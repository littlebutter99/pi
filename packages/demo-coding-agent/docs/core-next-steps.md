# demo-coding-agent 核心下一步(决策文档)

> 目的:定出"哪件事先做、为什么、怎么做、用什么接口"的单一结论,避免在表层功能上发散。
> 判定标准只有一条:**这件事不做,会不会让 agent 在真实任务里变不可靠或死掉**。会,才叫核心。

## 现状

- 交互式多轮 REPL,`read` / `bash` / `edit` / `write` 四个工具,`agent.prompt()` 逐轮推进。
- 已删:P1 的 steer/follow-up 队列、token 统计(纯观测,不影响行为)。
- 已接通的核心管线:`signal` → 工具中止(`bashTool` 的 `execute` 已监听 abort 杀子进程)、`beforeToolCall` 安全门。
- 未做且致命:没有上下文压缩。

## 优先级一:中止(已完成)`src/ui/repl.ts`

**实现**:输入层弃用 readline,改为裸 `process.stdin`(canonical 模式)+ `process.on("SIGINT")`。

```ts
const onSigint = (): void => {
	if (agent.state.isStreaming) {
		agent.abort(); // 工具子进程会收到 abort 信号被杀掉
	} else if (!quitting) {
		quitting = true;
		reader.wake();
	}
};
process.on("SIGINT", onSigint);
```

**为什么必须换掉 readline**(实测,不是猜测):

- readline 用私有 signal watcher 接管了 SIGINT,`process.on("SIGINT")` 挂了也不触发(`process.listenerCount("SIGINT")` 为 0);
- `rl.pause()` 期间 stdin 字节流被整体冻结,连 raw mode + 自己的 `data` 监听也收不到字节(流的 pause 先于任何人);
- `rl` 的 `SIGINT` 事件只在有 question 挂起/raw mode 激活时才派发,运行中(暂停时)收不到。

裸 stdin 的 canonical 模式恰好白赚:回显、退格、行编辑都由终端驱动完成;SIGINT 是信号、不受 `pause()` 影响。

**验证**(pty + 直接向进程发 SIGINT):

- 空闲 Ctrl+C → 干净退出(code 0);Ctrl+D → 干净退出;
- `sleep 45` 工具调用运行中 Ctrl+C → 中止提示 1 秒内出现、进程存活、会话继续下一轮、**无孤儿 sleep 进程**(说明 `bashTool` 的 abort 监听从信号到杀子进程整条链都通了);
- 管道输入 → 正常。(测试坑:裸 pty 无前台进程组,VINTR 发不出信号;`script` + `trap '' INT` 会让 node 拒绝安装 SIGINT 的 JS handler——这两种都是测试壳子问题,真终端不受影响。)

## 优先级二:read 工具契约修正(已完成)`src/core/tools.ts`

**两条规则**(文案对齐 `packages/coding-agent/src/core/tools/read.ts`):

1. **截断/行数写进 content 文本**,不是 details(模型看不到 details,序列化只走 content,见 `packages/ai/src/api/openai-completions.ts:1393`):

   ```
   line5
   line6

   [4 more lines in file. Use offset=7 to continue.]
   ```

2. **越界抛错**(`execute` 约定是 "Throw on failure",抛出去模型能收到并自我纠正):

   ```
   Error: Offset 99 is beyond end of file (10 lines total)
   ```

**顺带修的一处(coding-agent 也有,没修)**:文件以 `\n` 结尾时 `content.split("\n")` 末尾会多一个空元素,直接拿 `length` 当行数会把 10 行报成 11、"N more lines" 多算一条。行数统计用 `content.endsWith("\n")` 判断后减一,但**切片仍用原始 split**——join 回来与文件逐字节一致,read → edit/write 的精确匹配契约不受影响。

**验证**(直调用 `readTool.execute`,确定性断言,无模型参与):全量读字节保真且 totalLines=10;offset=5+limit=2 返回 `[4 more lines in file. Use offset=7 to continue.]`;读到末尾无提示;offset=99 抛 `Offset 99 is beyond end of file (10 lines total)`;空文件/单换行文件正常。端到端:让模型读 `tools.ts` 结尾 3 行,能准确报出真实行号。

## 优先级三:上下文压缩(真正的核心,工作量最大)

**为什么**:唯一"不做就会死"的功能。会话一长 provider 直接报 context 超限,硬失败,和被杀进程一样。这是 demo 与 coding agent 的分界。

**关键发现**:**不用从零写**。`pi-agent-core` 已导出整套管线(`packages/agent/src/index.ts:72` → `harness/compaction/compaction.ts`):

| 导出 | 作用 |
|---|---|
| `estimateContextTokens(messages)` | 用最后一条 assistant 的 usage 估当前上下文占用,其后消息按字符估 |
| `shouldCompact(contextTokens, contextWindow, settings)` | 超过 `contextWindow - reserveTokens` 触发 |
| `DEFAULT_COMPACTION_SETTINGS` | 现成阈值 |
| `prepareCompaction(entries, settings)` | 算 cut point:摘要哪些、保留哪段 tail、是否切轮 |
| `compact(preparation, models, model, customInstructions, thinkingLevel, retry, callbacks, context)` | 生成摘要并替换消息,`Result<CompactResult, CompactionError>` |

**接线方式**(工作量在这,不在算法):

- **`transformContext(messages)`**(`packages/agent/src/types.ts` 的 `AgentLoopConfig`)每次 LLM 调用前触发:跑 `estimateContextTokens` → `shouldCompact`,超了就压缩,把「摘要 + 保留 tail」替换回 `agent.state.messages`。
- **`shouldStopAfterTurn`**:压缩尚未完成时优雅收尾,不硬开下一轮。

**难点**:压缩管线是 harness 层结构(`Entry[]` / `Context`),demo 走的是高层 `Agent` API + `agent.state.messages`,中间需要一层适配。可参考 `packages/coding-agent` 的接法。

**验证**:开一个超长会话(或调低阈值),确认触发压缩、摘要进上下文、后续轮次照常。

## 做完三件后:跑一个真实任务再定下一步

例如让 agent 在 demo 目录里"给 read 工具加越界报错"。它会多轮 read → edit → bash 测试。跑完可见下一批缺口,预计是:

- **edit 一次只能改一处**(`oldText` 必须全局唯一,真实改动通常要改多处)——考虑多编辑或上下文匹配;
- **会话无法持久化**(重启全丢)——JSONL + `--resume`。

到那一步再讨论,不要提前做。

## 明确不做(面子工程,非核心)

slash 命令框架、`@file` 引用、skills、TUI 状态栏、token 统计(已删,不再加回)。这些不提升 agent 的可靠性,排到核心之后。

## 参考位置速查

- SIGINT/abort:`agent.state.isStreaming`、`agent.abort()`(demo 前一个版本用过,见 git 历史 50935a09d 的 repl.ts)
- read 参照:`packages/coding-agent/src/core/tools/read.ts`(truncation 提示拼接在 `read.ts:163-172`;越界抛错在 `read.ts:137`)
- 压缩管线:`packages/agent/src/harness/compaction/compaction.ts`(导出 `compact` / `prepareCompaction` / `estimateContextTokens` / `shouldCompact` / `DEFAULT_COMPACTION_SETTINGS`)
- Agent 钩子全表:`packages/agent/src/types.ts`(`AgentLoopConfig`)与 `packages/agent/src/agent.ts:98`(`AgentOptions`)
- coding-agent 钩子接法:`packages/coding-agent/src/core/agent-session.ts:487 / 508`(beforeToolCall / afterToolCall 运行中赋值)