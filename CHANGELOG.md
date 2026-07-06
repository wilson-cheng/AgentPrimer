# Changelog

All notable changes to AgentPrimer will be documented in this file.

This project follows a lightweight release-notes process until the first stable release.

## [Unreleased]

### Added

- **Detached background run management.** The agent loop now runs as a floating background promise via `lib/agent/run-manager.ts`, decoupled from the HTTP response. Closing the browser mid-stream no longer kills the run — it keeps going, checkpoints partial progress to SQLite after every step, and a later reopen polls `/api/chat/active`, re-attaches a tail, or (if the run already finished) loads the persisted result from the DB. New endpoints: `GET /api/chat/active` (is a run live?), `POST /api/chat/stop` (the Stop button — the only thing that cancels a run, via `AbortController`). One active run per (owner, session) is enforced server-side (409 `RUN_IN_PROGRESS`). A 30-minute wall-clock watchdog force-aborts hung runs. See [Module 04 → Detached Run Manager](docs/04-streaming.md#detached-run-manager).

- **Lazy message traces + cursor pagination.** The message reader (`GET /api/messages`) now supports `limit` / `before` / `after` cursor params and deliberately omits the multi-MB `trace_json` field (ships only a `has_trace` flag). A new `GET /api/messages/trace?messageId=<uuid>` endpoint fetches the full trace on demand when the Trace Drawer is opened. The `useChat` request body is trimmed via `buildChatRequestBody` so a "hi" follow-up no longer ships 15 MB of UI-only fields. Together these eliminate the large-session slowdown (browser crashes, 400 "Invalid request body").

- **`pickMessageParts` for historical rendering.** From-DB messages now render tool calls in their original interleaved order instead of being collapsed to the legacy fixed-order path. `components/chat/helpers.ts` prefers the persisted `parts_raw` snapshot whenever it is populated, so tool-call bubbles no longer jump to the bottom after navigating away from a session and back.

- **Advanced model parameters with user-editable overrides.** Settings → Advanced now exposes per-model context-window and max-output-tokens overrides, persisted as `model_context_overrides` / `model_output_overrides` JSON maps in the `settings` table. An override wins over both the provider-fetched value and the built-in lookup table. The DB-backed logic lives in `lib/agent/model-overrides.ts` (server-only; `clearModelOverrideCache()` must be called after saving).

- **Per-MCP-server environment variables.** Each row in the `mcp_servers` table gains an `env_json` column, surfaced in the Skills/MCP install + edit modals as a `KEY=value`-per-line textarea. Values are forwarded only to that one server's stdio subprocess; they are NOT exposed to other MCP servers, to function tools, or to the agent itself. Values are never sent back to the browser — the API returns only `env_keys` (a list of variable names) so the UI can show "currently configured: GITHUB_TOKEN" without revealing the token. This is the recommended way to give a single MCP server its own credential (e.g. `GITHUB_TOKEN` for the github MCP server); the global `MCP_FORWARD_ENV` env var remains available as a fleet-wide allow-list when many servers share the same variable. `AGENT_PRIMER_SECRET` / `AGENTPRIMER_SECRET` / `CODE_SERVER_PASSWORD` are denied at the per-server layer even if listed. Per-server env survives transport toggles (stdio ↔ sse), and a UI confirm() warns before losing forwarding by switching a configured stdio server to SSE.

- **Dedicated sandboxed preview route.** `GET /api/preview/[...slug]` serves files from `data/preview/` only, intentionally unauthenticated so sandboxed iframes (opaque origin, no cookies) can load subresources. The security boundary is directory scope via `resolvePreviewPath` + symlink realpath check. Source code, the SQLite database, memory files, and everything else under `data/` are structurally unreachable. `data/projects/` working dirs are mirrored into `data/preview/` on demand for legacy preview history.

### Removed

- **Settings → Environment Variables editor.** The free-form `data/.env` textarea has been removed from the Settings page. It misled operators into believing the keys typed there would reach MCP servers — which is no longer true under the new allow-list. `data/.env` itself is still read at startup by `lib/bootstrap.ts` for infrastructure variables (`AGENT_PRIMER_SECRET`, `LANGFUSE_*`, `EMBED_MODEL`, `EMBED_CACHE_DIR`); edit it on disk if you need those. For MCP server credentials, use Skills/MCP → server → Edit → Environment variables. The onboarding wizard's web-search step now writes `EXA_API_KEY` directly to the Exa MCP server's `env_json` so the subprocess actually receives it.

### Changed (breaking)

- **MCP server environment is now an allow-list, not an inherit-everything.** Third-party MCP servers (cloned from GitHub) used to receive a near-copy of the AgentPrimer process's `process.env`, which leaked operator secrets (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `GITHUB_TOKEN`, `EXA_API_KEY`, database URLs, …) to every server. Subprocesses now receive only a small allow-list (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `PWD`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TERM`, `NODE_ENV`, `NODE_PATH`, `NODE_OPTIONS`, `NPM_CONFIG_PREFIX`, `NPM_CONFIG_CACHE`, `PYTHONPATH`, `PYTHONIOENCODING`, `TERM_PROGRAM`, `COLORTERM`). To expose additional variables, set `MCP_FORWARD_ENV` to a comma- or whitespace-separated list of variable names — for example:

  ```bash
  export MCP_FORWARD_ENV="GITHUB_TOKEN,BRAVE_API_KEY,SLACK_BOT_TOKEN"
  ```

  Existing MCP servers that read credentials from env vars will stop working until those variable names are added to `MCP_FORWARD_ENV`. AgentPrimer's own `AGENT_PRIMER_SECRET` / `AGENTPRIMER_SECRET` / `CODE_SERVER_PASSWORD` are always denied even if listed.

- **`run_subagent_async`'s `project_folder` argument is now sandboxed to `./data/`.** Previously the model could pass any host path (e.g. `/tmp`, `/etc`) and the tool would create a `tasks/<task_id>.md` file there. The tool now resolves the requested path through `resolveAgentPath` and returns `{ error: 'project_folder must be inside ./data/ (got "…")' }` if the resolution lands outside `data/`. Multi-agent flows that previously passed absolute host paths must move their task folders under `data/projects/<project>/` (the convention all bundled defaults already follow).

### Fixed

- Prompt-injection sanitiser (`lib/agent/sanitize.ts`) no longer skips matches near the start of a tool result. Module-level global regexes were leaking `lastIndex` across calls via `re.test()`; the precheck has been removed so `text.replace(re, …)` runs unconditionally.
- Multimodal turns (image / audio user messages) are now preserved across follow-up turns. The useChat → OpenAI converter (`lib/agent/messages.ts`) used to `JSON.stringify` array-shaped user content, converting the second turn's view of an earlier image into a literal `'[{"type":"image_url",…}]'` string and losing the attachment.
- `run_subagent_async` task-file path is no longer arbitrary host filesystem (see breaking change above).
- A throw from `finalizeTrace` or `persistReasoning` can no longer overwrite a successful assistant row with an "incomplete" notice. `lib/agent/loop.ts` now calls `onFinish` (the assistant-row write) **before** those bookkeeping calls, and both `finalizeTrace` and `persistReasoning` are wrapped in `try/catch`.
- `getMessagesPage(sessionId, limit, before)` with `before = 0` now means "rows older than rowid 0" (an empty page) instead of silently being treated as "no cursor".
- `.users` rewrite is atomic: the file is written to a sibling temp path and `fs.renameSync`-ed into place, with cleanup of the temp file on rename failure. Concurrent legacy-MD5 upgrades during simultaneous logins can no longer corrupt the file and lock the admin out.
- `proxy.ts` public auth bypass now uses exact-or-child matching for both `PUBLIC_PATHS` and the Next.js internals (`/_next`, `/favicon`). A future route accidentally named `/login-admin-panel`, `/_next-anything`, or `/favicon-evil` can no longer bypass authentication.

### Docs

- 16 documentation files updated to match the post-refactor codebase: the agent loop now lives across `lib/agent/*.ts` (`lib/agent.ts` is a 28-line barrel), built-in tool count is **22** (was documented as 21), all stale `lib/agent.ts:<line>` citations re-routed to `lib/agent/loop.ts`, `lib/agent/streaming-agent.ts`, `lib/agent/builtin-tools.ts`, `lib/agent/finalize.ts`, `lib/agent/messages.ts`, `lib/agent/schema.ts`, `lib/agent/reasoning.ts`, `lib/agent/prompt.ts`, `lib/agent/model-resolver.ts` as appropriate. Component tree, MessageBubble props, MCP server example (Zod request schemas for `@modelcontextprotocol/sdk@^1.29`), database schema diff (`trace_json`, `lesson_progress`, ALTER vs CREATE), Langfuse call-site line numbers, test-files list, env-config story (SQLite settings, not `OPENAI_*` env vars), RAG retrieval ordering and `currentModelId` literal, and structured-output finalize-call snippet all corrected.

## [0.1.0] - 2026-06-27

Initial public open-source release.

### Added

- Hand-written ReAct agent loop with streaming, tool dispatch, and structured output.
- Three capability types: SKILL.md skills, function tools (sandboxed subprocesses), and MCP servers (stdio + SSE).
- 22 built-in tools, multi-agent orchestration, and a human-in-the-loop approval gate.
- RAG pipeline with an in-process embedding model (Transformers.js, all-MiniLM-L6-v2) and FTS5 fallback for degraded mode.
- Full Next.js 16 web UI: chat, agents/memory editor, settings, skills catalog, approvals, statistics, knowledge, tool playground, and agent-files editor.
- JWT authentication (httpOnly cookies) with bcrypt password hashing.
- 15-module learning curriculum under `docs/` with answer keys.

### Security

- Path sandboxing for all agent file access (traversal + symlink containment).
- Sandboxed-iframe CSP isolation for agent-generated HTML/SVG previews.
- Fatal startup error when `AGENT_PRIMER_SECRET` is unset in production, plus a loud warning in any non-production deployment using the public dev fallback secret.
- Constant-time comparison for legacy MD5 password hashes (auto-upgraded to bcrypt on successful login).
- In-memory login rate limiting to slow credential-stuffing and brute-force attempts.

## Release process

For each tagged release:

1. Move user-facing changes from `[Unreleased]` into a versioned section.
2. Include migration notes for database, Docker, or configuration changes.
3. Credit security reporters after coordinated disclosure, unless anonymity is requested.
