/**
 * Same demo coding agent, but backed by a real provider.
 *
 * Only the provider registration differs from `index.ts`: everything above
 * `Models` (the agent loop, tools, events, safety gate) is provider-agnostic.
 *
 * The DeepSeek provider is registered by importing the factory from
 * `@earendil-works/pi-ai/providers/*` and calling it. Auth resolves
 * automatically from `DEEPSEEK_API_KEY` (or another configured source).
 *
 * Run with: `DEEPSEEK_API_KEY=sk-... npm run demo:real`
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, type UserMessage } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { buildSystemPrompt } from "./prompt.ts";
import { bashTool, readFileTool, writeFileTool } from "./tools.ts";

// 从本包目录的 `.env` 读取环境变量(pi 本身不自动加载 .env)。
// 不覆盖已在环境里设置的值。
const demoDir = dirname(fileURLToPath(import.meta.url));
const dotenvPath = join(demoDir, "..", ".env");
try {
	for (const line of readFileSync(dotenvPath, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
		if (key && process.env[key] === undefined) process.env[key] = value;
	}
} catch {
	// .env 不存在时忽略(直接依赖真实环境变量)。
}

// 订阅 agent 事件,把思考/回复/工具执行等输出到 stdout
function streamer(agent: Agent): void {
	agent.subscribe((event) => {
		switch (event.type) {
			case "message_update":
				if (event.assistantMessageEvent.type === "thinking_delta") {
					process.stdout.write(`\x1b[90m${event.assistantMessageEvent.delta}\x1b[0m`);
				} else if (event.assistantMessageEvent.type === "text_delta") {
					process.stdout.write(event.assistantMessageEvent.delta);
				}
				break;
			case "tool_execution_start":
				console.log(`\n\x1b[36m[tool] ${event.toolName}(${JSON.stringify(event.args)})\x1b[0m`);
				break;
			case "tool_execution_end":
				console.log(`\x1b[36m[tool] ${event.toolName} ${event.isError ? "failed" : "ok"}\x1b[0m`);
				break;
			default:
				break;
		}
	});
}

async function main(): Promise<void> {
	console.log("[1] Register a real provider (DeepSeek)");
	const models = createModels();
	models.setProvider(deepseekProvider());

	const model = models.getModels("deepseek")[0];
	if (!model) {
		throw new Error(
			"No DeepSeek model found. Is @earendil-works/pi-ai/providers/deepseek importable? Set DEEPSEEK_API_KEY to authenticate.",
		);
	}
	console.log(`    model: ${model.id} (provider "${model.provider}")\n`);

	const tools = [readFileTool, writeFileTool, bashTool];
	console.log("[2] Create the Agent");
	const agent = new Agent({
		streamFn: models.streamSimple.bind(models),
		initialState: {
			systemPrompt: buildSystemPrompt(process.cwd(), tools),
			model,
			thinkingLevel: "off",
			tools,
		},
		beforeToolCall: async ({ toolCall }) => {
			const command = String(toolCall.arguments.command ?? "");
			if (toolCall.name === "bash" && /\brm\s+-rf\b|mkfs|> \/dev\/sd/i.test(command)) {
				return { block: true, reason: `blocked by demo safety gate: "${command}"` };
			}
			return undefined;
		},
	});
	streamer(agent);

	await chatLoop(agent);
}

// 交互式聊天循环:逐行读取用户输入,多轮对话状态累积在 agent.state.messages 中。
// 输入 exit / quit 或按 Ctrl+D 退出。
async function chatLoop(agent: Agent): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		console.log(
			"\n交互模式:输入提示词后回车,agent 会回复(支持多轮);输入 exit 或按 Ctrl+D 退出\n",
		);
		for (;;) {
			const line = await askLine(rl);
			if (line === null) break; // Ctrl+D
			const text = line.trim();
			if (!text) continue;
			if (/^(exit|quit|\/exit|\/quit)$/i.test(text)) break;
			console.log(`\n\x1b[1m>>> ${text}\x1b[0m`);
			rl.pause(); // agent 回复期间暂停读取 stdin,避免输入串行
			try {
				await agent.prompt({
					role: "user",
					content: text,
					timestamp: Date.now(),
				} satisfies UserMessage);
			} finally {
				rl.resume();
			}
			const lastAssistant = [...agent.state.messages]
				.reverse()
				.find((message) => message.role === "assistant");
			if (lastAssistant?.role === "assistant" && lastAssistant.usage?.totalTokens !== undefined) {
				console.log(`\n\x1b[90m[本轮 tokens: ${lastAssistant.usage.totalTokens}]\x1b[0m`);
			}
		}
	} finally {
		rl.close();
	}
}

function askLine(rl: Interface, label = "you> "): Promise<string | null> {
	return new Promise((resolve) => {
		rl.question(label, (answer) => resolve(answer));
		rl.once("close", () => resolve(null)); // Ctrl+D
	});
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});