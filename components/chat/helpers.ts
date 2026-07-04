/**
 * components/chat/helpers.ts
 * ---------------------------------------------------------------------------
 * Pure helper functions extracted from ChatInterface.tsx. Free of React or
 * DOM dependencies wherever possible — `getActionMenuPosition` is the lone
 * function that touches `window`, kept here for symmetry.
 */
import type { Message as UIMessage } from 'ai/react';
import type { UIPart } from '@/components/MessageBubble';
import {
  ACTION_MENU_GAP,
  ACTION_MENU_HEIGHT,
  ACTION_MENU_MARGIN,
  ACTION_MENU_WIDTH,
} from './constants';
import type { Attachment, ExtendedMessage, IncompleteState, StoredMessage } from './types';

/**
 * A message as it lives in `useChat` state: the SDK's UIMessage (which carries
 * live `toolInvocations` for in-session turns) plus our custom persisted
 * fields (`tool_calls_json`, `parts_raw`, …) attached to from-DB messages.
 */
type ChatStateMessage = UIMessage & {
  tool_calls_json?: string;
};

/**
 * Build a minimal POST /api/chat request body.
 *
 * Why this exists: a single multi-step assistant message persists a
 * `trace_json` that snapshots the ENTIRE conversation at every agent step
 * (see lib/agent/loop.ts). For a long session that field alone can reach tens
 * of MB. Because `useChat` ran with `sendExtraMessageFields: true`, every
 * UI-only field (`trace_json`, `parts`, `reasoning`, `token_usage_json`, …)
 * was serialized into the request body on every turn — even though the server
 * never reads them. A "hi" follow-up became a 15MB+ POST that crashed the
 * browser and made `request.json()` reject with a 400 "Invalid request body".
 *
 * The server only needs, per message: `id` (user-message id reuse), `role`,
 * `content`, and `toolInvocations` (live tool calls). Messages restored from
 * the DB have no live `toolInvocations`, so we forward their persisted
 * `tool_calls_json` instead and let the server reconstruct the tool history
 * (see `ensureToolInvocations` in lib/agent/messages.ts).
 */
export function buildChatRequestBody({
  id,
  messages,
  sessionId,
  agentName,
  modelId,
  requestBody,
}: {
  id: string;
  messages: ChatStateMessage[];
  sessionId: string;
  agentName: string;
  modelId: string;
  requestBody?: object;
}): unknown {
  const trimmed = messages.map((m) => {
    const base: Record<string, unknown> = {
      id: m.id,
      role: m.role,
      content: m.content,
    };
    if (Array.isArray(m.toolInvocations) && m.toolInvocations.length > 0) {
      base.toolInvocations = m.toolInvocations;
      return base;
    }
    // From-DB messages have no live toolInvocations. Forward the persisted
    // tool-call list so the server can rebuild the assistant/tool pairs.
    if (m.tool_calls_json) base.tool_calls_json = m.tool_calls_json;
    return base;
  });
  return {
    id,
    messages: trimmed,
    sessionId,
    agentName,
    ...(modelId ? { modelId } : {}),
    ...(requestBody ?? {}),
  };
}

export function parseJsonArray<T>(raw: string | undefined): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** Overlay a StoredMessage row's persisted fields onto an ExtendedMessage
 *  base. Shared by `toExtendedMessage` (fresh message from a DB row) and
 *  `mergeServerUpdates` (refresh an existing in-memory message with the
 *  freshest persisted snapshot) so the two construction sites can't drift.
 *
 *  Live-only fields (`parts`, `data`, `toolInvocations`, in-memory
 *  `trace_json`) are preserved via the `...base` spread and intentionally NOT
 *  touched: the server's persisted snapshot must never clobber them.
 *
 *  The heavy parts_json string is intentionally NOT JSON.parsed here — it
 *  rides through as `parts_raw` so MessageRow can decode it lazily, only for
 *  rows that actually render. trace_json is NOT carried at all — the list
 *  reader ships only a `has_trace` flag; the Trace Drawer fetches the trace
 *  on demand via /api/messages/trace. */
export function applyStoredFields(base: ExtendedMessage, row: StoredMessage): ExtendedMessage {
  return {
    ...base,
    content: row.content,
    experimental_attachments: parseJsonArray<Attachment>(row.attachments_json),
    token_usage_json: row.token_usage_json || '{}',
    tool_calls_json: row.tool_calls_json || '[]',
    reasoning: row.reasoning_json || '',
    parts_raw: row.parts_json || '[]',
    hasTrace: !!row.has_trace,
  };
}

