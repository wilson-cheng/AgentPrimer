/**
 * lib/builtin-tools-registry.ts
 * ---------------------------------------------------------------------------
 * Metadata catalogue for every built-in agent tool, plus helpers to read and
 * write their enabled/disabled state from the SQLite settings table.
 *
 * The registry is the single source of truth for:
 *   • What built-in tools exist          (used by the Skills UI)
 *   • Which are enabled                  (read by the agent loop)
 *   • Default enabled state              (run_shell defaults OFF)
 */

import { getSetting, setSetting } from './db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BuiltinToolCategory = 'filesystem' | 'memory' | 'agent' | 'shell' | 'output' | 'skill';

export interface BuiltinToolMeta {
  /** Matches the key used in the ToolSet – also the settings key suffix */
  id: string;
  /** Human-readable name shown in the UI */
  label: string;
  /** One-line description shown in the UI */
  description: string;
  category: BuiltinToolCategory;
  /**
   * If true, the card is highlighted in amber/red with a warning badge.
   * Use for tools that can cause irreversible or dangerous side-effects.
   */
  dangerous?: boolean;
  /** Whether the tool ships enabled by default (false → must be opted in) */
  defaultEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export const BUILTIN_TOOLS: BuiltinToolMeta[] = [
  // Output – send files to the user
  {
    id: 'send_file',
    label: 'Send File',
    description:
      'Deliver generated or existing files (images, audio, video, PDFs, CSVs…) directly in the chat with inline preview and a download button.',
    category: 'output',
    defaultEnabled: true,
  },
  {
    id: 'open_preview',
    label: 'Open Preview',
    description:
      'Open a file in the Preview Panel (HTML apps, images, PDFs, Markdown) so the user can see it without leaving the chat.',
    category: 'output',
    defaultEnabled: true,
  },

  // Memory
  {
    id: 'append_memory',
    label: 'Append Memory',
    description:
      "Append notes to this agent's private memory file so it remembers important information across conversations.",
    category: 'memory',
    defaultEnabled: true,
  },
  {
    id: 'replace_memory',
    label: 'Replace Memory',
    description:
      "Overwrite this agent's private memory file with new content. Dangerous — that agent's existing memory is lost.",
    category: 'memory',
    dangerous: true,
    defaultEnabled: true,
  },

  // Agent orchestration
  {
    id: 'create_agent',
    label: 'Create Agent',
    description:
      'Create a new agent folder with agent.md and memory.md from a name and system prompt.',
    category: 'agent',
    defaultEnabled: true,
  },
  {
    id: 'run_subagent_async',
    label: 'Run Sub-agent (async)',
    description:
      'Launch a sub-agent as a background task. Returns immediately with a task file to monitor. Sub-agents can nest further sub-agents.',
    category: 'agent',
    defaultEnabled: true,
  },
  {
    id: 'update_task_status',
    label: 'Update Task Status',
    description:
      'Append a progress, finished, or error entry to the current async task file. Only available inside async sub-agents.',
    category: 'agent',
    defaultEnabled: true,
  },
  {
    id: 'list_tasks',
    label: 'List Tasks',
    description:
      'List async sub-agent tasks where this agent is the assigner or assignee, with current status from the task file.',
    category: 'agent',
    defaultEnabled: true,
  },

  // Skills — Stage 2 activation (full SKILL.md body on demand)
  {
    id: 'load_skill',
    label: 'Load Skill',
    description:
      'Activate one of the available skills by name and load its full SKILL.md body into the conversation. Used for the Stage 2 step of progressive disclosure (Stage 1 names + descriptions are always in the system prompt).',
    category: 'skill',
    defaultEnabled: true,
  },

  // Filesystem – read
  {
    id: 'read_file',
    label: 'Read Files',
    description:
      'Read the contents of any file. Reading hidden/dot files (e.g. .env) requires separate approval.',
    category: 'filesystem',
    defaultEnabled: true,
  },
  {
    id: 'list_directory',
    label: 'List Directory',
    description: 'Browse the contents of a directory.',
    category: 'filesystem',
    defaultEnabled: true,
  },
  {
    id: 'stat_path',
    label: 'Inspect File Metadata',
    description: 'Get file or directory stats: size, type, permissions and timestamps.',
    category: 'filesystem',
    defaultEnabled: true,
  },
  {
    id: 'search_files',
    label: 'Search Files',
    description: 'Search for files by name glob or grep for text within files.',
    category: 'filesystem',
    defaultEnabled: true,
  },

  // Filesystem – write
  {
    id: 'edit_file',
    label: 'Edit File (patch)',
    description:
      'Replace an exact string in an existing file. More token-efficient than write_file — use this for targeted code edits.',
    category: 'filesystem',
    defaultEnabled: true,
  },
  {
    id: 'write_file',
    label: 'Write Files',
    description: 'Create or overwrite files. Also creates any missing parent directories.',
    category: 'filesystem',
    defaultEnabled: true,
  },
  {
    id: 'append_file',
    label: 'Append to Files',
    description: 'Append content to the end of a file without overwriting it.',
    category: 'filesystem',
    defaultEnabled: true,
  },
  {
    id: 'make_directory',
    label: 'Create Directories',
    description: 'Create a directory (including any missing parents).',
    category: 'filesystem',
    defaultEnabled: true,
  },
  {
    id: 'move_path',
    label: 'Move / Rename',
    description: 'Move or rename a file or directory.',
    category: 'filesystem',
    defaultEnabled: true,
  },
  {
    id: 'copy_path',
    label: 'Copy Files',
    description: 'Copy a file or directory to a new location.',
    category: 'filesystem',
    defaultEnabled: true,
  },

  // Filesystem – destructive
  {
    id: 'delete_path',
    label: 'Delete Files',
    description:
      'Permanently delete a file or directory. Each deletion requires user approval unless permanently granted.',
    category: 'filesystem',
    dangerous: true,
    defaultEnabled: true,
  },

  // RAG
  {
    id: 'search_rag',
    label: 'Search RAG',
    description:
      'Semantic (vector) or keyword retrieval over the RAG index. Use when the user references uploaded files, asks about stored RAG content, or requests document-grounded answers.',
    category: 'memory',
    defaultEnabled: true,
  },
  {
    id: 'add_to_rag',
    label: 'Add to RAG',
    description:
      'Add a document to the RAG index so the agent can retrieve it later with search_rag. Use for durable reference material, research notes, or any text worth storing for future semantic retrieval.',
    category: 'memory',
    defaultEnabled: true,
  },

  // Shell – most dangerous, opt-in only
  {
    id: 'run_shell',
    label: 'Run Shell Commands',
    description:
      'Execute arbitrary shell commands on the host system. Grants the agent full root-level access — enable only if you trust the model completely.',
    category: 'shell',
    dangerous: true,
    defaultEnabled: false,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SETTING_PREFIX = 'builtin_tool_enabled:';

/**
 * Check whether a built-in tool is currently enabled.
 * Falls back to the tool's `defaultEnabled` value when no setting is stored.
 */
export function isBuiltinToolEnabled(toolId: string): boolean {
  const stored = getSetting(`${SETTING_PREFIX}${toolId}`);
  if (stored === null || stored === undefined || stored === '') {
    const meta = BUILTIN_TOOLS.find((t) => t.id === toolId);
    return meta?.defaultEnabled ?? true;
  }
  return stored !== '0';
}

/** Persist the enabled/disabled state for a built-in tool. */
export function setBuiltinToolEnabled(toolId: string, enabled: boolean): void {
  setSetting(`${SETTING_PREFIX}${toolId}`, enabled ? '1' : '0');
}

/** Return every built-in tool with its current enabled state attached. */
export function listBuiltinToolsWithState(): Array<BuiltinToolMeta & { enabled: boolean }> {
  return BUILTIN_TOOLS.map((t) => ({ ...t, enabled: isBuiltinToolEnabled(t.id) }));
}
