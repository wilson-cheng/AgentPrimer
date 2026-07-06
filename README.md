<div align="center">

# 🤖 AgentPrimer

### A complete, AI agent experience platform you can read, run, and learn from

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://www.typescriptlang.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

Some AI agent tutorials give you either a toy demo you can't learn from, or a massive framework that hides everything behind abstractions.

**AgentPrimer is different.** It is a fully working, authenticated single-workspace AI agent application — real first-admin authentication, real streaming, real tool execution, real database — where every architectural decision is intentional. You run it, you poke at it, you read the docs, and by the end you understand exactly how production agentic systems are built.

---

## What You Will Build / Learn

After working through this project, you will be able to explain **and implement**:

- The **ReAct loop** (Reason + Act) — how agents chain tool calls to complete multi-step tasks
- **Real-time streaming** — Vercel AI SDK data stream from LLM to browser, token by token, with tool-call events
- **Four-tier capability architecture** — 22 built-in tools, subprocess-isolated function tools, SKILL.md instruction modules, and MCP servers
- **Persistent memory** — how agents remember facts across sessions
- **Multi-agent orchestration** — sync and async sub-agents with task tracking
- **Human-in-the-loop** — an approval gate that pauses the agent before dangerous operations
- **Full-stack integration** — Next.js App Router, SQLite, JWT auth, React streaming hooks

These are not simplified versions. This is the real code, heavily documented for learning.

---

## Quick Start

### Prerequisites

- **Node.js 20+** and npm (or pnpm/yarn)
- **Git** (GitHub-installed skills and MCP servers are git-cloned at install time)

### Install and run

```bash
# Clone and install Node.js dependencies
git clone https://github.com/wilson-cheng/AgentPrimer.git
cd AgentPrimer
npm install

# Start the server
npm run dev

# Open http://localhost:15432
# First visit prompts you to register an admin account
# Registration redirects to /setup for endpoint, API key, default model,
# optional Exa web search, and optional shell access
# You can later adjust these under Settings
```

---

## Before You Begin

Before diving into the codebase, make sure you are comfortable with:

- **Node.js 20+** — runtime fundamentals (async/await, module system, npm)
- **TypeScript basics** — types, interfaces, generics (most of the codebase is TypeScript)
- **React fundamentals** — components, hooks (`useState`, `useEffect`), props
- **LLM API familiarity** — what a chat completion is, what a system prompt does, the concept of tool/function calling
- **SQLite basics** — tables, queries, the WAL journal mode (optional but helpful)

If any of these are unfamiliar, the linked resources in each module's "Further Reading" section will help you catch up.

---

## The Learning Path

The project comes with **15 documentation modules** (00–14) that take you from zero to production-ready agentic AI knowledge:

| Module | Topic | What You Learn |
|--------|-------|----------------|
| [00](docs/00-build-from-scratch.md) | **Build From Scratch** | A minimal ReAct agent in about 60 lines before studying the full app |
| [01](docs/01-architecture.md) | **System Architecture** | Component map, request flow, technology choices and why |
| [02](docs/02-agent-loop.md) | **The Agent Loop** | ReAct pattern, streaming tool calls, safety limits, async agents |
| [03](docs/03-tools-and-skills.md) | **Tools, Function Tools, Skills & MCP** | All 22 built-in tools, subprocess-isolated function tools, SKILL.md instruction modules, and MCP servers |
| [04](docs/04-streaming.md) | **Streaming Protocol** | AI SDK data stream wire format, every event type, browser `useChat` hook |
| [05](docs/05-memory.md) | **Memory & Agents** | Long-term memory, multi-agent patterns, async task tracking |
| [06](docs/06-approval-gate.md) | **Approval Gate** | Human-in-the-loop, three approval scopes, security guarantees |
| [07](docs/07-frontend.md) | **Frontend** | React component tree, streaming UI, Preview Panel, file delivery |
| [08](docs/08-database.md) | **Database Design** | SQLite schema, ER diagram, migration strategy, WAL mode |
| [09](docs/09-ecosystem-comparison.md) | **Ecosystem Comparison** | AgentPrimer vs OpenClaw vs Hermes Agent — gaps, roadmap, inspiration |
| [10](docs/10-structured-output.md) | **Structured Output** | JSON-schema agents, extractor workflows, structured rendering |
| [11](docs/11-rag.md) | **RAG** | Chunking, embeddings, vector retrieval, FTS5 fallback |
| [12](docs/12-deployment-production.md) | **Deployment & Production** | Docker, nginx, backups, rate limiting, monitoring, Langfuse |
| [13](docs/13-testing-agents.md) | **Testing AI Agents** | Mocking the LLM, testing tool dispatch, integration tests, eval harness design |
| [14](docs/14-multi-agent-orchestration.md) | **Multi-Agent Orchestration** | Coordinating specialist agents with sync and async task flows |

### Suggested Reading Order

If you are new to the codebase, follow this order. Each step builds on the previous one:

