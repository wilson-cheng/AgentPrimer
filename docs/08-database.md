# Module 08 — Database

← [Frontend](./07-frontend.md) | [Back to README →](./README.md)

---

## Learning Objectives

After reading this module you will be able to:
- Explain why SQLite was chosen over Postgres/Redis for this use case
- Navigate every table in the schema and describe its purpose
- Understand WAL mode and why it matters for concurrent Next.js handlers
- Trace how a chat message is stored from streaming response to DB write
- Describe the migration strategy and how to add new columns safely
- Understand how `agent_tasks` and `agent_notifications` coordinate async sub-agents

---

## Overview

All persistent state lives in a single SQLite database file: **`data/db/agent.db`**.

- **Engine**: `better-sqlite3` (`^12.11.1`) — synchronous, zero-config, no external server
- **File**: `data/db/agent.db` (created automatically on first run)
- **WAL mode**: enabled for concurrent readers without blocking writers
- **Module**: [`lib/db.ts`](../lib/db.ts) — singleton connection, auto-migration
- **Other state on disk** (not in SQLite): `data/.users` (auth), `data/agents/<agent>/*.md`, `data/system.md`, `data/skills/`, `data/function-tools/`, `data/mcp-servers/`, `data/agent-files/`, `data/uploads/`, `data/models/`

---

## Entity Relationship Diagram

```mermaid
erDiagram
    settings {
        TEXT key PK
        TEXT value
    }

    sessions {
        TEXT id PK
        TEXT title
        TEXT agent_name
        INTEGER created_at
        INTEGER updated_at
        INTEGER pinned_chat
        TEXT pinned_prompt
        TEXT preview_state_json
    }

    messages {
        TEXT id PK
        TEXT session_id FK
        TEXT role
        TEXT content
        TEXT attachments_json
        TEXT tool_calls_json
        TEXT token_usage_json
        TEXT reasoning_json
        TEXT parts_json
        TEXT trace_json
        INTEGER created_at
    }

    skills {
        TEXT id PK
        TEXT name
        TEXT github_url
        TEXT local_path
        INTEGER enabled
        TEXT manifest_json
    }

    function_tools {
        TEXT id PK
        TEXT name
        TEXT github_url
        TEXT local_path
        INTEGER enabled
        TEXT manifest_json
    }

    mcp_servers {
        TEXT id PK
        TEXT name
        TEXT github_url
        TEXT local_path
        TEXT transport
        TEXT command
        TEXT args_json
        TEXT url
        INTEGER enabled
        TEXT env_json
    }

    permanent_approvals {
        TEXT operation PK
    }

    agent_tasks {
        TEXT id PK
        TEXT project_folder
        TEXT assigner
        TEXT assignee
        TEXT prompt
        TEXT task_file
        TEXT status
        INTEGER created_at
        INTEGER finished_at
    }

    agent_notifications {
        TEXT id PK
        TEXT session_id
        TEXT task_id
        TEXT task_file
        TEXT summary
        INTEGER created_at
        INTEGER read_at
    }

    lesson_progress {
        TEXT username PK
        TEXT lesson_slug PK
        TEXT status
        INTEGER quiz_score
        INTEGER quiz_total
        INTEGER updated_at
        INTEGER completed_at
    }

    knowledge_sources {
        INTEGER id PK
        TEXT name
        TEXT source_type
        TEXT content_md5
        TEXT embedding_model
        INTEGER chunk_count
        INTEGER ingested_at
        TEXT original_content
        BLOB original_blob
        TEXT original_mime
    }

    knowledge_chunks {
        INTEGER id PK
        INTEGER source_id FK
        INTEGER chunk_index
        TEXT chunk_text
        TEXT embedding
        INTEGER created_at
    }

    token_usage_log {
        TEXT id PK
        TEXT day
        INTEGER input
        INTEGER cached
        INTEGER output
        INTEGER created_at
    }

    sessions ||--o{ messages : "has many"
    agent_tasks ||--o{ agent_notifications : "generates"
    knowledge_sources ||--o{ knowledge_chunks : "has many chunks"
```

