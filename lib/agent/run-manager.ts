/**
 * lib/agent/run-manager.ts
 * ---------------------------------------------------------------------------
 * Detached, request-independent execution of an agent turn.
 *
 * Historically `runAgentLoop` ran *inside* the AI SDK `createDataStreamResponse`
 * `execute` callback, so its lifetime was bound to the HTTP response stream:
 * the moment the browser closed, `request.signal` aborted, the stream was
 * cancelled, `writer.write()` threw, and the loop died mid-step.
 *
 * The RunManager inverts that. The loop is started as a floating background
 * promise (the same `void (async () => …)()` pattern `run_subagent_async`
 * already uses) and writes its AI-SDK data-stream parts to a bounded replay
 * buffer. The HTTP response is a thin "tail" that replays the buffer and
 * forwards new parts to the browser. Closing the browser only tears down the
 * tail — the loop keeps running and keeps checkpointing to SQLite, so a later
 * reopen (which loads messages from the DB + the merge poll) shows the result.
 *
 * One active run per (owner, session) is enforced (the message-queue feature is
 * deferred; for now a second send while a run is live is rejected with
 * `RUN_IN_PROGRESS`). `owner` is the authenticated username so one user can't
 * abort or inspect another user's run. An `AbortController` per run backs the
 * Stop button: aborting cancels the in-flight `openai.chat.completions.create`
 * call (via the `signal` option the loop now passes) and breaks the loop
 * cleanly at the next safe point. A wall-clock watchdog force-aborts a run that
 * exceeds `MAX_RUN_MS` so a hung tool/subprocess can't brick the session.
 */
import { createDataStreamResponse, formatDataStreamPart } from 'ai';
import type { AgentStreamWriter, AgentStreamPart } from './types';

/** Thrown by `startRun` when a run is already active for the (owner, session). */
export const RUN_IN_PROGRESS = 'RUN_IN_PROGRESS';
/** Shared 409 body for the one-active-run rejection (early guard + race catch). */
export const RUN_IN_PROGRESS_MESSAGE = 'A generation is already running in this session.';

/** Max wall-clock a detached run may live before being force-aborted. Protects
 *  against a hung tool/subprocess bricking the session with 409s until restart.
 *  The run is separately bounded by `max_agent_steps` (token burn), not this. */
const MAX_RUN_MS = 30 * 60 * 1000;
/** Cap on the replay buffer so a readerless run can't hold its entire token
 *  stream in memory. Live tail readers receive parts directly via subscribers;
 *  the buffer only exists for late-attach replay (and is drop-oldest past this). */
const REPLAY_CAP = 2000;

interface ActiveRun {
  owner: string;
  sessionId: string;
  assistantMessageId: string;
  controller: AbortController;
  /** Bounded replay log for late-attaching tail readers. */
  buffer: AgentStreamPart[];
  /** Live tail readers — each receives every emitted part directly. */
  subscribers: Set<(part: AgentStreamPart) => void>;
  done: boolean;
  /** Resolves when the run finishes (success, error, or abort). */
  donePromise: Promise<void>;
  doneResolve: () => void;
  watchdog: ReturnType<typeof setTimeout>;
}

const runsByKey = new Map<string, ActiveRun>();

function runKey(owner: string | null | undefined, sessionId: string): string {
  return owner ? `${owner}:${sessionId}` : sessionId;
}

export function getActiveRun(
  owner: string | null | undefined,
  sessionId: string,
): ActiveRun | undefined {
  const run = runsByKey.get(runKey(owner, sessionId));
  return run && !run.done ? run : undefined;
}

export function isSessionRunning(
  owner: string | null | undefined,
  sessionId: string,
): boolean {
  return getActiveRun(owner, sessionId) !== undefined;
}

/** Trigger the Stop button's abort. Returns false if no live run exists. */
export function abortRun(owner: string | null | undefined, sessionId: string): boolean {
  const run = getActiveRun(owner, sessionId);
  if (!run) return false;
  run.controller.abort();
  return true;
}

export interface StartRunOptions {
  /** Authenticated username scoping the run registry so one user can't
   *  abort/inspect another's run. Null/undefined falls back to sessionId-only. */
  owner?: string | null;
  sessionId: string;
  assistantMessageId: string;
  /**
   * The detached turn. Receives a buffer-backed writer (every emitted AI-SDK
   * data-stream part is appended to the bounded replay buffer and forwarded to
   * any attached tail readers) and an `AbortSignal` that fires on Stop (or the
   * watchdog). The work is expected to end its own stream cleanly (the loop
   * emits `finish_message` on success, an incomplete-notice + `finish_message`
   * on abort/error). If it throws without doing so, the manager emits a
   * best-effort error finish so tail readers unblock.
   */
  work: (writer: AgentStreamWriter, signal: AbortSignal) => Promise<void>;
}