1. **[Module 00](docs/00-build-from-scratch.md)** — Build your first agent from scratch in ~60 lines. This gives you the mental model before you look at the full codebase.
2. **[`app/api/chat/route.ts`](app/api/chat/route.ts)** — Read the API entry point. See how a user message becomes an agent turn, including persistence and stream keep-alives.
3. **[Module 03](docs/03-tools-and-skills.md)** — Tools, Skills & MCP. Understand the three-tier tool architecture before diving into the agent loop.
4. **[`lib/agent.ts`](lib/agent.ts)** (the barrel) then **[`lib/agent/streaming-agent.ts`](lib/agent/streaming-agent.ts)** (`createStreamingAgent`, ~line 42) and **[`lib/agent/loop.ts`](lib/agent/loop.ts)** (`runAgentLoop`). `lib/agent.ts` is a 28-line barrel that re-exports the real implementation from `lib/agent/*.ts`; `streaming-agent.ts` is the public entry point and `loop.ts` is the ReAct loop itself.
5. **[Module 02](docs/02-agent-loop.md)** — The Agent Loop deep dive. Now you are ready for the full loop logic inside `lib/agent/loop.ts`.
6. **[Module 05](docs/05-memory.md)** — Memory & Agents. How persistent context and multi-agent orchestration work.
7. **[Module 10](docs/10-structured-output.md)** — Structured Output. The alternative execution path for extraction agents.
8. **[Module 11](docs/11-rag.md)** — RAG. How retrieval-augmented generation is added.

After those, read the remaining modules (04, 06, 07, 08, 09, 12, 13) in any order.

---

## Architecture at a Glance

```
Browser (React/Next.js)
    │
    │  POST /api/chat  →  AI SDK data stream (tail of a detached run)
    ▼
proxy.ts  (JWT page auth; API routes enforce auth individually where needed)
    │
    ▼
app/api/chat/route.ts  (save message, start detached agent run)
    │
    ▼
lib/agent/run-manager.ts  (floating promise + replay buffer + AbortController + 30-min watchdog)
    │
    ▼
lib/agent/*.ts  ─────────────────────────────────┐
  (lib/agent.ts is a barrel; real code in        │
   streaming-agent.ts + loop.ts + helpers)       │
    │  openai.chat.completions.create({ signal })  │
    │  ↕ streaming tool calls                      │
    ▼                                          │
Built-in tools       Function-tool subprocess    MCP server        SKILL.md instructions
(read/write/shell)   (function.json + index.js)  (any language)    (loaded into prompt)
    │                       │                  │
    └───────────────────────┴──────────────────┘
    │  tool results fed back into loop
    ▼
createTailResponse()  →  browser receives tokens live (browser close only tears down the tail)
    │  · per-step checkpoint to SQLite
    ▼
SQLite (sessions · messages · tasks · approvals)
```

The key insight: the agent loop is **hand-written**, not hidden inside a framework. Every iteration of `openai.chat.completions.create()` is visible. This is intentional — the goal is understanding, not abstraction. The loop runs **detached** from the HTTP response via `lib/agent/run-manager.ts`, so closing the browser mid-stream no longer kills the run — it keeps going, checkpoints partial progress to SQLite after every step, and a later reopen re-attaches a tail or loads the persisted result. Only the **Stop** button (`POST /api/chat/stop`) cancels a run.

---

## Key Design Decisions (and why they matter for learning)

| Decision | What | Why it's educational |
|----------|------|---------------------|
| **`openai` npm directly** | Not the Vercel AI SDK adapter | Shows every raw API field; preserves `reasoning_content` for DeepSeek R1 chain-of-thought |
| **Hand-written agent loop** | Not `streamText(maxSteps:10)` | You see exactly what happens on each iteration |
| **Detached run manager** | Loop runs as a floating promise, not inside the HTTP `execute` callback | Browser close no longer kills the run; per-step SQLite checkpoints survive refreshes; Stop button is the only cancel path |
| **SQLite + better-sqlite3** | Single file database | Zero external services; synchronous API is easy to reason about |
| **Function tools in subprocesses** | `child_process.spawn()` worker | Buggy or untrusted callable tool code cannot crash the Next.js server; SKILL.md skills are instruction text, not executable code |
| **`proxy.ts` not `middleware.ts`** | Next.js 16 convention | A real gotcha most tutorials miss — documented so you don't hit it |
| **Approval gate as chat messages** | Not a modal popup | Agent reads denial in natural language and can adapt its approach |

---

## Debugging and Development

AgentPrimer includes several built-in tools to help you understand what the agent is doing:

- **Browser DevTools (Network tab)** — Open the Network tab, filter by `/api/chat`, and watch AI SDK data stream events arrive in real-time. Each line is a typed event (`0:` for text, `b:`/`c:` for tool call fragments, `9:` for complete tool calls, `a:` for tool results). See [Module 04](docs/04-streaming.md) for the full wire format reference.

- **`console.log` in the agent loop** — The fastest way to debug: add `console.log` statements inside the agent loop in `lib/agent/loop.ts`. Log the current step number, `finish_reason`, tool call arguments, or token counts. The output appears in the server terminal.

