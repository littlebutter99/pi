/**
 * Same demo coding agent, but backed by a real provider.
 *
 * Only the provider registration differs from `index.ts`: everything above
 * `Models` (the agent loop, tools, events, safety gate) is provider-agnostic.
 *
 * The Anthropic provider is registered by importing the factory from
 * `@earendil-works/pi-ai/providers/*` and calling it. Auth resolves
 * automatically from `ANTHROPIC_API_KEY` (or another configured source).
 *
 * Run with: `ANTHROPIC_API_KEY=sk-ant-... npm run demo:real`
 */

import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, type UserMessage } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { bashTool, readFileTool, writeFileTool } from "./tools.ts";

function streamer(agent: Agent): void {
	agent.subscribe((event) => {
		switch (event.type) {
			case "message_update":
				if (event.assistantMessageEvent.type === "thinking_delta") {
					process.stdout.write(`\x1b[90m${event.assistantMessageEvent.delta}\x1b[0m`);
				} else if (event.assistantMessageEvent.type === "text_delta") {
					process.stdout.write(event.assistantMessageEvent.delta);
				}
				break;
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

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

export async function runRealDemo(messages: string[]): Promise<void> {
	console.log("[1] Register a real provider (Anthropic)");
	const models = createModels();
	models.setProvider(anthropicProvider());

	const model = models.getModels("anthropic")[0];
	if (!model) {
		throw new Error(
			"No Anthropic model found. Is @earendil-works/pi-ai/providers/anthropic importable? Set ANTHROPIC_API_KEY to authenticate.",
		);
	}
	console.log(`    model: ${model.id} (provider "${model.provider}")\n`);

	console.log("[2] Create the Agent");
	const agent = new Agent({
		streamFn: models.streamSimple.bind(models),
		initialState: {
			systemPrompt: SYSTEM_PROMPT,
			model,
			thinkingLevel: "off",
			tools: [readFileTool, writeFileTool, bashTool],
		},
		beforeToolCall: async ({ toolCall }) => {
			const command = String(toolCall.arguments.command ?? "");
			if (toolCall.name === "bash" && /\brm\s+-rf\b|mkfs|> \/dev\/sd/i.test(command)) {
				return { block: true, reason: `blocked by demo safety gate: "${command}"` };
			}
			return undefined;
		},
	});
	streamer(agent);

	for (const message of messages) {
		console.log(`\n\x1b[1m>>> ${message}\x1b[0m`);
		await agent.prompt(userMessage(message));
	}

	const lastAssistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
	if (lastAssistant?.role === "assistant") {
		console.log(`\ntotal tokens: ${lastAssistant.usage?.totalTokens}`);
	}
}

const defaultMessage = "List the files in the current directory with your tools, then summarize what you found.";

const args = process.argv.slice(2);
runRealDemo(args.length > 0 ? args : [defaultMessage]).catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
