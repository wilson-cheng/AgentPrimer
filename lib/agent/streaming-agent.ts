/**
 * lib/agent/streaming-agent.ts
 * ---------------------------------------------------------------------------
 * `createStreamingAgent` — the sole public entry point called by
 * `app/api/chat/route.ts`. Orchestrates the full agent lifecycle:
 *
 *   1. Reads agent config from agent.md
 *   2. Reads the active agent's memory content
 *   3. Loads skill tools + MCP tools + built-in tools
 *   4. Converts useChat format → OpenAI API message format
 *   5. Applies optional sliding-window compaction
 *   6. Injects multimodal attachments
 *   7. Returns a streaming HTTP Response consumed by the useChat hook
 */
import { createDataStreamResponse, formatDataStreamPart } from 'ai';
import { getSetting, getPendingNotifications, markNotificationsRead } from '../db';
import { readMemory, getAgentConfig, hasNoTools, MAIN_AGENT_NAME } from '../memory';
import type { OutputSchema } from '../memory';
import { buildSkillDiscoverySection } from '../skills-loader';
import { loadFunctionTools } from '../function-tools-loader';
import { loadMcpTools } from '../mcp-client';
import { createOpenAIClient } from './openai-client';
import { createBuiltinTools } from './builtin-tools';
import { buildSystemPrompt } from './prompt';
import { resolveModelWithFallback } from './model-resolver';
import { convertMessagesToOpenAI, compactConversation, buildMultimodalContent, ensureToolInvocations } from './messages';
import { loadReasoning, clearReasoning } from './reasoning';
import { buildIncompleteNotice, classifyStreamError } from './stream';
import { runAgentLoop } from './loop';
import { startRun, createTailResponse } from './run-manager';
import type { AgentStepTrace, AgentStreamWriter, Attachment, TokenUsage, ToolSet } from './types';
import type OpenAI from 'openai';

