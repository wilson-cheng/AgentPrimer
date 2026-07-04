/**
 * lib/agent/messages.ts
 * ---------------------------------------------------------------------------
 * Convert between the Vercel AI SDK `useChat` message format and the OpenAI
 * Chat Completions API format, plus context-window compaction, multimodal
 * attachment injection, and vision-rejection fallback helpers.
 */
import type OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../db';
import { sanitizeToolResultContent } from './sanitize';
import type { Attachment } from './types';

/**
 * Convert the Vercel AI SDK useChat message format → OpenAI Chat API format.
 *
 * ── Why this conversion is needed ─────────────────────────────────────────
 * useChat stores tool calls inside the assistant message object as:
 *   toolInvocations: [{ toolCallId, toolName, args, result, state, step }]
 *
 * The OpenAI API requires alternating message pairs:
 *   { role:"assistant", tool_calls:[{ id, function:{ name, arguments } }] }
 *   { role:"tool",      tool_call_id: id, content: "<result json>" }
 *   ...one pair per step...
 *   { role:"assistant", content: "Final text answer" }
 *
 * ── The `step` field ────────────────────────────────────────────────────
 * One useChat assistant message can span multiple agent steps (tool-call
 * rounds). For example: step 0 calls search_web, step 1 calls read_file.
 * Each step is reconstructed as its own assistant+tool message pair.
 *
 * ── reasoning_content ───────────────────────────────────────────────────
 * DeepSeek R1 and other "thinking" models emit `reasoning_content` alongside
 * the text. We re-attach the last reasoning block to the last assistant
 * message so the model can continue its chain-of-thought on the next turn.
 */
