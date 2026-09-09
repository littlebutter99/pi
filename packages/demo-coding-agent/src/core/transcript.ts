import type { Agent } from "@earendil-works/pi-agent-core";

/**
 * 消息类型收口:提供对 `AgentMessage[]` 的按角色查询,供上层(记账、持久化等)复用,
 * 避免各处手写脆弱的「倒序找最后一条 assistant」式遍历。
 */

/** 累加会话里所有助手消息各自的 usage.totalTokens(助手在想/回复/工具间多轮时都会带 usage)。 */
export function sumAssistantUsage(agent: Agent): number {
	let total = 0;
	for (const message of agent.state.messages) {
		if (message.role !== "assistant") continue;
		const used = message.usage?.totalTokens;
		if (typeof used === "number") total += used;
	}
	return total;
}
