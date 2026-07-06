# AgentPrimer — Training Documentation

> **AgentPrimer** is a self-hosted, full-stack AI agent platform built from scratch with Next.js. It is designed as a *learning platform*: every architectural decision is intentional and documented so you can understand exactly how an AI agent system is built.

---

## Who Is This For?

This documentation is structured for a **mixed audience** — from junior developers learning about AI agents for the first time, to senior engineers who want to understand specific implementation choices at a code level. Each module starts with high-level concepts and gradually increases in depth.

**What you will understand after working through these materials:**
- What an AI agent actually is and how the ReAct loop makes it work
- How prompt layers, model settings, context windows, and token budgets affect agent behavior
- How to build and extend the agent's toolkit using built-in tools, function tools, SKILL.md instruction modules, and MCP servers
- How real-time streaming is implemented end-to-end from LLM to browser
- How persistent memory, retrieval-augmented generation, and multi-agent orchestration work
- How to safely involve humans in agent decisions with approvals and least-privilege tool access
- How observability, traces, token accounting, and Langfuse help debug production agents
- How to test agents with mocks, deterministic tool tests, integration tests, and evaluation harnesses
- How the frontend and database are designed to support all of the above
- Where AgentPrimer stands relative to other open-source agent applications (OpenClaw, Hermes Agent)

---

## Learning Path

```
Beginner ─────────────────────────────────────────────────── Advanced
   │                                                               │
Module 00           Module 05           Module 08          Module 09
Build from Scratch  Memory & Agents  →  Database       →  Ecosystem
   │                      │                   │               Comparison
Module 01              Module 06                              Module 10
Architecture    →   Approval Gate                      →  Structured Output
   │                                                       │
Module 02              Module 07                          Module 11
Agent Loop      →   Frontend                       →  RAG
   │
Module 03
Tools & MCP
    │
Module 04
Streaming

Production branch: Module 12
Deployment & Production

Quality branch: Module 13
Testing AI Agents

Orchestration branch: Module 14
Multi-Agent Orchestration
```

**Recommended reading order for beginners:** 00 → 01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 10 → 11 → 12 → 13 → 14

**For developers already familiar with LLM APIs:** Start at 00 (Build from Scratch) then 02 (Agent Loop), then jump to whatever module is most relevant. Modules 10 (Structured Output) and 11 (RAG) cover patterns used constantly in production that most tutorials skip.

---

## Module Index

| # | Module | What You Will Learn |
|---|--------|---------------------|
| [00](./00-build-from-scratch.md) | **Build from Scratch** | Go from `create-next-app` to a working ReAct agent in ~60 lines of code; understand the primitives AgentPrimer builds on |
| [01](./01-architecture.md) | **Architecture** | System architecture, request flow, file layout, technology choices, and deployment trade-offs |
| [02](./02-agent-loop.md) | **The Agent Loop** | The ReAct (Reason + Act) algorithm that powers all agents; how tool calls are detected, executed, and fed back; detached RunManager, per-step checkpointing, Stop/abort; async sub-agents |
| [03](./03-tools-and-skills.md) | **Tools, Function Tools, Skills & MCP** | Built-in tools, subprocess-isolated function tools, SKILL.md instruction modules, MCP servers; how to write and install your own |
| [04](./04-streaming.md) | **Streaming Protocol** | AI SDK data stream wire format, every event type, how the browser consumes the stream with `useChat`, reasoning tokens, detached RunManager (browser-close-safe runs), heartbeat wrapper |
| [05](./05-memory.md) | **Memory & Agents** | `data/system.md`, `data/agents/<agent>/agent.md`, `data/agents/<agent>/memory.md`, structured output schemas, multi-agent patterns, async sub-agents |
| [06](./06-approval-gate.md) | **Approval Gate** | Human-in-the-loop design; approval scopes; how the gate pauses the agent and resumes cleanly |
| [07](./07-frontend.md) | **Frontend Architecture** | React component tree, `useChat` data flow, streaming UI updates, cursor pagination, lazy trace loading, `pickMessageParts`, Preview Panel, file sending |
| [08](./08-database.md) | **Database Design** | SQLite schema, ER diagram, all tables (including RAG index, token usage log, async task tracking), WAL mode, migration strategy |
| [09](./09-ecosystem-comparison.md) | **Ecosystem Comparison** | Three-way comparison: AgentPrimer vs OpenClaw vs Hermes Agent — architecture, feature matrix, gap analysis, and roadmap |
| [10](./10-structured-output.md) | **Structured Output** | `response_format: json_object`, schema-in-prompt approach, the `extractor` agent, dual rendering path (live vs. historical), `StructuredOutputPanel` |
| [11](./11-rag.md) | **RAG** | Why flat-file memory fails at scale, the chunk→embed→store→retrieve pipeline, in-process embeddings (Transformers.js), cosine similarity in JS, FTS5 fallback, RAG UI |
| [12](./12-deployment-production.md) | **Deployment & Production** | VPS deployment, Docker Compose, nginx reverse proxy, env vars, SQLite WAL backups, rate limiting, monitoring, Langfuse observability (setup, integration, trace analysis, evaluation, privacy) |
| [13](./13-testing-agents.md) | **Testing AI Agents** | Mocking the LLM, testing tool dispatch, integration tests, structured output tests, error path coverage, eval harness design |
| [14](./14-multi-agent-orchestration.md) | **Multi-Agent Orchestration** | Async sub-agents, task files, task notifications, monitor bubbles, auto follow-up, and orchestration limits |

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the dev server (accessible from all network interfaces)
npm run dev

# 3. Open http://localhost:15432 and register the first admin user

