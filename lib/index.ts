/**
 * lib/index.ts
 * ---------------------------------------------------------------------------
 * Barrel export for the lib/ module. Existing deep imports
 * (`import { getSetting } from '@/lib/db'`) continue to work unchanged. This
 * barrel adds an alternative grouped import surface:
 *
 *     import { createStreamingAgent, getSetting, readMemory } from '@/lib';
 *
 * Only public, stable functions/types are re-exported here. Internal helpers
 * remain importable via their original paths.
 */

// Agent module (already a barrel of its own)
export * from './agent';

// Database / persistence
export {
  getSetting,
  setSetting,
  saveMessage,
  deleteMessage,
  upsertAssistantMessage,
  touchSession,
  getSession,
  createSession,
  updateSessionTitle,
  createAgentTask,
  finishAgentTask,
  listAgentTasksByAgent,
  createAgentNotification,
  getPendingNotifications,
  markNotificationsRead,
  DATA_DIR,
} from './db';
export type { AgentNotification } from './db';

// Auth
export * from './auth';

// Memory / agent config
export {
  readMemory,
  writeMemory,
  getAgentConfig,
  readSystemPrompt,
  hasNoTools,
  MAIN_AGENT_NAME,
  safeAgentDirName,
  getAgentDir,
  getAgentFile,
  getAgentMemoryFile,
  getAgentRelativePath,
  getAgentMemoryRelativePath,
} from './memory';
export type { OutputSchema } from './memory';

// Built-in tools registry
export { isBuiltinToolEnabled, listBuiltinToolsWithState } from './builtin-tools-registry';

// Approval gate
export { isApproved, consumeOnce } from './approval-store';
export type { ApprovalOperation } from './approval-store';

// Skills / tools loaders
export {
  buildSkillContextSection,
  buildSkillDiscoverySection,
  loadOneSkillBody,
} from './skills-loader';
export { loadFunctionTools } from './function-tools-loader';
export { loadMcpTools } from './mcp-client';

// RAG
export { retrieveChunks } from './rag';

// Path security
export { resolveAgentPath } from './path-security';

// Model metadata
export { getOutputLength, lookupContextLength } from './model-lengths';
