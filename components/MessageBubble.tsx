'use client';

/**
 * components/MessageBubble.tsx
 * ---------------------------------------------------------------------------
 * Thin orchestrator that composes the four kinds of bubbles a message can show:
 *
 *   • text + markdown      (StreamingTextPart)
 *   • reasoning            (ReasoningBlock)
 *   • tool invocations     (LiveToolCard, LiveToolsPanel, HistoricalToolsTrace)
 *   • skill activation     (SkillActivationCard)
 *   • file attachments     (AgentFileCard, AttachmentRow)
 *   • structured output    (StructuredOutputPanel)
 *   • per-message footer   (TokenUsageBadge, TraceDrawer trigger)
 *
 * The actual rendering lives in components/message/*. This file is just the
 * glue that decides WHICH children to render for a given message — based on
 * role, presence of `parts` (ordered) vs legacy fields, and live vs DB data.
 *
 * Types are re-exported from ./message/types so existing imports of
 * `AgentFileResult`, `LiveToolInvocation`, `UIPart`, `ApprovalRequest`
 * from this file continue to work.
 */

import { Bot, BookPlus, Check, ChevronRight, Copy, Eye, RotateCcw, User } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentStepTrace,
  Attachment,
  LiveToolInvocation,
  MessageTokenUsage,
  ToolCall,
  UIPart,
} from './message/types';
import { ReasoningBlock, StreamingTextPart } from './message/Reasoning';
import { AttachmentRow } from './message/FileBlocks';
import { StructuredOutputPanel } from './message/StructuredOutput';
import FinalizeCallBubble from './message/FinalizeCallBubble';
import { TokenUsageBadge, TraceDrawer } from './message/TraceDrawer';
import {
  HistoricalToolsTrace,
  LiveToolCard,
  LiveToolsPanel,
  SkillActivationCard,
} from './message/ToolCards';
import SendToRagDialog from './SendToRagDialog';

// Re-export types so external imports of these from MessageBubble keep working.
export type { AgentFileResult, ApprovalRequest, LiveToolInvocation, UIPart } from './message/types';

interface MessageBubbleProps {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  attachments?: Attachment[];
  /** Saved tool calls from DB (historical messages) */
  toolCalls?: ToolCall[];
  /** Live tool invocations from msg.parts (streaming messages) */
  toolInvocations?: LiveToolInvocation[];
  /** Ordered parts array from useChat – enables interleaved reasoning/tool/text rendering */
  parts?: UIPart[];
  /** Reasoning text accumulated from msg.annotations during streaming */
  reasoning?: string;
  isStreaming?: boolean;
  /** Session ID passed through to approval buttons */
  sessionId?: string;
  /** Called after user grants approval – parent re-triggers the agent */
  onApprovalGranted?: (inv: LiveToolInvocation, scope: 'once' | 'session' | 'permanent') => void;
  /** Called when user clicks Deny */
  onApprovalDenied?: (inv: LiveToolInvocation) => void;
  /** Whether reasoning/tool-call blocks start expanded (from settings) */
  expandByDefault?: boolean;
  /** Token usage for this message – shown when showTokenUsage is true */
  tokenUsage?: MessageTokenUsage;
  /** Per-step trace data from the agent loop – enables the "Show trace" button.
   *  Populated for LIVE messages (captured from the agent_trace stream event);
   *  empty for from-DB messages, whose trace is fetched on demand (see
   *  `hasTrace` + `messageId`). */
  trace?: AgentStepTrace[];
  /** True when the message has a persisted trace but it isn't loaded yet
   *  (from-DB messages). Shows the "Trace" button and triggers a lazy fetch
   *  via /api/messages/trace when the drawer opens. */
  hasTrace?: boolean;
  /** Message id — used to fetch the trace on demand when `hasTrace` is set. */
  messageId?: string;
  /** Max context length of the currently-selected model (for context gauge) */
  contextLength?: number;
  /** Max output length of the currently-selected model (for output gauge) */
  outputLength?: number;
  /**
   * Live data parts from useChat's message.data (populated by 2: stream parts).
   * Used to detect structured output / skills bubbles while streaming, before
   * parts_json is restored from DB (which happens after page navigation).
   */
  data?: unknown[];
  /**
   * Set when this assistant response is the LAST one in the conversation
   * AND ended in an incomplete state (max output tokens, connection drop,
   * or upstream error). Triggers the "Continue" button below the bubble.
   */
  incomplete?: { reason: 'length' | 'connection_lost' | 'error'; detail?: string };
  /** Called when the user clicks the Continue button. */
  onContinue?: () => void;
}

