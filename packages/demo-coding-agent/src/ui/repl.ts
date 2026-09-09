import { createInterface, type Interface } from "node:readline";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import { sumAssistantUsage } from "../core/transcript.ts";

const EXIT_RE = /^(exit|quit|\/exit|\/quit)$/i;

function makeUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function gray(line: string): void {
	console.log(`\x1b[90m${line}\x1b[0m`);
}

/** 无提示标签地等一行;流关闭/EOF 时返回 null。 */
function waitLine(rl: Interface): Promise<string | null> {
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
		rl.question("", (answer) => done(answer));
	});
}

/**
 * 交互式多轮聊天 (P1 目标)。
 *
 * - reader 持续读 stdin,agent 回复期间不再像旧版那样 `rl.pause()` 冻结输入。
 * - agent 空闲时回车的新行 → `agent.prompt()` 开一轮;
 * - agent 正在回复/执行工具时回车 → 注入 `agent.steer()`(仍在跑的一次 run 会在其后续
 *   轮询点接上该行,而不是被丢弃);
 * - 每轮用户段结束后,若还有残留在 steer/followUp 队列的输入,用 `agent.continue()` 在
 *   同一会话接续,直到 agent 真闲下来;
 * - 每段 token 用「段内助手消息累计 usage 的差值」统计,避免跨多个 assistant 轮次只取
 *   最后一条导致少算。
 */
export function chatLoop(agent: Agent): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let quitting = false;
	// 表示是否已在跑一次 prompt 段;避免两个紧跟的回车同时开两段。
	let busy = false;

	return new Promise<void>((resolve) => {
		rl.once("close", () => resolve());

		const close = (): void => {
			if (quitting) return;
			quitting = true;
			if (agent.state.isStreaming) agent.abort(); // 别让它留下半个 run
			rl.close();
		};

		console.log(
			"\n交互模式:输入提示词后回车,agent 会回复(支持多轮);输入 exit / quit 或按 Ctrl+D 退出.\n" +
				"agent 正在回复时继续输入,会作为跟进 (steer) 接在正在进行的回复后面.\n",
		);

		/** 一次「新提问 + 把后续跟进入队内容接完」的段。 */
		const send = async (text: string): Promise<void> => {
			if (quitting) return;
			busy = true;
			console.log(`\n\x1b[1m>>> ${text}\x1b[0m`);
			const startTokens = sumAssistantUsage(agent);
			try {
				await agent.prompt(makeUserMessage(text));
				// 跑完一轮后,把立刻排进 agent steer/followUp 的输入全接进同一会话。
				while (agent.hasQueuedMessages() && !quitting) {
					await agent.continue();
				}
			} finally {
				busy = false;
				const used = sumAssistantUsage(agent) - startTokens;
				if (used > 0 || agent.state.errorMessage) {
					gray(`[本轮 tokens: ${used}]`);
				}
				if (quitting) {
					rl.close();
				}
			}
		};

		const handle = (raw: string): void => {
			if (quitting) return;
			const text = raw.trim();
			if (!text) return;
			if (EXIT_RE.test(text)) {
				close();
				return;
			}
			if (agent.state.isStreaming || busy) {
				// 忙碌:作为跟进入队,不让输入丢。等本次 run 结束(或它仍会轮询时)接上。
				gray(`(agent 忙,作为跟进入队: ${text})`);
				agent.steer(makeUserMessage(text));
				return;
			}
			void send(text);
		};

		// reader:持续读行,不因 agent 忙而停;close 时上面的 Promise resolve。
		void (async () => {
			while (!quitting) {
				const line = await waitLine(rl);
				if (line === null) break; // Ctrl+D → readline 发 close
				handle(line);
			}
		})();
	});
}
