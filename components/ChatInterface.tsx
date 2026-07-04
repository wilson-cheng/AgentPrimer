'use client';

/**
 * components/ChatInterface.tsx
 * ---------------------------------------------------------------------------
 * Shared chat UI used by both:
 *   - /chat         (new conversation — no initialSessionId)
 *   - /chat/[id]    (existing session — initialSessionId = route param)
 *
 * The sidebar lives in the persistent (main) layout and is never unmounted
 * during page navigation.  Session switching and new-conversation navigation
 * are handled there via router.push.  This component only manages the chat
 * content area and the optional preview panel.
 */

import { useChat, type Message as UIMessage } from 'ai/react';
import { useEffect, useRef, useState, useCallback, useMemo, useDeferredValue } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { type LiveToolInvocation } from '@/components/MessageBubble';
import ChatInput from '@/components/ChatInput';
import BrandLogo from '@/components/BrandLogo';
import ModelSelector from '@/components/ModelSelector';
import CustomDropDown from '@/components/ui/CustomDropDown';
import PreviewPanel, { type PreviewFile } from '@/components/PreviewPanel';
import SystemPromptModal from '@/components/SystemPromptModal';
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  PanelRight,
  PanelRightClose,
  Pin,
  PinOff,
  Bookmark,
  BookmarkX,
  MessageSquare,
  Brain,
  MoreHorizontal,
  Pencil,
  Trash2,
  ChevronDown,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { getContextLength, getOutputLength } from '@/lib/model-lengths';
import { MessageRow } from '@/components/chat/MessageRow';
import { INITIAL_PAGE_SIZE, OLDER_PAGE_SIZE } from '@/components/chat/constants';
import {
  getActionMenuPosition,
  toExtendedMessage,
  buildChatRequestBody,
  applyStoredFields,
  storedFieldsEqual,
} from '@/components/chat/helpers';
import { ALL_SUGGESTIONS } from '@/components/chat/suggestions';
import type {
  Attachment,
  ExtendedMessage,
  MessagesPage,
  PreviewState,
  Props,
  StoredMessage,
} from '@/components/chat/types';

