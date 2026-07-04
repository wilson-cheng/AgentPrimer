/**
 * lib/db.ts
 * ---------------------------------------------------------------------------
 * SQLite database layer using better-sqlite3 (synchronous, fast, zero-config).
 *
 * All persistent data lives inside the /data directory so that a single
 * volume-mount covers everything when deployed on Dokploy.
 *
 * Schema overview
 * ---------------
 *  settings    – key/value pairs (api_key, endpoint, default_model, …)
 *  sessions    – chat sessions (title, agent name, timestamps)
 *  messages    – individual messages per session (role, content, attachments)
 *  skills      – installed skill packages (GitHub URL, local path, manifest)
 *  mcp_servers – installed MCP servers (GitHub URL, transport type, command…)
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Path helpers – DATA_DIR is the single mount-point for persistent files
// ---------------------------------------------------------------------------
export const DATA_DIR = path.join(/* turbopackIgnore: true */ process.cwd(), 'data');
export const DB_DIR = path.join(DATA_DIR, 'db');
export const DB_PATH = path.join(DB_DIR, 'agent.db');

// Ensure the data and db directories exist at module load time
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Singleton DB connection
// Better-sqlite3 is synchronous, so a module-level singleton is safe in Node.
// ---------------------------------------------------------------------------
let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    // Ensure DB_DIR exists every time we open a connection. We previously
    // did this only at module-load time, which broke after a destructive
    // reset (POST /api/reset) deleted data/db/ in the same process: the
    // module-level mkdirSync had already run, so `new Database(DB_PATH)`
    // failed with "Cannot open database because the directory does not
    // exist" on the very next getDb() call.
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL'); // Write-ahead logging for better concurrency
    _db.pragma('busy_timeout = 5000'); // Wait up to 5s instead of throwing SQLITE_BUSY
    _db.pragma('foreign_keys = ON');
    // Checkpoint any leftover WAL data from a previous abrupt shutdown
    _db.pragma('wal_checkpoint(TRUNCATE)');
    migrate(_db);
  }
  return _db;
}

