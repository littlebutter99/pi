import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

/**
 * 内置工具集,工具名对齐 coding-agent 的默认核心写作组:read / bash / edit / write。
 * 与系统提示词 `Available tools` 列表同名(故名取自 coding-agent 的 createCodingTools)。
 * 教学实现:各自只做最小但真实的事,不带图片处理/渲染器/复杂 diff。
 */

/** 统一的工具返回结构:文本内容 + 附加 details */
function result(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text", text }], details };
}

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

// 读取文件,把内容放进 transcript 供模型查看。
// 契约(与 coding-agent 对齐):
// - 越界 offset 抛错,不给空串——否则模型会把"读多了"误读成"文件是空的";
// - limit 截断时把剩余行数写进 content 文本(模型看得到的正文,不是 details),提示继续翻页。
export const readTool: AgentTool<typeof readSchema> = {
	name: "read",
	label: "read",
	description:
		"Read the contents of a file. Supports text files. For large files, use offset/limit to page through them.",
	parameters: readSchema,
	execute: async (_id, { path, offset, limit }) => {
		const content = await readFile(path, "utf-8");
		// 切片用原始 split(join 回来与文件逐字节一致);行数统计去掉
		// 末尾幻影空元素(文件以 \n 结尾时 split 会多出一个),否则 10 行
		// 文件会报 11 行、"N more lines" 也会多算一条。
		const allLines = content.split("\n");
		const totalLines = content.endsWith("\n") ? allLines.length - 1 : allLines.length;
		const start = offset ? Math.max(0, offset - 1) : 0;
		if (start >= totalLines) {
			throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
		}
		let text: string;
		if (limit !== undefined) {
			const end = Math.min(start + limit, totalLines);
			text = allLines.slice(start, end).join("\n");
			if (end < totalLines) {
				const nextOffset = end + 1;
				const remaining = totalLines - end;
				text += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
			}
		} else {
			text = allLines.slice(start).join("\n");
		}
		return result(text, { path, totalLines });
	},
};

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Full file content" }),
});

// 写入文件,自动创建父目录
export const writeTool: AgentTool<typeof writeSchema> = {
	name: "write",
	label: "write",
	description:
		"Create or overwrite a text file. Use for writing new files or replacing an entire file's contents in one go.",
	parameters: writeSchema,
	execute: async (_id, { path, content }) => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf-8");
		return result(`wrote ${path} (${content.length} chars)`, { path });
	},
};

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	oldText: Type.String({ description: "Exact text to replace. It must be unique in the file." }),
	newText: Type.String({ description: "Replacement text." }),
});

/**
 * 就地精确替换文件的某一段。oldText 必须唯一,否则拒绝(避免误改)。
 * 相比 coding-agent 的 edit 只保留了最小语义:单文件、单处、精确文本替换。
 */
export const editTool: AgentTool<typeof editSchema> = {
	name: "edit",
	label: "edit",
	description:
		"Edit a file by replacing one exact text fragment with another. oldText must appear exactly once in the file.",
	parameters: editSchema,
	execute: async (_id, { path, oldText, newText }) => {
		const content = await readFile(path, "utf-8");
		const firstIndex = content.indexOf(oldText);
		if (firstIndex === -1) {
			throw new Error(`oldText was not found in ${path}`);
		}
		const lastIndex = content.lastIndexOf(oldText);
		if (firstIndex !== lastIndex) {
			throw new Error(`oldText occurs more than once in ${path}; make it unique before editing`);
		}
		const updated = content.slice(0, firstIndex) + newText + content.slice(firstIndex + oldText.length);
		await writeFile(path, updated, "utf-8");
		return result(`edited ${path}: replaced ${oldText.length} chars`, { path });
	},
};

const bashSchema = Type.Object({
	command: Type.String({ description: "The shell command to run" }),
	cwd: Type.Optional(Type.String({ description: "Working directory, defaults to process cwd" })),
});

// bash 工具演示三个 AgentTool 特性:
// executionMode "sequential" 强制串行;onUpdate 流式输出部分结果;抛 Error 编码非零退出
export const bashTool: AgentTool<typeof bashSchema> = {
	name: "bash",
	label: "bash",
	description:
		"Run a bash command and return its standard output and standard error. Use for anything that needs the shell: git, npm, tests, listing files.",
	parameters: bashSchema,
	executionMode: "sequential",
	execute: async (_id, { command, cwd }, signal, onUpdate) => {
		const child = spawn(command, { shell: true, cwd: cwd ?? process.cwd() });
		const chunks: string[] = [];
		const emit = (text: string): void => {
			chunks.push(text);
			onUpdate?.({ content: [{ type: "text", text }], details: { command, exitCode: null } });
		};
		child.stdout?.on("data", (chunk: Buffer) => emit(chunk.toString()));
		child.stderr?.on("data", (chunk: Buffer) => emit(chunk.toString()));

		// 等待进程退出;响应 agent 中止信号
		const exitCode = await new Promise<number | null>((resolveExit) => {
			const abort = (): void => {
				child.kill("SIGTERM");
			};
			signal?.addEventListener("abort", abort, { once: true });
			child.on("close", (code) => {
				signal?.removeEventListener("abort", abort);
				resolveExit(code);
			});
		});

		const output = chunks.join("");
		if (exitCode !== 0) {
			throw new Error(`command exited with code ${exitCode}\n${output}`);
		}
		return result(output.trim() === "" ? "(no output)" : output, { command, exitCode });
	},
};

/** 默认写作组:与 coding-agent createCodingTools 同序 */
export const defaultTools: AgentTool<any>[] = [readTool, bashTool, editTool, writeTool];
