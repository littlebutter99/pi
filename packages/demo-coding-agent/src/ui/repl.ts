import { createInterface, type Interface } from "node:readline";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";

function askLine(rl: Interface, label = "you> "): Promise<string | null> {
	return new Promise((resolve) => {
		rl.question(label, (answer) => resolve(answer));
		rl.once("close", () => resolve(null)); // Ctrl+D
	});
}

function printTurnTokens(agent: Agent): void {
	const lastAssistant = [...agent.state.messages].reverse().find((m) => m.role === "assistant");
	if (lastAssistant?.role === "assistant" && lastAssistant.usage?.totalTokens !== undefined) {
		console.log(`\n\x1b[90m[本轮 tokens: ${lastAssistant.usage.totalTokens}]\x1b[0m`);
	}
}

/**
 * 交互式聊天循环:逐行读取用户输入,多轮对话状态累积在 agent.state.messages 中。
 * 输入 exit / quit 或按 Ctrl+D 退出。
 */
export async function chatLoop(agent: Agent): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		console.log("\n交互模式:输入提示词后回车,agent 会回复(支持多轮);输入 exit 或按 Ctrl+D 退出\n");
		for (;;) {
			const line = await askLine(rl);
			if (line === null) break; // Ctrl+D
			const text = line.trim();
			if (!text) continue;
			if (/^(exit|quit|\/exit|\/quit)$/i.test(text)) break;
			console.log(`\n\x1b[1m>>> ${text}\x1b[0m`);
			rl.pause(); // agent 回复期间暂停读取 stdin,避免输入串行
			try {
				const message: UserMessage = { role: "user", content: text, timestamp: Date.now() };
				await agent.prompt(message);
			} finally {
				rl.resume();
			}
			printTurnTokens(agent);
		}
	} finally {
		rl.close();
	}
}
