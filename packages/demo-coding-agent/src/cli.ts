/**
 * demo-coding-agent 入口 —— 薄装配层,只负责把各模块拼起来。
 *
 * 职责划分(P0 目录整理):
 *   - core/provider.ts        注册真实 provider(DeepSeek)、读 .env,返回 model/streamFn
 *   - core/agent-session.ts   组装 Agent:系统提示词 + 工具 + 模型/思考档 + bash 安全门
 *   - core/prompt.ts          系统提示词分节生成(含 AGENTS.md)
 *   - core/tools.ts           内置工具 read/bash/edit/write
 *   - ui/streamer.ts          把 agent 事件渲染到 stdout
 *   - ui/repl.ts              交互式聊天循环(输入/退出/tokens 统计)
 *
 * 想加新的 slash 命令或工具时,应改 ui/repl 或 core/tools,而不是在这份入口里堆代码。
 */

import { createAgent } from "./core/agent-session.ts";
import { loadDotenv, registerDeepSeek } from "./core/provider.ts";
import { chatLoop } from "./ui/repl.ts";
import { attachStreamer } from "./ui/streamer.ts";

async function main(): Promise<void> {
	loadDotenv();

	console.log("[1] Register a real provider (DeepSeek)");
	const provider = registerDeepSeek();
	console.log(`    model: ${provider.model.id} (provider "${provider.model.provider}")\n`);

	console.log("[2] Create the Agent");
	const agent = createAgent(provider);
	attachStreamer(agent);

	await chatLoop(agent);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
