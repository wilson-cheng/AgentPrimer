/**
 * app/api/chat/active/route.ts
 * ---------------------------------------------------------------------------
 * GET /api/chat/active?sessionId=<id>
 *
 * Reports whether a background run is currently active for a session. The
 * frontend polls this on session load + periodically so that, after a browser
 * reopen mid-run, it can show a Stop button + "generating…" indicator and
 * disable Send (the message queue is deferred, so a second turn while a run is
 * live is rejected server-side with 409).
 *
 * Scoped to the authenticated user so one account can't probe another's run
 * status or assistantMessageId.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getActiveRun } from '@/lib/agent';
import { getSessionUser } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sessionId = request.nextUrl.searchParams.get('sessionId');
  if (!sessionId) return NextResponse.json({ active: false });
  const run = getActiveRun(user, sessionId);
  return NextResponse.json({
    active: !!run,
    assistantMessageId: run?.assistantMessageId ?? null,
  });
}
