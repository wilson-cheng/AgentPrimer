---
marp: true
theme: default
paginate: true
header: "Building AI Agents"
footer: "AgentPrimer Training – github.com/wilson-cheng/AgentPrimer"
style: |
  section {
    font-family: 'Segoe UI', system-ui, sans-serif;
    background: #ffffff;
    color: #1f2937;
    padding: 60px 70px;
  }
  section.lead {
    background: linear-gradient(135deg, #1f2937 0%, #111827 100%);
    color: #ffffff;
  }
  section.lead h1 {
    color: #ffffff;
    font-size: 2.8em;
    font-weight: 800;
    line-height: 1.1;
  }
  section.lead p, section.lead ul li {
    color: #9ca3af;
    font-size: 1.1em;
  }
  h1 { color: #111827; font-size: 2em; font-weight: 800; border-bottom: 4px solid #3b82f6; padding-bottom: 12px; }
  h2 { color: #3b82f6; font-size: 1.4em; font-weight: 700; margin-top: 0; }
  h3 { color: #374151; font-size: 1.1em; font-weight: 600; }
  code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; color: #dc2626; font-size: 0.9em; }
  pre { background: #111827; color: #e5e7eb; padding: 20px 24px; border-radius: 12px; font-size: 0.78em; line-height: 1.6; }
  pre code { background: none; color: inherit; padding: 0; }
  .accent { color: #3b82f6; }
  .emerald { color: #10b981; }
  .amber { color: #f59e0b; }
  ul li { margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
  th { background: #f3f4f6; color: #374151; font-weight: 700; padding: 10px 14px; text-align: left; }
  td { border-top: 1px solid #e5e7eb; padding: 8px 14px; }
  .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
  .card { background: #f9fafb; border: 2px solid #e5e7eb; border-radius: 12px; padding: 20px 24px; }
  .blue-card { background: #eff6ff; border-color: #bfdbfe; }
  .green-card { background: #f0fdf4; border-color: #bbf7d0; }
---

<!-- _class: lead -->

# Building AI Agents

### A Complete Guide Using AgentPrimer

<br/>

> From chatbots to autonomous agents —  
> understand the architecture, build your own tools,  
> and deploy with confidence.

---

# What We'll Cover

1. **What is an AI Agent?** — Beyond chatbots
2. **The Agent Loop** — How agents think and act
3. **Tools & Skills** — Extending agent capabilities
4. **MCP Protocol** — The standard for AI tooling
5. **Memory Systems** — Long-term agent memory
6. **Multi-Agent Patterns** — Orchestration
7. **Building Skills** — Hands-on skill creation
8. **Building MCP Servers** — Hands-on MCP creation
9. **AgentPrimer Architecture** — The full stack

---

# 1. What is an AI Agent?

## The Key Difference

<div class="columns">
<div class="card">

### Chatbot 🗣️

- Answers questions
- Returns text only
- Single-turn or simple multi-turn
- **Passive**: only responds

</div>
<div class="card blue-card">

### AI Agent 🤖

- **Takes action**
- Calls functions and APIs
- Multi-step reasoning loop
- **Active**: pursues goals

</div>
</div>

<br/>

> **An agent can use tools to read files, search the web,  
> run code, and interact with external systems.**

---

# 1. The "Aha!" Moment

```
User: "Analyze my sales CSV and write a summary"

Chatbot: "I can't access files or run analysis."

Agent:  → calls read_file("sales.csv")       ← tool 1
        → calls run_shell("python analyze.py")  ← tool 2
        → calls write_file("chart.html", ...)   ← tool 3
        → "Sales peaked in Q3 (+42% YoY).
           Here's the breakdown chart..."      ← final answer
```

<br/>

The agent **reasons** about what to do, **acts** with tools, and **responds** with results.

---

# 2. The Agent Loop

## The ReAct Pattern (Reason + Act)

```
┌────────────────────────────────────────────────┐
│                  AGENT LOOP                    │
│                                                │
│  User Message                                  │
│       ↓                                        │
│  Build Context (prompt + history + memory)     │
│       ↓                                        │
│  Call LLM with tools available                 │
│       ↓                                        │
│  Tool call? ──YES──→ Execute → append result   │
│       │                              │         │
│       │ ←────────── loop ────────────┘         │
│       │ NO                                     │
│       ↓                                        │
│  Final answer → User                           │
└────────────────────────────────────────────────┘
```

---

# 2. Agent Loop in Code

## `openai` npm package — direct streaming

```typescript
// AgentPrimer does NOT use streamText — it calls the openai package directly.
// This preserves reasoning_content (DeepSeek R1 chain-of-thought).
const stream = await openai.chat.completions.create({
  stream: true,
  model:    "deepseek-v4-flash",
  messages: conversationHistory,  // OpenAI message format
  tools:    toolSchemas,          // Zod-generated JSON Schema
});

// Vercel AI SDK is used only for the browser SSE wire format
return createDataStreamResponse({
  execute: async (writer) => {
    for await (const chunk of stream) { /* forward deltas */ }
  },
});
```

<br/>

The **tool-call loop is hand-written**: after each tool executes, its result is appended and the LLM is called again — up to the configured maximum, defaulting to 100 rounds for normal chat.

---

# 3. Tools & Skills

## What is a Tool?

A tool has four parts:

| Part | Purpose |
|------|---------|
| **Name** | Unique identifier (`search_web`) |
| **Description** | Tells LLM *when* to use it |
| **Parameters** | JSON Schema for inputs |
| **Execute** | The code that actually runs |

<br/>

> The **description** is the most important part.  
> A clear description → the agent uses the tool at the right time.

---

# 3. Tool Definition Example

```typescript
const weatherTool = tool({
  description: 'Get current weather for a city. Use when user asks about weather.',
  parameters: z.object({
    city: z.string().describe('The city name, e.g. "Tokyo"'),
    units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
  }),
  execute: async ({ city, units }) => {
    const data = await fetchWeatherAPI(city, units);
    return { temperature: data.temp, condition: data.condition };
  },
});
```

<br/>

The LLM sees the **name + description + parameter descriptions** and decides when to call the tool.

---

# 3. Skills vs Function Tools

**SKILL.md skill** = a Markdown instruction module the agent reads and follows. No code runs.

```
my-skill/
├── SKILL.md       ← YAML frontmatter + Markdown instructions
├── scripts/       ← (optional) referenced via read_file
└── assets/        ← (optional) templates, data files
```

**Function tool** = a callable function the agent invokes with JSON arguments. Code runs in a subprocess.

```
my-calculator/
├── function.json  ← OpenAI function schema
└── index.js       ← async function implementation
```

<br/>

Install either with a GitHub URL — AgentPrimer detects which format the repo uses.

```
https://github.com/owner/my-calculator-skill
```

The server clones the repo, runs `npm install`, and your tools are immediately available.

---

# 3. Subprocess Isolation 🔒

Function tools run in **isolated subprocesses** for security:

```
Main Server
    │
    │ spawn() — creates new Node.js process
    ▼
Function Tool Worker Process
    │ require('./skills/calculator/index.js')
    │ call: calculate({ expression: "2+2" })
    ↓
Result: { result: 4 }  ← IPC message back to parent
```

<div class="columns">
<div>

**Benefits:**
- Crashes don't affect main server
- Memory limited (256MB)

</div>
<div>

- 30s timeout on runaway code
- Receives only a minimal allowlisted environment

</div>
</div>

---

# 4. Model Context Protocol (MCP)

## USB-C for AI Tools

MCP is an **open standard** by Anthropic for connecting AI to tools and data.

> Any MCP agent ↔ Any MCP server

<div class="columns">
<div class="card">

### stdio transport
- Runs as child process
- Same machine
- Low latency
- Best for local tools

</div>
<div class="card blue-card">

### HTTP/SSE transport
- Runs as HTTP server
- Any machine, any network
- Persistent connection
- Best for remote/shared tools

</div>
</div>

---

# 4. MCP vs Skills

| | Skills | MCP Servers |
|--|--------|-------------|
| **Protocol** | Custom (fork + IPC) | Open standard (MCP) |
| **Language** | Node.js only | Any language |
| **Transport** | subprocess | stdio or HTTP |
| **Reuse** | AgentPrimer only | Any MCP-compatible agent |
| **Best for** | Quick tools | Reusable tool libraries |

<br/>

**Use MCP** when you want your tools to work with Claude, ChatGPT, and other MCP-compatible agents — not just AgentPrimer.

---

# 5. Memory Systems

## Why Agents Need Memory

Without memory, every conversation starts from scratch. The agent can't:

- Remember your name or preferences
- Build on previous work
- Learn from past conversations

<br/>

## Three Types

| Type | What | Storage |
|------|------|---------|
| **Conversation** | Current chat | SQLite messages table |
| **Long-term** | Persistent facts | `data/agents/<agent>/memory.md` file |
| **Semantic** | Searchable knowledge | (future) |

---

# 5. agents/<agent>/memory.md — Long-Term Memory

```markdown
# Agent Memory

## User Preferences
- Prefers TypeScript over JavaScript
- Uses 2-space indentation, single quotes
- Timezone: UTC+8 (Singapore)

## Current Project
- Name: ShopEasy e-commerce platform
- Stack: Next.js + PostgreSQL + Redis
- Current sprint: Payment integration

## Learned Facts
- API responses are always in snake_case
```

<br/>

This file is **injected into every system prompt**, giving the agent persistent context.

---

# 5. The Memory Tools

The agent can update its own memory during a conversation:

```
User: "My name is Alice and I prefer dark mode."

Agent: I should remember this.
→ calls append_memory({
    content: "## User Profile\n- Name: Alice\n- Prefers dark mode"
  })

Agent: "Got it Alice! I'll remember your dark mode preference."
```

<br/>

Memory accumulates over time, making the agent increasingly personalized.

---

# 6. Multi-Agent Systems

## Why Multiple Agents?

A single agent doing everything gets confused.  
**Specialized agents** excel at specific tasks.

```
                  ORCHESTRATOR
           "Write a research report"
              │                 │
              ▼                 ▼
           RESEARCHER          WRITER
          Finds sources     Writes draft
            and facts       with citations
```

<br/>

The **orchestrator** delegates work and synthesizes results.

---

# 6. Configuring Agents (agents/<agent>/agent.md)

```markdown
# main
**System Prompt:** You are a helpful orchestrator. 
Delegate specialized tasks to sub-agents.
**Tools:** all
**Model:** default

# researcher
**System Prompt:** Research topics thoroughly. Cite sources.
**Tools:** append_memory
**Model:** default

# coder
**System Prompt:** Write clean, well-documented code.
**Tools:** all
**Model:** default
```

---

# 6. The run_subagent_async Tool

```typescript
// Orchestrator calls this automatically
run_subagent_async({
  agent_name: "researcher",
  task: "Find the top 5 AI papers from 2025 on reasoning",
  project_folder: "/workspace"
})

// AgentPrimer then:
// 1. Loads researcher's system prompt
// 2. Starts a background task with researcher's tools/model
// 3. Queues a notification when complete
```

<br/>

**Guard**: An agent **cannot call itself** as a sub-agent — prevents infinite recursion.

---

# 7. Building a Function Tool

## Step 1: function.json

```json
{
  "name": "get_time",
  "description": "Get current time in any timezone. Use when user asks for the time.",
  "parameters": {
    "type": "object",
    "properties": {
      "timezone": { "type": "string", "description": "IANA timezone, e.g. Asia/Tokyo" }
    },
    "required": ["timezone"]
  }
}
```

---

# 7. Building a Function Tool

## Step 2: index.js

```javascript
'use strict';

module.exports = {
  // Function name must match the "name" in function.json
  async get_time({ timezone }) {
    const now = new Date();
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      dateStyle: 'full',
      timeStyle: 'long',
    }).format(now);

    return { time: formatted, timezone };
  },
};
```

<br/>

Drop into `data/function-tools/<name>/` → Settings → Discover → Enable → done! ✓

> Building a workflow or template? Use **SKILL.md** in `data/skills/<name>/` instead.

---

# 8. Building an MCP Server

## The Minimal Server

```javascript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server({ name: 'my-tools', version: '1.0.0' }, 
                          { capabilities: { tools: {} } });

server.setRequestHandler('tools/list', async () => ({
  tools: [{ name: 'greet', description: 'Greet someone',
    inputSchema: { type:'object', properties: { name: { type:'string' } }, required:['name'] } }]
}));

server.setRequestHandler('tools/call', async ({ params }) => {
  if (params.name === 'greet')
    return { content: [{ type: 'text', text: `Hello, ${params.arguments.name}!` }] };
});

await server.connect(new StdioServerTransport());
```

---

# 9. AgentPrimer Architecture

## Request Flow

```
Browser (useChat hook)
    │ POST /api/chat
    ▼
proxy.ts  ← JWT auth check
           (Next.js 16: proxy.ts, NOT middleware.ts)
    ▼
/api/chat/route.ts  ← save user message to SQLite; reject if RUN_IN_PROGRESS (409)
    ▼
lib/agent/streaming-agent.ts  ← createStreamingAgent(detached: true)
    ├─ load agents/<agent>/agent.md config
    ├─ load data/agents/<agent>/memory.md
    ├─ load skill tools (subprocess)
    ├─ load MCP tools (child process / HTTP)
    └─ load builtin-tools-registry.ts
    ▼
lib/agent/run-manager.ts  ← startRun(): floating promise + AbortController + watchdog
    ▼
openai.chat.completions.create({ stream: true, signal })
    │  (per-step checkpoint to SQLite; Stop button fires AbortController)
    ▼
createTailResponse() ← replay buffer + live forward (browser close only tears down tail)
    ▼
Browser ← real-time streaming text
    ▼
onFinish() ← save final assistant message to SQLite
```

---

# 9. Technology Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Next.js (App Router) + React |
| **Styling** | Tailwind CSS v4 |
| **LLM calls** | `openai` npm package (direct, not Vercel adapter) |
| **Stream wire** | Vercel AI SDK (`createDataStreamResponse`, `useChat`) |
| **Database** | SQLite (better-sqlite3) |
| **Auth** | JWT in httpOnly cookies (jose) |
| **MCP** | @modelcontextprotocol/sdk |
| **Subprocess** | child_process.spawn() |

---

# 9. Data Architecture

## All Persistent Data in /app/data/

```
/app/data/               ← Container volume mount
├── db/agent.db          ← Settings, sessions, messages
├── .users               ← Admin account store
├── agents/<agent>/memory.md            ← Agent persistent memory
├── agents/<agent>/agent.md            ← Agent configurations
├── uploads/             ← User file uploads
├── skills/              ← Installed skill packages
└── mcp-servers/         ← Installed MCP servers
```

<br/>

Mount host `./data` to container `/app/data` as a **persistent volume** in Docker/Dokploy so data survives container restarts.

---

# Deployment Checklist

<div class="columns">
<div>

### Before deploying:

- [ ] Change `AGENT_PRIMER_SECRET` env var
- [ ] Configure `/app/data` volume mount
- [ ] Register first admin user
- [ ] Set endpoint + API key in Settings

</div>
<div>

### Dokploy config:
```yaml
volumes:
  - /host/data:/app/data

environment:
  AGENT_PRIMER_SECRET: "your-64-char-secret"
  NODE_ENV: production
```

</div>
</div>

<br/>

> Your data (sessions, memory, installed skills) all  
> persists between deployments. ✓

---

<!-- _class: lead -->

# Summary

<br/>

| Concept | Key Insight |
|---------|------------|
| **Agent** | LLM + tools + loop = autonomous action |
| **Tools** | Functions the AI can call |
| **Skills** | Markdown instruction modules loaded into the agent prompt |
| **MCP** | Open standard for AI tools |
| **Memory** | Persistent context across sessions |
| **Multi-agent** | Specialized agents for complex tasks |
| **Streaming** | `openai` direct + Vercel AI SDK wire format |

<br/>

> **Full guide:** `docs/training.md` • **Ecosystem comparison:** `docs/09-ecosystem-comparison.md`

---

<!-- _class: lead -->

# Thank You!

<br/>

### Build something amazing with AgentPrimer

<br/>

**Questions?**  
Open an issue · Read the docs · Explore the code

<br/>

*AgentPrimer — Open source AI agent platform*  
*Built with ♥ using Next.js, `openai` (direct), Vercel AI SDK (wire only), and MCP*

---

# 15. Context Window Management

## The Problem

<div class="card">

Every conversation **adds tokens** to the context.  
Eventually you hit the model's limit and get an API error.

</div>

<br/>

<div class="columns">
<div class="card">

### Strategy 1: Sliding Window ✅
Keep only the last N exchanges.  
**Simple, free, implemented in AgentPrimer.**  
Settings → Context Window Compaction

</div>
<div class="card blue-card">

### Strategy 2: Summarization
Summarize old turns into a condensed prompt.  
Preserves context, but costs an LLM call.

</div>
</div>
<br/>
<div class="columns">
<div class="card">

### Strategy 3: Truncation
Drop tool-call/result pairs, keep text.  
Very high compression, zero cost.

</div>
<div class="card">

### Strategy 4: Pre-Flight Detection
Estimate tokens before each LLM call.  
Trigger compaction automatically at 80%.

</div>
</div>

---

# 15. Sliding Window — How It Works

```text
Before (15 exchanges → hitting limit):
  [sys] [u1] [t1a] ... [u15] [a15]  ← 50 messages

After (keep 5 exchanges):
  [sys] [notice] [u11] [a11] ... [u15] [a15]  ← 20 messages
```

- O(n) single pass, no LLM cost
- Always preserves system prompt
- Inject notice so model knows what was dropped
- Configurable: 0 = disabled, N = exchanges to keep
