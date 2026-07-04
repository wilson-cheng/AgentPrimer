/**
 * lib/agent/types.ts
 * ---------------------------------------------------------------------------
 * Shared types used across the agent module. These are pure type definitions
 * and have no runtime behavior.
 */
import type { z } from 'zod';
import type { JSONValue, formatDataStreamPart } from 'ai';

// ── Tool types ──────────────────────────────────────────────────────────────
// AgentTool represents a single callable function exposed to the AI model.
// `description` is the natural-language hint the model reads to decide WHEN to call it.
// `parameters` is a Zod schema used for runtime validation AND JSON Schema generation.
// `execute` is the TypeScript function that actually runs when the model calls the tool.
export type AgentTool = {
  description?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parameters: z.ZodType<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute?: (args: any, ...rest: any[]) => PromiseLike<unknown> | Promise<unknown>;
};

export type ToolSet = Record<string, AgentTool>;

// ── Stream writer ───────────────────────────────────────────────────────────
// The exact wire-format string `formatDataStreamPart` produces — a tagged
// template literal union like `0:"..."\n`, `b:{...}\n`, `d:{...}\n`. Typing
// the writer against this (not plain `string`) keeps it compatible with the
// AI SDK's `DataStreamWriter`, whose `write` accepts only this union. That
// lets the loop write to either a real AI SDK response writer OR a
// background-run buffer writer that implements the same surface.
export type AgentStreamPart = ReturnType<typeof formatDataStreamPart>;

export interface AgentStreamWriter {
  write: (part: AgentStreamPart) => void;
}

// ── Token usage ─────────────────────────────────────────────────────────────
export interface TokenUsage {
  input: number;
  cached: number;
  output: number;
  source?: JSONValue;
}

// ── Step traces ─────────────────────────────────────────────────────────────
export interface AgentStepTrace {
  [key: string]: JSONValue;
  step_index: number;
  duration_ms: number;
  finish_reason: string;
  request: { [key: string]: JSONValue; model: string; messages: JSONValue };
  token_usage: { [key: string]: JSONValue; input: number; cached: number; output: number };
  tool_calls: Array<{
    [key: string]: JSONValue;
    toolCallId: string;
    toolName: string;
    args: JSONValue;
    result: JSONValue;
  }>;
}

// ── Streaming normalized deltas ────────────────────────────────────────────
export interface NormalizedToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

export interface NormalizedChatDelta {
  finishReason?: string;
  textDelta: string;
  reasoningDelta: string;
  toolCallDeltas: NormalizedToolCallDelta[];
}

// ── Think extractor (for providers that inline <think>…</think>) ───────────
export interface ThinkExtractorChunk {
  text: string;
  reasoning: string;
}

export interface ThinkExtractor {
  push(delta: string): ThinkExtractorChunk;
  flush(): ThinkExtractorChunk;
}

// ── Multimodal attachment ──────────────────────────────────────────────────
export type Attachment = { name: string; url: string; mime: string; size: number };

// ── Model discovery ────────────────────────────────────────────────────────
export interface ModelInfo {
  id: string;
  context_length?: number;
  max_output_tokens?: number;
}

// ── SDK finish reason mapping ──────────────────────────────────────────────
export type SdkFinishReason =
  'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | 'unknown';
