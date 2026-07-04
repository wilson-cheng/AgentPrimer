/**
 * lib/agent/stream.ts
 * ---------------------------------------------------------------------------
 * Streaming-related helpers:
 *   • `normalizeChatCompletionChunk` flattens provider-specific chunk shapes
 *     into a single `NormalizedChatDelta`.
 *   • `createThinkExtractor` splits incremental `content` deltas into
 *     reasoning / visible text when a provider inlines `<think>…</think>`
 *     blocks instead of exposing a dedicated `reasoning_content` field.
 *   • Finish-reason normalization + the `shouldExecuteToolCalls` guard the
 *     agent loop uses to decide whether to fire tool execution.
 *   • Incomplete-stream notice text.
 */
import type {
  NormalizedChatDelta,
  NormalizedToolCallDelta,
  SdkFinishReason,
  ThinkExtractor,
  ThinkExtractorChunk,
} from './types';

export const LENGTH_FINISH_MESSAGE =
  '> ⚠️ Generation stopped because the model reached its maximum output token limit. The response may be incomplete. Increase the max output tokens or ask the model to continue from here.\n';

/**
 * Classify a stream/loop error into the incomplete-marker reason persisted
 * alongside the assistant message. An explicit abort (Stop button) wins over
 * the network-error heuristic so the UI shows "interrupted" + Continue rather
 * than "connection lost". Shared by the loop's stream-iteration catch and the
 * `runTurn` catch so the two copies of the string-matching heuristic can't drift.
 */
export function classifyStreamError(
  detail: string,
  abortSignal?: AbortSignal,
): 'aborted' | 'connection_lost' | 'error' {
  if (abortSignal?.aborted) return 'aborted';
  const lower = detail.toLowerCase();
  const looksLikeNetwork =
    lower.includes('socket') ||
    lower.includes('econn') ||
    lower.includes('aborted') ||
    lower.includes('timeout') ||
    lower.includes('network') ||
    lower.includes('eof') ||
    lower.includes('reset') ||
    lower.includes('disconnected') ||
    lower.includes('terminated');
  return looksLikeNetwork ? 'connection_lost' : 'error';
}

/**
 * Build a user-visible notice for an incomplete-stream condition.
 * `reason` is one of the well-known incomplete-marker reasons we persist
 * alongside the assistant message so the chat UI can surface a Continue
 * button on reload.
 */
export function buildIncompleteNotice(
  reason: 'connection_lost' | 'error' | 'aborted',
  detail?: string,
): string {
  switch (reason) {
    case 'connection_lost':
      return `> ⚠️ The connection to the model dropped before the response finished. Click **Continue** below or send "continue" to resume.${detail ? `\n>\n> _Details: ${detail}_` : ''}\n`;
    case 'aborted':
      return `> ⚠️ The response was interrupted before it finished. Click **Continue** below or send "continue" to resume.\n`;
    default:
      return `> ⚠️ The response was interrupted by an error. Click **Continue** below or send "continue" to resume.${detail ? `\n>\n> _Details: ${detail}_` : ''}\n`;
  }
}

function readStringAtPath(value: unknown, path: string[]): string {
  let cursor: unknown = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return '';
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'string' ? cursor : '';
}

function readStringFromPaths(value: unknown, paths: string[][]): string {
  for (const path of paths) {
    const found = readStringAtPath(value, path);
    if (found) return found;
  }
  return '';
}

export function normalizeFinishReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string') return undefined;
  const normalized = reason.toLowerCase().replace(/-/g, '_');
  if (normalized === 'tool_calls' || normalized === 'tool_call' || normalized === 'function_call')
    return 'tool_calls';
  if (
    normalized === 'max_tokens' ||
    normalized === 'max_output_tokens' ||
    normalized === 'token_limit'
  )
    return 'length';
  if (normalized === 'end_turn' || normalized === 'complete' || normalized === 'completed')
    return 'stop';
  return normalized;
}

function hasCompleteToolCall(tc: { name: string; args: string }): boolean {
  if (!tc.name) return false;
  try {
    JSON.parse(tc.args || '{}');
    return true;
  } catch {
    return false;
  }
}

export function shouldExecuteToolCalls(
  finishReason: string,
  toolCalls: Array<{ name: string; args: string }>,
  stepText: string,
): boolean {
  if (toolCalls.length === 0) return false;
  if (finishReason === 'tool_calls') return true;
  return finishReason === 'stop' && !stepText.trim() && toolCalls.every(hasCompleteToolCall);
}

export function toSdkFinishReason(reason: string): SdkFinishReason {
  switch (reason) {
    case 'stop':
    case 'length':
    case 'error':
    case 'other':
    case 'unknown':
      return reason;
    case 'tool_calls':
    case 'tool-calls':
    case 'function_call':
      return 'tool-calls';
    case 'content_filter':
    case 'content-filter':
      return 'content-filter';
    default:
      return 'unknown';
  }
}

/**
 * Splits incremental `content` deltas into reasoning and visible text when a
 * provider (e.g. MiniMax) inlines `<think>...</think>` blocks instead of
 * exposing a dedicated `reasoning_content` field. The extractor is stateful
 * because tags can be split across stream chunks (`<thi` then `nk>`).
 *
 * Tags are recognised case-insensitively and a `<think...>` open tag with
 * attributes is tolerated. The closing `</think>` tag is stripped from the
 * visible text so the user only sees the answer.
 */
