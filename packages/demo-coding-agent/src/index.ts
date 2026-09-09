/**
 * The demo coding agent, driven by the `faux` provider.
 *
 * The faux provider is part of `@earendil-works/pi-ai`: it speaks the exact
 * same stream protocol as real providers, but every "LLM response" is a
 * scripted value. The agent loop cannot tell the difference, so this file
 * runs anywhere with zero API keys and zero network.
 *
 * What it demonstrates, and where the pieces live:
 *
 * | feature                           | pi-ai                          | pi-agent-core                |
 * |-----------------------------------|--------------------------------|------------------------------|
 * | provider + model catalog          | `createModels()` + `setProvider()` | Agent `initialState.model` |
 * | stream bridge to the LLM          | `models.streamSimple()`        | Agent `streamFn`             |
 * | tool definitions (TypeBox schema) |                                | `AgentTool` (`src/tools.ts`) |
 * | event-driven UI                   |                                | `Agent.subscribe()`          |
 * | safety gate before tool execution |                                | Agent `beforeToolCall`       |
 * | interrupting a running agent      |                                | `Agent.steer()`              |
 *
 * Run with: `npm run demo` (or `npx tsx src/index.ts` from this directory).
 */

import { Agent } from "@earendil-works/pi-agent-core";
import {
	type Context,
	contentText,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { bashTool, readFileTool, writeFileTool } from "./tools.ts";

/**
 * Scripted "LLM" for the demo. Any real provider would do the same three
 * things: look at the conversation so far, decide on a response, and either
 * answer or request tool calls.
 */
function scriptedAssistant(context: Context) {
	// 1) If the newest message is a tool result, "answer" using it. The loop
	// just appended it after executing the previous turn's tool calls.
	const last = context.messages[context.messages.length - 1];
	if (last?.role === "toolResult") {
		const text = contentText(last.content);
		return fauxAssistantMessage([
			fauxText("Here is what I found:\n\n"),
			fauxText(text.length > 0 ? text : "(empty result)"),
		]);
	}

	// 2) Otherwise decide from the newest user message.
	const user = [...context.messages].reverse().find((message) => message.role === "user");
	const userText = user === undefined ? "" : contentText(user.content).trim();

	if (/rm\s*-rf|delete.*dir|remove|danger/i.test(userText)) {
		// This call will be blocked by the `beforeToolCall` safety gate.
		return fauxAssistantMessage([
			fauxText("Deleting the current directory, as requested."),
			fauxToolCall("bash", { command: "rm -rf ." }),
		]);
	}

	if (/list|contents|what.*(here|file)|current dir/i.test(userText)) {
		// Ask for a tool call. The agent loop validates the call against the
		// tool schema, runs the real tool, and feeds the result back to us.
		return fauxAssistantMessage([
			fauxText("Let me inspect the workspace first."),
			fauxThinking("I should list the directory before answering."),
			fauxToolCall("bash", { command: "ls -la" }),
		]);
	}

	if (/steer|ping/i.test(userText)) {
		return fauxAssistantMessage(
			'Pong. The "Ping!" message was queued with agent.steer() while the run was already streaming, then injected before this turn.',
		);
	}

	if (/hello|hi|hey/i.test(userText)) {
		return fauxAssistantMessage(
			"Hello, I am a tiny coding agent built from two packages: @earendil-works/pi-ai (models, provider, stream protocol) and @earendil-works/pi-agent-core (agent loop, tools, events).",
		);
	}

	return fauxAssistantMessage(`I am a scripted demo agent. I received: "${userText}"`);
}

function streamer(agent: Agent): void {
	// The event stream is the only contract between the agent loop and any UI.
	agent.subscribe((event) => {
		switch (event.type) {
			case "agent_start":
				console.log("\n--- agent run started ---");
				break;
			case "message_update":
				if (event.assistantMessageEvent.type === "thinking_delta") {
					process.stdout.write(`\x1b[90m${event.assistantMessageEvent.delta}\x1b[0m`);
				} else if (event.assistantMessageEvent.type === "text_delta") {
					process.stdout.write(event.assistantMessageEvent.delta);
				}
				break;
			case "message_end":
				process.stdout.write("\n");
				break;
			case "tool_execution_start":
				console.log(`\x1b[36m[tool] ${event.toolName}(${JSON.stringify(event.args)})\x1b[0m`);
				break;
			case "tool_execution_end":
				console.log(
					event.isError
						? `\x1b[31m[tool] ${event.toolName} failed\x1b[0m: ${contentText(event.result.content)}`
						: `\x1b[32m[tool] ${event.toolName} ok\x1b[0m`,
				);
				break;
			case "agent_end":
				// `event.messages` is the transcript this run produced.
				console.log(`--- run done (${event.messages.length} new messages) ---\n`);
				break;
			default:
				break;
		}
	});
}

export async function runFauxDemo(): Promise<void> {
	console.log("[1] Build a Models collection and register the faux provider");
	const faux = fauxProvider({ tokensPerSecond: 60 });
	const models = createModels();
	models.setProvider(faux.provider);

	const model = faux.getModel();
	console.log(`    model: ${model.id} (provider "${model.provider}", api "${model.api}")\n`);

	console.log("[2] Create the Agent: state, stream bridge, tools, safety gate");
	const agent = new Agent({
		streamFn: models.streamSimple.bind(models),
		initialState: {
			systemPrompt: SYSTEM_PROMPT,
			model,
			thinkingLevel: "off",
			tools: [readFileTool, writeFileTool, bashTool],
		},
		// Guard runs before every tool call, after argument validation.
		beforeToolCall: async ({ toolCall }) => {
			const command = String(toolCall.arguments.command ?? "");
			if (toolCall.name === "bash" && /\brm\s+-rf\b|mkfs|> \/dev\/sd/i.test(command)) {
				return {
					block: true,
					reason: `blocked by demo safety gate: "${command}"`,
					// terminate: true makes the agent stop after this tool batch.
					terminate: true,
				};
			}
			return undefined;
		},
	});
	streamer(agent);

	console.log("[3] Turn 1: ask something that requires a tool");
	// Script responses ahead of time. The loop consumes one response per
	// LLM call: turn 1 issues the tool call, turn 2 answers with the result.
	faux.setResponses([scriptedAssistant, scriptedAssistant]);
	await agent.prompt("What is in the current directory?");
	console.log(`    transcript so far: ${agent.state.messages.map((m) => m.role).join(" -> ")}\n`);

	console.log("[4] Turn 2: ask something dangerous (exercises beforeToolCall)");
	faux.setResponses([scriptedAssistant]);
	await agent.prompt("The workspace looks cluttered. Delete everything in the current directory with rm -rf.");
	console.log(`    transcript so far: ${agent.state.messages.map((m) => m.role).join(" -> ")}\n`);

	console.log("[5] Turn 3: steer the agent while it is busy");
	faux.setResponses([scriptedAssistant, scriptedAssistant]);
	const running = agent.prompt("Say hello.");
	// Queued steering messages are injected before the next LLM call.
	setTimeout(() => {
		agent.steer({ role: "user", content: "Ping! Did you get that?", timestamp: Date.now() });
	}, 0);
	await running;
	console.log(`    transcript so far: ${agent.state.messages.map((m) => m.role).join(" -> ")}\n`);

	console.log("[6] Inspect what the run produced");
	const lastAssistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
	if (lastAssistant?.role === "assistant") {
		console.log(`    total tokens (faux estimate): ${lastAssistant.usage?.totalTokens}`);
	}
	console.log("demo complete");
}

runFauxDemo().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
