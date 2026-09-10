import { createInterface, type Interface } from "node:readline";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";

const EXIT_RE = /^(exit|quit|\/exit|\/quit)$/i;

/** 等一行;流关闭/EOF(Ctrl+D)时返回 null。 */
function askLine(rl: Interface, label = "you> "): Promise<string | null> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value: string | null): void => {
			if (settled) return;
			settled = true;
			rl.removeListener("close", onClose);
			resolve(value);
		};
		const onClose = () => done(null);
		rl.once("close", onClose);
		rl.question(label, (answer) => done(answer));
	});
}

/**
 * 交互式多轮聊天:逐行读取用户输入,多轮状态累积在 `agent.state.messages` 里。
 * 输入 exit / quit 或按 Ctrl+D 退出。
 */
export async function chatLoop(agent: Agent): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		console.log("\n交互模式:输入提示词后回车,agent 会回复(支持多轮);输入 exit / quit 或按 Ctrl+D 退出\n");
		for (;;) {
			const line = await askLine(rl);
			if (line === null) break; // Ctrl+D
			const text = line.trim();
			if (!text) continue;
			if (EXIT_RE.test(text)) break;
			console.log(`\n\x1b[1m>>> ${text}\x1b[0m`);
			rl.pause(); // agent 回复期间不读 stdin,避免下一行插进正在跑的这一轮
			try {
				const message: UserMessage = { role: "user", content: text, timestamp: Date.now() };
				await agent.prompt(message);
			} finally {
				rl.resume();
			}
		}
	} finally {
		rl.close();
	}
}