- **VS Code debugger** — Set breakpoints in `lib/agent/loop.ts`, `lib/agent/streaming-agent.ts`, or `app/api/chat/route.ts`. Use the Node.js debugger configuration (`.vscode/launch.json`) to attach to the running dev server. This lets you step through the ReAct loop iteration by iteration.

- **Trace Drawer** — Click the "Show trace" button on any assistant message in the chat UI. This shows the exact LLM request (messages and tools sent), tool I/O (inputs and outputs), token counts, timing per step, and finish reasons. No server-side changes needed.

- **System Prompt Viewer** — Click the "View System Prompt" button in the chat header to see the exact composed system prompt (agent config + `system.md` + `data/agents/<agent>/memory.md` merged) that is sent to the LLM on every turn.

- **Tool Playground** — Navigate to `/tools` to test any built-in tool, skill, or MCP tool interactively. Fill in parameters via a generated form and see the raw result. Useful for verifying tool behavior without involving the agent loop.

---

## What's Built In

The running agent comes with **22 built-in tools** out of the box:

- **File system**: `read_file`, `write_file`, `edit_file`, `append_file`, `list_directory`, `make_directory`, `delete_path`, `move_path`, `copy_path`, `stat_path`, `search_files`
- **Output**: `send_file` (inline preview in chat), `open_preview` (Preview Panel)
- **Memory / knowledge**: `append_memory`, `replace_memory`, `search_knowledge_base`
- **Agents**: `create_agent`, `run_subagent_async` (background task), `update_task_status`, `list_tasks`
- **Skills**: `load_skill` (loads full SKILL.md instructions on demand)
- **Shell**: `run_shell` (opt-in, requires explicit enable and approval)

All tools are registered in [`lib/builtin-tools-registry.ts`](lib/builtin-tools-registry.ts) and can be enabled/disabled per-agent via `data/agents/<agent>/agent.md`.

---

## Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | Next.js App Router | 16 |
| Language | TypeScript | 5 |
| LLM calls | `openai` npm (direct, not adapter) | 6.x |
| Stream wire | Vercel AI SDK (`createDataStreamResponse`) | 4.3 |
| Database | `better-sqlite3` | 12.x |
| Auth | `jose` (JWT) | 6.x |
| Tools protocol | `@modelcontextprotocol/sdk` | 1.29 |
| Styling | Tailwind CSS | 4 |
| Schema validation | Zod + zod-to-json-schema | 3.x |

Supports any OpenAI-compatible API: DeepSeek, OpenAI, Ollama, LM Studio, vLLM, Groq, and Anthropic through an external OpenAI-compatible proxy.

---

## Deploying with Docker

```bash
# Create .env from .env.example and set AGENT_PRIMER_SECRET first
cp .env.example .env
# edit .env, then deploy the app
docker compose up -d

# Optional browser-based editor for trusted private deployments:
# docker compose --profile devtools up -d

# Or build and run manually:
docker build -t agentprimer .
docker run -p 15432:15432 -e AGENT_PRIMER_SECRET=replace-with-a-random-secret -v agentprimerdata:/app/data agentprimer
```

Mount `/app/data` as a persistent volume — all sessions, memory, skills, uploads, and RAG data live there. The included Compose file also has an optional `devtools` profile for code-server; set `CODE_SERVER_PASSWORD` and expose it only on trusted networks.

---

## Extending AgentPrimer

**Write a SKILL.md Skill** (Markdown instructions, loaded into the prompt):
```
data/skills/my-skill/
└── SKILL.md    ← natural-language workflow instructions for the agent
```

**Write an MCP Server** (any language):
```bash
# Any MCP-compatible server works
# Connect via Skills & MCP → MCP Servers
```

**Add an Agent** (no code needed):
```text
data/agents/my-specialist/
├── agent.md
└── memory.md
```
```markdown
# my-specialist
**System Prompt:** You are an expert in X. Always do Y.
**Tools:** read_file, write_file, append_memory
**Model:** default
```
Add it under `data/agents/my-specialist/agent.md`, refresh. Done. (`Model: default` falls through to whatever you picked under Settings → Default Model.)

---

## Contributing

All contributions are welcome — docs improvements, new skill examples, bug fixes, new modules.

1. Fork the repo
2. `npm install && npm run dev`
3. Make your changes
4. Open a PR with a clear description of what you changed and why

If you found this project useful for learning, the most helpful thing you can do is **⭐ star the repo** — it helps other developers discover it and builds momentum for the next phase of modules.

---

## Documentation

Full module documentation is in [`docs/`](docs/README.md).

The same content is available as a slide deck for teaching (Marp format): [`docs/training-slides.md`](docs/training-slides.md).

---

## License

MIT — use it, fork it, teach with it, build on it.

---

## Deployment Note

AgentPrimer is designed for Docker/VPS-style deployment with persistent filesystem storage, SQLite, native dependencies, and the in-process embedding model. Standard serverless hosting is not the intended deployment target unless you replace those storage/runtime assumptions.
