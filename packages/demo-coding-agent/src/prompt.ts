import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/** 默认模板的固定指南(对应 coding-agent 的 promptGuidelines 常量部分) */
const GUIDELINES = [
	"Prefer tools over guessing: if the user asks about the workspace, inspect it first.",
	"Keep text responses short.",
	"Dangerous shell commands may be blocked by a safety gate. Treat a blocked command as an error and report it plainly.",
];

/** 从 cwd 向上逐级查找最近的 AGENTS.md,只取一份 */
function findAgentsFile(cwd: string): { path: string; content: string } | undefined {
	let dir = cwd;
	for (;;) {
		const candidate = join(dir, "AGENTS.md");
		try {
			return { path: candidate, content: readFileSync(candidate, "utf8") };
		} catch {
			const parent = dirname(dir);
			if (parent === dir) return undefined; // 已到文件系统根
			dir = parent;
		}
	}
}

/**
 * 动态拼装系统提示词:默认模板 + 工具片段列表 + 根目录 AGENTS.md。
 * 工具列表与 Agent 实际使用的 tools 同源,自动同步。
 */
export function buildSystemPrompt(cwd: string, tools: AgentTool[]): string {
	const toolsList = tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
	const guidelines = GUIDELINES.map((line) => `- ${line}`).join("\n");

	let prompt = `You are a tiny coding agent running inside a demo harness. You help users by reading files, executing commands, and editing code.

Available tools:
${toolsList || "(none)"}

Guidelines:
${guidelines}
`;

	const agentsFile = findAgentsFile(cwd);
	if (agentsFile) {
		prompt += `
<project_context>

Project-specific instructions and guidelines:

<project_instructions path="${agentsFile.path}">
${agentsFile.content}
</project_instructions>

</project_context>
`;
	}

	prompt += `\nCurrent working directory: ${cwd.replace(/\\/g, "/")}`;
	return prompt;
}