---

## Table Reference

### `settings`

Key/value configuration store. Read by the agent (settings come into `lib/agent/openai-client.ts`, `lib/agent/streaming-agent.ts`, and `lib/agent/model-resolver.ts`) on every request to get the API key, endpoint, and default model.

| Key | Seeded default | Description |
|-----|----------------|-------------|
| `endpoint` | `""` | Base URL for OpenAI-compatible API; configured by the operator during setup |
| `api_key` | `""` | API key (blank = unauthenticated local API) |
| `default_model` | _not seeded_ | Operator-picked model. The agent emits a friendly streamed message linking to `/settings` until this is set. |
| `embedding_provider` | `"local"` | `'local'` (in-process model) or `'openai'` |
| `max_agent_steps` | _not seeded_ | Max ReAct loop iterations before forced stop. If the setting is absent the agent loop hard-codes `100` (see `lib/agent/streaming-agent.ts`). |
| `context_keep_pairs` | _not seeded_ | Sliding-window compaction size; `0` (or unset) disables compaction. |
| `tracing_enabled` | _not seeded_ | `'1'` enables per-step trace capture. |
| `reasoning:<sessionId>` | — | Last `reasoning_content` for a session (thinking models) |
| `builtin_tool_enabled:<id>` | — | `'1'` or `'0'` per tool (e.g. `builtin_tool_enabled:run_shell`) |
| `model_details` | _not seeded_ | JSON map of `{ modelId: { context_length, max_output_tokens } }` fetched from the provider's `/v1/models` endpoint and cached so the Settings → Advanced panel can show defaults. |
| `model_context_overrides` | _not seeded_ | JSON map of `{ modelId: number }` — user-editable context-window override that wins over both the provider-fetched value and the built-in lookup table. Read & cached by `lib/agent/model-overrides.ts`. |
| `model_output_overrides` | _not seeded_ | JSON map of `{ modelId: number }` — user-editable max-output-tokens override (same priority chain as context). |

Any additional keys can be stored and retrieved with `getSetting(key)` / `setSetting(key, value)`.

### `sessions`

One row per chat session.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID generated by the client |
| `title` | TEXT | Auto-set from the first user message (first 60 chars) |
| `agent_name` | TEXT | Agent used for this session (from data/agents/<agent>/agent.md) |
| `created_at` | INTEGER | Unix timestamp |
| `updated_at` | INTEGER | Updated on each new message (for sorting) |
| `pinned_chat` | INTEGER | `1` when pinned in the sidebar |
| `pinned_prompt` | TEXT | Optional pinned prompt text for the session |
| `preview_state_json` | TEXT | JSON `{ open, file, history, index }` — persisted Preview Panel state so it survives page reloads |

### `messages`

One row per chat message.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `session_id` | TEXT FK | References `sessions.id` (CASCADE DELETE) |
| `role` | TEXT | `'user'`, `'assistant'`, `'tool'`, or `'system'` |
| `content` | TEXT | Full message text |
| `attachments_json` | TEXT | JSON array of `{ name, url, mime, size }` |
| `tool_calls_json` | TEXT | JSON array of `{ toolName, args, result }` — the agent's tool trace |
| `token_usage_json` | TEXT | JSON `{ input, cached, output }` — token counts for this turn |
| `reasoning_json` | TEXT | Raw `reasoning_content` from the model (thinking models like DeepSeek R1) |
| `parts_json` | TEXT | AI SDK `parts[]` array serialized as JSON — used to restore structured output panels after page reload |
| `trace_json` | TEXT | Agent trace events for richer historical rendering |
| `created_at` | INTEGER | Unix timestamp |

The `tool_calls_json` column stores the complete tool call history for each assistant message. This is used to re-render historical tool calls in the `MessageBubble` component after page load.