export async function createStreamingAgent(params: {
  agentName?: string;
  modelId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[];
  sessionId?: string;
  /** Attachments from the current user turn to inject as multimodal content */
  attachments?: Attachment[];
  /** Pre-allocated assistant message id for incremental persistence (see runAgentLoop). */
  assistantMessageId?: string;
  /** Authenticated username scoping the detached run registry so one user can't
   *  stop/inspect another's run. Only used on the detached path. */
  user?: string | null;
  /**
   * When true (default), run the agent loop detached from the HTTP response so
   * it survives a browser disconnect and can be stopped via /api/chat/stop.
   * Set false for server-internal callers that consume the whole response
   * themselves (the async sub-agent follow-up) — there's no browser to
   * disconnect, so coupling the loop to the response is fine and simpler.
   */
  detached?: boolean;
  onFinish?: (
    text: string,
    toolCalls: unknown[],
    tokenUsage?: TokenUsage,
    reasoning?: string,
    parts?: unknown[],
    trace?: AgentStepTrace[],
  ) => void | Promise<void>;
}): Promise<Response> {
  const {
    agentName = MAIN_AGENT_NAME,
    modelId,
    onFinish,
    sessionId,
    assistantMessageId,
    user,
    detached = true,
  } = params;

  const config = getAgentConfig(agentName);
  const memory = readMemory(config.name);

  // ── No endpoint / API key configured? Emit a friendly message and stop. ──
  const configuredEndpoint = getSetting('endpoint');
  const configuredApiKey = getSetting('api_key');
  if (!configuredEndpoint || !configuredApiKey) {
    return createDataStreamResponse({
      execute: async (writer) => {
        const missingParts: string[] = [];
        if (!configuredEndpoint) missingParts.push('**Base URL**');
        if (!configuredApiKey) missingParts.push('**API Key**');
        const message =
          `⚠️ ${missingParts.join(' and ')} ${missingParts.length === 1 ? 'is' : 'are'} not configured.\n\n` +
          'Open the [Settings page](/settings) and fill in your OpenAI-compatible ' +
          `${missingParts.join(' and ')}, then try again.`;
        writer.write(
          formatDataStreamPart('start_step', {
            messageId: assistantMessageId ?? `step-no-api-${sessionId ?? 'anon'}`,
          }),
        );
        writer.write(formatDataStreamPart('text', message));
        writer.write(
          formatDataStreamPart('finish_step', {
            finishReason: 'stop',
            usage: { promptTokens: 0, completionTokens: 0 },
            isContinued: false,
          }),
        );
        writer.write(
          formatDataStreamPart('finish_message', {
            finishReason: 'stop',
            usage: { promptTokens: 0, completionTokens: 0 },
          }),
        );
        if (onFinish) {
          await onFinish(
            message,
            [],
            { input: 0, cached: 0, output: 0 },
            undefined,
            [{ type: 'text', text: message }],
            undefined,
          );
        }
      },
      onError: (error) => (error instanceof Error ? error.message : String(error)),
    });
  }

  const openai = createOpenAIClient();

  // ── Structured output ──────────────────────────────────────────────────
  const outputSchemaConfig: OutputSchema | undefined = config.outputSchema;

  // ── Tool assembly ───────────────────────────────────────────────────────
  // Special case: `**Tools:** none` in agent.md means no tools at all.
  const isNoTools = hasNoTools(config.tools);

  if (outputSchemaConfig && !isNoTools) {
    console.warn(
      `[agent] "${agentName}" pairs **Output Schema:** with tools — running the ReAct ` +
        `loop + one finalize call (N+1 LLM calls per turn). Add "**Tools:** none" (or omit ` +
        `the **Tools:** line) for one-shot extraction (1 LLM call per turn).`,
    );
  }

  const functionTools = isNoTools ? {} : loadFunctionTools(config.tools);
  const mcpTools = isNoTools ? {} : await loadMcpTools(config.tools);
  // Pass the per-agent skill filter so the `load_skill` built-in tool can
  // enforce the same allow-list as the Stage 1 discovery section.
  const builtins = isNoTools
    ? {}
    : createBuiltinTools(agentName, sessionId, undefined, sessionId, config.tools);
  const allTools = { ...functionTools, ...mcpTools, ...builtins } as ToolSet;

  const pendingNotifications = sessionId ? getPendingNotifications(sessionId) : [];
  if (pendingNotifications.length && sessionId) markNotificationsRead(sessionId);

  const resolvedModel = await resolveModelWithFallback(modelId, config.model, agentName);

  // ── System prompt assembly ─────────────────────────────────────────────
  const { section: skillSection, skills: activatedSkills } = buildSkillDiscoverySection(
    config.tools,
  );

  const basePrompt = buildSystemPrompt(
    config.systemPrompt,
    memory,
    pendingNotifications.length ? pendingNotifications : undefined,
  );

  const systemPrompt = basePrompt + skillSection;

  const lastReasoning = sessionId ? loadReasoning(sessionId) : '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sanitized = (params.messages as any[]).filter((msg: any) => {
    if (msg.role !== 'assistant') return true;
    const invocations: Array<{ state: string }> = msg.toolInvocations ?? [];
    return invocations.every((t) => t.state === 'result');
  });

  // From-DB messages (reloaded after switching sessions) carry tool_calls_json
  // but no live `toolInvocations`; reconstruct them so convertMessagesToOpenAI
  // doesn't silently drop every tool call + result from the LLM history.
  const withToolInvocations = ensureToolInvocations(sanitized);

  const apiMessages = convertMessagesToOpenAI(withToolInvocations, lastReasoning);
  if (sessionId && lastReasoning) clearReasoning(sessionId);

  // ── Sliding-window context compaction ───────────────────────────────────
  const keepPairs = parseInt(getSetting('context_keep_pairs') || '0', 10);
  if (keepPairs > 0) {
    const beforeCount = apiMessages.length;
    const compacted = compactConversation(apiMessages, keepPairs);
    const dropped = beforeCount - compacted.length;
    if (dropped > 0) {
      compacted.splice(1, 0, {
        role: 'system',
        content: `[System: The conversation was compacted — ${dropped} older message(s) were removed to stay within the context window. The last ${keepPairs} exchanges are preserved.]`,
      });
      (apiMessages as OpenAI.Chat.ChatCompletionMessageParam[]).length = 0;
      apiMessages.push(...compacted);
    }
  }

  // ── Inject multimodal content into the last user message ───────────────
  if (params.attachments?.length) {
    const lastUserIdx = apiMessages.reduceRight(
      (found, msg, i) => (found === -1 && (msg as { role: string }).role === 'user' ? i : found),
      -1,
    );
    if (lastUserIdx !== -1) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = apiMessages[lastUserIdx] as any;
      const textContent = typeof msg.content === 'string' ? msg.content : '';
      const multiParts = await buildMultimodalContent(textContent, params.attachments);
      if (multiParts.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (apiMessages[lastUserIdx] as any).content = multiParts;
      }
    }
  }

  const storedMaxSteps = parseInt(getSetting('max_agent_steps') || '0', 10);
  const maxSteps = storedMaxSteps > 0 ? storedMaxSteps : 100;

  // ── No model configured? Emit a friendly message and stop. ──────────────
  if (!resolvedModel) {
    return createDataStreamResponse({
      execute: async (writer) => {
        const message =
          '⚠️ No default model is configured.\n\n' +
          'Open the [Settings page](/settings) and pick a model under ' +
          '**Default Model**, then try again.';
        writer.write(
          formatDataStreamPart('start_step', {
            messageId: assistantMessageId ?? `step-no-model-${sessionId ?? 'anon'}`,
          }),
        );
        writer.write(formatDataStreamPart('text', message));
        writer.write(
          formatDataStreamPart('finish_step', {
            finishReason: 'stop',
            usage: { promptTokens: 0, completionTokens: 0 },
            isContinued: false,
          }),
        );
        writer.write(
          formatDataStreamPart('finish_message', {
            finishReason: 'stop',
            usage: { promptTokens: 0, completionTokens: 0 },
          }),
        );
        if (onFinish) {
          await onFinish(
            message,
            [],
            { input: 0, cached: 0, output: 0 },
            undefined,
            [{ type: 'text', text: message }],
            undefined,
          );
        }
      },
      onError: (error) => (error instanceof Error ? error.message : String(error)),
    });
  }

  // `runTurn` wraps `runAgentLoop` with the same error contract the old
  // inline `execute` had: a throw from incidental post-success bookkeeping is
  // swallowed, anything else becomes an incomplete-notice + finish so the
  // assistant row is persisted with a resumable marker. Shared by both the
  // detached (browser-facing) and non-detached (server-internal follow-up)
  // execution paths.
  const runTurn = async (writer: AgentStreamWriter, abortSignal?: AbortSignal): Promise<void> => {
    // `loopSettled` flips true the moment `runAgentLoop` returns without
    // throwing. After that point the assistant row has already been
    // persisted (via `onFinish` inside the loop) and the success-side of
    // the stream has been written; any later throw from incidental work
    // (finalize-trace flush, reasoning persistence, the user's onFinish
    // bookkeeping) must NOT be turned into an "incomplete" notice that
    // overwrites the successful response.
    let loopSettled = false;
    try {
      await runAgentLoop({
        openai,
        modelId: resolvedModel,
        systemPrompt,
        apiMessages,
        tools: allTools,
        maxSteps,
        writer,
        sessionId,
        agentName,
        assistantMessageId,
        onFinish,
        activatedSkills,
        outputSchema: outputSchemaConfig,
        abortSignal,
      });
      loopSettled = true;
    } catch (err) {
      if (loopSettled) {
        console.warn(
          '[agent] post-success bookkeeping failed (ignored):',
          err instanceof Error ? err.message : err,
        );
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      const reason = classifyStreamError(detail, abortSignal);
      const notice = buildIncompleteNotice(reason, detail);
      try {
        writer.write(formatDataStreamPart('text', notice));
        writer.write(formatDataStreamPart('data', [{ type: 'incomplete', reason, detail }]));
        writer.write(
          formatDataStreamPart('finish_step', {
            finishReason: reason === 'error' ? 'error' : 'unknown',
            usage: { promptTokens: 0, completionTokens: 0 },
            isContinued: false,
          }),
        );
        writer.write(
          formatDataStreamPart('finish_message', {
            finishReason: reason === 'error' ? 'error' : 'unknown',
            usage: { promptTokens: 0, completionTokens: 0 },
          }),
        );
      } catch {
        /* writer may already be closed */
      }
      if (onFinish) {
        try {
          await onFinish(
            notice,
            [],
            { input: 0, cached: 0, output: 0 },
            undefined,
            [
              { type: 'text', text: notice },
              { type: 'incomplete-marker', reason, detail },
            ],
            undefined,
          );
        } catch (persistErr) {
          console.warn('[agent] failed to persist incomplete state:', persistErr);
        }
      }
      console.warn('[agent] runAgentLoop failed:', detail);
    }
  };

  // ── Detached background run (browser-facing) ───────────────────────────
  // The loop runs as a floating promise owned by the RunManager, writing to a
  // replay buffer; the returned Response tails that buffer. Closing the browser
  // only tears down the tail — the loop keeps going and keeps checkpointing, so
  // a later reopen sees the result. `startRun` throws RUN_IN_PROGRESS if a run
  // is already live for this session (the caller maps that to a 409).
  if (detached && sessionId && assistantMessageId) {
    const { run } = startRun({
      owner: user,
      sessionId,
      assistantMessageId,
      work: (writer, signal) => runTurn(writer, signal),
    });
    return createTailResponse(run);
  }

  // ── Coupled run (server-internal callers, e.g. the async sub-agent ─────
  // follow-up) that consume the whole response via `response.text()`. There's
  // no browser to disconnect and no Stop button, so tying the loop to the
  // response stream is both fine and simpler.
  return createDataStreamResponse({
    execute: async (writer) => {
      await runTurn(writer);
    },
    onError: (error) => (error instanceof Error ? error.message : String(error)),
  });
}
