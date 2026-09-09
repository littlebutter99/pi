# demo-coding-agent 走向 coding-agent 的路线图 (roadmap)

> 目标:把 `demo-coding-agent` 逐步做成 `pi-coding-agent` 那样的形态。约束保持不变——**只依赖 `pi-agent-core` / `pi-ai` 提供的接口**,不照搬或内联 coding-agent 的实现;每个阶段应该是独立可跑、可单独讲解的最小闭环。
>
> 相关文档:[`interactive-mode-checklist.md`](./interactive-mode-checklist.md) 是交互模式的逐项差距(界面/编辑/命令/快捷键/消息队列/会话)。本文是**整体演进计划**,按核心优先排序,含当前接入点和验收要点。

## 现状(基线)

已完成:

- 交互式多轮 REPL(`cli.ts`),基于 `agent.prompt()`,逐行 stdin
- 系统提示词分节生成并加载 AGENTS.md(`prompt.ts`:人格 → 工具清单 → 准则 → `<project_context>` → skills 空占位 → cwd)
- 内置工具集对齐 coding-agent 默认写作组(`tools.ts`):`read` / `bash` / `edit` / `write`,含统一返回结构、bash 的 sequential/onUpdate/非零退出教学特性
- 思考模式与思考/正文分区渲染(`cli.ts` streamer)
- bash 安全门(block 危险命令)

目标切面是 coding-agent 的**可持久化会话 + slash 命令 + 命令式 TUI**,但 demo 不必 1:1 照搬。下面是按性价比排的核心路径。

---

## Phase 0 — 目录与入口整理(排除膨胀)

**现状**:全部逻辑挤在 `src/cli.ts` + `src/tools.ts` + `src/prompt.ts` 三个文件。扩展会迅速膨胀。

- 拆分为 `src/core/`(`agent-session`、tools、prompt、compaction)、`src/commands/`、`src/ui/`,`cli.ts` 只留启动与装配。
- 教学红利:每个文件对应一个可单独讲到点(i.e. session / tools / command registry)。

**验收**:加一个 slash 命令、一个工具不需要改动 `cli.ts`。

## Phase 1 — 消息模型、turn 事件与消息队列(核心之一)

**现状**:多轮靠 `agent.state.messages` 累加;每轮 token 在 `agent_end` 之后才用「找最后一条 assistant」来数;输入忙碌时 `rl.pause()` 直接不吃输入(不做队列)。

要做:

1. **消息类型收口**:区分 user / assistant(带 `usage`、`stopReason`、思考量) / 工具结果 / 自定义消息的职责。
2. **以事件界定一轮**:订阅 `turn_start` / `turn_end` / `message_start~end` 而不是看 `agent_end` 才收尾。这样 usage 收集点稳定,为 token 统计/状态栏打底(`checklist` 第 1 节)。
3. **steer / follow-up 队列**:`checklist` 第 5 节,pi-agent-core 的 `agent.steer()` 正好覆盖——agent 忙时输入 Enter → `steer()` 注入,`alt+Enter` 用 follow-up 语义(工作全部结束后才投)。**这是与 coding-agent 行为差异最大、也最好讲的一节**。

**接入点**:`agent.steer()`、`agent.subscribe()` 的事件(`agent-loop.ts` 里 `message_update` / `turn_start` / `turn_end`)、`agent.state.messages`。

## Phase 2 — slash 命令框架(核心之二)

**现状**:输入 `/exit` 走特判,其余全当用户消息发给模型。

- 做一个**最小解析框架**:输入以 `/` 开头 → 查命令注册表执行,与普通消息分离(不整段发给模型)。
- 核心命令按性价比(`checklist` 第 3 节):
  - `/model` 切换模型
  - `/thinking` 循环思考档(基于已有的思考渲染)
  - `/new` 新会话
  - `/compact` 上下文压缩(见 Phase 4)
  - `/copy` 复制最后一条 assistant
  - `/quit` 退出