# 4. Complete /setup to configure your LLM endpoint, API key, and default model
#    (supports DeepSeek, OpenAI, Ollama, LM Studio, any OpenAI-compatible API)
```

The only persistent state is in `data/` — a single directory that acts as the volume mount point for Docker deployments.

---

## Key Design Decisions

Understanding *why* these decisions were made is as important as *what* they are.

| Decision | What | Why |
|----------|------|-----|
| **OpenAI SDK directly** | `openai` npm package, not `@ai-sdk/openai` | Full access to vendor-specific fields like `reasoning_content` (DeepSeek R1 chain-of-thought) that the Vercel adapter silently strips |
| **Vercel AI SDK for wire protocol only** | `createDataStreamResponse`, `formatDataStreamPart`, `useChat` | The SSE framing and browser hook are reused, but the agent loop is entirely hand-written for maximum transparency |
| **One SQLite file** | `data/db/agent.db` via `better-sqlite3` | Zero external services; synchronous API fits Node.js; a single `docker volume` mount covers everything |
| **Agent config in Markdown** | `data/agents/<agent>/agent.md`, `data/agents/<agent>/memory.md` | Human-editable without a DB migration or server restart; agents can update their own memory via `append_memory` / `replace_memory` |
| **Function tools in subprocesses** | `lib/function-tool-worker.js` | Buggy or malicious function tool code cannot crash the main Next.js server; memory and time are capped per call. SKILL.md skills are *not* run as subprocesses — they are instruction text injected into the system prompt. |
| **Middleware named `proxy.ts`** | Not `middleware.ts` | Next.js 16 changed the middleware filename convention. The file must be named `proxy.ts` — `middleware.ts` is silently ignored in this version |
| **Approval gate as user messages** | Approval/denial sent as plain chat messages | The agent reads the decision in natural language and can respond contextually (retry, acknowledge, offer alternatives) |

---

## Project Structure at a Glance

```
agentprimer/
├── proxy.ts               # Page auth proxy; API routes enforce auth individually where needed
├── app/
│   ├── (main)/
│   │   ├── chat/page.tsx      # Main chat UI
│   │   ├── agents/page.tsx    # Agent and memory file editor
│   │   ├── knowledge/page.tsx # RAG UI
│   │   ├── statistics/page.tsx # Token usage dashboard
│   │   ├── skills/page.tsx    # Skills, function tools, MCP servers, built-in tools
│   │   ├── tools/page.tsx     # Tool Playground
│   │   ├── editor/page.tsx    # Agent Files Monaco editor
│   │   ├── approvals/page.tsx # Permanent approval management
│   │   └── settings/page.tsx  # Provider/model/user preferences
│   ├── api/chat/          # ★ POST /api/chat — the streaming agent entry point
│   ├── api/approval/      # Human approval state management
│   ├── api/sessions/      # Chat session CRUD
│   ├── api/skills/        # Skill install / toggle / delete
│   ├── api/mcp/           # MCP server install / toggle / delete
│   ├── api/rag/           # RAG ingestion and search
│   ├── api/statistics/    # Token usage statistics
│   └── api/auth/          # JWT login / logout / register
├── lib/
│   ├── agent.ts           # Agent barrel export; real implementation lives in lib/agent/*
│   ├── agent/loop.ts      # ★ Core ReAct loop, streaming, and tool dispatch
│   ├── agent/streaming-agent.ts # ★ Streaming agent entry point used by /api/chat
│   ├── db.ts              # SQLite layer — all persistent state
│   ├── memory.ts          # agents/<agent>/memory.md / agents/<agent>/agent.md read-write helpers
│   ├── skills-loader.ts   # SKILL.md skill loader (injects instructions into system prompt)
│   ├── function-tools-loader.ts # Function tool loader (callable code in subprocesses)
│   ├── function-tool-worker.js  # Subprocess entry point for function tool execution
│   ├── rag.ts             # Chunking, embeddings, vector search, FTS5 fallback
│   ├── langfuse.ts        # Optional trace export to Langfuse
│   ├── mcp-client.ts      # MCP protocol client (stdio + SSE)
│   ├── approval-store.ts  # Per-session and permanent approval tracking
│   ├── agent-files.ts     # Files the agent sends to the user
│   ├── builtin-tools-registry.ts  # Catalogue of built-in tools (enable/disable)
│   └── auth.ts            # JWT sign/verify
├── components/
│   ├── MessageBubble.tsx  # Renders messages (text, tools, reasoning, approval, files)
│   ├── PreviewPanel.tsx   # Resizable panel for live HTML/image previews
│   ├── learn/             # In-app curriculum UI
│   └── ChatInput.tsx      # Multi-line input with file attachments
└── data/                  # ★ Volume mount point — everything persistent lives here
    ├── db/agent.db        # SQLite database
    ├── .users             # First-run admin account store
    ├── system.md          # Global system prompt
    ├── agents/<agent>/memory.md          # Agent's long-term memory
    ├── agents/<agent>/agent.md          # Agent definitions (name, system prompt, tools, model)
    ├── uploads/           # User-uploaded files
    ├── agent-files/       # Files sent by the agent to users
    ├── skills/            # Cloned SKILL.md instruction packages
    ├── function-tools/    # Callable function-tool packages
    └── mcp-servers/       # Cloned MCP server packages
```

---

## How to Use This Documentation

Each module document follows this structure:

1. **Learning Objectives** — what you will understand after reading
2. **Core Concepts** — the theory, with diagrams
3. **Implementation Walkthrough** — the actual code with in-depth annotation
4. **Alternate Approaches** — how other systems solve the same problem differently
5. **Future Expansion** — what you could add to make the system more powerful
6. **Exercises** — hands-on challenges to solidify understanding
7. **Further Reading** — references and source material

Answer keys for exercises live in [`docs/answers/`](./answers/).

Start with [Module 00 — Build From Scratch →](./00-build-from-scratch.md)