The `parts_json` column is written by the AI SDK's `onFinish` callback. It stores structured output data in a format that the `MessageBubble` component can restore when loading chat history.

### `skills`

Installed SKILL.md skill packages (instruction modules, not callable tools).

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `name` | TEXT UNIQUE | Skill name (from SKILL.md frontmatter) |
| `github_url` | TEXT | Original GitHub URL |
| `local_path` | TEXT | Absolute path to cloned directory |
| `enabled` | INTEGER | `1` = active, `0` = disabled |
| `manifest_json` | TEXT | Raw SKILL.md content as JSON string |

### `function_tools`

Installed function tool packages (callable code — `function.json` + `index.js`).

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `name` | TEXT UNIQUE | Tool name (from `function.json` `name` field) |
| `github_url` | TEXT | Original GitHub URL |
| `local_path` | TEXT | Absolute path to cloned directory |
| `enabled` | INTEGER | `1` = active, `0` = disabled |
| `manifest_json` | TEXT | Full `function.json` contents as JSON string |

### `mcp_servers`

Installed MCP server configs.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `name` | TEXT UNIQUE | Server name |
| `github_url` | TEXT | Source repo |
| `local_path` | TEXT | Cloned directory (stdio) or empty (SSE) |
| `transport` | TEXT | `'stdio'` or `'sse'` |
| `command` | TEXT | Executable for stdio (e.g. `node`) |
| `args_json` | TEXT | JSON array of arguments (e.g. `["server.js"]`) |
| `url` | TEXT | Base URL for SSE transport |
| `enabled` | INTEGER | `1` = active, `0` = disabled |
| `env_json` | TEXT | JSON object of per-server env vars forwarded to the stdio subprocess (e.g. `{"GITHUB_TOKEN":"ghp_…"}`). Empty `{}` for SSE servers. Added via `ALTER TABLE` on existing installs. |

### `permanent_approvals`

One row per permanently approved operation. Current operation keys are `'delete'`, `'read_dotfile'`, and `'run_shell'`.

| Column | Type | Description |
|--------|------|-------------|
| `operation` | TEXT PK | Operation key (e.g. `'delete'`, `'read_dotfile'`) |

### `agent_tasks` *(new)*

Index table for async sub-agent tasks. The full execution log lives in a Markdown task file at the path stored in `task_file`.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `project_folder` | TEXT | Working directory for the task |
| `assigner` | TEXT | Agent name that launched this task |
| `assignee` | TEXT | Agent name executing the task |
| `prompt` | TEXT | The instruction given to the sub-agent |
| `task_file` | TEXT | Absolute path to the task `.md` file |
| `status` | TEXT | `'running'` → `'finished'` / `'error'` / `'interrupted'` |
| `created_at` | INTEGER | Unix timestamp |
| `finished_at` | INTEGER | Unix timestamp (null while running) |

**`'interrupted'` status:** On server restart, `migrate()` sets all `'running'` tasks to `'interrupted'`. This signals that the sub-agent was killed mid-execution and the task file may be incomplete.

### `agent_notifications` *(new)*

Queued notifications delivered to a parent session when an async task completes. Unread notifications are injected into the system prompt on the parent's next turn.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `session_id` | TEXT | Parent session that should receive this notification (no schema-level FK; application convention) |
| `task_id` | TEXT | Application-level reference to `agent_tasks.id` (no schema-level FK) |
| `task_file` | TEXT | Path to the task file for the parent to read |
| `summary` | TEXT | One-line human-readable completion summary |
| `created_at` | INTEGER | Unix timestamp |
| `read_at` | INTEGER | Set when the parent has seen this notification (null = unread) |

### `lesson_progress`

Per-user progress for the in-app learning curriculum (`/learn` and `/learn/[slug]`).