export default function MessageBubble({
  role,
  content,
  attachments = [],
  toolCalls = [],
  toolInvocations = [],
  parts = [],
  reasoning = '',
  isStreaming,
  sessionId,
  onApprovalGranted,
  onApprovalDenied,
  expandByDefault = false,
  tokenUsage,
  contextLength,
  outputLength,
  data = [],
  trace = [],
  hasTrace = false,
  messageId,
  incomplete,
  onContinue,
}: MessageBubbleProps) {
  const [traceOpen, setTraceOpen] = useState(false);
  const [fetchedTrace, setFetchedTrace] = useState<AgentStepTrace[] | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [subagentOpen, setSubagentOpen] = useState(false);
  const [sendToRagOpen, setSendToRagOpen] = useState(false);
  const isUser = role === 'user';
  const isAssistant = role === 'assistant';
  const subagentMatch = isAssistant ? content.match(/^\[(Sub-agent[^\]]+)\]\n\n([\s\S]*)$/) : null;

  // ── Lazy trace loading ──────────────────────────────────────────────────
  // Live messages carry their trace in memory (`trace` prop, captured from
  // the agent_trace stream event). From-DB messages only carry a `hasTrace`
  // flag — the (potentially multi-MB) trace is fetched here, on demand, when
  // the user opens the Trace Drawer. See /api/messages/trace.
  const effectiveTrace: AgentStepTrace[] = trace.length > 0 ? trace : fetchedTrace ?? [];
  // Tracks the messageId we've already fetched (or are fetching) so the
  // effect doesn't refetch on unrelated re-renders. A ref (not state) so it
  // never re-triggers the effect — putting traceLoading/fetchedTrace in the
  // dependency array would cancel the in-flight fetch on the setTraceLoading
  // re-render and leave the drawer stuck on "Loading…".
  const fetchedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!traceOpen) return;
    if (trace.length > 0) return; // already have the live trace
    if (!hasTrace || !messageId) return; // nothing to load
    if (fetchedForRef.current === messageId) return; // already fetched/fetching
    fetchedForRef.current = messageId;
    let cancelled = false;
    setTraceLoading(true);
    fetch(`/api/messages/trace?messageId=${encodeURIComponent(messageId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        try {
          const v = JSON.parse((d as { trace_json?: string })?.trace_json ?? '[]');
          setFetchedTrace(Array.isArray(v) ? (v as AgentStepTrace[]) : []);
        } catch {
          setFetchedTrace([]);
        }
      })
      .catch(() => {
        if (!cancelled) setFetchedTrace([]);
      })
      .finally(() => {
        if (!cancelled) setTraceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [traceOpen, trace.length, hasTrace, messageId]);

  // Closing the drawer drops the (potentially multi-MB) fetched trace so it
  // isn't held in memory for the rest of the session; reopening refetches.
  const closeTrace = useCallback(() => {
    setTraceOpen(false);
    setFetchedTrace(null);
    setTraceLoading(false);
    fetchedForRef.current = null;
  }, []);

  // Prefer live invocations (streaming) over saved tool calls (historical)
  const liveTools = toolInvocations.length > 0 ? toolInvocations : null;
  const savedTools = toolCalls.length > 0 ? toolCalls : null;

  // ── Structured output detection ──────────────────────────────────────────
  // Source depends on the message lifecycle:
  //   Live (during streaming) → msg.data as { type: 'structured_output', ... }
  //   Historical (from DB)    → msg.parts as { type: 'structured-output', ... }
  const soFromData = data.find(
    (d) =>
      typeof d === 'object' &&
      d !== null &&
      (d as Record<string, unknown>).type === 'structured_output',
  ) as { type: string; data: unknown; schemaName: string; schemaLabel: string } | undefined;

  // ── Finalize-call bubble ────────────────────────────────────────────────
  // Schema-bound agents (any agent with **Output Schema:** in agent.md)
  // ALWAYS make one extra non-streaming "finalize" call after the ReAct
  // loop ends. The server emits the about-to-be-sent request payload as a
  // `finalize_call` data event BEFORE firing the call, so the user sees an
  // expandable bubble in the chat showing exactly what is being sent.
  // The bubble is intentionally pre-call only (no response yet at that
  // moment); the structured-output panel below renders the result.
  const finalizeFromData = data.find(
    (d) =>
      typeof d === 'object' &&
      d !== null &&
      (d as Record<string, unknown>).type === 'finalize_call',
  ) as { type: string; schemaLabel?: string; payload: unknown } | undefined;

  // ── Activated skills detection ──────────────────────────────────────────
  // Skills are injected into the system prompt server-side (NOT as tool calls).
  // To make them visible the agent loop emits a `skills_activated` data part
  // live, and pushes a matching `skills-activated` part to `allParts` for
  // persistence. Live UI reads `data[]`; reloaded UI reads `parts[]`.
  const skillsFromData = data.find(
    (d) =>
      typeof d === 'object' &&
      d !== null &&
      (d as Record<string, unknown>).type === 'skills_activated',
  ) as { type: string; skills: Array<{ name: string; description: string }> } | undefined;

  // ── Ordered-parts rendering ──────────────────────────────────────────────
  // When msg.parts is available (live/recent messages), the SDK emits parts in
  // the exact sequence they arrived: reasoning → tool-call → reasoning → text.
  // We render them in that order instead of the legacy fixed layout.
  //
  // 'structured-output' and 'skills-activated' parts are restored from
  // parts_json on page navigation.
  const orderedParts = parts.filter(
    (p) =>
      p.type === 'step-start' ||
      p.type === 'reasoning' ||
      p.type === 'tool-invocation' ||
      p.type === 'text' ||
      p.type === 'structured-output' ||
      p.type === 'finalize-call' ||
      p.type === 'skills-activated',
  );
  const useOrderedParts =
    orderedParts.some(
      (p) =>
        p.type === 'reasoning' ||
        p.type === 'tool-invocation' ||
        p.type === 'text' ||
        p.type === 'structured-output' ||
        p.type === 'finalize-call' ||
        p.type === 'skills-activated',
    ) ||
    !!soFromData ||
    !!skillsFromData ||
    !!finalizeFromData;
  const copyResponseSource = async () => {
    const source = useOrderedParts ? orderedParts.filter((p) => p.type !== 'step-start') : content;
    await navigator.clipboard.writeText(
      typeof source === 'string' ? source : JSON.stringify(source, null, 2),
    );
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  /** Plain-text version of the response (no part wrappers) — what the
   *  Send-to-RAG dialog hands to the summarizer. We prefer the visible text
   *  parts when available; for legacy messages we fall back to `content`. */
  const summarySource: string = useOrderedParts
    ? orderedParts
        .filter((p) => p.type === 'text' || p.type === 'reasoning')
        .map((p) =>
          p.type === 'text'
            ? (p as { text: string }).text
            : `> ${(p as { reasoning: string }).reasoning}`,
        )
        .join('\n\n')
    : content;

  const copyIcon = (
    <button
      onClick={copyResponseSource}
      className="absolute bottom-1.5 left-3 inline-flex h-5 w-5 items-center justify-center rounded-md text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
      title="Copy"
      aria-label="Copy"
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );

  const sendToRagIcon = (
    <button
      onClick={() => setSendToRagOpen(true)}
      className="absolute bottom-1.5 left-10 inline-flex h-5 w-5 items-center justify-center rounded-md text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
      title="Send the summary to RAG"
      aria-label="Send the summary to RAG"
    >
      <BookPlus size={16} />
    </button>
  );
  // Index of the last non-step-start part – only that part gets isStreaming.
  const lastPartIdx = orderedParts.reduce((last, p, i) => (p.type !== 'step-start' ? i : last), -1);

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'} group`}>
      {/* Avatar */}
      <div
        className={`flex-shrink-0 h-8 w-8 rounded-lg flex items-center justify-center ${isUser ? 'bg-blue-500' : 'bg-gray-200 dark:bg-gray-700'}`}
      >
        {isUser ? (
          <User size={15} className="text-white" />
        ) : (
          <Bot size={15} className="text-gray-600 dark:text-gray-300" />
        )}
      </div>

      <div
        className={`flex flex-col gap-2 w-full min-w-0 max-w-[90%] ${isUser ? 'items-end' : 'items-start'}`}
      >
        {/* Attachments */}
        {attachments.length > 0 && <AttachmentRow attachments={attachments} isUser={isUser} />}

        {/* ── ORDERED PARTS (live / recent messages) ────────────────────────
            Renders each part at its actual position in the stream:
            reasoning → tool call → reasoning → text.
            Falls back to legacy fixed-order for historical messages. */}
        {isAssistant && useOrderedParts && (
          <>
            {orderedParts.map((part, i) => {
              const partStreaming = isStreaming && i === lastPartIdx;
              if (part.type === 'step-start') return null;

              if (part.type === 'reasoning') {
                const rp = part as { type: 'reasoning'; reasoning: string };
                return (
                  <ReasoningBlock
                    key={`r${i}`}
                    reasoning={rp.reasoning}
                    isStreaming={partStreaming}
                    expandByDefault={expandByDefault}
                  />
                );
              }

              if (part.type === 'tool-invocation') {
                const tp = part as { type: 'tool-invocation'; toolInvocation: LiveToolInvocation };
                return (
                  <LiveToolCard
                    key={tp.toolInvocation.toolCallId}
                    inv={tp.toolInvocation}
                    sessionId={sessionId}
                    onApprovalGranted={onApprovalGranted}
                    onApprovalDenied={onApprovalDenied}
                    expandByDefault={expandByDefault}
                  />
                );
              }

              if (part.type === 'finalize-call') {
                const fp = part as {
                  type: 'finalize-call';
                  schemaLabel?: string;
                  payload: unknown;
                };
                return (
                  <FinalizeCallBubble
                    key={`fin${i}`}
                    schemaLabel={fp.schemaLabel}
                    payload={fp.payload}
                  />
                );
              }

              if (part.type === 'structured-output') {
                const sop = part as {
                  type: 'structured-output';
                  data: unknown;
                  schemaName: string;
                  schemaLabel: string;
                };
                return (
                  <StructuredOutputPanel
                    key={`so${i}`}
                    data={sop.data}
                    schemaName={sop.schemaName}
                    schemaLabel={sop.schemaLabel}
                  />
                );
              }

              if (part.type === 'skills-activated') {
                const skp = part as {
                  type: 'skills-activated';
                  skills: Array<{ name: string; description: string }>;
                };
                return <SkillActivationCard key={`sk${i}`} skills={skp.skills} />;
              }

              if (part.type === 'text') {
                if (soFromData) return null;
                const xp = part as { type: 'text'; text: string };
                if (!xp.text || !xp.text.trim()) return null;
                return (
                  <div
                    key={`t${i}`}
                    className="group relative max-w-full rounded-xl px-4 py-3 pb-6 text-base leading-relaxed bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-tl-sm"
                  >
                    <StreamingTextPart
                      text={xp.text}
                      isStreaming={isStreaming ?? false}
                      streamingCursor={partStreaming ?? false}
                    />
                    {!isStreaming && copyIcon}
                    {!isStreaming && sendToRagIcon}
                  </div>
                );
              }

              return null;
            })}
            {/* Live finalize-call bubble */}
            {finalizeFromData && !orderedParts.some((p) => p.type === 'finalize-call') && (
              <FinalizeCallBubble
                schemaLabel={finalizeFromData.schemaLabel}
                payload={finalizeFromData.payload}
              />
            )}
            {/* Live structured output */}
            {soFromData && !orderedParts.some((p) => p.type === 'structured-output') && (
              <StructuredOutputPanel
                data={soFromData.data}
                schemaName={soFromData.schemaName}
                schemaLabel={soFromData.schemaLabel}
              />
            )}
            {/* Live skills bubble */}
            {skillsFromData && !orderedParts.some((p) => p.type === 'skills-activated') && (
              <SkillActivationCard skills={skillsFromData.skills} />
            )}
          </>
        )}

        {/* ── LEGACY FIXED-ORDER (historical messages / no parts) ───────── */}
        {isAssistant && !useOrderedParts && reasoning && (
          <ReasoningBlock
            reasoning={reasoning}
            isStreaming={isStreaming && !content}
            expandByDefault={expandByDefault}
          />
        )}

        {isAssistant && !useOrderedParts && liveTools && liveTools.length > 0 && (
          <LiveToolsPanel
            invocations={liveTools}
            sessionId={sessionId}
            onApprovalGranted={onApprovalGranted}
            onApprovalDenied={onApprovalDenied}
            expandByDefault={expandByDefault}
          />
        )}

        {subagentMatch && !useOrderedParts && (
          <div className="max-w-full rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-100 overflow-hidden">
            <button
              onClick={() => setSubagentOpen((v) => !v)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-700 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors"
            >
              <ChevronRight
                size={15}
                className={`transition-transform ${subagentOpen ? 'rotate-90' : ''}`}
              />
              <span>{subagentMatch[1]}</span>
            </button>
            {subagentOpen && (
              <pre className="whitespace-pre-wrap border-t border-emerald-200 px-3 py-2 text-sm leading-relaxed dark:border-emerald-800">
                {subagentMatch[2]}
              </pre>
            )}
          </div>
        )}

        {/* Main content bubble: user messages + assistant without ordered parts */}
        {(isUser || (isAssistant && !useOrderedParts && !subagentMatch)) &&
          content &&
          content.trim() && (
            <div
              className={`
            ${isAssistant ? 'group ' : ''}relative max-w-full rounded-xl px-4 py-3 ${isAssistant ? 'pb-8 ' : ''}text-base leading-relaxed
            ${
              isUser
                ? 'bg-blue-500 text-white rounded-tr-sm'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-tl-sm'
            }
          `}
            >
              {isUser ? (
                <p className="whitespace-pre-wrap">{content}</p>
              ) : (
                <>
                  <StreamingTextPart
                    text={content}
                    isStreaming={isStreaming ?? false}
                    streamingCursor={isStreaming ?? false}
                  />
                  {!isStreaming && copyIcon}
                  {!isStreaming && sendToRagIcon}
                </>
              )}
            </div>
          )}

        {/* Historical tool calls trace (from DB, shown for loaded messages) */}
        {isAssistant && !liveTools && savedTools && (
          <HistoricalToolsTrace toolCalls={savedTools} expandByDefault={expandByDefault} />
        )}

        {/* Thinking indicator */}
        {isAssistant && isStreaming && (
          <div className="flex mt-2 gap-1.5 items-center h-5 px-1" aria-label="Thinking">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-2 w-2 rounded-full bg-gray-400 animate-bounce"
                style={{ animationDelay: `${i * 0.15}s` }}
              />
            ))}
          </div>
        )}

        {/* Token usage badge + trace button */}
        {isAssistant && !isStreaming && (
          <div className="space-y-1">
            {tokenUsage && (tokenUsage.input > 0 || tokenUsage.output > 0) && (
              <TokenUsageBadge
                usage={tokenUsage}
                contextLength={contextLength}
                outputLength={outputLength}
              />
            )}
            {(trace.length > 0 || hasTrace) && (
              <button
                onClick={() => setTraceOpen(true)}
                className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-sm font-mono bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 border border-gray-200 dark:border-gray-700 hover:bg-violet-100 dark:hover:bg-violet-900/30 hover:text-violet-600 dark:hover:text-violet-300 transition-colors"
                title="View per-step trace"
              >
                <Eye size={13} />
                {trace.length > 0
                  ? `Trace (${trace.length} step${trace.length !== 1 ? 's' : ''})`
                  : 'Trace'}
              </button>
            )}
          </div>
        )}

        {/* Continue button — shown when this is the last assistant message and
            it ended in an incomplete state (max output tokens reached, the
            connection dropped, or an upstream error fired). The button asks
            the server to resume the response from exactly where it left off
            (see /api/chat resumeFrom handling). */}
        {isAssistant && !isStreaming && incomplete && onContinue && (
          <button
            onClick={onContinue}
            className="inline-flex items-center gap-2 px-3 py-1.5 mt-1 rounded-lg text-sm font-medium bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-900/60 transition-colors"
            title={
              incomplete.reason === 'length'
                ? 'Resume after the model hit its max output token limit'
                : incomplete.reason === 'connection_lost'
                  ? 'Resume after the connection to the model dropped'
                  : 'Resume after an interruption'
            }
          >
            <RotateCcw size={14} />
            Continue
          </button>
        )}
      </div>

      {/* Trace drawer — live trace is shown immediately; from-DB trace is
          fetched on demand (see the lazy-load effect above). */}
      {traceOpen &&
        (traceLoading && effectiveTrace.length === 0 ? (
          <div
            className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
            onClick={closeTrace}
          >
            <div
              className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl px-8 py-6 text-sm text-gray-500 dark:text-gray-400"
              onClick={(e) => e.stopPropagation()}
            >
              Loading trace…
            </div>
          </div>
        ) : (
          <TraceDrawer trace={effectiveTrace} onClose={closeTrace} />
        ))}

      {/* Send-to-RAG dialog (3-step: summarize → send → index) */}
      {sendToRagOpen && (
        <SendToRagDialog
          mode="summary"
          defaultTitle={`Chat summary ${new Date().toLocaleString()}`}
          messageContent={summarySource}
          sessionId={sessionId}
          onClose={() => setSendToRagOpen(false)}
        />
      )}
    </div>
  );
}
