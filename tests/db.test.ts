import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tempDir: string;

async function loadDb() {
  vi.resetModules();
  return import('../lib/db');
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentprimer-db-'));
  vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('database layer', () => {
  it('initializes schema, WAL mode, and default settings', async () => {
    const { getDb, getSetting } = await loadDb();
    const db = getDb();

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    // No vendor-specific `endpoint` is seeded — the operator must point at
    // their own provider in Settings → Base URL on first run. The chat route
    // emits a friendly "configure your API" stream until it is set.
    expect(getSetting('endpoint')).toBe('');
    // No `default_model` is seeded — the operator picks one in Settings on
    // first run. The agent loop emits a friendly "configure a model" stream
    // until then. `getSetting` returns the empty string for missing keys.
    expect(getSetting('default_model')).toBe('');
  });

  it('persists settings with upsert semantics', async () => {
    const { getSetting, setSetting } = await loadDb();

    setSetting('endpoint', 'https://example.test/v1');
    setSetting('endpoint', 'https://example.test/v2');

    expect(getSetting('endpoint')).toBe('https://example.test/v2');
  });

  it('creates sessions and cascades message deletion', async () => {
    const { createSession, deleteSession, getMessages, getSession, saveMessage } = await loadDb();

    createSession('session-1', 'Title', 'coder');
    saveMessage({
      id: 'message-1',
      session_id: 'session-1',
      role: 'user',
      content: 'Hello',
      attachments_json: '[]',
      tool_calls_json: '[]',
      token_usage_json: '{}',
      reasoning_json: '',
      parts_json: '[]',
      trace_json: '[]',
    });

    expect(getSession('session-1')?.agent_name).toBe('coder');
    expect(getMessages('session-1')).toHaveLength(1);

    deleteSession('session-1');

    expect(getSession('session-1')).toBeUndefined();
    expect(getMessages('session-1')).toHaveLength(0);
  });

  it('writes assistant token usage to append-only statistics log', async () => {
    const { createSession, getTotalTokenStats, saveMessage } = await loadDb();

    createSession('session-1', 'Title');
    saveMessage({
      id: 'assistant-1',
      session_id: 'session-1',
      role: 'assistant',
      content: 'Hi',
      attachments_json: '[]',
      tool_calls_json: '[]',
      token_usage_json: JSON.stringify({ input: 10, cached: 3, output: 5 }),
      reasoning_json: '',
      parts_json: '[]',
      trace_json: '[]',
    });

    expect(getTotalTokenStats(1)).toEqual({ input: 10, cached: 3, output: 5 });
  });

  it('preserves user-enabled state when bundled tools are reseeded', async () => {
    fs.mkdirSync(path.join(tempDir, 'defaults', 'skills', 'demo-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'defaults', 'skills', 'demo-skill', 'SKILL.md'),
      'name: demo-skill\ndescription: Demo skill\n',
      'utf-8',
    );
    fs.mkdirSync(path.join(tempDir, 'defaults', 'function-tools', 'demo-tool'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tempDir, 'defaults', 'function-tools', 'demo-tool', 'function.json'),
      JSON.stringify({
        name: 'demo_tool',
        description: 'Demo tool',
        parameters: { type: 'object', properties: {} },
      }),
      'utf-8',
    );
    fs.mkdirSync(path.join(tempDir, 'defaults', 'mcp-servers', 'exa'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'defaults', 'mcp-servers', 'exa', 'mcp.json'),
      JSON.stringify({
        name: 'exa',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'exa-mcp-server'],
        enabled: false,
      }),
      'utf-8',
    );

    vi.resetModules();
    const { bootstrap } = await import('../lib/bootstrap');
    const {
      listSkills,
      listFunctionTools,
      listMcpServers,
      setSkillEnabled,
      setFunctionToolEnabled,
      setMcpServerEnabled,
    } = await import('../lib/db');

    bootstrap();
    const skill = listSkills().find((s) => s.name === 'demo-skill');
    const functionTool = listFunctionTools().find((t) => t.name === 'demo_tool');
    const exa = listMcpServers().find((s) => s.name === 'exa');
    expect(skill?.enabled).toBe(1);
    expect(functionTool?.enabled).toBe(1);
    expect(exa?.enabled).toBe(0);

    setSkillEnabled(skill!.id, false);
    setFunctionToolEnabled(functionTool!.id, false);
    setMcpServerEnabled(exa!.id, true);
    bootstrap();

    expect(listSkills().find((s) => s.name === 'demo-skill')?.enabled).toBe(0);
    expect(listFunctionTools().find((t) => t.name === 'demo_tool')?.enabled).toBe(0);
    expect(listMcpServers().find((s) => s.name === 'exa')?.enabled).toBe(1);
  });

  it('upserts skills and MCP servers by unique name', async () => {
    const { listSkills, listMcpServers, upsertSkill, upsertMcpServer } = await loadDb();

    upsertSkill({
      id: 'skill-1',
      name: 'demo',
      github_url: 'builtin://demo',
      local_path: '/tmp/demo',
      enabled: 1,
      manifest_json: '{}',
    });
    upsertSkill({
      id: 'skill-2',
      name: 'demo',
      github_url: 'builtin://demo-2',
      local_path: '/tmp/demo2',
      enabled: 0,
      manifest_json: '{"updated":true}',
    });

    upsertMcpServer({
      id: 'mcp-1',
      name: 'datetime',
      github_url: 'builtin://datetime',
      local_path: '/tmp/mcp',
      transport: 'stdio',
      command: 'node',
      args_json: '[]',
      url: '',
      enabled: 1,
    });

    expect(listSkills()).toHaveLength(1);
    expect(listSkills()[0]).toMatchObject({ id: 'skill-1', name: 'demo', enabled: 0 });
    expect(listMcpServers()).toHaveLength(1);
    expect(listMcpServers()[0].name).toBe('datetime');
  });

  it('list reads exclude trace_json and report a cheap has_trace flag', async () => {
    const { createSession, saveMessage, getMessagesPage, getMessageTrace } = await loadDb();
    createSession('session-1', 'Title');
    // A user message (no trace) and an assistant message with a multi-step trace.
    saveMessage({
      id: 'msg-user',
      session_id: 'session-1',
      role: 'user',
      content: 'hi',
      attachments_json: '[]',
      tool_calls_json: '[]',
      token_usage_json: '{}',
      reasoning_json: '',
      parts_json: '[]',
      trace_json: '[]',
    });
    const bigTrace = JSON.stringify([{ step_index: 0, duration_ms: 5, finish_reason: 'stop' }]);
    saveMessage({
      id: 'msg-assistant',
      session_id: 'session-1',
      role: 'assistant',
      content: 'done',
      attachments_json: '[]',
      tool_calls_json: '[]',
      token_usage_json: '{}',
      reasoning_json: '',
      parts_json: '[]',
      trace_json: bigTrace,
    });

    const page = getMessagesPage('session-1', 50);
    // trace_json must NOT be shipped on the list path (it can be multi-MB).
    expect(page.messages.every((m) => !('trace_json' in m))).toBe(true);
    const user = page.messages.find((m) => m.id === 'msg-user')!;
    const assistant = page.messages.find((m) => m.id === 'msg-assistant')!;
    expect(user.has_trace).toBe(0);
    expect(assistant.has_trace).toBe(1);

    // The full trace is fetched on demand per message.
    expect(getMessageTrace('msg-user')).toBe('[]');
    expect(getMessageTrace('msg-assistant')).toBe(bigTrace);
    expect(getMessageTrace('does-not-exist')).toBeNull();
  });
});
