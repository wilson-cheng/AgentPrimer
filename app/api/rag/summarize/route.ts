import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getSetting, getMessages } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';

/**
 * POST /api/rag/summarize
 * ---------------------------------------------------------------------------
 * Summarize text so it can be ingested into RAG by the new "Send the summary
 * to RAG" buttons in the chat window.
 *
 *   { sessionId: string }            → summarize the entire session history
 *   { messageContent: string }       → summarize a single assistant response
 *
 * Returns: { summary: string }
 *
 * Cancellation: aborting the request on the client cancels the upstream
 * OpenAI call (we forward `req.signal`). The caller is also responsible for
 * undoing any partial RAG row when the summary itself is interrupted.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    sessionId?: string;
    messageContent?: string;
  } | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  // Build the input text. messageContent wins over sessionId so the dialog
  // can override "summarize the whole conversation" with "just this message".
  let input = '';
  if (body.messageContent?.trim()) {
    input = body.messageContent;
  } else if (body.sessionId?.trim()) {
    const msgs = getMessages(body.sessionId);
    input = msgs
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `### ${m.role.toUpperCase()}\n\n${m.content}`)
      .join('\n\n---\n\n');
  } else {
    return NextResponse.json({ error: 'messageContent or sessionId is required' }, { status: 400 });
  }

  if (!input.trim()) {
    return NextResponse.json({ error: 'Nothing to summarize' }, { status: 400 });
  }

  // Configured chat provider — same settings the agent loop uses
  const baseURL = getSetting('endpoint');
  const apiKey = getSetting('api_key') || 'sk-no-key';
  const model = getSetting('default_model');
  if (!baseURL) {
    return NextResponse.json(
      { error: 'No API endpoint configured. Open Settings → Base URL.' },
      { status: 400 },
    );
  }
  if (!model) {
    return NextResponse.json(
      { error: 'No default model configured. Open Settings → Default Model.' },
      { status: 400 },
    );
  }

  const openai = new OpenAI({ baseURL, apiKey: apiKey.trim() });

  // Cap input size so we never exceed the model's context window. 24k chars
  // ≈ 6k tokens which is comfortable on every supported provider, and the
  // resulting summary is still high-quality for the RAG pipeline.
  const MAX_INPUT_CHARS = 24_000;
  const truncatedInput =
    input.length > MAX_INPUT_CHARS ? input.slice(0, MAX_INPUT_CHARS) + '\n\n[…truncated…]' : input;

  const systemPrompt =
    'You are a precise summarizer. Produce a self-contained summary that ' +
    'preserves the key facts, decisions, and code snippets so it is useful ' +
    'as a standalone RAG entry. Use clear markdown with short ' +
    'sections. Do not invent information.';

  try {
    const resp = await openai.chat.completions.create(
      {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: truncatedInput },
        ],
        temperature: 0.2,
      },
      { signal: req.signal },
    );
    const summary = resp.choices[0]?.message?.content ?? '';
    if (!summary.trim()) {
      return NextResponse.json({ error: 'Model returned an empty summary' }, { status: 502 });
    }

    return NextResponse.json({ summary });
  } catch (err) {
    // AbortError surfaces as a DOMException with name='AbortError' from the
    // openai SDK. Translate to 499 so the client can distinguish cancel from
    // a real failure.
    if (err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))) {
      return NextResponse.json({ error: 'Cancelled' }, { status: 499 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
