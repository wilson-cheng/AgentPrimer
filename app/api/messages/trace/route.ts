/**
 * app/api/messages/trace/route.ts
 * ---------------------------------------------------------------------------
 * On-demand trace reader. Returns the full `trace_json` for a single message.
 *
 * The paginated reader (/api/messages) deliberately OMITS trace_json — a
 * single multi-step assistant message can persist a multi-MB trace (the full
 * conversation snapshotted at every agent step), and shipping it on every
 * session-load / 10s poll was the root cause of the large-session slowdown
 * (browser crashes, 400 "Invalid request body"). The chat UI instead gets a
 * cheap `has_trace` flag and fetches the trace here only when the user opens
 * the Trace Drawer for that message.
 *
 * GET /api/messages/trace?messageId=<uuid>  →  { trace_json: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getMessageTrace } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const messageId = request.nextUrl.searchParams.get('messageId');
  if (!messageId) {
    return NextResponse.json({ error: 'messageId required' }, { status: 400 });
  }
  // Auth is enforced by proxy.ts (JWT required for /api/**). AgentPrimer is a
  // single-workspace app, so any authenticated user may read any message —
  // consistent with /api/messages.
  const trace_json = getMessageTrace(messageId);
  return NextResponse.json({ trace_json: trace_json ?? '[]' });
}
