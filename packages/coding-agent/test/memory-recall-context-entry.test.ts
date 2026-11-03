/**
 * Recalled memories reach the model as a hidden context entry delivered with the
 * user's turn, never as part of the system prompt. The provider prefix cache is
 * keyed on the system prompt bytes, so a per-session recall that changes them
 * invalidates every cached prefix for the transcript.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import {
	type Api,
	type Context,
	clearCustomApis,
	type Model,
	type ModelSpec,
	registerCustomApi,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as memoryBackend from "@oh-my-pi/pi-coding-agent/memory-backend";
import { MEMORY_RECALL_CONTEXT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/memory-backend/recall-entry";
import type { MemoryBackend, MemoryPromptPreparation } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const RECALL_BLOCK = "<memories>\nThe deploy host is beta-9.\n</memories>";
const RECALL_DETAILS = { scope: "test-scope", memories: [{ id: "m1", text: "The deploy host is beta-9." }] };

const sessions: AgentSession[] = [];

/** The exact system-prompt bytes a provider request carries. */
function promptBytes(context: Context): string {
	const prompt = context.systemPrompt;
	return prompt === undefined ? "\u0000absent" : prompt.map(part => `${part.length}:${part}`).join("\u0000");
}

afterEach(() => {
	for (const session of sessions.splice(0)) void session.dispose();
	clearCustomApis();
	vi.restoreAllMocks();
});

function createModelRegistryStub(key = "key") {
	return {
		getApiKey: vi.fn(async () => key),
		resolver: vi.fn(() => async () => key),
		authStorage: { usage: { ingestHeaders: vi.fn() }, oauth: { identity: vi.fn() } },
		hasLazyRuntimeMetadata: vi.fn(() => false),
	};
}

function createModel(api: string): Model<Api> {
	return buildModel({
		id: `local-${api}`,
		name: "Local Model",
		api,
		provider: "ollama",
		baseUrl: "http://127.0.0.1:11434",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
}

function captureContexts(api: string): Context[] {
	const contexts: Context[] = [];
	registerCustomApi(api, (_model, context) => {
		contexts.push(context);
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			const message = createAssistantMessage("ok");
			stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	});
	return contexts;
}

async function runTurn(
	api: string,
	backend: MemoryBackend,
	prompts: readonly string[],
): Promise<{ contexts: Context[]; session: AgentSession }> {
	const contexts = captureContexts(api);
	vi.spyOn(memoryBackend, "resolveMemoryBackend").mockResolvedValue(backend);
	const session = new AgentSession({
		agent: new Agent({
			initialState: { model: createModel(api), systemPrompt: ["base"], messages: [], tools: [] },
			convertToLlm,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: createModelRegistryStub() as never,
	});
	sessions.push(session);
	for (const prompt of prompts) await session.sendUserMessage(prompt);
	return { contexts, session };
}

function recallBackend(preparation: MemoryPromptPreparation | undefined): MemoryBackend {
	let delivered = false;
	return {
		id: "hindsight",
		async start() {},
		async buildDeveloperInstructions() {
			return undefined;
		},
		async clear() {},
		async enqueue() {},
		async beforeAgentStartPrompt() {
			if (delivered) return undefined;
			return {
				...preparation,
				commit: () => {
					if (!preparation?.commit()) return false;
					delivered = true;
					return true;
				},
			};
		},
	};
}

function hiddenRecallPreparation(): MemoryPromptPreparation {
	return {
		contextEntry: {
			customType: MEMORY_RECALL_CONTEXT_MESSAGE_TYPE,
			content: RECALL_BLOCK,
			details: RECALL_DETAILS,
		},
		commit: () => true,
	};
}

const plainBackend: MemoryBackend = {
	id: "hindsight",
	async start() {},
	async buildDeveloperInstructions() {
		return undefined;
	},
	async clear() {},
	async enqueue() {},
};

describe("recall delivery", () => {
	it("delivers recalled memories as a hidden context entry, leaving the system prompt byte-identical", async () => {
		const withRecall = await runTurn("test-recall-entry-with", recallBackend(hiddenRecallPreparation()), ["hello"]);
		const withoutRecall = await runTurn("test-recall-entry-without", plainBackend, ["hello"]);

		const recalled = withRecall.contexts[0]!;
		const plain = withoutRecall.contexts[0]!;
		expect(promptBytes(recalled)).toBe(promptBytes(plain));
		expect(recalled.systemPrompt).not.toContain("beta-9");
		expect(JSON.stringify(recalled.messages)).toContain("beta-9");

		const entries = withRecall.session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === MEMORY_RECALL_CONTEXT_MESSAGE_TYPE);
		expect(entries).toMatchObject([
			{ content: RECALL_BLOCK, details: RECALL_DETAILS, display: false, attribution: "agent" },
		]);
	});

	it("never promotes the delivered recall back into the system prompt on a later turn", async () => {
		const { contexts, session } = await runTurn(
			"test-recall-entry-later-turn",
			recallBackend(hiddenRecallPreparation()),
			["hello", "again"],
		);

		expect(contexts).toHaveLength(2);
		expect(promptBytes(contexts[1]!)).toBe(promptBytes(contexts[0]!));
		expect(contexts[1]!.systemPrompt).not.toContain("beta-9");
		const entries = session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === MEMORY_RECALL_CONTEXT_MESSAGE_TYPE);
		expect(entries).toHaveLength(1);
	});
});
