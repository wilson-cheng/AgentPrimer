/**
 * lib/agent/loop.ts
 * ---------------------------------------------------------------------------
 * The heart of the agent: `runAgentLoop` implements the ReAct (Reason + Act)
 * loop on top of the OpenAI streaming API.
 *
 *   REPEAT up to `maxSteps` times:
 *     1. Call the LLM with the current message history + available tools.
 *        Stream every token to the browser in real-time.
 *     2. After all chunks arrive, check finish_reason:
 *        • "stop"       → model produced a text answer. Done.
 *        • "tool_calls" → model wants to call one or more tools:
 *             a. Emit "9:" (full tool call) to the UI
 *             b. Execute each tool's execute() function
 *             c. Emit "a:" (tool result) to the UI
 *             d. Append assistant message + tool results to message history
 *             e. Go back to step 1
 *   Emit "d:" (finish_message) – browser knows stream is complete
 *   Call onFinish() – route.ts persists the response to SQLite
 */
import OpenAI from 'openai';
import { formatDataStreamPart } from 'ai';
import type { JSONValue } from 'ai';
import type { OutputSchema } from '../memory';
import { upsertAssistantMessage, getSetting } from '../db';
import { getEffectiveOutputLength } from './model-overrides';
import { createAgentTrace, endGeneration, finalizeTrace, startGeneration } from '../langfuse';
import { toolsToOpenAIFormat } from './schema';
import {
  buildIncompleteNotice,
  classifyStreamError,
  createThinkExtractor,
  LENGTH_FINISH_MESSAGE,
  normalizeChatCompletionChunk,
  shouldExecuteToolCalls,
  toSdkFinishReason,
} from './stream';
import {
  sanitizeArgsForClient,
  sanitizeMessagesForClientTrace,
  sanitizeResultForClient,
  sanitizeToolResultContent,
  toJSONValue,
} from './sanitize';
import { normalizeTokenUsage } from './usage';
import { saveReasoning, clearReasoning, persistReasoning } from './reasoning';
import { isVisionRejectionError, stripMultimodalFromMsgs } from './messages';
import { runFinalizeCall } from './finalize';
import type { AgentStepTrace, AgentStreamWriter, ToolSet, TokenUsage } from './types';

