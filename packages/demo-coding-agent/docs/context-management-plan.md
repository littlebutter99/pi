# Claude Code 上下文管理范式落地计划(计划文档)

> 目标:把调研到的 Claude Code 范式(五级压缩级联 + 热/冷分离提醒 + 预算反压)在 `demo-coding-agent` 上落地。
> 约束不变:**只用 `pi-agent-core` / `pi-ai` 暴露的接口**,不内联 coding-agent 实现;每阶段独立可跑、可单独验收。
> 范式来源:Anthropic 官方 API compaction 文档 + 社区逆向 Claude Code `src/services/compact/*.ts` 的分析(见调研结论)。
> 本文只写计划;实现从 Phase A 开始逐个做,每个 Phase 有独立的验收标准。

---

## 0. 范式回顾(一段话)

Claude Code 把上下文管理当"预算优化"问题:窗口 = 系统提示 + 工具定义 + 逐轮提醒 + 历史。压缩分五级,**能不动 LLM 就不动**:

| 级 | 手段 | 成本 |
|---|---|---|
| T1 Microcompact | 重排消息保住缓存前缀 | 0 |
| T2 Snip | 归档最旧探索性消息,留轻量标记(LRU 逐出) | 0 |
| T3 Collapse | 90% 起按段落渐进摘要(90% / 92% / 94%…),无断崖 | 少量 LLM 调用 |
| T4 Auto Compact | 子代理全量摘要,只留最后几条原文 | 一次 LLM 调用 |
| T5 Reactive | 413 应急:留最后 4 条,其余全摘要,重试一次 | 一次 LLM 调用 |

配套机制:热/冷分离(系统提示词缓存不得变,易变状态以 `<system-reminder>` 注入消息流)、预算反压(40%/70%/90% 提醒模型缩短输出)、tokenSaverOutput(bash 大输出全量给 UI、压缩版给模型)。

---

## 1. 映射到 pi 的接口(先对齐,再谈实现)

| 范式件 | Claude Code | pi 已有什么 | 缺口与适配 |
|---|---|---|---|
| T1 缓存前缀稳定 | cache_editing 重排 | 系统提示词/工具定义构造后不变(已成立) | **无显式 cache API**(DeepSeek 走 openai-completions,前缀缓存自动);改用纪律:提醒永远放消息流尾部,不碰系统提示词 |
| T2 免费归档 | snip + 轻量标记 | 无 | 自建:归档栈 + 自定义 role 标记消息;需自定义 `convertToLlm` 把标记映射成短文本 |
| T3 渐进摘要 | collapse 分段压 | `prepareCompaction` 是单切点(harnes `Entry[]` 依赖) | 自建"多段渐进":从旧到新分几次摘要 |
| T4 全量摘要 | 子代理摘要 | `compact()` / `generateSummaryWithUsage`(依赖 harness `Context`,demo 没有) | **核心适配**:用 `ProviderBundle.streamFn` 自己发一次摘要请求;`estimateTokens` / `serializeConversation` / `SUMMARIZATION_SYSTEM_PROMPT` 已导出可直接用(packages/agent/src/harness/compaction/compaction.ts:724 / 420) |
| T5 413 应急 | reactive compact | `agent.state.errorMessage` 在 prompt 结束后可读 | 自建:检测 context-length 类报错 → 压缩 → 重试一次(带 flags 防环) |
| 热/冷提醒 | system-reminder 50 种 | 无 | 自建提醒栈 + `convertToLlm` 尾部折叠(把提醒拼进每次请求的末端,不碰系统提示词) |
| tokenSaverOutput | bash 压缩输出 | `afterToolCall` 钩子可覆盖 `content` | `afterToolCall` 里大输出截断,全量放 `details`(UI 用) |
| 预算反压 | token 提醒升档 | `shouldStopAfterTurn` / `estimateContextTokens` | 提醒文本分档注入(60% 建议短输出,85% 收敛) |

---

## 2. 关键设计决策(先定死,免得实现时来回改)

1. **摘要请求不进 Agent loop**。压缩时用 `models.streamSimple(model, {...})` 直接发一次请求,而不是 `agent.prompt()`。好处:①天然没有递归——摘要请求不会触发 `transformContext`,不会"压出压缩";②不污染 `agent.state`;③可用 `thinkingLevel` 与 `maxTokens` 独立控制摘要档位。
2. **切点策略**:从消息头开始按 `estimateTokens` 累加,留足 `keepRecentTokens` 预算(默认 20000,见 `DEFAULT_COMPACTION_SETTINGS`)给保尾;切点落在 user 消息边界(不切断一轮 user→assistant→toolResult)。
3. **触发与收敛**:
   - `transformContext`(每次 LLM 调用前):`estimateContextTokens(...).tokens` + `contextWindow - reserveTokens`(默认 16384)判断,超了就压;
   - `shouldStopAfterTurn`:压缩正在进行时返回 true 让这轮优雅收尾,别硬开下一轮。
4. **迭代摘要**:保留上一次摘要文本,第二次压缩用 UPDATE 语义(previousSummary + 新旧段合并),不叠加新份。
5. **保真尾部**:摘要 + 最近若干条原文(正在改的文件、最新用户需求、最近工具结果)一个字节不动。

---

## 3. 分阶段计划

### Phase A:T2 免费归档 + 自定义 convertToLlm(半天)

**做什么**

- Agent 增加自定义 `convertToLlm`(现在用默认实现,会静默丢弃非 user/assistant/toolResult 的自定义 role);
- 新建归档栈:`snip()` 把最旧 N 条消息移出 `agent.state.messages`,放一个标记消息(自定义 role,内容如 `[已归档 N 条历史消息]`);
- `transformContext` 里用 `estimateContextTokens` + `shouldCompact` 判断,超阈值就 `snip()`——**不花任何 LLM 调用**。

