// Scripted Pi provider for deterministic CLI/RPC tests

import type {
	AssistantMessage,
	AssistantMessageEventStream,
	JsonObject,
	Model,
	SimpleStreamOptions,
	ToolCall,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ScriptStep = {
	text?: string;
	toolCalls?: Array<{
		name: string;
		arguments?: JsonObject;
		id?: string;
	}>;
};

const PROVIDER = "sandburg-test";
const API = "sandburg-scripted-api";
const MODEL = "scripted";
const DEFAULT_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function readScript(): ScriptStep[] {
	const rawScript = process.env.SANDBURG_TEST_PROVIDER_SCRIPT;
	if (!rawScript) throw new Error("SANDBURG_TEST_PROVIDER_SCRIPT is not set");

	const script = JSON.parse(rawScript) as ScriptStep[];
	if (!Array.isArray(script)) throw new Error("SANDBURG_TEST_PROVIDER_SCRIPT must be a JSON array");
	return script;
}

function toAssistantMessage(step: ScriptStep, model: Model<string>, responseIndex: number): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (step.text !== undefined) content.push({ type: "text", text: step.text });
	for (const [toolIndex, toolCall] of (step.toolCalls ?? []).entries()) {
		content.push({
			type: "toolCall",
			id: toolCall.id ?? `scripted-tool-${responseIndex}-${toolIndex}`,
			name: toolCall.name,
			arguments: toolCall.arguments ?? {},
		});
	}

	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: DEFAULT_USAGE,
		stopReason: step.toolCalls?.length ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

async function pushMessage(
	stream: AssistantMessageEventStream,
	message: AssistantMessage,
): Promise<void> {
	const partial: AssistantMessage = { ...message, content: [] };
	stream.push({ type: "start", partial });

	for (const [contentIndex, block] of message.content.entries()) {
		if (block.type === "text") {
			partial.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex, partial });
			partial.content[contentIndex] = block;
			stream.push({ type: "text_delta", contentIndex, delta: block.text, partial });
			stream.push({ type: "text_end", contentIndex, content: block.text, partial });
			continue;
		}

		const toolCall = block as ToolCall;
		partial.content.push({ type: "toolCall", id: toolCall.id, name: toolCall.name, arguments: {} });
		stream.push({ type: "toolcall_start", contentIndex, partial });
		const delta = JSON.stringify(toolCall.arguments);
		stream.push({ type: "toolcall_delta", contentIndex, delta, partial });
		partial.content[contentIndex] = toolCall;
		stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
	}

	stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
	stream.end(message);
}

export default function (pi: ExtensionAPI) {
	const script = readScript();
	let responseIndex = 0;

	pi.registerProvider(PROVIDER, {
		name: "Sandburg Scripted Test Provider",
		baseUrl: "http://localhost:0",
		apiKey: "SANDBURG_TEST_PROVIDER_API_KEY",
		api: API,
		models: [
			{
				id: MODEL,
				name: "Sandburg Scripted Test Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
		streamSimple: (model: Model<string>, _context, options?: SimpleStreamOptions) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				try {
					await options?.onResponse?.({ status: 200, headers: {} }, model);
					const step = script[responseIndex++];
					if (!step) throw new Error("No more scripted provider responses");
					await pushMessage(stream, toAssistantMessage(step, model, responseIndex - 1));
				} catch (error) {
					const message: AssistantMessage = {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: DEFAULT_USAGE,
						stopReason: "error",
						errorMessage: error instanceof Error ? error.message : String(error),
						timestamp: Date.now(),
					};
					stream.push({ type: "error", reason: "error", error: message });
					stream.end(message);
				}
			});
			return stream;
		},
	});
}
