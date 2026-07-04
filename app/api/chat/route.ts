/**
 * app/api/chat/route.ts
 * ---------------------------------------------------------------------------
 * Streaming chat endpoint.
 *
 * POST body:
 *   {
 *     sessionId: string,
 *     messages: any[],   // full conversation history
 *     agentName?: string,        // agent to use (from data/agents/<agent>/agent.md)
 *     modelId?: string           // model override
 *   }
 *
 * Response: AI SDK data stream (consumed by useChat hook on the frontend)
 *
 * After the stream finishes, both the user message and assistant response
 * are persisted to the SQLite database.
 */

import { NextRequest, NextResponse } from 'next/server';
import { formatDataStreamPart } from 'ai';
import {
  createStreamingAgent,
  isSessionRunning,
  RUN_IN_PROGRESS,
  RUN_IN_PROGRESS_MESSAGE,
} from '@/lib/agent';
import { getSessionUser } from '@/lib/auth';
import {
  saveMessage,
  deleteMessage,
  touchSession,
  getSession,
  updateSessionTitle,
  createSession,
  upsertAssistantMessage,
} from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';

export const runtime = 'nodejs'; // Required: we use Node.js APIs (fs, sqlite, child_process)
// The agent loop now runs detached from this HTTP response (see
// lib/agent/run-manager.ts), so a run can outlive a single request. We still
// keep the request open as long as practical so the browser receives live
// tokens; beyond this wall-clock cap the live tail closes and the frontend's
// 10s merge poll takes over from the SQLite checkpoints. The run itself is
// bounded by `max_agent_steps`, NOT by this value.
export const maxDuration = 600;

/**
 * AI SDK data-stream keep-alive heartbeat.
 *
 * The Vercel AI SDK data stream is line-delimited (`<code>:<json>\n`),
 * not an EventSource stream. Injecting raw SSE comments (`: heartbeat`) is
 * invalid because the client parser treats `:` as a stream-part separator
 * with an empty code and throws "Invalid code". Instead, emit a valid custom
 * `data` stream part that the client can safely ignore while proxies still
 * see bytes on long-running tool turns.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

function wrapWithHeartbeat(
  upstream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const heartbeat = encoder.encode(formatDataStreamPart('data', [{ type: 'heartbeat' as const }]));
  let buffer = '';
  let lastFlushAt = Date.now();
  let interval: ReturnType<typeof setInterval> | null = null;
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const stop = () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    if (upstreamReader) {
      try {
        upstreamReader.cancel();
      } catch {
        /* already cancelled */
      }
      upstreamReader = null;
    }
  };

  signal.addEventListener('abort', stop, { once: true });

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      interval = setInterval(() => {
        if (Date.now() - lastFlushAt >= HEARTBEAT_INTERVAL_MS) {
          try {
            controller.enqueue(heartbeat);
          } catch {
            stop();
          }
          lastFlushAt = Date.now();
        }
      }, HEARTBEAT_INTERVAL_MS);

      upstreamReader = upstream.getReader();
      try {
        while (true) {
          const { value, done } = await upstreamReader.read();
          if (done) {
            // Flush any remaining buffered bytes (trailing partial record)
            // so we don't lose the last bit of an incomplete chunk.
            if (buffer.length > 0) {
              controller.enqueue(encoder.encode(buffer));
              buffer = '';
              lastFlushAt = Date.now();
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          // Release every complete AI SDK data-stream line.
          let boundary: number;
          while ((boundary = buffer.indexOf('\n')) !== -1) {
            const end = boundary + 1;
            controller.enqueue(encoder.encode(buffer.slice(0, end)));
            buffer = buffer.slice(end);
            lastFlushAt = Date.now();
          }
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        stop();
      }
    },
    cancel() {
      stop();
    },
  });
}

/**
 * Strip the visible "incomplete" notice paragraph from a previously-persisted
 * assistant message before re-sending it to the LLM. Without this, the model
 * sees its own warning text ("⚠️ Generation stopped because…") and treats it
 * as a completed response, often refusing to continue or starting over.
 *
 * The notice formats are produced by `LENGTH_FINISH_MESSAGE` and
 * `buildIncompleteNotice` in lib/agent.ts. They always begin with
 * `> ⚠️` and end with the next blank line / end of string, so a single
 * regex matches all variants.
 */
function stripIncompleteNotice(content: string): string {
  if (!content) return content;
  // Match a leading-or-mid `>` blockquote line that starts with the warning
  // emoji, plus any consecutive `>` continuation lines, plus one trailing
  // newline. Always remove it cleanly — the surrounding blank line(s) are
  // collapsed by `trimEnd()`. We do NOT try to preserve a leading `\n\n`
  // separator: an inline notice always sits at the end of the assistant
  // text in our format, so removing the entire block is safe.
  return content.replace(/(?:^|\n\n)>\s*⚠️[^\n]*(?:\n>[^\n]*)*\n?/g, '').trimEnd();
}

