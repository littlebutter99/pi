import type { Agent } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";

const EXIT_RE = /^(exit|quit|\/exit|\/quit)$/i;

/**
 * 逐行读取 stdin。刻意不用 readline:
 *
 * - readline 用私有 signal watcher 接管 SIGINT,`process.on("SIGINT")` 永远不触发,
 *   且 `rl.pause()` 期间字节流被整个冻结,运行中无法收到任何按键;
 * - 裸 `process.stdin` 走 canonical 模式,回显、退格、行编辑全由终端驱动完成,
 *   SIGINT 是信号、不受 `pause()` 影响,`agent.abort()` 可以可靠触发。
 *
 * wait() 等一行(Ctrl+D/EOF 返回 null);wake() 供 Ctrl+C 空闲退出时主动结束等待;dispose() 撤销监听。
 */
function createLineReader() {
	let buffer = "";
	let eof = false;
	const lines: string[] = [];
	let resolveLine: ((line: string | null) => void) | null = null;

	const deliver = (line: string): void => {
		if (resolveLine) {
			const resolve = resolveLine;
			resolveLine = null;
			resolve(line);
		} else {
			lines.push(line); // 暂停期间输入的行先缓冲,resume 后 wait() 依次取
		}
	};

	const onData = (chunk: Buffer): void => {
		buffer += chunk.toString("utf8");
		for (;;) {
			const nl = buffer.indexOf("\n");
			if (nl === -1) break;
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			deliver(line.replace(/\r$/, ""));
		}
	};
	const onEnd = (): void => {
		eof = true;
		resolveLine?.(null);
		resolveLine = null;
	};
	process.stdin.on("data", onData);
	process.stdin.on("end", onEnd);

	return {
		wait(): Promise<string | null> {
			if (eof) return Promise.resolve(null);
			const buffered = lines.shift();
			if (buffered !== undefined) return Promise.resolve(buffered);
			return new Promise((resolve) => {
				resolveLine = resolve;
			});
		},
		wake(): void {
			resolveLine?.(null);
			resolveLine = null;
		},
		dispose(): void {
			process.stdin.removeListener("data", onData);
			process.stdin.removeListener("end", onEnd);
			process.stdin.pause(); // 否则 stdin 停留在 flowing 状态会挂住事件循环,进程退不出去
		},
	};
}

/**
 * 交互式多轮聊天:逐行读取用户输入,多轮状态累积在 `agent.state.messages` 里。
 * 输入 exit / quit 或按 Ctrl+D 退出;回复中按 Ctrl+C 中止当前轮,空闲按 Ctrl+C 退出。
 */
export async function chatLoop(agent: Agent): Promise<void> {
	const reader = createLineReader();
	let quitting = false;

	// Ctrl+C:回复中 `agent.abort()` 中止当前轮(工具子进程会收到 abort 信号被杀掉),空闲时退出。
	const onSigint = (): void => {
		if (agent.state.isStreaming) {
			agent.abort();
			console.log("\n\x1b[90m(Ctrl+C 已中止本轮回复)\x1b[0m");
		} else if (!quitting) {
			quitting = true;
			reader.wake();
		}
	};
	process.on("SIGINT", onSigint);

	try {
		console.log(
			"\n交互模式:输入提示词后回车,agent 会回复(支持多轮);回复中按 Ctrl+C 中止,输入 exit / quit 或按 Ctrl+D 退出\n",
		);
		for (;;) {
			if (quitting) break;
			process.stdout.write("you> ");
			const line = await reader.wait();
			if (line === null || quitting) break; // Ctrl+D / Ctrl+C(空闲)
			const text = line.trim();
			if (!text) continue;
			if (EXIT_RE.test(text)) break;
			console.log(`\n\x1b[1m>>> ${text}\x1b[0m`);
			process.stdin.pause(); // 回复期间不读 stdin,输入留在终端缓冲,下一轮再读(不做队列)
			try {
				const message: UserMessage = { role: "user", content: text, timestamp: Date.now() };
				await agent.prompt(message);
			} finally {
				process.stdin.resume();
			}
		}
	} finally {
		process.removeListener("SIGINT", onSigint);
		reader.dispose();
	}
}
