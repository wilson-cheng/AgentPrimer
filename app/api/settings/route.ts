import { getAllSettings, setSetting } from '@/lib/db';
import { clearModelOverrideCache } from '@/lib/agent/model-overrides';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET() {
  const settings = getAllSettings();
  // Never expose the raw API key – mask it for display
  const masked = { ...settings };
  if (masked.api_key && masked.api_key.length > 8) {
    masked.api_key =
      masked.api_key.slice(0, 4) + '•'.repeat(masked.api_key.length - 8) + masked.api_key.slice(-4);
  }
  if (masked.embedding_api_key && masked.embedding_api_key.length > 8) {
    masked.embedding_api_key =
      masked.embedding_api_key.slice(0, 4) +
      '•'.repeat(masked.embedding_api_key.length - 8) +
      masked.embedding_api_key.slice(-4);
  }
  if (masked.langfuse_secret_key && masked.langfuse_secret_key.length > 8) {
    masked.langfuse_secret_key =
      masked.langfuse_secret_key.slice(0, 4) +
      '•'.repeat(masked.langfuse_secret_key.length - 8) +
      masked.langfuse_secret_key.slice(-4);
  }
  return NextResponse.json({ settings: masked });
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const allowed = [
    'endpoint',
    'api_key',
    'default_model',
    'expand_tool_details',
    'max_agent_steps',
    'show_token_usage',
    'show_trace',
    'embedding_provider',
    'embedding_endpoint',
    'embedding_api_key',
    'embedding_model',
    'tracing_enabled',
    'tool_playground',
    'langfuse_enabled',
    'langfuse_public_key',
    'langfuse_secret_key',
    'langfuse_base_url',
    'context_keep_pairs',
    'subagent_polling_enabled',
    'subagent_poll_interval_seconds',
    'subagent_poll_max_attempts',
    'subagent_progress_bubbles_enabled',
    'subagent_auto_followup_enabled',
    'model_context_overrides',
    'model_output_overrides',
  ];

  for (const key of allowed) {
    if (typeof body[key] === 'string') {
      setSetting(key, body[key]);
    }
  }

  // Invalidate the in-memory model-override cache so the next agent turn
  // picks up the freshly saved context/output overrides without a restart.
  if (typeof body.model_context_overrides === 'string' || typeof body.model_output_overrides === 'string') {
    clearModelOverrideCache();
  }

  return NextResponse.json({ ok: true });
}
