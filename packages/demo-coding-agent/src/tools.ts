import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

/** 统一的工具返回结构:文本内容 + 附加 details */
function result(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text", text }], details };
}

const readFileSchema = Type.Object({
	path: Type.String({ description: "Absolute or cwd-relative path of the file to read" }),
});

// 读取文件,把内容放进 transcript 供模型查看
export const readFileTool: AgentTool<typeof readFileSchema> = {
	name: "read_file",
	label: "Read File",
	description: "Read a text file and return its contents.",
	parameters: readFileSchema,
	execute: async (_id, { path }) => result(await readFile(path, "utf-8"), { path }),
};

const writeFileSchema = Type.Object({
	path: Type.String({ description: "Absolute or cwd-relative path of the file to write" }),
	content: Type.String({ description: "Full file content" }),
});

// 写入文件,自动创建父目录
export const writeFileTool: AgentTool<typeof writeFileSchema> = {
	name: "write_file",
	label: "Write File",
	description: "Create or overwrite a text file. Parent directories are created as needed.",
	parameters: writeFileSchema,
	execute: async (_id, { path, content }) => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf-8");
		return result(`wrote ${path} (${content.length} chars)`, { path });
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
	label: "Run Shell Command",
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