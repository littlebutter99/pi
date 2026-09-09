# demo-coding-agent 交互模式功能对照清单

> 对照 `@earendil-works/pi-coding-agent` 的交互模式,列出 demo-coding-agent 的差距、 coding-agent 的行为,以及实现要点。教学用:每个缺口都只依赖 `pi-agent-core` / `pi-ai` 的接口,不引入编码器内部实现。
>
> 当前 demo 现状:终端逐行输入 → `agent.prompt()` → 流式输出(**已有多轮对话、退出命令、tokens 统计**)。无界面布局、无命令、无快捷键、无消息队列。

---

## 1. 界面与反馈

| 功能 | coding-agent 行为 | demo 现状 | 实现要点 |
|---|---|---|---|
| **消息区渲染** | 用户/助手消息、工具调用和结果、通知分区展示 | 全部混在 stdout | 用 `agent.subscribe()` 的 `message_update` / `agent_start` / `agent_end` 事件,按类型标注颜色或前缀 |
| **思考过程(thinking)** | 单独分区,可折叠(Ctrl+T) | 灰色文本直接混流 | 已有 `thinking_delta` 分支,但无折叠;记录 delta 起止行的渲染状态即可 |
| **工具输出折叠** | Ctrl+O 展开/收起工具输出 | `[tool]` 行平铺 | 用 `tool_execution_start/end` 事件配对,记住每个 toolCallId 的起止行 |
| **页脚状态栏** | 会话名、tokens(↑↓RW)、成本、上下文占用、当前模型 | 仅每轮打印 tokens | 汇总 `agent.state.messages` 里 assistant `usage`,轮询渲染一行 |
| **启动头** | 展示快捷键、加载的 AGENTS.md、skills、扩展 | 无 | 纯静态,打印一行提示即可 |

## 2. 编辑器能力

| 功能 | coding-agent 行为 | demo 现状 | 实现要点 |
|---|---|---|---|
| **命令前缀 `!` / `!!`** | `!cmd` 跑 bash 并把输出发给 LLM;`!!cmd` 只跑不发 | 无 | 输入行以 `!` 开头时直接 `spawn`,输出可选拼进下一条 user message(可复用 `tools.ts` 的 bash 逻辑) |
| **多行输入** | Shift+Enter 换行,Enter 发送 | `readline` 单行 | 换成 `raw mode` 手工拼行(或用按键捕获的 readline 扩展),教学上可后置 |
| **`@` 文件引用** | 模糊搜索项目文件插入路径 | 无 | 无依赖,`glob` 当前目录 + 模糊匹配,教学上可后置 |
| **剪贴板粘贴** | Ctrl+V 粘贴图片/文本给模型 | 无 | 依赖平台命令(`pbcopy`/`xclip`),后置 |

## 3. 命令系统

demo 只需要 slash 命令的**解析框架**:输入以 `/` 开头时查表执行,与普通消息分离。以下按教学价值排序。

| 命令 | coding-agent 行为 | demo 实现要点 |
|---|---|---|
| `/model` | 切换模型(Ctrl+S 保存默认) | `models.getModels("deepseek")` 已在手,换一个重开 `Agent` 或改 `agent.state.model`(setter 存在) |
| `/compact` | 手动压缩上下文 | `agent.state.messages` 可替换;教学上先做「清空到只剩 system + 当前摘要」 |
| `/copy` | 复制最后一条助手消息 | 取 `agent.state.messages` 最后一个 assistant,写剪贴板 |
| `/thinking` | 切换思考等级 | `agent.state.thinkingLevel`(demo 现在是写死 `"off"`) |
| `/new` | 新会话 | 重新 `new Agent` |
| `/resume`、`/tree`、`/fork`、`/clone` | 会话管理/回溯/分叉 | 依赖会话持久化,见第 6 节 |
| `/export`、`/import` | 会话导出 JSONL / 导入恢复 | 把 `agent.state.messages` 序列化;注意 assistant 消息格式要能回放 |
| `/quit` | 退出 | 已有(exit/quit/Ctrl+D) |

## 4. 快捷键

demo 现在没有按键体系(raw mode 之前只有 readline 的 question)。先做这几个投入产出比最高的:

| 快捷键 | coding-agent 行为 | demo 实现要点 |
|---|---|---|
| **Ctrl+C** | 第一次清空输入,连按两次退出 | 简单:直接退出 + 提示;升级:空闲时退出、`agent.isStreaming` 时 `agent.abort()` |
| **Escape** | 中止当前回复 | `agent.abort()` 已在 api,顺手可达 |
| **Ctrl+L** | 打开模型选择器 | 等价于 `/model` |
| **Ctrl+X** | 复制最后一条助手消息 | 等价于 `/copy` |

实现方法:把输入层从 `readline.question` 升级为 `raw mode`(`process.stdin.setRawMode(true)`)逐键处理,`Enter` 提交、`Shift+Enter` 换行、Ctrl 组合发控制码。这是 demo 从「逐行脚本」走向「真 TUI 层」的关键一步,建议作为教学主线。

## 5. 消息队列

这是 coding-agent 交互模式最有价值、也最好讲的一节 —— 它直接用 `pi-agent-core` 的 **`agent.steer()`**:

| 功能 | coding-agent 行为 | demo 实现要点 |
|---|---|---|
| **Enter 排队(steering)** | agent 忙时输入的 Enter 消息,当前 turn 工具执行完后投递 | `agent.prompt()` 进行中不 await;用 `agent.steer({ role: "user", content, timestamp: Date.now() })` 注入,任务完成回调里处理 |
| **Alt+Enter 排队(follow-up)** | 全部工作结束后才投递 | 同上,但发送时机后移到订阅的 `agent_end` 事件 |
| **Escape 取回/中止** | 中止并恢复队列到编辑器 | 队列数组本地管理;中止用 `agent.abort()` |
| **Alt+Up 取回** | 把排队的消息取回编辑器 | 队列数组操作 |

> 配套改动:现在 `rl.pause()`(agent 回复时不读输入)要改成「agent 运行中仍读输入但只入队不发送」,这是消息队列与现在实现最大的行为差异。

## 6. 会话与上下文(交互相关部分)

| 功能 | coding-agent 行为 | demo 实现要点 |
|---|---|---|
| **会话持久化** | JSONL 存盘,`/resume` 恢复 | `agent.state.messages` 序列化到文件;恢复时回放进新 Agent 的 initialState |
| **分支/回溯** | `/tree` 回到历史消息点继续 | messages 数组是快照语义(setter 替换),直接裁剪数组即可模拟 |
| **compaction** | 上下文超限自动摘要压缩 | pi-agent-core 有 transcript 压缩工具(`packages/agent/src/harness/compaction/`),教学版可先做「超阈值时报 `/compact` 提示」 |

---

## 建议教学顺序(按性价比)

1. **命令解析框架 + `/model`、`/thinking`、`/copy`** —— 最小成本,立刻有「编码助手感」
2. **快捷键层(raw mode)+ Ctrl+C/Escape 中止(`agent.abort()`)** —— 交互模式的核心骨架
3. **消息队列(`agent.steer()`)** —— coding-agent 交互模式的关键差异点,pi-agent-core 接口正好覆盖
4. **工具输出折叠/页脚状态栏**(基于 subscribe 事件)
5. **会话持久化 + `/new`、`/resume`、`/export`**
6. 最后才做编辑体验(`!command`、多行输入、`@` 引用、剪贴板)