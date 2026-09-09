import { Agent } from "@earendil-works/pi-agent-core";
import { buildSystemPrompt } from "./prompt.ts";
import type { ProviderBundle } from "./provider.ts";
import { defaultTools } from "./tools.ts";

/**
 * 组装一个 Agent:系统提示词、工具、默认模型/思考档、以及 bash 安全门。
 * 工具与系统提示词取自 `core/tools` / `core/prompt`,provider 相关由 `registerDeepSeek()` 提供。
 * 一个 Agent 即「一个会话」的 agent 侧状态;展示/输入循环在 ui 层订阅它。
 */
export function createAgent(provider: ProviderBundle): Agent {
	const tools = defaultTools;
	return new Agent({
		streamFn: provider.streamFn,
		initialState: {
			systemPrompt: buildSystemPrompt(process.cwd(), tools),
			model: provider.model,
			// deepseek-v4-flash 的 thinkingLevelMap: low / high / max 可用,medium/minimal 为空。
			// 这里开深思考档;若担心思考量吞完 max_tokens 导致无正文,可加 thinkingBudgets。
			thinkingLevel: "high",
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
}