**验收**

- 长会话:token 占用曲线出现"免费下降"(用最后一条 assistant 的 usage 观测);
- 标记消息出现在模型可见上下文里,后续轮次仍能续聊;
- 0 次额外 LLM 调用(对比实现前后 provider 用量)。

### Phase B:T4 全量摘要适配器(核心,1-2 天)

**做什么**

- `src/core/` 新建 `compact.ts`(demo 自己的适配器,不内联 coding-agent):
  1. 切点:`estimateTokens` 从头累加,保证尾部 ≥ `keepRecentTokens`;
  2. 串行化旧段:`serializeConversation`(已导出);
  3. 一次摘要:`streamSimple(model, {systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages:[{role:"user"…}]}, {maxTokens:…})`,摘要 body 沿用 structured 格式(Goal/Progress/Key Decisions/Next Steps + 要求保留路径/函数名/错误原文);
  4. 替换:`agent.state.messages = [摘要消息, ...保尾]`,摘要消息用 pi 现成 `createCompactionSummaryMessage`(packages/agent/src/harness/messages.ts 导出);
  5. 迭代:`previousSummary` 传给第二次压缩(UPDATE 语义)。
- 接线:`transformContext` 触发(阈值不满足先尝试 Phase A 的 `snip()`);`shouldStopAfterTurn` 配合收敛。

**验收**

- 两小时级别会话不爆,压缩后能继续 edit/bash(用 pty + 真模型跑长任务验证);
- 摘要里出现精确文件路径与待办,保尾原文逐字节不变;
- 第二次压缩合并而非叠加(上下文里只有一份摘要)。

### Phase C:热/冷分离提醒管道(半天)

**做什么**

- 提醒栈:3 类起步——token 压力(60%/85% 升档)、压缩后提示(上下文已压缩,可回头查 `[已归档]`)、进行中状态(简单的"当前任务第 N 步"计数器,对应 CC 的 plan 提醒);
- `convertToLlm` 里把提醒栈拼成 `<system-reminder>…</system-reminder>` 文本,折叠到每次请求**末尾**(不碰系统提示词,保住缓存前缀);
- token 压力提醒:升级式文本("上下文已到 85%,请缩短输出、优先保留结论")对应 CC 的预算反压。

**验收**

- 抓取发给 provider 的原始 payload(用 `onPayload` 钩子),确认 `<system-reminder>` 在尾部、系统提示词逐字节未变;
- long-run 时模型确实变短(输出 token 下降)。

### Phase D:T5 应急重试(半天)

**做什么**

- `agent.prompt()` 结束后检查 `agent.state.errorMessage`,匹配 context-length / 413 类错误;命中 → 走 Phase B 压缩 → 重试一次;第二次仍失败则如实报错(复用 CC 的 one-attempt guard 语义)。

**验收**

- 人为塞入超大工具输出触发超限,观察自动压缩恢复而非会话死亡;
- 只重试一次,不无限循环。

### Phase E:tokenSaverOutput(半天)

**做什么**

- `afterToolCall` 对 bash 结果:输出超过阈值时,`content` 换成截断版本 + `[output truncated: N chars, use bash 重定向查看]` 说明,全量放 `details`;
- 对应 CC 的"全量 UI、压缩给模型"。

**验收**

- UI(streamer)显示全量输出,模型侧 payload 里是截断版。

---

## 4. 明确不做(范围外)

- **plan mode / IDE 提醒**:pi 无 plan mode,demo 无 IDE 集成——提醒栈只做 token 压力/压缩提示/步骤计数;
- **显式 cache_editing 打点**:DeepSeek 无此 API,前缀缓存是自动的,靠"提醒放尾部"的纪律维持;
- **fork 子代理做摘要**:CC 用 fork 复用父代理的缓存前缀;demo 的摘要请求系统提示词不同,本来就没有共享前缀,直接 `streamSimple` 一次请求即可;
- **会话记忆持久化**:那是 Phase 5 持久化的另一条线,不混在压缩里。

---

## 5. 风险与已有保障

| 风险 | 保障 |
|---|---|
| 摘要质量差导致后续改错文件 | 结构化摘要格式 + 明确要求保留路径/函数名/错误原文 + 保尾原文不压 |
| 压缩递归(摘要再触发压缩) | 摘要请求走 `streamSimple` 不进 Agent loop,`transformContext` 天然不触发 |
| 压缩太频繁 / 花太多 token | 免费档(Phase A)优先;阈值用 `reserveTokens = 16384` 余量;可加"距上次压缩至少 N 轮"冷却 |
| 切点切断工具轮次 | 切点必须落在 user 消息边界 |
| 413 窗口期模型失忆 | Phase D 的应急摘要也走同一结构化格式,文档记录为一次性降级 |

---

## 6. 依赖与顺序

```
Phase A(免费归档+convertToLlm) → Phase B(T4 摘要适配器,核心) → Phase C(提醒管道)
→ Phase D(413 应急) → Phase E(tokenSaver)
```

依赖关系:A 是 B 的前置(自定义 `convertToLlm` 是压缩摘要消息进上下文的前提);C 依赖 B 的 token 估算;D 依赖 B;E 独立可并行。
优先级顺序不变:`core-next-steps.md` 的优先级三(压缩)由本计划覆盖;读写契约(优先级二)已完成,不依赖本计划。

## 7. 验收总纲(每阶段跑一遍)

1. pty + 真模型,人工构造超长会话(或临时调低 reserveTokens 加速触发);
2. 观察:token 曲线(最后一条 assistant 的 usage)、触发次数、模型可见消息结构;
3. 压缩后继续给 edit/bash 任务,确认还能精确干活;
4. 全程无未捕获异常、无递归、会话不爆。