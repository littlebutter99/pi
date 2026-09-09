# demo-coding-agent

一个极简的 coding agent,直接构建在两个包之上——不涉及任何其他 pi 包:

| 包 | 作用 |
|---|---|
| `@earendil-works/pi-ai` | 模型、provider、与 LLM 之间的流式协议 |
| `@earendil-works/pi-agent-core` | agent 循环、工具执行、事件、agent 状态 |

这个包存在的目的是展示每个功能**住在哪里**,让你能基于同样的两个包构建自己的 agent(而不只是 coding agent)。

## 文件

- `src/index.ts` —— 由 **faux provider** 驱动的示例(无需 API key、无需网络;"LLM" 是一个脚本化函数)。运行:`npm run demo`。
- `src/cli.ts` —— 使用**真实 provider**(Anthropic)的同一个 agent。运行:`ANTHROPIC_API_KEY=sk-ant-... npm run demo:real "your prompt"`。
- `src/tools.ts` —— 三个 `AgentTool`:`read_file`、`write_file`、`bash`。
- `src/prompt.ts` —— 系统提示词。

## 一次运行的流程

```
你的代码                          pi-ai                          pi-agent-core
─────────────────────────────────────────────────────────────────────────────
createModels()            →  Models(provider 注册表 + 认证)
setProvider(provider())   →  注册一个 provider 及其模型目录
getModel()/getModels()    →  挑选一个 Model
new Agent({streamFn,      →  创建 agent
           initialState})     state: model、systemPrompt、tools、messages
agent.prompt("...")            runAgentLoop:
                               turn: LLM 调用(经 streamFn → provider → API)
                               工具调用 → 校验 → beforeToolCall 闸门
                               → execute() → 把 toolResult 放回 transcript
                               → 下一轮,直到 stop
agent.subscribe(events)   ←  agent_start / message_update / tool_execution_* /
                               turn_end / agent_end(流式 UI)
```

### 1. 模型与 provider(`pi-ai`)

`Models` 是 provider 的运行时集合。一个 provider 拥有自己的模型目录、认证和流式行为。内置 provider 工厂随 `@earendil-works/pi-ai/providers/*` 发布:

```ts
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider()); // 认证自动从 ANTHROPIC_API_KEY 解析

const model = models.getModel("anthropic", "claude-sonnet-4-6"); // 或 getModels(...)[0]
```

没有 API key?开发时用 faux provider:

```ts
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

const faux = fauxProvider();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage("Hello"),
  fauxAssistantMessage([fauxToolCall("bash", { command: "ls -la" })]),
]);
```

faux provider 使用与真实 provider 完全相同的流式协议,因此 agent 循环和你的工具可以原样运行。

### 2. 桥梁:`streamFn`(`pi-ai` → `pi-agent-core`)

`AgentOptions.streamFn` 是 agent core 与 LLM 对话的唯一入口:

```ts
const agent = new Agent({
  streamFn: models.streamSimple.bind(models), // Models.streamSimple 满足 StreamFn
  // ...
});
```

约定:stream 函数永不抛异常;请求/模型/运行时失败会以一条 `stopReason: "error" | "aborted"` 的 assistant 消息编码进返回的事件流。`pi-agent-core` 会在每次调用前,把自己的 `AgentMessage[]` transcript 转换为 pi-ai 的 `Message[]`(过滤掉仅用于 UI 的消息)。

### 3. 工具(`pi-agent-core`)

每个工具都是一个 `AgentTool`:一个 TypeBox 参数 schema 加一个 `execute` 函数。抛出 `Error` 会向模型报告失败;`onUpdate` 回调流式输出部分结果;`executionMode: "sequential"` 会强制该工具在并行批次中也单独执行。

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

### 4. 钩子与控制(`pi-agent-core`)

```ts
const agent = new Agent({
  streamFn,
  initialState: { systemPrompt, model, tools: [bashTool] },
  // 对每次工具调用做闸门/改写
  beforeToolCall: async ({ toolCall }) =>
    dangerous(toolCall) ? { block: true, reason: "blocked" } : undefined,
  afterToolCall: async ({ result, isError }) => ({ details: { ...result.details } }),
});

agent.subscribe((event) => { /* 用事件渲染流式 UI */ });
agent.steer({ role: "user", content: "stop, do this instead", timestamp: Date.now() });
agent.abort();
```

`agent.state` 暴露实时 transcript、流式消息、待处理的工具调用、模型、思考等级——替换 `state.messages`/`state.tools` 即可在运行时回退或改变 agent。

## 开发

本包通过 `tsx` 从源码运行,并使用仓库根 tsconfig 的路径映射(`@earendil-works/pi-ai` → `packages/ai/src`,……)。执行根目录 `npm install` 后,运行:

```bash
npm run demo        # faux provider,无需 key
npm run demo:real   # 需要 ANTHROPIC_API_KEY
```

关于 `cli.ts`(真实 provider 分支)的说明:它的模型目录导入(`@earendil-works/pi-ai/providers/anthropic`)依赖 `pi-ai` 构建生成的模型数据(`packages/ai/src/providers/data/*.json`)。消费发布版 npm 包时这些数据已内置其中,所以这只是开发仓库特有的注意事项:从源码运行 `demo:real` 之前,先用 `npm --prefix packages/ai run generate-models` 生成它。

`src/cli.ts` 被排除在本包自己的 `tsconfig.json` 之外(它需要生成的数据);它仍由仓库根 tsconfig 覆盖。
