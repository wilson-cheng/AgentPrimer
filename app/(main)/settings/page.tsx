'use client';

/**
 * app/settings/page.tsx
 * ---------------------------------------------------------------------------
 * Settings page: configure OpenAI endpoint, API key, and default model.
 * When the user leaves the Base URL or API Key field, we immediately probe
 * POST /api/models to auto-populate the Default Model dropdown.
 */

import { useState, useEffect } from 'react';

import Button from '@/components/ui/Button';
import CustomDropDown from '@/components/ui/CustomDropDown';
import { useConfirm } from '@/components/ui/CustomConfirmDialog';
import {
  Settings,
  Key,
  Globe,
  Cpu,
  Save,
  Check,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Sliders,
  Repeat,
  Database,
  Layout,
  GripVertical,
  Sun,
  Moon,
  Monitor,
  Activity,
  PanelRightClose,
  AlertTriangle,
  RotateCcw,
  BookOpen,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

import {
  lookupContextLength,
  lookupOutputLength,
} from '@/lib/model-lengths';

export default function SettingsPage() {
  // LLM API endpoint URL (e.g., https://api.deepseek.com/v1)
  const [endpoint, setEndpoint] = useState('');
  // Whether to expand tool call details inline in the chat UI by default
  const [expandToolDetails, setExpandToolDetails] = useState(true);
  // Whether to show token usage badges on each assistant message
  const [showTokenUsage, setShowTokenUsage] = useState(true);
  // Whether to show the per-step Trace badge on each assistant message
  const [showTrace, setShowTrace] = useState(true);
  // Maximum agent loop steps before forced stop (0 = unlimited)
  const [maxAgentSteps, setMaxAgentSteps] = useState(0);
  // API key for the configured LLM endpoint
  const [apiKey, setApiKey] = useState('');
  // Whether the stored API key is masked with bullet characters (read-only display)
  const [keyIsMasked, setKeyIsMasked] = useState(false);
  // Default model ID used when no agent or per-session override is set
  const [defaultModel, setDefaultModel] = useState('');
  // Whether settings are still loading from the server
  const [loading, setLoading] = useState(true);
  // Whether a save operation is currently in progress
  const [saving, setSaving] = useState(false);
  // Whether the last save completed successfully (shows "Saved!" indicator briefly)
  const [saved, setSaved] = useState(false);

  // Model list state
  // Available model IDs fetched from the LLM endpoint (auto-populated on endpoint change)
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  // Whether a model list fetch is in progress
  const [fetchingModels, setFetchingModels] = useState(false);
  // Error message if the model list fetch fails
  const [modelFetchError, setModelFetchError] = useState('');

  // ── Advanced model parameters (collapsible) ────────────────────────────
  // Whether the "Advanced" panel under the model dropdown is expanded
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Per-model detail maps fetched from the provider's /v1/models endpoint
  // (context_length + max_output_tokens). Keyed by model ID.
  const [modelDetails, setModelDetails] = useState<
    Record<string, { context_length?: number; max_output_tokens?: number }>
  >({});
  // User-editable context-window override for the currently selected model.
  // Empty string = use the application default (provider / lookup table).
  const [advancedContextWindow, setAdvancedContextWindow] = useState<number | ''>('');
  // User-editable max-output-size override for the currently selected model.
  const [advancedMaxOutput, setAdvancedMaxOutput] = useState<number | ''>('');
  // The full override maps persisted to the settings table. These are loaded
  // once on mount and updated as the user edits individual model values so
  // switching models preserves per-model overrides without losing them.
  const [contextOverrides, setContextOverrides] = useState<Record<string, number>>({});
  const [outputOverrides, setOutputOverrides] = useState<Record<string, number>>({});

  // API key test state
  // Whether a connectivity test is in progress
  const [testing, setTesting] = useState(false);
  // Result of the last API key connectivity test: idle / ok / fail
  const [testStatus, setTestStatus] = useState<'idle' | 'ok' | 'fail'>('idle');
  // Human-readable message from the last API key test
  const [testMsg, setTestMsg] = useState('');

  // (.env editor removed — MCP server credentials live on the per-server
  // env_json column (Skills/MCP → Edit → Environment variables) so a stray
  // host env variable can no longer leak across MCP servers.)

  // Embedding provider — 'local' uses the in-process model (Transformers.js), 'openai' uses text-embedding-3-small
  const [embeddingProvider, setEmbeddingProvider] = useState<'local' | 'openai'>('local');
  // Optional embedding-specific endpoint/key/model. When blank the chat
  // endpoint/key are reused. The model defaults to text-embedding-3-small.
  const [embeddingEndpoint, setEmbeddingEndpoint] = useState('');
  const [embeddingApiKey, setEmbeddingApiKey] = useState('');
  const [embeddingKeyMasked, setEmbeddingKeyMasked] = useState(false);
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [embeddingAvailableModels, setEmbeddingAvailableModels] = useState<string[]>([]);
  const [embeddingFetchingModels, setEmbeddingFetchingModels] = useState(false);
  const [embeddingFetchError, setEmbeddingFetchError] = useState('');
  const [embeddingTesting, setEmbeddingTesting] = useState(false);
  const [embeddingTestStatus, setEmbeddingTestStatus] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [embeddingTestMsg, setEmbeddingTestMsg] = useState('');
  // Whether Langfuse observability tracing is enabled (for external LLM request logging)
  const [tracingEnabled, setTracingEnabled] = useState(true);
  // Whether the Tool Playground page is enabled in the navigation
  const [toolPlayground, setToolPlayground] = useState(true);
  // Langfuse observability settings
  // Langfuse public key (safe to expose, used for identifying the source in logs)
  const [langfuseEnabled, setLangfuseEnabled] = useState(false);
  const [langfusePublicKey, setLangfusePublicKey] = useState('');
  // Langfuse secret key (sensitive — used for API authentication)
  const [langfuseSecretKey, setLangfuseSecretKey] = useState('');
  // Langfuse base URL — supports cloud (https://cloud.langfuse.com) or self-hosted
  const [langfuseBaseUrl, setLangfuseBaseUrl] = useState('https://cloud.langfuse.com');
  // Whether the stored Langfuse secret key is masked for display
  const [langfuseSecretMasked, setLangfuseSecretMasked] = useState(false);
  // Context window compaction: how many user/assistant exchange pairs to keep (0 = disabled)
  const [contextKeepPairs, setContextKeepPairs] = useState(0);
  const [subagentPollingEnabled, setSubagentPollingEnabled] = useState(true);
  const [subagentPollIntervalSeconds, setSubagentPollIntervalSeconds] = useState<number | ''>(60);
  const [subagentPollMaxAttempts, setSubagentPollMaxAttempts] = useState<number | ''>(10);
  const [subagentProgressBubblesEnabled, setSubagentProgressBubblesEnabled] = useState(false);
  const [subagentAutoFollowupEnabled, setSubagentAutoFollowupEnabled] = useState(true);

  // New Chat Layout settings (stored in data/.ui-settings.json)
  // Whether to show the suggestion prompts on a fresh chat page
  const [newChatShowSuggestions, setNewChatShowSuggestions] = useState(true);
  // Whether to show pinned/starred conversations on the new chat page
  const [newChatShowPinnedChat, setNewChatShowPinnedChat] = useState(true);
  // Whether to show pinned system prompts on the new chat page
  const [newChatShowPinnedPrompt, setNewChatShowPinnedPrompt] = useState(true);
  // Order of sections on the new chat page (drag-reorderable)
  const [newChatSectionOrder, setNewChatSectionOrder] = useState([
    'suggestions',
    'pinned_chat',
    'pinned_prompt',
  ]);
  // Which section is currently being dragged (null = none)
  const [draggingSection, setDraggingSection] = useState<string | null>(null);
  const [showLearnNav, setShowLearnNav] = useState(true);

  // Theme setting
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');

  useEffect(() => {
    const stored = localStorage.getItem('theme');
    if (stored === 'dark' || stored === 'light') setTheme(stored);
    else setTheme('system');
  }, []);

  const applyTheme = (t: 'light' | 'dark' | 'system') => {
    setTheme(t);
    if (t === 'dark') {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else if (t === 'light') {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    } else {
      localStorage.removeItem('theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.classList.toggle('dark', prefersDark);
    }
  };

  // Probe the endpoint for an available model list (using unsaved form values).
  // NOTE: GET /api/settings returns the API key masked with • characters for
  // security. If the user hasn't changed the key, we must NOT send the masked
  // value – the backend will use the saved key when api_key is omitted.
  const fetchModels = async (url: string, key: string) => {
    if (!url) return;
    setFetchingModels(true);
    setModelFetchError('');
    try {
      // Detect the masked placeholder (contains bullet char U+2022)
      const cleanKey = key.includes('\u2022') ? undefined : key || undefined;
      const res = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: url, api_key: cleanKey }),
      });
      const data = await res.json();
      if (data.models?.length) {
        setAvailableModels(data.models);
        // Persist the per-model detail map (context_length + max_output_tokens)
        // so the Advanced panel can show defaults when a model is selected.
        if (data.details && typeof data.details === 'object') {
          setModelDetails(data.details as typeof modelDetails);
        }
      } else {
        setModelFetchError(data.error || 'No models returned');
        setAvailableModels([]);
      }
    } catch {
      setModelFetchError('Network error – check the Base URL');
      setAvailableModels([]);
    } finally {
      setFetchingModels(false);
    }
  };

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        const ep = data.settings?.endpoint ?? '';
        const key = data.settings?.api_key ?? '';
        const mdl = data.settings?.default_model ?? '';
        // Never pre-populate the API key field with the masked value — that would
        // overwrite the real key with bullet characters if the user clicks Save.
        const masked = key.includes('\u2022');
        setEndpoint(ep);
        setApiKey(masked ? '' : key);
        setKeyIsMasked(masked);
        setDefaultModel(mdl);
        setExpandToolDetails(data.settings?.expand_tool_details !== 'false');
        setShowTokenUsage(data.settings?.show_token_usage !== 'false');
        setShowTrace(data.settings?.show_trace !== 'false');
        setMaxAgentSteps(parseInt(data.settings?.max_agent_steps ?? '0', 10) || 0);
        setContextKeepPairs(parseInt(data.settings?.context_keep_pairs ?? '0', 10) || 0);
        setSubagentPollingEnabled(data.settings?.subagent_polling_enabled !== 'false');
        setSubagentPollIntervalSeconds(
          parseInt(data.settings?.subagent_poll_interval_seconds ?? '60', 10) || 60,
        );
        setSubagentPollMaxAttempts(
          parseInt(data.settings?.subagent_poll_max_attempts ?? '10', 10) || 10,
        );
        setSubagentProgressBubblesEnabled(
          data.settings?.subagent_progress_bubbles_enabled === 'true',
        );
        setSubagentAutoFollowupEnabled(data.settings?.subagent_auto_followup_enabled !== 'false');
        setEmbeddingProvider((data.settings?.embedding_provider ?? 'local') as 'local' | 'openai');
        const embKey = data.settings?.embedding_api_key ?? '';
        const embKeyMasked = embKey.includes('\u2022');
        setEmbeddingEndpoint(data.settings?.embedding_endpoint ?? '');
        setEmbeddingApiKey(embKeyMasked ? '' : embKey);
        setEmbeddingKeyMasked(embKeyMasked);
        setEmbeddingModel(data.settings?.embedding_model ?? '');
        setTracingEnabled(data.settings?.tracing_enabled !== 'false');
        setToolPlayground(data.settings?.tool_playground !== 'false');
        setLangfuseEnabled(data.settings?.langfuse_enabled === 'true');
        setLangfusePublicKey(data.settings?.langfuse_public_key ?? '');
        setLangfuseBaseUrl(data.settings?.langfuse_base_url ?? 'https://cloud.langfuse.com');
        const lfSecret = data.settings?.langfuse_secret_key ?? '';
        const lfMasked = lfSecret.includes('\u2022');
        setLangfuseSecretKey(lfMasked ? '' : lfSecret);
        setLangfuseSecretMasked(lfMasked);
        // Load persisted per-model override maps (JSON strings in the settings
        // table). Empty/corrupt blobs safely fall back to empty objects.
        try {
          const ctxRaw = data.settings?.model_context_overrides;
          if (ctxRaw) setContextOverrides(JSON.parse(ctxRaw));
        } catch { /* corrupt JSON — ignore */ }
        try {
          const outRaw = data.settings?.model_output_overrides;
          if (outRaw) setOutputOverrides(JSON.parse(outRaw));
        } catch { /* corrupt JSON — ignore */ }
        setLoading(false);
        // Auto-fetch model list on load only when the key is a real value
        if (ep && !masked && key) fetchModels(ep, key);
        // Auto-fetch the embedding endpoint's model list when openai is
        // selected and we have something usable to probe with.
        const embProv = data.settings?.embedding_provider ?? 'local';
        if (embProv === 'openai') {
          const embEp = data.settings?.embedding_endpoint || ep;
          const rawEmbKey = data.settings?.embedding_api_key ?? '';
          const embKeyUsable =
            rawEmbKey && !rawEmbKey.includes('\u2022') ? rawEmbKey : key && !masked ? key : '';
          if (embEp && embKeyUsable) fetchEmbeddingModels(embEp, embKeyUsable);
        }
      });

    // (.env editor removed — see comment above the deleted state hooks.)

    // Load new-chat layout prefs
    fetch('/api/ui-settings')
      .then((r) => r.json())
      .then((d: Record<string, unknown>) => {
        if (d.new_chat_show_suggestions !== undefined)
          setNewChatShowSuggestions(d.new_chat_show_suggestions !== false);
        if (d.new_chat_show_pinned_chat !== undefined)
          setNewChatShowPinnedChat(d.new_chat_show_pinned_chat !== false);
        if (d.new_chat_show_pinned_prompt !== undefined)
          setNewChatShowPinnedPrompt(d.new_chat_show_pinned_prompt !== false);
        if (d.show_learn_nav !== undefined) setShowLearnNav(d.show_learn_nav !== false);
        if (typeof d.new_chat_section_order === 'string' && d.new_chat_section_order) {
          setNewChatSectionOrder((d.new_chat_section_order as string).split(',').filter(Boolean));
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync Advanced fields when the selected model changes ───────────────
  // Whenever the user picks a different model (or types a new ID), recompute
  // the default Context Window / Max Output values shown in the Advanced
  // panel. The priority is:
  //   1. A user-saved override for this exact model ID (from the override maps)
  //   2. The provider-fetched value from /v1/models (modelDetails)
  //   3. The built-in lookup table (lookupContextLength / lookupOutputLength)
  //   4. Empty string (no default known)
  // The user can then adjust the number manually; their edit is staged into
  // the override maps and persisted on Save.
  useEffect(() => {
    if (!defaultModel) {
      setAdvancedContextWindow('');
      setAdvancedMaxOutput('');
      return;
    }
    const detail = modelDetails[defaultModel];
    // Context window
    const savedCtx = contextOverrides[defaultModel];
    if (savedCtx !== undefined) {
      setAdvancedContextWindow(savedCtx);
    } else if (detail?.context_length) {
      setAdvancedContextWindow(detail.context_length);
    } else {
      const looked = lookupContextLength(defaultModel);
      setAdvancedContextWindow(looked ?? '');
    }
    // Max output size
    const savedOut = outputOverrides[defaultModel];
    if (savedOut !== undefined) {
      setAdvancedMaxOutput(savedOut);
    } else if (detail?.max_output_tokens) {
      setAdvancedMaxOutput(detail.max_output_tokens);
    } else {
      const looked = lookupOutputLength(defaultModel);
      setAdvancedMaxOutput(looked ?? '');
    }
  }, [defaultModel, modelDetails, contextOverrides, outputOverrides]);

  // Probe the embedding endpoint for available models. Falls back to the
  // chat endpoint/key when the embedding fields are blank.
  const fetchEmbeddingModels = async (url: string, key: string) => {
    const useUrl = url || endpoint;
    if (!useUrl) return;
    setEmbeddingFetchingModels(true);
    setEmbeddingFetchError('');
    try {
      const cleanKey = key.includes('\u2022') ? undefined : key || undefined;
      const cleanChatKey = apiKey.includes('\u2022') ? undefined : apiKey || undefined;
      const res = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: useUrl, api_key: cleanKey ?? cleanChatKey }),
      });
      const data = await res.json();
      if (data.models?.length) {
        setEmbeddingAvailableModels(data.models);
      } else {
        setEmbeddingFetchError(data.error || 'No models returned');
        setEmbeddingAvailableModels([]);
      }
    } catch {
      setEmbeddingFetchError('Network error – check the Base URL');
      setEmbeddingAvailableModels([]);
    } finally {
      setEmbeddingFetchingModels(false);
    }
  };

  const testEmbeddingApiKey = async () => {
    setEmbeddingTesting(true);
    setEmbeddingTestStatus('idle');
    setEmbeddingTestMsg('');
    try {
      const cleanKey = embeddingApiKey.includes('\u2022')
        ? undefined
        : embeddingApiKey || undefined;
      const cleanChatKey = apiKey.includes('\u2022') ? undefined : apiKey || undefined;
      const useUrl = embeddingEndpoint || endpoint;
      const res = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: useUrl, api_key: cleanKey ?? cleanChatKey }),
      });
      const data = await res.json();
      if (data.models?.length) {
        setEmbeddingTestStatus('ok');
        setEmbeddingTestMsg(
          `Connected — ${data.models.length} model${data.models.length !== 1 ? 's' : ''} available`,
        );
        setEmbeddingAvailableModels(data.models);
      } else {
        setEmbeddingTestStatus('fail');
        setEmbeddingTestMsg(data.error ?? 'No models returned. Check your endpoint and key.');
      }
    } catch {
      setEmbeddingTestStatus('fail');
      setEmbeddingTestMsg('Network error — check the Base URL.');
    } finally {
      setEmbeddingTesting(false);
    }
  };

  const testApiKey = async () => {
    setTesting(true);
    setTestStatus('idle');
    setTestMsg('');
    try {
      const cleanKey = apiKey.includes('\u2022') ? undefined : apiKey || undefined;
      const res = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint, api_key: cleanKey }),
      });
      const data = await res.json();
      if (data.models?.length) {
        setTestStatus('ok');
        setTestMsg(
          `Connected — ${data.models.length} model${data.models.length !== 1 ? 's' : ''} available`,
        );
        setAvailableModels(data.models);
      } else {
        setTestStatus('fail');
        setTestMsg(data.error ?? 'No models returned. Check your endpoint and key.');
      }
    } catch {
      setTestStatus('fail');
      setTestMsg('Network error — check the Base URL.');
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    // Stage the current Advanced field values into the override maps for the
    // selected model so they are persisted alongside every other setting.
    // A model must be selected for the override to be meaningful; empty
    // values are skipped (the default will be used instead).
    const nextContextOverrides = { ...contextOverrides };
    const nextOutputOverrides = { ...outputOverrides };
    if (defaultModel) {
      if (advancedContextWindow !== '' && advancedContextWindow > 0) {
        nextContextOverrides[defaultModel] = advancedContextWindow;
      } else {
        delete nextContextOverrides[defaultModel];
      }
      if (advancedMaxOutput !== '' && advancedMaxOutput > 0) {
        nextOutputOverrides[defaultModel] = advancedMaxOutput;
      } else {
        delete nextOutputOverrides[defaultModel];
      }
    }
    // Only send api_key when the user has typed a new value — skip it when the
    // field is empty so the existing key in the DB is preserved unchanged.
    const saveBody: Record<string, string> = {
      endpoint,
      default_model: defaultModel,
      expand_tool_details: String(expandToolDetails),
      show_token_usage: String(showTokenUsage),
      show_trace: String(showTrace),
      max_agent_steps: String(maxAgentSteps),
      context_keep_pairs: String(contextKeepPairs),
      subagent_polling_enabled: String(subagentPollingEnabled),
      subagent_poll_interval_seconds: String(subagentPollIntervalSeconds || 60),
      subagent_poll_max_attempts: String(subagentPollMaxAttempts || 10),
      subagent_progress_bubbles_enabled: String(subagentProgressBubblesEnabled),
      subagent_auto_followup_enabled: String(subagentAutoFollowupEnabled),
      embedding_provider: embeddingProvider,
      embedding_endpoint: embeddingEndpoint,
      embedding_model: embeddingModel,
      tracing_enabled: String(tracingEnabled),
      tool_playground: String(toolPlayground),
      langfuse_enabled: String(langfuseEnabled),
      langfuse_public_key: langfusePublicKey,
      langfuse_base_url: langfuseBaseUrl,
      model_context_overrides: JSON.stringify(nextContextOverrides),
      model_output_overrides: JSON.stringify(nextOutputOverrides),
    };
    // Keep the in-memory override maps in sync so a subsequent model switch
    // (without a reload) shows the just-saved values.
    setContextOverrides(nextContextOverrides);
    setOutputOverrides(nextOutputOverrides);
    if (apiKey) saveBody.api_key = apiKey;
    if (embeddingApiKey) saveBody.embedding_api_key = embeddingApiKey;
    if (langfuseSecretKey) saveBody.langfuse_secret_key = langfuseSecretKey;

    // Persist server settings, UI settings, and (when changed) .env in
    // parallel. One Save button = one atomic commit point from the user's
    // perspective.
    const reqs: Promise<unknown>[] = [
      fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(saveBody),
      }),
      fetch('/api/ui-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          new_chat_show_suggestions: newChatShowSuggestions,
          new_chat_show_pinned_chat: newChatShowPinnedChat,
          new_chat_show_pinned_prompt: newChatShowPinnedPrompt,
          show_learn_nav: showLearnNav,
          new_chat_section_order: newChatSectionOrder.join(','),
        }),
      }),
    ];
    await Promise.all(reqs);

    if (apiKey) setKeyIsMasked(false);
    if (embeddingApiKey) setEmbeddingKeyMasked(false);
    if (langfuseSecretKey) setLangfuseSecretMasked(false);

    // Notify any layout shells listening for nav-relevant changes.
    window.dispatchEvent(
      new CustomEvent('ui-settings-changed', {
        detail: { show_learn_nav: showLearnNav },
      }),
    );

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggingSection(id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!draggingSection || draggingSection === targetId) return;
    const next = [...newChatSectionOrder];
    const from = next.indexOf(draggingSection);
    const to = next.indexOf(targetId);
    if (from === -1 || to === -1) return;
    next.splice(from, 1);
    next.splice(to, 0, draggingSection);
    setNewChatSectionOrder(next);
    setDraggingSection(null);
  };

  // ── Danger Zone: Reset Defaults dialog state ───────────────────────────
  // The reset flow uses TWO dialogs to make the destructive action hard to
  // do by accident:
  //   1. Picker dialog: checkboxes for each category + special "Reset to
  //      original" (full wipe). Confirm → opens Dialog 2.
  //   2. Confirm dialog: enumerates exactly what's about to be overwritten,
  //      uses red "Confirm" button, and explicitly warns about logout on
  //      full reset.
  const { showConfirm: showResetConfirm, ConfirmModal: ResetConfirmModal } = useConfirm();
  const [resetPickerOpen, setResetPickerOpen] = useState(false);
  const [resetRunning, setResetRunning] = useState(false);
  const [resetErr, setResetErr] = useState('');
  // Picker state — keep flags individually so the labels can render in the
  // order we want without needing an extra array of metadata.
  const [resetSystem, setResetSystem] = useState(false);
  const [resetAgents, setResetAgents] = useState(false);
  const [resetSingleAgent, setResetSingleAgent] = useState(false);
  const [resetAgentName, setResetAgentName] = useState('main');
  const [resetAgentNames, setResetAgentNames] = useState<string[]>(['main']);
  const [resetMcp, setResetMcp] = useState(false);
  const [resetSkills, setResetSkills] = useState(false);
  const [resetFunctionTools, setResetFunctionTools] = useState(false);
  const [resetFull, setResetFull] = useState(false);

  // When the user picks "Reset to original" the other checkboxes get
  // checked + dimmed (per the spec). They're still tracked individually
  // so unchecking "Reset to original" reverts to whatever the user had
  // selected manually before.
  const checkedAny =
    resetSystem ||
    resetAgents ||
    resetSingleAgent ||
    resetMcp ||
    resetSkills ||
    resetFunctionTools ||
    resetFull;

  const openResetPicker = () => {
    setResetSystem(false);
    setResetAgents(false);
    setResetSingleAgent(false);
    setResetMcp(false);
    setResetSkills(false);
    setResetFunctionTools(false);
    setResetFull(false);
    setResetErr('');
    fetch('/api/agents')
      .then((r) => r.json())
      .then((d) => {
        const names = Array.isArray(d.agents) && d.agents.length ? d.agents : ['main'];
        setResetAgentNames(names);
        setResetAgentName(names.includes(resetAgentName) ? resetAgentName : names[0]);
      })
      .catch(() => {
        setResetAgentNames(['main']);
        setResetAgentName('main');
      });
    setResetPickerOpen(true);
  };

  const handleResetContinue = async () => {
    // Build the targets list. When "Reset to original" is checked the
    // server treats `full` as the umbrella that supersedes all others, so
    // we send only ['full'] to keep the wire format tight.
    const targets: string[] = resetFull
      ? ['full']
      : [
          resetSystem && 'system',
          resetAgents && 'agents',
          resetSingleAgent && 'agent',
          resetMcp && 'mcp-servers',
          resetSkills && 'skills',
          resetFunctionTools && 'function-tools',
        ].filter((x): x is string => typeof x === 'string');

    if (targets.length === 0) return;

    // Stage 2: spell out what's about to happen in plain language. The
    // confirm button is red, and for `full` we make the logout consequence
    // unmissable.
    const isFull = targets[0] === 'full';
    const message = isFull ? (
      <>
        <p className="text-red-600 dark:text-red-400 font-700">
          This will permanently delete EVERYTHING and restore the app to its original state,
          including:
        </p>
        <ul className="list-disc list-inside ml-2 text-gray-700 dark:text-gray-300 space-y-0.5">
          <li>Your user account and login</li>
          <li>All chats, messages, and uploaded files</li>
          <li>All custom skills, function tools, and MCP servers</li>
          <li>All saved settings and API keys</li>
          <li>System prompt and agent folders</li>
        </ul>
        <p className="text-gray-600 dark:text-gray-400">
          The embedding model cache (<code className="font-mono">data/models/</code>) is kept to
          avoid a slow re-download — delete it manually for a true clean slate.
        </p>
        <p className="text-red-600 dark:text-red-400">
          You will be logged out and redirected to the registration page.
        </p>
      </>
    ) : (
      <>
        <p>
          The following will be <strong>overwritten with the bundled defaults</strong>:
        </p>
        <ul className="list-disc list-inside ml-2 text-gray-700 dark:text-gray-300 space-y-0.5">
          {resetSystem && (
            <li>
              <code className="font-mono">system.md</code> (global system prompt)
            </li>
          )}
          {resetAgents && (
            <li>
              <code className="font-mono">data/agents/</code> (all agent folders — custom agents and
              memories will be lost)
            </li>
          )}
          {resetSingleAgent && (
            <li>
              <code className="font-mono">data/agents/{resetAgentName}/</code> (that agent&apos;s
              prompt, memory, schemas, and files)
            </li>
          )}
          {resetMcp && (
            <li>
              All MCP servers in <code className="font-mono">data/mcp-servers/</code> —
              user-installed servers will be removed; only bundled defaults remain
            </li>
          )}
          {resetSkills && (
            <li>
              All skills in <code className="font-mono">data/skills/</code> — user-installed skills
              will be removed; only bundled defaults remain
            </li>
          )}
          {resetFunctionTools && (
            <li>
              All function tools in <code className="font-mono">data/function-tools/</code> —
              user-installed tools will be removed; only bundled defaults remain
            </li>
          )}
        </ul>
        <p className="text-gray-500 dark:text-gray-400">
          Your user account, chats, settings, and API keys are NOT affected.
        </p>
      </>
    );

    const ok = await showResetConfirm(message, {
      title: isFull ? 'Wipe everything?' : 'Restore defaults?',
      confirmLabel: isFull ? 'Wipe Everything' : 'Restore Defaults',
      confirmVariant: 'danger',
    });
    if (!ok) return;

    // Fire and forget — close the picker, run the request, then either
    // hard-navigate to /register (full reset) or reload the page so the
    // restored values render with their defaults.
    setResetPickerOpen(false);
    setResetRunning(true);
    setResetErr('');
    try {
      const res = await fetch('/api/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets, agentName: resetSingleAgent ? resetAgentName : undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      if (data.didWipeAccounts) {
        // Hard navigation drops all client React state + revokes the
        // cookie state cached in memory. AuthGuard at /register would
        // also redirect us there on the next render, but doing it here
        // avoids a brief flash of the settings page.
        window.location.href = '/register';
      } else {
        window.location.reload();
      }
    } catch (err) {
      setResetErr(err instanceof Error ? err.message : String(err));
      setResetRunning(false);
    }
  };

  return (
    <main className="flex-1 flex flex-col overflow-hidden">
      {/* Page header — sticks at top */}
      <div className="flex-shrink-0 bg-blue-500 pl-14 pr-6 py-6 md:px-8 md:py-10 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full translate-x-1/3 -translate-y-1/3" />
        <div className="absolute top-0 left-1/3 w-36 h-36 bg-white/10 rotate-45 -translate-y-1/2" />
        <div className="relative z-10 max-w-2xl">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 min-w-12 rounded-xl bg-white/20 flex items-center justify-center">
              <Settings size={24} className="text-white" />
            </div>
            <div className="min-w-0 overflow-hidden">
              <h1 className="text-3xl font-800 text-white tracking-tight truncate">Settings</h1>
              <p className="text-blue-200 text-sm truncate">
                Configure your AI backend and preferences
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Scrollable content — scrollbar at browser edge */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto w-full px-8 py-8 space-y-6">
          {loading ? (
            <div className="flex items-center gap-3 text-gray-400 dark:text-gray-500 py-12 justify-center">
              <RefreshCw size={18} className="animate-spin" />
              <span>Loading settings…</span>
            </div>
          ) : (
            <>
              {/* How saving works */}
              <div className="rounded-xl border border-blue-100 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/40 px-4 py-3 text-sm text-blue-800 dark:text-blue-200 flex items-start gap-2.5">
                <Save size={16} className="flex-shrink-0 mt-0.5" />
                <p>
                  Your changes are kept locally on this page and only persisted when you click
                  <span className="font-700"> Save Settings </span>
                  at the bottom. The only exception is the
                  <span className="font-700"> Theme </span>
                  selector, which applies immediately and is stored per-browser.
                </p>
              </div>

              {/* API Configuration — endpoint, key, and default model in one block */}
              <section className="rounded-xl px-0 pb-6 md:p-6 md:bg-gray-50 dark:md:bg-gray-800/50">
                <div className="flex items-center gap-3 mb-5">
                  <div className="h-9 w-9 rounded-lg min-w-9 bg-blue-500 flex items-center justify-center">
                    <Globe size={18} className="text-white" />
                  </div>
                  <div>
                    <h2 className="font-700 text-gray-900 dark:text-gray-100">API Configuration</h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      OpenAI-compatible endpoint, key, and default model
                    </p>
                  </div>
                </div>

                <div className="space-y-6">
                  {/* Base URL */}
                  <div className="space-y-1.5">
                    <label className="text-sm font-600 text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                      <Globe size={14} className="text-blue-500" />
                      Base URL
                    </label>
                    <input
                      type="url"
                      value={endpoint}
                      onChange={(e) => setEndpoint(e.target.value)}
                      onBlur={(e) => fetchModels(e.target.value, apiKey)}
                      placeholder="https://api.deepseek.com/v1"
                      className="w-full h-11 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 rounded-lg border-2 border-gray-200 dark:border-gray-600 text-sm focus:outline-none focus:border-blue-500 transition-all duration-200 font-mono"
                    />
                    <p className="text-sm text-gray-400 dark:text-gray-500">
                      Supports OpenAI, OpenRouter, Together AI, Ollama, LM Studio, and any
                      compatible endpoint.
                    </p>
                  </div>

                  {/* API Key */}
                  <div className="space-y-1.5">
                    <label className="text-sm font-600 text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                      <Key size={14} className="text-emerald-500" />
                      API Key
                    </label>
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => {
                        setApiKey(e.target.value);
                        setKeyIsMasked(false);
                      }}
                      onBlur={(e) => fetchModels(endpoint, e.target.value)}
                      placeholder={keyIsMasked ? 'Key saved – re-enter to replace' : 'sk-…'}
                      className="w-full h-11 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 rounded-lg border-2 border-gray-200 dark:border-gray-600 text-sm focus:outline-none focus:border-blue-500 transition-all duration-200 font-mono"
                    />
                    <p className="text-sm text-gray-400 dark:text-gray-500">
                      {keyIsMasked
                        ? 'A key is already saved. Leave blank to keep it.'
                        : 'Leave blank to keep the existing key.'}
                    </p>
                    {/* Test button */}
                    <button
                      type="button"
                      onClick={testApiKey}
                      disabled={testing || !endpoint}
                      className="mt-1 flex items-center gap-1.5 px-3 h-8 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40 text-sm font-600 text-gray-700 dark:text-gray-300 transition-colors"
                    >
                      {testing ? (
                        <>
                          <RefreshCw size={14} className="animate-spin" /> Testing…
                        </>
                      ) : (
                        <>
                          <RefreshCw size={14} /> Test and fetch models
                        </>
                      )}
                    </button>
                    {testStatus !== 'idle' && (
                      <div
                        className={`flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg ${
                          testStatus === 'ok'
                            ? 'bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300'
                            : 'bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
                        }`}
                      >
                        {testStatus === 'ok' ? (
                          <CheckCircle2 size={14} className="flex-shrink-0" />
                        ) : (
                          <XCircle size={14} className="flex-shrink-0" />
                        )}
                        {testMsg}
                      </div>
                    )}
                  </div>

                  {/* Default model */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-600 text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                        <Cpu size={14} className="text-amber-500" />
                        Default Model
                      </label>
                      <button
                        type="button"
                        onClick={() => fetchModels(endpoint, apiKey)}
                        disabled={fetchingModels || !endpoint}
                        className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 disabled:opacity-40"
                      >
                        <RefreshCw size={14} className={fetchingModels ? 'animate-spin' : ''} />
                        {fetchingModels ? 'Loading…' : 'Refresh models'}
                      </button>
                    </div>

                    {/* Searchable model dropdown */}
                    <CustomDropDown
                      models={availableModels}
                      value={defaultModel}
                      onChange={setDefaultModel}
                      placeholder="Type or select a model ID…"
                      allowFreeText
                      compact
                    />

                    {/* Status hint */}
                    {fetchingModels ? (
                      <p className="text-sm text-gray-400">Fetching available models…</p>
                    ) : availableModels.length > 0 ? (
                      <p className="text-sm text-green-600">
                        {availableModels.length} models available
                      </p>
                    ) : modelFetchError ? (
                      <p className="text-sm text-red-500">
                        {modelFetchError} — you can still type a model ID manually
                      </p>
                    ) : (
                      <p className="text-sm text-gray-400">
                        Used when no model is selected in chat. Enter Base URL above and press Tab
                        to auto-load available models.
                      </p>
                    )}
                  </div>

                  {/* Advanced model parameters — collapsible */}
                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setAdvancedOpen((v) => !v)}
                      className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-gray-700/50 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                    >
                      <span className="flex items-center gap-2 text-sm font-600 text-gray-700 dark:text-gray-300">
                        <Sliders size={14} className="text-gray-500 dark:text-gray-400" />
                        Advanced
                      </span>
                      {advancedOpen ? (
                        <ChevronDown size={16} className="text-gray-400" />
                      ) : (
                        <ChevronRight size={16} className="text-gray-400" />
                      )}
                    </button>

                    {advancedOpen && (
                      <div className="px-4 py-4 space-y-4">
                        <p className="text-sm text-gray-400 dark:text-gray-500">
                          Override the default model parameters used when calling the API. Values
                          are pre-filled from the provider or the built-in lookup table when you
                          select a model; adjust them as needed. Leave blank to use the default.
                        </p>

                        {/* Context Window */}
                        <div className="space-y-1.5">
                          <label className="text-sm font-600 text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                            <Cpu size={14} className="text-indigo-500" />
                            Context Window (tokens)
                          </label>
                          <input
                            type="number"
                            min={0}
                            value={advancedContextWindow}
                            onChange={(e) => {
                              const v = e.target.value;
                              setAdvancedContextWindow(v === '' ? '' : Math.max(0, parseInt(v, 10) || 0));
                            }}
                            placeholder="Default from model"
                            disabled={!defaultModel}
                            className="w-full h-11 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 rounded-lg border-2 border-gray-200 dark:border-gray-600 text-sm focus:outline-none focus:border-blue-500 transition-all duration-200 font-mono disabled:opacity-50 disabled:cursor-not-allowed"
                          />
                          <p className="text-sm text-gray-400 dark:text-gray-500">
                            Maximum total tokens (prompt + completion) the model can accept.
                            {!defaultModel && ' Select a model first.'}
                          </p>
                        </div>

                        {/* Max Output Size */}
                        <div className="space-y-1.5">
                          <label className="text-sm font-600 text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                            <Sliders size={14} className="text-purple-500" />
                            Max Output Size (tokens)
                          </label>
                          <input
                            type="number"
                            min={0}
                            value={advancedMaxOutput}
                            onChange={(e) => {
                              const v = e.target.value;
                              setAdvancedMaxOutput(v === '' ? '' : Math.max(0, parseInt(v, 10) || 0));
                            }}
                            placeholder="Default from model"
                            disabled={!defaultModel}
                            className="w-full h-11 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 rounded-lg border-2 border-gray-200 dark:border-gray-600 text-sm focus:outline-none focus:border-blue-500 transition-all duration-200 font-mono disabled:opacity-50 disabled:cursor-not-allowed"
                          />
                          <p className="text-sm text-gray-400 dark:text-gray-500">
                            Maximum number of tokens the model can generate in a single response
                            (sent as <code className="text-xs">max_tokens</code> in the API call).
                            {!defaultModel && ' Select a model first.'}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {/* Embedding Provider */}
              <section className="rounded-xl px-0 pb-6 md:p-6 md:bg-gray-50 dark:md:bg-gray-800/50">
                <div className="flex items-center gap-3 mb-5">
                  <div className="h-9 w-9 rounded-lg min-w-9 bg-teal-500 flex items-center justify-center">
                    <Database size={18} className="text-white" />
                  </div>
                  <div>
                    <h2 className="font-700 text-gray-900 dark:text-gray-100">
                      Embedding Provider
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Used for RAG and semantic memory search
                    </p>
                  </div>
                </div>
                <div className="flex rounded-lg overflow-hidden border-2 border-gray-200 dark:border-gray-600">
                  <button
                    type="button"
                    onClick={() => setEmbeddingProvider('local')}
                    className={`flex-1 py-2.5 text-sm font-600 transition-colors ${
                      embeddingProvider === 'local'
                        ? 'bg-teal-500 text-white'
                        : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600'
                    }`}
                  >
                    Local (on-device)
                  </button>
                  <button
                    type="button"
                    onClick={() => setEmbeddingProvider('openai')}
                    className={`flex-1 py-2.5 text-sm font-600 transition-colors border-l-2 border-gray-200 dark:border-gray-600 ${
                      embeddingProvider === 'openai'
                        ? 'bg-teal-500 text-white'
                        : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600'
                    }`}
                  >
                    OpenAI API
                  </button>
                </div>
                <p className="text-sm text-gray-400 dark:text-gray-500 mt-2">
                  {embeddingProvider === 'local'
                    ? 'Uses a local in-process embedding model (all-MiniLM-L6-v2) — no API cost, runs fully on server.'
                    : 'Uses an OpenAI-compatible embeddings API. Configure a separate endpoint, key and model below if your embedding provider differs from your chat provider.'}
                </p>

                {embeddingProvider === 'openai' && (
                  <div className="mt-5 space-y-5 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
                    {/* Embedding Base URL */}
                    <div className="space-y-1.5">
                      <label className="text-sm font-600 text-gray-700 dark:text-gray-300">
                        Embedding Base URL
                      </label>
                      <input
                        type="url"
                        value={embeddingEndpoint}
                        onChange={(e) => setEmbeddingEndpoint(e.target.value)}
                        onBlur={(e) => fetchEmbeddingModels(e.target.value, embeddingApiKey)}
                        placeholder={endpoint || 'https://api.openai.com/v1'}
                        className="w-full h-11 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 rounded-lg border-2 border-gray-200 dark:border-gray-600 text-sm focus:outline-none focus:border-teal-500 transition-all duration-200 font-mono"
                      />
                      <p className="text-sm text-gray-400 dark:text-gray-500">
                        Leave blank to reuse the chat API Base URL above.
                      </p>
                    </div>

                    {/* Embedding API Key */}
                    <div className="space-y-1.5">
                      <label className="text-sm font-600 text-gray-700 dark:text-gray-300">
                        Embedding API Key
                      </label>
                      <input
                        type="password"
                        value={embeddingApiKey}
                        onChange={(e) => {
                          setEmbeddingApiKey(e.target.value);
                          setEmbeddingKeyMasked(false);
                        }}
                        onBlur={(e) => fetchEmbeddingModels(embeddingEndpoint, e.target.value)}
                        placeholder={
                          embeddingKeyMasked
                            ? 'Key saved – re-enter to replace'
                            : 'Leave blank to reuse the chat API key'
                        }
                        className="w-full h-11 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 rounded-lg border-2 border-gray-200 dark:border-gray-600 text-sm focus:outline-none focus:border-teal-500 transition-all duration-200 font-mono"
                      />
                      <p className="text-sm text-gray-400 dark:text-gray-500">
                        {embeddingKeyMasked
                          ? 'A key is already saved. Leave blank to keep it.'
                          : 'Leave blank to keep the existing key, or to reuse the chat API key.'}
                      </p>
                      <button
                        type="button"
                        onClick={testEmbeddingApiKey}
                        disabled={embeddingTesting || !(embeddingEndpoint || endpoint)}
                        className="mt-1 flex items-center gap-1.5 px-3 h-8 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40 text-sm font-600 text-gray-700 dark:text-gray-300 transition-colors"
                      >
                        {embeddingTesting ? (
                          <>
                            <RefreshCw size={14} className="animate-spin" /> Testing…
                          </>
                        ) : (
                          <>
                            <RefreshCw size={14} /> Test and fetch models
                          </>
                        )}
                      </button>
                      {embeddingTestStatus !== 'idle' && (
                        <div
                          className={`flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg ${
                            embeddingTestStatus === 'ok'
                              ? 'bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300'
                              : 'bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
                          }`}
                        >
                          {embeddingTestStatus === 'ok' ? (
                            <CheckCircle2 size={14} className="flex-shrink-0" />
                          ) : (
                            <XCircle size={14} className="flex-shrink-0" />
                          )}
                          {embeddingTestMsg}
                        </div>
                      )}
                    </div>

                    {/* Embedding Model */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-600 text-gray-700 dark:text-gray-300">
                          Embedding Model
                        </label>
                        <button
                          type="button"
                          onClick={() => fetchEmbeddingModels(embeddingEndpoint, embeddingApiKey)}
                          disabled={embeddingFetchingModels || !(embeddingEndpoint || endpoint)}
                          className="flex items-center gap-1.5 text-sm text-teal-600 hover:text-teal-800 disabled:opacity-40"
                        >
                          <RefreshCw
                            size={14}
                            className={embeddingFetchingModels ? 'animate-spin' : ''}
                          />
                          {embeddingFetchingModels ? 'Loading…' : 'Refresh models'}
                        </button>
                      </div>
                      <CustomDropDown
                        models={embeddingAvailableModels}
                        value={embeddingModel}
                        onChange={setEmbeddingModel}
                        placeholder="text-embedding-3-small"
                        allowFreeText
                        compact
                      />
                      {embeddingFetchingModels ? (
                        <p className="text-sm text-gray-400">Fetching available models…</p>
                      ) : embeddingAvailableModels.length > 0 ? (
                        <p className="text-sm text-green-600">
                          {embeddingAvailableModels.length} models available
                        </p>
                      ) : embeddingFetchError ? (
                        <p className="text-sm text-red-500">
                          {embeddingFetchError} — you can still type a model ID manually
                        </p>
                      ) : (
                        <p className="text-sm text-gray-400">
                          Defaults to <code className="font-mono">text-embedding-3-small</code> when
                          blank. Type a model ID or click Refresh.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </section>

              {/* Chat Behavior */}
              <section className="rounded-xl px-0 pb-6 md:p-6 md:bg-gray-50 dark:md:bg-gray-800/50">
                <div className="flex items-center gap-3 mb-5">
                  <div className="h-9 w-9 rounded-lg min-w-9 bg-violet-500 flex items-center justify-center">
                    <Sliders size={18} className="text-white" />
                  </div>
                  <div>
                    <h2 className="font-700 text-gray-900 dark:text-gray-100">Chat Behavior</h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Control how the chat interface behaves
                    </p>
                  </div>
                </div>
                <div className="space-y-5">
                  {/* Expand tool details toggle */}
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-600 text-gray-700 dark:text-gray-300">
                        Expand tool details by default
                      </p>
                      <p className="text-sm text-gray-400 dark:text-gray-500 mt-0.5">
                        Show reasoning and tool call results expanded instead of collapsed
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setExpandToolDetails((v) => !v)}
                      className={`relative flex-shrink-0 h-6 w-11 rounded-full transition-colors duration-200 focus:outline-none ${
                        expandToolDetails ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${
                          expandToolDetails ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>

                  {/* Show token usage toggle */}
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-600 text-gray-700 dark:text-gray-300">
                        Show token usage in messages
                      </p>
                      <p className="text-sm text-gray-400 dark:text-gray-500 mt-0.5">
                        Display input, cached, and output token counts at the end of each assistant
                        message
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowTokenUsage((v) => !v)}
                      className={`relative flex-shrink-0 h-6 w-11 rounded-full transition-colors duration-200 focus:outline-none ${
                        showTokenUsage ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${
                          showTokenUsage ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>

                  {/* Show trace badge toggle */}
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-600 text-gray-700 dark:text-gray-300">
                        Show trace in messages
                      </p>
                      <p className="text-sm text-gray-400 dark:text-gray-500 mt-0.5">
                        Display the &quot;Trace&quot; badge at the end of each assistant message
                        that has per-step trace data
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowTrace((v) => !v)}
                      className={`relative flex-shrink-0 h-6 w-11 rounded-full transition-colors duration-200 focus:outline-none ${
                        showTrace ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${
                          showTrace ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>

                  {/* Agent tracing toggle */}
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-600 text-gray-700 dark:text-gray-300">
                        Per-step agent tracing
                      </p>
                      <p className="text-sm text-gray-400 dark:text-gray-500 mt-0.5">
                        Record per-LLM-call timing, token usage, and tool I/O for each assistant
                        message (requires more storage)
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTracingEnabled((v) => !v)}
                      className={`relative flex-shrink-0 h-6 w-11 rounded-full transition-colors duration-200 focus:outline-none ${
                        tracingEnabled ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${
                          tracingEnabled ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>

                  {/* Sub-agent monitor */}
                  <div className="space-y-4 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-600 text-gray-700 dark:text-gray-300">
                          Monitor async sub-agents
                        </p>
                        <p className="text-sm text-gray-400 dark:text-gray-500 mt-0.5">
                          Poll background sub-agent task logs and inject completion updates into the
                          chat
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSubagentPollingEnabled((v) => !v)}
                        className={`relative flex-shrink-0 h-6 w-11 rounded-full transition-colors duration-200 focus:outline-none ${
                          subagentPollingEnabled ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${
                            subagentPollingEnabled ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-600 text-gray-700 dark:text-gray-300">
                          Show progress bubbles
                        </p>
                        <p className="text-sm text-gray-400 dark:text-gray-500 mt-0.5">
                          Post changed progress log lines while tasks are still running
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSubagentProgressBubblesEnabled((v) => !v)}
                        className={`relative flex-shrink-0 h-6 w-11 rounded-full transition-colors duration-200 focus:outline-none ${
                          subagentProgressBubblesEnabled
                            ? 'bg-emerald-500'
                            : 'bg-gray-300 dark:bg-gray-600'
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${
                            subagentProgressBubblesEnabled ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-600 text-gray-700 dark:text-gray-300">
                          Auto follow up when complete
                        </p>
                        <p className="text-sm text-gray-400 dark:text-gray-500 mt-0.5">
                          Experimental orchestration demo: automatically spend one parent-agent LLM
                          call after a sub-agent finishes
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSubagentAutoFollowupEnabled((v) => !v)}
                        className={`relative flex-shrink-0 h-6 w-11 rounded-full transition-colors duration-200 focus:outline-none ${
                          subagentAutoFollowupEnabled
                            ? 'bg-emerald-500'
                            : 'bg-gray-300 dark:bg-gray-600'
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${
                            subagentAutoFollowupEnabled ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-sm font-600 text-gray-700 dark:text-gray-300">
                          Poll interval seconds
                        </label>
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={subagentPollIntervalSeconds}
                          onChange={(e) =>
                            setSubagentPollIntervalSeconds(
                              e.target.value === '' ? '' : parseInt(e.target.value, 10),
                            )
                          }
                          onBlur={() =>
                            setSubagentPollIntervalSeconds((v) =>
                              v === '' || Number.isNaN(v) || v < 1 ? 60 : v,
                            )
                          }
                          className="w-full h-11 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 rounded-lg border-2 border-gray-200 dark:border-gray-600 text-sm focus:outline-none focus:border-emerald-500 transition-all duration-200 font-mono"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-sm font-600 text-gray-700 dark:text-gray-300">
                          Max poll attempts
                        </label>
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={subagentPollMaxAttempts}
                          onChange={(e) =>
                            setSubagentPollMaxAttempts(
                              e.target.value === '' ? '' : parseInt(e.target.value, 10),
                            )
                          }
                          onBlur={() =>
                            setSubagentPollMaxAttempts((v) =>
                              v === '' || Number.isNaN(v) || v < 1 ? 10 : v,
                            )
                          }
                          className="w-full h-11 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 rounded-lg border-2 border-gray-200 dark:border-gray-600 text-sm focus:outline-none focus:border-emerald-500 transition-all duration-200 font-mono"
                        />
                      </div>
                    </div>
                    <p className="text-sm text-gray-400 dark:text-gray-500">
                      Default: poll every 60 seconds, up to 10 times. Polling reads local task
                      status/log files and does not call the LLM.
                    </p>
                  </div>

                  {/* Max agent steps */}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Repeat size={14} className="text-gray-500" />
                      <label className="text-sm font-600 text-gray-700 dark:text-gray-300">
                        Max Agent Loop Steps
                      </label>
                    </div>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={maxAgentSteps}
                      onChange={(e) =>
                        setMaxAgentSteps(Math.max(0, parseInt(e.target.value, 10) || 0))
                      }
                      className="w-full h-11 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 rounded-lg border-2 border-gray-200 dark:border-gray-600 text-sm focus:outline-none focus:border-blue-500 transition-all duration-200 font-mono"
                    />
                    <p className="text-sm text-gray-400 dark:text-gray-500">
                      Maximum tool-call iterations per agent response. Set to{' '}
                      <code className="font-mono bg-gray-100 dark:bg-gray-700 px-1 rounded">0</code>{' '}
                      for unlimited (up to 100).
                    </p>
                  </div>

                  {/* Context window compaction */}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <PanelRightClose size={14} className="text-gray-500" />
                      <label className="text-sm font-600 text-gray-700 dark:text-gray-300">
                        Context Window Compaction
                      </label>
                    </div>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={contextKeepPairs}
                      onChange={(e) =>
                        setContextKeepPairs(Math.max(0, parseInt(e.target.value, 10) || 0))
                      }
                      className="w-full h-11 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 rounded-lg border-2 border-gray-200 dark:border-gray-600 text-sm focus:outline-none focus:border-blue-500 transition-all duration-200 font-mono"
                    />
                    <p className="text-sm text-gray-400 dark:text-gray-500">
                      Number of recent user/assistant exchanges to keep in context (sliding window).
                      Set to{' '}
                      <code className="font-mono bg-gray-100 dark:bg-gray-700 px-1 rounded">0</code>{' '}
                      to disable. Older messages are dropped to stay within the model&apos;s token
                      limit. Helps prevent context overflow on long conversations.
                    </p>
                  </div>
                </div>
              </section>

              {/* Langfuse Observability */}
              <section className="rounded-xl px-0 pb-6 md:p-6 md:bg-gray-50 dark:md:bg-gray-800/50">
                <div className="flex items-center gap-3 mb-5">
                  <div className="h-9 w-9 rounded-lg min-w-9 bg-fuchsia-500 flex items-center justify-center">
                    <Activity size={18} className="text-white" />
                  </div>
                  <div>
                    <h2 className="font-700 text-gray-900 dark:text-gray-100">
                      Langfuse Observability
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Optional external tracing for LLM calls, tool steps, timing, and token usage
                    </p>
                  </div>
                </div>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-600 text-gray-700 dark:text-gray-300">
                        Send traces to Langfuse
                      </p>
                      <p className="text-sm text-gray-400 dark:text-gray-500 mt-0.5">
                        Requires Public Key and Secret Key. Per-step local tracing can be enabled
                        separately above.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setLangfuseEnabled((v) => !v)}
                      className={`relative flex-shrink-0 h-6 w-11 rounded-full transition-colors duration-200 focus:outline-none ${
                        langfuseEnabled ? 'bg-fuchsia-500' : 'bg-gray-300 dark:bg-gray-600'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${
                          langfuseEnabled ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-sm font-600 text-gray-700 dark:text-gray-300">
                        Public Key
                      </label>
                      <input
                        type="text"
                        value={langfusePublicKey}
                        onChange={(e) => setLangfusePublicKey(e.target.value)}
                        placeholder="pk-lf-..."
                        className="w-full h-11 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 rounded-lg border-2 border-gray-200 dark:border-gray-600 text-sm focus:outline-none focus:border-fuchsia-500 transition-all duration-200 font-mono"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-600 text-gray-700 dark:text-gray-300">
                        Secret Key
                      </label>
                      <input
                        type="password"
                        value={langfuseSecretKey}
                        onChange={(e) => {
                          setLangfuseSecretKey(e.target.value);
                          setLangfuseSecretMasked(false);
                        }}
                        placeholder={
                          langfuseSecretMasked ? 'Secret saved – re-enter to replace' : 'sk-lf-...'
                        }
                        className="w-full h-11 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 rounded-lg border-2 border-gray-200 dark:border-gray-600 text-sm focus:outline-none focus:border-fuchsia-500 transition-all duration-200 font-mono"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-600 text-gray-700 dark:text-gray-300">
                      Base URL
                    </label>
                    <input
                      type="url"
                      value={langfuseBaseUrl}
                      onChange={(e) => setLangfuseBaseUrl(e.target.value)}
                      placeholder="https://cloud.langfuse.com"
                      className="w-full h-11 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 rounded-lg border-2 border-gray-200 dark:border-gray-600 text-sm focus:outline-none focus:border-fuchsia-500 transition-all duration-200 font-mono"
                    />
                    <p className="text-sm text-gray-400 dark:text-gray-500">
                      Use the cloud URL or your self-hosted Langfuse base URL.
                    </p>
                  </div>
                </div>
              </section>

              {/* Theme */}
              <section className="rounded-xl px-0 pb-6 md:p-6 md:bg-gray-50 dark:md:bg-gray-800/50">
                <div className="flex items-center gap-3 mb-5">
                  <div className="h-9 w-9 rounded-lg min-w-9 bg-amber-500 flex items-center justify-center">
                    <Sun size={18} className="text-white" />
                  </div>
                  <div>
                    <h2 className="font-700 text-gray-900 dark:text-gray-100">Theme</h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Applied immediately and saved per-browser (no Save needed)
                    </p>
                  </div>
                </div>
                <div className="flex rounded-lg overflow-hidden border-2 border-gray-200 dark:border-gray-600">
                  {(
                    [
                      { value: 'light', label: 'Light', Icon: Sun },
                      { value: 'dark', label: 'Dark', Icon: Moon },
                      { value: 'system', label: 'System', Icon: Monitor },
                    ] as const
                  ).map(({ value, label, Icon }, i) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => applyTheme(value)}
                      className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-600 transition-colors ${
                        i > 0 ? 'border-l-2 border-gray-200 dark:border-gray-600' : ''
                      } ${
                        theme === value
                          ? 'bg-amber-500 text-white'
                          : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600'
                      }`}
                    >
                      <Icon size={15} />
                      {label}
                    </button>
                  ))}
                </div>
              </section>

              {/* Navigation */}
              <section className="rounded-xl px-0 pb-6 md:p-6 md:bg-gray-50 dark:md:bg-gray-800/50">
                <div className="flex items-center gap-3 mb-5">
                  <div className="h-9 w-9 rounded-lg min-w-9 bg-blue-500 flex items-center justify-center">
                    <BookOpen size={18} className="text-white" />
                  </div>
                  <div>
                    <h2 className="font-700 text-gray-900 dark:text-gray-100">Navigation</h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Choose which learning shortcuts appear in the sidebar
                    </p>
                  </div>
                </div>
                <div className="space-y-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-600 text-gray-700 dark:text-gray-300">
                        Show Learn in sidebar
                      </p>
                      <p className="text-sm text-gray-400 dark:text-gray-500 mt-0.5">
                        Hide this after finishing the curriculum, then re-enable it here anytime
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowLearnNav((v) => !v)}
                      className={`relative flex-shrink-0 h-6 w-11 rounded-full transition-colors duration-200 focus:outline-none ${showLearnNav ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${showLearnNav ? 'translate-x-5' : 'translate-x-0'}`}
                      />
                    </button>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-600 text-gray-700 dark:text-gray-300">
                        Tool Playground
                      </p>
                      <p className="text-sm text-gray-400 dark:text-gray-500 mt-0.5">
                        Enable the Tool Playground page for testing tools interactively
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setToolPlayground((v) => !v)}
                      className={`relative flex-shrink-0 h-6 w-11 rounded-full transition-colors duration-200 focus:outline-none ${
                        toolPlayground ? 'bg-amber-500' : 'bg-gray-300 dark:bg-gray-600'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${
                          toolPlayground ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </section>

              {/* New Chat Layout */}
              <section className="rounded-xl px-0 pb-6 md:p-6 md:bg-gray-50 dark:md:bg-gray-800/50">
                <div className="flex items-center gap-3 mb-5">
                  <div className="h-9 w-9 rounded-lg min-w-9 bg-indigo-500 flex items-center justify-center">
                    <Layout size={18} className="text-white" />
                  </div>
                  <div>
                    <h2 className="font-700 text-gray-900 dark:text-gray-100">New Chat Layout</h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Choose which sections appear on the new chat screen and their order
                    </p>
                  </div>
                </div>

                {/* Drag-to-reorder with inline toggles */}
                <div className="space-y-1.5">
                  {newChatSectionOrder.map((id) => {
                    const meta: Record<
                      string,
                      { label: string; value: boolean; set: (v: boolean) => void }
                    > = {
                      suggestions: {
                        label: 'Suggested Prompts',
                        value: newChatShowSuggestions,
                        set: setNewChatShowSuggestions,
                      },
                      pinned_chat: {
                        label: 'Pinned Chat',
                        value: newChatShowPinnedChat,
                        set: setNewChatShowPinnedChat,
                      },
                      pinned_prompt: {
                        label: 'Pinned Prompts',
                        value: newChatShowPinnedPrompt,
                        set: setNewChatShowPinnedPrompt,
                      },
                    };
                    const { label, value, set } = meta[id] ?? {
                      label: id,
                      value: true,
                      set: () => {},
                    };
                    return (
                      <div
                        key={id}
                        draggable
                        onDragStart={(e) => handleDragStart(e, id)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => handleDrop(e, id)}
                        onDragEnd={() => setDraggingSection(null)}
                        className={`flex items-center gap-3 px-3 py-2.5 bg-white dark:bg-gray-700 rounded-lg border border-gray-200 dark:border-gray-600 cursor-grab active:cursor-grabbing transition-opacity ${draggingSection === id ? 'opacity-40' : 'opacity-100'}`}
                      >
                        <GripVertical size={15} className="text-gray-400 flex-shrink-0" />
                        <span className="flex-1 text-sm text-gray-700 dark:text-gray-200">
                          {label}
                        </span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={value}
                          onClick={(e) => {
                            e.stopPropagation();
                            set(!value);
                          }}
                          className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${value ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                        >
                          <span
                            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${value ? 'translate-x-4.5' : 'translate-x-0.5'}`}
                          />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* Save button — single commit point for everything above
                  except Theme (which is browser-local and applies immediately). */}
              <div className="sticky bottom-0 -mx-8 px-8 py-4 bg-gradient-to-t from-white via-white/95 to-white/0 dark:from-gray-900 dark:via-gray-900/95 dark:to-gray-900/0 z-10">
                <Button
                  variant="primary"
                  size="lg"
                  onClick={handleSave}
                  loading={saving}
                  className="w-full shadow-lg"
                >
                  {saved ? (
                    <>
                      <Check size={16} /> Saved!
                    </>
                  ) : (
                    <>
                      <Save size={16} /> Save Settings
                    </>
                  )}
                </Button>
              </div>

              {/* Info box */}
              <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-900 rounded-xl p-5 text-sm text-blue-700 dark:text-blue-300">
                <p className="font-700 mb-1.5">Deployment tip</p>
                <p>
                  All persistent data (database, memory, agents, skills) is stored in the{' '}
                  <code className="font-mono bg-blue-100 dark:bg-blue-900/50 px-1 rounded">
                    /data
                  </code>{' '}
                  directory. Mount this directory as a volume on server to persist data across
                  restarts.
                </p>
              </div>

              {/* ── Danger Zone ────────────────────────────────────────────
                  Last section on the page (after Save Settings + the info
                  tip) so it's visually separated from the routine settings.
                  Red border emphasizes that everything inside is
                  destructive. */}
              <section className="bg-red-50/60 dark:bg-red-950/20 border border-red-200 dark:border-red-900/60 rounded-xl p-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="h-9 w-9 rounded-lg min-w-9 bg-red-500 flex items-center justify-center">
                    <AlertTriangle size={18} className="text-white" />
                  </div>
                  <div>
                    <h2 className="font-700 text-gray-900 dark:text-gray-100">Danger Zone</h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Restore individual parts of AgentPrimer — or wipe everything and start fresh.
                    </p>
                  </div>
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                  <strong>Reset Default</strong> overwrites the items you select with the bundled
                  defaults shipped with this build. <strong>Reset to original</strong> additionally
                  deletes your user account, chats, settings, and uploaded files — effectively a
                  factory reset. These actions cannot be undone.
                </p>
                {resetErr && (
                  <div className="mb-3 text-sm text-red-700 dark:text-red-300 bg-red-100 dark:bg-red-900/40 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2">
                    Reset failed: {resetErr}
                  </div>
                )}
                <Button variant="danger" size="md" onClick={openResetPicker} loading={resetRunning}>
                  <RotateCcw size={14} /> Reset Default…
                </Button>
              </section>
            </>
          )}
        </div>
        {/* end inner centered content */}
      </div>
      {/* end outer scroll container */}

      {/* ── Reset picker dialog (Stage 1) ──────────────────────────────
            Inline dialog (not the shared Modal) because we need a red
            danger framing and custom checkbox list. Clicking the backdrop
            cancels. */}
      {resetPickerOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={() => setResetPickerOpen(false)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <div className="h-9 w-9 rounded-lg min-w-9 bg-red-500 flex items-center justify-center">
                <RotateCcw size={18} className="text-white" />
              </div>
              <div>
                <h2 className="font-700 text-gray-900 dark:text-gray-100">Reset Default</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Pick what to restore from defaults
                </p>
              </div>
            </div>
            <div className="px-6 py-4 space-y-3 max-h-[60vh] overflow-y-auto">
              <ResetCheck
                label="System prompt"
                hint="data/system.md"
                checked={resetFull || resetSystem}
                disabled={resetFull}
                onChange={setResetSystem}
              />
              <ResetCheck
                label="All agents"
                hint="data/agents/ — resets every bundled agent folder"
                checked={resetFull || resetAgents}
                disabled={resetFull || resetSingleAgent}
                onChange={setResetAgents}
              />
              <ResetCheck
                label="Single agent"
                hint="Reset one bundled agent folder"
                checked={resetFull || resetSingleAgent}
                disabled={resetFull || resetAgents}
                onChange={setResetSingleAgent}
              />
              {resetSingleAgent && !resetFull && !resetAgents && (
                <select
                  value={resetAgentName}
                  onChange={(e) => setResetAgentName(e.target.value)}
                  className="ml-6 h-9 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-gray-100"
                >
                  {resetAgentNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
              <ResetCheck
                label="MCP servers"
                hint="Removes ALL installed MCP servers; restores only the bundled defaults"
                checked={resetFull || resetMcp}
                disabled={resetFull}
                onChange={setResetMcp}
              />
              <ResetCheck
                label="Skills"
                hint="Removes ALL installed skills; restores only the bundled defaults"
                checked={resetFull || resetSkills}
                disabled={resetFull}
                onChange={setResetSkills}
              />
              <ResetCheck
                label="Function tools"
                hint="Removes ALL installed function tools; restores only the bundled defaults"
                checked={resetFull || resetFunctionTools}
                disabled={resetFull}
                onChange={setResetFunctionTools}
              />
              <div className="border-t border-gray-200 dark:border-gray-700 pt-3 mt-3">
                <ResetCheck
                  label="Reset to original (full factory reset)"
                  hint="Also deletes your user account, all chats, API keys, and uploads. You will be logged out."
                  checked={resetFull}
                  onChange={setResetFull}
                  accent="danger"
                />
              </div>
            </div>
            <div className="px-6 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setResetPickerOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleResetContinue}
                disabled={!checkedAny}
              >
                Continue
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Stage 2 confirm dialog — rendered by the useConfirm hook. */}
      {ResetConfirmModal}
    </main>
  );
}

/**
 * Single checkbox row in the Reset picker. Built locally instead of a
 * shared component because (a) there's no <Checkbox> in components/ui/
 * and (b) the row layout (label + hint + optional danger accent) is
 * specific to this picker.
 */
function ResetCheck({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
  accent = 'default',
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  accent?: 'default' | 'danger';
}) {
  return (
    <label
      className={`flex items-start gap-2 cursor-pointer select-none ${
        disabled ? 'opacity-50 cursor-not-allowed' : ''
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className={`mt-1 h-4 w-4 rounded border-gray-300 dark:border-gray-600 ${
          accent === 'danger'
            ? 'text-red-500 focus:ring-red-500'
            : 'text-blue-500 focus:ring-blue-500'
        } disabled:cursor-not-allowed`}
      />
      <span className="min-w-0">
        <span
          className={`block text-sm font-600 ${
            accent === 'danger'
              ? 'text-red-700 dark:text-red-300'
              : 'text-gray-900 dark:text-gray-100'
          }`}
        >
          {label}
        </span>
        {hint && (
          <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">{hint}</span>
        )}
      </span>
    </label>
  );
}