| Column | Type | Description |
|--------|------|-------------|
| `username` | TEXT | First half of the composite primary key |
| `lesson_slug` | TEXT | Lesson identifier, second half of the composite primary key |
| `status` | TEXT | `'not_started'` / `'in_progress'` / `'completed'` (CHECK-constrained) |
| `quiz_score` | INTEGER | Most recent quiz score (nullable) |
| `quiz_total` | INTEGER | Total quiz questions for that lesson (nullable) |
| `updated_at` | INTEGER | Unix timestamp of the most recent change |
| `completed_at` | INTEGER | Unix timestamp when first marked `completed` (nullable) |

---

### `knowledge_sources`

One row per ingested document in the RAG.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `name` | TEXT | Display name (e.g. "Q3 Roadmap.pdf") |
| `source_type` | TEXT | `'file_upload'`, `'paste'`, or `'memory'` |
| `content_md5` | TEXT | MD5 of source content — used to skip re-ingestion when unchanged |
| `embedding_model` | TEXT | Embedding model/provider used for this source |
| `chunk_count` | INTEGER | Number of chunks produced during ingestion |
| `ingested_at` | INTEGER | Unix timestamp |
| `original_content` | TEXT | Original document text for text/markdown/html sources — used by the View panel for inline rendering |
| `original_blob` | BLOB | Original binary bytes (e.g. PDFs) — used by the View panel for iframe rendering |
| `original_mime` | TEXT | MIME type of the original document (e.g. `text/markdown`, `application/pdf`) — drives how the View panel renders it |

### `knowledge_chunks`

One row per text chunk from each source. Each source is split into ~1600-char overlapping chunks.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `source_id` | INTEGER FK | References `knowledge_sources.id` (CASCADE DELETE) |
| `chunk_index` | INTEGER | Position within the source (0-based) |
| `chunk_text` | TEXT | The actual text of the chunk |
| `embedding` | TEXT | JSON float array (e.g. `"[0.023, -0.104, ...]"`) — null until embedded |
| `created_at` | INTEGER | Unix timestamp |

Cosine similarity is computed in JavaScript at retrieval time by loading all embeddings into memory. Scales to ~50k chunks without performance issues. For larger collections, replace with the `sqlite-vec` extension.

### `knowledge_fts` (FTS5 virtual table)

Full-text search index over `knowledge_chunks`. Used as a fallback when no embeddings are available (e.g., when the local embedding model can't load).

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  chunk_text,
  content='knowledge_chunks',
  content_rowid='id'
);
```

The FTS5 table provides keyword-based search (BM25 ranking) without requiring an embedding model. The `search_knowledge_base` tool automatically falls back to FTS5 if vector search returns no results.

### `token_usage_log`

One row per agent turn, logging token consumption for the Statistics page.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Assistant message ID; prevents double-counting on backfill |
| `day` | TEXT | Local calendar day (`YYYY-MM-DD`) used for chart grouping |
| `input` | INTEGER | Prompt tokens consumed |
| `cached` | INTEGER | Prompt tokens served from the model's cache (cheaper) |
| `output` | INTEGER | Completion tokens generated |
| `created_at` | INTEGER | Unix timestamp |

Aggregated by the Statistics page (`/api/statistics`) to render Recharts bar charts for 7, 30, 90, or 365-day windows. Rows are append-only and are not deleted when sessions or messages are deleted.

---

## Full Schema SQL

> **Note:** The Full Schema SQL below is the **logical** end-state of all `CREATE TABLE` + `ALTER TABLE … ADD COLUMN` migrations in `lib/db.ts`. The actual `lib/db.ts` `CREATE TABLE` statements are narrower; later columns (e.g. `messages.token_usage_json`, `messages.reasoning_json`, `messages.parts_json`, `messages.trace_json`, `sessions.pinned_chat`, `sessions.pinned_prompt`, `sessions.preview_state_json`, `knowledge_sources.original_*`) are added by guarded `ALTER TABLE` statements during `migrate()`. New installs end up with the schema below; upgraded installs reach it via the ALTERs. See "Migration Strategy" below.

```sql
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL DEFAULT 'New Chat',
  agent_name         TEXT NOT NULL DEFAULT 'main',
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  pinned_chat        INTEGER NOT NULL DEFAULT 0,   -- added by ALTER
  pinned_prompt      TEXT,                          -- added by ALTER
  preview_state_json TEXT NOT NULL DEFAULT '{}'     -- added by ALTER
);

CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
  content          TEXT NOT NULL DEFAULT '',
  attachments_json TEXT NOT NULL DEFAULT '[]',
  tool_calls_json  TEXT NOT NULL DEFAULT '[]',
  token_usage_json TEXT NOT NULL DEFAULT '{}',     -- added by ALTER
  reasoning_json   TEXT NOT NULL DEFAULT '',       -- added by ALTER
  parts_json       TEXT NOT NULL DEFAULT '[]',     -- added by ALTER
  trace_json       TEXT NOT NULL DEFAULT '[]',     -- added by ALTER
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE TABLE IF NOT EXISTS skills (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  github_url    TEXT NOT NULL,
  local_path    TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  manifest_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS function_tools (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  github_url    TEXT NOT NULL,
  local_path    TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  manifest_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  github_url  TEXT NOT NULL,
  local_path  TEXT NOT NULL,
  transport   TEXT NOT NULL DEFAULT 'stdio',
  command     TEXT NOT NULL DEFAULT '',
  args_json   TEXT NOT NULL DEFAULT '[]',
  url         TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  env_json    TEXT NOT NULL DEFAULT '{}'   -- added by ALTER on upgrade
);

CREATE TABLE IF NOT EXISTS permanent_approvals (
  operation TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  source_type      TEXT NOT NULL DEFAULT 'file_upload',
  content_md5      TEXT,
  embedding_model  TEXT,
  chunk_count      INTEGER NOT NULL DEFAULT 0,
  ingested_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  original_content TEXT,    -- added by ALTER (RAG View panel)
  original_blob    BLOB,    -- added by ALTER
  original_mime    TEXT     -- added by ALTER
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id          INTEGER PRIMARY KEY,
  source_id   INTEGER NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  chunk_text  TEXT NOT NULL,
  embedding   TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  chunk_text,
  content='knowledge_chunks',
  content_rowid='id'
);

-- Async sub-agent task index
CREATE TABLE IF NOT EXISTS agent_tasks (
  id             TEXT PRIMARY KEY,
  project_folder TEXT NOT NULL DEFAULT '',
  assigner       TEXT NOT NULL DEFAULT '',
  assignee       TEXT NOT NULL DEFAULT '',
  prompt         TEXT NOT NULL DEFAULT '',
  task_file      TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'running',
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at    INTEGER
);

-- Notifications from async tasks back to parent sessions
CREATE TABLE IF NOT EXISTS agent_notifications (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  task_file  TEXT NOT NULL DEFAULT '',
  summary    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  read_at    INTEGER
);

CREATE TABLE IF NOT EXISTS token_usage_log (
  id         TEXT PRIMARY KEY,
  day        TEXT NOT NULL,
  input      INTEGER NOT NULL DEFAULT 0,
  cached     INTEGER NOT NULL DEFAULT 0,
  output     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS lesson_progress (
  username     TEXT NOT NULL,
  lesson_slug  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'not_started'
                 CHECK(status IN ('not_started','in_progress','completed')),
  quiz_score   INTEGER,
  quiz_total   INTEGER,
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER,
  PRIMARY KEY (username, lesson_slug)
);
```

---

## WAL Mode and Concurrency

```mermaid
sequenceDiagram
    participant Writer
    participant WAL_File as WAL file
    participant DB_File as Main DB file
    participant Reader

    Writer->>WAL_File: Write new page (non-blocking)
    Reader->>DB_File: Read old page (not blocked)
    Reader->>WAL_File: Check WAL for newer version
    Note over Writer,Reader: Readers and writers don't block each other
    Writer->>DB_File: Checkpoint: flush WAL → main DB
```

**WAL (Write-Ahead Logging)** allows concurrent reads during writes. This is important because:
- The streaming agent writes to the DB in `onFinish` while the browser may still be sending the last few bytes
- The sidebar polls `/api/sessions` while a chat is in progress

**`busy_timeout = 5000`** means SQLite will retry for up to 5 seconds before throwing `SQLITE_BUSY`. This prevents race conditions during brief write conflicts.

---

## `lib/db.ts` Helper Functions

### Settings

```typescript
getSetting(key: string): string
setSetting(key: string, value: string): void
getAllSettings(): Record<string, string>
```

### Sessions

```typescript
createSession(id, title, agentName?): Session
getSession(id): Session | undefined
listSessions(): Session[]
updateSessionTitle(id, title): void
updateSessionAgent(id, agentName): void
touchSession(id): void            // updates updated_at timestamp
deleteSession(id): void           // cascades to messages
pinSessionChat(id, pinned): void  // pin/unpin in sidebar
setPinnedPrompt(id, text): void   // set pinned prompt text
updateSessionPreviewState(id, previewStateJson): void // persist Preview Panel state
getFirstUserMessage(sessionId): string | null
```

### Messages

```typescript
saveMessage(msg: Omit<Message, 'created_at'>): void
upsertAssistantMessage(msg): void   // checkpoint write — used during streaming AND per-step in the detached loop
getMessages(sessionId): Message[]                    // legacy: all messages (avoid for long sessions)
getMessagesPage(sessionId, opts): Message[]          // cursor-paginated reads (limit + before cursor)
getMessagesAfter(sessionId, afterRowid, limit?): Message[]  // tail polling / post-stream catch-up
getMessageTrace(messageId): string | null            // on-demand trace_json for a single message (lazy load)
countMessages(sessionId): number
```

> **Why `getMessageTrace` is separate:** The paginated readers (`getMessagesPage` / `getMessagesAfter`) deliberately **omit** `trace_json` — a single multi-step assistant message can persist a multi-MB trace. Shipping it on every session-load / poll was the root cause of the large-session slowdown. The list readers ship only a `has_trace` flag; the Trace Drawer fetches the full trace on demand via `GET /api/messages/trace?messageId=<uuid>`.

### Skills, Function Tools & MCP Servers

```typescript
listSkills(): Skill[]
upsertSkill(skill): void
setSkillEnabled(id, enabled): void
deleteSkill(id): void

listFunctionTools(): FunctionTool[]
upsertFunctionTool(tool): void
setFunctionToolEnabled(id, enabled): void
deleteFunctionTool(id): void

listMcpServers(): McpServer[]
upsertMcpServer(server): void
setMcpServerEnabled(id, enabled): void
deleteMcpServer(id): void
```

---

## Migration Strategy

The `migrate()` function in `lib/db.ts` runs on every cold start using `CREATE TABLE IF NOT EXISTS`. This is an **additive-only** migration strategy:

- **New tables**: safe to add in any deploy — `IF NOT EXISTS` makes it idempotent
- **New columns**: require `ALTER TABLE … ADD COLUMN` executed after the `CREATE TABLE` block
- **Column removal / rename**: not supported by SQLite directly; requires `CREATE TABLE new … AS SELECT …` + rename

### Adding a Column Safely

The `token_usage_json` column was added to `messages` after the initial schema was deployed. The approach in `lib/db.ts`:

```typescript
// Check whether the column already exists (PRAGMA returns all columns)
const msgCols = (db.prepare('PRAGMA table_info(messages)').all() as {name:string}[]).map(c => c.name);
if (!msgCols.includes('token_usage_json')) {
  db.exec("ALTER TABLE messages ADD COLUMN token_usage_json TEXT NOT NULL DEFAULT '{}'");
}
```

This guard makes the migration **idempotent** — running it on an existing DB that already has the column is safe.

- No rollback support — use the single-file SQLite backup for recovery

---

## Backup and Recovery

AgentPrimer uses SQLite WAL mode, so a live database can have recent writes in `agent.db-wal`. Do **not** back up only `agent.db` with `cp` while the app is running.

Use SQLite's online backup command for live systems:

```bash
sqlite3 data/db/agent.db ".backup data/db/agent-$(date +%F-%H%M%S).bak"
```

If the app is fully stopped, you may copy `data/db/agent.db` together with any `agent.db-wal` and `agent.db-shm` sidecar files. For Docker/Dokploy deployments, mount `data/` as a persistent volume to survive container restarts.

---

## Alternate Approaches

| Approach | Trade-off |
|----------|-----------|
| **SQLite + better-sqlite3** (AgentPrimer) | Zero-config; single file backup; synchronous API fits Next.js; not suitable for horizontal scaling |
| **PostgreSQL** | Scales horizontally; rich feature set; requires a separate server process; migrations need a proper tool (Drizzle, Prisma) |
| **Drizzle ORM** | Type-safe schema definitions; auto-generates migrations; adds abstraction layer; ideal if PostgreSQL migration is planned |
| **Prisma** | Feature-rich ORM with Studio UI; heavier; slower cold-start in serverless environments |
| **Redis** | Excellent for ephemeral state (session store, pub/sub); not suitable as a primary persistent store |
| **Plain JSON files** | Extremely simple; no query language; breaks at scale; race conditions with concurrent writes |

**Migration path to PostgreSQL:** Replace `better-sqlite3` with `pg` or `drizzle-orm/postgres-js`. The SQL schema is compatible (minor adjustments: `TEXT` → `VARCHAR`, `INTEGER` → `BIGINT` for timestamps). The helper functions in `lib/db.ts` are the only layer that needs changing.

---

## Future Expansion

1. **Full-text search on messages** — Add a virtual FTS5 table (`CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid')`) to enable fast keyword search across all chat history.

2. **Token usage analytics** — The `token_usage_log` table stores per-turn input, cached, and output token counts. The Statistics page (`/statistics`) aggregates these into Recharts bar charts, selectable by time window (7/30/90/365 days).

3. **Session export** — Add a `GET /api/sessions/<id>/export` route that dumps a session to JSON or Markdown for portability.

4. **Multi-user with row-level auth** — Add a `user_id` foreign key to `sessions` and `agent_tasks`. Filter all queries by the authenticated user ID from `proxy.ts`.

---

## Exercises

1. **Inspect the live database:** Run `sqlite3 data/db/agent.db` (requires `sqlite3` CLI). Type `.tables` to list tables. Run `SELECT * FROM settings;` to see current configuration.

2. **Count tokens:** After a few chat turns, run:
   ```sql
   SELECT SUM(json_extract(token_usage_json, '$.input')) AS total_input,
          SUM(json_extract(token_usage_json, '$.cached')) AS total_cached,
          SUM(json_extract(token_usage_json, '$.output')) AS total_output
   FROM messages WHERE role = 'assistant';
   ```

3. **Test WAL mode:** Open two SQLite connections simultaneously (`sqlite3 data/db/agent.db` in two terminals). In the first, start a long transaction (`BEGIN;`). In the second, run a SELECT. Confirm it doesn't block.

4. **Add a new column:** Add a `tags_json TEXT NOT NULL DEFAULT '[]'` column to the `sessions` table using the safe migration pattern. Restart the dev server and confirm it was added with `PRAGMA table_info(sessions)`.

---

## Further Reading

- better-sqlite3: [github.com/WiseLibs/better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- SQLite WAL mode: [sqlite.org/wal.html](https://www.sqlite.org/wal.html)
- SQLite FTS5: [sqlite.org/fts5.html](https://www.sqlite.org/fts5.html)
- Drizzle ORM: [orm.drizzle.team](https://orm.drizzle.team/)

See: [Back to README →](./README.md) | Continue to [Module 09 — Ecosystem Comparison →](./09-ecosystem-comparison.md)