export default function ChatInterface({ initialSessionId }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const [sessionId, setSessionId] = useState<string>('');
  const [agentName, setAgentName] = useState('main');
  const [modelId, setModelId] = useState('');
  const [modelContextLengths, setModelContextLengths] = useState<Record<string, number>>({});
  const [modelOutputLengths, setModelOutputLengths] = useState<Record<string, number>>({});
  const [agentNames, setAgentNames] = useState<string[]>(['main']);
  /** Per-agent preferred model (from agent.md). null = "use Settings default". */
  const [agentModels, setAgentModels] = useState<Record<string, string | null>>({});
  /** The list of model IDs that the configured provider actually exposes —
   *  used to detect an agent's preference pointing at an unavailable model. */
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  /** The Settings → Default Model setting, used as the fallback when an
   *  agent omits **Model:** (or sets it to `default`). Fetched from
   *  /api/settings alongside the model list. */
  const [settingsDefaultModel, setSettingsDefaultModel] = useState<string>('');
  const [sessionTitle, setSessionTitle] = useState('New Chat');
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  /** True when a detached background run is active for this session — i.e. the
   *  agent loop is still going after the browser was closed/reopened (or the
   *  live stream dropped). Drives the Stop button + Send gating on reopen and
   *  a faster DB-merge poll so the assistant bubble updates as the run
   *  checkpoints. See lib/agent/run-manager.ts. */
  const [backgroundRunning, setBackgroundRunning] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  /**
   * Stick-to-bottom mode. While `true`, every DOM growth pins scrollTop to
   * scrollHeight. Flips to `false` only when the user *clearly* scrolls up
   * (delta-based wheel/touch upward movement OR the bottom sentinel leaves
   * the viewport by more than the anchoring threshold). The previous design
   * used `userScrolledRef` driven by raw scroll deltas, which incorrectly
   * tripped on browser scroll-anchoring jitter during streaming. See
   * commit history of this file for the multiple failed patches.
   */
  const stickToBottomRef = useRef(true);
  /** State for showing/hiding the scroll-to-bottom button */
  const [showScrollButton, setShowScrollButton] = useState(false);
  /** true only when the user manually changes the agent selector */
  const userChangedAgentRef = useRef(false);
  /** tracks previous isLoading value to detect stream-completed transition */
  const prevLoadingRef = useRef(false);
  /** mirror of prevLoadingRef used by the post-stream refetch effect */
  const prevLoadingForRefetchRef = useRef(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  /** Pagination state for the historical-message window. The UI only renders
   *  the rows held in `messages`; older rows are fetched on demand by the
   *  "Load earlier" button. The state lives at the component level (not a
   *  ref) because the button needs to re-render when the cursor / count
   *  changes. */
  const [olderCursor, setOlderCursor] = useState<number | null>(null);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [totalMessageCount, setTotalMessageCount] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** Map message.id → SQLite rowid. Used by the polling/refetch effects to
   *  request "rows after the latest one I have" without re-downloading the
   *  full history every poll. Synthetic notification rows have rowid 0 and
   *  are intentionally omitted so they don't poison the cursor. */
  const messageRowidsRef = useRef<Map<string, number>>(new Map());
  const [expandByDefault, setExpandByDefault] = useState(true);
  const [showTokenUsage, setShowTokenUsage] = useState(true);
  const [showTrace, setShowTrace] = useState(true);
  // Pinned sessions for new-chat empty state
  const [pinnedSessions, setPinnedSessions] = useState<
    Array<{
      id: string;
      title: string;
      agent_name?: string;
      pinned_chat: number;
      pinned_prompt: string | null;
    }>
  >([]);
  const [newChatContextMenu, setNewChatContextMenu] = useState<{
    id: string;
    mode: 'chat' | 'prompt';
    x: number;
    y: number;
  } | null>(null);
  // New-chat layout: which sections to show and their order
  const [newChatShowSuggestions] = useState(true);
  const [newChatShowPinnedChat] = useState(true);
  const [newChatShowPinnedPrompt] = useState(true);
  const [newChatSectionOrder] = useState<string[]>(['suggestions', 'pinned_chat', 'pinned_prompt']);
  const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const processedPreviewRef = useRef(new Set<string>());
  /** Ordered list of every file previewed in this session (for history nav) */
  const [previewHistory, setPreviewHistory] = useState<PreviewFile[]>([]);
  /** Currently-displayed index within previewHistory */
  const [previewHistoryIndex, setPreviewHistoryIndex] = useState(0);
  const restoredPreviewStateRef = useRef<PreviewState | null>(null);
  /** True while loadSession is restoring historical messages – suppresses auto-open */
  const isRestoringRef = useRef(false);

  const suggestions = useMemo(() => {
    const shuffled = [...ALL_SUGGESTIONS].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 6);
  }, []);

  const refreshPinnedSessions = useCallback(async () => {
    const res = await fetch('/api/sessions');
    if (!res.ok) return;
    const d = await res.json();
    setPinnedSessions(
      (d.sessions ?? []).filter(
        (s: { pinned_chat: number; pinned_prompt: string | null }) =>
          s.pinned_chat || s.pinned_prompt,
      ),
    );
  }, []);

  const patchPinnedSession = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      await fetch('/api/sessions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...body }),
      });
      await refreshPinnedSessions();
      window.dispatchEvent(new Event('sessions-changed'));
    },
    [refreshPinnedSessions],
  );

  const deletePinnedSession = useCallback(
    async (id: string) => {
      await fetch(`/api/sessions?id=${id}`, { method: 'DELETE' });
      await refreshPinnedSessions();
      window.dispatchEvent(new Event('sessions-changed'));
    },
    [refreshPinnedSessions],
  );

  const persistPreviewState = useCallback(
    (state: PreviewState) => {
      if (!sessionId) return;
      fetch('/api/sessions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sessionId, previewState: state }),
      }).catch(() => {});
    },
    [sessionId],
  );

  const selectPreview = useCallback(
    (file: PreviewFile, history: PreviewFile[], index: number, open = true) => {
      const nextFile = { ...file, version: (previewFile?.version ?? 0) + 1 };
      setPreviewHistoryIndex(index);
      setPreviewFile(nextFile);
      setPreviewOpen(open);
      persistPreviewState({ open, file: nextFile, history, index });
    },
    [persistPreviewState, previewFile?.version],
  );

  const setPreviewOpenPersisted = useCallback(
    (open: boolean) => {
      setPreviewOpen(open);
      persistPreviewState({
        open,
        file: previewFile,
        history: previewHistory,
        index: previewHistoryIndex,
      });
    },
    [persistPreviewState, previewFile, previewHistory, previewHistoryIndex],
  );

  // ---------------------------------------------------------------------------
  // Vercel AI SDK useChat hook
  // Manages message state + streaming connection to /api/chat
  // ---------------------------------------------------------------------------
  // Build a TRIMMED request body on every send. The default behaviour
  // (`sendExtraMessageFields`) serializes the entire message objects —
  // including `trace_json`, which snapshots the whole conversation at every
  // agent step and can reach tens of MB for a long session. That turned a
  // "hi" follow-up into a 15MB+ POST that crashed the browser and made the
  // server's `request.json()` reject with a 400 "Invalid request body". The
  // server only needs id/role/content/toolInvocations (+ tool_calls_json for
  // from-DB messages), so `buildChatRequestBody` drops everything else.
  // Recreated only when the session/agent/model change so `append` stays
  // referentially stable between turns.
  const prepareChatRequestBody = useCallback(
    (options: { id: string; messages: Parameters<typeof buildChatRequestBody>[0]['messages']; requestBody?: object }) =>
      buildChatRequestBody({
        id: options.id,
        messages: options.messages,
        requestBody: options.requestBody,
        sessionId,
        agentName,
        modelId,
      }),
    [sessionId, agentName, modelId],
  );

  const {
    messages,
    append,
    isLoading,
    stop,
    setMessages,
    error: chatError,
    data: streamData,
  } = useChat({
    api: '/api/chat',
    // `prepareChatRequestBody` builds a minimal wire payload (id/role/content/
    // toolInvocations + the per-call body) so the multi-MB UI-only fields
    // (trace_json, parts, reasoning, …) never reach /api/chat. It also
    // forwards each message id so the server persists user messages under the
    // same id the client renders (otherwise the DB row gets a fresh UUID that
    // arrives back as a "new" message → duplicated user bubble).
    experimental_prepareRequestBody: prepareChatRequestBody,
    onFinish: () => {
      // Notify sidebar to refresh session list (title may have changed)
      window.dispatchEvent(new Event('sessions-changed'));
      // If this is the first response at /chat (no id in URL), update the URL
      // to /chat/<sessionId> using history.replaceState instead of router.replace
      // so the component is NOT remounted (avoiding the flash).
      if (pathname === '/chat' && sessionId) {
        window.history.replaceState(null, '', '/chat/' + sessionId);
        // Notify the persistent layout sidebar of the new active session
        window.dispatchEvent(new CustomEvent('session-active', { detail: { id: sessionId } }));
      }
    },
    onError: (err) => {
      console.error('Chat error:', err);
    },
  });

  // When isLoading transitions true → false the stream has just completed.
  // Scan the streamData array for token_usage and agent_trace entries and
  // attach them to the last assistant message so badges render immediately.
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = isLoading;

    if (!wasLoading || isLoading) return; // only act on the true→false edge

    if (!streamData?.length) return;
    let tokenUsage: { input: number; cached: number; output: number; source?: unknown } | null =
      null;
    let traceData: unknown[] | null = null;
    // Structured-output agents stream the finalize-call request payload and
    // the parsed JSON result as `data` events. The Vercel SDK aggregates
    // these into the global `streamData` array but does NOT auto-attach
    // them to the per-message `msg.data` field, so MessageBubble (which
    // reads `msg.data` via the `data` prop) wouldn't see them. We harvest
    // both here and attach to the last assistant message — mirroring the
    // token_usage / agent_trace harvest below.
    //
    // NOTE: `skills_activated` is intentionally NOT harvested here. Skills
    // are also persisted as `skills-activated` parts in `parts_json`, and
    // the persisted-parts render path places them at the TOP of the message
    // (the chronologically correct position — they're discovered before any
    // tool call fires). If we harvested skills into msg.data too, the
    // live-data fallback in MessageBubble would render a duplicate at the
    // BOTTOM of the message. Skills wait for the persistence round-trip.
    let finalizeCall: { schemaLabel?: string; payload: unknown } | null = null;
    let structuredOutput: { data: unknown; schemaName: string; schemaLabel: string } | null = null;
    for (let i = streamData.length - 1; i >= 0; i--) {
      const d = streamData[i];
      try {
        const parsed = (typeof d === 'string' ? JSON.parse(d) : d) as Record<string, unknown>;
        if (parsed?.type === 'token_usage' && !tokenUsage) {
          tokenUsage = {
            input: (parsed.input as number) ?? 0,
            cached: (parsed.cached as number) ?? 0,
            output: (parsed.output as number) ?? 0,
            source: parsed.source,
          };
        }
        if (parsed?.type === 'agent_trace' && !traceData) {
          traceData = parsed.trace as unknown[];
        }
        if (parsed?.type === 'finalize_call' && !finalizeCall) {
          finalizeCall = {
            schemaLabel: parsed.schemaLabel as string | undefined,
            payload: parsed.payload,
          };
        }
        if (parsed?.type === 'structured_output' && !structuredOutput) {
          structuredOutput = {
            data: parsed.data,
            schemaName: parsed.schemaName as string,
            schemaLabel: parsed.schemaLabel as string,
          };
        }
      } catch {
        /* skip malformed entries */
      }
    }
    if (!tokenUsage && !traceData && !finalizeCall && !structuredOutput) return;
    setMessages((prev) => {
      const updated = [...prev];
      for (let j = updated.length - 1; j >= 0; j--) {
        if (updated[j].role === 'assistant') {
          const newMsg = { ...updated[j] };
          if (tokenUsage) {
            (newMsg as unknown as { token_usage_json: string }).token_usage_json =
              JSON.stringify(tokenUsage);
          }
          if (traceData) {
            (newMsg as unknown as { trace_json: string }).trace_json = JSON.stringify(traceData);
            (newMsg as unknown as { hasTrace: boolean }).hasTrace = true;
          }
          // Push our custom data events onto msg.data so MessageBubble's
          // `soFromData` / `finalizeFromData` selectors (which scan
          // msg.data, not streamData) can see them.
          if (finalizeCall || structuredOutput) {
            const existing = ((newMsg as unknown as { data?: unknown[] }).data ?? []).slice();
            if (
              finalizeCall &&
              !existing.some((d) => (d as Record<string, unknown>)?.type === 'finalize_call')
            ) {
              existing.push({ type: 'finalize_call', ...finalizeCall });
            }
            if (
              structuredOutput &&
              !existing.some((d) => (d as Record<string, unknown>)?.type === 'structured_output')
            ) {
              existing.push({ type: 'structured_output', ...structuredOutput });
            }
            (newMsg as unknown as { data: unknown[] }).data = existing;
          }
          updated[j] = newMsg;
          break;
        }
      }
      return updated;
    });
  }, [isLoading, streamData, setMessages]);

  // ── mergeServerUpdates ─────────────────────────────────────────────────
  // Pulls just-the-deltas from /api/messages and merges them into the
  // current window without re-downloading the entire history.
  //
  //   1. `after=<maxRowid>` – returns rows that landed AFTER the most
  //      recent persisted row we know about (sub-agent notifications,
  //      checkpoint upserts after a connection drop, etc).
  //   2. A small head-page request – grabs synthetic notification rows
  //      AND lets us refresh the most recent message's parts/trace/token
  //      payload, since the agent loop overwrites that row in place.
  //
  // Both responses are merged into `messages` by id; new ids are appended,
  // existing ids are updated in place. The visible "older history"
  // window is never disturbed.
  const mergeServerUpdates = useCallback(
    async (sid: string) => {
      if (!sid) return;
      const maxRowid = (() => {
        let m = 0;
        for (const v of messageRowidsRef.current.values()) if (v > m) m = v;
        return m;
      })();

      const requests: Array<Promise<MessagesPage | null>> = [];
      if (maxRowid > 0) {
        requests.push(
          fetch(`/api/messages?sessionId=${sid}&after=${maxRowid}&pending=0`)
            .then((r) => (r.ok ? (r.json() as Promise<MessagesPage>) : null))
            .catch(() => null),
        );
      } else {
        requests.push(Promise.resolve(null));
      }
      // Small head-page so we can pick up: (a) sub-agent notification rows,
      // (b) checkpoint updates to the most recent assistant message. Limit
      // matches the initial page so the wire footprint stays predictable.
      requests.push(
        fetch(`/api/messages?sessionId=${sid}&limit=${INITIAL_PAGE_SIZE}`)
          .then((r) => (r.ok ? (r.json() as Promise<MessagesPage>) : null))
          .catch(() => null),
      );

      const [afterPage, headPage] = await Promise.all(requests);

      // Aggregate every row we just learned about. The order doesn't matter
      // because we merge by id; head-page wins on conflict because it has
      // the freshest checkpoint data.
      const incoming = new Map<string, StoredMessage>();
      for (const row of afterPage?.messages ?? []) incoming.set(row.id, row);
      for (const row of headPage?.messages ?? []) incoming.set(row.id, row);
      if (incoming.size === 0) return;

      // Update the rowid cursor map for any real (non-synthetic) rows so the
      // next merge call narrows the after-cursor query further.
      for (const row of incoming.values()) {
        if (row._rowid && row._rowid > 0) messageRowidsRef.current.set(row.id, row._rowid);
      }

      // Update totalCount + hasMoreOlder when the head-page tells us about it.
      if (headPage) {
        if (typeof headPage.totalCount === 'number') setTotalMessageCount(headPage.totalCount);
        // Only adjust hasMoreOlder when we still have the original cursor
        // unmodified — otherwise "Load earlier" pagination ordering wins.
        if (olderCursor === null && headPage.nextCursor !== null) {
          setOlderCursor(headPage.nextCursor);
          setHasMoreOlder(!!headPage.hasMore);
        }
      }

      setMessages((prev) => {
        const byId = new Map<string, ExtendedMessage>();
        for (const m of prev) byId.set(m.id, m as ExtendedMessage);
        let touched = false;

        for (const [id, row] of incoming) {
          const existing = byId.get(id);
          if (!existing) {
            byId.set(id, toExtendedMessage(row));
            touched = true;
            continue;
          }
          // Don't overwrite a freshly-streamed message that the SDK is still
          // holding live `parts` for. The server may have a stale snapshot.
          const isLiveStreaming =
            isLoading &&
            prev.length > 0 &&
            prev[prev.length - 1].id === id &&
            Array.isArray((existing as { parts?: unknown[] }).parts) &&
            ((existing as { parts?: unknown[] }).parts ?? []).length > 0;
          if (isLiveStreaming) continue;
          // Bail out when none of the persisted-only fields differ. This
          // matters for the 10-second polling effect: without this guard
          // every poll allocates fresh refs for every row in the head page,
          // forcing React.memo on MessageRow to discard its bailout and
          // re-render every visible message twice a minute.
          // Bail out when none of the persisted-only fields differ. This
          // matters for the 10-second polling effect: without this guard
          // every poll allocates fresh refs for every row in the head page,
          // forcing React.memo on MessageRow to discard its bailout and
          // re-render every visible message twice a minute.
          if (storedFieldsEqual(existing, row)) continue;
          // Refresh the persisted fields from the freshest snapshot. Live-only
          // fields (parts, data, toolInvocations, in-memory trace_json) are
          // preserved by applyStoredFields' `...existing` spread — the server
          // snapshot must not clobber the just-streamed trace of the last
          // assistant message.
          const merged = applyStoredFields(existing, row);
          byId.set(id, merged);
          touched = true;
        }
        if (!touched) return prev;

        // Preserve the previous render order; append any brand-new ids at
        // the end (server returns them in chronological order so the head-
        // page tail order matches what we want).
        const out: ExtendedMessage[] = [];
        const seen = new Set<string>();
        for (const m of prev) {
          const next = byId.get(m.id);
          if (next) {
            out.push(next);
            seen.add(m.id);
          }
        }
        // Append rows we hadn't seen before. Respect the server's order:
        // afterPage rows are oldest→newest already, head-page rows are too.
        const newIds: string[] = [];
        for (const row of afterPage?.messages ?? []) {
          if (!seen.has(row.id)) {
            newIds.push(row.id);
            seen.add(row.id);
          }
        }
        for (const row of headPage?.messages ?? []) {
          if (!seen.has(row.id)) {
            newIds.push(row.id);
            seen.add(row.id);
          }
        }
        for (const id of newIds) {
          const m = byId.get(id);
          if (m) out.push(m);
        }
        // useChat types setMessages' callback as `Message[] -> Message[]`,
        // and `ExtendedMessage` is a structural superset of `Message` (the
        // extra string-typed persistence fields are all optional). The cast
        // is needed only because TypeScript treats function-form setStates
        // as invariant in their return type, and our local `UIPart` is a
        // looser union than the SDK's typed parts.
        return out as unknown as UIMessage[];
      });
    },
    [isLoading, olderCursor, setMessages],
  );

  // After every stream completion (whether finished cleanly, errored, or
  // the connection dropped) re-fetch any messages that were appended
  // server-side. The agent loop checkpoints partial state into the DB so
  // even a mid-stream connection drop leaves a usable assistant row with an
  // `incomplete-marker` part in `parts_json`. We use the rowid cursor map
  // to ask only for "rows after the last one we have", and also re-read
  // the head page so the most recent message picks up its final
  // parts_json/trace_json/token_usage payload.
  useEffect(() => {
    const wasLoading = prevLoadingForRefetchRef.current;
    prevLoadingForRefetchRef.current = isLoading;
    if (!wasLoading || isLoading || !sessionId) return;
    // Small delay so the server's onFinish has time to write the final row
    // before we read it back. 600ms is enough for a single SQLite write
    // and short enough that the UI feels responsive.
    const timeoutId = window.setTimeout(() => {
      void mergeServerUpdates(sessionId).catch(() => {});
    }, 600);
    return () => window.clearTimeout(timeoutId);
  }, [isLoading, sessionId, mergeServerUpdates]);

  useEffect(() => {
    if (!sessionId || isLoading) return;
    // While a detached background run is active, poll the DB merge faster so
    // the assistant bubble updates as the loop checkpoints (every step). The
    // normal 10s cadence is fine when idle.
    const intervalMs = backgroundRunning ? 3000 : 10000;
    const timer = window.setInterval(() => {
      void mergeServerUpdates(sessionId).catch(() => {});
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [sessionId, isLoading, backgroundRunning, mergeServerUpdates]);

  // ── Background-run detection ───────────────────────────────────────────
  // After a browser reopen mid-run (or a tab close in the same session), the
  // useChat hook has no live fetch, so `isLoading` is false even though a
  // detached run is still going on the server. We do a one-shot check on
  // mount / session change / stream end (Effect A), and only spin up a
  // continuous poll while a run is actually active (Effect B) so an idle tab
  // doesn't poll forever.
  const checkActive = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`/api/chat/active?sessionId=${sessionId}`);
      if (!res.ok) return;
      const data = (await res.json()) as { active?: boolean };
      setBackgroundRunning(!!data.active);
    } catch {
      /* ignore — transient network error */
    }
  }, [sessionId]);

  // Effect A: one-shot detection on mount / session change / stream end.
  useEffect(() => {
    if (!sessionId) {
      setBackgroundRunning(false);
      return;
    }
    if (isLoading) {
      setBackgroundRunning(false);
      return;
    }
    void checkActive();
  }, [sessionId, isLoading, checkActive]);

  // Effect B: continuous poll ONLY while a background run is active, so we
  // notice when it finishes and stop gating the UI.
  useEffect(() => {
    if (!sessionId || !backgroundRunning) return;
    const timer = window.setInterval(() => {
      void checkActive();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [sessionId, backgroundRunning, checkActive]);

  // Persist agent choice when the user manually changes it
  useEffect(() => {
    if (!sessionId || !userChangedAgentRef.current) return;
    userChangedAgentRef.current = false;
    fetch('/api/sessions', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sessionId, agentName }),
    });
  }, [sessionId, agentName]);

  // ---------------------------------------------------------------------------
  // Load or create session on mount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    initSession();
    fetchAgentNames();
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d) => {
        setExpandByDefault(d.settings?.expand_tool_details !== 'false');
        setShowTokenUsage(d.settings?.show_token_usage !== 'false');
        setShowTrace(d.settings?.show_trace !== 'false');
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch pinned sessions whenever sidebar pin/unpin changes
  useEffect(() => {
    const handler = () => {
      refreshPinnedSessions().catch(() => {});
    };
    window.addEventListener('sessions-changed', handler);
    return () => window.removeEventListener('sessions-changed', handler);
  }, [refreshPinnedSessions]);
  // During initial history restore (isRestoringRef=true) we collect the
  // full preview history but do NOT auto-open the panel.
  useEffect(() => {
    const isRestoring = isRestoringRef.current;
    const newItems: PreviewFile[] = [];

    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;

      // Live streamed parts (useChat)
      const parts = (msg as unknown as { parts?: unknown[] }).parts ?? [];
      for (const part of parts) {
        if (
          typeof part === 'object' &&
          part !== null &&
          (part as Record<string, unknown>).type === 'tool-invocation'
        ) {
          const inv = (part as Record<string, unknown>).toolInvocation as Record<string, unknown>;
          if (
            inv?.toolName === 'open_preview' &&
            inv?.state === 'result' &&
            typeof inv?.toolCallId === 'string'
          ) {
            const key = `live:${inv.toolCallId}`;
            if (!processedPreviewRef.current.has(key)) {
              processedPreviewRef.current.add(key);
              const result = inv.result as Record<string, unknown>;
              if (result?.type === 'open_preview' && typeof result.path === 'string') {
                const item: PreviewFile = {
                  path: result.path as string,
                  sourcePath: result.sourcePath as string | undefined,
                  title: result.title as string | undefined,
                  version: 1,
                };
                newItems.push(item);
              }
            }
          }
        }
      }

      // Historical tool calls (from DB)
      const toolCalls = (() => {
        try {
          const tc = (msg as unknown as { tool_calls_json?: string }).tool_calls_json;
          return tc ? JSON.parse(tc) : [];
        } catch {
          return [];
        }
      })();
      for (const tc of toolCalls) {
        if (tc?.name === 'open_preview' && tc?.result?.type === 'open_preview') {
          const key = `hist:${tc.id ?? tc.name + tc.result.path}`;
          if (!processedPreviewRef.current.has(key)) {
            processedPreviewRef.current.add(key);
            if (typeof tc.result.path === 'string') {
              const item: PreviewFile = {
                path: tc.result.path as string,
                title: tc.result.title as string | undefined,
                sourcePath: tc.result.sourcePath as string | undefined,
                version: 1,
              };
              newItems.push(item);
            }
          }
        }
      }
    }

    if (newItems.length > 0) {
      const restored = isRestoring ? restoredPreviewStateRef.current : null;
      if (restored?.history?.length) {
        const index = Math.max(0, Math.min(restored.index ?? 0, restored.history.length - 1));
        const file = restored.file ?? restored.history[index] ?? null;
        setPreviewHistory(restored.history);
        setPreviewHistoryIndex(index);
        setPreviewFile(file ? { ...file, version: 1 } : null);
        setPreviewOpen(!!restored.open && !!file);
        restoredPreviewStateRef.current = null;
      } else {
        const nextHistory = [...previewHistory, ...newItems];
        const index = nextHistory.length - 1;
        const lastItem = newItems[newItems.length - 1];
        const nextFile = { ...lastItem, version: (previewFile?.version ?? 0) + 1 };
        setPreviewHistory(nextHistory);
        setPreviewHistoryIndex(index);
        if (isRestoring) {
          setPreviewFile(nextFile);
        } else {
          setPreviewFile(nextFile);
          setPreviewOpen(true);
          persistPreviewState({ open: true, file: nextFile, history: nextHistory, index });
        }
      }
    } else if (isRestoring && restoredPreviewStateRef.current?.file) {
      const restored = restoredPreviewStateRef.current;
      const file = restored.file!;
      const history: PreviewFile[] = restored.history?.length ? restored.history : [file];
      const index = Math.max(0, Math.min(restored.index ?? 0, history.length - 1));
      setPreviewHistory(history);
      setPreviewHistoryIndex(index);
      setPreviewFile({ ...file, version: 1 });
      setPreviewOpen(!!restored.open);
      restoredPreviewStateRef.current = null;
    }
    // Clear the restoring flag after this effect run so subsequent live events
    // can auto-open again. Must happen here (not in loadSession) because effects
    // run asynchronously after the render – synchronous clearing would be too early.
    if (isRestoring) {
      isRestoringRef.current = false;
    }
  }, [messages, persistPreviewState, previewFile?.version, previewHistory]);

  const initSession = async () => {
    if (initialSessionId) {
      // Load the session specified by the URL param
      await loadSession(initialSessionId);
    } else {
      // No session ID in URL → start a blank new conversation
      startNewSession();
    }
  };

  // Start a brand-new conversation without creating a DB session yet.
  // The session is created lazily on the server when the first message is sent.
  const startNewSession = useCallback(() => {
    // Detach the previous session's live tail (client fetch only). The detached
    // server run keeps going and checkpoints to its own session row, so starting
    // a new chat mid-inference doesn't leak the old stream into the new view.
    try {
      stop();
    } catch {
      /* no live fetch to abort */
    }
    stickToBottomRef.current = true;
    setSessionId(uuidv4());
    setSessionTitle('New Conversation');
    setMessages([]);
    setHistoryLoaded(true);
    setOlderCursor(null);
    setHasMoreOlder(false);
    setTotalMessageCount(0);
    messageRowidsRef.current = new Map();
    setPreviewOpen(false);
    setPreviewFile(null);
    setPreviewHistory([]);
    setPreviewHistoryIndex(0);
    processedPreviewRef.current = new Set();
    restoredPreviewStateRef.current = null;
    isRestoringRef.current = false;
  }, [setMessages, stop]);

  const loadSession = async (id: string, preloadedTitle?: string, preloadedAgentName?: string) => {
    // Detach the previous session's live tail WITHOUT aborting the server run
    // (so `stop()`, not `handleStop`). The detached loop keeps going and
    // checkpoints to the OLD session's DB row — switching away mid-inference
    // must not leak its tokens into this view, and the result is visible when
    // you switch back (the active-check + merge poll pick it up).
    try {
      stop();
    } catch {
      /* no live fetch to abort */
    }
    stickToBottomRef.current = true;
    setSessionId(id);
    setHistoryLoaded(false);
    setMessages([]);
    setOlderCursor(null);
    setHasMoreOlder(false);
    setTotalMessageCount(0);
    messageRowidsRef.current = new Map();
    // Reset preview state for the incoming session
    setPreviewOpen(false);
    setPreviewFile(null);
    setPreviewHistory([]);
    setPreviewHistoryIndex(0);
    processedPreviewRef.current = new Set();
    restoredPreviewStateRef.current = null;
    // Note: isRestoringRef is set to true just before setMessages(converted) below
    // so that the intermediate setMessages([]) render doesn't accidentally clear it.

    // Load only the most recent INITIAL_PAGE_SIZE messages. Older history is
    // fetched on demand via the "Load earlier" button — this is the single
    // biggest win for chats with hundreds of tool calls, where rendering
    // every historical part_json was crashing the browser.
    const res = await fetch(`/api/messages?sessionId=${id}&limit=${INITIAL_PAGE_SIZE}`);
    const data: MessagesPage = await res.json();
    const stored: StoredMessage[] = data.messages ?? [];

    const sessRes = await fetch('/api/sessions');
    const sessData = await sessRes.json();
    const sess = sessData.sessions?.find(
      (s: { id: string; title: string; preview_state_json?: string }) => s.id === id,
    );
    try {
      restoredPreviewStateRef.current = sess?.preview_state_json
        ? (JSON.parse(sess.preview_state_json) as PreviewState)
        : null;
    } catch {
      restoredPreviewStateRef.current = null;
    }

    const converted = stored.map(toExtendedMessage);
    // Remember every (id → rowid) so the polling and post-stream refetch
    // effects can ask the server for "messages after the most recent one I
    // have" instead of re-downloading the entire history every interval.
    const rowids = new Map<string, number>();
    for (const m of stored) {
      if (m._rowid && m._rowid > 0) rowids.set(m.id, m._rowid);
    }
    messageRowidsRef.current = rowids;
    setOlderCursor(data.nextCursor ?? null);
    setHasMoreOlder(!!data.hasMore);
    setTotalMessageCount(data.totalCount ?? stored.length);
    // Set the flag immediately before delivering the historical messages so
    // the messages effect sees isRestoringRef=true for this exact render.
    // We intentionally do NOT set it earlier: the setMessages([]) call above
    // triggers a render+effect that would clear the flag prematurely.
    isRestoringRef.current = true;
    setMessages(converted as unknown as UIMessage[]);
    setHistoryLoaded(true);

    if (preloadedTitle) {
      // Use the title passed by the caller (avoids an extra /api/sessions round-trip)
      setSessionTitle(preloadedTitle);
    } else if (sess) {
      setSessionTitle(sess.title);
    }

    // Restore the agent that was active for this session
    if (preloadedAgentName) {
      setAgentName(preloadedAgentName);
    }
  };

  // ── Load earlier ─────────────────────────────────────────────────────────
  // Fetches the next OLDER_PAGE_SIZE messages older than the current cursor
  // and prepends them to the visible window. Re-arms the cursor + has-more
  // flags from the server response. No-op while a load is already running
  // or there's nothing older to fetch.
  const loadOlderMessages = useCallback(async () => {
    if (!sessionId || loadingOlder || !hasMoreOlder || olderCursor === null) return;
    setLoadingOlder(true);
    try {
      const url = `/api/messages?sessionId=${sessionId}&limit=${OLDER_PAGE_SIZE}&before=${olderCursor}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data: MessagesPage = await res.json();
      const older = (data.messages ?? []).map(toExtendedMessage);
      // Update the rowid map BEFORE setMessages — the polling effect reads
      // it on every message-list change.
      for (const m of data.messages ?? []) {
        if (m._rowid && m._rowid > 0) {
          messageRowidsRef.current.set(m.id, m._rowid);
        }
      }
      setMessages((prev) => {
        // Dedupe defensively — if the user clicks twice quickly we'd
        // otherwise insert the same window twice.
        const existing = new Set(prev.map((m) => m.id));
        const fresh = older.filter((m) => !existing.has(m.id));
        if (fresh.length === 0) return prev;
        // Same invariance dance as mergeServerUpdates — see comment there.
        return [...fresh, ...prev] as unknown as UIMessage[];
      });
      setOlderCursor(data.nextCursor ?? null);
      setHasMoreOlder(!!data.hasMore);
      if (typeof data.totalCount === 'number') setTotalMessageCount(data.totalCount);
    } finally {
      setLoadingOlder(false);
    }
  }, [sessionId, loadingOlder, hasMoreOlder, olderCursor, setMessages]);

  const fetchAgentNames = async () => {
    const res = await fetch('/api/agents');
    if (res.ok) {
      const data = await res.json();
      setAgentNames(data.agents ?? ['main']);
      // agentConfigs is the richer per-agent metadata (name + preferred model).
      // We cache it so that switching the active agent in the chat header can
      // immediately update the model selector to the agent's preference.
      if (Array.isArray(data.agentConfigs)) {
        const map: Record<string, string | null> = {};
        for (const cfg of data.agentConfigs as Array<{ name: string; model: string | null }>) {
          map[cfg.name] = cfg.model;
        }
        setAgentModels(map);
      }
    }
  };

  // Cache the list of models the configured provider actually exposes so
  // that we can detect "agent prefers model X but X isn't available" and
  // gracefully fall through to the settings default. We piggy-back the
  // /api/settings call here so the agent-switch effect can read the
  // Settings → Default Model value synchronously from state.
  const fetchAvailableModels = useCallback(async () => {
    try {
      const [modelsRes, settingsRes] = await Promise.all([
        fetch('/api/models'),
        fetch('/api/settings'),
      ]);
      if (modelsRes.ok) {
        const data = await modelsRes.json();
        if (Array.isArray(data.models)) {
          setAvailableModels(data.models as string[]);
          const ctx: Record<string, number> = {};
          const out: Record<string, number> = {};
          for (const [id, detail] of Object.entries(
            (data.details ?? {}) as Record<
              string,
              { context_length?: number; max_output_tokens?: number }
            >,
          )) {
            if (typeof detail.context_length === 'number') ctx[id] = detail.context_length;
            if (typeof detail.max_output_tokens === 'number') out[id] = detail.max_output_tokens;
          }
          setModelContextLengths(ctx);
          setModelOutputLengths(out);
        }
      }
      if (settingsRes.ok) {
        const data = await settingsRes.json();
        setSettingsDefaultModel((data.settings?.default_model as string) ?? '');
      }
    } catch {
      // Provider may be unreachable on first paint — selector will retry.
    }
  }, []);

  useEffect(() => {
    fetchAvailableModels();
  }, [fetchAvailableModels]);

  // ── Auto-switch the model selector when the active agent changes ─────────
  // When the user picks a different agent in the chat header, snap the
  // model selector to the agent's preferred model from agent.md. Falls
  // through to the Settings → Default Model when the agent omits **Model:**
  // (or sets it to `default`) OR when the named model doesn't appear in
  // the provider's /v1/models list.
  //
  // We push a concrete model ID into `modelId` for two reasons:
  //   1) ModelSelector is a controlled component — leaving `value=""` shows
  //      a blank in the dropdown. The user wants to see WHICH model will
  //      be used, not "default".
  //   2) The chat-request body sends `modelId` straight through to the
  //      backend resolver, so a concrete value here removes one round-trip
  //      worth of ambiguity.
  useEffect(() => {
    // Wait until we know what the available models and the settings default
    // are. Until then, leave `modelId` alone so the initial ModelSelector
    // bootstrap (which seeds the value on mount) isn't fighting us.
    if (availableModels.length === 0) return;

    const preferred = agentModels[agentName];
    const fallback =
      settingsDefaultModel && availableModels.includes(settingsDefaultModel)
        ? settingsDefaultModel
        : (availableModels[0] ?? '');

    if (!preferred) {
      // Agent doesn't pin a model (or said `default`) — show the settings default.
      setModelId(fallback);
      return;
    }
    if (availableModels.includes(preferred)) {
      setModelId(preferred);
      return;
    }
    // Agent asked for a model the provider doesn't have. Fall back to the
    // settings default and warn so the operator notices the stale agent.md entry.
    console.warn(
      `Agent "${agentName}" specifies model "${preferred}" which is not ` +
        `available on the configured endpoint. Falling back to "${fallback || '<none>'}".`,
    );
    setModelId(fallback);
  }, [agentName, agentModels, availableModels, settingsDefaultModel]);

  // ---------------------------------------------------------------------------
  // Auto-scroll to bottom — robust, single-source-of-truth design.
  // ---------------------------------------------------------------------------
  //
  // Why this code looks different from the usual "scroll-on-message-change"
  // pattern: the previous design tried to track user intent via raw scroll
  // deltas, which is *fundamentally unreliable* during streaming because the
  // browser's built-in scroll-anchoring (CSSWG `overflow-anchor`) shifts
  // scrollTop by a few pixels every time content grows above or at the
  // viewport bottom. That tiny shift fires a "scroll up" event indistinguish-
  // able from a real user scroll, flips the auto-scroll-paused flag, and
  // every subsequent token quietly fails to scroll. Result: the user sees a
  // chat that won't follow new content — exactly the bug we kept "fixing".
  //
  // The fix has three pillars:
  //
  //   1. SENTINEL-BASED "AT BOTTOM" DETECTION
  //      An IntersectionObserver watches a 1px sentinel at the end of the
  //      messages list. The observer fires only when the sentinel actually
  //      enters/leaves the visible scrollport — completely immune to scroll-
  //      anchoring jitter.
  //
  //   2. STICK-TO-BOTTOM MODE
  //      A single ref `stickToBottomRef` says "should incoming content pin
  //      the view to the bottom?". It starts true, flips false ONLY on a
  //      clear upward gesture (wheel deltaY < -10 or touch drag down > 10px),
  //      and flips back true the moment the sentinel is visible again.
  //
  //   3. MUTATIONOBSERVER PINS DURING STREAMING
  //      A MutationObserver on the messages content container directly sets
  //      `scrollTop = scrollHeight` *synchronously* for every DOM change
  //      while in stick-to-bottom mode. No rAF debouncing, no React effect
  //      lag — the pin happens in the same microtask as the mutation, so
  //      tokens never have a chance to push the view past the viewport.
  //
  // Net result: auto-scroll works for typed messages, suggestion clicks,
  // streaming tokens, structured-output bubbles, tool-call expansions, and
  // image attachments — without depending on any of the fragile heuristics
  // we kept patching.

  /** Sentinel placed after the last message; observer key for "at bottom". */
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  /** rAF coalescing handle for pinToBottom — one pin per frame, max. */
  const pendingPinRef = useRef<number | null>(null);

  /**
   * Imperatively pin the scrollport to the bottom. Coalesced to one
   * `requestAnimationFrame` per frame so a burst of MutationObserver
   * callbacks (streaming tokens, multiple subtree mutations per microtask)
   * collapses into a single forced reflow instead of N. The rAF callback
   * re-reads `scrollHeight` at flush time, so it can never go stale.
   */
  const pinToBottom = useCallback(() => {
    if (pendingPinRef.current !== null) return;
    pendingPinRef.current = requestAnimationFrame(() => {
      pendingPinRef.current = null;
      const c = scrollContainerRef.current;
      if (!c) return;
      c.scrollTop = c.scrollHeight;
    });
  }, []);

  // Cancel any pending pin on unmount so we don't leak a frame after the
  // component is gone.
  useEffect(
    () => () => {
      if (pendingPinRef.current !== null) {
        cancelAnimationFrame(pendingPinRef.current);
        pendingPinRef.current = null;
      }
    },
    [],
  );

  // ── Sentinel observer: keeps `stickToBottomRef` and the scroll button
  //    button state in lock-step with whether the bottom is actually visible.
  useEffect(() => {
    const container = scrollContainerRef.current;
    const anchor = scrollAnchorRef.current;
    if (!container || !anchor) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const atBottom = entry.isIntersecting;
        if (atBottom) {
          // Re-entered the bottom — resume sticking and hide the button.
          stickToBottomRef.current = true;
          setShowScrollButton(false);
        } else {
          // Left the bottom — only show the scroll button. We do NOT flip
          // `stickToBottomRef` here, because content growth itself can
          // momentarily push the sentinel out of view; the explicit user
          // gesture handler below is the only place that turns sticking off.
          setShowScrollButton(true);
        }
      },
      // 0 threshold + small rootMargin handles sub-pixel rounding so the
      // sentinel is considered "visible" as soon as it enters the bottom
      // edge. The 64px bottom margin covers the floating ChatInput shadow.
      { root: container, rootMargin: '0px 0px 64px 0px', threshold: 0 },
    );
    observer.observe(anchor);
    return () => observer.disconnect();
  }, []);

  // ── User-gesture detection: a clear upward intent turns OFF sticking.
  //    We only react to *meaningful* movement (wheel deltaY < -10, touch
  //    drag down > 10px) so that scroll-anchoring jitter (typically <5px)
  //    cannot trip us. We never set sticking back to true here — the
  //    sentinel observer above does that, exactly when the user reaches
  //    the bottom again.
  //
  //    Keyboard scroll keys are deliberately NOT handled: ChatInput owns
  //    page focus during typing, so the container almost never receives
  //    keydown events. Wheel + touch already cover real-world intent.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < -10) stickToBottomRef.current = false;
    };

    let touchStartY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? null;
      if (touchStartY !== null && y !== null && y - touchStartY > 10) {
        stickToBottomRef.current = false;
        touchStartY = y; // reset so a continued drag re-arms the threshold
      }
    };

    container.addEventListener('wheel', onWheel, { passive: true });
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
    };
  }, []);

  // ── MutationObserver pins during streaming. Any DOM mutation under the
  //    messages container while sticking → scrollTop = scrollHeight,
  //    synchronously, in the same microtask as the mutation. This is what
  //    makes streaming tokens reliably stay pinned without rAF lag.
  useEffect(() => {
    const content = messagesContentRef.current;
    if (!content) return;

    const pinIfSticking = () => {
      if (stickToBottomRef.current) pinToBottom();
    };

    const observer = new MutationObserver(pinIfSticking);
    observer.observe(content, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Image loads grow the content after the MutationObserver has already
    // fired (img element exists, but height arrives later). Catch them.
    const onLoadCapture = (e: Event) => {
      if ((e.target as HTMLElement | null)?.tagName === 'IMG') pinIfSticking();
    };
    content.addEventListener('load', onLoadCapture, true);

    return () => {
      observer.disconnect();
      content.removeEventListener('load', onLoadCapture, true);
    };
  }, [pinToBottom]);

  // ── React-driven scroll on message-list changes. This is a fallback for
  //    cases where the MutationObserver hasn't attached yet (first render)
  //    or where the message identity changed without a DOM mutation we
  //    can't otherwise observe (e.g. session swap clearing then refilling).
  //    Always force pin on a brand-new user message to override anything.
  const prevMessageCountRef = useRef(0);
  useEffect(() => {
    const prevCount = prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;

    const lastRole = messages[messages.length - 1]?.role;
    const newUserMessage = messages.length > prevCount && lastRole === 'user';

    if (newUserMessage) {
      // User just submitted — always pin and re-arm sticking, even if the
      // user had previously scrolled up. Their explicit "send" is intent
      // to follow the new turn.
      stickToBottomRef.current = true;
      pinToBottom();
      return;
    }

    if (stickToBottomRef.current) {
      pinToBottom();
    }
  }, [messages, pinToBottom]);

  // Public helper used by the floating "scroll to bottom" button.
  const scrollToBottom = useCallback(() => {
    stickToBottomRef.current = true;
    setShowScrollButton(false);
    pinToBottom();
  }, [pinToBottom]);

  // ---------------------------------------------------------------------------
  // Stop the active generation
  // ---------------------------------------------------------------------------
  // `stop` (from useChat) only kills the local fetch — which, now that the
  // loop runs detached, would merely detach the browser tail and leave the
  // run going in the background. So we ALSO POST /api/chat/stop to abort the
  // server-side run. Works both for a live stream (isLoading) and for a
  // background run reopened in a new tab (backgroundRunning).
  const handleStop = useCallback(() => {
    try {
      stop();
    } catch {
      /* no live fetch to abort */
    }
    if (sessionId) {
      fetch('/api/chat/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).catch(() => {});
    }
  }, [sessionId, stop]);

  // ---------------------------------------------------------------------------
  // Handle sending a message
  // ---------------------------------------------------------------------------
  const handleSend = useCallback(
    async (text: string, attachments: Attachment[]) => {
      if (!text && attachments.length === 0) return;
      if (!sessionId) return;

      setPendingAttachments(attachments);
      // Re-arm sticking and pin immediately. The MutationObserver + the
      // message-list effect will keep us pinned through the entire turn.
      stickToBottomRef.current = true;
      setShowScrollButton(false);
      scrollToBottom();

      // Append message via useChat (triggers streaming request)
      try {
        await append(
          { role: 'user', content: text },
          {
            body: {
              sessionId,
              agentName,
              modelId: modelId || undefined,
              attachments,
            },
          },
        );
      } catch (err) {
        console.error('append error:', err);
      }

      setPendingAttachments([]);
      window.dispatchEvent(new Event('sessions-changed'));
    },
    [sessionId, agentName, modelId, append, scrollToBottom],
  );

  // Listen for session-renamed events dispatched by the persistent layout sidebar
  useEffect(() => {
    const handler = (e: Event) => {
      const { id, title } = (e as CustomEvent<{ id: string; title: string }>).detail;
      if (id === sessionId) setSessionTitle(title);
    };
    window.addEventListener('session-renamed', handler);
    return () => window.removeEventListener('session-renamed', handler);
  }, [sessionId]);

  // Reset to a blank conversation when the layout's "New Chat" button is clicked
  // while we're already on a /chat route (router.push would be a no-op in that case).
  useEffect(() => {
    const handler = () => {
      startNewSession();
    };
    window.addEventListener('new-chat-requested', handler);
    return () => window.removeEventListener('new-chat-requested', handler);
  }, [startNewSession]);

  // Switch to a specific session when the layout's sidebar requests it while
  // we're already on a /chat route. The layout uses history.replaceState
  // to keep the URL in sync without unmounting this component (avoiding the
  // route-change flash), and we load the requested session in place.
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail.id;
      if (id && id !== sessionId) loadSession(id);
    };
    window.addEventListener('load-session-requested', handler);
    return () => window.removeEventListener('load-session-requested', handler);
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Deferred message list: lets React prioritise user interactions (scrolling,
  // button clicks) over the expensive message-list re-renders that occur on
  // every streaming token.  React will coalesce rapid updates and skip
  // intermediate renders when the main thread is busy.
  const displayMessages = useDeferredValue(messages);

  // Stable contextLength so React.memo comparisons on MessageRow stay equal
  // when neither the model nor the fetched lengths have changed.
  const contextLength = useMemo(
    () => getContextLength(modelId, modelContextLengths),
    [modelId, modelContextLengths],
  );
  const outputLength = useMemo(
    () => getOutputLength(modelId, modelOutputLengths),
    [modelId, modelOutputLengths],
  );

  // Stable approval callbacks so React.memo on MessageRow can bail out for
  // all previous messages (inline arrow functions create new references every
  // render and would defeat memoisation).
  const handleApprovalGranted = useCallback(
    async (_invocation: LiveToolInvocation, scope: 'once' | 'session' | 'permanent') => {
      void _invocation;
      await append({
        role: 'user',
        content: `I approved the operation (scope: ${scope}). Please proceed.`,
      });
    },
    [append],
  );

  const handleApprovalDenied = useCallback(async () => {
    await append({
      role: 'user',
      content: 'I denied the operation. Please do not proceed with it.',
    });
  }, [append]);

  // Continue / resume after an incomplete assistant message.
  // Sends a hidden user turn marked with `resumeFrom: true` so the server
  // rewrites the prompt as a "continue from where you left off" instruction
  // instead of treating the literal word "continue" as a new request.
  // The persisted user message in the chat history is shown as "[Continue]"
  // — see /api/chat for the server-side handling.
  const handleContinue = useCallback(async () => {
    if (!sessionId) return;
    stickToBottomRef.current = true;
    setShowScrollButton(false);
    scrollToBottom();
    try {
      await append(
        { role: 'user', content: '[Continue]' },
        {
          body: {
            sessionId,
            agentName,
            modelId: modelId || undefined,
            resumeFrom: true,
          },
        },
      );
    } catch (err) {
      console.error('continue error:', err);
    }
  }, [sessionId, agentName, modelId, append]); // eslint-disable-line react-hooks/exhaustive-deps

  const isEmpty = messages.length === 0 && historyLoaded && !isLoading;

  return (
    <>
      {newChatContextMenu &&
        (() => {
          const s = pinnedSessions.find((s) => s.id === newChatContextMenu.id);
          if (!s) return null;
          return (
            <>
              <div
                className="fixed inset-0 z-40 bg-black/10"
                onClick={() => setNewChatContextMenu(null)}
              />
              <div
                className="fixed z-50 min-w-[220px] rounded-xl border border-gray-200 bg-white py-1 shadow-xl dark:border-gray-700 dark:bg-gray-800"
                style={{ left: newChatContextMenu.x, top: newChatContextMenu.y }}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 text-left"
                  onClick={() => {
                    setNewChatContextMenu(null);
                    patchPinnedSession(s.id, { pinChat: !s.pinned_chat });
                  }}
                >
                  {s.pinned_chat ? <PinOff size={15} /> : <Pin size={15} />}
                  {s.pinned_chat ? 'Unpin Chat' : 'Pin Chat'}
                </button>
                <button
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 text-left"
                  onClick={() => {
                    setNewChatContextMenu(null);
                    patchPinnedSession(s.id, { pinPrompt: !s.pinned_prompt });
                  }}
                >
                  {s.pinned_prompt ? <BookmarkX size={15} /> : <Bookmark size={15} />}
                  {s.pinned_prompt ? 'Unpin Prompt' : 'Pin Prompt'}
                </button>
                <button
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 text-left"
                  onClick={() => {
                    setNewChatContextMenu(null);
                    router.push(`/chat/${s.id}`);
                  }}
                >
                  <Pencil size={15} />
                  Edit
                </button>
                <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
                <button
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 text-left"
                  onClick={() => {
                    setNewChatContextMenu(null);
                    deletePinnedSession(s.id);
                  }}
                >
                  <Trash2 size={15} />
                  Delete
                </button>
              </div>
            </>
          );
        })()}

      {/* Main chat area
          On mobile, hidden when preview is open so only one panel shows at a time */}
      <main
        className={`flex-1 flex-col overflow-hidden min-w-0 ${
          previewOpen && previewFile ? 'hidden md:flex' : 'flex'
        }`}
      >
        {/* Top bar
            Desktop: single row – title on the left, agent + model selectors on the right.
            Mobile:  two rows – title row (with pl-16 to clear the hamburger button) +
                     compact selector row below. */}
        <header
          className="flex-shrink-0 border-b border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          {/* Row 1 – title */}
          <div className="flex items-center justify-between pl-16 pr-3 md:px-6 py-2.5 md:py-3">
            <h1 className="font-700 text-gray-900 dark:text-gray-100 text-base truncate">
              {sessionTitle}
            </h1>

            <div className="flex items-center gap-2">
              {/* Preview toggle / history navigator */}
              {previewFile &&
                (previewHistory.length > 1 ? (
                  /* Multi-preview nav bar */
                  <div className="flex items-center gap-0.5">
                    <button
                      disabled={previewHistoryIndex === 0}
                      onClick={() => {
                        const idx = previewHistoryIndex - 1;
                        selectPreview(previewHistory[idx], previewHistory, idx, true);
                      }}
                      title="Previous preview"
                      className="h-9 w-8 flex items-center justify-center rounded-l-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 hover:text-blue-600 dark:hover:text-blue-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <button
                      onClick={() => setPreviewOpenPersisted(!previewOpen)}
                      title={previewOpen ? 'Hide preview' : 'Open preview'}
                      className={`h-9 flex items-center gap-1.5 px-2.5 text-sm font-medium transition-colors ${
                        previewOpen
                          ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/60'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                      }`}
                    >
                      {previewOpen ? <PanelRightClose size={15} /> : <PanelRight size={15} />}
                      <span className="hidden sm:inline text-sm whitespace-nowrap">
                        {previewHistoryIndex + 1} / {previewHistory.length}
                      </span>
                    </button>
                    <button
                      disabled={previewHistoryIndex === previewHistory.length - 1}
                      onClick={() => {
                        const idx = previewHistoryIndex + 1;
                        selectPreview(previewHistory[idx], previewHistory, idx, true);
                      }}
                      title="Next preview"
                      className="h-9 w-8 flex items-center justify-center rounded-r-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 hover:text-blue-600 dark:hover:text-blue-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                ) : (
                  /* Single preview toggle */
                  <button
                    onClick={() => setPreviewOpenPersisted(!previewOpen)}
                    title={previewOpen ? 'Hide preview' : 'Reopen preview'}
                    className={`h-9 flex items-center gap-1.5 px-3 rounded-lg text-sm font-medium transition-colors ${
                      previewOpen
                        ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/60'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                    }`}
                  >
                    {previewOpen ? <PanelRightClose size={15} /> : <PanelRight size={15} />}
                    <span className="hidden sm:inline text-sm">
                      {previewOpen ? 'Hide' : 'Preview'}
                    </span>
                  </button>
                ))}

              {/* Desktop-only selectors (hidden on mobile, shown in row 2 instead) */}
              <div className="hidden md:flex items-center gap-3">
                {/* System prompt viewer */}
                <button
                  onClick={() => setSystemPromptOpen(true)}
                  title="View system prompt"
                  className="h-9 w-9 flex items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-violet-100 dark:hover:bg-violet-900/40 hover:text-violet-600 dark:hover:text-violet-300 transition-colors"
                >
                  <Brain size={15} />
                </button>
                {/* Agent selector */}
                <CustomDropDown
                  models={agentNames}
                  value={agentName}
                  onChange={(n) => {
                    userChangedAgentRef.current = true;
                    setAgentName(n);
                  }}
                  placeholder="Select an agent…"
                  searchPlaceholder="Search agents…"
                  noun={{ singular: 'agent', plural: 'agents' }}
                  icon={<Bot size={14} />}
                  allowFreeText={false}
                />

                {/* Model selector */}
                <ModelSelector value={modelId} onChange={setModelId} />
              </div>
            </div>
          </div>

          {/* Row 2 – compact selectors, mobile only */}
          <div className="flex md:hidden items-center gap-2 pl-16 pr-3 pb-2.5">
            <button
              onClick={() => setSystemPromptOpen(true)}
              title="View system prompt"
              className="hidden sm:flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 hover:bg-violet-100 dark:hover:bg-violet-900/40 hover:text-violet-600 dark:hover:text-violet-300 transition-colors flex-shrink-0"
            >
              <Brain size={14} />
            </button>
            {/* Agent selector – compact */}
            <CustomDropDown
              models={agentNames}
              value={agentName}
              onChange={(n) => {
                userChangedAgentRef.current = true;
                setAgentName(n);
              }}
              placeholder="Select an agent…"
              searchPlaceholder="Search agents…"
              noun={{ singular: 'agent', plural: 'agents' }}
              icon={<Bot size={14} />}
              allowFreeText={false}
              compact
              className="flex-1"
            />

            {/* Model selector – compact, fills remaining space */}
            <ModelSelector value={modelId} onChange={setModelId} compact className="flex-1" />
          </div>
        </header>

        {/* Messages area */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto overflow-x-hidden px-4 pt-6 bg-white dark:bg-gray-950 [overflow-anchor:none]"
        >
          {/* Empty state */}
          {isEmpty && (
            <div className="flex flex-col items-center justify-center h-full text-center max-w-2xl mx-auto">
              <BrandLogo className="h-20 w-20 mb-3" priority />
              <h2 className="text-2xl font-800 text-gray-900 dark:text-gray-100 tracking-tight mb-2">
                Start a conversation
              </h2>
              <p className="text-gray-500 dark:text-gray-300 text-sm leading-relaxed">
                Ask anything. The agent can use skills and MCP tools, remember important
                information, and delegate to specialized sub-agents.
              </p>

              {/* Sections rendered in user-configured order */}
              {newChatSectionOrder.map((section) => {
                if (section === 'suggestions' && newChatShowSuggestions) {
                  return (
                    <div key="suggestions" className="mt-6 w-full text-left">
                      <p className="text-sm font-600 text-gray-500 dark:text-gray-300 tracking-wider mb-3">
                        Suggested Prompts
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full">
                        {suggestions.map((suggestion, idx) => (
                          <button
                            key={suggestion}
                            onClick={() => handleSend(suggestion, [])}
                            className={`cursor-pointer text-left px-4 py-3 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-xl text-sm text-gray-600 dark:text-gray-300 font-medium transition-all duration-150 hover:scale-[1.02]${idx >= 4 ? ' hidden sm:block' : ''}`}
                          >
                            <MessageSquare size={15} className="inline mr-2 opacity-50" />
                            {suggestion}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                }
                if (
                  section === 'pinned_chat' &&
                  newChatShowPinnedChat &&
                  pinnedSessions.some((s) => s.pinned_chat)
                ) {
                  return (
                    <div key="pinned_chat" className="mt-6 w-full text-left">
                      <p className="text-sm font-600 text-gray-500 dark:text-gray-300 tracking-wider mb-3">
                        Pinned Chats
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {pinnedSessions
                          .filter((s) => s.pinned_chat)
                          .map((s) => (
                            <div
                              key={s.id}
                              className="relative flex items-center gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 transition-colors group cursor-pointer"
                            >
                              <button
                                className="cursor-pointer flex-1 text-left text-sm font-medium text-gray-700 dark:text-gray-200 truncate"
                                onClick={() => {
                                  window.history.pushState(null, '', `/chat/${s.id}`);
                                  window.dispatchEvent(
                                    new CustomEvent('session-active', { detail: { id: s.id } }),
                                  );
                                  loadSession(s.id, s.title, s.agent_name);
                                }}
                              >
                                <Pin size={15} className="inline mr-2 opacity-50" />
                                {s.title}
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const pos = getActionMenuPosition(
                                    e.currentTarget.getBoundingClientRect(),
                                  );
                                  setNewChatContextMenu({
                                    id: s.id,
                                    mode: 'chat',
                                    x: pos.x,
                                    y: pos.y,
                                  });
                                }}
                                title="Chat actions"
                                aria-label="Chat actions"
                                className="cursor-pointer p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-all flex-shrink-0"
                              >
                                <MoreHorizontal size={17} />
                              </button>
                            </div>
                          ))}
                      </div>
                    </div>
                  );
                }
                if (section === 'pinned_prompt' && newChatShowPinnedPrompt) {
                  const promptSessions = pinnedSessions.filter((s) => s.pinned_prompt);
                  if (promptSessions.length === 0) return null;
                  return (
                    <div key="pinned_prompt" className="mt-6 w-full text-left">
                      <p className="text-sm font-600 text-gray-500 dark:text-gray-300 tracking-wider mb-3">
                        Pinned Prompts
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {promptSessions.map((s) => (
                          <div
                            key={s.id}
                            className="relative flex items-center gap-3 px-4 py-3 bg-blue-50 dark:bg-blue-950/30 rounded-xl border border-blue-200 dark:border-blue-800 hover:border-blue-400 dark:hover:border-blue-600 transition-colors group cursor-pointer"
                          >
                            <button
                              className="cursor-pointer flex-1 text-left text-sm text-gray-700 dark:text-gray-200 line-clamp-2"
                              onClick={() => handleSend(s.pinned_prompt!, [])}
                            >
                              <MessageSquare
                                size={15}
                                className="inline mr-2 opacity-50 flex-shrink-0"
                              />
                              {s.pinned_prompt}
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                const pos = getActionMenuPosition(
                                  e.currentTarget.getBoundingClientRect(),
                                );
                                setNewChatContextMenu({
                                  id: s.id,
                                  mode: 'prompt',
                                  x: pos.x,
                                  y: pos.y,
                                });
                              }}
                              title="Prompt actions"
                              aria-label="Prompt actions"
                              className="cursor-pointer p-1 rounded hover:bg-blue-200 dark:hover:bg-blue-800 text-blue-400 hover:text-blue-700 dark:hover:text-blue-200 transition-all flex-shrink-0"
                            >
                              <MoreHorizontal size={17} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                }
                return null;
              })}
            </div>
          )}

          {/* Error banner */}
          {chatError && (
            <div className="max-w-3xl mx-auto mb-4">
              <div className="flex items-start gap-3 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
                <span className="font-semibold flex-shrink-0">Error:</span>
                <span className="break-all">{chatError.message}</span>
              </div>
            </div>
          )}

          {/* Message list */}
          <div ref={messagesContentRef} className="max-w-3xl mx-auto space-y-6 pb-16">
            {/* "Load earlier" affordance — visible only when the session has
                more historical messages than the initial page contained. We
                stop the click from re-arming stick-to-bottom because the
                user is reading older history; the page anchor is preserved
                by the browser's native scroll-anchoring on prepended nodes. */}
            {hasMoreOlder && historyLoaded && messages.length > 0 && (
              <div className="flex justify-center pt-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    stickToBottomRef.current = false;
                    void loadOlderMessages();
                  }}
                  disabled={loadingOlder}
                  className="px-3 py-1.5 rounded-full text-sm font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-blue-100 dark:hover:bg-blue-900/40 hover:text-blue-700 dark:hover:text-blue-200 disabled:opacity-50 transition-colors"
                  title={`${totalMessageCount - messages.length} older messages available`}
                >
                  {loadingOlder
                    ? 'Loading earlier messages…'
                    : `Load earlier messages${totalMessageCount > messages.length ? ` (${totalMessageCount - messages.length} more)` : ''}`}
                </button>
              </div>
            )}
            {displayMessages.map((msg, i) => (
              <MessageRow
                key={msg.id}
                msg={msg as unknown as ExtendedMessage}
                isLast={i === displayMessages.length - 1}
                isLoading={isLoading}
                sessionId={sessionId}
                expandByDefault={expandByDefault}
                showTokenUsage={showTokenUsage}
                showTrace={showTrace}
                contextLength={contextLength}
                outputLength={outputLength}
                onApprovalGranted={handleApprovalGranted}
                onApprovalDenied={handleApprovalDenied}
                onContinue={handleContinue}
              />
            ))}

            {/* Pending attachments preview (user just submitted) */}
            {pendingAttachments.length > 0 &&
              pendingAttachments.map((att) => (
                <div key={att.url} className="flex justify-end mb-2">
                  <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg px-3 py-1.5 text-sm text-blue-600 flex items-center gap-2">
                    <span className="text-sm opacity-60">{att.mime}</span>
                    <span className="font-medium truncate max-w-[200px]">{att.name}</span>
                  </div>
                </div>
              ))}

            {/* Loading indicator: shown only when waiting for the first assistant message
                (i.e., last message is user, not assistant). This prevents duplicate bot icons
                when the assistant message has already started streaming. */}
            {isLoading && messages.length > 0 && messages[messages.length - 1].role === 'user' && (
              <div className="flex gap-3">
                <div className="h-8 w-8 rounded-lg bg-gray-200 dark:bg-gray-700 flex items-center justify-center flex-shrink-0">
                  <Bot size={15} className="text-gray-600 dark:text-gray-300" />
                </div>
                <div className="bg-gray-100 dark:bg-gray-800 rounded-xl rounded-tl-sm px-4 py-3">
                  <div className="flex gap-1.5 items-center h-5">
                    {[0, 1, 2].map((i) => (
                      <div
                        key={i}
                        className="h-2 w-2 rounded-full bg-gray-400 animate-bounce"
                        style={{ animationDelay: `${i * 0.15}s` }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Background-run indicator: a detached run is still going on the
                server (e.g. the browser was reopened mid-generation). There's
                no live stream here, so the assistant bubble updates via the DB
                merge poll. Surfaces a visible "still working" signal + Stop. */}
            {backgroundRunning && !isLoading && (
              <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 pl-11">
                <span className="inline-block h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
                Generating in background…
              </div>
            )}
          </div>

          <div ref={scrollAnchorRef} aria-hidden="true" className="h-px w-full" />

          {/* Scroll to bottom button – sits to the right of the message bubble column,
              sticky at the bottom of the visible scrollport. Always rendered so it can
              fade in/out smoothly via opacity transitions. */}
          <div
            className={`sticky bottom-4 max-w-3xl mx-auto h-0 pointer-events-none transition-opacity duration-300 ease-in-out ${
              showScrollButton ? 'opacity-100' : 'opacity-0'
            }`}
            aria-hidden={!showScrollButton}
          >
            <button
              onClick={() => scrollToBottom()}
              tabIndex={showScrollButton ? 0 : -1}
              className={`absolute right-0 bottom-0 translate-x-[calc(100%-1rem)] max-[1200px]:translate-x-0 max-[1200px]:right-2 h-14 w-14 flex items-center justify-center rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors duration-200 ${
                showScrollButton ? 'pointer-events-auto' : 'pointer-events-none'
              }`}
              title="Scroll to bottom"
              aria-label="Scroll to bottom"
            >
              <ChevronDown size={20} className="text-gray-600 dark:text-gray-300" />
            </button>
          </div>
        </div>

        {/* Chat input */}
        <ChatInput
          onSend={handleSend}
          onStop={isLoading || backgroundRunning ? handleStop : undefined}
          disabled={isLoading || backgroundRunning || !sessionId}
          placeholder={`Message ${agentName === 'main' ? 'AgentPrimer' : agentName}…`}
        />
      </main>

      {/* Preview Panel
          previewFile persists so the toggle button can reopen the last file.
          Hidden on mobile when chat is active (main is shown instead). */}
      {previewFile && previewOpen && (
        <PreviewPanel file={previewFile} onClose={() => setPreviewOpenPersisted(false)} />
      )}

      {/* System Prompt Viewer */}
      {systemPromptOpen && (
        <SystemPromptModal
          agentName={agentName}
          sessionId={sessionId}
          onClose={() => setSystemPromptOpen(false)}
        />
      )}
    </>
  );
}
