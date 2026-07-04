import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentprimer-payload-'));
  vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('buildChatRequestBody (client payload trimming)', () => {
  it('drops trace_json/parts/reasoning and keeps only id/role/content/toolInvocations', async () => {
    const { buildChatRequestBody } = await import('../components/chat/helpers');
    const messages = [
      {
        id: 'u1',
        role: 'user',
        content: 'hi',
        parts: [{ type: 'text', text: 'hi' }],
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'done',
        toolInvocations: [
          {
            toolCallId: 'tc1',
            toolName: 'read_file',
            args: { path: '/x' },
            result: 'ok',
            state: 'result',
            step: 0,
          },
        ],
        // 5MB of UI-only trace data that must NOT reach the server:
        trace_json: 'X'.repeat(5_000_000),
        parts: [{ type: 'tool-invocation', toolInvocation: {} }],
        reasoning: 'thinking...',
        token_usage_json: '{"input":1000}',
        parts_raw: '[]',
        tool_calls_json: '[]',
      },
    ];
    const body = buildChatRequestBody({
      id: 'chat1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
      sessionId: 's1',
      agentName: 'main',
      modelId: 'm1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const serialized = JSON.stringify(body);

    // The 5MB trace_json must be gone.
    expect(serialized.length).toBeLessThan(50_000);
    expect(body.messages[0]).toEqual({ id: 'u1', role: 'user', content: 'hi' });
    expect(body.messages[1]).toEqual({
      id: 'a1',
      role: 'assistant',
      content: 'done',
      toolInvocations: messages[1].toolInvocations,
    });
    expect(body.sessionId).toBe('s1');
    expect(body.agentName).toBe('main');
    expect(body.modelId).toBe('m1');
  });

  it('forwards tool_calls_json (not toolInvocations) for from-DB messages and omits empty modelId', async () => {
    const { buildChatRequestBody } = await import('../components/chat/helpers');
    const messages = [
      {
        id: 'a1',
        role: 'assistant',
        content: 'done',
        tool_calls_json: JSON.stringify([
          { toolCallId: 'tc1', toolName: 'read_file', args: { path: '/x' }, result: 'ok' },
        ]),
      },
    ];
    const body = buildChatRequestBody({
      id: 'chat1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
      sessionId: 's1',
      agentName: 'main',
      modelId: '',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    expect(body.messages[0]).toHaveProperty('tool_calls_json');
    expect(body.messages[0].toolInvocations).toBeUndefined();
    expect(body.modelId).toBeUndefined();
  });

  it('merges per-call requestBody (attachments/resumeFrom) into the body', async () => {
    const { buildChatRequestBody } = await import('../components/chat/helpers');
    const body = buildChatRequestBody({
      id: 'chat1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: [{ id: 'u1', role: 'user', content: 'hi' }] as any,
      sessionId: 's1',
      agentName: 'main',
      modelId: 'm1',
      requestBody: { attachments: [{ name: 'f.txt' }], resumeFrom: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    expect(body.attachments).toEqual([{ name: 'f.txt' }]);
    expect(body.resumeFrom).toBe(true);
  });
});

describe('ensureToolInvocations (server-side reconstruction)', () => {
  it('rebuilds toolInvocations from tool_calls_json so tool history survives a reload', async () => {
    const { ensureToolInvocations, convertMessagesToOpenAI } = await import('../lib/agent/messages');
    const reloaded = [
      { id: 'u1', role: 'user', content: 'list files' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'here they are',
        tool_calls_json: JSON.stringify([
          {
            toolCallId: 'tc1',
            toolName: 'list_directory',
            args: { path: '/x' },
            result: { entries: ['a', 'b'] },
          },
          {
            toolCallId: 'tc2',
            toolName: 'read_file',
            args: { path: '/x/a' },
            result: 'hello',
          },
        ]),
        // No live toolInvocations — simulates a from-DB reload.
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;

    // Without the fix, every tool call + result is dropped:
    const before = convertMessagesToOpenAI(reloaded, '');
    expect(before.filter((m) => m.role === 'tool')).toHaveLength(0);

    // With the fix, tool calls + results are reconstructed:
    const fixed = ensureToolInvocations(reloaded);
    expect(fixed[1].toolInvocations).toHaveLength(2);
    expect(fixed[1].toolInvocations[0].state).toBe('result');
    const after = convertMessagesToOpenAI(fixed, '');
    expect(after.filter((m) => m.role === 'tool')).toHaveLength(2);
    expect(after.filter((m) => m.role === 'assistant' && 'tool_calls' in m)).toHaveLength(1);
  });

  it('leaves live messages with existing toolInvocations untouched', async () => {
    const { ensureToolInvocations } = await import('../lib/agent/messages');
    const live = [
      {
        id: 'a1',
        role: 'assistant',
        content: 'x',
        toolInvocations: [
          {
            toolCallId: 'tc1',
            toolName: 't',
            args: {},
            result: 'r',
            state: 'result',
            step: 3,
          },
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;
    const out = ensureToolInvocations(live);
    expect(out[0].toolInvocations[0].step).toBe(3);
  });

  it('ignores malformed tool_calls_json', async () => {
    const { ensureToolInvocations } = await import('../lib/agent/messages');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = [{ id: 'a1', role: 'assistant', content: 'x', tool_calls_json: 'not-json' }] as any;
    const out = ensureToolInvocations(bad);
    expect(out[0].toolInvocations).toBeUndefined();
  });
});

describe('applyStoredFields / storedFieldsEqual (shared DB-row mapping)', () => {
  it('toExtendedMessage maps has_trace -> hasTrace and does not carry trace_json', async () => {
    const { toExtendedMessage } = await import('../components/chat/helpers');
    const row = {
      id: 'a1',
      role: 'assistant',
      content: 'done',
      attachments_json: '[]',
      tool_calls_json: '[]',
      token_usage_json: '{}',
      reasoning_json: '',
      parts_json: '[]',
      has_trace: 1,
      _rowid: 7,
    };
    const m = toExtendedMessage(row);
    expect(m.hasTrace).toBe(true);
    expect(m.trace_json).toBeUndefined();
    expect(m.parts_raw).toBe('[]');
  });

  it('applyStoredFields preserves live-only fields from the base', async () => {
    const { applyStoredFields } = await import('../components/chat/helpers');
    const base = {
      id: 'a1',
      role: 'assistant',
      content: 'old',
      parts: [{ type: 'text', text: 'live' }],
      toolInvocations: [{ toolCallId: 'tc1', state: 'result' }],
      trace_json: '[[live]]',
    };
    const row = {
      id: 'a1',
      role: 'assistant',
      content: 'new',
      attachments_json: '[]',
      tool_calls_json: '[]',
      token_usage_json: '{}',
      reasoning_json: 'r',
      parts_json: '[]',
      has_trace: 1,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const merged = applyStoredFields(base as any, row as any);
    expect(merged.content).toBe('new'); // refreshed from row
    expect(merged.reasoning).toBe('r');
    expect(merged.hasTrace).toBe(true);
    // live-only fields preserved, NOT clobbered by the persisted snapshot
    expect(merged.parts).toEqual([{ type: 'text', text: 'live' }]);
    expect(merged.trace_json).toBe('[[live]]');
  });

  it('storedFieldsEqual mirrors applyStoredFields (no drift)', async () => {
    const { applyStoredFields, storedFieldsEqual } = await import('../components/chat/helpers');
    const row = {
      id: 'a1',
      role: 'assistant',
      content: 'done',
      attachments_json: '[]',
      tool_calls_json: '[]',
      token_usage_json: '{}',
      reasoning_json: '',
      parts_json: '[]',
      has_trace: 1,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applied = applyStoredFields({ id: 'a1', role: 'assistant', content: '' } as any, row as any);
    expect(storedFieldsEqual(applied, row)).toBe(true);
    // A field change must be detected so the poll re-merges.
    expect(storedFieldsEqual({ ...applied, content: 'stale' }, row)).toBe(false);
    expect(storedFieldsEqual({ ...applied, hasTrace: false }, row)).toBe(false);
    expect(storedFieldsEqual({ ...applied, parts_raw: '[{}]' }, row)).toBe(false);
  });
});

describe('pickMessageParts (from-DB ordering fix)', () => {
  it('prefers parsed parts_raw over the SDK-built msg.parts so interleaved tool-invocations are not pushed to the bottom', async () => {
    const { pickMessageParts } = await import('../components/chat/helpers');
    // The agent loop records parts in the exact order they happened. For
    // a typical ReAct turn that's: step-start → reasoning → tool-invocation
    // → text → (next step) → reasoning → tool-invocation → text.
    const interleavedFromDB = [
      { type: 'step-start' },
      { type: 'reasoning', reasoning: 'I should look at the file first.' },
      {
        type: 'tool-invocation',
        toolInvocation: { toolCallId: 't1', toolName: 'read_file', args: {}, state: 'result', result: 'ok' },
      },
      { type: 'text', text: 'The file says…' },
      { type: 'reasoning', reasoning: 'Now I need to update it.' },
      {
        type: 'tool-invocation',
        toolInvocation: { toolCallId: 't2', toolName: 'write_file', args: {}, state: 'result', result: 'ok' },
      },
      { type: 'text', text: 'Done.' },
    ];
    // The SDK's setMessages()→fillMessageParts()→getMessageParts() fallback
    // for a from-DB message that has reasoning + content but no SDK
    // `toolInvocations` field produces [reasoning, text] only — the broken
    // state users saw after navigating back to a session.
    const sdkBuiltFallback = [
      { type: 'reasoning', reasoning: 'I should look at the file first.\nNow I need to update it.' },
      { type: 'text', text: 'The file says…\nDone.' },
    ];
    const picked = pickMessageParts(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdkBuiltFallback as any,
      JSON.stringify(interleavedFromDB),
    );
    // Must NOT be the SDK's [reasoning, text] fallback — that would force
    // the legacy render path and group the tool calls at the bottom.
    expect(picked).toEqual(interleavedFromDB);
    expect(picked.filter((p) => p.type === 'tool-invocation')).toHaveLength(2);
  });

  it('falls back to msg.parts when parts_raw is the literal empty array ("[]")', async () => {
    const { pickMessageParts } = await import('../components/chat/helpers');
    const liveParts = [{ type: 'text', text: 'streaming…' }];
    const picked = pickMessageParts(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      liveParts as any,
      '[]',
    );
    expect(picked).toBe(liveParts);
  });

  it('falls back to msg.parts when parts_raw is undefined (live, never persisted)', async () => {
    const { pickMessageParts } = await import('../components/chat/helpers');
    const liveParts = [{ type: 'text', text: 'streaming…' }];
    const picked = pickMessageParts(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      liveParts as any,
      undefined,
    );
    expect(picked).toBe(liveParts);
  });

  it('falls back to msg.parts when parts_raw is malformed JSON (defensive)', async () => {
    const { pickMessageParts } = await import('../components/chat/helpers');
    const liveParts = [{ type: 'text', text: 'streaming…' }];
    const picked = pickMessageParts(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      liveParts as any,
      'not-json-{',
    );
    expect(picked).toBe(liveParts);
  });

  it('returns an empty array when both parts_raw and msg.parts are absent', async () => {
    const { pickMessageParts } = await import('../components/chat/helpers');
    expect(pickMessageParts(undefined, undefined)).toEqual([]);
    expect(pickMessageParts(undefined, '[]')).toEqual([]);
  });

  it('preserves part order from parts_raw: reasoning → tool → reasoning → text → tool → text', async () => {
    const { pickMessageParts } = await import('../components/chat/helpers');
    const ordered = [
      { type: 'reasoning', reasoning: 'r1' },
      { type: 'tool-invocation', toolInvocation: { toolCallId: 'a' } },
      { type: 'reasoning', reasoning: 'r2' },
      { type: 'text', text: 't1' },
      { type: 'tool-invocation', toolInvocation: { toolCallId: 'b' } },
      { type: 'text', text: 't2' },
    ];
    const picked = pickMessageParts(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      undefined as any,
      JSON.stringify(ordered),
    );
    expect(picked.map((p: { type: string }) => p.type)).toEqual([
      'reasoning',
      'tool-invocation',
      'reasoning',
      'text',
      'tool-invocation',
      'text',
    ]);
  });
});