export async function runAgentLoop(params: {
  openai: OpenAI;
  modelId: string;
  systemPrompt: string;
  apiMessages: OpenAI.Chat.ChatCompletionMessageParam[];
  tools: ToolSet;
  maxSteps: number;
  writer: AgentStreamWriter;
  sessionId?: string;
  agentName?: string;
  /**
   * Stable id of the assistant message row this run will own. When provided,
   * the loop checkpoints partial progress (text, reasoning, tool calls,
   * parts, trace) to SQLite after every step so a refresh during a long
   * multi-tool run does not lose the work that has already been done.
   */
  assistantMessageId?: string;
  /**
   * Abort signal owned by the RunManager. Fires ONLY when the user clicks
   * Stop (never on a browser/socket disconnect, because the loop now runs
   * detached from the HTTP response). Passed to each `openai.create` call so
   * the in-flight LLM request is cancelled, and checked at the top of every
   * step so a cancel that lands between steps exits cleanly without firing
   * another LLM request.
   */
  abortSignal?: AbortSignal;
  onFinish?: (
    text: string,
    toolCalls: unknown[],
    tokenUsage?: TokenUsage,
    reasoning?: string,
    parts?: unknown[],
    trace?: AgentStepTrace[],
  ) => void | Promise<void>;
  /** Skills injected into the system prompt this turn (surfaced as a chat bubble). */
  activatedSkills?: Array<{ name: string; description: string }>;
  /**
   * Optional inline schema for structured-output agents. When present the
   * loop runs exactly as for a free-text agent and the final assistant
   * message is post-processed by `runFinalizeCall`.
   */
  outputSchema?: OutputSchema;
}): Promise<void> {
  const {
    openai,
    modelId,
    systemPrompt,
    apiMessages,
    tools,
    maxSteps,
    writer,
    sessionId,
    agentName,
    assistantMessageId,
    abortSignal,
    onFinish,
    activatedSkills,
    outputSchema,
  } = params;
  // Convert tools to OpenAI format once (not on every loop iteration)
  const openaiTools = Object.keys(tools).length > 0 ? toolsToOpenAIFormat(tools) : undefined;
  // Build the message array: system prompt always first, then conversation history.
  // This array grows each step as we append tool calls and their results.
  // When the composed system prompt is fully empty (user wiped system.md,
  // their agent prompt, and memory) we send zero system messages so the
  // raw API call is genuinely just `messages: [{ role: 'user', ... }]` —
  // matching what users expect when they "disable everything". OpenAI
  // accepts that fine.
  const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...apiMessages]
    : [...apiMessages];
  let totalText = '';
  const allToolCalls: unknown[] = [];
  const totalUsage: TokenUsage = { input: 0, cached: 0, output: 0 };
  let lastStepInput = 0;
  let lastStepCached = 0;
  // Track the FINAL non-tool-calls step's text only — NOT the cumulative
  // totalText. When `runFinalizeCall` fires it appends this as the last
  // assistant message in the finalize transcript, so we want JUST the
  // final step's prose.
  let lastStepText = '';
  let totalReasoning = '';
  const allParts: unknown[] = [];
  let finalFinishReason = 'stop';

  /**
   * Checkpoint the assistant message row after each completed step so a
   * connection drop or refresh during a long run does not lose progress.
   */
  const CHECKPOINT_MIN_INTERVAL_MS = 1500;
  let lastCheckpointAt = 0;
  let lastCheckpointSig = '';

  const checkpoint = (force = false): void => {
    if (!sessionId || !assistantMessageId) return;
    const sig = `${totalText.length}|${totalReasoning.length}|${allToolCalls.length}|${allParts.length}|${stepTraces.length}|${totalUsage.output}`;
    if (sig === lastCheckpointSig) return;

    const now = Date.now();
    if (!force && now - lastCheckpointAt < CHECKPOINT_MIN_INTERVAL_MS) return;

    try {
      upsertAssistantMessage({
        id: assistantMessageId,
        session_id: sessionId,
        role: 'assistant',
        content: totalText,
        attachments_json: '[]',
        tool_calls_json: JSON.stringify(allToolCalls),
        token_usage_json: JSON.stringify({
          input: lastStepInput,
          cached: lastStepCached,
          output: totalUsage.output,
          source: totalUsage.source,
        }),
        reasoning_json: totalReasoning,
        parts_json: JSON.stringify(allParts),
        trace_json: stepTraces.length > 0 ? JSON.stringify(stepTraces) : '[]',
      });
      lastCheckpointAt = now;
      lastCheckpointSig = sig;
    } catch (err) {
      console.warn('[agent] checkpoint failed:', err instanceof Error ? err.message : err);
    }
  };

  // ── Surface available skills as a chat bubble ──────────────────────────
  if (activatedSkills && activatedSkills.length > 0) {
    writer.write(
      formatDataStreamPart('data', [{ type: 'skills_activated', skills: activatedSkills }]),
    );
    allParts.push({ type: 'skills-activated', skills: activatedSkills });
  }

  const tracingEnabled = getSetting('tracing_enabled') !== 'false';
  const stepTraces: AgentStepTrace[] = [];
  const langfuseTrace = createAgentTrace({
    sessionId,
    agentName,
    modelId,
    promptPreview:
      typeof apiMessages.at(-1)?.content === 'string'
        ? (apiMessages.at(-1)?.content as string)
        : undefined,
  });

  for (let step = 0; step < maxSteps; step++) {
    // ── One-shot schema-agent short-circuit ─────────────────────────────
    if (step === 0 && outputSchema && Object.keys(tools).length === 0) break;

    // ── Explicit cancel (Stop button) ───────────────────────────────────
    // The in-flight LLM call is aborted via `signal` further down; this guard
    // catches a cancel that lands between steps (e.g. during a long tool
    // execution) so we exit without firing another LLM request. We emit an
    // 'aborted' notice + marker + finish_step, then break and let the normal
    // post-loop path emit the single `finish_message` and persist via
    // `onFinish`.
    if (abortSignal?.aborted) {
      const notice = buildIncompleteNotice('aborted');
      totalText += notice;
      allParts.push({ type: 'text', text: notice });
      allParts.push({ type: 'incomplete-marker', reason: 'aborted' });
      writer.write(formatDataStreamPart('text', notice));
      writer.write(formatDataStreamPart('data', [{ type: 'incomplete', reason: 'aborted' }]));
      finalFinishReason = 'aborted';
      writer.write(
        formatDataStreamPart('finish_step', {
          finishReason: toSdkFinishReason('aborted'),
          usage: { promptTokens: 0, completionTokens: 0 },
          isContinued: false,
        }),
      );
      checkpoint(true);
      break;
    }

    const stepStartTime = tracingEnabled ? Date.now() : 0;
    const requestSnapshot = {
      model: modelId,
      messages: sanitizeMessagesForClientTrace(msgs),
      ...(openaiTools ? { tools: toJSONValue(openaiTools) } : {}),
    };
    const traceRequest = tracingEnabled ? requestSnapshot : undefined;
    const langfuseGeneration = startGeneration({
      trace: langfuseTrace,
      name: `agent-step-${step + 1}`,
      model: modelId,
      input: requestSnapshot,
      metadata: { step, toolCount: openaiTools?.length ?? 0 },
    });
    let stepInput = 0,
      stepCached = 0,
      stepOutput = 0;
    allParts.push({ type: 'step-start' });
    writer.write(
      formatDataStreamPart('start_step', {
        messageId: assistantMessageId ?? `step-${Date.now()}-${step}`,
      }),
    );

    // ── 1. Call the LLM with streaming ─────────────────────────────────────
    let stream: Awaited<ReturnType<typeof openai.chat.completions.create>>;
    try {
      stream = await openai.chat.completions.create({
        model: modelId,
        messages: msgs,
        max_tokens: getEffectiveOutputLength(modelId),
        ...(openaiTools ? { tools: openaiTools, tool_choice: 'auto' } : {}),
        stream: true,
        stream_options: { include_usage: true },
        ...(abortSignal ? { signal: abortSignal } : {}),
      });
    } catch (err) {
      if (
        step === 0 &&
        err instanceof OpenAI.APIError &&
        err.status === 400 &&
        isVisionRejectionError(err.message ?? '')
      ) {
        const didStrip = stripMultimodalFromMsgs(msgs);
        if (didStrip) {
          writer.write(
            formatDataStreamPart(
              'text',
              '> ⚠️ *This model does not support image or audio inputs — attachments have been removed. Configure a vision-capable model in Settings to use this feature.*\n\n',
            ),
          );
          stream = await openai.chat.completions.create({
            model: modelId,
            messages: msgs,
            max_tokens: getEffectiveOutputLength(modelId),
            ...(openaiTools ? { tools: openaiTools, tool_choice: 'auto' } : {}),
            stream: true,
            stream_options: { include_usage: true },
            ...(abortSignal ? { signal: abortSignal } : {}),
          });
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    let stepText = '';
    let stepReasoning = '';
    let reasoningWriteAccum = '';
    let finishReason = 'stop';
    const tcAccum = new Map<number, { id: string; name: string; args: string }>();
    const thinkExtractor = createThinkExtractor();

    const writeText = (text: string): void => {
      if (!text) return;
      stepText += text;
      writer.write(formatDataStreamPart('text', text));
    };

    const writeReasoning = (reasoning: string): void => {
      if (!reasoning) return;
      stepReasoning += reasoning;
      reasoningWriteAccum += reasoning;
      if (reasoningWriteAccum.length >= 50) {
        writer.write(formatDataStreamPart('reasoning', reasoningWriteAccum));
        reasoningWriteAccum = '';
      }
    };

    // ── 2. Process each streaming chunk ────────────────────────────────────
    let streamInterrupted: { reason: 'connection_lost' | 'error' | 'aborted'; detail: string } | undefined;
    try {
      for await (const chunk of stream) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chunkUsage = (chunk as any).usage;
        if (chunkUsage) {
          const normalizedUsage = normalizeTokenUsage(chunkUsage);
          totalUsage.input += normalizedUsage.input;
          totalUsage.cached += normalizedUsage.cached;
          totalUsage.output += normalizedUsage.output;
          stepInput += normalizedUsage.input;
          stepCached += normalizedUsage.cached;
          stepOutput += normalizedUsage.output;
          if (normalizedUsage.input > 0) {
            lastStepInput = normalizedUsage.input;
            lastStepCached = normalizedUsage.cached;
          }
          if (normalizedUsage.source !== undefined) {
            totalUsage.source = normalizedUsage.source;
          }
        }

        const normalized = normalizeChatCompletionChunk(chunk);
        if (normalized.finishReason) finishReason = normalized.finishReason;

        writeReasoning(normalized.reasoningDelta);

        if (normalized.textDelta) {
          const split = thinkExtractor.push(normalized.textDelta);
          writeReasoning(split.reasoning);
          writeText(split.text);
        }

        for (const tc of normalized.toolCallDeltas) {
          const idx = tc.index;
          if (!tcAccum.has(idx)) {
            const id = tc.id ?? `tc-${step}-${idx}`,
              name = tc.name ?? '';
            tcAccum.set(idx, { id, name, args: '' });
            writer.write(
              formatDataStreamPart('tool_call_streaming_start', { toolCallId: id, toolName: name }),
            );
          }
          const entry = tcAccum.get(idx)!;
          if (tc.id) entry.id = tc.id;
          if (tc.name) entry.name = tc.name;
          if (tc.argumentsDelta) {
            entry.args += tc.argumentsDelta;
            const suppressLargeArgDelta =
              (entry.name === 'write_file' || entry.name === 'append_file') &&
              entry.args.length > 2000;
            if (!suppressLargeArgDelta) {
              writer.write(
                formatDataStreamPart('tool_call_delta', {
                  toolCallId: entry.id,
                  argsTextDelta: tc.argumentsDelta,
                }),
              );
            }
          }
        }
      }
    } catch (streamErr) {
      const detail = streamErr instanceof Error ? streamErr.message : String(streamErr);
      streamInterrupted = {
        reason: classifyStreamError(detail, abortSignal),
        detail,
      };
      console.warn('[agent] stream interrupted mid-response:', detail);
    }

    // Flush any text/reasoning buffered inside the <think> extractor.
    const tail = thinkExtractor.flush();
    writeReasoning(tail.reasoning);
    writeText(tail.text);

    if (reasoningWriteAccum) {
      writer.write(formatDataStreamPart('reasoning', reasoningWriteAccum));
      reasoningWriteAccum = '';
    }

    totalText += stepText;

    if (sessionId) {
      if (stepReasoning) {
        saveReasoning(sessionId, stepReasoning);
        totalReasoning += stepReasoning;
      } else if (step === 0) clearReasoning(sessionId);
    }

    if (stepReasoning) allParts.push({ type: 'reasoning', reasoning: stepReasoning });
    if (stepText && stepText.trim()) allParts.push({ type: 'text', text: stepText });

    // ── 3. Check finish reason ──────────────────────────────────────────────
    const completedTCs = Array.from(tcAccum.values());
    const hasToolCalls = shouldExecuteToolCalls(finishReason, completedTCs, stepText);

    if (!hasToolCalls || streamInterrupted) {
      lastStepText = stepText;
      const completedTCsForCleanup = streamInterrupted ? [] : completedTCs;
      const abandonedToolCalls = completedTCsForCleanup.map((tc) => {
        let clientArgs: Record<string, unknown>;
        try {
          clientArgs = sanitizeArgsForClient(tc.name, JSON.parse(tc.args));
        } catch {
          clientArgs = {
            error: 'Tool arguments were incomplete and could not be parsed.',
            receivedCharacters: tc.args.length,
          };
        }
        const clientResult = {
          error: `Tool call was not executed because the model finished with '${finishReason}' before completing the call.`,
        };
        writer.write(
          formatDataStreamPart('tool_call', {
            toolCallId: tc.id,
            toolName: tc.name,
            args: clientArgs,
          }),
        );
        writer.write(
          formatDataStreamPart('tool_result', { toolCallId: tc.id, result: clientResult }),
        );
        allToolCalls.push({
          toolCallId: tc.id,
          toolName: tc.name,
          args: clientArgs,
          result: clientResult,
        });
        allParts.push({
          type: 'tool-invocation',
          toolInvocation: {
            toolCallId: tc.id,
            toolName: tc.name,
            state: 'result',
            args: clientArgs,
            result: clientResult,
          },
        });
        return {
          toolCallId: tc.id,
          toolName: tc.name,
          args: toJSONValue(clientArgs),
          result: toJSONValue(clientResult),
        };
      });
      let stepFinishReason = finishReason;
      let incompleteMarker:
        | { reason: 'length' | 'connection_lost' | 'error' | 'aborted'; detail?: string }
        | undefined;
      if (streamInterrupted) {
        stepFinishReason = streamInterrupted.reason;
        incompleteMarker = { reason: streamInterrupted.reason, detail: streamInterrupted.detail };
        const notice = stepText
          ? `\n\n${buildIncompleteNotice(streamInterrupted.reason, streamInterrupted.detail)}`
          : buildIncompleteNotice(streamInterrupted.reason, streamInterrupted.detail);
        stepText += notice;
        totalText += notice;
        const lastPart = allParts[allParts.length - 1] as
          { type?: string; text?: string } | undefined;
        if (lastPart?.type === 'text' && typeof lastPart.text === 'string') {
          lastPart.text += notice;
        } else {
          allParts.push({ type: 'text', text: notice });
        }
        writer.write(formatDataStreamPart('text', notice));
      } else if (finishReason === 'length') {
        incompleteMarker = { reason: 'length' };
        const notice = stepText ? `\n\n${LENGTH_FINISH_MESSAGE}` : LENGTH_FINISH_MESSAGE;
        stepText += notice;
        totalText += notice;
        const lastPart = allParts[allParts.length - 1] as
          { type?: string; text?: string } | undefined;
        if (lastPart?.type === 'text' && typeof lastPart.text === 'string') {
          lastPart.text += notice;
        } else {
          allParts.push({ type: 'text', text: notice });
        }
        writer.write(formatDataStreamPart('text', notice));
      } else if (finishReason === 'stop') {
        stepFinishReason = 'stop';
      }
      if (incompleteMarker) {
        allParts.push({
          type: 'incomplete-marker',
          reason: incompleteMarker.reason,
          detail: incompleteMarker.detail,
        });
        writer.write(
          formatDataStreamPart('data', [
            {
              type: 'incomplete',
              reason: incompleteMarker.reason,
              ...(incompleteMarker.detail ? { detail: incompleteMarker.detail } : {}),
            },
          ]),
        );
      }
      finalFinishReason = stepFinishReason;
      writer.write(
        formatDataStreamPart('finish_step', {
          finishReason: toSdkFinishReason(stepFinishReason),
          usage: { promptTokens: 0, completionTokens: 0 },
          isContinued: false,
        }),
      );
      lastStepText = stepText;
      if (tracingEnabled) {
        stepTraces.push({
          step_index: step,
          duration_ms: Date.now() - stepStartTime,
          finish_reason: stepFinishReason,
          request: traceRequest!,
          token_usage: { input: stepInput, cached: stepCached, output: stepOutput },
          tool_calls: abandonedToolCalls,
        });
      }
      endGeneration({
        generation: langfuseGeneration,
        output: { text: stepText, finishReason: stepFinishReason },
        usage: { input: stepInput, cached: stepCached, output: stepOutput },
        metadata: {
          finishReason: stepFinishReason,
          toolCalls: abandonedToolCalls.map((tc) => tc.toolName),
        },
      });
      checkpoint(true);
      break;
    }

    // ── 4. Execute tool calls ───────────────────────────────────────────────
    const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      content: stepText || null,
      tool_calls: completedTCs.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: tc.args,
        },
      })),
    };
    if (stepReasoning) {
      (
        assistantMsg as OpenAI.Chat.ChatCompletionAssistantMessageParam & {
          reasoning_content?: string;
        }
      ).reasoning_content = stepReasoning;
    }
    msgs.push(assistantMsg);

    let needsApproval = false;
    for (const tc of completedTCs) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.args);
      } catch {
        args = {};
      }
      const clientArgs = sanitizeArgsForClient(tc.name, args);
      writer.write(
        formatDataStreamPart('tool_call', {
          toolCallId: tc.id,
          toolName: tc.name,
          args: clientArgs,
        }),
      );
      allToolCalls.push({ toolCallId: tc.id, toolName: tc.name, args: clientArgs });
      let result: unknown;
      try {
        const toolDef = tools[tc.name];
        result = toolDef?.execute
          ? await toolDef.execute(args)
          : { error: `Tool not found: ${tc.name}` };
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      const clientResult = sanitizeResultForClient(result);
      (allToolCalls[allToolCalls.length - 1] as Record<string, unknown>).result = clientResult;
      allParts.push({
        type: 'tool-invocation',
        toolInvocation: {
          toolCallId: tc.id,
          toolName: tc.name,
          state: 'result',
          args: clientArgs,
          result: clientResult,
        },
      });
      writer.write(
        formatDataStreamPart('tool_result', { toolCallId: tc.id, result: clientResult }),
      );
      msgs.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: sanitizeToolResultContent(result),
      });

      if (
        result &&
        typeof result === 'object' &&
        (result as Record<string, unknown>).requires_approval === true
      ) {
        needsApproval = true;
      }
    }

    if (needsApproval) {
      writer.write(
        formatDataStreamPart('finish_step', {
          finishReason: 'stop',
          usage: { promptTokens: 0, completionTokens: 0 },
          isContinued: false,
        }),
      );
      if (tracingEnabled) {
        const toolCallsTrace = completedTCs.map((tc) => {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.args);
          } catch {
            args = {};
          }
          return {
            toolCallId: tc.id,
            toolName: tc.name,
            args: toJSONValue(sanitizeArgsForClient(tc.name, args)),
            result: { requires_approval: true },
          };
        });
        stepTraces.push({
          step_index: step,
          duration_ms: Date.now() - stepStartTime,
          finish_reason: 'requires_approval',
          request: traceRequest!,
          token_usage: { input: stepInput, cached: stepCached, output: stepOutput },
          tool_calls: toolCallsTrace,
        });
      }
      endGeneration({
        generation: langfuseGeneration,
        output: {
          text: stepText,
          finishReason: 'requires_approval',
          toolCalls: completedTCs.map((tc) => tc.name),
        },
        usage: { input: stepInput, cached: stepCached, output: stepOutput },
        metadata: { finishReason: 'requires_approval', toolCallCount: completedTCs.length },
      });
      checkpoint(true);
      break;
    }

    if (tracingEnabled) {
      const toolCallsTrace = completedTCs.map((tc) => {
        const entry = allToolCalls.find((a) => (a as Record<string, unknown>).toolCallId === tc.id);
        return {
          toolCallId: tc.id,
          toolName: tc.name,
          args: toJSONValue(
            entry
              ? (entry as Record<string, unknown>).args
              : sanitizeArgsForClient(
                  tc.name,
                  (() => {
                    try {
                      return JSON.parse(tc.args);
                    } catch {
                      return {};
                    }
                  })(),
                ),
          ),
          result: toJSONValue(entry ? (entry as Record<string, unknown>).result : undefined),
        };
      });
      stepTraces.push({
        step_index: step,
        duration_ms: Date.now() - stepStartTime,
        finish_reason: finishReason,
        request: traceRequest!,
        token_usage: { input: stepInput, cached: stepCached, output: stepOutput },
        tool_calls: toolCallsTrace,
      });
    }

    endGeneration({
      generation: langfuseGeneration,
      output: { text: stepText, finishReason, toolCalls: completedTCs.map((tc) => tc.name) },
      usage: { input: stepInput, cached: stepCached, output: stepOutput },
      metadata: { finishReason, toolCallCount: completedTCs.length },
    });

    writer.write(
      formatDataStreamPart('finish_step', {
        finishReason: 'tool-calls',
        usage: { promptTokens: 0, completionTokens: 0 },
        isContinued: false,
      }),
    );
    checkpoint();
  }

  // ── 4.5. Finalize call for structured-output agents ─────────────────────
  // Skipped on an explicit abort: the abort already emitted its own
  // finish_step + 'aborted' marker in the break path above, so running the
  // finalize call (whose `openai.create({signal})` would throw AbortError)
  // would otherwise skip the normal post-loop finish_message and let runTurn's
  // catch emit a second finish_step + a wrong 'connection_lost' marker.
  if (outputSchema && !abortSignal?.aborted) {
    const finalize = await runFinalizeCall({
      openai,
      modelId,
      loopMsgs: msgs,
      finalText: lastStepText,
      schema: outputSchema,
      writer,
      allParts,
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
    totalUsage.input += finalize.usage.input;
    totalUsage.cached += finalize.usage.cached;
    totalUsage.output += finalize.usage.output;
    totalUsage.source = finalize.usage.source;
    if (finalize.usage.input > lastStepInput) lastStepInput = finalize.usage.input;
    if (finalize.usage.cached > lastStepCached) lastStepCached = finalize.usage.cached;
    if (!totalText) {
      try {
        totalText = JSON.stringify(finalize.data, null, 2);
      } catch {
        /* unserialisable — leave totalText empty */
      }
    }
    const structuredPart = {
      type: 'structured-output' as const,
      data: finalize.data,
      schemaName: outputSchema.label,
      schemaLabel: outputSchema.label,
    };
    allParts.push(structuredPart);
    writer.write(
      formatDataStreamPart('data', [
        {
          type: 'structured_output',
          data: finalize.data as JSONValue,
          schemaName: outputSchema.label,
          schemaLabel: outputSchema.label,
        },
      ]),
    );
  }

  // ── 5. Finalize the stream ─────────────────────────────────────────────
  if (totalUsage.input > 0 || totalUsage.output > 0) {
    const usageData: Record<string, JSONValue> = {
      type: 'token_usage',
      input: lastStepInput,
      cached: lastStepCached,
      output: totalUsage.output,
    };
    if (totalUsage.source !== undefined) usageData.source = totalUsage.source;
    writer.write(formatDataStreamPart('data', [usageData]));
  }
  if (stepTraces.length > 0) {
    writer.write(
      formatDataStreamPart('data', [
        { type: 'agent_trace', trace: stepTraces } as {
          type: 'agent_trace';
          trace: AgentStepTrace[];
        },
      ]),
    );
  }
  writer.write(
    formatDataStreamPart('finish_message', {
      finishReason: toSdkFinishReason(finalFinishReason),
      usage: { promptTokens: totalUsage.input, completionTokens: totalUsage.output },
    }),
  );
  const displayUsage: TokenUsage = {
    input: lastStepInput,
    cached: lastStepCached,
    output: totalUsage.output,
    source: totalUsage.source,
  };
  // Persist the assistant row FIRST. Bookkeeping (Langfuse trace flush,
  // reasoning cache write) comes after — any failure in those is
  // best-effort and must not be propagated, otherwise the caller would
  // treat a successful turn as an error and overwrite the row with an
  // "incomplete" notice.
  if (onFinish)
    await onFinish(
      totalText,
      allToolCalls,
      displayUsage,
      totalReasoning || undefined,
      allParts,
      stepTraces.length > 0 ? stepTraces : undefined,
    );
  try {
    await finalizeTrace({ trace: langfuseTrace, output: totalText, traceData: stepTraces });
  } catch (err) {
    console.warn(
      '[agent] finalizeTrace failed (ignored):',
      err instanceof Error ? err.message : err,
    );
  }
  // Persist reasoning to SQLite now that streaming is done.
  try {
    if (sessionId) persistReasoning(sessionId);
  } catch (err) {
    console.warn(
      '[agent] persistReasoning failed (ignored):',
      err instanceof Error ? err.message : err,
    );
  }
}
