/**
 * app/api/chat/stop/route.ts
 * ---------------------------------------------------------------------------
 * POST /api/chat/stop  { sessionId }
 *
 * Aborts the active background run for a session — i.e. the Stop button.
 * This is the ONLY thing that cancels a run: a browser/socket disconnect no
 * longer does (the loop runs detached via lib/agent/run-manager.ts). The
 * abort fires the run's AbortController, which the loop passes to
 * `openai.chat.completions.create({ signal })` (cancelling the in-flight LLM
 * request) and checks at the top of every step (clean exit between steps).
 *
 * Scoped to the authenticated user so one account can't abort another's run.
 */
import { NextRequest, NextResponse } from 'next/server';
import { abortRun } from '@/lib/agent';
import { getSessionUser } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { sessionId } = body as { sessionId?: string };
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
  }
  const aborted = abortRun(user, sessionId);
  return NextResponse.json({ ok: aborted });
}
