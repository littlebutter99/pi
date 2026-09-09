import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * 按 coding-agent 系统提示词的「方面」顺序手工拼装。
 *
 * 每个方面对应一段独立文本,最终按以下顺序连接:
 *   1. 人格 / 角色定位
 *   2. Available tools(每个工具一行,来自 Agent 实际使用的 tools,自动同步)
 *   3. Guidelines(固定准则 + 预留的注入点)
 *   4. <project_context> 项目级规则(最近一份 AGENTS.md)
 *   5. skills <available_skills>:先不加,给 `<insertpoint>` 占位
 *   6. 尾部:Current working directory
 */

/** 固定准则(coding-agent 的 "always include" 部分,教学用常量) */
const GUIDELINES = [
	"Prefer tools over guessing: if the user asks about the workspace, inspect it first.",
	"Keep text responses short.",
	"Dangerous shell commands may be blocked by a safety gate. Treat a blocked command as an error and report it plainly.",
];

/** 人格/角色段(对应 coding-agent 无 custom system prompt 时的默认首段) */
const PERSONA = `You are a tiny coding agent running inside a demo harness. You help users by reading files, executing commands, and editing code.`;

/**
 * Available tools 段:每个工具一行 "- name: description"。
 * 与 Agent 实际注入的 tools 同源,工具增减会随 tools 参数自动反映。
 */
function toolsBlock(tools: AgentTool[]): string {
	const lines = tools.map((tool) => `- ${tool.name}: ${tool.description}`);
	return `Available tools:\n${lines.length > 0 ? lines.join("\n") : "(none)"}`;
}

/** Guidelines 段:固定准则,每行 "- xxx"。 */
function guidelinesBlock(): string {
	return `Guidelines:\n${GUIDELINES.map((line) => `- ${line}`).join("\n")}`;
}

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
 * <project_context> 段:把找到的那份 AGENTS.md 包装成 <project_instructions>。
 * 暂无 AGENTS.md 时返回空串,该段整体不出现。
 */
function projectContextBlock(cwd: string): string {
	const agentsFile = findAgentsFile(cwd);
	if (!agentsFile) return "";
	return `<project_context>

Project-specific instructions and guidelines:

<project_instructions path="${agentsFile.path}">
${agentsFile.content}
</project_instructions>

</project_context>`;
}

/**
 * Skills 段:先留空。
 *
 * 对应 coding-agent 里的 <available_skills> 块(每个 skill 渲染成
 * `<skill name= location=>`),等 demo 接入 skills 时再把生成器接到这里。
 */
function skillsBlock(): string {
	return "";
}

/**
 * 动态拼装系统提示词:按 coding-agent 的方面顺序连接各段,段间以空行分隔。
 *
 * skills 目前为空占位,先不发。整体结构已就绪,后续接入 skills 只需替换
 * skillsBlock() 的实现,不破坏其余段落顺序。
 */
export function buildSystemPrompt(cwd: string, tools: AgentTool[]): string {
	const sections = [PERSONA, toolsBlock(tools), guidelinesBlock(), projectContextBlock(cwd), skillsBlock()];
	const promptCwd = cwd.replace(/\\/g, "/");

	// 空段(如暂无 AGENTS.md、skills 未接入)不产生空行噪声
	const body = sections.filter((section) => section.length > 0).join("\n\n");
	return `${body}\n\nCurrent working directory: ${promptCwd}`;
}