export function convertMessagesToOpenAI(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[],
  lastReasoning: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isLastAssistant = i === lastAssistantIdx;

    if (msg.role === 'user') {
      // Preserve multimodal (array) `content` exactly as-is. A user turn that
      // already carries OpenAI-style content parts (e.g. `image_url`,
      // `input_audio`) was produced by `buildMultimodalContent` on a prior
      // request; JSON-stringifying it here would turn the image bytes into a
      // literal `[{"type":"image_url",…}]` string and the model would lose
      // sight of the attachment permanently after the first follow-up turn.
      const content =
        typeof msg.content === 'string' || Array.isArray(msg.content)
          ? msg.content
          : JSON.stringify(msg.content);
      result.push({ role: 'user', content });
      continue;
    }

    if (msg.role !== 'assistant') continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const completed: any[] = (msg.toolInvocations ?? []).filter((t: any) => t.state === 'result');

    if (completed.length === 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m: any = { role: 'assistant', content: msg.content ?? '' };
      if (isLastAssistant && lastReasoning) m.reasoning_content = lastReasoning;
      result.push(m);
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const maxStep = completed.reduce((max: number, t: any) => Math.max(max, t.step ?? 0), 0);
    for (let s = 0; s <= maxStep; s++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stepCalls = completed.filter((t: any) => (t.step ?? 0) === s);
      if (stepCalls.length === 0) continue;

      result.push({
        role: 'assistant',
        content: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tool_calls: stepCalls.map((t: any) => ({
          id: t.toolCallId,
          type: 'function' as const,
          function: {
            name: t.toolName,
            arguments: typeof t.args === 'string' ? t.args : JSON.stringify(t.args),
          },
        })),
      } as OpenAI.Chat.ChatCompletionAssistantMessageParam);

      for (const inv of stepCalls) {
        result.push({
          role: 'tool',
          tool_call_id: inv.toolCallId,
          content: sanitizeToolResultContent(inv.result),
        });
      }
    }

    if (msg.content) {
      // OpenAI's Chat Completions API requires assistant `content` to be a
      // plain string (or `null` when emitting only tool_calls). Earlier
      // turns may have stored structured arrays in `content` (e.g. from
      // structured-output rendering); flatten them to a string here.
      let contentStr: string;
      if (typeof msg.content === 'string') {
        contentStr = msg.content;
      } else if (Array.isArray(msg.content)) {
        const pieces: string[] = [];
        for (const p of msg.content as Array<{ text?: string } | string>) {
          if (typeof p === 'string') {
            pieces.push(p);
            continue;
          }
          if (p && typeof p === 'object' && typeof p.text === 'string') {
            pieces.push(p.text);
            continue;
          }
          // Non-text part inside assistant content. Today this never
          // happens in production, but it would silently lose data if the
          // part schema ever expands. Stringify so the information
          // survives the round-trip and warn loudly outside production so
          // the schema drift is visible during development.
          if (process.env.NODE_ENV !== 'production') {
            console.warn(
              '[agent] dropped non-text assistant content part in conversion to OpenAI format:',
              p,
            );
          }
          try {
            pieces.push(JSON.stringify(p));
          } catch {
            pieces.push(String(p));
          }
        }
        contentStr = pieces.filter(Boolean).join('\n');
      } else {
        contentStr = String(msg.content);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m: any = { role: 'assistant', content: contentStr };
      if (isLastAssistant && lastReasoning) m.reasoning_content = lastReasoning;
      result.push(m);
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Context Window Compaction
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHY THIS MATTERS (for learners):
// ───────────────────────────────
// Every LLM has a finite "context window" — the maximum number of tokens it
// can process in a single request. For a conversation agent, the problem is
// that every turn adds messages to the history. Over a long session the
// conversation grows until it exceeds the model's context limit, at which
// point the API returns an error and the conversation is effectively stuck.
//
// This is one of the most practical engineering challenges in building
// production agents. Several strategies exist to manage it (see the training
// docs for a full comparison). We implement the most common one here:
//
//   Strategy 1: SLIDING WINDOW (implemented below)
//   ──────────────────────────────────────────────
//   Keep only the N most recent message exchanges (pairs of user+assistant).
//   Older messages are silently dropped. The system prompt and any in-flight
//   tool-call messages are always preserved.
//
//   Pros: Simple, fast, predictable token usage, no information leak.
//   Cons: The agent "forgets" what was said before the window. Early context
//         is completely lost, which can cause repetitive questions or confusion
//         about decisions made earlier in the conversation.
//
//   Other strategies (described in docs/training.md):
//     2. Summarization-based — compress old messages into a summary
//     3. Truncation — drop tool call/result pairs, keep user/assistant text
//     4. Pre-flight detection — estimate tokens and trigger compaction proactively
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * compactConversation – sliding-window context compaction
 *
 * Trims `apiMessages` to keep only the system prompt + the last N user/assistant
 * exchanges. Tool-call and tool-result messages that belong to a trimmed
 * exchange are also removed.
 *
 * @param apiMessages   – The full OpenAI-format message array (system + history)
 * @param keepPairs     – How many user/assistant exchange pairs to keep (0 = disabled)
 * @returns             – The compacted message array
 */
export function compactConversation(
  apiMessages: OpenAI.Chat.ChatCompletionMessageParam[],
  keepPairs: number,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (keepPairs <= 0 || apiMessages.length <= keepPairs + 1) return apiMessages;

  // Step 1: Walk backwards and identify which indices to keep.
  // An "exchange" starts with a user message and includes all following
  // messages (assistant, tool-calls, tool-results) until the next user message.
  const keepIndices = new Set<number>();
  let pairsFound = 0;

  // Always keep the system prompt at index 0
  keepIndices.add(0);

  for (let i = apiMessages.length - 1; i >= 0; i--) {
    const msg = apiMessages[i];
    if (msg.role === 'user') {
      keepIndices.add(i);
      pairsFound++;
      if (pairsFound >= keepPairs) break;
    } else {
      keepIndices.add(i);
    }
  }

  // If we hit the system prompt before finding enough pairs, keep everything.
  if (pairsFound < keepPairs) return apiMessages;

  return apiMessages.filter((_, i) => keepIndices.has(i));
}

// ── Tool-invocation reconstruction for from-DB messages ───────────────────

/**
 * Ensure every assistant message carries a `toolInvocations` array that
 * `convertMessagesToOpenAI` can read.
 *
 * Messages restored from the database (via /api/messages → loadSession) carry
 * the persisted `tool_calls_json` string but NOT the live `toolInvocations`
 * array that the SDK populates for in-session messages. Without this
 * normalization, `convertMessagesToOpenAI` sees no tool calls for those
 * messages and silently drops every tool call + tool result from the history
 * sent to the LLM — so after switching away from a session and coming back,
 * the agent "forgets" everything it did with tools.
 *
 * We reconstruct `toolInvocations` from `tool_calls_json` (the flat
 * `{toolCallId, toolName, args, result}` list persisted by the agent loop).
 * Step grouping is collapsed to a single step because the persisted list does
 * not retain per-step boundaries; that is valid for the OpenAI API and far
 * better than losing the tool history entirely.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ensureToolInvocations(messages: any[]): any[] {
  return messages.map((msg) => {
    if (msg.role !== 'assistant') return msg;
    if (Array.isArray(msg.toolInvocations) && msg.toolInvocations.length > 0) return msg;
    const raw = msg.tool_calls_json;
    if (typeof raw !== 'string' || raw.length === 0) return msg;
    let list: unknown;
    try {
      list = JSON.parse(raw);
    } catch {
      return msg;
    }
    if (!Array.isArray(list) || list.length === 0) return msg;
    return {
      ...msg,
      toolInvocations: list
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
        .map((t) => ({
          toolCallId: t.toolCallId,
          toolName: t.toolName,
          args: t.args,
          result: t.result,
          state: 'result',
          step: 0,
        })),
    };
  });
}

// ── Multimodal fallback helpers ────────────────────────────────────────────

/**
 * Returns true when a 400 error from the upstream LLM is specifically caused
 * by the model not supporting image_url or input_audio content parts.
 * DeepSeek and several other providers return a serde error like:
 *   "unknown variant `image_url`, expected `text`"
 */
export function isVisionRejectionError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('image_url') ||
    lower.includes('input_audio') ||
    (lower.includes('unknown variant') && (lower.includes('image') || lower.includes('audio')))
  );
}

/**
 * Mutates the messages array in-place: collapses any user message whose
 * `content` is an array (multimodal) down to a plain string, removing all
 * non-text parts (image_url, input_audio) and appending a short notice.
 * Returns true when at least one message was modified.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function stripMultimodalFromMsgs(msgs: any[]): boolean {
  let stripped = false;
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts: any[] = msg.content;
    const textContent = parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text as string)
      .join('\n');
    const removedTypes = [
      ...new Set(parts.filter((p) => p.type !== 'text').map((p) => p.type as string)),
    ];
    if (removedTypes.length === 0) continue;
    const notice = `[Attached media (${removedTypes.join(', ')}) was omitted — this model does not support vision/audio inputs]`;
    msgs[i] = { ...msg, content: textContent ? `${textContent}\n${notice}` : notice };
    stripped = true;
  }
  return stripped;
}

// ── Multimodal attachment helpers ──────────────────────────────────────────
//
// Supported attachment types for the User→LLM direction.
//
//   Images  → content part { type: 'image_url',    image_url:   { url: 'data:<mime>;base64,...' } }
//   Audio   → content part { type: 'input_audio',  input_audio: { data: '<base64>', format: 'wav'|'mp3'|'ogg'|'opus'|'flac' } }
//   Video   → no native OpenAI type; frames could be extracted but we skip for now
//   Text    → read file content and append as a text part
//   Other   → mention the filename in a text part so the model is aware

export function resolveUploadPath(url: string): string {
  // /api/uploads/<filename>  →  data/uploads/<filename>
  const filename = decodeURIComponent(url.replace(/^\/api\/uploads\//, ''));
  return path.join(DATA_DIR, 'uploads', path.basename(filename));
}

type MultimodalContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } };

export async function buildMultimodalContent(
  text: string,
  attachments: Attachment[],
): Promise<MultimodalContentPart[]> {
  const parts: MultimodalContentPart[] = [];
  if (text) parts.push({ type: 'text', text });

  for (const att of attachments) {
    const filePath = resolveUploadPath(att.url);
    const fileExists = await fs.promises
      .access(filePath)
      .then(() => true)
      .catch(() => false);
    if (!fileExists) {
      parts.push({ type: 'text', text: `[Attached file not found on disk: ${att.name}]` });
      continue;
    }

    if (att.mime.startsWith('image/')) {
      const b64 = (await fs.promises.readFile(filePath)).toString('base64');
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${att.mime};base64,${b64}` },
      });
    } else if (att.mime.startsWith('audio/')) {
      // OpenAI GPT-4o Audio format
      const b64 = (await fs.promises.readFile(filePath)).toString('base64');
      // Format must be one of: wav, mp3, ogg, opus, flac
      const extFmt = att.name.split('.').pop()?.toLowerCase() ?? 'wav';
      const fmt = ['wav', 'mp3', 'ogg', 'opus', 'flac'].includes(extFmt) ? extFmt : 'wav';
      parts.push({ type: 'input_audio', input_audio: { data: b64, format: fmt } });
    } else if (att.mime.startsWith('text/') || att.mime === 'application/json') {
      // Inline text content (CSV, Markdown, code, JSON, etc.)
      try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        const label = att.name.endsWith('.json') ? 'json' : (att.name.split('.').pop() ?? 'text');
        parts.push({
          type: 'text',
          text: `\`\`\`${label}\n// Attached file: ${att.name}\n${content}\n\`\`\``,
        });
      } catch {
        parts.push({ type: 'text', text: `[Could not read text file: ${att.name}]` });
      }
    } else {
      // Video and other binary types — describe the attachment so the model is aware
      parts.push({
        type: 'text',
        text: `[User attached ${att.mime} file: ${att.name} (${(att.size / 1024).toFixed(1)} KB) — binary content not forwarded]`,
      });
    }
  }

  return parts;
}
