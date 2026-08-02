/**
 * lib/agent/builtin-tools.ts
 * ---------------------------------------------------------------------------
 * Built-in tools every agent receives by default, the metadata helper used by
 * the Tool Playground, and the async sub-agent runner.
 *
 * Tools are defined inline (Vercel AI SDK `tool()` helper) so each tool's
 * description and Zod schema sit next to its implementation. Disabled tools
 * are filtered out via `lib/builtin-tools-registry`.
 */
import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import type OpenAI from 'openai';
import {
  createAgentTask,
  finishAgentTask,
  listAgentTasksByAgent,
  createAgentNotification,
} from '../db';
import {
  readMemory,
  writeMemory,
  getAgentConfig,
  safeAgentDirName,
  getAgentDir,
  getAgentFile,
  getAgentMemoryFile,
  getAgentRelativePath,
  getAgentMemoryRelativePath,
} from '../memory';
import { buildSkillContextSection, loadOneSkillBody } from '../skills-loader';
import { loadFunctionTools } from '../function-tools-loader';
import { loadMcpTools } from '../mcp-client';
import { isApproved, consumeOnce } from '../approval-store';
import type { ApprovalOperation } from '../approval-store';
import { isBuiltinToolEnabled, listBuiltinToolsWithState } from '../builtin-tools-registry';
import { copyFileToAgentFiles } from '../agent-files';
import type { AgentFileResult } from '../agent-files';
import { retrieveChunks, ingestDocument } from '../rag';
import { getEffectiveOutputLength } from './model-overrides';
import { startSubagentMonitor } from '../subagent-monitor';
import {
  resolveAgentPath,
  extractProjectName,
  PROJECTS_ROOT,
  PREVIEW_ROOT,
} from '../path-security';
import { createOpenAIClient } from './openai-client';
import { resolveModelWithFallback } from './model-resolver';
import { toolsToOpenAIFormat, zodToOpenAISchema } from './schema';
import { sanitizeToolResultContent } from './sanitize';
import { buildSystemPrompt } from './prompt';
import type { ToolSet } from './types';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ── Async sub-agent helpers ──────────────────────────────────────────────────

/** Append a timestamped log entry to a task markdown file. */
async function appendTaskLog(taskFile: string, entry: string): Promise<void> {
  const ts = new Date().toISOString();
  try {
    await fs.promises.appendFile(taskFile, `[${ts}] ${entry}\n`, 'utf8');
  } catch {
    /* file may be deleted */
  }
}

/**
 * runSubagentWithTaskFile – run a named agent non-interactively as a background
 * task. Injects the task file path into the system prompt and provides the
 * update_task_status tool so the agent can log its own progress.
 *
 * Always called from inside a `void (async () => {...})()` IIFE; never awaited
 * by the caller.
 */
async function runSubagentWithTaskFile(
  agentName: string,
  prompt: string,
  taskFile: string,
  notifySessionId?: string,
): Promise<string> {
  const config = getAgentConfig(agentName);
  const memory = readMemory(config.name);
  const openai = createOpenAIClient();
  const modelId = await resolveModelWithFallback(undefined, config.model, agentName);
  if (!modelId) {
    throw new Error(
      'No default model is configured. Open Settings → Default Model and pick one ' +
        `before delegating tasks to the "${agentName}" sub-agent.`,
    );
  }
  const functionTools = loadFunctionTools(config.tools);
  const mcpTools = await loadMcpTools(config.tools);
  const builtins = createBuiltinTools(agentName, undefined, taskFile, notifySessionId);
  const allTools = { ...functionTools, ...mcpTools, ...builtins } as ToolSet;
  const openaiTools = toolsToOpenAIFormat(allTools);

  const skillSection = buildSkillContextSection(config.tools);
  const systemPrompt =
    buildSystemPrompt(config.systemPrompt, memory) +
    skillSection +
    `\n\n## Async Task Context\n` +
    `You are running as an **async sub-agent**.\n` +
    `- Task file: \`${taskFile}\`\n` +
    `- Call \`update_task_status\` after each significant step.\n` +
    `- Finish with \`update_task_status({ message: "summary", finished: true })\`.\n` +
    `- On failure call \`update_task_status({ error: "reason" })\`.\n`;
  const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];
  for (let step = 0; step < 20; step++) {
    const response = await openai.chat.completions.create({
      model: modelId,
      messages: msgs,
      max_tokens: getEffectiveOutputLength(modelId),
      ...(openaiTools.length ? { tools: openaiTools, tool_choice: 'auto' } : {}),
    });
    const choice = response.choices[0];
    if (!choice) break;
    if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls?.length)
      return choice.message.content ?? '';
    msgs.push(choice.message);
    for (const tc of choice.message
      .tool_calls as OpenAI.Chat.ChatCompletionMessageFunctionToolCall[]) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }
      const toolDef = allTools[tc.function.name];
      const result = toolDef?.execute
        ? await toolDef.execute(args)
        : { error: `Tool not found: ${tc.function.name}` };
      msgs.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: sanitizeToolResultContent(result),
      });
    }
  }
  return '';
}

// ── Built-in tools ──────────────────────────────────────────────────────────

