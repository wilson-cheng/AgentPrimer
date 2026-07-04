import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { getAgentTask, getMessages, getSetting, saveMessage, touchSession } from './db';
import type { AgentStepTrace, TokenUsage } from './agent';

const activeMonitors = new Map<string, NodeJS.Timeout>();
const activeFollowups = new Set<string>();

type TaskStatus = 'running' | 'finished' | 'error' | 'interrupted' | 'unknown';

function settingBool(key: string, fallback: boolean): boolean {
  const value = getSetting(key);
  if (!value) return fallback;
  return value !== 'false';
}

function settingInt(key: string, fallback: number, min: number, max: number): number {
  const raw = parseInt(getSetting(key), 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

async function readTaskFile(taskFile: string): Promise<string> {
  return fs.promises.readFile(taskFile, 'utf8').catch(() => '');
}

function latestInterestingLine(content: string): string {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const interesting = lines.filter((line) => /\] (PROGRESS|FINISHED|ERROR|STATUS):/.test(line));
  return interesting.at(-1) ?? lines.at(-1) ?? '';
}

function finalSummary(content: string, fallback: string): string {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const final = [...lines].reverse().find((line) => /\] (FINISHED|ERROR):/.test(line));
  if (!final) return fallback;
  return final.replace(/^\[[^\]]+\]\s*/, '');
}

function injectMessage(sessionId: string, content: string): void {
  saveMessage({
    id: randomUUID(),
    session_id: sessionId,
    role: 'assistant',
    content,
    attachments_json: '[]',
    tool_calls_json: '[]',
    token_usage_json: '{}',
    reasoning_json: '',
    parts_json: '[]',
    trace_json: '[]',
  });
  touchSession(sessionId);
}

function statusLabel(status: TaskStatus): string {
  if (status === 'error') return 'failed';
  return status;
}

async function runParentFollowup(args: {
  sessionId: string;
  taskId: string;
  assignee: string;
  summary: string;
  taskFile: string;
}): Promise<void> {
  if (!settingBool('subagent_auto_followup_enabled', true)) return;
  if (activeFollowups.has(args.taskId)) return;
  activeFollowups.add(args.taskId);
  try {
    const task = getAgentTask(args.taskId);
    const stored = getMessages(args.sessionId).map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
    }));
    const prompt = [
      `The async sub-agent "${args.assignee}" has finished task ${args.taskId}.`,
      '',
      'Result:',
      args.summary,
      '',
      `Task log: ${args.taskFile}`,
      '',
      'Follow up with the user now. Summarize what changed, point to important artifacts, and suggest the next useful action. Do not launch another sub-agent unless the user asks.',
    ].join('\n');
    const { createStreamingAgent } = await import('./agent');
    const response = await createStreamingAgent({
      agentName: task?.assigner,
      messages: [...stored, { role: 'user', content: prompt }],
      sessionId: args.sessionId,
      // Server-internal follow-up: consumed via `response.text()`, no browser
      // to disconnect and no Stop button. Coupling the loop to the response
      // (instead of the detached RunManager) avoids a singleton collision with
      // any user-initiated run on the same session.
      detached: false,
      onFinish: async (
        text: string,
        toolCalls: unknown[],
        tokenUsage?: TokenUsage,
        reasoning?: string,
        parts?: unknown[],
        trace?: AgentStepTrace[],
      ) => {
        saveMessage({
          id: randomUUID(),
          session_id: args.sessionId,
          role: 'assistant',
          content: text,
          attachments_json: '[]',
          tool_calls_json: JSON.stringify(toolCalls),
          token_usage_json: tokenUsage ? JSON.stringify(tokenUsage) : '{}',
          reasoning_json: reasoning ?? '',
          parts_json: JSON.stringify(parts ?? []),
          trace_json: trace ? JSON.stringify(trace) : '[]',
        });
        touchSession(args.sessionId);
      },
    });
    await response.text();
  } catch (err) {
    injectMessage(
      args.sessionId,
      `[Sub-agent follow-up failed · ${args.assignee}]\n\n${err instanceof Error ? err.message : String(err)}\n\nTask: ${args.taskId}`,
    );
  } finally {
    activeFollowups.delete(args.taskId);
  }
}

export function startSubagentMonitor(args: {
  sessionId: string;
  taskId: string;
  taskFile: string;
  assignee: string;
}): void {
  if (!settingBool('subagent_polling_enabled', true)) return;
  if (activeMonitors.has(args.taskId)) return;

  const intervalSeconds = settingInt('subagent_poll_interval_seconds', 60, 1, 3600);
  const maxAttempts = settingInt('subagent_poll_max_attempts', 10, 1, 1000);
  const progressBubbles = settingBool('subagent_progress_bubbles_enabled', false);
  let attempts = 0;
  let lastLine = '';
  let completed = false;

  const stop = () => {
    const timer = activeMonitors.get(args.taskId);
    if (timer) clearInterval(timer);
    activeMonitors.delete(args.taskId);
  };

  const poll = async () => {
    if (completed) return;
    attempts += 1;
    const task = getAgentTask(args.taskId);
    const status = (task?.status ?? 'unknown') as TaskStatus;
    const content = await readTaskFile(args.taskFile);
    const line = latestInterestingLine(content);

    if (progressBubbles && line && line !== lastLine && status === 'running') {
      lastLine = line;
      injectMessage(
        args.sessionId,
        `[Sub-agent update · ${args.assignee} · running]\n\n${line.replace(/^\[[^\]]+\]\s*/, '')}\n\nTask: ${args.taskId}`,
      );
    }

    if (status === 'finished' || status === 'error' || status === 'interrupted') {
      completed = true;
      const summary = finalSummary(content, statusLabel(status));
      injectMessage(
        args.sessionId,
        `[Sub-agent ${statusLabel(status)} · ${args.assignee}]\n\n${summary}\n\nTask: ${args.taskId}\nLog: ${args.taskFile}`,
      );
      if (status === 'finished') {
        void runParentFollowup({
          sessionId: args.sessionId,
          taskId: args.taskId,
          assignee: args.assignee,
          summary,
          taskFile: args.taskFile,
        });
      }
      stop();
      return;
    }

    if (attempts >= maxAttempts) {
      completed = true;
      injectMessage(
        args.sessionId,
        `[Sub-agent monitor timed out · ${args.assignee}]\n\nStopped polling after ${attempts} attempt${attempts === 1 ? '' : 's'}. The sub-agent may still be running.\n\nTask: ${args.taskId}\nLog: ${args.taskFile}`,
      );
      stop();
    }
  };

  const timer = setInterval(() => {
    void poll();
  }, intervalSeconds * 1000);
  activeMonitors.set(args.taskId, timer);
}
