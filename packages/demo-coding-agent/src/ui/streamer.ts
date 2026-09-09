import type { Agent } from "@earendil-works/pi-agent-core";

/**
 * 把某个 agent 的流式事件渲染到 stdout:思考/正文分区、工具调用。
 * 返回的 unsubscribe 可依 agent 生命周期撤销订阅。思考区开/关用闭包状态,不污染模块全局。
 */
export function attachStreamer(agent: Agent): () => void {
	let thinkingActive = false;
	return agent.subscribe((event) => {
		switch (event.type) {
			case "message_update": {
				const ev = event.assistantMessageEvent;
				if (ev.type === "thinking_start") {
					thinkingActive = true;
					process.stdout.write("\n\x1b[33m[思考]\x1b[0m ");
				} else if (ev.type === "thinking_delta") {
					// 思考过程用灰色,和正文区分开
					process.stdout.write(`\x1b[90m${ev.delta}\x1b[0m`);
				} else if (ev.type === "thinking_end") {
					process.stdout.write("\n");
				} else if (ev.type === "text_start") {
					if (thinkingActive) {
						process.stdout.write("\n\x1b[1m正文:\x1b[0m ");
						thinkingActive = false;
					}
				} else if (ev.type === "text_delta") {
					process.stdout.write(ev.delta);
				}
				break;
			}
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