/**
 * createBuiltinTools – returns the tools every agent receives by default.
 *
 * @param agentName       Name of the running agent (task assigner + self-call guard)
 * @param sessionId       Chat session ID for approval gate; undefined in async sub-agents
 * @param currentTaskFile Task file path when running as an async sub-agent
 * @param notifySessionId Session to receive a notification when a child task finishes
 * @param skillFilter     Per-agent skill allow-list (from agent.md `tools`).
 *                        'all' or undefined = every enabled skill is loadable;
 *                        string[] = restrict `load_skill` to these skill names.
 *                        Mirrors the system-prompt Stage 1 discovery filter so
 *                        the model cannot side-load a disallowed skill.
 */
export function createBuiltinTools(
  agentName: string,
  sessionId?: string,
  currentTaskFile?: string,
  notifySessionId?: string,
  skillFilter: string[] | 'all' = 'all',
): ToolSet {
  const all: ToolSet = {
    append_memory: tool({
      description:
        "Append new information to this agent's private persistent memory file. Use this to remember important information across conversations.",
      parameters: z.object({
        content: z.string().describe("The content to append to this agent's private memory file"),
      }),
      execute: async ({ content }) => {
        const existing = readMemory(agentName);
        writeMemory(existing + '\n\n---\n\n' + (content as string), agentName);
        return { success: true, message: 'Memory appended successfully.' };
      },
    }),

    replace_memory: tool({
      description:
        "Replace this agent's entire private memory file with new content. WARNING: all existing memory for this agent is permanently lost. Only use when the user explicitly asks to reset or rewrite memory.",
      parameters: z.object({
        content: z
          .string()
          .describe(
            "The new content that will completely replace this agent's private memory file",
          ),
      }),
      execute: async ({ content }) => {
        writeMemory(content as string, agentName);
        return { success: true, message: 'Memory replaced successfully.' };
      },
    }),

    create_agent: tool({
      description:
        'Create a new agent folder with agent.md and memory.md. Use this when the user asks to create, add, define, or scaffold a new agent.',
      parameters: z.object({
        name: z
          .string()
          .min(1)
          .describe('Agent name. It will be converted to a safe folder name under data/agents/.'),
        system_prompt: z
          .string()
          .min(1)
          .describe('The role-specific system prompt for the new agent.'),
        tools: z
          .string()
          .optional()
          .describe(
            'Tool policy for **Tools:**. Use "all", "none", or a comma-separated tool list. Defaults to all.',
          ),
        model: z
          .string()
          .optional()
          .describe(
            'Optional model for **Model:**. Use "default" to inherit Settings → Default Model.',
          ),
        memory: z
          .string()
          .optional()
          .describe(
            'Optional initial memory.md content. If omitted, a concise default memory template is created.',
          ),
        overwrite: z
          .boolean()
          .optional()
          .describe(
            'Set true only when the user explicitly wants to replace an existing agent folder.',
          ),
      }),
      execute: async ({ name, system_prompt, tools, model, memory, overwrite }) => {
        const safeName = safeAgentDirName(name as string);
        const agentDir = getAgentDir(safeName);
        const agentFile = getAgentFile(safeName);
        const memoryFile = getAgentMemoryFile(safeName);
        const exists = fs.existsSync(agentFile) || fs.existsSync(memoryFile);
        if (exists && !overwrite) {
          return {
            error: `Agent "${safeName}" already exists. Set overwrite=true only if the user explicitly wants to replace it.`,
            agent_dir: agentDir,
          };
        }

        await fs.promises.mkdir(agentDir, { recursive: true });
        const toolsValue = String(tools || 'all').trim() || 'all';
        const modelValue = String(model || 'default').trim() || 'default';
        const agentContent = [
          `# ${safeName}`,
          '',
          `**System Prompt:** ${String(system_prompt).trim()}`,
          '',
          `**Tools:** ${toolsValue}`,
          `**Model:** ${modelValue}`,
          '',
        ].join('\n');
        const memoryContent =
          typeof memory === 'string' && memory.trim()
            ? memory.trim() + '\n'
            : [
                `# ${safeName} Memory`,
                '',
                `Private long-term memory for the ${safeName} agent.`,
                '',
                '## Preferences',
                '- *[AI Note: Store durable preferences and operating constraints here]*',
                '',
                '## Learned Facts',
                '- *[AI Note: Store reusable facts, workflows, and reflections here]*',
                '',
              ].join('\n');

        await fs.promises.writeFile(agentFile, agentContent, 'utf8');
        await fs.promises.writeFile(memoryFile, memoryContent, 'utf8');

        return {
          success: true,
          agent_name: safeName,
          agent_dir: agentDir,
          agent_file: getAgentRelativePath(safeName),
          memory_file: getAgentMemoryRelativePath(safeName),
          message: `Created agent "${safeName}" with agent.md and memory.md.`,
        };
      },
    }),

    run_subagent_async: tool({
      description: [
        'Launch a sub-agent as a background task (non-blocking). Returns immediately with task_id and task_file.',
        'The sub-agent appends timestamped log entries to the task file:',
        '  [timestamp] PROGRESS: what the agent is doing',
        '  [timestamp] FINISHED: summary   ← task complete',
        '  [timestamp] ERROR: reason       ← task failed',
        'Poll with read_file(task_file) to check status.',
        'If sub-agent monitoring is enabled in Settings, completion/progress updates are injected into the same chat session automatically.',
        'You will also receive a notification on your next turn when the task finishes.',
      ].join('\n'),
      parameters: z.object({
        agent_name: z.string().describe('Name of the agent to run (must exist in agent.md)'),
        task: z.string().describe('Full task description / prompt for the sub-agent'),
        project_folder: z
          .string()
          .describe('Project folder — task file stored at <project_folder>/tasks/<task_id>.md'),
      }),
      execute: async ({ agent_name, task, project_folder }) => {
        if ((agent_name as string) === agentName)
          return { error: 'An agent cannot call itself as a sub-agent.' };
        // Sandbox `project_folder` to be inside DATA_DIR. Without this the
        // model can pick any path on disk for the tasks/ directory (e.g.
        // `/tmp`, `/etc`), exfiltrating task content or littering arbitrary
        // locations. The path is allowed to point at a leaf that does not
        // exist yet — `resolveAgentPath` covers that case.
        const sandboxed = resolveAgentPath(project_folder as string);
        if (!sandboxed) {
          return {
            error: `project_folder must be inside ./data/ (got "${project_folder}").`,
          };
        }
        const taskId = randomUUID();
        const taskDir = path.join(sandboxed, 'tasks');
        const taskFile = path.join(taskDir, `${taskId}.md`);
        await fs.promises.mkdir(taskDir, { recursive: true });
        const now = new Date().toISOString();
        await fs.promises.writeFile(
          taskFile,
          [
            `# Task ${taskId}`,
            '',
            `**Assigner:** ${agentName}`,
            `**Assignee:** ${agent_name as string}`,
            `**Started:** ${now}`,
            '**Status:** running',
            '',
            '## Prompt',
            task as string,
            '',
            '## Log',
            `[${now}] STARTED`,
            '',
          ].join('\n'),
          'utf8',
        );
        createAgentTask(
          taskId,
          sandboxed,
          agentName,
          agent_name as string,
          task as string,
          taskFile,
        );
        if (notifySessionId) {
          startSubagentMonitor({
            sessionId: notifySessionId,
            taskId,
            taskFile,
            assignee: agent_name as string,
          });
        }
        // Launch in the background — intentionally not awaited
        void (async () => {
          try {
            await appendTaskLog(taskFile, 'STATUS:RUNNING');
            const result = await runSubagentWithTaskFile(
              agent_name as string,
              task as string,
              taskFile,
              notifySessionId,
            );
            const content = await fs.promises.readFile(taskFile, 'utf8');
            if (!content.includes('] FINISHED:')) {
              await appendTaskLog(
                taskFile,
                `FINISHED: ${result || '(completed with no text output)'}`,
              );
            }
            const finalContent = await fs.promises.readFile(taskFile, 'utf8');
            await fs.promises.writeFile(
              taskFile,
              finalContent.replace('**Status:** running', '**Status:** finished'),
              'utf8',
            );
            finishAgentTask(taskId, 'finished');
            if (notifySessionId) {
              const summary = result ? result.slice(0, 300) : '(no text output)';
              createAgentNotification(randomUUID(), notifySessionId, taskId, taskFile, summary);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await appendTaskLog(taskFile, `ERROR: ${msg}`);
            try {
              const errContent = await fs.promises.readFile(taskFile, 'utf8');
              await fs.promises.writeFile(
                taskFile,
                errContent.replace('**Status:** running', '**Status:** error'),
                'utf8',
              );
            } catch {
              /* ignore */
            }
            finishAgentTask(taskId, 'error');
            if (notifySessionId) {
              createAgentNotification(
                randomUUID(),
                notifySessionId,
                taskId,
                taskFile,
                `ERROR: ${msg.slice(0, 200)}`,
              );
            }
          }
        })();
        return {
          task_id: taskId,
          task_file: taskFile,
          status: 'started',
          message: `Sub-agent '${agent_name as string}' launched. Monitor: read_file("${taskFile}")`,
        };
      },
    }),

    update_task_status: tool({
      description: [
        'Append a progress update to your task file. Only available inside async sub-agents.',
        'Call after each significant step.',
        'Set finished=true when the entire task is done, or error="reason" if it failed.',
      ].join(' '),
      parameters: z.object({
        message: z.string().describe('What you just did, or the final result summary'),
        finished: z.boolean().optional().describe('Set true when the entire task is complete'),
        error: z.string().optional().describe('Failure reason when the task cannot be completed'),
      }),
      execute: async ({ message, finished, error: taskError }) => {
        if (!currentTaskFile)
          return { error: 'update_task_status is only available inside async sub-agents.' };
        if (taskError) {
          await appendTaskLog(currentTaskFile, `ERROR: ${taskError as string}`);
        } else if (finished) {
          await appendTaskLog(currentTaskFile, `FINISHED: ${message as string}`);
        } else {
          await appendTaskLog(currentTaskFile, `PROGRESS: ${message as string}`);
        }
        return { success: true };
      },
    }),

    list_tasks: tool({
      description: [
        'List async sub-agent tasks where this agent is the assigner or assignee.',
        'Use project_folder to scope to a specific project.',
      ].join(' '),
      parameters: z.object({
        project_folder: z
          .string()
          .optional()
          .describe('Filter tasks under this project folder (optional)'),
      }),
      execute: async ({ project_folder }) => {
        const tasks = listAgentTasksByAgent(agentName);
        const filtered = project_folder
          ? tasks.filter((t) => t.task_file.startsWith(path.resolve(project_folder as string)))
          : tasks;
        const result = await Promise.all(
          filtered.map(async (t) => {
            let lastLog = '';
            let fileStatus = t.status;
            try {
              const lines = (await fs.promises.readFile(t.task_file, 'utf8')).split('\n');
              const logLines = lines.filter((l) =>
                /^\[.+\] (STARTED|STATUS:|PROGRESS:|FINISHED:|ERROR:)/.test(l),
              );
              lastLog = logLines.at(-1) ?? '';
              if (lastLog.includes('] FINISHED:')) fileStatus = 'finished';
              else if (lastLog.includes('] ERROR:')) fileStatus = 'error';
            } catch {
              /* file may have been deleted */
            }
            return {
              task_id: t.id,
              task_file: t.task_file,
              assigner: t.assigner,
              assignee: t.assignee,
              status: fileStatus,
              last_log: lastLog,
              started: new Date(t.created_at * 1000).toISOString(),
              finished: t.finished_at ? new Date(t.finished_at * 1000).toISOString() : null,
            };
          }),
        );
        return { tasks: result, count: result.length };
      },
    }),

    read_file: tool({
      description:
        'Read the contents of a file. Returns the text content. Paths are sandboxed to the project data directory (`./data/`); requests for files outside that root are refused.',
      parameters: z.object({
        file_path: z
          .string()
          .describe(
            'Path to the file to read, relative to the project data directory or absolute (e.g. "data/system.md"). Must resolve to a file under ./data/.',
          ),
        encoding: z
          .enum(['utf8', 'base64', 'hex'])
          .default('utf8')
          .describe('File encoding (default: utf8)'),
      }),
      execute: async ({ file_path, encoding }) => {
        // Zod `.default('utf8')` only fires when the schema validates the input
        // (i.e. when the LLM calls the tool through the agent loop). The Tool
        // Playground and direct test calls bypass Zod and pass `encoding` as
        // undefined — `fs.readFile(path, undefined)` then returns a raw Buffer
        // instead of a string. Defaulting here makes the behaviour consistent
        // regardless of how the tool is invoked.
        const enc: BufferEncoding = (encoding as BufferEncoding) ?? 'utf8';
        const resolved = resolveAgentPath(file_path as string);
        if (!resolved) {
          return {
            error: `Path "${file_path}" is outside the project data directory and is not allowed.`,
          };
        }
        const basename = path.basename(resolved);
        if (basename.startsWith('.') && sessionId) {
          const op: ApprovalOperation = 'read_dotfile';
          if (!isApproved(sessionId, op, resolved)) {
            return {
              requires_approval: true,
              operation: op,
              path: resolved,
              description: `Read hidden/dot file: ${resolved}`,
            };
          }
          consumeOnce(sessionId, op, resolved);
        }
        const content = await fs.promises.readFile(resolved, enc);
        const stats = await fs.promises.stat(resolved);
        return {
          path: resolved,
          content,
          size: stats.size,
          modified: new Date(stats.mtimeMs).toISOString(),
        };
      },
    }),

    write_file: tool({
      description:
        'Write content to a file. Creates the file (and any missing parent directories) if it does not exist, or overwrites it. Paths are sandboxed to the project data directory (`./data/`); writes outside that root are refused.',
      parameters: z.object({
        file_path: z
          .string()
          .describe(
            'Path to write to, relative to the project data directory or absolute. Must resolve to a file under ./data/.',
          ),
        content: z.string().describe('Content to write'),
        encoding: z
          .enum(['utf8', 'base64'])
          .default('utf8')
          .describe('Encoding for the content string'),
      }),
      execute: async ({ file_path, content, encoding }) => {
        const enc: BufferEncoding = (encoding as BufferEncoding) ?? 'utf8';
        const resolved = resolveAgentPath(file_path as string);
        if (!resolved) {
          return {
            error: `Path "${file_path}" is outside the project data directory and is not allowed.`,
          };
        }
        await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
        await fs.promises.writeFile(resolved, content as string, enc);
        const stats = await fs.promises.stat(resolved);
        return { path: resolved, size: stats.size, written: true };
      },
    }),

    append_file: tool({
      description:
        'Append content to the end of a file. Creates the file if it does not exist. Paths are sandboxed to the project data directory.',
      parameters: z.object({
        file_path: z
          .string()
          .describe(
            'Path of the file, relative to the project data directory or absolute. Must resolve to a file under ./data/.',
          ),
        content: z.string().describe('Content to append'),
      }),
      execute: async ({ file_path, content }) => {
        const resolved = resolveAgentPath(file_path as string);
        if (!resolved) {
          return {
            error: `Path "${file_path}" is outside the project data directory and is not allowed.`,
          };
        }
        await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
        await fs.promises.appendFile(resolved, content as string, 'utf8');
        const stats = await fs.promises.stat(resolved);
        return { path: resolved, size: stats.size, appended: true };
      },
    }),

    list_directory: tool({
      description:
        'List the contents of a directory. Paths are sandboxed to the project data directory.',
      parameters: z.object({
        dir_path: z
          .string()
          .describe(
            'Directory to list, relative to the project data directory or absolute. Must resolve to a directory under ./data/.',
          ),
        recursive: z
          .boolean()
          .default(false)
          .describe('Whether to list recursively (default: false)'),
      }),
      execute: async ({ dir_path, recursive }) => {
        const resolved = resolveAgentPath(dir_path as string);
        if (!resolved) {
          return {
            error: `Path "${dir_path}" is outside the project data directory and is not allowed.`,
          };
        }
        async function listDir(
          p: string,
          depth = 0,
        ): Promise<
          Array<{ name: string; path: string; type: string; size?: number; modified?: string }>
        > {
          const entries = await fs.promises.readdir(p, { withFileTypes: true });
          const result: Array<{
            name: string;
            path: string;
            type: string;
            size?: number;
            modified?: string;
          }> = [];
          for (const e of entries) {
            const full = path.join(p, e.name);
            if (e.isDirectory()) {
              result.push({ name: e.name, path: full, type: 'directory' });
              if (recursive && depth < 5) result.push(...(await listDir(full, depth + 1)));
            } else {
              const st = await fs.promises.stat(full);
              result.push({
                name: e.name,
                path: full,
                type: 'file',
                size: st.size,
                modified: new Date(st.mtimeMs).toISOString(),
              });
            }
          }
          return result;
        }
        return { path: resolved, entries: await listDir(resolved) };
      },
    }),

    delete_path: tool({
      description:
        'Delete a file or directory (recursively). Use with caution — requires user approval. Paths are sandboxed to the project data directory.',
      parameters: z.object({
        target_path: z
          .string()
          .describe(
            'Path to delete, relative to the project data directory or absolute. Must resolve to a path under ./data/.',
          ),
        recursive: z
          .boolean()
          .default(false)
          .describe('Required true to delete non-empty directories'),
      }),
      execute: async ({ target_path, recursive }) => {
        const resolved = resolveAgentPath(target_path as string);
        if (!resolved) {
          return {
            error: `Path "${target_path}" is outside the project data directory and is not allowed.`,
          };
        }
        const stat = await fs.promises.stat(resolved);
        if (!sessionId) {
          return {
            error:
              'delete_path requires an interactive chat session for approval and cannot run from Tool Playground or async sub-agents.',
          };
        }
        const op: ApprovalOperation = 'delete';
        if (!isApproved(sessionId, op, resolved)) {
          return {
            requires_approval: true,
            operation: op,
            path: resolved,
            description: `Delete ${stat.isDirectory() ? 'directory' : 'file'}: ${resolved}`,
          };
        }
        consumeOnce(sessionId, op, resolved);
        if (stat.isDirectory()) {
          if (!recursive) return { error: 'Set recursive=true to delete a directory.' };
          await fs.promises.rm(resolved, { recursive: true, force: true });
        } else {
          await fs.promises.unlink(resolved);
        }
        return { path: resolved, deleted: true };
      },
    }),

    move_path: tool({
      description:
        'Move or rename a file or directory. Both source and destination must resolve to paths under the project data directory.',
      parameters: z.object({
        source_path: z
          .string()
          .describe(
            'Current path, relative to the project data directory or absolute. Must resolve to a path under ./data/.',
          ),
        destination_path: z
          .string()
          .describe(
            'New path, relative to the project data directory or absolute. Must resolve to a path under ./data/.',
          ),
      }),
      execute: async ({ source_path, destination_path }) => {
        const src = resolveAgentPath(source_path as string);
        if (!src)
          return {
            error: `Source path "${source_path}" is outside the project data directory and is not allowed.`,
          };
        const dst = resolveAgentPath(destination_path as string);
        if (!dst)
          return {
            error: `Destination path "${destination_path}" is outside the project data directory and is not allowed.`,
          };
        await fs.promises.mkdir(path.dirname(dst), { recursive: true });
        await fs.promises.rename(src, dst);
        return { from: src, to: dst, moved: true };
      },
    }),

    copy_path: tool({
      description:
        'Copy a file or directory to a new location. Both source and destination must resolve to paths under the project data directory.',
      parameters: z.object({
        source_path: z
          .string()
          .describe(
            'Source path, relative to the project data directory or absolute. Must resolve to a path under ./data/.',
          ),
        destination_path: z
          .string()
          .describe(
            'Destination path, relative to the project data directory or absolute. Must resolve to a path under ./data/.',
          ),
      }),
      execute: async ({ source_path, destination_path }) => {
        const src = resolveAgentPath(source_path as string);
        if (!src)
          return {
            error: `Source path "${source_path}" is outside the project data directory and is not allowed.`,
          };
        const dst = resolveAgentPath(destination_path as string);
        if (!dst)
          return {
            error: `Destination path "${destination_path}" is outside the project data directory and is not allowed.`,
          };
        const stat = await fs.promises.stat(src);
        await fs.promises.mkdir(path.dirname(dst), { recursive: true });
        if (stat.isDirectory()) {
          await fs.promises.cp(src, dst, { recursive: true });
        } else {
          await fs.promises.copyFile(src, dst);
        }
        return { from: src, to: dst, copied: true };
      },
    }),

    make_directory: tool({
      description:
        'Create a directory (and any missing parent directories). Paths are sandboxed to the project data directory.',
      parameters: z.object({
        dir_path: z
          .string()
          .describe(
            'Directory to create, relative to the project data directory or absolute. Must resolve to a path under ./data/.',
          ),
      }),
      execute: async ({ dir_path }) => {
        const resolved = resolveAgentPath(dir_path as string);
        if (!resolved) {
          return {
            error: `Path "${dir_path}" is outside the project data directory and is not allowed.`,
          };
        }
        await fs.promises.mkdir(resolved, { recursive: true });
        return { path: resolved, created: true };
      },
    }),

    stat_path: tool({
      description:
        'Get metadata about a file or directory (size, type, permissions, timestamps). Paths are sandboxed to the project data directory.',
      parameters: z.object({
        target_path: z
          .string()
          .describe(
            'Path to inspect, relative to the project data directory or absolute. Must resolve to a path under ./data/.',
          ),
      }),
      execute: async ({ target_path }) => {
        const resolved = resolveAgentPath(target_path as string);
        if (!resolved) {
          return {
            error: `Path "${target_path}" is outside the project data directory and is not allowed.`,
          };
        }
        const st = await fs.promises.stat(resolved);
        return {
          path: resolved,
          type: st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : 'file',
          size: st.size,
          mode: '0' + (st.mode & 0o777).toString(8),
          created: new Date(st.birthtimeMs).toISOString(),
          modified: new Date(st.mtimeMs).toISOString(),
          accessed: new Date(st.atimeMs).toISOString(),
        };
      },
    }),

    search_files: tool({
      description:
        'Search for files by name pattern or content using grep/find. The search root is sandboxed to the project data directory.',
      parameters: z.object({
        dir_path: z
          .string()
          .describe(
            'Directory to search in, relative to the project data directory or absolute. Must resolve to a directory under ./data/.',
          ),
        pattern: z.string().describe('Filename glob (e.g. "*.ts") or text to grep for'),
        search_type: z
          .enum(['name', 'content'])
          .default('name')
          .describe('"name" searches by filename, "content" searches file contents'),
        case_sensitive: z.boolean().default(true).describe('Whether the search is case-sensitive'),
      }),
      execute: async ({ dir_path, pattern, search_type, case_sensitive }) => {
        const resolved = resolveAgentPath(dir_path as string);
        if (!resolved) {
          return {
            error: `Path "${dir_path}" is outside the project data directory and is not allowed.`,
          };
        }
        const searchPattern = pattern as string;
        let output = '';
        try {
          if (search_type === 'name') {
            const { stdout } = await execFileAsync('find', [resolved, '-name', searchPattern], {
              encoding: 'utf8',
              timeout: 10000,
              maxBuffer: 1024 * 1024,
            });
            output = stdout;
          } else {
            const args = case_sensitive
              ? ['-rl', searchPattern, resolved]
              : ['-rli', searchPattern, resolved];
            const { stdout } = await execFileAsync('grep', args, {
              encoding: 'utf8',
              timeout: 10000,
              maxBuffer: 1024 * 1024,
            });
            output = stdout;
          }
        } catch (err) {
          const e = err as { stdout?: string; code?: number };
          if (e.code !== 1 || typeof e.stdout !== 'string') throw err;
          output = e.stdout;
        }
        const matches = output.trim().split('\n').filter(Boolean).slice(0, 200);
        return { pattern, search_type, matches, count: matches.length };
      },
    }),

    send_file: tool({
      description: [
        'Send a file to the user in the chat UI.',
        'The file will be shown with an inline preview (image/video/audio player) and a download button.',
        'Use this whenever you produce output that should be delivered as a file:',
        '  • Generated images (PNG, JPEG, SVG, WebP…)',
        '  • Audio clips (MP3, WAV, OGG…)',
        '  • Video (MP4, WebM…)',
        '  • Documents, reports, CSVs, PDFs…',
        '  • Any file written to disk via write_file or run_shell',
        'You MUST first save the file to disk with write_file, then call send_file with file_path.',
        'Inline base64 data is NOT supported — always use file_path.',
        'The source path must resolve to a file under the project data directory (./data/).',
      ].join(' '),
      parameters: z.object({
        filename: z
          .string()
          .describe('Filename with extension, e.g. "chart.png", "report.csv", "song.mp3"'),
        description: z
          .string()
          .optional()
          .describe('Caption shown to the user below the file preview'),
        file_path: z
          .string()
          .describe(
            'Path to an existing file under ./data/. Save it to disk first with write_file, then call send_file with file_path.',
          ),
        mime_type: z
          .string()
          .optional()
          .describe(
            'MIME type override, e.g. "image/png". Auto-detected from extension if omitted.',
          ),
      }),
      execute: async ({
        filename,
        description,
        file_path,
        mime_type,
      }): Promise<AgentFileResult | { error: string }> => {
        try {
          if (!file_path || (file_path as string).trim() === '') {
            return {
              error:
                'file_path is required. Save the file to disk first (write_file), then call send_file with file_path.',
            };
          }
          const resolved = resolveAgentPath(file_path as string);
          if (!resolved) {
            return {
              error: `Path "${file_path}" is outside the project data directory and is not allowed.`,
            };
          }
          return copyFileToAgentFiles(
            resolved,
            filename as string,
            description as string | undefined,
            mime_type as string | undefined,
          );
        } catch (err) {
          return {
            error: `Failed to store file: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    }),

    open_preview: tool({
      description: [
        'Open a file in the Preview Panel on the right side of the screen.',
        'Call this after creating or updating any file that benefits from visual inspection:',
        '  • HTML / web apps / games  → rendered live in a sandboxed iframe',
        '  • Markdown (.md)           → split editor + rendered preview (user can edit)',
        '  • Images (PNG/JPG/SVG/GIF) → displayed inline',
        '  • PDFs                     → rendered with the browser PDF viewer',
        'For multi-file web apps pass the main entry file (e.g. index.html).',
        'Do NOT call this for config files, JSON data, scripts, or other non-visual outputs.',
        'The file must live under data/projects/<project-name>/. The entire project folder is',
        'copied to a sandboxed preview area before opening, so all relative assets resolve',
        'correctly. You do not need to copy files manually — just build under',
        'data/projects/<project-name>/ and call open_preview on the entry file.',
      ].join('\n'),
      parameters: z.object({
        file_path: z
          .string()
          .describe('Path to an existing file under data/projects/<project-name>/ to preview'),
        title: z
          .string()
          .optional()
          .describe('Optional short title to show in the preview panel header'),
      }),
      execute: async ({ file_path, title }) => {
        const resolved = resolveAgentPath(file_path as string);
        if (!resolved) {
          return {
            error: `Path "${file_path}" is outside the project data directory and is not allowed.`,
          };
        }
        const exists = await fs.promises
          .access(resolved)
          .then(() => true)
          .catch(() => false);
        if (!exists) {
          return { error: `File not found: ${file_path}` };
        }

        // Derive the project name from the path (must be under
        // data/projects/<name>/...).
        const projectName = extractProjectName(resolved);
        if (!projectName) {
          return {
            error:
              'Preview files must live under data/projects/<project-name>/. ' +
              'Create a project folder there first, then call open_preview on the entry file.',
          };
        }

        // Copy the entire project directory to data/preview/<name>/ so the
        // sandboxed preview iframe (no cookies) can load every relative asset
        // without exposing source files or the database to unauthenticated
        // access.
        const projectSrcDir = path.join(PROJECTS_ROOT, projectName);
        const previewDestDir = path.join(PREVIEW_ROOT, projectName);
        try {
          await fs.promises.rm(previewDestDir, { recursive: true, force: true });
          await fs.promises.cp(projectSrcDir, previewDestDir, { recursive: true });
        } catch {
          return { error: `Failed to stage preview for project "${projectName}".` };
        }

        const relFromProjectRoot = path.relative(projectSrcDir, resolved);
        const previewPath = path.join(previewDestDir, relFromProjectRoot);

        return {
          type: 'open_preview' as const,
          path: previewPath,
          sourcePath: resolved,
          title: (title as string | undefined) ?? path.basename(resolved),
          exists: true,
        };
      },
    }),

    edit_file: tool({
      description: [
        'Edit a file by replacing an exact string with a new string.',
        'Use this instead of write_file when modifying existing files — it is faster, uses fewer tokens, and avoids accidentally overwriting unrelated code.',
        'Paths are sandboxed to the project data directory (`./data/`); edits outside that root are refused.',
        'old_string must match the file content EXACTLY (including whitespace and indentation).',
        'Include 3–5 lines of surrounding context in old_string so the target location is unambiguous.',
        'Returns an error if old_string is not found or matches more than one location.',
      ].join('\n'),
      parameters: z.object({
        file_path: z
          .string()
          .describe(
            'Path to the file to edit, relative to the project data directory or absolute. Must resolve to a file under ./data/.',
          ),
        old_string: z
          .string()
          .describe(
            'The exact text to find and replace. Must match exactly including whitespace. Include 3–5 lines of context to uniquely identify the location.',
          ),
        new_string: z
          .string()
          .describe('The replacement text to substitute in place of old_string'),
      }),
      execute: async ({ file_path, old_string, new_string }) => {
        const resolved = resolveAgentPath(file_path as string);
        if (!resolved) {
          return {
            error: `Path "${file_path}" is outside the project data directory and is not allowed.`,
          };
        }
        if (
          !(await fs.promises
            .access(resolved)
            .then(() => true)
            .catch(() => false))
        )
          return { error: `File not found: ${resolved}` };
        const content = await fs.promises.readFile(resolved, 'utf8');
        const occurrences = content.split(old_string as string).length - 1;
        if (occurrences === 0) {
          return {
            error:
              'old_string not found in file. Check that it matches exactly (including whitespace and indentation). Read the file first if you are unsure.',
          };
        }
        if (occurrences > 1) {
          return {
            error: `old_string matches ${occurrences} locations in the file. Add more surrounding context lines to make it unique.`,
          };
        }
        const updated = content.replace(old_string as string, new_string as string);
        await fs.promises.writeFile(resolved, updated, 'utf8');
        const stats = await fs.promises.stat(resolved);
        return { path: resolved, size: stats.size, edited: true };
      },
    }),

    run_shell: tool({
      description:
        'Execute an arbitrary shell command on the host system. Returns stdout, stderr and exit code. Requires user approval unless previously granted.',
      parameters: z.object({
        command: z.string().describe('The shell command to execute'),
        cwd: z.string().optional().describe('Working directory (default: project root)'),
        timeout_ms: z.number().default(30000).describe('Timeout in milliseconds (default: 30 000)'),
      }),
      execute: async ({ command, cwd, timeout_ms }) => {
        const op: ApprovalOperation = 'run_shell';
        const commandText = command as string;
        if (!sessionId) {
          if (!currentTaskFile) {
            return {
              error:
                'run_shell requires an interactive chat session for approval and cannot run from Tool Playground.',
            };
          }
          // Async sub-agents do not have a browser chat session, so they can
          // never pause and render an approval UI. They should still be able
          // to use shell when the operator has granted the operation forever
          // via the normal approval table; `isApproved()` checks permanent
          // approvals before looking at the session map, so a synthetic
          // session id is enough to ask only that global question.
          if (!isApproved('__async_subagent__', op, commandText)) {
            return {
              error:
                'run_shell requires a permanent approval before async sub-agents can execute shell commands. Approve run_shell forever from an interactive chat first.',
            };
          }
        } else if (!isApproved(sessionId, op, commandText)) {
          return {
            requires_approval: true,
            operation: op,
            path: command,
            description: `Run shell command: ${command}`,
          };
        } else {
          consumeOnce(sessionId, op, commandText);
        }
        try {
          const { stdout, stderr } = await execAsync(commandText, {
            cwd: cwd ? path.resolve(cwd as string) : process.cwd(),
            timeout: (timeout_ms as number) ?? 30000,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024 * 10,
          });
          return { stdout: stdout as string, stderr: stderr as string, exit_code: 0 };
        } catch (err) {
          // exec rejects when the command exits non-zero; extract details
          const e = err as Error & { stdout?: string; stderr?: string; code?: number };
          return {
            stdout: e.stdout ?? '',
            stderr: e.stderr ?? e.message ?? String(err),
            exit_code: typeof e.code === 'number' ? e.code : 1,
          };
        }
      },
    }),

    // ── Skills — Stage 2 activation ───────────────────────────────────
    load_skill: tool({
      description:
        'Load the full SKILL.md body of one of the available skills listed in the ' +
        '"Available Skills" section of the system prompt. Call this when the user ' +
        "task matches a skill's scope. The returned `body` is authoritative " +
        'instructions — follow them for the rest of the task. Returns an error ' +
        'object if the skill name is unknown or not permitted for this agent.',
      parameters: z.object({
        name: z
          .string()
          .describe('Exact skill name as shown in "Available Skills" (e.g. "report-generator")'),
      }),
      execute: async ({ name }) => {
        const skill = loadOneSkillBody(name as string, skillFilter);
        if (!skill) {
          return {
            success: false,
            error: `Skill "${name}" is not available. Use only the names listed under "Available Skills" in the system prompt.`,
          };
        }
        return {
          success: true,
          name: skill.name,
          description: skill.description,
          body: skill.body,
          path: skill.path,
        };
      },
    }),

    // ── RAG ────────────────────────────────────────────────────────────────
    search_rag: tool({
      description:
        'Search the RAG index for relevant context. ' +
        'Use this when the user references uploaded files, asks about stored information, ' +
        'or needs document-grounded answers. Performs semantic vector retrieval with ' +
        'automatic fallback to keyword (FTS5) search.',
      parameters: z.object({
        query: z.string().describe('Natural language search query'),
        top_k: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Number of text chunks to return (default 5)'),
      }),
      execute: async ({ query, top_k }) => {
        const chunks = await retrieveChunks(query as string, (top_k as number | undefined) ?? 5);
        if (chunks.length === 0) {
          return 'No relevant RAG content found. The RAG index may be empty - ask the user to add documents via the RAG page, or use the add_to_rag tool to store useful information yourself.';
        }
        return chunks.map((c, i) => `[Result ${i + 1}]\n${c}`).join('\n\n---\n\n');
      },
    }),

    add_to_rag: tool({
      description:
        'Add a document to the RAG index so it can be retrieved later with search_rag. ' +
        'Use this when the conversation reveals durable information worth storing for future ' +
        'semantic retrieval - e.g. reference material, research notes, decisions, or any text ' +
        'that future conversations may need to look up. The content is automatically chunked, ' +
        'embedded, and indexed. This is complementary to append_memory (which stores short notes ' +
        'in the system prompt); use add_to_rag for longer or more structured content that should ' +
        'be retrieved on demand rather than always loaded.',
      parameters: z.object({
        name: z
          .string()
          .min(1)
          .describe(
            'A short, descriptive title for this RAG entry (e.g. "Meeting notes 2025-01-15").',
          ),
        content: z
          .string()
          .min(1)
          .describe('The full text to index. Markdown is fine.'),
      }),
      execute: async ({ name, content }) => {
        const result = await ingestDocument({
          name: name as string,
          sourceType: 'agent',
          content: content as string,
          originalContent: content as string,
          originalMime: 'text/plain',
        });
        if (result.skipped) {
          return {
            success: true,
            skipped: true,
            message: `Identical content for "${name}" was already in the RAG index (${result.chunks} chunks).`,
            sourceId: result.sourceId,
            chunks: result.chunks,
          };
        }
        return {
          success: true,
          message: `Added "${name}" to the RAG index (${result.chunks} chunks, embedded: ${result.embedded}).`,
          sourceId: result.sourceId,
          chunks: result.chunks,
        };
      },
    }),
  };

  // Filter out any tools that the user has disabled in the Skills & MCP settings.
  const filtered: ToolSet = {};
  for (const [name, def] of Object.entries(all)) {
    if (isBuiltinToolEnabled(name)) filtered[name] = def;
  }
  return filtered;
}

/**
 * Return parameter JSON Schemas for every built-in tool, keyed by tool name.
 * Used by the Tool Playground to generate input forms.
 * Execute functions are omitted — this is metadata only.
 */
export function getBuiltinToolParameterSchemas(): Record<
  string,
  { description?: string; parameters: Record<string, unknown>; category: string; label: string }
> {
  const meta = listBuiltinToolsWithState();
  const all = createBuiltinTools('_playground', undefined);
  const result: Record<
    string,
    { description?: string; parameters: Record<string, unknown>; category: string; label: string }
  > = {};
  for (const m of meta) {
    const def = all[m.id];
    if (def) {
      result[m.id] = {
        description: def.description,
        parameters: zodToOpenAISchema(def.parameters),
        category: m.category,
        label: m.label,
      };
    }
  }
  return result;
}