export function createThinkExtractor(): ThinkExtractor {
  const OPEN_RE = /<think(?:\s[^>]*)?>/i;
  const CLOSE_RE = /<\/think\s*>/i;
  const PARTIAL_OPEN_RE = /<(t(h(i(n(k)?)?)?)?(?:\s[^>]*)?)?$/i;
  const PARTIAL_CLOSE_RE = /<\/?(t(h(i(n(k)?)?)?)?(?:\s[^>]*)?)?$/i;

  let buffer = '';
  let inThink = false;

  const drain = (final: boolean): ThinkExtractorChunk => {
    let text = '';
    let reasoning = '';

    while (buffer.length > 0) {
      if (!inThink) {
        const match = buffer.match(OPEN_RE);
        if (match && match.index !== undefined) {
          text += buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          inThink = true;
          continue;
        }
        if (!final) {
          const partial = buffer.match(PARTIAL_OPEN_RE);
          if (partial && partial.index !== undefined && partial.index < buffer.length) {
            text += buffer.slice(0, partial.index);
            buffer = buffer.slice(partial.index);
            return { text, reasoning };
          }
        }
        text += buffer;
        buffer = '';
      } else {
        const match = buffer.match(CLOSE_RE);
        if (match && match.index !== undefined) {
          reasoning += buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          inThink = false;
          continue;
        }
        if (!final) {
          const partial = buffer.match(PARTIAL_CLOSE_RE);
          if (partial && partial.index !== undefined && partial.index < buffer.length) {
            reasoning += buffer.slice(0, partial.index);
            buffer = buffer.slice(partial.index);
            return { text, reasoning };
          }
        }
        reasoning += buffer;
        buffer = '';
      }
    }

    return { text, reasoning };
  };

  return {
    push(delta: string): ThinkExtractorChunk {
      if (!delta) return { text: '', reasoning: '' };
      buffer += delta;
      return drain(false);
    },
    flush(): ThinkExtractorChunk {
      return drain(true);
    },
  };
}

export function normalizeChatCompletionChunk(chunk: unknown): NormalizedChatDelta {
  const choice = (chunk as { choices?: unknown[] })?.choices?.[0] as
    Record<string, unknown> | undefined;
  if (!choice) return { textDelta: '', reasoningDelta: '', toolCallDeltas: [] };

  const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
  const textDelta = readStringFromPaths(delta, [
    ['content'],
    ['text'],
    ['message', 'content'],
    ['output_text'],
  ]);
  const reasoningDelta = readStringFromPaths(delta, [
    ['reasoning_content'],
    ['reasoning'],
    ['reasoning_text'],
    ['thinking'],
    ['thinking_content'],
    ['thought'],
    ['thoughts'],
    ['analysis'],
    ['message', 'reasoning_content'],
  ]);
  const toolCallDeltas: NormalizedToolCallDelta[] = [];
  const rawToolCalls = Array.isArray(delta.tool_calls)
    ? delta.tool_calls
    : Array.isArray(delta.toolCalls)
      ? delta.toolCalls
      : [];

  rawToolCalls.forEach((raw, fallbackIndex) => {
    if (!raw || typeof raw !== 'object') return;
    const item = raw as Record<string, unknown>;
    const fn = (item.function ?? item.function_call ?? item.tool_call ?? {}) as Record<
      string,
      unknown
    >;
    const index = typeof item.index === 'number' ? item.index : fallbackIndex;
    const id =
      typeof item.id === 'string'
        ? item.id
        : typeof item.toolCallId === 'string'
          ? item.toolCallId
          : undefined;
    const name = readStringFromPaths(item, [
      ['name'],
      ['toolName'],
      ['function', 'name'],
      ['function_call', 'name'],
      ['tool_call', 'name'],
    ]);
    const argumentsDelta =
      typeof fn.arguments === 'string'
        ? fn.arguments
        : typeof fn.arguments_delta === 'string'
          ? fn.arguments_delta
          : typeof fn.args === 'string'
            ? fn.args
            : typeof item.arguments === 'string'
              ? item.arguments
              : typeof item.args === 'string'
                ? item.args
                : '';
    toolCallDeltas.push({
      index,
      id,
      name: name || undefined,
      argumentsDelta: argumentsDelta || undefined,
    });
  });

  const legacyFunctionCall = delta.function_call as Record<string, unknown> | undefined;
  if (legacyFunctionCall && typeof legacyFunctionCall === 'object') {
    const name = typeof legacyFunctionCall.name === 'string' ? legacyFunctionCall.name : undefined;
    const argumentsDelta =
      typeof legacyFunctionCall.arguments === 'string' ? legacyFunctionCall.arguments : undefined;
    toolCallDeltas.push({ index: 0, name, argumentsDelta });
  }

  return {
    finishReason: normalizeFinishReason(choice.finish_reason ?? choice.finishReason),
    textDelta,
    reasoningDelta,
    toolCallDeltas,
  };
}