/** Convert a raw DB row from /api/messages into the shape useChat expects. */
export function toExtendedMessage(m: StoredMessage): ExtendedMessage {
  return applyStoredFields({ id: m.id, role: m.role, content: m.content }, m);
}

/** True when every persisted field on `existing` already matches the freshest
 *  DB snapshot `row`. Used by `mergeServerUpdates` to skip no-op updates that
 *  would otherwise force every visible MessageRow to re-render on each 10s
 *  poll. Keep this field set in lockstep with `applyStoredFields` — a field
 *  present in one but not the other means either a stale UI or a missed poll
 *  update. */
export function storedFieldsEqual(existing: ExtendedMessage, row: StoredMessage): boolean {
  return (
    existing.content === row.content &&
    (existing.token_usage_json ?? '{}') === (row.token_usage_json || '{}') &&
    (existing.tool_calls_json ?? '[]') === (row.tool_calls_json || '[]') &&
    (existing.reasoning ?? '') === (row.reasoning_json || '') &&
    (existing.parts_raw ?? '[]') === (row.parts_json || '[]') &&
    !!existing.hasTrace === !!row.has_trace
  );
}

export function getActionMenuPosition(rect: Pick<DOMRect, 'top' | 'bottom' | 'right'>) {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const left = Math.max(
    ACTION_MENU_MARGIN,
    Math.min(
      rect.right - ACTION_MENU_WIDTH,
      viewportWidth - ACTION_MENU_WIDTH - ACTION_MENU_MARGIN,
    ),
  );
  const below = rect.bottom + ACTION_MENU_GAP;
  const above = rect.top - ACTION_MENU_GAP - ACTION_MENU_HEIGHT;
  const top =
    below + ACTION_MENU_HEIGHT <= viewportHeight - ACTION_MENU_MARGIN
      ? below
      : Math.max(ACTION_MENU_MARGIN, above);
  return { x: left, y: top };
}

/**
 * Detect whether an assistant message ended in an incomplete state (max
 * output tokens, dropped connection, upstream error). Sources, in order:
 *
 *   1. Persisted parts (`incomplete-marker`) — restored from DB on reload.
 *   2. Live `data[]` events (`type: 'incomplete'`) — emitted by the server
 *      mid-stream when interrupt detection triggers.
 *   3. Fallback: scan the message text for the well-known ⚠️ warning
 *      strings the server agent loop emits.
 *
 * We only honor the marker on the LAST assistant message AND when the
 * stream is no longer running (otherwise the Continue button would race
 * with the in-progress completion).
 */
export function detectIncomplete(
  isLast: boolean,
  role: 'user' | 'assistant',
  isStreaming: boolean,
  parts: UIPart[] | undefined,
  data: unknown[] | undefined,
  content: string,
): IncompleteState | undefined {
  if (!isLast || role !== 'assistant' || isStreaming) return undefined;
  const partsList = parts ?? [];
  for (const p of partsList) {
    if (p && typeof p === 'object' && (p as Record<string, unknown>).type === 'incomplete-marker') {
      const rec = p as Record<string, unknown>;
      const rawReason = String(rec.reason ?? 'error');
      const reason: IncompleteState['reason'] =
        rawReason === 'length' || rawReason === 'connection_lost' ? rawReason : 'error';
      return { reason, detail: typeof rec.detail === 'string' ? rec.detail : undefined };
    }
  }
  const live = (data ?? []).find(
    (d) =>
      typeof d === 'object' && d !== null && (d as Record<string, unknown>).type === 'incomplete',
  ) as Record<string, unknown> | undefined;
  if (live) {
    const rawReason = String(live.reason ?? 'error');
    const reason: IncompleteState['reason'] =
      rawReason === 'length' || rawReason === 'connection_lost' ? rawReason : 'error';
    return { reason, detail: typeof live.detail === 'string' ? live.detail : undefined };
  }
  const textParts = partsList
    .filter((p) => p && typeof p === 'object' && (p as Record<string, unknown>).type === 'text')
    .map((p) => String((p as Record<string, unknown>).text ?? ''));
  const warningText = [content, ...textParts].filter(Boolean).join('\n\n');
  if (/^>\s*⚠️/m.test(warningText)) {
    if (warningText.includes('maximum output token limit')) return { reason: 'length' };
    if (warningText.includes('connection to the model dropped'))
      return { reason: 'connection_lost' };
    if (warningText.includes('interrupted')) return { reason: 'error' };
  }
  return undefined;
}