/**
 * Detect whether the last assistant message in the conversation history was
 * persisted with an `incomplete-marker` part — i.e. the previous turn ended
 * abnormally (max output tokens reached, connection dropped, upstream
 * error). Used to decide whether the next user message should be rewritten
 * as an explicit "continue from where you left off" instruction.
 */
function findLastAssistantIncomplete(
  messages: Array<{ role: string; parts?: unknown; content?: unknown }>,
): { reason: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const parts = Array.isArray(m.parts) ? m.parts : [];
    for (const p of parts) {
      if (
        p &&
        typeof p === 'object' &&
        (p as Record<string, unknown>).type === 'incomplete-marker'
      ) {
        return { reason: String((p as Record<string, unknown>).reason ?? 'unknown') };
      }
    }
  }
  return null;
}

/**
 * Heuristic: a one-word "continue" / "go on" / "繼續" message is treated as
 * a resume request when the previous assistant turn was marked incomplete.
 */
function isContinueIntent(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return false;
  return /^(continue|go on|keep going|carry on|please continue|繼續|继续|続けて|계속)\.?!?$/i.test(
    trimmed,
  );
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });

  const { sessionId, messages, agentName, modelId, attachments, resumeFrom } = body as {
    sessionId: string;
    messages: Array<{ id?: string; role: string; content: unknown; parts?: unknown }>;
    agentName?: string;
    modelId?: string;
    attachments?: Array<{ name: string; url: string; mime: string; size: number }>;
    /**
     * Set by the client when the user clicks the "Continue" button on an
     * incomplete assistant message. The server treats the new user turn as
     * a resume request rather than a fresh question.
     */
    resumeFrom?: boolean;
  };

  if (!sessionId || !messages?.length) {
    return NextResponse.json({ error: 'sessionId and messages are required' }, { status: 400 });
  }

  // Authenticated username — scopes the detached run registry so one user can't
  // start/stop/inspect another user's run. proxy.ts enforces a valid JWT, so
  // this should always resolve; guard defensively.
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── One active background run per (user, session) (queue is deferred) ───
  // A second turn while a run is still live would race on the same
  // workspace/assistant row. The frontend disables Send while a run is
  // active, but this server-side guard is authoritative and also catches the
  // reopen-mid-run case where the user can type before the UI catches up.
  // Checked BEFORE saving the user message so a rejected turn leaves no
  // dangling user row.
  if (isSessionRunning(user, sessionId)) {
    return NextResponse.json({ error: RUN_IN_PROGRESS_MESSAGE }, { status: 409 });
  }

  // ── Detect resume requests (BEFORE any mutation) ───────────────────────
  // Two paths reach here as a "continue":
  //   1. The frontend Continue button sets resumeFrom=true explicitly.
  //   2. The user typed "continue" (or equivalent) and the previous
  //      assistant message has an incomplete-marker.
  // We detect the intent first, persist the original user text to the DB,
  // and only then rewrite the messages array for the LLM. Splitting the
  // detection from the mutation removes the ordering hazard where a
  // future code reorganization could accidentally save the rewritten
  // directive instead of the user's original input.
  const lastUserMessageRaw = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i];
    }
    return undefined;
  })();
  const lastUserText =
    typeof lastUserMessageRaw?.content === 'string' ? lastUserMessageRaw.content : '';
  const incompleteInfo = findLastAssistantIncomplete(messages);
  const shouldResume = !!resumeFrom || (incompleteInfo && isContinueIntent(lastUserText));

  // Get the last user message to save it
  const userMessages = messages.filter((m) => m.role === 'user');
  const lastUserMessage = userMessages[userMessages.length - 1];

  // Tracked so the RUN_IN_PROGRESS race catch can roll it back. The early
  // isSessionRunning check is BEFORE this save, but startRun (inside
  // createStreamingAgent, further down) re-checks atomically; if it loses the
  // race we must not leave a dangling user row.
  let savedUserMessageId: string | undefined;

  // Save the user message to the database FIRST, while messages still hold
  // the user's original text. Mutation for the LLM happens after this block.
  if (lastUserMessage) {
    // Lazy session creation: the client generates a UUID before the first message
    // is sent, so the session may not exist in the DB yet.
    if (!getSession(sessionId)) {
      createSession(sessionId, 'New Chat', agentName ?? 'main');
    }

    // For resume requests, persist what the USER actually typed (or a short
    // marker if it came from the Continue button). The rewritten directive
    // we send to the LLM is intentionally NOT saved — the chat history
    // should reflect the user's intent, not the prompt-engineering details.
    const persistedContent = shouldResume
      ? resumeFrom && !isContinueIntent(lastUserText)
        ? '[Continue]'
        : lastUserText || '[Continue]'
      : typeof lastUserMessage.content === 'string'
        ? lastUserMessage.content
        : JSON.stringify(lastUserMessage.content);

    // Reuse the client-supplied message id (allocated by the AI SDK's useChat
    // hook) when present so the row in the DB shares an id with the user
    // message already rendered on the client. Without this the post-stream
    // merge would treat the persisted row as new and render a duplicate user
    // bubble. Falls back to a fresh UUID for legacy clients that don't send
    // `sendExtraMessageFields`.
    const userMessageId =
      typeof lastUserMessage.id === 'string' && lastUserMessage.id
        ? lastUserMessage.id
        : uuidv4();
    savedUserMessageId = userMessageId;
    saveMessage({
      id: userMessageId,
      session_id: sessionId,
      role: 'user',
      content: persistedContent,
      attachments_json: JSON.stringify(attachments ?? []),
      tool_calls_json: '[]',
      token_usage_json: '{}',
      reasoning_json: '',
      parts_json: '[]',
      trace_json: '[]',
    });

    // Auto-generate session title from first user message
    const session = getSession(sessionId);
    if (session?.title === 'New Chat' && typeof persistedContent === 'string') {
      const title = persistedContent.slice(0, 60) + (persistedContent.length > 60 ? '…' : '');
      updateSessionTitle(sessionId, title);
    }

    touchSession(sessionId);
  }

  // ── Now (and only now) rewrite messages for the LLM ─────────────────────
  // The user row is already persisted with the original text; mutating the
  // array beyond this point only affects what the model sees, never what
  // gets stored. If a future change moves this block above the persist
  // block, the assertions in `persistedContent` above will still pull from
  // `lastUserText`, which was captured before mutation — but keeping the
  // order explicit here prevents accidental drift.
  if (shouldResume) {
    // Strip the incomplete-warning paragraph from every prior assistant
    // message so the model doesn't read its own "⚠️ stopped" text.
    for (const m of messages) {
      if (m.role === 'assistant' && typeof m.content === 'string') {
        m.content = stripIncompleteNotice(m.content);
      }
    }
    // Replace the last user message text with an explicit resume directive.
    if (lastUserMessageRaw) {
      lastUserMessageRaw.content =
        'Continue your previous response from exactly where you left off. ' +
        'Do not repeat, summarize, or restart what you have already produced — ' +
        'just pick up writing the next character/sentence/section. ' +
        'If you were in the middle of a tool call, complete it first.';
    }
  }

  // Pre-allocate the assistant message id so the agent loop can checkpoint
  // partial progress (text, reasoning, tool calls, parts, trace) into the
  // same row after every step. If the connection drops mid-run, a refresh
  // sees everything completed up to the last finished step.
  const assistantMessageId = uuidv4();

  // Start the streaming agent – returns a Response with the AI data stream.
  // We wrap it to add no-buffering headers so that VS Code port-forwarding /
  // any nginx/proxy in front of the dev server does not batch up SSE chunks.
  // The loop now runs detached (lib/agent/run-manager.ts): `agentResponse`
  // is a tail of the run's replay buffer, so a client disconnect only tears
  // down this tail, not the run itself.
  let agentResponse: Response;
  try {
    agentResponse = await createStreamingAgent({
      agentName,
      modelId,
      messages,
      sessionId,
      attachments,
      assistantMessageId,
      user,
      detached: true,
      onFinish: async (text, toolCalls, tokenUsage, reasoning, parts, trace) => {
        // Final assistant write — overwrites any checkpoint rows written during
        // the run so the persisted state matches what `onFinish` reports.
        upsertAssistantMessage({
          id: assistantMessageId,
          session_id: sessionId,
          role: 'assistant',
          content: text,
          attachments_json: '[]',
          tool_calls_json: JSON.stringify(toolCalls),
          token_usage_json: tokenUsage ? JSON.stringify(tokenUsage) : '{}',
          reasoning_json: reasoning ?? '',
          parts_json: JSON.stringify(parts ?? []),
          trace_json: trace ? JSON.stringify(trace) : '[]',
        });
        touchSession(sessionId);
      },
    });
  } catch (err) {
    // Backstop for the rare race between the early `isSessionRunning` check
    // above and `startRun` inside createStreamingAgent. Roll back the user
    // message we already saved so a lost race leaves no dangling row.
    if (err instanceof Error && err.message === RUN_IN_PROGRESS) {
      if (savedUserMessageId) {
        try {
          deleteMessage(savedUserMessageId);
        } catch {
          /* best-effort */
        }
      }
      return NextResponse.json({ error: RUN_IN_PROGRESS_MESSAGE }, { status: 409 });
    }
    throw err;
  }

  const headers = new Headers(agentResponse.headers);
  headers.set('X-Accel-Buffering', 'no'); // nginx: disable proxy buffering
  headers.set('Cache-Control', 'no-cache, no-transform'); // prevent compression buffering

  // Wrap the upstream body so a valid AI SDK data-stream heartbeat is emitted
  // every ~15s of idle time. Without this, Traefik / nginx / Cloudflare may
  // close an idle SSE connection mid-turn while a tool subprocess runs.
  if (agentResponse.body) {
    const wrapped = wrapWithHeartbeat(agentResponse.body, request.signal);
    return new Response(wrapped, { status: agentResponse.status, headers });
  }
  return new Response(null, { status: agentResponse.status, headers });
}
