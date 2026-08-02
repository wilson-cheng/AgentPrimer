# Building AI Agents: A Complete Guide

## Using AgentPrimer as Your Learning Platform

---

## Table of Contents

1. [What is an AI Agent?](#1-what-is-an-ai-agent)
2. [The Agent Loop](#2-the-agent-loop)
3. [Tools & Skills](#3-tools--skills)
4. [Model Context Protocol (MCP)](#4-model-context-protocol-mcp)
5. [Memory & Persistence](#5-memory--persistence)
6. [Multi-Agent Systems](#6-multi-agent-systems)
7. [Building Your Own Skill](#7-building-your-own-skill)
8. [Building Your Own MCP Server](#8-building-your-own-mcp-server)
9. [Advanced Patterns](#9-advanced-patterns)
10. [AgentPrimer Architecture Deep Dive](#10-agentprimer-architecture-deep-dive)
11. [Ecosystem Comparison](#11-ecosystem-comparison)
12. [Structured Output](#12-structured-output)
13. [RAG](#13-rag)
14. [Multimodal Attachments](#14-multimodal-attachments)
15. [Context Window Management](#15-context-window-management)

---

## 1. What is an AI Agent?

A **chatbot** answers questions. An **AI agent** *takes action*.

The key difference is **tool use**: an agent can call functions, search the web, read files, run code, and interact with external systems — all autonomously, in service of a goal.

```
User: "Analyze this CSV file and create a summary chart"

Chatbot: "I can't do that, I'm just a language model."

Agent:  → reads the CSV  (tool: read_file)
        → analyzes data  (tool: run_shell, if enabled)
        → creates chart  (tool: write_file + send_file/open_preview)
        → "Here's your chart! Key finding: sales peaked in Q3..."
```

### Core Components of an Agent

```
┌─────────────────────────────────────────────────────┐
│                      AI AGENT                       │
│                                                     │
│  ┌──────────┐   ┌──────────┐   ┌──────────────────┐ │
│  │  LLM     │   │  Tools   │   │     Memory       │ │
│  │ (Brain)  │◄──│(Hands)   │   │  (Long-term)     │ │
│  └──────────┘   └──────────┘   └──────────────────┘ │
│       │               │                  │          │
│       ▼               ▼                  ▼          │
│  Reasons about    Executes         Stores and       │
│  what to do       actions          retrieves info   │
└─────────────────────────────────────────────────────┘
```

---

## 2. The Agent Loop

The **agent loop** (also called the ReAct loop) is the core execution pattern:

```
┌──────────────────────────────────────────────────────┐
│                   AGENT LOOP                         │
│                                                      │
│  1. User sends message                               │
│         ↓                                            │
│  2. Build context (system prompt + history + memory) │
│         ↓                                            │
│  3. Call LLM with tools available                    │
│         ↓                                            │
│  4. Did LLM call a tool?                             │
│     YES → Execute tool → Append result → Go to 3     │
│     NO  → Return final answer to user                │
└──────────────────────────────────────────────────────┘
```

### In Code (AgentPrimer's agent.ts)

AgentPrimer does **not** use `streamText` from the Vercel AI SDK. Instead, it calls the `openai` npm package directly. This preserves vendor-specific response fields like `reasoning_content` (DeepSeek R1 chain-of-thought) that the Vercel adapter silently strips:

```typescript
// 1. Call the LLM directly — NOT streamText
const stream = await openai.chat.completions.create({
  stream: true,
  model:    modelId,       // e.g. "deepseek-v4-flash"
  messages: openaiMsgs,   // full conversation history in OpenAI format
  tools:    toolSchemas,  // Zod-generated JSON Schema ($schema key removed)
});

// 2. Wrap in Vercel AI SDK's data stream wire format (used only for the browser hook)
return createDataStreamResponse({
  execute: async (writer) => {
    for await (const chunk of stream) {
      // Forward text deltas, tool-call fragments, and reasoning tokens to browser
    }
    // After each tool call, the loop re-calls the LLM with the tool result appended
  },
});
```

The tool-call loop is hand-written inside `lib/agent/loop.ts`. After each tool executes, the result is appended to the message history and the LLM is called again — up to a configurable iteration limit (default: 100 rounds). This approach chains multiple tool calls:

```
User: "What's 2+2 and what's the weather in Tokyo?"
                                                     
Agent thought: I need to call two tools             
→ call calculator("2+2") → 4                        
→ call get_weather("Tokyo") → "20°C, sunny"         
→ "2+2 is 4. The weather in Tokyo is 20°C and sunny!"
```

---

## 3. Tools & Skills

### What is a Tool?

A **tool** is a function the AI can call. It has:
- **Name**: unique identifier
- **Description**: tells the LLM *when* to use it
- **Parameters**: JSON Schema defining expected inputs
- **Execute**: the actual code that runs

```typescript
// Example tool definition (Vercel AI SDK)
function evaluateArithmetic(expression: string): number {
  if (!/^[0-9+\-*/().\s]+$/.test(expression)) throw new Error('unsupported expression');
  const tokens = expression.match(/\d+(?:\.\d+)?|[+\-*/()]/g) ?? [];
  if (tokens.join('').replace(/\s/g, '') !== expression.replace(/\s/g, '')) throw new Error('unsupported expression');
  return Number(Function(`"use strict"; return (${tokens.join('')})`)());
}

const calculateTool = tool({
  description: 'Evaluate a mathematical expression',
  parameters: z.object({
    expression: z.string().describe('The math expression, e.g. "2 + 2"'),
  }),
  execute: async ({ expression }) => ({ result: evaluateArithmetic(expression) }),
});
```

### What is a Function Tool?

A **Function Tool** in AgentPrimer is a **callable function package** installed from GitHub or registered locally. Function tools are how the agent executes deterministic code — math, API calls, file parsing, anything that needs to run *exactly* the same way every time.

```
my-calculator/
├── function.json     ← OpenAI function schema (name, description, parameters)
└── index.js          ← CommonJS module exporting one async function per tool
```

**function.json:**
```json
{
  "name": "calculator",
  "description": "Evaluate a mathematical expression and return the numeric result. Use when the user asks to calculate, compute, or evaluate arithmetic.",
  "parameters": {
    "type": "object",
    "properties": {
      "expression": {
        "type": "string",
        "description": "The arithmetic expression to evaluate, e.g. '(3 + 4) * 2'"
      }
    },
    "required": ["expression"]
  }
}
```

**index.js:**
```javascript
'use strict';

module.exports = {
  // Function name must match the "name" in function.json
  async calculator({ expression }) {
    // Whitelist arithmetic chars to prevent code injection
    if (!/^[\d\s+\-*/.%()]+$/.test(expression)) {
      throw new Error('Only numbers and arithmetic operators are allowed.');
    }
    const tokens = expression.match(/\d+(?:\.\d+)?|[+\-*/()]/g) ?? [];
    if (tokens.join('').replace(/\s/g, '') !== expression.replace(/\s/g, '')) {
      throw new Error('Only numbers and arithmetic operators are allowed.');
    }
    const result = Function('"use strict"; return (' + tokens.join('') + ')')();
    return { result };
  }
};
```

### What is a SKILL.md Skill?

A **Skill** in AgentPrimer is an **instruction module** following the [agentskills.io](https://agentskills.io/) open standard. Skills are *not* callable functions — they are Markdown documents whose content is injected into the agent's system prompt. The agent reads the instructions and follows them using its own reasoning.

```
my-skill/
├── SKILL.md          ← Required: YAML frontmatter + Markdown instructions
├── scripts/          ← Optional: scripts the agent can run (via run_shell or read_file)
├── references/       ← Optional: detailed reference docs the agent can read on demand
└── assets/           ← Optional: templates, data files, schemas
```

**SKILL.md:**
```markdown
---
name: report-generator
description: Generate a polished 5-10 page report from a topic or notes. Use when the user asks to "write a report", "create a document", or "generate a whitepaper".
metadata:
  level: "2 - Intermediate"
  author: AgentPrimer
---

# Report Generator

## What This Skill Does
1. Analyse the user's request and pick a topic
2. Outline 5-10 pages of structured content
3. Generate a print-styled A4 HTML document
4. Open it in the preview panel

## Instructions
... (the agent reads and follows these steps) ...
```

### When to Use Each

| Use a Function Tool | Use a SKILL.md Skill |
|---------------------|----------------------|
| Exact computation (math, conversion, hashing) | Multi-step workflows |
| Calling external APIs | Templates and guidelines |
| Anything requiring determinism | Structured output patterns |
| Parsing structured data | Research methodologies |

### Subprocess Isolation (Function Tools)

For security, AgentPrimer runs function tool handlers in **isolated subprocesses**:

```
Main Server Process
      │
      │  spawn('node', ['--max-old-space-size=256', 'lib/function-tool-worker.js'])
      ▼
Function Tool Worker Process (separate Node.js instance, 256 MB cap)
      │  require('./function-tools/calculator/index.js')
      │  call: calculator({ expression: "2+2" })
      │
      ▼ (JSON over stdout back to parent)
Result: { result: 4 }
```

Benefits:
- A buggy function tool **cannot crash** the main server
- Function tools run with limited memory (256MB cap)
- 35-second timeout kills runaway function tools
- Function tools cannot access parent process memory or module cache

---

## 4. Model Context Protocol (MCP)

**MCP** (Model Context Protocol) is an open standard by Anthropic for connecting AI models to external tools and data sources.

Think of it as **USB-C for AI tools**: any MCP-compatible agent can use any MCP-compatible tool server.

### Two Transport Types

**stdio** (most common): The MCP server runs as a child process on the same machine.
```
Agent Process ←—IPC/stdio—→ MCP Server Process
```

**HTTP/SSE**: The MCP server runs as an HTTP server (can be remote).
```
Agent Process ←—HTTP—→ MCP Server (any machine)
```

### How AgentPrimer Uses MCP

```typescript
// Connect to a stdio MCP server
const transport = new StdioClientTransport({
  command: 'node',
  args: ['data/mcp-servers/my-server/server.js'],
});

const client = new Client({ name: 'agentprimer', version: '1.0' }, {});
await client.connect(transport);

// List available tools
const { tools } = await client.listTools();
// → [{ name: 'search_web', description: '...', inputSchema: {...} }]

// Call a tool
const result = await client.callTool({
  name: 'search_web',
  arguments: { query: 'latest AI news' },
});
```

### Writing an MCP Server (stdio)

```javascript
// server.js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server(
  { name: 'my-tools', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Register tools
server.setRequestHandler('tools/list', async () => ({
  tools: [{
    name: 'greet',
    description: 'Greet a person by name',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  }],
}));

server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;
  if (name === 'greet') {
    return { content: [{ type: 'text', text: `Hello, ${args.name}!` }] };
  }
  throw new Error(`Unknown tool: ${name}`);
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
```

---

## 5. Memory & Persistence

### Why Agents Need Memory

Without memory, every conversation starts from scratch. The agent can't:
- Remember your name, preferences, or past work
- Build on previous conversations
- Learn from mistakes

### Three Types of Memory

| Type | What | Where in AgentPrimer |
|------|------|-------------------|
| **Conversation** | Current chat history | `messages` table in SQLite |
| **Long-term** | Persistent facts across sessions | `data/agents/<agent>/memory.md` file |
| **Semantic document knowledge** | Searchable RAG index | Implemented via chunking, embeddings, vector ranking, and FTS5 fallback |

### agents/<agent>/memory.md in Action

```markdown
# Agent Memory

## User Preferences
- User prefers TypeScript over JavaScript
- User works on a MacBook Pro with 32GB RAM
- User's timezone is UTC+8 (Singapore)

## Project Context
- Working on: E-commerce platform "ShopEasy"
- Tech stack: Next.js, PostgreSQL, Redis
- Current sprint: Payment integration

## Learned Facts
- User's API key prefix: sk-proj-... (stored safely in settings)
- Preferred code style: 2-space indent, single quotes
```

This is **injected into every system prompt**, so the agent always has this context:

```typescript
const systemPrompt = `
${agentConfig.systemPrompt}

## Persistent Memory
${memory}  // ← injected here
`;
```

### The Memory Tools

The agent can update its own memory:

```
User: "My name is Alice and I prefer Python for data scripts."

Agent thought: I should remember this.
→ calls append_memory({
    content: "## User Profile\n- Name: Alice\n- Prefers Python for data scripts"
  })
→ "Got it! I'll remember your name is Alice and that you prefer Python for data scripts."
```

Use `replace_memory` only when intentionally rewriting the entire memory file.

---

## 6. Multi-Agent Systems

### Why Multiple Agents?

A single agent trying to do everything gets confused. Specialized agents excel at specific tasks.

```
┌─────────────────────────────────────────────────┐
│                   ORCHESTRATOR                  │
│                                                 │
│ "Research this topic and write a blog post"     │
│             │                      │            │
│             ▼                      ▼            │
│ ┌─────────────────────┐ ┌─────────────────────┐ │
│ │      RESEARCHER     │ │       WRITER        │ │
│ │     Finds facts     │ │   Writes content    │ │
│ │     and sources     │ │   with citations    │ │
│ └─────────────────────┘ └─────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### The run_subagent_async Tool

```typescript
// Built-in tool that delegates to a background sub-agent
run_subagent_async: tool({
  description: 'Start a background task with a specialized sub-agent',
  parameters: z.object({
    agent_name: z.string(),      // must exist in data/agents/<agent>/agent.md
    task: z.string(),            // the task to give the sub-agent
    project_folder: z.string(),  // working directory for the task
  }),
  execute: async ({ agent_name, task, project_folder }) => {
    const result = await startAsyncSubagent(agent_name, task, project_folder);
    return result;
  },
}),
```

### agents/<agent>/agent.md Configuration

```markdown
# main
**System Prompt:** You are a helpful orchestrator. Delegate to specialists.
**Tools:** all
**Model:** default

# researcher
**System Prompt:** You research topics thoroughly. Summarize findings clearly.
**Tools:** append_memory
**Model:** default

# coder
**System Prompt:** You write excellent code. Explain your reasoning.
**Tools:** all
**Model:** default
```

### Sub-Agent Execution Flow

```
1. Main agent calls run_subagent_async("researcher", "Find latest AI papers from 2025", project_folder)
2. AgentPrimer creates a background task with:
   - researcher's system prompt
   - researcher's allowed tools
   - default llm model
3. Researcher agent runs, possibly calling its own tools and writing status updates
4. Completion is queued in `agent_notifications`
5. Main agent incorporates the research on the next turn
```

**Recursion guard**: An agent cannot call itself as a sub-agent (prevents infinite loops).

---

## 7. Building Your Own Function Tool

### Step 1: Create the Repository Structure

```bash
mkdir my-tool && cd my-tool
git init
```

### Step 2: Create function.json

```json
{
  "name": "get_time",
  "description": "Get the current time in a specific IANA timezone. Use when the user asks for the current time or wants to convert a timestamp into a specific zone.",
  "parameters": {
    "type": "object",
    "properties": {
      "timezone": {
        "type": "string",
        "description": "IANA timezone, e.g. 'America/New_York', 'Asia/Tokyo', 'UTC'"
      }
    },
    "required": ["timezone"]
  }
}
```

> Want to declare multiple functions in one package? Use the `functions: [...]` array form — `lib/function-tools-loader.ts` accepts both shapes.

### Step 3: Create index.js

```javascript
'use strict';

module.exports = {
  // Function name must match the "name" in function.json
  async get_time({ timezone }) {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      dateStyle: 'full',
      timeStyle: 'long',
    });
    return { time: formatter.format(now), timezone };
  },
};
```

### Step 4: Test Locally

```bash
node -e "
const tool = require('./index.js');
tool.get_time({ timezone: 'Asia/Tokyo' }).then(console.log);
"
```

### Step 5: Register the Function Tool

1. Copy the directory into `data/function-tools/<name>/`
2. Open **Skills & MCP → Function Tools** in the app
3. Click **Discover** to detect the new directory
4. Click **Enable**
5. Your tool appears as a callable function in the agent's next turn — visible as an amber `LiveToolCard` bubble in the chat when called

### Bonus: Build a SKILL.md Skill Instead

If your "tool" is really a workflow or set of instructions (not deterministic code), build a SKILL.md skill:

1. Create `data/skills/<name>/SKILL.md` with the YAML frontmatter shown above
2. Open **Skills & MCP → Skills** → **Discover** → **Enable**
3. The agent's system prompt now lists your skill under "## Available Skills"
4. When a matching task arrives, the agent calls the built-in `load_skill` tool to read the full instructions, then follows them

See `defaults/skills/report-generator/SKILL.md` for a complete worked example.

---

## 8. Building Your Own MCP Server

### stdio MCP Server Example

```bash
mkdir my-mcp-server && cd my-mcp-server
npm init -y
npm install @modelcontextprotocol/sdk
```

**server.js:**
```javascript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';

const server = new Server(
  { name: 'file-tools', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'read_file',
      description: 'Read a text file and return its contents',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read' },
        },
        required: ['path'],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  if (name === 'read_file') {
    try {
      const content = fs.readFileSync(args.path, 'utf-8');
      return {
        content: [{ type: 'text', text: content }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
  
  throw new Error(`Unknown tool: ${name}`);
});

// Connect to stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
```

**package.json:**
```json
{
  "name": "my-mcp-server",
  "type": "module",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  }
}
```

### HTTP/SSE MCP Server

For remote or persistent servers, use HTTP:

```javascript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';

const app = express();
const server = new Server(/* ... */);

// SSE endpoint for MCP protocol
app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  await server.connect(transport);
});

app.post('/messages', express.json(), async (req, res) => {
  // Handle incoming messages
});

app.listen(3001);
```

---

## 9. Advanced Patterns

### Prompt Chaining

Break complex tasks into sequential steps:

```
Step 1: Research  → Step 2: Outline  → Step 3: Write  → Step 4: Review
```

With AgentPrimer, you can implement this with sub-agents:

```
# orchestrator
**System Prompt:** You coordinate complex writing tasks.
  For each task:
  1. Call researcher to gather information
  2. Call outliner to create structure
  3. Call writer to produce the draft
  4. Call reviewer to improve quality
**Tools:** run_subagent_async, append_memory
```

### Reflection Pattern

The agent critiques its own output:

```
Initial Answer → Self-Critique → Improved Answer
```

```markdown
# reflective
**System Prompt:** After producing any answer:
  1. First draft your response
  2. Critique it: What's missing? What could be clearer?
  3. Revise based on your critique
  Only then provide the final answer.
**Tools:** all
```

### Tool Use Best Practices

1. **Descriptive names**: `search_web` not `s`
2. **Clear descriptions**: Tell the LLM *when* to use the tool, not just *what* it does
3. **Validation**: Always validate inputs in the execute function
4. **Error messages**: Return helpful error messages, not raw exceptions
5. **Idempotency**: Tool calls may be retried; design accordingly

---

## 10. AgentPrimer Architecture Deep Dive

### Request Flow

```
Browser
  │ POST /api/chat { sessionId, messages, agentName, modelId }
  ▼
proxy.ts               ← validates JWT session cookie for page routes
                          (Next.js 16: must be proxy.ts — middleware.ts is silently ignored)
  ▼
app/api/chat/route.ts  ← saves user message to SQLite; rejects if RUN_IN_PROGRESS (409)
  ▼
lib/agent/streaming-agent.ts  ← createStreamingAgent(detached: true)
  │ ├── getAgentConfig()        from data/agents/<agent>/agent.md
  │ ├── readMemory()            from data/agents/<agent>/memory.md
  │ ├── buildSkillDiscoverySection() from lib/skills-loader.ts
  │ ├── loadFunctionTools()     from lib/function-tools-loader.ts
  │ ├── loadMcpTools()          from lib/mcp-client.ts
  │ └── createBuiltinTools()    from lib/agent/builtin-tools.ts + builtin-tools-registry.ts
  │
  ▼
lib/agent/run-manager.ts  ← startRun(): floating promise + AbortController + 30-min watchdog
  │                          writes AI-SDK parts to a bounded replay buffer
  ▼
openai.chat.completions.create({ stream: true, signal, model, messages, tools })
  │
  ├── AI calls tool → execute() → append result → checkpoint to SQLite → call LLM again
  ├── AI calls tool → execute() → append result → checkpoint to SQLite → call LLM again
  └── AI produces final text
  │
  ▼
createTailResponse()    ← replays buffer, then forwards live parts to browser
  │                        browser close only tears down the tail — the loop keeps running
  ▼
Browser useChat() hook  ← streams text to UI in real-time
  │
  ▼
onFinish() callback    ← saves final assistant message to SQLite (overwrites checkpoints)
```

> **Detached execution:** The loop runs as a **floating background promise** owned by `lib/agent/run-manager.ts`, not inside the HTTP `execute` callback. Closing the browser mid-stream no longer kills the run — it keeps going, checkpoints partial progress to SQLite after every step, and a later reopen polls `/api/chat/active`, re-attaches a tail, or (if the run already finished) loads the persisted result from the DB. Only `POST /api/chat/stop` (the Stop button) cancels a run, via the run's `AbortController`. One active run per (owner, session) is enforced server-side (409 `RUN_IN_PROGRESS`).

### Database Schema

```sql
settings            (key, value)                        ← endpoint, api_key, default_model, embedding_provider, max_agent_steps
sessions            (id, title, agent_name, created_at, updated_at)
messages            (id, session_id, role, content, attachments_json, tool_calls_json,
                     token_usage_json, reasoning_json, parts_json, trace_json, created_at)
skills              (id, name, github_url, local_path, enabled, manifest_json)
function_tools      (id, name, github_url, local_path, enabled, manifest_json)
mcp_servers         (id, name, github_url, local_path, transport, command, args_json, url, enabled)
permanent_approvals (operation)                          ← remembered approvals
agent_tasks         (id, project_folder, assigner, assignee, prompt, task_file, status, created_at, finished_at)
agent_notifications (id, session_id, task_id, task_file, summary, created_at, read_at)
knowledge_sources   (id, name, source_type, content_md5, embedding_model, chunk_count, ingested_at) ← RAG documents
knowledge_chunks    (id, source_id, chunk_index, chunk_text, embedding, created_at) ← RAG chunks
knowledge_fts       FTS5 virtual table over knowledge_chunks                   ← keyword fallback
token_usage_log     (id, day, input, cached, output, created_at)
```

`agent_tasks` and `agent_notifications` support the async sub-agent pattern: when an agent runs `run_subagent_async`, the task is written to a Markdown file and indexed here. When the sub-agent completes, a notification is queued for the parent session so the orchestrator can read the result in its next turn.

### File System Layout (Persistent Volume)

```
/app/data/               ← Container path mounted from host `./data`
├── db/
│   └── agent.db         ← SQLite database (all state including RAG vectors)
├── .users               ← First-run admin account store
├── system.md            ← Global system prompt (prepended to every agent)
├── agents/<agent>/memory.md            ← Agent persistent memory
├── agents/<agent>/agent.md            ← Agent configurations (name, prompt, tools, model, output schema)
├── models/              ← Transformers.js ONNX model cache (~90 MB, all-MiniLM-L6-v2)
├── uploads/             ← User-uploaded files (images, audio, text)
├── agent-files/         ← Files created by the agent via send_file tool
│   └── <uuid>/<file>
├── skills/              ← Installed SKILL.md skill packages
│   └── my-skill/
│       └── SKILL.md
├── function-tools/      ← Installed function tool packages
│   └── my-tool/
│       ├── function.json
│       └── index.js
└── mcp-servers/         ← Installed MCP servers
    └── my-server/
        └── server.js
```

### Security Considerations

1. **Function tool isolation**: Function tools run in subprocesses (256 MB cap, 35s timeout), can't access server memory
2. **Auth**: JWT in httpOnly cookie, not accessible to JavaScript
3. **Path traversal**: Upload serving sanitizes filenames with `path.basename()`
4. **API key masking**: Settings API never returns raw API key
5. **Input validation**: All API routes validate inputs
6. **OWASP Top 10**: No SQL injection (parameterized queries), XSS prevented by React's escaping

---

## Quick Reference

### agents/<agent>/agent.md Format

```markdown
# AgentName
**System Prompt:** The system prompt text here.
Can span multiple lines.
**Tools:** all  OR  tool1, tool2, skill_name__tool_name
**Model:** default  (optional)
```

### Tool Naming Convention

- Built-in tools: `append_memory`, `replace_memory`, `run_subagent_async`
- Function tools: the function name from `function.json` (e.g., `calculator`)
- MCP tools: `servername__toolname` (e.g., `github__create_issue`)

### Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_PRIMER_SECRET` | unset | JWT signing secret; required in production |
| `NODE_ENV` | `development` | Affects cookie security settings |

### Deployment Checklist

- [ ] Set `AGENT_PRIMER_SECRET` to a random 64-char string
- [ ] Mount host `./data` to container `/app/data` as a persistent volume
- [ ] Register the first admin user on first launch
- [ ] Configure endpoint and API key in Settings
- [ ] Run `npm run build && npm start`

---

---

## 11. Ecosystem Comparison

For a detailed comparison of AgentPrimer against the two leading open-source personal AI agent applications, see [**Module 09 — Ecosystem Comparison**](./09-ecosystem-comparison.md).

| Project | Delivery | Key Strength |
|---------|----------|--------------|
| **AgentPrimer** | Web UI, single-admin self-hosted | Browser-first, rich Preview Panel, training-friendly architecture |
| **OpenClaw** | Daemon + 20 channels | Omnichannel (WhatsApp, Telegram, iMessage…), 5,400+ skills on ClawHub |
| **Hermes Agent** | Terminal TUI + gateway | Self-improving skills, FTS5 memory search, 7 execution backends |

The comparison covers: architecture diagrams, feature matrix, gap analysis (Docker sandboxing, messaging delivery, FTS5 memory, cron scheduler, skills registry), and a concrete roadmap for closing each gap.

---

*AgentPrimer – Built with Next.js, `openai` npm package (direct), Vercel AI SDK (wire protocol only), better-sqlite3, and @modelcontextprotocol/sdk*

---

## 12. Structured Output

### What Is Structured Output?

Most agent responses are free-form text. **Structured output** forces the agent to return a specific JSON schema — a typed, validated data structure instead of prose.

Use cases:
- **Document analysis** — extract entities, dates, action items from meeting notes
- **Data pipelines** — feed agent output directly to downstream code without parsing
- **Form filling** — populate a database record from free-text input
- **Comparison tables** — extract feature comparisons from product descriptions

### How It Works in AgentPrimer

A structured output agent always finishes with a **non-streaming finalize call** that returns JSON. With `Tools: none`, it goes straight to finalization; with tools enabled, it first runs the normal ReAct loop and then finalizes the transcript:

```
Normal agent:            LLM → tool call → result → LLM → answer
Structured, no tools:    LLM finalize → JSON object
Structured, with tools:  LLM → tool call → result → LLM → finalize → JSON object
```

### Configuring a Structured Output Agent

Add `**Output Schema:**` to an agent in `data/agents/<agent>/agent.md`:

````markdown
# extractor
**System Prompt:** You extract structured information from documents. Be precise.
**Output Schema:** Entity Extractor
Extracts summary and sentiment from text.
```json
{
  "type": "object",
  "properties": {
    "summary": { "type": "string" },
    "sentiment": { "type": "string", "enum": ["positive", "negative", "neutral", "mixed"] }
  },
  "required": ["summary", "sentiment"]
}
```
**Tools:** none
**Model:** default
````

The `**Output Schema:**` label is followed by an inline fenced JSON Schema in `data/agents/<agent>/agent.md`. The full JSON schema is printed in the finalize prompt so the model knows exactly what to produce.

### Adding a New Schema

1. Open `data/agents/<agent>/agent.md`
2. Add a new agent block with an inline schema:

````markdown
# product-extractor
**System Prompt:** You extract product details from text.
**Output Schema:** Product Extractor
Extracts product name, price, and features from text.
```json
{
  "type": "object",
  "properties": {
    "product_name": { "type": "string" },
    "price_usd": { "type": "number" },
    "features": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["product_name", "price_usd", "features"]
}
```
**Tools:** none
**Model:** default
````

Done — no TypeScript registry or database migration is needed.

### Rendering in the UI

Structured output is rendered in the `StructuredOutputPanel` component — a formatted field table with colored badges for enums, bullet lists for arrays, and a collapsible raw JSON section. The panel appears in place of the normal message bubble.

**Dual-path rendering:** During a live session the panel is populated from the SSE data stream; after page reload it's restored from `parts_json` in the SQLite `messages` table.

---

## 13. RAG

### The Problem with Flat-File Memory

`data/agents/<agent>/memory.md` is injected into every system prompt verbatim. This works for a few hundred tokens but breaks when:
- Memory grows beyond ~5k tokens (context window pressure)
- Only a subset of facts is relevant to each query (noise)
- You need to query documents you haven't manually summarized into agents/<agent>/memory.md

### What RAG Does

**Retrieval-Augmented Generation** retrieves only the relevant text chunks at query time:

```
Without RAG: system prompt = instructions + ALL of agents/<agent>/memory.md
With RAG:    agent calls search_rag → top-k relevant chunks return as a tool result
```

### The Four Stages

```
1. CHUNK   — split document into ~1600-char pieces with 200-char overlap
2. EMBED   — convert each chunk to a float vector (semantic representation)
3. STORE   — save (chunk_text, vector) in SQLite knowledge_chunks table
4. RETRIEVE— embed the query, find closest vectors, return top-k chunks
```

### Using the RAG

1. Go to `/knowledge` in the sidebar
2. Click the **Paste** or **Upload** tab
3. Add a document (Markdown, plain text, PDF)
4. The document is automatically chunked and embedded

The agent then uses the `search_rag` tool to query it:

```
User: "What were the action items from last week's meeting?"
Agent: → calls search_rag("action items last week meeting")
       → retrieves 3 relevant chunks from meeting notes you uploaded
       → synthesizes an answer from those chunks
```

### Embedding Providers

| Provider | Setup | Dimensions | Notes |
|----------|-------|-----------|-------|
| Local (Transformers.js) | In-process, automatic | 384 | Free; runs in Node, no Python |
| OpenAI | Set API key in Settings | 1536 | Better quality; costs money |

The RAG page shows a health badge indicating which provider is active and whether it's working.

### FTS5 Fallback

If no embedding provider is available, the RAG index automatically uses **SQLite FTS5 keyword search** (BM25 ranking). Lower quality than vector search but still useful. The health badge shows `degraded` when FTS5 is the active path.

---

## 14. Multimodal Attachments

### What AgentPrimer Supports

The chat input accepts file attachments that are sent directly to the LLM as multimodal content:

| Type | Formats | Sent as |
|------|---------|---------|
| Images | PNG, JPEG, GIF, WebP | Base64 `image_url` in the message |
| Audio | MP3, WAV, OGG, M4A | Base64 `input_audio` content part |
| Text | TXT, MD, JSON, CSV, code files | Plain text inlined in the message |

### How It Works

When the user attaches a file:

1. The file is uploaded to `/api/upload` and saved to `data/uploads/`
2. The URL is stored in the message's `attachments_json`
3. When the message is sent to the LLM, `buildMultimodalContent()` in `lib/agent/messages.ts` converts attachments to the appropriate OpenAI API content parts
4. The model receives the image/audio/text as part of its context

### Example: Image Analysis

```
User: [attaches screenshot.png] "What's wrong with this UI layout?"
Agent: → receives image as image_url content part
       → "The button alignment is off — the primary CTA is not visually centered 
          in the card. The padding on the left is 16px but 8px on the right..."
```

### Model Compatibility

Not all models support all modalities:
- **Vision (images)**: GPT-4o, Claude 3.x, Gemini 1.5+, LLaVA via Ollama
- **Audio**: GPT-4o Audio, Gemini 1.5 Pro
- **Text**: All models (text files are just inlined as string content)

If you send an image to a text-only model, it will either error or silently ignore it. Stick to vision-capable models when using image attachments.

---

## 15. Context Window Management

### The Problem

Every LLM has a **finite context window** — the maximum number of tokens it can process in a single request. For a conversation agent, the problem is that every turn adds messages to the history. Over a long session the conversation grows until it exceeds the model's token limit, at which point the API returns an error and the conversation is effectively stuck.

```
Conversation Growth Over Time:

Turn  1: [system] [user-1] [assistant-1]                              ≈ 2,000 tokens
Turn 10: [system] [user-1] ... [user-10] [assistant-10]                ≈ 20,000 tokens
Turn 50: [system] [user-1] ... [user-50] [assistant-50]                ≈ 100,000 tokens
Turn 100: [system] [user-1] ... [tool-42a] ... [assistant-100]         ≈ 250,000+ tokens
                                                                              ↑
                                                              Model limit (e.g. 128K) → ERROR
```

This is one of the most practical engineering challenges in building production agents. Several strategies exist to manage it, each with different trade-offs.

### How AgentPrimer Handles It

AgentPrimer provides a **context gauge** below each assistant message that shows the current context usage (e.g., `120K / 1M`). When the gauge turns red (>80%), you're approaching the limit.

Additionally, AgentPrimer implements **Strategy 1 (Sliding Window)** below, configurable from the Settings page.

---

### Strategy 1: Sliding Window (Implemented in AgentPrimer)

**How it works:** Keep only the N most recent message exchanges (pairs of user + assistant). Older messages are silently dropped. The system prompt and any in-flight tool-call messages are always preserved.

```
Before compaction (15 exchanges, 50 total messages):
  [sys] [u1] [a1] [t1a] [t1b] [u2] [a2] [u3] [a3] ... [u15] [a15]
   ↑                                                          ↑
   always kept                                          most recent

After compaction (keep 5 exchanges):
  [sys] [notice] [u11] [a11] [u12] [a12] [u13] [a13] [u14] [a14] [u15] [a15]
   ↑      ↑                                                              ↑
   kept   "System: older messages dropped"                         most recent
```

**Where it runs:** In [lib/agent/messages.ts](lib/agent/messages.ts), the `compactConversation()` function is called after messages are converted to OpenAI format and before they're sent to the LLM.

**How to configure:** Go to **Settings → Chat Behavior → Context Window Compaction** and set the number of recent exchanges to keep. Set to `0` (default) to disable.

**Pros:**
- ✅ Simple and fast — O(n) single pass, no LLM calls needed
- ✅ Deterministic — same input always produces same output
- ✅ Transparent — a system notice is injected telling the model what was dropped
- ✅ Predictable token usage — you can estimate max tokens from window size

**Cons:**
- ❌ The agent "forgets" early conversation context
- ❌ May cause repetitive questions about information that was already discussed
- ❌ No graceful degradation — it's a hard cut rather than progressive compression

**When to use:** Long-running conversations where early context becomes irrelevant (e.g., a coding assistant that only needs the current task, not the full project history).

```typescript
// ── The core sliding-window algorithm (from lib/agent/messages.ts) ──

function compactConversation(
  apiMessages: OpenAI.Chat.ChatCompletionMessageParam[],
  keepPairs: number,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (keepPairs <= 0 || apiMessages.length <= keepPairs + 1) return apiMessages;

  const keepIndices = new Set<number>();
  let pairsFound = 0;
  keepIndices.add(0); // Always keep system prompt

  // Walk backwards: each "user" message starts a new exchange pair
  for (let i = apiMessages.length - 1; i >= 0; i--) {
    const msg = apiMessages[i];
    if (msg.role === 'user') {
      keepIndices.add(i);
      pairsFound++;
      if (pairsFound >= keepPairs) break;
    } else {
      keepIndices.add(i); // assistant, tool, or system messages
    }
  }

  if (pairsFound < keepPairs) return apiMessages;
  return apiMessages.filter((_, i) => keepIndices.has(i));
}
```

---

### Strategy 2: Summarization-Based Compaction

**How it works:** When the context exceeds a threshold, use the LLM itself to summarize the older conversation turns into a condensed prompt. The summary replaces the old messages.

```
Before:
  [sys] [u1] [a1] [u2] [a2] [u3] [a3] ... [u20] [a20]

Step 1 – Summarize old turns:
  LLM call: "Summarize turns 1-15 in 2 paragraphs..."
  → "The user asked about X, then Y was implemented, then Z was discussed..."

Step 2 – Replace with summary:
  [sys] [summary-message] [u16] [a16] ... [u20] [a20]
         ↑
    "Earlier conversation summary: ..."

Total tokens: summary(200) + last 5 turns(15K) ≈ 15.2K vs original 50K
```

**Pros:**
- ✅ Preserves the essence of early conversation
- ✅ Significantly reduces token count
- ✅ No information about past decisions is completely lost

**Cons:**
- ❌ Expensive — each compaction costs an LLM call (tokens + latency)
- ❌ Lossy — summaries inevitably lose detail and nuance
- ❌ Complex — need to decide WHEN to summarize, WHAT to include, and handle errors
- ❌ The summary itself takes context space (though much less than the original)

**When to use:** Customer support, tutoring, or any scenario where the agent must remember the full context but the conversation is very long.

---

### Strategy 3: Truncation (Drop Tool Internals)

**How it works:** Remove tool-call and tool-result messages from older exchanges, keeping only the user query and the final assistant text reply. This dramatically reduces token count without losing the semantic conversation flow.

```
Before (1 exchange with 3 tool calls):
  [user: "analyze sales.csv"]
  [assistant: tool_call → read_file]
  [tool: CSV contents (500 tokens)]
  [assistant: tool_call → run_shell]
  [tool: Python output (300 tokens)]
  [assistant: tool_call → write_file + send_file]
  [tool: Chart data (200 tokens)]
  [assistant: "Sales peaked in Q3..."]
  Total: ~1,100 tokens

After truncation:
  [user: "analyze sales.csv"]
  [assistant: "Sales peaked in Q3..."]
  Total: ~50 tokens (95% reduction)
```

**Pros:**
- ✅ High compression ratio for tool-heavy conversations
- ✅ Preserves user intent and agent's final answer
- ✅ No LLM cost — purely structural

**Cons:**
- ❌ If the user asks "what was in that CSV file?", the agent can't recall
- ❌ Tool results often contain important data the model may need later
- ❌ Must be paired with some strategy for when the user references past results

**When to use:** Agents that use expensive tools (web search, code execution) where the raw tool output is rarely needed again once the answer is given.

---

### Strategy 4: Pre-Flight Detection (Proactive Compaction)

**How it works:** Before every LLM call, estimate the token count of the current message array. If it exceeds a safety threshold (e.g., 80% of the model's context window), trigger one of the above compaction strategies automatically.

```
Agent Loop (with pre-flight detection):

  1. User sends message
  2. Estimate token count of current context
  3. Is it > 80% of model's context limit?
     YES → Trigger compaction (sliding window / summarization / truncation)
     NO  → Continue
  4. Call LLM
  5. Process tool calls or return answer
```

**Token estimation approaches (without an actual tokenizer):**

```typescript
// Rough estimation: 1 token ≈ 4 characters for English text
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Better: count message parts with per-role heuristics
function estimateMessageTokens(msgs: Message[]): number {
  let total = 0;
  for (const msg of msgs) {
    total += 4; // base overhead per message
    if (typeof msg.content === 'string') {
      total += Math.ceil(msg.content.length / 4);
    }
    if (msg.role === 'system') total += 4; // system message overhead
    if (msg.role === 'tool') total += 2;   // tool result overhead
  }
  return total;
}
```

**Pros:**
- ✅ Automatic — no user intervention needed
- ✅ Prevents errors before they happen (proactive vs reactive)
- ✅ Can be combined with any compaction strategy

**Cons:**
- ❌ Token estimation is imprecise without the model's actual tokenizer
- ❌ Adds complexity to the agent loop
- ❌ Proactive compaction may trigger unnecessarily if estimation is inaccurate

**When to use:** As a wrapper around any of the above strategies. Best practice is to use Strategy 1 or 3 as the compaction method, triggered by Strategy 4's pre-flight detection.

---

### Comparison Table

| Strategy | Compression | Cost | Fidelity | Complexity | Preserves Early Context |
|----------|------------|------|----------|------------|------------------------|
| 1. Sliding Window | High | Free | Low (drops) | Low | ❌ |
| 2. Summarization | Medium | High (LLM call) | Medium | High | ✅ (condensed) |
| 3. Truncation | Very High | Free | Medium | Low | ✅ (gist) |
| 4. Pre-Flight | — | Free | — | Medium | — (trigger only) |

### Best Practices

1. **Start with Strategy 1 (Sliding Window)** — it's simple, free, and solves the most common problem. AgentPrimer implements this out of the box.

2. **Add Strategy 4 (Pre-Flight) as a trigger** — combine it with any strategy so compaction happens automatically instead of waiting for an API error.

3. **For high-stakes conversations** (legal, medical, customer support), consider Strategy 2 (Summarization) so critical context is never fully lost.

4. **For tool-heavy agents** (web research, data analysis), use Strategy 3 (Truncation) — tool outputs are large but rarely needed again after the answer.

5. **Always inject a system notice** when compaction occurs, so the model knows what was dropped. Without this, the model may hallucinate or reference information that no longer exists in context.

6. **Monitor the context gauge** — the red visual cue (>80%) is your warning. If you see it frequently, lower your compaction threshold.

### In AgentPrimer

AgentPrimer implements **Strategy 1 (Sliding Window)** with a configurable exchange count via Settings → Chat Behavior → Context Window Compaction. The implementation is in [lib/agent/messages.ts](lib/agent/messages.ts) with the `compactConversation()` function called automatically before each agent loop execution.

To experiment with the other strategies, you can extend the `compactConversation()` function or add a pre-flight check in the `createStreamingAgent()` function. The architecture is designed to make these additions straightforward — the message array passes through a single pipeline before reaching the LLM.