// Close the DB cleanly on process exit so the WAL/SHM files are not left dirty.
// Also exported so the `/api/reset` endpoint can close the connection before
// nuking data/db/ (deleting an open SQLite file is undefined on Windows and
// orphans inflight writes on Linux/Mac).
export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
process.on('exit', closeDb);
process.on('SIGINT', () => {
  closeDb();
  process.exit(0);
});
process.on('SIGTERM', () => {
  closeDb();
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Schema migration – idempotent (CREATE TABLE IF NOT EXISTS)
// ---------------------------------------------------------------------------
function migrate(db: Database.Database): void {
  db.exec(`
    -- Key/value config store
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    -- Chat sessions
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT 'New Chat',
      agent_name  TEXT NOT NULL DEFAULT 'main',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Chat messages (per session)
    CREATE TABLE IF NOT EXISTS messages (
      id               TEXT PRIMARY KEY,
      session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role             TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
      content          TEXT NOT NULL DEFAULT '',
      -- JSON array of { name, url, mime, size } objects for attachments
      attachments_json TEXT NOT NULL DEFAULT '[]',
      -- Raw tool call / tool result JSON for agent trace display
      tool_calls_json  TEXT NOT NULL DEFAULT '[]',
      created_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ── SKILL.md skills (agentskills.io format) ─────────────────────────────
    -- Each row represents one skill directory containing a SKILL.md file.
    -- Skills are NOT callable functions — they are instruction modules whose
    -- content is injected into the agent system prompt at startup.
    -- manifest_json stores the raw SKILL.md content for display and caching.
    CREATE TABLE IF NOT EXISTS skills (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      github_url    TEXT NOT NULL,
      local_path    TEXT NOT NULL,
      enabled       INTEGER NOT NULL DEFAULT 1,
      manifest_json TEXT NOT NULL DEFAULT '{}'
    );

    -- ── Function Tools (OpenAI function-calling format) ──────────────────────
    -- Each row represents one function-tool package: a directory containing
    -- function.json (the OpenAI function schema) and index.js (the implementation).
    -- Function tools ARE callable — the agent emits a tool_call and the server
    -- executes index.js in a subprocess, then feeds the result back to the model.
    CREATE TABLE IF NOT EXISTS function_tools (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      github_url    TEXT NOT NULL,
      local_path    TEXT NOT NULL,
      enabled       INTEGER NOT NULL DEFAULT 1,
      -- JSON content of function.json (the OpenAI function schema)
      manifest_json TEXT NOT NULL DEFAULT '{}'
    );

    -- Installed MCP servers (cloned from GitHub)
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      github_url  TEXT NOT NULL,
      local_path  TEXT NOT NULL,
      -- Transport: 'stdio' | 'sse'
      transport   TEXT NOT NULL DEFAULT 'stdio',
      -- For stdio: the command to run (e.g. "node", "python")
      command     TEXT NOT NULL DEFAULT '',
      -- JSON array of command arguments
      args_json   TEXT NOT NULL DEFAULT '[]',
      -- For SSE/HTTP: the base URL of the server
      url         TEXT NOT NULL DEFAULT '',
      enabled     INTEGER NOT NULL DEFAULT 1,
      -- JSON object of per-server environment variables (forwarded to stdio
      -- subprocesses, merged on top of the default allow-list). Added so
      -- operators can give a single MCP server its own API key without
      -- exposing that key to every other MCP server they install.
      env_json    TEXT NOT NULL DEFAULT '{}'
    );

    -- Permanently approved agent operations (delete, read_dotfile, …)
    CREATE TABLE IF NOT EXISTS permanent_approvals (
      operation TEXT PRIMARY KEY
    );

    -- RAG -----------------------------------------------
    -- One row per ingested document / data source
    CREATE TABLE IF NOT EXISTS knowledge_sources (
      id              INTEGER PRIMARY KEY,
      name            TEXT    NOT NULL UNIQUE,
      source_type     TEXT    NOT NULL DEFAULT 'file_upload',
      content_md5     TEXT,
      embedding_model TEXT,
      chunk_count     INTEGER NOT NULL DEFAULT 0,
      ingested_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      -- Original document so the RAG page's View button can re-render it.
      -- text/markdown/html → stored verbatim in original_content (TEXT).
      -- PDFs                → stored as raw bytes in original_blob (BLOB).
      -- original_mime tells the View panel which path to use.
      original_content TEXT,
      original_blob    BLOB,
      original_mime    TEXT
    );

    -- Text chunks derived from each source, with optional embedding vector
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id          INTEGER PRIMARY KEY,
      source_id   INTEGER NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      chunk_text  TEXT    NOT NULL,
      -- JSON array of floats (embedding vector), NULL when provider was unavailable
      embedding   TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- FTS5 full-text search index over chunk_text (content table → manual sync)
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      chunk_text,
      content='knowledge_chunks',
      content_rowid='id'
    );

    -- Async sub-agent task index (full append-only log lives in the task .md file)
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

    -- Pending notifications queued for parent sessions when async tasks complete
    CREATE TABLE IF NOT EXISTS agent_notifications (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      task_id    TEXT NOT NULL,
      task_file  TEXT NOT NULL DEFAULT '',
      summary    TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      read_at    INTEGER
    );

    -- Append-only token usage log – NOT deleted when sessions/messages are deleted.
    -- One row per assistant message. Primary key = message id prevents double-counting.
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
      status       TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','completed')),
      quiz_score   INTEGER,
      quiz_total   INTEGER,
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at INTEGER,
      PRIMARY KEY (username, lesson_slug)
    );
  `);

  // Any tasks that were 'running' when the server last stopped cannot resume.
  // Mark them as 'interrupted' so callers can detect the gap.
  db.exec(
    "UPDATE agent_tasks SET status = 'interrupted', finished_at = unixepoch() WHERE status = 'running'",
  );

  // Add token_usage_json column to messages if it doesn't exist (backward-compatible)
  const msgCols = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  if (!msgCols.includes('token_usage_json')) {
    db.exec("ALTER TABLE messages ADD COLUMN token_usage_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!msgCols.includes('reasoning_json')) {
    db.exec("ALTER TABLE messages ADD COLUMN reasoning_json TEXT NOT NULL DEFAULT ''");
  }
  if (!msgCols.includes('parts_json')) {
    db.exec("ALTER TABLE messages ADD COLUMN parts_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!msgCols.includes('trace_json')) {
    db.exec("ALTER TABLE messages ADD COLUMN trace_json TEXT NOT NULL DEFAULT '[]'");
  }
  // `has_trace` is a cheap 0/1 flag for "this message has a non-empty trace".
  // The list readers (getMessagesPage/getMessagesAfter) select it INSTEAD of
  // trace_json — SQLite length(trace_json) would scan the (potentially
  // multi-MB) trace on every read/poll, so we persist the flag at write time.
  if (!msgCols.includes('has_trace')) {
    db.exec('ALTER TABLE messages ADD COLUMN has_trace INTEGER NOT NULL DEFAULT 0');
    // One-time backfill for rows written before this column existed.
    db.exec('UPDATE messages SET has_trace = 1 WHERE length(trace_json) > 2');
  }

  // Index on `session_id` — this is the hot path for the chat UI. Every
  // paginated read (`/api/messages`), the 10s polling cursor, the
  // post-stream refetch, and `countMessages` all filter by `session_id`
  // and order/range by rowid. Without this index SQLite scans the entire
  // messages table across all sessions for every one of those queries.
  //
  // SQLite secondary indexes on a rowid table implicitly include the rowid
  // as a trailing column, so `(session_id, rowid)` ranges and ordering
  // resolve directly from this single-column index. CREATE INDEX
  // IF NOT EXISTS makes it idempotent on repeated startups.
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)');

  // Add pinned_chat and pinned_prompt columns to sessions (backward-compatible)
  const sessCols = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  if (!sessCols.includes('pinned_chat')) {
    db.exec('ALTER TABLE sessions ADD COLUMN pinned_chat INTEGER NOT NULL DEFAULT 0');
  }
  if (!sessCols.includes('pinned_prompt')) {
    db.exec('ALTER TABLE sessions ADD COLUMN pinned_prompt TEXT');
  }
  if (!sessCols.includes('preview_state_json')) {
    db.exec("ALTER TABLE sessions ADD COLUMN preview_state_json TEXT NOT NULL DEFAULT '{}'");
  }

  // Add original_content / original_blob / original_mime columns to
  // knowledge_sources so the RAG page's "View" button can re-render the
  // ingested document.
  //   • original_content (TEXT) — verbatim text for text/markdown/html.
  //   • original_blob    (BLOB) — raw bytes for PDFs (no base64 inflation).
  //   • original_mime    (TEXT) — content-type that drives the View panel.
  const ksCols = (
    db.prepare('PRAGMA table_info(knowledge_sources)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!ksCols.includes('original_content')) {
    db.exec('ALTER TABLE knowledge_sources ADD COLUMN original_content TEXT');
  }
  if (!ksCols.includes('original_blob')) {
    db.exec('ALTER TABLE knowledge_sources ADD COLUMN original_blob BLOB');
  }
  if (!ksCols.includes('original_mime')) {
    db.exec('ALTER TABLE knowledge_sources ADD COLUMN original_mime TEXT');
  }

  // Per-MCP-server environment variables. Lets the user supply an MCP
  // server-specific API key (e.g. GITHUB_TOKEN for the github MCP server)
  // without exposing it to every other MCP server they install.
  const mcpCols = (
    db.prepare('PRAGMA table_info(mcp_servers)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!mcpCols.includes('env_json')) {
    db.exec("ALTER TABLE mcp_servers ADD COLUMN env_json TEXT NOT NULL DEFAULT '{}'");
  }

  // Backfill token_usage_log from existing messages (INSERT OR IGNORE = idempotent)
  db.exec(`
    INSERT OR IGNORE INTO token_usage_log (id, day, input, cached, output, created_at)
    SELECT
      id,
      date(created_at, 'unixepoch', 'localtime'),
      CAST(COALESCE(json_extract(token_usage_json, '$.input'),  0) AS INTEGER),
      CAST(COALESCE(json_extract(token_usage_json, '$.cached'), 0) AS INTEGER),
      CAST(COALESCE(json_extract(token_usage_json, '$.output'), 0) AS INTEGER),
      created_at
    FROM messages
    WHERE role = 'assistant'
      AND (
        CAST(COALESCE(json_extract(token_usage_json, '$.input'),  0) AS INTEGER) > 0
        OR CAST(COALESCE(json_extract(token_usage_json, '$.output'), 0) AS INTEGER) > 0
      )
  `);

  // Seed default settings if empty
  const count = (db.prepare('SELECT COUNT(*) as n FROM settings').get() as { n: number }).n;
  if (count === 0) {
    // No `endpoint` is seeded — the operator must point at their own provider
    // in Settings → Base URL on first run. The chat route fails fast (with a
    // friendly streamed message linking back to Settings) until it is set.
    db.prepare("INSERT INTO settings (key, value) VALUES ('endpoint', '')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('api_key', '')").run();
    // No `default_model` is seeded — the operator must pick one in Settings
    // → Default Model on first run. The agent loop fails fast (with a friendly
    // chat message linking back to Settings) until a model is configured.
    db.prepare("INSERT INTO settings (key, value) VALUES ('embedding_provider', 'local')").run();
  }
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------
export function getSetting(key: string): string {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string } | undefined;
  return row?.value ?? '';
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------
export interface Session {
  id: string;
  title: string;
  agent_name: string;
  created_at: number;
  updated_at: number;
  pinned_chat: number; // 0 | 1 – whether this session is pinned in the sidebar
  pinned_prompt: string | null; // text of the first user message if pinned as a prompt
  preview_state_json: string;
}

export function createSession(id: string, title: string, agentName = 'main'): Session {
  const db = getDb();
  db.prepare('INSERT INTO sessions (id, title, agent_name) VALUES (?, ?, ?)').run(
    id,
    title,
    agentName,
  );
  return getSession(id)!;
}

export function getSession(id: string): Session | undefined {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
}

export function listSessions(): Session[] {
  return getDb().prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as Session[];
}

export function updateSessionTitle(id: string, title: string): void {
  getDb()
    .prepare('UPDATE sessions SET title = ?, updated_at = unixepoch() WHERE id = ?')
    .run(title, id);
}

export function updateSessionAgent(id: string, agentName: string): void {
  getDb()
    .prepare('UPDATE sessions SET agent_name = ?, updated_at = unixepoch() WHERE id = ?')
    .run(agentName, id);
}

export function touchSession(id: string): void {
  getDb().prepare('UPDATE sessions SET updated_at = unixepoch() WHERE id = ?').run(id);
}

export function deleteSession(id: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function pinSessionChat(id: string, pinned: boolean): void {
  getDb()
    .prepare('UPDATE sessions SET pinned_chat = ? WHERE id = ?')
    .run(pinned ? 1 : 0, id);
}

export function setPinnedPrompt(id: string, text: string | null): void {
  getDb().prepare('UPDATE sessions SET pinned_prompt = ? WHERE id = ?').run(text, id);
}

export function updateSessionPreviewState(id: string, previewStateJson: string): void {
  getDb()
    .prepare('UPDATE sessions SET preview_state_json = ? WHERE id = ?')
    .run(previewStateJson, id);
}

export function getFirstUserMessage(sessionId: string): string | null {
  const row = getDb()
    .prepare(
      "SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1",
    )
    .get(sessionId) as { content: string } | undefined;
  return row?.content ?? null;
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------
export interface TokenUsage {
  input: number;
  cached: number;
  output: number;
}

export interface Message {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  attachments_json: string;
  tool_calls_json: string;
  token_usage_json: string;
  reasoning_json: string;
  parts_json: string;
  /** Persisted per-step trace. Omitted from list reads (getMessagesPage /
   *  getMessagesAfter) to keep responses small — fetched lazily via
   *  /api/messages/trace. Still present on write paths (saveMessage /
   *  upsertAssistantMessage) and on the full getMessages() read. */
  trace_json?: string;
  /** 0/1 — whether trace_json is non-empty (length > 2). Cheap surrogate so
   *  the UI can show the "Trace" button without loading the (potentially
   *  multi-MB) trace. Populated by the list-read queries and written at
   *  message-save time (saveMessage/upsertAssistantMessage). */
  has_trace?: number;
  created_at: number;
}

/** 0/1 — whether a trace_json string is non-empty (longer than the empty
 *  `'[]'`). Computed from the V8 string length (O(1)) at write time so the
 *  list readers can select the persisted `has_trace` column instead of
 *  scanning the (potentially multi-MB) trace with SQLite length(). */
function traceHasContent(traceJson: string | undefined | null): number {
  return !!traceJson && traceJson.length > 2 ? 1 : 0;
}

export function saveMessage(msg: Omit<Message, 'created_at'>): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, attachments_json, tool_calls_json, token_usage_json, reasoning_json, parts_json, trace_json, has_trace)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.session_id,
    msg.role,
    msg.content,
    msg.attachments_json,
    msg.tool_calls_json,
    msg.token_usage_json ?? '{}',
    msg.reasoning_json ?? '',
    msg.parts_json ?? '[]',
    msg.trace_json ?? '[]',
    traceHasContent(msg.trace_json),
  );

  // Also write to the persistent token usage log so stats survive message/session deletion
  recordAssistantTokenUsage(msg);
}

/**
 * Append-only token usage log writer. Idempotent on `id` (uses INSERT OR
 * IGNORE) so callers can safely invoke it multiple times for the same row —
 * e.g. checkpoint upserts during a long agent run + the final upsert. Only
 * writes when the row is an assistant message with a non-zero usage total.
 */
function recordAssistantTokenUsage(msg: Omit<Message, 'created_at'>): void {
  if (msg.role !== 'assistant') return;
  try {
    const usage = JSON.parse(msg.token_usage_json ?? '{}') as {
      input?: number;
      cached?: number;
      output?: number;
    };
    const inp = usage.input ?? 0;
    const out = usage.output ?? 0;
    if (inp <= 0 && out <= 0) return;
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO token_usage_log (id, day, input, cached, output)
       VALUES (?, date('now', 'localtime'), ?, ?, ?)`,
      )
      .run(msg.id, inp, usage.cached ?? 0, out);
  } catch {
    /* ignore JSON parse errors */
  }
}

/**
 * Insert-or-update an assistant message row by id. Used by the agent loop to
 * persist progress after every tool/reasoning step so a refresh during a long
 * run does not lose the work that has already been done. Idempotent on `id`.
 *
 * Also mirrors `saveMessage`'s side-effect of writing to `token_usage_log`,
 * which is the persistent (append-only) source of truth for daily/lifetime
 * token accounting. The log row is `INSERT OR IGNORE` keyed on the message
 * id, so the first checkpoint that reports non-zero usage records the row
 * and later checkpoints/the final upsert are no-ops on the log.
 */
export function upsertAssistantMessage(msg: Omit<Message, 'created_at'>): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, attachments_json, tool_calls_json, token_usage_json, reasoning_json, parts_json, trace_json, has_trace)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       content          = excluded.content,
       attachments_json = excluded.attachments_json,
       tool_calls_json  = excluded.tool_calls_json,
       token_usage_json = excluded.token_usage_json,
       reasoning_json   = excluded.reasoning_json,
       parts_json       = excluded.parts_json,
       trace_json       = excluded.trace_json,
       has_trace        = excluded.has_trace`,
  ).run(
    msg.id,
    msg.session_id,
    msg.role,
    msg.content,
    msg.attachments_json,
    msg.tool_calls_json,
    msg.token_usage_json ?? '{}',
    msg.reasoning_json ?? '',
    msg.parts_json ?? '[]',
    msg.trace_json ?? '[]',
    traceHasContent(msg.trace_json),
  );
  recordAssistantTokenUsage(msg);
}

export function getMessages(sessionId: string): Message[] {
  return getDb()
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId) as Message[];
}

/**
 * Total number of messages for a session. Used by the pagination API to tell
 * the frontend whether more rows exist before the currently-loaded window.
 */
export function countMessages(sessionId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?')
    .get(sessionId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Cursor-paginated message reader. Returns the most recent `limit` rows
 * older-than-or-equal-to the optional `before` rowid, in chronological
 * (ASC) order — so the caller can append/prepend without re-sorting.
 *
 * Cursor encoding: a single integer (`created_at`-tied autoincrement rowid).
 * SQLite assigns rowids in insertion order, which matches conversation
 * order even for messages that share the same `created_at` second.
 *
 * Why rowid instead of created_at?
 *   • created_at is unixepoch() seconds — easy to collide on burst inserts
 *     (e.g. two checkpoints in the same second), so a created_at cursor
 *     could skip rows.
 *   • rowid is unique-by-construction, monotonically increasing, and free
 *     (already indexed as the primary key for `INTEGER PRIMARY KEY` tables;
 *     for our TEXT primary key it's still maintained as the implicit rowid).
 */
/**
 * Columns returned by the paginated message readers (getMessagesPage /
 * getMessagesAfter). `trace_json` is deliberately EXCLUDED: a single
 * multi-step assistant message can persist a multi-MB trace (the full
 * conversation snapshotted at every agent step), and returning it on every
 * session-load / 10s poll was the root cause of the large-session slowdown.
 * The UI gets the persisted `has_trace` flag (written at message-save time,
 * so reading it is O(1) — unlike length(trace_json), which scans the blob)
 * and fetches the trace on demand via /api/messages/trace when the Trace
 * Drawer opens.
 */
const MESSAGE_LIST_COLUMNS =
  'id, session_id, role, content, attachments_json, tool_calls_json, ' +
  'token_usage_json, reasoning_json, parts_json, created_at, ' +
  'has_trace, rowid AS _rowid';

export function getMessagesPage(
  sessionId: string,
  limit: number,
  before?: number,
): { messages: Array<Message & { _rowid: number }>; nextCursor: number | null; hasMore: boolean } {
  const cap = Math.max(1, Math.min(limit, 500));
  const db = getDb();
  // `before` is a rowid cursor: only `undefined`/`null` should mean "no
  // cursor → newest page". The falsy check used to also accept `0` as "no
  // cursor", which is wrong — rowid 0 is a perfectly valid (if rare)
  // sentinel meaning "rows older than rowid 0" (an empty result). Compare
  // explicitly so a caller asking for `before: 0` gets an empty page
  // instead of the newest messages.
  const hasCursor = before !== undefined && before !== null;
  const rows = hasCursor
    ? (db
        .prepare(
          `SELECT ${MESSAGE_LIST_COLUMNS} FROM messages
         WHERE session_id = ? AND rowid < ?
         ORDER BY rowid DESC LIMIT ?`,
        )
        .all(sessionId, before, cap + 1) as Array<Message & { _rowid: number }>)
    : (db
        .prepare(
          `SELECT ${MESSAGE_LIST_COLUMNS} FROM messages
         WHERE session_id = ?
         ORDER BY rowid DESC LIMIT ?`,
        )
        .all(sessionId, cap + 1) as Array<Message & { _rowid: number }>);

  const hasMore = rows.length > cap;
  const messages = (hasMore ? rows.slice(0, cap) : rows).reverse();
  // The cursor we hand back is the SMALLEST rowid in the returned window —
  // the next page request asks for "rows older than this".
  const nextCursor = hasMore && messages.length > 0 ? messages[0]._rowid : null;
  return { messages, nextCursor, hasMore };
}

/**
 * Fetch a window of messages newer than the given rowid cursor. Used by the
 * polling and post-stream refetch effects to pick up appended rows without
 * re-downloading the entire history.
 */
export function getMessagesAfter(
  sessionId: string,
  after: number,
  limit = 200,
): Array<Message & { _rowid: number }> {
  const cap = Math.max(1, Math.min(limit, 500));
  return getDb()
    .prepare(
      `SELECT ${MESSAGE_LIST_COLUMNS} FROM messages
     WHERE session_id = ? AND rowid > ?
     ORDER BY rowid ASC LIMIT ?`,
    )
    .all(sessionId, after, cap) as Array<Message & { _rowid: number }>;
}

/**
 * Return the full `trace_json` for a single message. Used by the lazy-load
 * endpoint (/api/messages/trace) so the Trace Drawer fetches a trace only
 * when the user actually opens it — instead of every message carrying its
 * (potentially multi-MB) trace on every session-load / poll.
 */
export function getMessageTrace(messageId: string): string | null {
  const row = getDb().prepare('SELECT trace_json FROM messages WHERE id = ?').get(messageId) as
    | { trace_json: string }
    | undefined;
  return row?.trace_json ?? null;
}

// ---------------------------------------------------------------------------
// Skills helpers
// ---------------------------------------------------------------------------
export interface Skill {
  id: string;
  name: string;
  github_url: string;
  local_path: string;
  enabled: number;
  manifest_json: string;
}

export function listSkills(): Skill[] {
  return getDb().prepare('SELECT * FROM skills ORDER BY name ASC').all() as Skill[];
}

export function getSkill(id: string): Skill | undefined {
  return getDb().prepare('SELECT * FROM skills WHERE id = ?').get(id) as Skill | undefined;
}

export function upsertSkill(skill: Skill): void {
  const db = getDb();
  // SQLite only allows one ON CONFLICT clause per INSERT, so resolve a
  // potential name collision first: reuse the existing row's id so that the
  // subsequent upsert hits the ON CONFLICT(id) path instead of the name
  // UNIQUE constraint.
  const existing = db.prepare('SELECT id FROM skills WHERE name = ?').get(skill.name) as
    { id: string } | undefined;
  const id = existing?.id ?? skill.id;
  db.prepare(
    `INSERT INTO skills (id, name, github_url, local_path, enabled, manifest_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       github_url = excluded.github_url,
       local_path = excluded.local_path,
       enabled = excluded.enabled,
       manifest_json = excluded.manifest_json`,
  ).run(id, skill.name, skill.github_url, skill.local_path, skill.enabled, skill.manifest_json);
}

export function setSkillEnabled(id: string, enabled: boolean): void {
  getDb()
    .prepare('UPDATE skills SET enabled = ? WHERE id = ?')
    .run(enabled ? 1 : 0, id);
}

export function deleteSkill(id: string): void {
  getDb().prepare('DELETE FROM skills WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Function tool helpers
// ---------------------------------------------------------------------------
export interface FunctionTool {
  id: string;
  name: string;
  github_url: string;
  local_path: string;
  enabled: number;
  manifest_json: string; // JSON content of function.json
}

export function listFunctionTools(): FunctionTool[] {
  return getDb().prepare('SELECT * FROM function_tools ORDER BY name ASC').all() as FunctionTool[];
}

export function getFunctionTool(id: string): FunctionTool | undefined {
  return getDb().prepare('SELECT * FROM function_tools WHERE id = ?').get(id) as
    FunctionTool | undefined;
}

export function upsertFunctionTool(ft: FunctionTool): void {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM function_tools WHERE name = ?').get(ft.name) as
    { id: string } | undefined;
  const id = existing?.id ?? ft.id;
  db.prepare(
    `INSERT INTO function_tools (id, name, github_url, local_path, enabled, manifest_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       github_url = excluded.github_url,
       local_path = excluded.local_path,
       enabled = excluded.enabled,
       manifest_json = excluded.manifest_json`,
  ).run(id, ft.name, ft.github_url, ft.local_path, ft.enabled, ft.manifest_json);
}

export function setFunctionToolEnabled(id: string, enabled: boolean): void {
  getDb()
    .prepare('UPDATE function_tools SET enabled = ? WHERE id = ?')
    .run(enabled ? 1 : 0, id);
}

export function deleteFunctionTool(id: string): void {
  getDb().prepare('DELETE FROM function_tools WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// MCP server helpers
// ---------------------------------------------------------------------------
export interface McpServer {
  id: string;
  name: string;
  github_url: string;
  local_path: string;
  transport: 'stdio' | 'sse';
  command: string;
  args_json: string;
  url: string;
  enabled: number;
  /**
   * JSON object of per-server environment variables (e.g.
   * `{"GITHUB_TOKEN":"ghp_…"}`). Merged on top of the global allow-list in
   * `lib/mcp-client.ts` when the stdio subprocess is launched. Empty `{}`
   * for SSE servers and for stdio servers that don't need custom env vars.
   */
  env_json: string;
}

export function listMcpServers(): McpServer[] {
  return getDb().prepare('SELECT * FROM mcp_servers ORDER BY name ASC').all() as McpServer[];
}

export function getMcpServer(id: string): McpServer | undefined {
  return getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServer | undefined;
}

export function upsertMcpServer(server: McpServer): void {
  getDb()
    .prepare(
      `INSERT INTO mcp_servers (id, name, github_url, local_path, transport, command, args_json, url, enabled, env_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       github_url = excluded.github_url,
       local_path = excluded.local_path,
       transport = excluded.transport,
       command = excluded.command,
       args_json = excluded.args_json,
       url = excluded.url,
       enabled = excluded.enabled,
       env_json = excluded.env_json`,
    )
    .run(
      server.id,
      server.name,
      server.github_url,
      server.local_path,
      server.transport,
      server.command,
      server.args_json,
      server.url,
      server.enabled,
      server.env_json ?? '{}',
    );
}

export function setMcpServerEnabled(id: string, enabled: boolean): void {
  getDb()
    .prepare('UPDATE mcp_servers SET enabled = ? WHERE id = ?')
    .run(enabled ? 1 : 0, id);
}

export function deleteMcpServer(id: string): void {
  getDb().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Token usage statistics helpers
// ---------------------------------------------------------------------------

export interface DailyTokenStats {
  day: string; // 'YYYY-MM-DD'
  input: number;
  cached: number;
  output: number;
}

/**
 * Returns per-day token usage aggregated from assistant messages.
 * Uses SQLite JSON functions to extract fields from token_usage_json.
 * @param days  How many calendar days back to query (e.g. 30 for last month)
 */
export function getDailyTokenStats(days: number): DailyTokenStats[] {
  const db = getDb();
  const rows = db
    .prepare(
      `
    SELECT
      day,
      CAST(SUM(input)  AS INTEGER) AS input,
      CAST(SUM(cached) AS INTEGER) AS cached,
      CAST(SUM(output) AS INTEGER) AS output
    FROM token_usage_log
    WHERE created_at >= unixepoch('now', ?)
    GROUP BY day
    ORDER BY day ASC
  `,
    )
    .all(`-${days} days`) as DailyTokenStats[];

  // Fill in every calendar day in the requested range with zeros so the chart
  // always spans the full window — days with no activity should show as empty bars.
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const filled: DailyTokenStats[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    filled.push(byDay.get(key) ?? { day: key, input: 0, cached: 0, output: 0 });
  }
  return filled;
}

/**
 * Returns total token usage summed over a period.
 */
export function getTotalTokenStats(days: number): TokenUsage {
  const db = getDb();
  const row = db
    .prepare(
      `
    SELECT
      CAST(COALESCE(SUM(input),  0) AS INTEGER) AS input,
      CAST(COALESCE(SUM(cached), 0) AS INTEGER) AS cached,
      CAST(COALESCE(SUM(output), 0) AS INTEGER) AS output
    FROM token_usage_log
    WHERE created_at >= unixepoch('now', ?)
  `,
    )
    .get(`-${days} days`) as TokenUsage | undefined;
  return row ?? { input: 0, cached: 0, output: 0 };
}

// ---------------------------------------------------------------------------
// Agent task helpers
// ---------------------------------------------------------------------------

export interface AgentTask {
  id: string;
  project_folder: string;
  assigner: string;
  assignee: string;
  prompt: string;
  task_file: string;
  status: string;
  created_at: number;
  finished_at: number | null;
}

export function createAgentTask(
  id: string,
  projectFolder: string,
  assigner: string,
  assignee: string,
  prompt: string,
  taskFile: string,
): void {
  getDb()
    .prepare(
      'INSERT INTO agent_tasks (id, project_folder, assigner, assignee, prompt, task_file) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, projectFolder, assigner, assignee, prompt, taskFile);
}

export function finishAgentTask(id: string, status: 'finished' | 'error' | 'interrupted'): void {
  getDb()
    .prepare('UPDATE agent_tasks SET status = ?, finished_at = unixepoch() WHERE id = ?')
    .run(status, id);
}

export function getAgentTask(id: string): AgentTask | undefined {
  return getDb().prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id) as AgentTask | undefined;
}

export function listAgentTasksByAgent(agentName: string): AgentTask[] {
  return getDb()
    .prepare(
      'SELECT * FROM agent_tasks WHERE assigner = ? OR assignee = ? ORDER BY created_at DESC LIMIT 100',
    )
    .all(agentName, agentName) as AgentTask[];
}

// ---------------------------------------------------------------------------
// Agent notification helpers
// ---------------------------------------------------------------------------

export interface AgentNotification {
  id: string;
  session_id: string;
  task_id: string;
  task_file: string;
  summary: string;
  created_at: number;
  read_at: number | null;
}

export function createAgentNotification(
  id: string,
  sessionId: string,
  taskId: string,
  taskFile: string,
  summary: string,
): void {
  getDb()
    .prepare(
      'INSERT INTO agent_notifications (id, session_id, task_id, task_file, summary) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, sessionId, taskId, taskFile, summary);
}

export function getPendingNotifications(sessionId: string): AgentNotification[] {
  return getDb()
    .prepare(
      'SELECT * FROM agent_notifications WHERE session_id = ? AND read_at IS NULL ORDER BY created_at ASC',
    )
    .all(sessionId) as AgentNotification[];
}

export function markNotificationsRead(sessionId: string): void {
  getDb()
    .prepare(
      'UPDATE agent_notifications SET read_at = unixepoch() WHERE session_id = ? AND read_at IS NULL',
    )
    .run(sessionId);
}

export interface LessonProgress {
  username: string;
  lesson_slug: string;
  status: 'not_started' | 'in_progress' | 'completed';
  quiz_score: number | null;
  quiz_total: number | null;
  updated_at: number;
  completed_at: number | null;
}

export function listLessonProgress(username: string): LessonProgress[] {
  return getDb()
    .prepare('SELECT * FROM lesson_progress WHERE username = ? ORDER BY updated_at DESC')
    .all(username) as LessonProgress[];
}

export function getLessonProgress(
  username: string,
  lessonSlug: string,
): LessonProgress | undefined {
  return getDb()
    .prepare('SELECT * FROM lesson_progress WHERE username = ? AND lesson_slug = ?')
    .get(username, lessonSlug) as LessonProgress | undefined;
}

export function upsertLessonProgress(
  username: string,
  lessonSlug: string,
  status: LessonProgress['status'],
  quizScore?: number | null,
  quizTotal?: number | null,
): LessonProgress {
  getDb()
    .prepare(
      `INSERT INTO lesson_progress (username, lesson_slug, status, quiz_score, quiz_total, completed_at)
       VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 'completed' THEN unixepoch() ELSE NULL END)
       ON CONFLICT(username, lesson_slug) DO UPDATE SET
         status = excluded.status,
         quiz_score = COALESCE(excluded.quiz_score, lesson_progress.quiz_score),
         quiz_total = COALESCE(excluded.quiz_total, lesson_progress.quiz_total),
         updated_at = unixepoch(),
         completed_at = CASE
           WHEN excluded.status = 'completed' THEN COALESCE(lesson_progress.completed_at, unixepoch())
           ELSE lesson_progress.completed_at
         END`,
    )
    .run(username, lessonSlug, status, quizScore ?? null, quizTotal ?? null, status);
  return getLessonProgress(username, lessonSlug)!;
}
