export interface LessonQuestion {
  id: string;
  prompt: string;
  options: string[];
  answer: number;
  explanation: string;
}

export interface LessonExperiment {
  title: string;
  instructions: string;
  href: string;
  cta: string;
}

export interface Lesson {
  slug: string;
  title: string;
  module: string;
  level: 'Beginner' | 'Intermediate' | 'Advanced';
  estimatedMinutes: number;
  summary: string;
  objectives: string[];
  content: string;
  experiments: LessonExperiment[];
  questions: LessonQuestion[];
}

export const LESSONS: Lesson[] = [
  {
    slug: '00-build-from-scratch',
    title: '00 — What Is Agentic AI?',
    module: '00 Foundations',
    level: 'Beginner',
    estimatedMinutes: 24,
    summary:
      'Build the correct mental model: an agent is a goal-directed software loop that lets a model choose actions, observe results, and continue until a stopping condition is reached.',
    objectives: [
      'Define agentic AI precisely',
      'Separate chatbots, workflows, copilots, and agents',
      'Explain the minimum agent loop',
    ],
    content: `# What Is Agentic AI?

![Colorful diagram for 00 build from scratch](/learn/00-build-from-scratch.svg)

Agentic AI is not simply "a chatbot with tools." It is a software system that gives a language model an operating loop: the model receives a goal and context, chooses an action, the program executes that action, the result is fed back as an observation, and the loop continues until the task is complete or a safety limit stops it.

A useful definition:

> **An AI agent is a goal-directed program that repeatedly uses a model to decide what to do next, can take actions through tools or other systems, observes the results, and manages enough state to make progress across steps.**

## The core loop

![Small agent loop illustration](/learn/00-small-agent-loop.svg)

![Agentic AI core loop](/learn/00-agent-loop-program.svg)

The loop matters because each tool result can change the next decision. A chatbot answers from context once. An agent can discover missing information, inspect files, call APIs, write artifacts, ask for approval, delegate work, and revise its plan.

## Chatbot vs workflow vs agent

| System | Who chooses the next step? | Can use tools? | Can adapt mid-task? | Example |
|--------|-----------------------------|----------------|---------------------|---------|
| Chatbot | The user, every turn | Maybe, but usually hidden | Limited | "Explain this error" |
| Fixed workflow | Developer-authored code | Yes | Only along predefined branches | "Summarize then email" pipeline |
| Copilot | Human chooses when to apply | Yes, often with suggestions | Human-led | IDE code assistant |
| Agent | Model chooses within program guardrails | Yes | Yes, after observations | "Inspect this repo and fix failing tests" |

Agentic does **not** mean autonomous without limits. A good agent has boundaries: allowed tools, approval gates, step limits, logging, tests, and rollback paths.

## Agency is a spectrum

![Agency spectrum](/learn/00-agency-spectrum.svg)

AgentPrimer sits in the middle-to-high range: it has a handwritten agent loop, tool use, memory, RAG, approvals, streaming, structured output, and async sub-agents, but it keeps the operator in control.

## The minimum implementation

A tiny agent has five pieces:

1. **Goal** — the user's request.
2. **State** — messages, memory, retrieved context, current task file.
3. **Policy** — system prompt, tool descriptions, permissions, model settings.
4. **Actions** — tools the program can actually execute.
5. **Control loop** — repeat model call → action → observation until done.

AgentPrimer adds production features around those same pieces: authentication, SQLite persistence, trace records, stream events, approval gates, function-tool subprocesses, MCP servers, per-agent prompts, RAG, and deployment settings.

## Try it yourself: identify agency

Open Chat and ask: "What can you do in this app?" Then ask a task requiring observation, such as "Read the project README and summarize the architecture." Watch for this difference:

- If the model answers immediately from general knowledge, it behaved like a chatbot.
- If it calls a file tool, observes the result, and then answers, it behaved like an agent.

## Common misconception

An agent is not "a model that thinks harder." The model is only one component. The **program** supplies the loop, tools, memory, persistence, safety, and UI that make agentic behavior possible.`,
    experiments: [
      {
        title: 'Classify three prompts',
        instructions:
          'Open Chat and try three prompts: one pure explanation, one file-inspection task, and one multi-step task. Label each as chatbot-like, tool-assisted, or agentic based on whether the model acts and observes.',
        href: '/chat',
        cta: 'Open Chat',
      },
      {
        title: 'Find the loop in the app',
        instructions:
          'Open Tool Playground and Skills & MCP. Identify which capabilities could become actions in an agent loop.',
        href: '/tools',
        cta: 'Open Tools',
      },
    ],
    questions: [
      {
        id: '00-definition',
        prompt: 'Which definition best describes agentic AI?',
        options: [
          'A goal-directed program that lets a model choose actions, observe results, and continue within guardrails',
          'A larger chatbot with no tools',
          'A static prompt template',
          'Any UI that streams tokens',
        ],
        answer: 0,
        explanation:
          'Agency comes from the loop that turns model decisions into actions and feeds observations back into context.',
      },
      {
        id: '00-spectrum',
        prompt: 'Why is agency a spectrum rather than a yes/no property?',
        options: [
          'Systems can have different degrees of autonomy, tools, memory, planning, and safety limits',
          'All models are equally autonomous',
          'Only robots can be agents',
          'Streaming automatically makes a system autonomous',
        ],
        answer: 0,
        explanation:
          'A single completion, a tool-using chat, and a long-running autonomous worker all have different levels of agency.',
      },
      {
        id: '00-observation',
        prompt: 'Why does a tool result go back into the model context?',
        options: [
          'So the model can observe what happened and decide the next step',
          'So the UI can ignore it',
          'So tools run twice',
          'So the database can be deleted',
        ],
        answer: 0,
        explanation:
          'The observation changes the model’s next decision and lets the agent make progress.',
      },
      {
        id: '00-boundaries',
        prompt: 'What keeps an agent from becoming unsafe automation?',
        options: [
          'Tool allowlists, approval gates, step limits, logs, tests, and clear operating boundaries',
          'Removing all logs',
          'Letting the model run every command silently',
          'Only using a colorful UI',
        ],
        answer: 0,
        explanation: 'Agentic systems need explicit guardrails because they can take real actions.',
      },
    ],
  },
  {
    slug: '01-architecture',
    title: '01 — Agent System Architecture',
    module: '01 Architecture',
    level: 'Beginner',
    estimatedMinutes: 26,
    summary:
      'Trace one request through the browser, API route, agent runtime, tool layer, persistence, and observability surfaces.',
    objectives: [
      'Map the major runtime layers',
      'Locate the real agent implementation files',
      'Explain how state and tools flow through the system',
    ],
    content: `# Agent System Architecture

![Colorful diagram for 01 architecture](/learn/01-architecture.svg)

An agent application is a distributed system in miniature. The browser displays progress, the API route starts a streamed turn, the agent runtime owns the loop, tools perform actions, and SQLite/file storage preserves state.

## AgentPrimer request path

![AgentPrimer architecture map](/learn/01-architecture-map.svg)

![AgentPrimer request path](/learn/01-request-path.svg)

## Current file map

| Concern | Current source of truth |
|---------|-------------------------|
| Chat API entry | app/api/chat/route.ts |
| Detached run manager | lib/agent/run-manager.ts |
| Streaming turn setup | lib/agent/streaming-agent.ts |
| ReAct loop | lib/agent/loop.ts |
| Built-in tools | lib/agent/builtin-tools.ts |
| Message conversion | lib/agent/messages.ts |
| System prompt composition | lib/agent/prompt.ts |
| Structured-output finalize call | lib/agent/finalize.ts |
| Model length overrides | lib/agent/model-overrides.ts |
| SQLite schema/helpers | lib/db.ts |
| Auth middleware | proxy.ts |

The old single-file mental model is no longer accurate: **lib/agent.ts is a barrel export**. The teaching value is now in the smaller files under lib/agent/.

## Four planes of an agent app

![Four planes of an agent app](/learn/01-four-planes.svg)

Good architecture keeps these planes distinct. For example, the browser should not own provider secrets, the model should not directly mutate the database, and MCP credentials should be scoped to the server that needs them.

## Try it yourself: follow one turn

1. Open Chat.
2. Send a request that requires reading a file.
3. Watch the stream appear.
4. Open the trace drawer and identify: model input, tool call, tool result, final output.
5. Locate the matching code path in lib/agent/loop.ts and lib/agent/builtin-tools.ts.

The goal is not to memorize file names. The goal is to understand where responsibility changes hands.`,
    experiments: [
      {
        title: 'Trace one request',
        instructions:
          'Send a file-inspection prompt, then map every visible UI event to one layer: browser, API, runtime, model, tool, or database.',
        href: '/chat',
        cta: 'Open Chat',
      },
      {
        title: 'Browse the implementation',
        instructions:
          'Open Agent Files and inspect lib/agent/streaming-agent.ts, lib/agent/loop.ts, and lib/agent/builtin-tools.ts. Identify the handoff points.',
        href: '/editor?folder=lib/agent',
        cta: 'Open Agent Files',
      },
    ],
    questions: [
      {
        id: '01-runtime-files',
        prompt: 'Where does the real agent loop live now?',
        options: [
          'lib/agent/loop.ts, called by lib/agent/streaming-agent.ts',
          'Only lib/agent.ts',
          'Only proxy.ts',
          'Only package.json',
        ],
        answer: 0,
        explanation: 'lib/agent.ts is a barrel; the loop itself is in lib/agent/loop.ts.',
      },
      {
        id: '01-planes',
        prompt: 'Why separate control, data, action, and experience planes?',
        options: [
          'To keep policy, state, side effects, and UI responsibilities clear',
          'To make every feature slower',
          'To hide tool calls from traces',
          'To store secrets in the browser',
        ],
        answer: 0,
        explanation: 'Clear boundaries make the system safer to modify and easier to debug.',
      },
      {
        id: '01-state',
        prompt: 'Which layer persists sessions, messages, RAG metadata, tasks, and settings?',
        options: [
          'SQLite plus files under data/',
          'The browser DOM only',
          'A CSS file',
          'The model provider',
        ],
        answer: 0,
        explanation:
          'AgentPrimer stores durable app state in SQLite and human-editable files under data/.',
      },
      {
        id: '01-proxy',
        prompt: 'What does proxy.ts do in this Next.js version?',
        options: [
          'Acts as the auth middleware boundary',
          'Executes tools',
          'Embeds documents',
          'Renders Markdown',
        ],
        answer: 0,
        explanation: 'proxy.ts validates the JWT cookie before protected pages/routes run.',
      },
    ],
  },
  {
    slug: '02-agent-loop',
    title: '02 — Reason, Act, Observe',
    module: '02 Control Loop',
    level: 'Beginner',
    estimatedMinutes: 28,
    summary:
      'Understand the ReAct loop as the control system that turns language-model outputs into bounded action.',
    objectives: [
      'Explain the Reason → Act → Observe cycle',
      'Recognize loop failure modes',
      'Use traces to debug agent behavior',
    ],
    content: `# Reason, Act, Observe

![Colorful diagram for 02 agent loop](/learn/02-agent-loop.svg)

The agent loop is the heart of agentic AI. ReAct stands for **Reason + Act**: the model reasons about the goal, calls a tool when it needs an action or observation, then reads the result and reasons again.

## Loop overview

![Colorful ReAct loop overview](/learn/react-loop-overview.svg)

![ReAct state machine](/learn/02-loop-state-machine.svg)

## What the model controls vs what code controls

| Controlled by model | Controlled by program |
|---------------------|-----------------------|
| Which tool to request | Which tools exist |
| Tool arguments | Schema validation |
| Whether to continue or answer | Max step limit |
| Natural-language reasoning | Approval gates |
| Plan revisions | Persistence and trace format |

This distinction matters. The model proposes. The program disposes.

## Failure modes

Agents fail in recognizable ways:

| Failure | Symptom | Guardrail |
|---------|---------|-----------|
| Looping | Repeats same tool call | max_agent_steps, trace review |
| Tool misuse | Wrong args or wrong tool | better descriptions, schemas, tests |
| Missing observation | Guesses after failed tool | force tool result back into context |
| Overreach | Runs destructive action | approval gate, tool allowlists |
| Context bloat | Prompt becomes huge | message compaction, RAG, summarization |
| False success | Says done but artifact absent | verification tool call, tests, preview |

## Reading a trace

![AgentPrimer turn sequence](/learn/react-loop-sequence.svg)

A good trace answers:

1. What goal and context did the model see?
2. Which tools were available?
3. Which tool did it choose?
4. What arguments were sent?
5. What did the tool actually return?
6. Why did the loop stop?

## Try it yourself: force an observation

Ask the agent: "Inspect package.json and tell me the test command." A non-agent answer might hallucinate. An agentic answer should read the file first. If it guesses, ask: "Show me the tool result you used."`,
    experiments: [
      {
        title: 'Trigger and inspect a tool call',
        instructions:
          'Ask the agent to inspect package.json. Open the trace drawer and identify the model call, tool call, tool result, and final answer.',
        href: '/chat',
        cta: 'Open Chat',
      },
      {
        title: 'Tune loop limits',
        instructions:
          'Open Settings and find the max agent steps setting. Decide what failure mode a very low limit and a very high limit would create.',
        href: '/settings',
        cta: 'Open Settings',
      },
    ],
    questions: [
      {
        id: '02-react',
        prompt: 'What does ReAct mean in agent design?',
        options: [
          'Reason and Act, with observations fed back into context',
          'Render and CSS',
          'Retry all completions automatically',
          'Remove every tool',
        ],
        answer: 0,
        explanation:
          'ReAct is the repeated pattern of reasoning, acting, observing, and continuing.',
      },
      {
        id: '02-program-control',
        prompt: 'Which part should be controlled by program code rather than the model?',
        options: [
          'Approval gates and max step limits',
          'The exact prose of every answer',
          'The user goal',
          'The browser font',
        ],
        answer: 0,
        explanation: 'Safety boundaries and control limits should be enforced by code.',
      },
      {
        id: '02-trace',
        prompt: 'What is the main purpose of an agent trace?',
        options: [
          'Make the hidden loop visible and debuggable',
          'Hide tool results',
          'Replace authentication',
          'Guarantee the model is always correct',
        ],
        answer: 0,
        explanation:
          'Traces expose model inputs, tool calls, tool outputs, usage, timing, and stop reasons.',
      },
      {
        id: '02-failure',
        prompt: 'What is a common sign of an unbounded agent loop?',
        options: [
          'Repeating the same or similar tool call without progress',
          'Returning a final answer',
          'Saving a trace',
          'Asking for approval',
        ],
        answer: 0,
        explanation: 'Repetition without new information is a classic loop failure.',
      },
    ],
  },
  {
    slug: '03-tools-and-skills',
    title: '03 — Tools, Skills, Function Tools, and MCP',
    module: '03 Capabilities',
    level: 'Beginner',
    estimatedMinutes: 30,
    summary:
      'Learn how agents gain capabilities, why schemas matter, and how to choose between built-ins, function tools, skills, and MCP servers.',
    objectives: [
      'Separate actions from instructions',
      'Design tool schemas the model can use',
      'Choose the right capability type for a task',
    ],
    content: `# Tools, Skills, Function Tools, and MCP

![Colorful diagram for 03 tools and skills](/learn/03-tools-and-skills.svg)

A language model cannot directly read your filesystem, call a database, send a file, or search the web. The application exposes those actions as tools. Good agent design is largely good tool design.

## Capability map

![Agent capability map](/learn/03-capability-map.svg)

![Capability map](/learn/03-capability-flow.svg)

## Action vs instruction

| Capability | What it is | Best for | Risk profile |
|------------|------------|----------|--------------|
| Built-in tool | Code owned by AgentPrimer | Files, memory, RAG, previews, sub-agents | Known and testable |
| Function tool | Installed callable package | Custom deterministic logic | Isolated subprocess, still host access |
| MCP server | Protocol server exposing tools/resources | External systems, search, SaaS APIs | Depends on server trust and env scope |
| SKILL.md | Markdown procedure the model reads | Workflows, domain guidance, checklists | Prompt-injection / stale instructions |

Skills are not actions. They change how the model behaves. Tools are actions. They change the world or produce observations.

## Tool schema design

A tool schema is a contract between model and program. It should answer:

- When should the model use this tool?
- What arguments are required?
- What values are valid?
- What errors can happen?
- What result shape comes back?

Bad schema: "run thing" with a string argument.

Good schema: explicit names, short descriptions, enum constraints, defaults, and examples in the description when helpful.

## Capability selection checklist

![Capability selection checklist](/learn/03-capability-decision.svg)

## MCP credentials

For stdio MCP servers, credentials belong on the individual server in **Skills & MCP → Edit → Environment variables**. This scopes the key to one subprocess. Do not rely on global environment variables unless you intentionally configure fleet-wide forwarding.

## Try it yourself: improve a tool description

Open Tool Playground and choose a file tool. Imagine the model has never seen your UI. Would the description tell it when to use the tool, what path format to pass, and what result to expect? Write one sentence that would reduce misuse.`,
    experiments: [
      {
        title: 'Compare capability types',
        instructions:
          'Open Skills & MCP. Pick one skill, one built-in tool, one function tool, and one MCP server. For each, decide whether it is instruction or action.',
        href: '/skills',
        cta: 'Open Skills & MCP',
      },
      {
        title: 'Inspect a schema',
        instructions:
          'Open Tool Playground and inspect the parameters for read_file, write_file, and run_shell. Identify which fields are required and which are dangerous.',
        href: '/tools',
        cta: 'Open Tool Playground',
      },
    ],
    questions: [
      {
        id: '03-action-instruction',
        prompt: 'What is the key difference between a tool and a SKILL.md skill?',
        options: [
          'A tool executes an action; a skill gives instructions the model should follow',
          'A skill always runs shell commands',
          'A tool is only a CSS component',
          'There is no difference',
        ],
        answer: 0,
        explanation:
          'Tools return observations from executed code. Skills modify the model’s behavior through instructions.',
      },
      {
        id: '03-schema',
        prompt: 'Why do tool schemas matter?',
        options: [
          'They help the model produce valid arguments and help the program validate them',
          'They only change colors',
          'They replace logs',
          'They hide errors',
        ],
        answer: 0,
        explanation:
          'The model reads tool names, descriptions, and schemas when deciding how to call tools.',
      },
      {
        id: '03-mcp-env',
        prompt: 'Where should a per-server API key for a stdio MCP server be configured?',
        options: [
          'On that MCP server’s Environment variables field in Skills & MCP',
          'In every browser tab',
          'Inside a random chat message',
          'Only in CSS',
        ],
        answer: 0,
        explanation:
          'Per-server env scopes the key to one MCP subprocess instead of leaking it to every server.',
      },
      {
        id: '03-choice',
        prompt: 'When is a SKILL.md file the right capability type?',
        options: [
          'When the agent needs procedural guidance but no new executable action',
          'When the app needs a database migration',
          'When the model must run a binary',
          'When the UI needs authentication',
        ],
        answer: 0,
        explanation: 'Skills are best for reusable instructions, checklists, and workflows.',
      },
    ],
  },
  {
    slug: '04-streaming',
    title: '04 — Streaming and Agent UX',
    module: '04 Streaming',
    level: 'Intermediate',
    estimatedMinutes: 22,
    summary:
      'Understand why agent apps stream more than text: they stream reasoning, tool-call state, results, usage, and structured UI events. Learn how a detached run manager keeps work alive across browser disconnects.',
    objectives: [
      'Explain streaming as user trust infrastructure',
      'Recognize text/tool/reasoning/data stream events',
      'Design UI that shows progress without lying',
      'Explain how a detached run survives a browser close',
    ],
    content: `# Streaming and Agent UX

![Colorful diagram for 04 streaming](/learn/04-streaming.svg)

Agent work can be slow because it may include multiple model calls, tool calls, file reads, subprocesses, RAG searches, and finalization calls. A blank screen feels broken. Streaming turns hidden progress into visible progress.

## Stream flow

![Streaming event flow](/learn/04-stream-flow.svg)

![Streaming sequence](/learn/04-stream-sequence.svg)

## What should be visible?

| Agent event | Good UI treatment | Why |
|-------------|-------------------|-----|
| Waiting for model | subtle loading state | User knows work started |
| Reasoning token | collapsible thinking panel | Useful for debugging without overwhelming |
| Tool call start | live tool card | Shows action selection |
| Tool args streaming | partial args display | Makes long args feel alive |
| Approval needed | explicit pause with buttons | User remains in control |
| Tool result | summarized observation | Explains next answer |
| Final answer | normal message content | The artifact the user asked for |

## Trust and latency

Streaming is not just performance polish. It is trust infrastructure. If an agent is going to run commands, inspect files, or call external services, the user should see what is happening as it happens.

## Detached runs: work that survives a browser close

In older chat apps, closing the browser tab mid-stream killed the response — the loop was tied to the HTTP connection. AgentPrimer decouples them: the agent loop runs as a **detached background promise** inside \`lib/agent/run-manager.ts\`. The HTTP response is just a thin "tail" that replays a buffer and forwards new tokens live.

- Close the browser → the tail tears down, but the loop keeps running and keeps checkpointing to SQLite after every step.
- Reopen mid-run → the UI polls \`/api/chat/active\`, sees the run is live, and re-attaches a tail.
- Run finished while away → the completed message is loaded from the database on the next poll.
- Stop button → \`POST /api/chat/stop\` fires the run's AbortController, the only thing that cancels a run.
- One active run per session → a second send while a run is live is rejected with 409 \`RUN_IN_PROGRESS\`.

This is the same pattern used for background sub-agents: a floating promise that outlives the request that started it.

## Try it yourself: read the stream

Open DevTools → Network, send a prompt that causes a tool call, and watch the response body. You will see different event kinds: text, tool start, tool delta, tool result, data, finish step, and finish message.`,
    experiments: [
      {
        title: 'Compare a simple answer and a tool-heavy answer',
        instructions:
          'Send one pure explanation prompt and one prompt that requires reading files. Compare the visible stream behavior in the chat UI.',
        href: '/chat',
        cta: 'Open Chat',
      },
      {
        title: 'Inspect stream chunks',
        instructions:
          'Use browser DevTools to inspect /api/chat while a response streams. Identify at least two non-text event types.',
        href: '/chat',
        cta: 'Open Chat',
      },
      {
        title: 'Test the detached run',
        instructions:
          'Start a tool-heavy prompt, then close the browser tab while it is still streaming. Reopen the same session — the run should have continued in the background and the result should appear (or a Stop button should still be active if it is still running).',
        href: '/chat',
        cta: 'Open Chat',
      },
    ],
    questions: [
      {
        id: '04-purpose',
        prompt: 'Why is streaming especially important for agents?',
        options: [
          'Agent turns can include multiple hidden steps, so streaming makes progress and actions visible',
          'It removes the need for tools',
          'It guarantees correctness',
          'It replaces the database',
        ],
        answer: 0,
        explanation:
          'Streaming exposes progress during multi-step work and reduces user uncertainty.',
      },
      {
        id: '04-events',
        prompt: 'Which item can be streamed besides normal text?',
        options: [
          'Tool-call lifecycle events',
          'Only CSS variables',
          'Only database table names',
          'Only package versions',
        ],
        answer: 0,
        explanation:
          'AgentPrimer streams tool starts, deltas, results, data events, and finish events.',
      },
      {
        id: '04-approval',
        prompt: 'How should the UI treat a dangerous tool call?',
        options: [
          'Pause and show explicit approve/deny controls',
          'Run it invisibly',
          'Hide the command',
          'Pretend it completed',
        ],
        answer: 0,
        explanation: 'Dangerous actions need human-in-the-loop visibility and control.',
      },
      {
        id: '04-detached',
        prompt: 'What happens if you close the browser while an agent run is still streaming?',
        options: [
          'The loop keeps running in the background and checkpoints to the database; a reopen re-attaches or loads the result',
          'The run is immediately cancelled and all progress is lost',
          'The server restarts',
          'The model is charged again for the full response',
        ],
        answer: 0,
        explanation:
          'The loop runs as a detached floating promise. Only the Stop button (POST /api/chat/stop) cancels it.',
      },
    ],
  },
  {
    slug: '05-memory-and-agents',
    title: '05 — Context, Memory, and Agent Identity',
    module: '05 Memory',
    level: 'Beginner',
    estimatedMinutes: 28,
    summary:
      'Learn what belongs in system prompts, per-agent prompts, durable memory, pinned prompts, task files, and retrieved context.',
    objectives: [
      'Separate context from memory',
      'Design named agents with clear roles and tool policies',
      'Understand async task state and notifications',
    ],
    content: `# Context, Memory, and Agent Identity

![Colorful diagram for 05 memory and agents](/learn/05-memory-and-agents.svg)

Agentic AI depends on context. The model only knows what the application sends into the current request. Memory is one way to decide what context should appear again later.

## Memory layer stack

![Memory layer stack](/learn/05-memory-layers.svg)

![Context stack](/learn/05-context-stack.svg)

## Context vs memory

| Term | Meaning | Example |
|------|---------|---------|
| Context | Everything sent to the model right now | current messages, system prompt, selected tool schemas |
| Memory | Durable information intended for future turns | "User prefers concise answers" |
| RAG | Retrieved source passages from a large corpus | chunk from a PDF or doc |
| Task state | Durable progress for background work | task markdown file and DB row |

Memory is not a dumping ground. Bad memory bloats every prompt and can make the agent overfit stale facts. Good memory is durable, compact, and behaviorally useful.

## Named agents

A named agent is configuration:

| Field | Design question |
|-------|-----------------|
| System Prompt | What role should this agent play? |
| Tools | What actions should this agent be allowed to take? |
| Model | Does this role need a specific model? |
| Output Schema | Should the final answer be structured JSON? |
| Memory | What durable facts improve future performance? |

## Async sub-agents

Async sub-agents are useful when the parent should continue or when work is naturally parallel. They need task files because there is no live browser chat session attached to them.

![Async sub-agent lifecycle](/learn/05-async-subagent-sequence.svg)

## Try it yourself: write a memory rule

Create or edit an agent memory entry that is small and durable, such as "When explaining architecture, include a diagram-first summary." Then preview the composed system prompt and confirm the memory is injected.`,
    experiments: [
      {
        title: 'Inspect the composed prompt',
        instructions:
          'Open Chat, select an agent, and view the system prompt modal. Identify global prompt, agent prompt, memory, tools, and notifications.',
        href: '/chat',
        cta: 'Open Chat',
      },
      {
        title: 'Edit a named agent',
        instructions:
          'Open Prompts & Memory. Create a narrowly-scoped agent with a small tool allowlist and a short memory entry.',
        href: '/agents',
        cta: 'Open Prompts & Memory',
      },
    ],
    questions: [
      {
        id: '05-context-memory',
        prompt: 'What is the difference between context and memory?',
        options: [
          'Context is sent now; memory is durable information that may be injected later',
          'They are identical',
          'Memory is only CSS',
          'Context is never sent to models',
        ],
        answer: 0,
        explanation: 'Memory is stored state. Context is what the current model call receives.',
      },
      {
        id: '05-good-memory',
        prompt: 'Which memory entry is most useful?',
        options: [
          'A compact durable preference that improves future behavior',
          'A full copy of every conversation',
          'A random stack trace with no meaning',
          'The entire node_modules folder',
        ],
        answer: 0,
        explanation: 'Good memory is compact, durable, and actionable.',
      },
      {
        id: '05-agent-role',
        prompt: 'What does an agent.md file configure?',
        options: [
          'Role prompt, tool policy, model choice, and optional output schema',
          'Only static images',
          'Only browser cookies',
          'Only database indexes',
        ],
        answer: 0,
        explanation: 'agent.md is the human-editable identity and policy file for a named agent.',
      },
      {
        id: '05-async-state',
        prompt: 'Why do async sub-agents use task files?',
        options: [
          'They need durable progress state without a live browser session',
          'They cannot write text',
          'They replace all tools',
          'They only exist for styling',
        ],
        answer: 0,
        explanation:
          'Task files give background agents a durable place to log progress and completion.',
      },
    ],
  },
  {
    slug: '06-approval-gate',
    title: '06 — Human-in-the-Loop Safety',
    module: '06 Safety',
    level: 'Beginner',
    estimatedMinutes: 24,
    summary:
      'Learn how approvals, deny paths, permanent permissions, and sub-agent constraints keep powerful tools under operator control.',
    objectives: [
      'Identify actions that need approval',
      'Choose once, session, or permanent approval scopes',
      'Explain the difference between interactive agents and async sub-agents',
    ],
    content: `# Human-in-the-Loop Safety

![Colorful diagram for 06 approval gate](/learn/06-approval-gate.svg)

Agentic systems can take real actions. Safety is not a prompt alone; it is enforced in code. AgentPrimer uses approval gates for sensitive built-ins such as deleting files, reading dotfiles, and running shell commands.

## Approval flow

![Approval flow](/learn/06-approval-flow.svg)

![Approval decision path](/learn/06-approval-decision.svg)

## Approval scopes

| Scope | Stored where | Best for |
|-------|--------------|----------|
| Once | in-memory session map keyed by operation + path/command | A single risky command |
| Session | in-memory session map keyed by operation | Repeated similar operations during one chat |
| Permanent | SQLite permanent_approvals table | Operator-trusted capability across sessions and sub-agents |

Async sub-agents cannot show browser approval UI because they run in the background. They can only use shell when the operator has granted the operation permanently.

## Safety design principle

A model should never be the only thing deciding whether it may perform a dangerous action. The program should enforce the boundary even if the model is prompted to ignore it.

## Denial is a valid observation

When a user denies an action, the model should see that denial as context and choose a safer path. Denial is not an exception; it is a human preference injected into the loop.

## Try it yourself: approve and deny

Ask the agent to run a harmless shell command after enabling run_shell. Approve once. Then ask for another command and deny it. Observe how the agent responds to each tool result.`,
    experiments: [
      {
        title: 'Trigger a harmless approval',
        instructions:
          'Enable run_shell, then ask the agent to run `pwd`. Approve once and observe the command result in the chat.',
        href: '/chat',
        cta: 'Open Chat',
      },
      {
        title: 'Review permanent approvals',
        instructions:
          'Open Approvals and inspect which operations are permanently allowed. Think about which ones should remain temporary instead.',
        href: '/approvals',
        cta: 'Open Approvals',
      },
    ],
    questions: [
      {
        id: '06-code-boundary',
        prompt: 'Why should approval gates be enforced in code?',
        options: [
          'Because prompts alone cannot guarantee a model will not request risky actions',
          'Because users dislike buttons',
          'Because tools cannot return errors',
          'Because CSS needs approval',
        ],
        answer: 0,
        explanation: 'The program must enforce safety boundaries regardless of model text.',
      },
      {
        id: '06-async',
        prompt: 'Why can async sub-agents not ask for one-time browser approval?',
        options: [
          'They run without a live interactive browser session',
          'They cannot use models',
          'They are CSS only',
          'They never use tools',
        ],
        answer: 0,
        explanation: 'Background tasks cannot pause and render an approval UI to the user.',
      },
      {
        id: '06-permanent',
        prompt: 'Which approval scope can apply across sessions and async sub-agents?',
        options: ['Permanent', 'Once only', 'A tab hover state', 'A markdown heading'],
        answer: 0,
        explanation: 'Permanent approvals are stored in SQLite and checked globally by operation.',
      },
      {
        id: '06-denial',
        prompt: 'How should the loop treat a denied action?',
        options: [
          'As an observation that constrains the next decision',
          'As permission to retry secretly',
          'As a reason to delete logs',
          'As a database backup',
        ],
        answer: 0,
        explanation: 'The model should use denial as context and choose a safer alternative.',
      },
    ],
  },
  {
    slug: '07-frontend',
    title: '07 — Designing the Agent User Experience',
    module: '07 Frontend',
    level: 'Intermediate',
    estimatedMinutes: 24,
    summary:
      'Learn how a frontend for agents differs from a normal chat UI: it must show state, tool activity, approvals, previews, traces, and recoverable history.',
    objectives: [
      'Identify UI states unique to agents',
      'Connect stream events to message rendering',
      'Design affordances that improve trust',
    ],
    content: `# Designing the Agent User Experience

![Colorful diagram for 07 frontend](/learn/07-frontend.svg)

A normal chat UI displays messages. An agent UI must display **work**: plans, tool calls, approvals, generated files, previews, traces, token usage, and partial progress.

## Frontend map

![Frontend component map](/learn/07-frontend-map.svg)

![Agent UI state map](/learn/07-agent-ui-map.svg)

## Agent UI requirements

| Requirement | Why it matters |
|-------------|----------------|
| Show live progress | Long tasks feel alive |
| Reveal tool calls | User sees what the agent is doing |
| Pause for approval | User controls risky operations |
| Preserve history | Reload should not lose tool context |
| Preview artifacts | Generated files should be inspectable immediately |
| Show traces | Developers can debug wrong behavior |

## Designing for recoverability

Agent turns can be interrupted: browser reload, network drop, model error, tool error, or approval denial. The frontend should be able to reconstruct messages from persisted parts and show incomplete states honestly.

## Try it yourself: UI state inventory

Open a chat with a tool call. Count how many UI states appear: streaming text, tool card, result, final message, maybe trace, maybe preview. That inventory is why agent frontends are more complex than chat bubbles.`,
    experiments: [
      {
        title: 'Inspect a tool card',
        instructions:
          'Run a prompt that calls a file tool. Look at the live tool card and identify tool name, args, status, and result.',
        href: '/chat',
        cta: 'Open Chat',
      },
      {
        title: 'Open an artifact preview',
        instructions:
          'Ask the agent to create a small HTML or Markdown file and open it in the preview panel. Observe how editing and preview relate.',
        href: '/chat',
        cta: 'Open Chat',
      },
    ],
    questions: [
      {
        id: '07-ui-agent',
        prompt: 'What makes an agent UI different from a simple chat UI?',
        options: [
          'It must show work state such as tool calls, approvals, previews, and traces',
          'It only needs bigger fonts',
          'It should hide all intermediate actions',
          'It cannot store history',
        ],
        answer: 0,
        explanation: 'Agent UI needs to make multi-step work visible and recoverable.',
      },
      {
        id: '07-recover',
        prompt: 'Why persist message parts and tool calls?',
        options: [
          'So reloads can reconstruct what happened',
          'So the model never uses tools',
          'So CSS compiles faster',
          'So authentication is unnecessary',
        ],
        answer: 0,
        explanation: 'Persisted parts let the UI render history accurately after reload.',
      },
      {
        id: '07-trust',
        prompt: 'Which UI element improves trust during risky operations?',
        options: [
          'An explicit approval card showing the requested action',
          'A hidden spinner',
          'A blank screen',
          'A disabled trace drawer',
        ],
        answer: 0,
        explanation: 'Approval cards let users inspect and control risky actions.',
      },
    ],
  },
  {
    slug: '08-database',
    title: '08 — State, Persistence, and Event History',
    module: '08 Persistence',
    level: 'Intermediate',
    estimatedMinutes: 26,
    summary:
      'Understand why agent apps need durable state: messages, traces, tasks, RAG, settings, approvals, token usage, and lesson progress.',
    objectives: [
      'Identify durable state categories',
      'Explain why task and message history matter',
      'Understand migration and backup risk',
    ],
    content: `# State, Persistence, and Event History

![Colorful diagram for 08 database](/learn/08-database.svg)

An agent is not just a request/response function. It accumulates state: conversation history, memory, task progress, tool traces, generated files, RAG indexes, approvals, and settings. Losing that state changes behavior.

## Database map

![Database map](/learn/08-database-map.svg)

![Agent state relationships](/learn/08-state-erd.svg)

## State categories

| Category | Examples | Why durable? |
|----------|----------|--------------|
| Conversation | sessions, messages, parts, traces | Reload and auditability |
| Configuration | provider endpoint, model, tool flags | Stable behavior |
| Knowledge | RAG sources, chunks, embeddings | Avoid re-ingestion |
| Safety | permanent approvals | Operator policy |
| Background work | agent_tasks, notifications, task files | Async continuity |
| Learning | lesson_progress | Curriculum state |

## Event history vs final answer

For agents, the path matters. A final answer without tool history cannot tell you whether the agent inspected the right file, used stale RAG, ignored an approval denial, or silently failed and guessed.

## Production risk

Database changes are deployment-sensitive. A migration that scans every historical message, rebuilds every embedding, or rewrites task files can be expensive. Good migrations are idempotent, bounded, and observable.

## Try it yourself: inspect persistence

Create a chat with one tool call. Reload the page. Confirm that text, tool cards, reasoning/parts, and trace information still render. Then open Statistics and notice that usage is persisted too.`,
    experiments: [
      {
        title: 'Reload a tool-heavy chat',
        instructions:
          'Create a chat with a tool call, reload the browser, and verify the tool card still appears. This demonstrates persisted message parts.',
        href: '/chat',
        cta: 'Open Chat',
      },
      {
        title: 'Inspect usage data',
        instructions:
          'Open Statistics after sending a few messages. Identify how token usage becomes both cost data and operational telemetry.',
        href: '/statistics',
        cta: 'Open Statistics',
      },
    ],
    questions: [
      {
        id: '08-state',
        prompt: 'Why does an agent app persist more than final text?',
        options: [
          'Tool calls, traces, reasoning parts, and task state are needed for reload, audit, and debugging',
          'Final text is never useful',
          'Only CSS needs persistence',
          'The browser cannot store strings',
        ],
        answer: 0,
        explanation: 'Agent behavior is multi-step, so the intermediate path is important.',
      },
      {
        id: '08-migrations',
        prompt: 'What makes a database migration risky in an agent app?',
        options: [
          'It may touch large historical message, trace, RAG, or task data',
          'It changes a button label',
          'It only edits comments',
          'It never runs in production',
        ],
        answer: 0,
        explanation: 'Historical agent data can be large and operationally important.',
      },
      {
        id: '08-task',
        prompt: 'Why persist async task rows and task files?',
        options: [
          'So background work can be monitored and recovered across turns',
          'So the model provider stores them',
          'So all chats are deleted',
          'So CSS can animate',
        ],
        answer: 0,
        explanation:
          'Async agents need durable progress state independent of the live browser session.',
      },
    ],
  },
  {
    slug: '09-ecosystem-comparison',
    title: '09 — Agent Ecosystem and Design Choices',
    module: '09 Ecosystem',
    level: 'Intermediate',
    estimatedMinutes: 22,
    summary:
      'Compare framework-first, protocol-first, product-first, and teaching-first approaches to building agents.',
    objectives: [
      'Understand common agent platform patterns',
      'Evaluate when to use frameworks vs handwritten loops',
      'Identify AgentPrimer’s teaching-first trade-offs',
    ],
    content: `# Agent Ecosystem and Design Choices

![Colorful diagram for 09 ecosystem comparison](/learn/09-ecosystem-comparison.svg)

Agent systems exist on several axes: how much they hide, how much they standardize, how much autonomy they grant, and how much they teach. AgentPrimer is intentionally transparent: the loop is handwritten so you can inspect it.

## Ecosystem map

![Ecosystem quadrant](/learn/09-ecosystem-quadrant.svg)

![Agent ecosystem quadrant](/learn/09-ecosystem-quadrant-custom.svg)

## Common approaches

| Approach | Strength | Weakness |
|----------|----------|----------|
| Framework-first | Fast to start, many abstractions | Loop can become hidden or hard to debug |
| Protocol-first | Interoperability through MCP/tool protocols | Still need product UX and safety model |
| Product-first | Polished workflows | Less flexible for learning internals |
| Teaching-first | Transparent architecture and traces | More code to understand |

## When to use a framework

Use a framework when your team needs speed, standard integrations, and can accept its control model. Handwrite the loop when you need to learn, deeply customize, debug provider quirks, or enforce unusual policy.

## The durable concepts

Tools, context, memory, traces, approvals, RAG, structured outputs, and evals appear across most serious agent systems even when APIs differ. Learn those concepts and you can move between frameworks.`,
    experiments: [
      {
        title: 'Compare abstraction levels',
        instructions:
          'Open Agent Files and inspect lib/agent/loop.ts. Then imagine what would be hidden if a framework owned that loop.',
        href: '/editor?folder=lib/agent',
        cta: 'Open Agent Files',
      },
      {
        title: 'Map capabilities to ecosystem patterns',
        instructions:
          'Open Skills & MCP. Decide which features are protocol-first (MCP), platform-owned (built-ins), or instruction-first (skills).',
        href: '/skills',
        cta: 'Open Skills & MCP',
      },
    ],
    questions: [
      {
        id: '09-handwritten',
        prompt:
          'Why would AgentPrimer handwrite its agent loop instead of hiding it behind a framework?',
        options: [
          'To make the mechanics teachable and debuggable',
          'To avoid using tools',
          'To remove streaming',
          'To hide traces',
        ],
        answer: 0,
        explanation:
          'A visible loop lets learners inspect every model call, tool result, and stop reason.',
      },
      {
        id: '09-framework',
        prompt: 'When is a framework-first approach useful?',
        options: [
          'When speed and standard integrations matter more than full loop control',
          'When you never need debugging',
          'When no tools exist',
          'When UI is impossible',
        ],
        answer: 0,
        explanation: 'Frameworks can accelerate common patterns but may hide control details.',
      },
      {
        id: '09-concepts',
        prompt: 'Which concept transfers across most serious agent platforms?',
        options: [
          'Tools, context, memory, traces, approvals, RAG, structured outputs, and evals',
          'Only one CSS framework',
          'Only one logo',
          'Only one database file name',
        ],
        answer: 0,
        explanation: 'The durable ideas matter more than one library’s API.',
      },
    ],
  },
  {
    slug: '10-structured-output',
    title: '10 — Structured Output and Reliable Interfaces',
    module: '10 Structured Output',
    level: 'Intermediate',
    estimatedMinutes: 24,
    summary:
      'Learn how agents produce machine-readable JSON through schemas, finalization calls, parsing, and UI rendering.',
    objectives: [
      'Explain why final answers sometimes need schemas',
      'Understand the finalize-call pattern',
      'Design robust structured-output workflows',
    ],
    content: `# Structured Output and Reliable Interfaces

![Colorful diagram for 10 structured output](/learn/10-structured-output.svg)

Humans like prose. Programs like structure. Structured output turns an agent’s final answer into a typed interface another system can rely on.

## Finalize flow

![Structured output flow](/learn/10-structured-output-flow.svg)

![Structured output finalize flow](/learn/10-finalize-sequence.svg)

## Why a second call?

The normal loop is optimized for reasoning and acting. The finalize call is optimized for one job: convert the completed transcript into a JSON object that matches the schema. This separation reduces the chance that tool-use instructions, chatty prose, or intermediate thoughts leak into the final machine-readable value.

## Schema design checklist

- Use explicit field names.
- Mark required fields carefully.
- Prefer arrays for repeated facts.
- Use enums when the answer set is closed.
- Decide what empty means: empty string, empty array, null, or omitted.
- Include enough description for the model to infer each field.

## Failure handling

A robust structured-output system does not pretend parsing always works. It should surface parse errors, raw model text, schema name, and the request payload so developers can debug bad outputs.`,
    experiments: [
      {
        title: 'Run the extractor agent',
        instructions:
          'Open Chat, choose an extractor/structured-output agent if available, and ask it to extract entities from a paragraph. Inspect the structured panel.',
        href: '/chat',
        cta: 'Open Chat',
      },
      {
        title: 'Inspect an output schema',
        instructions:
          'Open Agent Files and look under data/agents for a schema file or Output Schema File reference. Identify required fields.',
        href: '/editor?folder=agents',
        cta: 'Open Agent Files',
      },
    ],
    questions: [
      {
        id: '10-purpose',
        prompt: 'Why use structured output?',
        options: [
          'So downstream code can consume a predictable JSON object',
          'So the model never uses tools',
          'So CSS compiles faster',
          'So auth is disabled',
        ],
        answer: 0,
        explanation: 'Schemas make the final answer usable by programs, not just humans.',
      },
      {
        id: '10-finalize',
        prompt: 'What is the finalize call optimized for?',
        options: [
          'Converting the completed transcript into schema-shaped JSON',
          'Running shell commands',
          'Replacing all tests',
          'Rendering the sidebar',
        ],
        answer: 0,
        explanation: 'The finalize call is a focused non-streaming JSON generation step.',
      },
      {
        id: '10-parse-error',
        prompt: 'What should happen if JSON.parse fails?',
        options: [
          'Surface the parse error and raw response for debugging',
          'Pretend the output was valid',
          'Delete the schema',
          'Hide the response',
        ],
        answer: 0,
        explanation: 'Structured-output failures must be visible and debuggable.',
      },
    ],
  },
  {
    slug: '11-rag',
    title: '11 — Retrieval-Augmented Generation',
    module: '11 RAG',
    level: 'Intermediate',
    estimatedMinutes: 28,
    summary:
      'Learn how RAG gives agents access to large, source-grounded knowledge without stuffing everything into the prompt.',
    objectives: [
      'Explain chunking, embedding, retrieval, and fallback search',
      'Choose between memory and RAG',
      'Evaluate retrieved context quality',
    ],
    content: `# Retrieval-Augmented Generation

![Colorful diagram for 11 rag](/learn/11-rag.svg)

RAG is a way to give an agent relevant source material at the moment it needs it. Instead of placing every document in every prompt, the system indexes documents into chunks, retrieves the most relevant chunks for a query, and lets the model answer with that context.

## RAG pipeline

![RAG pipeline](/learn/11-rag-pipeline.svg)

![RAG retrieval pipeline](/learn/11-rag-flow.svg)

## Memory vs RAG

| Use memory when... | Use RAG when... |
|--------------------|-----------------|
| The fact is short and durable | The source is long |
| It should affect many future turns | Only some passages matter |
| It is a preference or operating rule | You need source-grounded answers |
| It is safe to inject every time | You need retrieval on demand |

## Retrieval is not truth

RAG can retrieve irrelevant chunks, miss synonyms, or surface stale documents. Good agents should cite sources, inspect enough context, and admit when the index does not contain the answer.

## Why fallback matters

Local embedding models may fail to load. Cloud embedding keys may be absent. AgentPrimer falls back to SQLite FTS5 keyword search so the knowledge base remains useful in degraded mode.

## Try it yourself: build a tiny knowledge base

Paste a short document into RAG. Ask a question whose answer is present and another whose answer is not. Compare whether the agent uses retrieved context or guesses.`,
    experiments: [
      {
        title: 'Index and search a document',
        instructions:
          'Open RAG, ingest a short document, then search for both an exact phrase and a related synonym. Compare vector vs keyword behavior.',
        href: '/knowledge',
        cta: 'Open RAG',
      },
      {
        title: 'Ask a grounded question',
        instructions:
          'After indexing a document, ask the agent a question that requires it. Check the trace for search_knowledge_base.',
        href: '/chat',
        cta: 'Open Chat',
      },
    ],
    questions: [
      {
        id: '11-purpose',
        prompt: 'What does RAG retrieve?',
        options: [
          'Relevant chunks from indexed documents',
          'Every file always',
          'Only browser cookies',
          'Only CSS classes',
        ],
        answer: 0,
        explanation: 'RAG returns a small set of relevant chunks for a query.',
      },
      {
        id: '11-memory',
        prompt: 'When is RAG better than memory.md?',
        options: [
          'When the source is large and only some passages are relevant',
          'For a one-line durable preference',
          'For the app logo',
          'For disabling all tools',
        ],
        answer: 0,
        explanation: 'RAG scales to larger corpora by retrieving on demand.',
      },
      {
        id: '11-fallback',
        prompt: 'What fallback keeps search working when embeddings are unavailable?',
        options: [
          'SQLite FTS5 keyword search',
          'Deleting all documents',
          'Hiding the RAG page',
          'Changing the font',
        ],
        answer: 0,
        explanation: 'FTS5 provides keyword search in degraded mode.',
      },
      {
        id: '11-quality',
        prompt: 'What should an agent do if retrieved context does not answer the question?',
        options: [
          'Say the indexed material does not contain enough information',
          'Invent an answer anyway',
          'Delete the index',
          'Run shell secretly',
        ],
        answer: 0,
        explanation: 'RAG should reduce hallucination, not provide cover for guessing.',
      },
    ],
  },
  {
    slug: '12-deployment-production',
    title: '12 — Production Agent Operations',
    module: '12 Production',
    level: 'Intermediate',
    estimatedMinutes: 30,
    summary:
      'Learn what changes when an agent leaves local development: persistence, secrets, backups, streaming proxies, monitoring, and incident response.',
    objectives: [
      'Plan production persistence and backups',
      'Protect secrets and MCP credentials',
      'Monitor behavior, cost, and failures',
    ],
    content: `# Production Agent Operations

![Colorful diagram for 12 deployment production](/learn/12-deployment-production.svg)

A production agent system is not just a model call behind a web page. It is an operational service that can spend money, mutate files, call external APIs, store user data, and run long tasks.

## Production shape

![Production deployment shape](/learn/12-production-shape.svg)

![Production agent operations](/learn/12-production-ops.svg)

## Production checklist

- Persist **data/** as a volume.
- Back up SQLite using WAL-safe backup procedures.
- Back up generated files, uploads, agent configs, and RAG sources.
- Disable proxy buffering for streamed chat responses.
- Scope MCP API keys per server.
- Require a strong AGENT_PRIMER_SECRET.
- Monitor model latency, tool errors, cost, token usage, and trace quality.
- Decide what data is allowed to leave your environment.

## Operational risks unique to agents

| Risk | Why agents amplify it | Mitigation |
|------|------------------------|------------|
| Cost runaway | Loops and sub-agents can call models many times | step limits, token stats, alerts |
| Secret exposure | Tools/MCP can access external services | per-server env, deny lists, logs hygiene |
| Data loss | Tools can write/delete files | approvals, backups, least-privilege tool policies |
| Silent bad behavior | Model can produce plausible wrong answers | traces, evals, RAG citations |
| Stuck background work | Async tasks may fail after parent turn ends | task rows, monitor, notifications |

## Try it yourself: production readiness review

Open Settings, Skills & MCP, Approvals, Statistics, and RAG. For each page, identify one production failure it helps prevent or diagnose.`,
    experiments: [
      {
        title: 'Review production settings',
        instructions:
          'Open Settings and identify model endpoint, default model, tracing, embedding provider, and Langfuse options.',
        href: '/settings',
        cta: 'Open Settings',
      },
      {
        title: 'Inspect operational signals',
        instructions:
          'Open Statistics after a few chats. Think about which chart would reveal cost runaway or unexpected usage.',
        href: '/statistics',
        cta: 'Open Statistics',
      },
    ],
    questions: [
      {
        id: '12-volume',
        prompt: 'Why must data/ be persisted in production?',
        options: [
          'It contains database, memory, settings, uploads, generated files, RAG data, and agent configs',
          'It only contains temporary CSS',
          'It is unused',
          'It stores only browser cache',
        ],
        answer: 0,
        explanation: 'Losing data/ can lose most durable app state.',
      },
      {
        id: '12-streaming',
        prompt: 'What can reverse-proxy buffering break?',
        options: [
          'Real-time streamed chat updates',
          'TypeScript type checking',
          'SQLite table names',
          'Markdown headings',
        ],
        answer: 0,
        explanation: 'Buffered proxies can delay chunks until the entire response finishes.',
      },
      {
        id: '12-secrets',
        prompt: 'Where should a credential for one stdio MCP server go?',
        options: [
          'That server’s per-server Environment variables field',
          'A public markdown lesson',
          'A chat message',
          'The browser console',
        ],
        answer: 0,
        explanation: 'Per-server env reduces cross-server secret exposure.',
      },
      {
        id: '12-monitor',
        prompt: 'What should production monitoring include?',
        options: [
          'Latency, errors, token usage, tool failures, traces, and costs',
          'Only page background color',
          'Only package names',
          'Only screenshots',
        ],
        answer: 0,
        explanation:
          'Agents need operational visibility because behavior spans model calls and tools.',
      },
    ],
  },
  {
    slug: '13-testing-agents',
    title: '13 — Testing, Evaluation, and Debugging',
    module: '13 Testing',
    level: 'Intermediate',
    estimatedMinutes: 30,
    summary:
      'Learn how to test deterministic code, mock model behavior, evaluate quality, and debug failures with traces.',
    objectives: [
      'Separate unit tests, integration tests, and evals',
      'Mock LLM behavior for deterministic loop tests',
      'Design quality rubrics for agent behavior',
    ],
    content: `# Testing, Evaluation, and Debugging

![Colorful diagram for 13 testing agents](/learn/13-testing-agents.svg)

Agents combine deterministic software with probabilistic model behavior. Test the deterministic parts like normal code. Evaluate model behavior with fixed prompts, rubrics, and traces.

## Agent testing pyramid

![Agent testing pyramid](/learn/13-testing-pyramid.svg)

![Agent testing pyramid](/learn/13-testing-pyramid-flow.svg)

## What should be deterministic?

- Zod-to-JSON-schema conversion.
- Agent config parsing.
- Approval-store decisions.
- Path sandboxing.
- Tool argument validation.
- RAG chunking and fallback behavior.
- DB migrations and helper queries.
- Stream-part formatting.

## What needs evals?

- Did the agent choose the right tool?
- Did it stop when done?
- Did it cite retrieved context?
- Did it avoid overclaiming?
- Did it ask for approval when required?
- Did the final artifact satisfy the user goal?

## Debug loop

![Agent debug loop](/learn/13-debug-loop.svg)

## Try it yourself: write an eval rubric

Run a realistic prompt and inspect the trace. Write three scoring criteria: one for tool choice, one for factual grounding, and one for final answer usefulness.`,
    experiments: [
      {
        title: 'Run tests',
        instructions:
          'If running locally, run npm test. Identify which suites cover deterministic code and which mock model/tool behavior.',
        href: '/tools',
        cta: 'Open Tools',
      },
      {
        title: 'Create a mini eval',
        instructions:
          'Pick one chat task and write a three-point rubric: correct tool use, grounded answer, safe behavior. Then compare the trace against it.',
        href: '/chat',
        cta: 'Open Chat',
      },
    ],
    questions: [
      {
        id: '13-unit',
        prompt: 'Which component is best for deterministic unit tests?',
        options: [
          'Schema conversion, parsers, DB helpers, and tool code',
          'Whether a model subjectively sounds nice',
          'A random output at high temperature',
          'A user preference with no rubric',
        ],
        answer: 0,
        explanation: 'Pure or bounded code should be tested deterministically.',
      },
      {
        id: '13-mock',
        prompt: 'Why mock model responses in loop tests?',
        options: [
          'To make tool-call sequences repeatable',
          'To make tests slower',
          'To hide all failures',
          'To remove assertions',
        ],
        answer: 0,
        explanation: 'Mocked responses let tests assert exact loop behavior.',
      },
      {
        id: '13-eval',
        prompt: 'What does an eval add beyond unit tests?',
        options: [
          'A quality measurement for realistic agent behavior',
          'A replacement for all code tests',
          'A CSS snapshot only',
          'A way to ignore traces',
        ],
        answer: 0,
        explanation: 'Evals test behavior quality under realistic tasks and rubrics.',
      },
      {
        id: '13-debug',
        prompt: 'Where should you start debugging a bad agent answer?',
        options: [
          'The trace: model input, tool calls, observations, and stop reason',
          'The app logo',
          'Only the final sentence',
          'A random package version',
        ],
        answer: 0,
        explanation: 'The trace shows the hidden path that produced the answer.',
      },
    ],
  },
  {
    slug: '14-multi-agent-orchestration',
    title: '14 — Multi-Agent Orchestration',
    module: '14 Orchestration',
    level: 'Advanced',
    estimatedMinutes: 32,
    summary:
      'Learn when to delegate to sub-agents, how background tasks communicate, and how to avoid turning multi-agent systems into uncontrolled complexity.',
    objectives: [
      'Decide when multi-agent delegation is useful',
      'Explain async task files and notifications',
      'Design safe specialist agents with narrow tools',
    ],
    content: `# Multi-Agent Orchestration

Multi-agent systems are not automatically better. They are useful when work can be decomposed into independent roles, parallel subtasks, or specialist contexts. They are harmful when they multiply confusion, cost, and hidden state.

## Orchestration pattern

![Multi-agent orchestration flow](/learn/14-orchestration-flow.svg)

## When delegation helps

Use sub-agents when:

- Work can run independently or in parallel.
- A specialist prompt/tool policy is genuinely useful.
- The parent would otherwise lose focus or exceed context.
- The result can be summarized back through a task file.

Do **not** use sub-agents just to make a task sound sophisticated. Every sub-agent adds model calls, state, failure paths, and coordination overhead.

## Agent roles

| Role | Good tool policy | Bad tool policy |
|------|------------------|-----------------|
| Researcher | RAG/search/read-only tools | full shell and delete |
| Coder | read/write/edit, tests with approval | unrestricted external APIs |
| Reviewer | read-only + trace inspection | write/delete by default |
| Operator | approvals, synthesis, delegation | doing every subtask itself |

## Async constraints

Async sub-agents do not have a live browser session. They cannot ask the user for one-time approval. Dangerous operations therefore require either a safe tool policy or a permanent approval that the operator intentionally granted.

## Communication protocol

A background sub-agent should update the task file with:

- current status,
- major decisions,
- files changed,
- errors encountered,
- final summary,
- verification evidence.

The parent should read the task file before synthesizing a result. Never assume a background agent succeeded just because it was launched.

## Try it yourself: design a team

Pick a realistic task such as "audit this repo and fix docs drift." Design three agents: researcher, implementer, reviewer. For each, write a one-sentence role, allowed tools, forbidden tools, and what it must report in the task file.`,
    experiments: [
      {
        title: 'Create a specialist agent',
        instructions:
          'Open Prompts & Memory and create a read-only reviewer agent. Give it a narrow system prompt and limited tools.',
        href: '/agents',
        cta: 'Open Prompts & Memory',
      },
      {
        title: 'Launch a background task',
        instructions:
          'From Chat, ask the main agent to delegate a small read-only task to your specialist. Then inspect the returned task file in Agent Files.',
        href: '/chat',
        cta: 'Open Chat',
      },
    ],
    questions: [
      {
        id: '14-when',
        prompt: 'When should you use a sub-agent?',
        options: [
          'When work is independent, parallel, or benefits from a specialist role/tool policy',
          'For every single prompt',
          'Only to avoid writing tests',
          'When you want hidden state',
        ],
        answer: 0,
        explanation:
          'Sub-agents add overhead and should be used for decomposition or specialization.',
      },
      {
        id: '14-task-file',
        prompt: 'Why does an async sub-agent write to a task file?',
        options: [
          'To provide durable progress and final evidence to the parent',
          'To hide its work',
          'To delete approvals',
          'To replace all messages',
        ],
        answer: 0,
        explanation:
          'The task file is the communication channel between background work and the parent.',
      },
      {
        id: '14-tools',
        prompt: 'What is a safe tool policy for a reviewer agent?',
        options: [
          'Mostly read-only tools and trace inspection',
          'Unrestricted delete and shell by default',
          'No ability to read anything',
          'Only UI theme controls',
        ],
        answer: 0,
        explanation: 'Specialist agents should get the minimum tools needed for their role.',
      },
      {
        id: '14-approval',
        prompt: 'Why do async sub-agents need special handling for dangerous tools?',
        options: [
          'They cannot show live browser approval UI, so only permanent approvals can apply',
          'They cannot use models',
          'They always run in the browser',
          'They never write logs',
        ],
        answer: 0,
        explanation: 'Background agents lack an interactive session for one-time approval prompts.',
      },
    ],
  },
];

export function getLesson(slug: string): Lesson | undefined {
  return LESSONS.find((lesson) => lesson.slug === slug);
}

export function getNextLesson(slug: string): Lesson | undefined {
  const index = LESSONS.findIndex((lesson) => lesson.slug === slug);
  return index >= 0 ? LESSONS[index + 1] : undefined;
}

export function getPreviousLesson(slug: string): Lesson | undefined {
  const index = LESSONS.findIndex((lesson) => lesson.slug === slug);
  return index > 0 ? LESSONS[index - 1] : undefined;
}
