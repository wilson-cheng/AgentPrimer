/**
 * app/api/messages/route.ts
 * ---------------------------------------------------------------------------
 * Paginated message reader.
 *
 * Query params (sessionId is always required):
 *   limit     – page size (default 50, max 500)
 *   before    – cursor: return rows OLDER than this rowid (for "Load earlier")
 *   after     – cursor: return rows NEWER than this rowid (for polling /
 *               post-stream refresh — used in place of a full reload)
 *   pending   – '0' to skip the synthetic sub-agent notification rows that
 *               are normally appended; the polling effect uses this to keep
 *               its diff comparisons honest.
 *
 * Response:
 *   {
 *     messages:    Array<Message & { _rowid: number }>
 *     totalCount:  number
 *     nextCursor:  number | null   // pass back as `before` for older history
 *     hasMore:     boolean         // older history exists beyond this window
 *   }
 *
 * Backwards compatibility: callers that omit `limit`, `before`, and `after`
 * still get a usable default — the most recent 50 messages, oldest-first.
 */

import {
  countMessages,
  getAgentTask,
  getMessagesAfter,
  getMessagesPage,
  getPendingNotifications,
} from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const DEFAULT_LIMIT = 50;

function parseIntParam(value: string | null, fallback?: number): number | undefined {
  if (value === null || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('sessionId');
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 });

  const limit =
    parseIntParam(request.nextUrl.searchParams.get('limit'), DEFAULT_LIMIT) ?? DEFAULT_LIMIT;
  const before = parseIntParam(request.nextUrl.searchParams.get('before'));
  const after = parseIntParam(request.nextUrl.searchParams.get('after'));
  const includePending = request.nextUrl.searchParams.get('pending') !== '0';

  const totalCount = countMessages(sessionId);

  // ── after-cursor branch (polling / post-stream catchup) ──────────────────
  // Only returns rows newer than the cursor. Pending sub-agent notifications
  // are never returned here — they have no rowid and the head-page request
  // re-fetches them when needed.
  if (after !== undefined) {
    const messages = getMessagesAfter(sessionId, after, limit);
    return NextResponse.json({
      messages,
      totalCount,
      nextCursor: null,
      hasMore: false,
    });
  }

  // ── before-cursor / first-page branch ────────────────────────────────────
  const page = getMessagesPage(sessionId, limit, before);

  // Sub-agent notification rows are synthetic (no DB row, no rowid) and
  // should only ride along on the FIRST page so the chat tail shows pending
  // bubbles. Older pages never include them.
  let messages: Array<
    | (typeof page.messages)[number]
    | {
        id: string;
        session_id: string;
        role: 'assistant';
        content: string;
        attachments_json: string;
        tool_calls_json: string;
        token_usage_json: string;
        reasoning_json: string;
        parts_json: string;
        has_trace: number;
        created_at: number;
        _rowid: number;
      }
  > = page.messages;
  if (includePending && before === undefined) {
    const existingTaskIds = new Set(
      messages.map((m) => m.content.match(/Task: ([0-9a-f-]{36})/)?.[1]).filter(Boolean),
    );
    const pending = getPendingNotifications(sessionId)
      .filter((n) => !existingTaskIds.has(n.task_id))
      .map((n) => {
        const task = getAgentTask(n.task_id);
        return {
          id: `notification:${n.id}`,
          session_id: sessionId,
          role: 'assistant' as const,
          content: `[Sub-agent finished · ${task?.assignee ?? 'sub-agent'}]\n\n${n.summary}\n\nTask: ${n.task_id}\nLog: ${n.task_file}`,
          attachments_json: '[]',
          tool_calls_json: '[]',
          token_usage_json: '{}',
          reasoning_json: '',
          parts_json: '[]',
          has_trace: 0,
          created_at: n.created_at,
          _rowid: 0,
        };
      });
    messages = [...messages, ...pending];
  }

  return NextResponse.json({
    messages,
    totalCount,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  });
}
