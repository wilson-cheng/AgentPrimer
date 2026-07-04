/**
 * lib/agent/index.ts
 * ---------------------------------------------------------------------------
 * Public surface of the agent module. Imports of `@/lib/agent` resolve here
 * via the thin re-export at `lib/agent.ts` (preserved for backwards
 * compatibility with the rest of the codebase and external tooling).
 */

// AI SDK helper re-export so callers can `import { tool } from '@/lib/agent'`.
export { tool } from 'ai';

// Types
export type {
  AgentTool,
  ToolSet,
  TokenUsage,
  AgentStepTrace,
  AgentStreamWriter,
  NormalizedToolCallDelta,
  NormalizedChatDelta,
  ThinkExtractorChunk,
  ThinkExtractor,
  Attachment,
  ModelInfo,
  SdkFinishReason,
} from './types';

// Client + DI seam
export {
  createOpenAIClient,
  fetchAvailableModels,
  sanitizeKey,
  setOpenAIClientFactory,
  resetOpenAIClientFactory,
} from './openai-client';
export type { OpenAIClient, OpenAIClientFactory } from './openai-client';

// Schema helpers
export { zodToOpenAISchema, toolsToOpenAIFormat } from './schema';

// Streaming primitives
export {
  normalizeChatCompletionChunk,
  createThinkExtractor,
  shouldExecuteToolCalls,
  normalizeFinishReason,
  toSdkFinishReason,
  buildIncompleteNotice,
  LENGTH_FINISH_MESSAGE,
} from './stream';

// Reasoning cache
export { loadReasoning, saveReasoning, clearReasoning, persistReasoning } from './reasoning';

// Token usage
export { normalizeTokenUsage } from './usage';

// Sanitizers
export {
  toJSONValue,
  summarizeStringForClient,
  sanitizeArgsForClient,
  sanitizeResultForClient,
  sanitizeToolResultContent,
  sanitizeMessagesForClientTrace,
} from './sanitize';

// Messages / context / multimodal
export {
  convertMessagesToOpenAI,
  compactConversation,
  isVisionRejectionError,
  stripMultimodalFromMsgs,
  resolveUploadPath,
  buildMultimodalContent,
} from './messages';

// Prompt assembly
export { buildSystemPrompt } from './prompt';

// Finalize
export { buildFinalizeSystemPrompt, buildFinalizeRequest, runFinalizeCall } from './finalize';

// Model resolution
export { getAvailableModelIds, resolveModelWithFallback } from './model-resolver';

// Built-in tools
export { createBuiltinTools, getBuiltinToolParameterSchemas } from './builtin-tools';

// Loop
export { runAgentLoop } from './loop';

// Detached background-run manager (loop survives browser disconnect; Stop button)
export {
  startRun,
  createTailResponse,
  abortRun,
  getActiveRun,
  isSessionRunning,
  RUN_IN_PROGRESS,
  RUN_IN_PROGRESS_MESSAGE,
} from './run-manager';

// Public entry point
export { createStreamingAgent } from './streaming-agent';
