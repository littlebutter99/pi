# demo-coding-agent

A minimal coding agent built directly on two packages — no other pi package
involved:

| package | role |
|---|---|
| `@earendil-works/pi-ai` | models, providers, the stream protocol to the LLM |
| `@earendil-works/pi-agent-core` | the agent loop, tool execution, events, agent state |

This package exists to show *where* each feature lives, so you can build your
own agent (not just a coding agent) on the same two packages.

## Files

- `src/index.ts` — demo driven by the **faux provider** (no API key, no
  network; the "LLM" is a scripted function). Run: `npm run demo`.
- `src/cli.ts` — the same agent with a **real provider** (Anthropic).
  Run: `ANTHROPIC_API_KEY=sk-ant-... npm run demo:real "your prompt"`.
- `src/tools.ts` — three `AgentTool`s: `read_file`, `write_file`, `bash`.
- `src/prompt.ts` — the system prompt.

## How a run works

```
your code                          pi-ai                          pi-agent-core
─────────────────────────────────────────────────────────────────────────────
createModels()            →  Models (provider registry + auth)
setProvider(provider())   →  registers a provider + its model catalog
getModel()/getModels()    →  picks a Model
new Agent({streamFn,      →  creates the agent
           initialState})     state: model, systemPrompt, tools, messages
agent.prompt("...")            runAgentLoop:
                               turn: LLM call (via streamFn → provider → API)
                               tool calls → validated → beforeToolCall gate
                               → execute() → toolResult back into transcript
                               → next turn, until stop
agent.subscribe(events)   ←  agent_start / message_update / tool_execution_* /
                               turn_end / agent_end (streaming UI)
```

### 1. Models and providers (`pi-ai`)

`Models` is a runtime collection of providers. A provider owns its model
catalog, auth, and stream behavior. Built-in provider factories ship in
`@earendil-works/pi-ai/providers/*`:

```ts
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider()); // auth auto-resolves from ANTHROPIC_API_KEY

const model = models.getModel("anthropic", "claude-sonnet-4-6"); // or getModels(...)[0]
```

No API key? Use the faux provider for development:

```ts
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

const faux = fauxProvider();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage("Hello"),
  fauxAssistantMessage([fauxToolCall("bash", { command: "ls -la" })]),
]);
```

The faux provider speaks the exact stream protocol of a real provider, so the
agent loop and your tools run unchanged.

### 2. The bridge: `streamFn` (`pi-ai` → `pi-agent-core`)

`AgentOptions.streamFn` is the only place the agent core talks to the LLM:

```ts
const agent = new Agent({
  streamFn: models.streamSimple.bind(models), // Models.streamSimple satisfies StreamFn
  // ...
});
```

Contract: the stream function never throws; request/model/runtime failures
are encoded in the returned event stream as an assistant message with
`stopReason: "error" | "aborted"`. `pi-agent-core` converts its own
`AgentMessage[]` transcript to pi-ai `Message[]` (filtering UI-only messages)
right before every call.

### 3. Tools (`pi-agent-core`)

Each tool is a `AgentTool`: a TypeBox parameter schema + an `execute`
function. Throwing an `Error` reports failure to the model; an `onUpdate`
callback streams partial output; `executionMode: "sequential"` forces the
tool to run alone even in a parallel batch.

```ts
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const schema = Type.Object({ path: Type.String() });
const readFileTool: AgentTool<typeof schema, { path: string }> = {
  name: "read_file",
  label: "Read File",
  description: "Read a text file.",
  parameters: schema,
  execute: async (_id, params) => ({
    content: [{ type: "text", text: await readFile(params.path, "utf-8") }],
    details: { path: params.path },
  }),
};
```

### 4. Hooks and control (`pi-agent-core`)

```ts
const agent = new Agent({
  streamFn,
  initialState: { systemPrompt, model, tools: [bashTool] },
  // gate / rewrite every tool call
  beforeToolCall: async ({ toolCall }) =>
    dangerous(toolCall) ? { block: true, reason: "blocked" } : undefined,
  afterToolCall: async ({ result, isError }) => ({ details: { ...result.details } }),
});

agent.subscribe((event) => { /* render streaming UI from events */ });
agent.steer({ role: "user", content: "stop, do this instead", timestamp: Date.now() });
agent.abort();
```

`agent.state` exposes the live transcript, streaming message, pending tool
calls, model, thinking level — replace `state.messages`/`state.tools` to
rewind or change the agent at runtime.

## Developing

This package runs from source via `tsx` and the repo-root tsconfig path
mapping (`@earendil-works/pi-ai` → `packages/ai/src`, ...). After a root
`npm install`, run:

```bash
npm run demo        # faux provider, no key needed
npm run demo:real   # requires ANTHROPIC_API_KEY
```

Note on `cli.ts` (the real-provider branch): its model catalog import
(`@earendil-works/pi-ai/providers/anthropic`) depends on generated model data
(`packages/ai/src/providers/data/*.json`) that the `pi-ai` build produces.
When consuming the published npm package this data ships inside it, so this
is a dev-repo-only caveat: generate it with `npm --prefix packages/ai run
generate-models` before running `demo:real` from source.

`src/cli.ts` is excluded from this package's own `tsconfig.json` (it needs the
generated data); it is still covered by the repo-root tsconfig.