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
import { detectIncomplete, pickMessageParts } from './helpers';
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

  // Decide which `parts` to render. The DB's `parts_raw` snapshot is the
  // authoritative source for the original reasoning/tool-call/text
  // sequence — see the long comment on `pickMessageParts` for why the
  // SDK's auto-generated `msg.parts` cannot be trusted for from-DB
  // messages. `pickMessageParts` handles the parse + precedence rules and
  // is memoised here so re-renders triggered by unrelated state don't
  // re-parse the (potentially large) JSON.
  const partsForRender: UIPart[] = useMemo(
    () => pickMessageParts(msg.parts, msg.parts_raw),
    [msg.parts, msg.parts_raw],
  );

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
