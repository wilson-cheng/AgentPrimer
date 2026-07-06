/**
 * lib/agent/finalize.ts
 * ---------------------------------------------------------------------------
 * Post-loop finalize call for structured-output agents.
 *
 * The finalize call is a SEPARATE non-streaming request, fired after the
 * main ReAct loop ends for any agent with an `**Output Schema:**`. Its job
 * is one thing only: turn the loop's transcript into a JSON object that
 * matches the schema. Nothing else.
 */
import OpenAI from 'openai';
import { formatDataStreamPart } from 'ai';
import type { OutputSchema } from '../memory';
import { getEffectiveOutputLength } from './model-overrides';
import { normalizeTokenUsage } from './usage';
import { toJSONValue } from './sanitize';
import type { AgentStreamWriter, TokenUsage } from './types';

/**
 * Build the system prompt for the finalize call.
 *
 * Why a tiny dedicated prompt instead of reusing the agent's main prompt:
 *   The agent's own prompt may contain extensive role-playing, tool
 *   instructions, etc. — none of that is relevant to "now convert the
 *   conversation you just had into JSON". A focused finalize prompt keeps
 *   the model on-task and minimises token overhead.
 */
export function buildFinalizeSystemPrompt(schema: OutputSchema): string {
  const schemaJson = JSON.stringify(schema.schema, null, 2);
  return `You will receive a conversation transcript. Read it carefully, then emit a single JSON object that captures the final answer according to the schema below.

Rules:
- Output ONLY the raw JSON object — no prose, no explanation, no markdown code fences.
- Every field listed in "required" MUST be present in your output.
- Use an empty array \`[]\` or empty string \`""\` for fields with no applicable data.
- Do not add extra fields not in the schema.

## Schema: ${schema.label}
${schema.description}

\`\`\`json
${schemaJson}
\`\`\``;
}

/**
 * Build the exact OpenAI Chat Completions request body for a finalize call.
 *
 * Returned object is intended both for (a) actually firing the request and
 * (b) being streamed to the UI as the `finalize_call` payload so the user
 * can inspect what's about to be sent BEFORE the response comes back.
 *
 * Loop transcript (`loopMsgs`) starts at index 1 — we skip the loop's own
 * system message (which describes the agent's role + tools) because none
 * of that is relevant to "now produce JSON".
 *
 * The finalize user message is fixed and minimal: it just nudges the model
 * to produce the structured object from the conversation it just saw.
 */
export function buildFinalizeRequest(args: {
  modelId: string;
  loopMsgs: OpenAI.Chat.ChatCompletionMessageParam[];
  finalText: string;
  schema: OutputSchema;
}): {
  model: string;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response_format: any;
  max_tokens: number;
  stream: false;
} {
  const { modelId, loopMsgs, finalText, schema } = args;
  const transcript: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildFinalizeSystemPrompt(schema) },
    // Skip the loop's own system message (index 0) — keep user/assistant/tool turns.
    ...loopMsgs.slice(1),
    // Append the final assistant message that ended the loop (it was never
    // pushed to loopMsgs because the loop breaks before push when no
    // tool_calls were emitted).
    ...(finalText ? [{ role: 'assistant' as const, content: finalText }] : []),
    {
      role: 'user',
      content:
        'The conversation above is complete. Emit a single JSON object that captures ' +
        'the final answer according to the schema in the system prompt. Output JSON only.',
    },
  ];
  return {
    model: modelId,
    messages: transcript,
    max_tokens: getEffectiveOutputLength(modelId),
    response_format: { type: 'json_object' },
    stream: false,
  };
}

/**
 * runFinalizeCall — always-fires post-loop call for structured-output agents.
 *
 *   • Always runs (no parse-first short-circuit).
 *   • Has no retry / repair stages.
 *   • Emits a pre-call `finalize_call` data event AND pushes a persisted
 *     `finalize-call` part so the UI can render an expandable bubble
 *     showing what's about to be sent.
 *   • Strict-parses the response with `JSON.parse` only. No tolerant
 *     extraction. If parsing fails, the structured-output panel renders
 *     a `parse_error` field — the user's signal that the model or prompt
 *     needs adjustment.
 *
 * A 400/422 fallback for providers that reject `response_format` is kept,
 * because that's not "hiding model failure" — it's just provider compat.
 */
export async function runFinalizeCall(args: {
  openai: OpenAI;
  modelId: string;
  loopMsgs: OpenAI.Chat.ChatCompletionMessageParam[];
  finalText: string;
  schema: OutputSchema;
  writer: AgentStreamWriter;
  allParts: unknown[];
  /** Abort signal from the RunManager — cancels the finalize HTTP call on Stop. */
  signal?: AbortSignal;
}): Promise<{ data: unknown; usage: TokenUsage }> {
  const { openai, modelId, loopMsgs, finalText, schema, writer, allParts, signal } = args;

  const request = buildFinalizeRequest({ modelId, loopMsgs, finalText, schema });

  // Announce the finalize call BEFORE firing it, so the user sees a bubble
  // with the request payload at the moment the API call leaves the building.
  const finalizeMeta = {
    type: 'finalize-call' as const,
    schemaLabel: schema.label,
    payload: toJSONValue(request),
  };
  allParts.push(finalizeMeta);
  writer.write(
    formatDataStreamPart('data', [
      { type: 'finalize_call', schemaLabel: schema.label, payload: toJSONValue(request) },
    ]),
  );

  let response: OpenAI.Chat.ChatCompletion;
  try {
    response = await openai.chat.completions.create({
      model: request.model,
      messages: request.messages,
      max_tokens: request.max_tokens,
      response_format: request.response_format,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof OpenAI.APIError && (err.status === 400 || err.status === 422)) {
      // Provider doesn't support response_format — retry once without it.
      response = await openai.chat.completions.create({
        model: request.model,
        messages: request.messages,
        max_tokens: request.max_tokens,
        ...(signal ? { signal } : {}),
      });
    } else {
      throw err;
    }
  }

  const rawText = response.choices[0]?.message?.content ?? '{}';
  const usage = normalizeTokenUsage(response.usage);

  // Strict parse. No tolerant extraction — surfacing parse errors is part
  // of the educational contract.
  let data: unknown;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    data = {
      parse_error: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
      raw_finalize_response: rawText,
    };
  }

  return { data, usage };
}