- 命令注册表留扩展位:`/export`、`/resume`、`/skill` 自然落位。

**接入点**:`agent.state.model`(可 setter 切换)、`agent.state.thinkingLevel`、`agent.state.messages`。

## Phase 3 — 原始输入层、快捷键与中止(交互模式的地基)

**现状**:`readline.question`,逐行;Escape 中止、Ctrl 组合都无。

- 从 `readline` 换成 **raw mode** 逐键处理:
  - Enter 发送、`shift+Enter` 续行(多行输入)
  - `Escape` → `agent.abort()` 中止当前回复
  - `Ctrl+C` 空闲退出、忙碌时确认/中止
  - `Ctrl+X` 复制最后一条 assistant、`Ctrl+L` 模型选择
- 只有 raw mode 之后,「输入忙碌时继续读、但只入队不发送」才成立(Phase 1 的协作基础)。

> 投入较大,**建议等 Phase 1/2 跑通再做**,否则 demo 仍是"自上而下逐行"而不是事件驱动,收益打折。

## Phase 4 — 上下文与压缩 compaction(核心之三)

**现状**:对话无限累积,极易触上下文上限;目前只能手动 `/exit` 重来。

- coding-agent 有 `packages/agent/src/harness/compaction/`。教学第一步不必照搬:
  1. 超阈值(demo 用 token 粗估或消息量)时提示 `/compact`
  2. 执行「保留 system + 会话首尾若干条 + 一条摘要」替换 `agent.state.messages`
  3. 摘要如何补进下文(可挂在后续 user 消息或系统提示的补充段)
- compaction 是真·长会话不炸的机制,也是通往持久化分支回溯的雏形。

**接入点**:`agent.state.messages`(数组快照语义,可直接替换)。

## Phase 5 — 会话持久化与恢复(走向 coding-agent 关键,可后移)

- `/export`、`/resume` 基础:把 `agent.state.messages` 序列化 JSONL,启动时 `--session` / 续聊恢复;assistant 消息要能回放。
- 分支/回溯 `/tree` 依赖它(coding-agent 的 fork/collapse),属较后期优先,先留接口。

## Phase 6 — 工具与能力扩展

- `/skill` 与 skills 发现:`prompt.ts` 已留出 `<available_skills>` 空占位(此前定"skills 先不加"),走 coding-agent / pi 共享规范。
- `!command` / `!!command`:把 bash 输出发给模型(`!`)或只跑不发(`!!`)。
- `@file` 引用:pull project 文件路径进上下文。
- prompt template 资源(与 skills 并列)。

## Phase 7 — 界面打磨

对照 `checklist` 第 1 节:

- 页脚状态栏(tokens ↑↓ / 成本 / 上下文占用 / 当前模型)
- 思考区可折叠(`Ctrl+T`):现只有"分区 + 分色",缺折叠
- 工具输出折叠(`Ctrl+O`)，按 toolCallId 配对起止

依赖 raw mode 与事件流,故排在 Phase 1/3 之后。

---

## 核心缩写顺序(推荐先做)

> 面向"最少步骤、最先长出 coding-agent 的形"。

**P0 目录整理 → P1 事件化 turn + steer/follow-up → P2 slash 命令框(先 `/model` `/new` `/thinking` `/quit` `/copy`)→ P4 最小 compaction → P6 工具(先 `!command`)→ P3 raw 输入 → P5 持久化 → P7 渲染。**

理由:消息队列 + 命令框在纯 actor 语义上长出 coding-agent 交互是最短路径;compaction 让长会话不炸;raw 输入/TUI 依赖前面才顺。

> 与 `checklist` 的教学顺序目标一致,但这是整体计划,按依赖与核心程度编排。做某一步时以本 phase 的「接入点」只用 pi-agent-core/pi-ai 为准,不内联 coding-agent 内部实现。