export interface StartedRun {
  run: ActiveRun;
}

/**
 * Register and start a detached run. Throws `RUN_IN_PROGRESS` (an Error whose
 * `message` is that sentinel) if a run is already live for the (owner, session).
 */
export function startRun(opts: StartRunOptions): StartedRun {
  const key = runKey(opts.owner, opts.sessionId);
  const existing = runsByKey.get(key);
  if (existing && !existing.done) {
    throw new Error(RUN_IN_PROGRESS);
  }

  let doneResolve!: () => void;
  const donePromise = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });

  const run: ActiveRun = {
    owner: opts.owner ?? '',
    sessionId: opts.sessionId,
    assistantMessageId: opts.assistantMessageId,
    controller: new AbortController(),
    buffer: [],
    subscribers: new Set(),
    done: false,
    donePromise,
    doneResolve,
    watchdog: setTimeout(() => run.controller.abort(), MAX_RUN_MS),
  };
  runsByKey.set(key, run);

  const writer: AgentStreamWriter = {
    write: (part: AgentStreamPart) => {
      if (run.done) return;
      // Bounded replay log (drop-oldest past the cap) so a readerless run can't
      // grow this without bound. Live readers get the part via subscribers.
      if (run.buffer.length >= REPLAY_CAP) run.buffer.shift();
      run.buffer.push(part);
      for (const push of run.subscribers) {
        try {
          push(part);
        } catch {
          /* a tail reader died — it removes itself on its next push */
        }
      }
    },
  };

  const finishRun = (): void => {
    if (run.done) return;
    run.done = true;
    clearTimeout(run.watchdog);
    run.subscribers.clear();
    run.doneResolve();
    // Keep the run registered briefly so a tail that attaches in the same tick
    // as completion can still replay the buffer. After the grace, drop it so
    // memory doesn't grow with finished runs.
    setTimeout(() => {
      if (runsByKey.get(key) === run) runsByKey.delete(key);
    }, 5_000);
  };

  // Detached execution — intentionally not awaited. The floating promise lives
  // in the module scope, NOT tied to any HTTP request, so it survives a browser
  // close / request teardown exactly like an async sub-agent's worker.
  void (async () => {
    try {
      await opts.work(writer, run.controller.signal);
    } catch (err) {
      // The work threw without ending the stream. Emit a best-effort error
      // finish so any attached tail reader unblocks instead of hanging.
      try {
        writer.write(
          formatDataStreamPart('finish_message', {
            finishReason: 'error',
            usage: { promptTokens: 0, completionTokens: 0 },
          }),
        );
      } catch {
        /* writer may be closed */
      }
      console.warn('[run-manager] detached run threw:', err instanceof Error ? err.message : err);
    } finally {
      finishRun();
    }
  })();

  return { run };
}

/**
 * Build an AI-SDK data-stream `Response` that tails a run: it replays the
 * bounded buffer, then forwards new parts live (via a subscriber) until the run
 * finishes, at which point the stream closes (the loop's own `finish_message`
 * is the last part the subscriber receives).
 *
 * Using `createDataStreamResponse` (rather than a hand-rolled stream) preserves
 * the exact wire format + headers the `useChat` hook expects. If the client
 * disconnects, the AI SDK cancels this stream, the subscriber's `writer.write`
 * throws, and the subscriber detaches — but the run itself keeps going.
 */
export function createTailResponse(run: ActiveRun): Response {
  return createDataStreamResponse({
    execute: async (writer) => {
      let stopped = false;
      const subscriber = (part: AgentStreamPart): void => {
        if (stopped) return;
        try {
          writer.write(part);
        } catch {
          // Response stream cancelled (client gone). Detach this subscriber
          // only; the run continues in the background.
          stopped = true;
          run.subscribers.delete(subscriber);
        }
      };
      // Replay buffered parts (bounded) before going live. This loop is
      // synchronous, so no loop write can interleave — nothing is lost between
      // replay and subscribe.
      for (const part of run.buffer) {
        subscriber(part);
        if (stopped) break;
      }
      if (!stopped) run.subscribers.add(subscriber);
      // Wait until the run finishes (the subscriber has already received the
      // final parts, incl. finish_message, live). If the client already
      // disconnected, the subscriber is detached and this just resolves.
      await run.donePromise;
      run.subscribers.delete(subscriber);
    },
    onError: (error) => (error instanceof Error ? error.message : String(error)),
  });
}
