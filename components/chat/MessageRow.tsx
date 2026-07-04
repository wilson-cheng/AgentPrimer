/**
 * components/chat/MessageRow.tsx
 * ---------------------------------------------------------------------------
 * Memoised per-message wrapper. Extracted from ChatInterface.tsx.
 *
 * React.memo ensures that when the last assistant message receives a new
 * streaming token, ONLY that message re-renders. All previous (completed)
 * messages are skipped entirely because their props haven't changed.
 * JSON parsing of tool/trace payloads is also memoised so it runs only
 * when the underlying serialised string actually changes.
 */
'use client';

import { memo, useMemo } from 'react';
import MessageBubble, { type LiveToolInvocation, type UIPart } from '@/components/MessageBubble';
import { detectIncomplete } from './helpers';
import type { ExtendedMessage } from './types';

interface MessageRowProps {
  msg: ExtendedMessage;
  isLast: boolean;
  isLoading: boolean;
  sessionId: string;
  expandByDefault: boolean;
  showTokenUsage: boolean;
  showTrace: boolean;
  contextLength: number | undefined;
  outputLength: number | undefined;
  onApprovalGranted: (inv: LiveToolInvocation, scope: 'once' | 'session' | 'permanent') => void;
  onApprovalDenied: (inv: LiveToolInvocation) => void;
  /** Resume callback — only meaningful for the LAST assistant message. */
  onContinue?: () => void;
}

export const MessageRow = memo(function MessageRow({
  msg,
  isLast,
  isLoading,
  sessionId,
  expandByDefault,
  showTokenUsage,
  showTrace,
  contextLength,
  outputLength,
  onApprovalGranted,
  onApprovalDenied,
  onContinue,
}: MessageRowProps) {
  const isStreaming = isLast && isLoading && msg.role === 'assistant';

  // Lazy-parse the historical parts blob. For chats with hundreds of tool
  // calls this is the single biggest cost on session-load: previously every
  // row's parts_json was JSON.parsed up front in loadSession, multiplied by
  // every re-render through React.memo's stable input requirement. We keep
  // the raw string on the row and parse here, behind useMemo.
  const parsedHistoricalParts = useMemo<UIPart[]>(() => {
    if (!msg.parts_raw) return [];
    try {
      const v = JSON.parse(msg.parts_raw);
      return Array.isArray(v) ? (v as UIPart[]) : [];
    } catch {
      return [];
    }
  }, [msg.parts_raw]);

  // Live messages from useChat already have a real `parts` array; only fall
  // back to the parsed historical blob when the live one is absent/empty.
  const partsForRender: UIPart[] =
    msg.parts && msg.parts.length > 0 ? msg.parts : parsedHistoricalParts;

  const toolCalls = useMemo(() => {
    try {
      return msg.tool_calls_json ? JSON.parse(msg.tool_calls_json) : [];
    } catch {
      return [];
    }
  }, [msg.tool_calls_json]);

  const trace = useMemo(() => {
    if (!showTrace) return [];
    try {
      return msg.trace_json ? JSON.parse(msg.trace_json) : [];
    } catch {
      return [];
    }
  }, [msg.trace_json, showTrace]);

  // From-DB messages carry only a `hasTrace` flag (the multi-MB trace is
  // fetched on demand by the Trace Drawer); live messages carry the trace
  // in memory via `trace` above. The button shows for either, gated by the
  // showTrace setting.
  const hasTrace = showTrace && !!msg.hasTrace;

  const toolInvocations = useMemo(
    () =>
      partsForRender
        .filter(
          (p): p is { type: 'tool-invocation'; toolInvocation: LiveToolInvocation } =>
            typeof p === 'object' &&
            p !== null &&
            (p as Record<string, unknown>).type === 'tool-invocation',
        )
        .map((p) => p.toolInvocation),
    [partsForRender],
  );

  const tokenUsage = useMemo(() => {
    if (!showTokenUsage || msg.role !== 'assistant') return undefined;
    try {
      const tj = msg.token_usage_json;
      if (!tj || tj === '{}') return undefined;
      const u = JSON.parse(tj);
      return u.input != null || u.output != null || u.source != null ? u : undefined;
    } catch {
      return undefined;
    }
  }, [showTokenUsage, msg.role, msg.token_usage_json]);

  const incomplete = useMemo(
    () => detectIncomplete(isLast, msg.role, isStreaming, partsForRender, msg.data, msg.content),
    [isLast, msg.role, isStreaming, partsForRender, msg.data, msg.content],
  );

  return (
    <MessageBubble
      role={msg.role}
      content={msg.content}
      attachments={msg.experimental_attachments ?? []}
      toolCalls={toolCalls}
      toolInvocations={toolInvocations}
      parts={partsForRender}
      data={msg.data ?? []}
      trace={trace}
      hasTrace={hasTrace}
      messageId={msg.id}
      reasoning={msg.reasoning ?? ''}
      isStreaming={isStreaming}
      sessionId={sessionId}
      expandByDefault={expandByDefault}
      tokenUsage={tokenUsage}
      contextLength={contextLength}
      outputLength={outputLength}
      onApprovalGranted={onApprovalGranted}
      onApprovalDenied={onApprovalDenied}
      incomplete={incomplete}
      onContinue={incomplete ? onContinue : undefined}
    />
  );
});
