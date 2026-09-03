import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { USELESS_NOTICE } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { AssistantMessage, Model, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionMaintenance, type SessionMaintenanceHost } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const CONTEXT_WINDOW = 200_000;
const THRESHOLD = 140_000;
const LEAD = 17_500;
const SPECULATION_BAND_START = THRESHOLD - LEAD;

function userMessage(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantMessage(text: string, model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: 10_000,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10_100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function uselessGrepResult(text: string, toolCallId = "call-raw"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "grep",
		content: [{ type: "text", text }],
		isError: false,
		useless: true,
		timestamp: Date.now(),
	};
}


describe("hot handoff speculative lifecycle", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let authorModel: Model;
	let sessionManager: SessionManager;
	let maintenance: SessionMaintenance;
	let agent: Agent;
	let events: string[];
	let compactingSources: Array<string | undefined>;
	let notices: Array<{ level: string; message: string }>;

	function appendSummarizableConversation(): void {
		const text = "conversation ".repeat(8_000);
		sessionManager.appendMessage(userMessage(text));
		sessionManager.appendMessage(assistantMessage("response ".repeat(8_000), model));
		sessionManager.appendMessage(userMessage(text));
		sessionManager.appendMessage(assistantMessage("final response", model));
	}

	function createMaintenance(options: { minLead?: number; hotHandoff?: boolean } = {}): SessionMaintenance {
		agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.asyncEnabled": true,
			"compaction.methodOrder": ["soft"],
			"compaction.thresholdPercent": 70,
			"compaction.keepRecentTokens": 8_000,
			"compaction.autoContinue": false,
			"compaction.dropUseless": true,
			...(options.minLead !== undefined ? { "compaction.speculationMinLeadTokens": options.minLead } : {}),
		});
		const hotHandoff = options.hotHandoff !== false;
		const extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "session.compacting",
			emit: async (event: { type: string; source?: string; messages?: unknown[] }) => {
				if (event.type !== "session.compacting") return undefined;
				compactingSources.push(event.source);
				if (event.source === "auto") return undefined;
				if (!hotHandoff) return undefined;
				return {
					prompt: "independent handoff author",
					model: `${authorModel.provider}/${authorModel.id}`,
					failureNotice: "⚠ Hot Handoff failed — falling back to default compaction",
					preserveData: { hotHandoff: { version: 1, startedAt: new Date().toISOString() } },
				};
			},
		};
		const host = {
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner,
			sideStreamFn: async () => {
				throw new Error("The compact seam should be used instead of the side stream");
			},
			providerSessionState: new Map(),
			preferWebsockets: undefined,
			model: () => model,
			thinkingLevel: () => undefined,
			isDisposed: () => false,
			isStreaming: () => false,
			isGeneratingHandoff: () => false,
			promptGeneration: () => 0,
			sessionId: () => sessionManager.getSessionId(),
			messages: () => agent.state.messages,
			baseSystemPrompt: () => ["Test"],
			goalModeState: () => undefined,
			planReferencePath: () => "",
			nonMessageTokenSource: () => ({}),
			memoryBackendSession: () => undefined,
			emitSessionEvent: async (event: { type: string }) => {
				events.push(event.type);
			},
			emitNotice: (level: "info" | "warning" | "error", message: string) => {
				notices.push({ level, message });
			},
			schedulePostPromptTask: () => {},
			scheduleAgentContinue: () => {},
			scheduleCompactionContinuation: () => false,
			persistTurnMessagesForMidRunCompaction: async () => false,
			findLastAssistantMessage: () => undefined,
			disconnectFromAgent: () => {},
			reconnectToAgent: () => {},
			drainStrandedQueuedMessages: () => {},
			buildDisplaySessionContext: () => sessionManager.buildSessionContext(),
			convertToLlmForSideRequest: (messages: AgentMessage[]) => messages as never,
			obfuscateTextForProvider: (text: string | undefined) => text,
			obfuscatePreparationForProvider: <T>(preparation: T) => preparation,
			closeCodexProviderSessionsForHistoryRewrite: () => {},
			resetCodexProviderAfterCompaction: () => {},
			resetPlanReference: () => {},
			syncTodoPhasesFromBranch: () => {},
			resetAdvisorRuntimes: () => {},
			rebaseAfterCompaction: () => {},
			recordAnchoredHistoryRewrite: () => {},
			getContextBreakdown: () => undefined,
			getContextUsage: () => undefined,
			shake: async () => ({ modified: false, tokensRemoved: 0 }),
			dropImages: async () => ({ removed: 0 }),
			generateHandoffDocument: async () => undefined,
			removeAssistantMessageFromActiveContext: () => {},
			dropPersistedAssistantTurn: async () => undefined,
			runRecoveryCompactionWithRollback: async () => ({ deferredHandoff: false, continuationScheduled: false }),
			parseRetryAfterMsFromError: () => undefined,
			setModelTemporary: async () => {},
			abort: async () => {},
			abortHandoff: () => {},
		} as unknown as SessionMaintenanceHost;
		return new SessionMaintenance(host);
	}

	async function waitForState(state: "idle" | "running" | "armed"): Promise<void> {
		for (let microtask = 0; microtask < 200 && maintenance.speculationState !== state; microtask++) {
			await Promise.resolve();
		}
		if (maintenance.speculationState !== state) {
			throw new Error(`Speculation did not become ${state} (was ${maintenance.speculationState})`);
		}
	}

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		const author = getBundledModel("openai", "gpt-5");
		if (!bundled || !author) throw new Error("Expected built-in models");
		model = { ...bundled, contextWindow: CONTEXT_WINDOW };
		authorModel = author;
	});

	beforeEach(() => {
		sessionManager = SessionManager.inMemory();
		events = [];
		compactingSources = [];
		notices = [];
		appendSummarizableConversation();
		maintenance = createMaintenance();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
	});

	it("starts the independent author before threshold and commits without a second call", async () => {
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockImplementation(async (preparation, compactModel) => ({
				summary: "Handoff Document",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
				preserveData: { author: compactModel.id },
			}));

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START - 1, CONTEXT_WINDOW);
		expect(maintenance.speculationState).toBe("idle");
		expect(compactSpy).not.toHaveBeenCalled();

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		expect(maintenance.speculationState).toBe("running");
		await waitForState("armed");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy.mock.calls[0]![1].id).toBe(authorModel.id);
		expect(compactingSources).toEqual(["speculation"]);
		expect(sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(false);

		sessionManager.appendMessage(userMessage("raw continuation"));
		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("Handoff Document");
	});

	it("cuts at the speculation checkpoint, not keepRecentTokens, and derives firstKeptEntryId after it", async () => {
		const checkpointId = sessionManager.getBranch().at(-1)!.id;
		let semanticFirstKept: string | undefined;
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			semanticFirstKept = preparation.firstKeptEntryId;
			return {
				summary: "Handoff Document",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");
		expect(semanticFirstKept).toBe(checkpointId);
		expect(compactSpy.mock.calls[0]![0].recentMessages).toEqual([]);
		expect(compactSpy.mock.calls[0]![0].messagesToSummarize.length).toBeGreaterThan(0);

		sessionManager.appendMessage(userMessage("raw continuation"));
		sessionManager.appendMessage(assistantMessage("continued after checkpoint", model));
		const firstRawId = sessionManager.getBranch().find(entry => {
			if (entry.type !== "message") return false;
			return JSON.stringify(entry.message).includes("raw continuation");
		})?.id;
		expect(firstRawId).toBeDefined();
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START + 9_000, CONTEXT_WINDOW);
		expect(maintenance.speculationState).toBe("armed");
		expect(compactSpy).toHaveBeenCalledTimes(1);

		await maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: THRESHOLD + 9_000,
		});
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.firstKeptEntryId : undefined).toBe(firstRawId);
		expect(entry?.type === "compaction" ? entry.firstKeptEntryId : undefined).not.toBe(checkpointId);
		expect(agent.state.messages.some(message => JSON.stringify(message).includes("raw continuation"))).toBe(true);
	});

	it("waits leftover author time then recuts an oversized post-checkpoint burst", async () => {
		let authorCalls = 0;
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			authorCalls += 1;
			return {
				summary: authorCalls === 1 ? "Handoff Document early" : "Handoff Document recut",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");
		expect(compactSpy).toHaveBeenCalledTimes(1);

		sessionManager.appendMessage(userMessage("raw continuation ".repeat(2_000)));
		sessionManager.appendMessage(assistantMessage("continued after checkpoint", model));
		const recutLeafId = sessionManager.getBranch().at(-1)!.id;
		await maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: THRESHOLD + 9_000,
		});
		expect(compactSpy).toHaveBeenCalledTimes(2);
		expect(
			compactSpy.mock.calls[1]![0].messagesToSummarize.some(message =>
				JSON.stringify(message).includes("raw continuation"),
			),
		).toBe(true);
		expect(
			compactSpy.mock.calls[1]![0].messagesToSummarize.some(message =>
				JSON.stringify(message).includes("continued after checkpoint"),
			),
		).toBe(true);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("Handoff Document recut");
		expect(entry?.type === "compaction" ? entry.firstKeptEntryId : undefined).not.toBe(recutLeafId);
		expect(entry?.type === "compaction" ? entry.preserveData : undefined).toMatchObject({
			recutCycle: { recut: true, authorCalls: 2 },
		});
		expect(agent.state.messages.some(message => JSON.stringify(message).includes("raw continuation"))).toBe(true);
	});

	it("keeps the original armed result when the recut author fails", async () => {
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockImplementationOnce(async preparation => ({
				summary: "Handoff Document early",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			}))
			.mockRejectedValueOnce(new Error("recut author failed"));

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");
		sessionManager.appendMessage(userMessage("raw continuation ".repeat(2_000)));
		sessionManager.appendMessage(assistantMessage("continued after checkpoint", model));
		await maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: THRESHOLD + 9_000,
		});
		expect(compactSpy).toHaveBeenCalledTimes(2);
		expect(notices).toEqual([]);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("Handoff Document early");
		expect(agent.state.messages.some(message => JSON.stringify(message).includes("raw continuation"))).toBe(true);
	});


	it("does not recut a committed checkpoint-bound raw continuation until residual grows by the lead", async () => {
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "Handoff Document",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");
		sessionManager.appendMessage(userMessage("raw continuation"));
		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.preserveData : undefined).toMatchObject({
			hotHandoff: { version: 1 },
		});
		expect(maintenance.speculationState).toBe("idle");

		const residual =
			entry?.type === "compaction"
				? typeof entry.tokensAfter === "number"
					? entry.tokensAfter
					: entry.tokensBefore
				: 0;
		maintenance.maybeStartSpeculativeCompaction(Math.min(residual, THRESHOLD - 1), CONTEXT_WINDOW);
		expect(maintenance.speculationState).toBe("idle");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(maintenance.deferThresholdCompactionToSpeculation(residual, CONTEXT_WINDOW)).toBe(true);
		expect(maintenance.speculationState).toBe("idle");
		expect(compactSpy).toHaveBeenCalledTimes(1);
	});

	it("does not prune or shake the checkpoint-bound raw window after commit", async () => {
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "Handoff Document",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");
		sessionManager.appendMessage(userMessage("raw continuation"));
		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });

		const bulky = "match line\n".repeat(20_000);
		sessionManager.appendMessage(uselessGrepResult(bulky));
		await maintenance.checkCompaction(assistantMessage("continued after compact", model), true, false, false);

		const texts = sessionManager
			.getBranch()
			.filter(entry => entry.type === "message" && entry.message.role === "toolResult")
			.map(entry => JSON.stringify(entry.type === "message" ? entry.message : undefined));
		expect(texts.some(text => text.includes("match line"))).toBe(true);
		expect(
			texts.some(
				text => text.includes("[shaken") || text.includes("Output truncated") || text.includes(USELESS_NOTICE),
			),
		).toBe(false);
	});

	it("keeps stock prune when Hot Handoff is inactive", async () => {
		maintenance = createMaintenance({ hotHandoff: false });
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "stock summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");
		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });

		const bulky = "match line\n".repeat(20_000);
		sessionManager.appendMessage(uselessGrepResult(bulky));
		await maintenance.checkCompaction(assistantMessage("continued after compact", model), true, false, false);

		const texts = sessionManager
			.getBranch()
			.filter(entry => entry.type === "message" && entry.message.role === "toolResult")
			.map(entry => JSON.stringify(entry.type === "message" ? entry.message : undefined));
		expect(texts.some(text => text.includes(USELESS_NOTICE))).toBe(true);
	});


	it("does not wedge the session when the speculative author fails", async () => {
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockRejectedValueOnce(new Error("handoff author failed"))
			.mockImplementation(async preparation => ({
				summary: "stock fallback",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			}));

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("idle");
		expect(sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(false);
		expect(notices).toEqual([
			{ level: "warning", message: "⚠ Hot Handoff failed — falling back to default compaction" },
		]);

		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });
		expect(compactSpy).toHaveBeenCalledTimes(2);
		expect(compactSpy.mock.calls[1]![1].id).toBe(model.id);
		expect(notices).toHaveLength(1);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("stock fallback");
	});

	it("does not start a duplicate author when threshold arrives in flight", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			started.resolve();
			await release.promise;
			return {
				summary: "Handoff Document late",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await started.promise;
		expect(maintenance.speculationState).toBe("running");
		expect(maintenance.deferThresholdCompactionToSpeculation(THRESHOLD + 1_000, CONTEXT_WINDOW)).toBe(true);
		expect(compactSpy).toHaveBeenCalledTimes(1);

		release.resolve();
		await waitForState("armed");
		sessionManager.appendMessage(userMessage("raw continuation"));
		expect(maintenance.deferThresholdCompactionToSpeculation(THRESHOLD + 2_000, CONTEXT_WINDOW)).toBe(false);
		await maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: THRESHOLD + 2_000,
		});
		expect(compactSpy).toHaveBeenCalledTimes(1);
	});

	it("awaits leftover author time at threshold instead of aborting", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			started.resolve();
			await release.promise;
			return {
				summary: "Handoff Document leftover",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await started.promise;
		expect(maintenance.speculationState).toBe("running");

		const compacting = maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: THRESHOLD,
		});
		release.resolve();
		await compacting;
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("Handoff Document leftover");
	});


	it("uses the configured minimum speculation lead when larger than native", async () => {
		vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "unused",
			firstKeptEntryId: sessionManager.getBranch().at(-1)!.id,
			tokensBefore: 1,
			details: {},
		});
		maintenance = createMaintenance({ minLead: 30_000 });
		// Native lead is 17.5k; min lead 30k starts the band at threshold − 30k.
		maintenance.maybeStartSpeculativeCompaction(THRESHOLD - 30_000 - 1, CONTEXT_WINDOW);
		expect(maintenance.speculationState).toBe("idle");
		maintenance.maybeStartSpeculativeCompaction(THRESHOLD - 30_000, CONTEXT_WINDOW);
		expect(maintenance.speculationState).toBe("running");
	});
});
