import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

export interface FileDetails {
	path: string;
}

const readFileSchema = Type.Object({
	path: Type.String({ description: "Absolute or cwd-relative path of the file to read" }),
});

/**
 * Reads a file into the transcript so the model can see it.
 */
export const readFileTool: AgentTool<typeof readFileSchema, FileDetails> = {
	name: "read_file",
	label: "Read File",
	description: "Read a text file and return its contents.",
	parameters: readFileSchema,
	execute: async (_toolCallId, params) => {
		const content = await readFile(params.path, "utf-8");
		return {
			content: [{ type: "text", text: content }],
			details: { path: params.path },
		};
	},
};

const writeFileSchema = Type.Object({
	path: Type.String({ description: "Absolute or cwd-relative path of the file to write" }),
	content: Type.String({ description: "Full file content" }),
});

export const writeFileTool: AgentTool<typeof writeFileSchema, FileDetails> = {
	name: "write_file",
	label: "Write File",
	description: "Create or overwrite a text file. Parent directories are created as needed.",
	parameters: writeFileSchema,
	execute: async (_toolCallId, params) => {
		await mkdir(dirname(params.path), { recursive: true });
		await writeFile(params.path, params.content, "utf-8");
		return {
			content: [{ type: "text", text: `wrote ${params.path} (${params.content.length} chars)` }],
			details: { path: params.path },
		};
	},
};

const bashSchema = Type.Object({
	command: Type.String({ description: "The shell command to run" }),
	cwd: Type.Optional(Type.String({ description: "Working directory, defaults to process cwd" })),
});

export interface BashDetails {
	command: string;
	exitCode: number | null;
}

/**
 * A bash tool that demonstrates three AgentTool features:
 *
 * - `executionMode: "sequential"` forces this tool to run one at a time,
 *   even when the agent batches multiple tool calls in one turn.
 * - the `onUpdate` callback streams partial output while the command runs.
 * - throwing an Error encodes a failure (exit code != 0) as a tool error.
 */
export const bashTool: AgentTool<typeof bashSchema, BashDetails> = {
	name: "bash",
	label: "Run Shell Command",
	description:
		"Run a bash command and return its standard output and standard error. Use for anything that needs the shell: git, npm, tests, listing files.",
	parameters: bashSchema,
	executionMode: "sequential",
	execute: async (_toolCallId, params, signal, onUpdate) => {
		const child = spawn(params.command, {
			shell: true,
			cwd: params.cwd ?? process.cwd(),
		});

		const chunks: string[] = [];
		const emit = (text: string): void => {
			chunks.push(text);
			onUpdate?.({
				content: [{ type: "text", text }],
				details: { command: params.command, exitCode: null },
			});
		};
		child.stdout?.on("data", (chunk: Buffer) => emit(chunk.toString()));
		child.stderr?.on("data", (chunk: Buffer) => emit(chunk.toString()));

		const exitCode: number | null = await new Promise((resolveExit) => {
			const abort = (): void => {
				child.kill("SIGTERM");
			};
			// Tool execution can be aborted together with the agent run.
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
		return {
			content: [{ type: "text", text: output.trim() === "" ? "(no output)" : output }],
			details: { command: params.command, exitCode },
		};
	},
};
