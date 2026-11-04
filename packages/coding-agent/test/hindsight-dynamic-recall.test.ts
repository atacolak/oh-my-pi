/**
 * Recall lifecycle contracts.
 *
 * A first-turn recall is not a session-long freeze: compaction boundaries and a
 * genuine retitle ask a different question of the bank, and a resumed transcript
 * must recall against its own history instead of replaying a week-old block.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Settings as SettingsClass } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	HindsightApi,
	type MemoryItemInput,
	type RecallOptions,
	type RecallResponse,
	type RetainBatchOptions,
	type RetainOptions,
	type RetainResponse,
} from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { hindsightBackend } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import { extractMessages } from "@oh-my-pi/pi-coding-agent/hindsight/transcript";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function makeConfig(overrides: Partial<HindsightConfig> = {}): HindsightConfig {
	return {
		hindsightApiUrl: "http://localhost:8888",
		hindsightApiToken: null,
		bankId: "personal",
		bankIdPrefix: "",
		scopeTags: [],
		provenanceTags: [],
		globalScope: false,
		scoping: "per-project-tagged",
		bankMission: "",
		retainMission: null,
		autoRecall: true,
		autoRetain: false,
		retainMode: "full-session",
		retainEveryNTurns: 3,
		retainOverlapTurns: 2,
		retainContext: "omp",
		retainUpdateMode: "replace",
		retainStrategy: null,
		recallBudget: "mid",
		recallMaxTokens: 1024,
		recallTypes: [],
		recallContextTurns: 2,
		recallMaxQueryChars: 800,
		recallPromptPreamble: "preamble",
		recallPreferObservations: true,
		recallPrune: true,
		recallDedup: true,
		recallCadence: "boundary",
		decisionModelUrl: null,
		decisionModelApiKey: null,
		decisionModelThreshold: 0.25,
		debug: false,
		requestTimeoutMs: 30_000,
		reflectTimeoutMs: 30_000,
		recallTimeoutMs: 30_000,
		retainTimeoutMs: 30_000,
		mentalModelsEnabled: false,
		mentalModelAutoSeed: false,
		mentalModelMaxRenderChars: 16_000,
		...overrides,
	};
}

class RecordingApi extends HindsightApi {
	readonly recallCalls: { query: string; options?: RecallOptions }[] = [];
	readonly retainCalls: { content: string; metadata?: Record<string, string>; documentId?: string }[] = [];
	readonly batchCalls: MemoryItemInput[][] = [];
	recallResponse: RecallResponse = { results: [{ id: "m1", text: "deploy host is beta-9", type: "world" }] };

	constructor() {
		super({ baseUrl: "http://localhost" });
	}

	override async createBank(): Promise<Record<string, unknown>> {
		return {};
	}

	override async retain(_bankId: string, content: string, options?: RetainOptions): Promise<RetainResponse> {
		this.retainCalls.push({ content, metadata: options?.metadata, documentId: options?.documentId });
		return {};
	}

	override async retainBatch(
		_bankId: string,
		items: MemoryItemInput[],
		_options?: RetainBatchOptions,
	): Promise<RetainResponse> {
		this.batchCalls.push(items);
		return {};
	}

	override async recall(_bankId: string, query: string, options?: RecallOptions): Promise<RecallResponse> {
		this.recallCalls.push({ query, options });
		return this.recallResponse;
	}
}

interface Harness {
	state: HindsightSessionState;
	session: AgentSession & { emit(event: AgentSessionEvent): void };
	sessionManager: SessionManager;
	listeners: Set<(event: AgentSessionEvent) => void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		harness.state.dispose();
		await harness.sessionManager.close();
	}
});

function makeHarness(
	client: RecordingApi,
	options: {
		sessionManager?: SessionManager;
		config?: HindsightConfig;
		episodeIdFor?: (sessionId: string) => string | null;
		recallDelivered?: boolean;
	} = {},
): Harness {
	const sessionManager = options.sessionManager ?? SessionManager.inMemory();
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const holder: { current?: HindsightSessionState } = {};
	const settings: Settings = SettingsClass.isolated({ "memory.backend": "hindsight" });
	const session = {
		sessionId: sessionManager.getSessionId(),
		settings,
		sessionManager,
		emitNotice: () => {},
		refreshBaseSystemPrompt: async () => {},
		subscribe(listener: (event: AgentSessionEvent) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getHindsightSessionState: () => holder.current,
		getXdevToolEntries: () => [],
		emit(event: AgentSessionEvent) {
			for (const listener of listeners) listener(event);
		},
	};
	const state = new HindsightSessionState({
		sessionId: session.sessionId,
		client,
		bankId: "personal",
		config: options.config ?? makeConfig(),
		session: session as unknown as AgentSession,
		banksSet: new Set(["personal"]),
		recallDelivered: options.recallDelivered ?? false,
		episodeIdFor: options.episodeIdFor,
	});
	holder.current = state;
	const harness = { state, session: session as unknown as Harness["session"], sessionManager, listeners };
	harnesses.push(harness);
	return harness;
}

function appendTurn(sessionManager: SessionManager, user: string, assistant: string): void {
	sessionManager.appendMessage({ role: "user", content: user, timestamp: Date.now() });
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: assistant }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as never);
}

async function deliverRecall(harness: Harness, prompt: string): Promise<string | undefined> {
	const preparation = await harness.state.beforeAgentStartPrompt(prompt);
	if (!preparation) return undefined;
	expect(preparation.commit()).toBe(true);
	return preparation.contextEntry?.content;
}

describe("recall dedupe", () => {
	it("adds nothing when a refresh recalls only memories the transcript already holds", async () => {
		const client = new RecordingApi();
		const harness = makeHarness(client);
		harness.state.attachSessionListeners();

		expect(await deliverRecall(harness, "first question")).toContain("deploy host is beta-9");

		appendTurn(harness.sessionManager, "first question", "first answer");
		harness.session.emit({
			type: "auto_compaction_end",
			action: "context-full",
			result: { summary: "summary", firstKeptEntryId: "", tokensBefore: 10 },
			aborted: false,
			willRetry: false,
		});

		const preparation = await harness.state.beforeAgentStartPrompt("second question");
		expect(preparation).toBeDefined();
		expect(preparation!.contextEntry).toBeUndefined();
		expect(preparation!.commit()).toBe(true);
		expect(client.recallCalls).toHaveLength(2);
		expect([...harness.state.recalledMemoryIds]).toHaveLength(1);
		expect([...harness.state.recalledMemoryIds][0]).toStartWith("id:m1:");
		// An empty refresh must not overwrite the transcript's recall with nothing.
		expect(harness.sessionManager.getBranch().filter(entry => entry.type === "custom")).toHaveLength(1);
	});
});

describe("recall request settings", () => {
	it("forwards the observation preference and rerank switches to the bank", async () => {
		const client = new RecordingApi();
		const harness = makeHarness(client, {
			config: makeConfig({ recallPreferObservations: false, recallPrune: false, recallDedup: true }),
		});

		expect(await deliverRecall(harness, "first question")).toContain("beta-9");
		expect(client.recallCalls[0]!.options?.preferObservations).toBe(false);
		expect(client.recallCalls[0]!.options?.rerank).toEqual({ prune: false, dedup: true });
	});
});

describe("retitle refresh", () => {
	it("refreshes on a genuine retitle and ignores a repeated identical title", async () => {
		const client = new RecordingApi();
		const harness = makeHarness(client);
		harness.state.attachSessionListeners();
		await harness.sessionManager.setSessionName("deploy runbook", "auto");

		expect(await deliverRecall(harness, "first question")).toContain("beta-9");
		expect(client.recallCalls).toHaveLength(1);

		await harness.sessionManager.setSessionName("deploy runbook", "auto");
		expect(await harness.state.beforeAgentStartPrompt("second question")).toBeUndefined();
		expect(client.recallCalls).toHaveLength(1);

		client.recallResponse = { results: [{ id: "m2", text: "the runbook moved to ops/" }] };
		await harness.sessionManager.setSessionName("ops runbook", "auto");
		expect(await deliverRecall(harness, "third question")).toContain("the runbook moved to ops/");
		expect(client.recallCalls).toHaveLength(2);
	});
});

describe("developer instructions", () => {
	it("never carries the delivered recall into the system prompt", async () => {
		const client = new RecordingApi();
		const harness = makeHarness(client);
		expect(await deliverRecall(harness, "hello")).toContain("beta-9");

		const instructions = await hindsightBackend.buildDeveloperInstructions(
			"/tmp",
			"/tmp",
			harness.session.settings,
			harness.session,
		);
		expect(instructions ?? "").not.toContain("beta-9");
		expect(instructions ?? "").not.toContain("<memories>\npreamble");
	});
});

describe("episode resolver wire-up", () => {
	it("carries the episode id from the backend start options into stamped metadata", async () => {
		const sessionManager = SessionManager.inMemory();
		const holder: { current?: HindsightSessionState } = {};
		const settings = SettingsClass.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = {
			sessionId: sessionManager.getSessionId(),
			settings,
			sessionManager,
			emitNotice: () => {},
			refreshBaseSystemPrompt: async () => {},
			subscribe: () => () => {},
			getAgentProfileName: () => "builder",
			getXdevToolEntries: () => [],
			getHindsightSessionState: () => holder.current,
			setHindsightSessionState(state?: HindsightSessionState) {
				holder.current = state;
				return undefined;
			},
		};

		await hindsightBackend.start({
			session: session as unknown as AgentSession,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
			episodeIdFor: () => "ep-from-runtime",
		});

		expect(holder.current?.buildRetainMetadata("doc-1")).toEqual({
			session_id: sessionManager.getSessionId(),
			memory_document_id: "doc-1",
			episode_id: "ep-from-runtime",
		});
		holder.current?.dispose();
		await sessionManager.close();
	});
});

describe("retain provenance", () => {
	it("stamps the memory document and no episode when the episode substrate is absent", async () => {
		const client = new RecordingApi();
		const harness = makeHarness(client, {});
		await harness.state.retainSession([{ role: "user", content: "remember tabs" }], { forceReplace: true });

		expect(client.retainCalls).toHaveLength(1);
		expect(client.retainCalls[0]!.metadata).toEqual({
			session_id: harness.sessionManager.getSessionId(),
			memory_document_id: harness.sessionManager.getSessionId(),
		});
		expect(client.retainCalls[0]!.metadata).not.toHaveProperty("episode_id");
	});

	it("stamps the resolved episode id on transcript and tool retains once the substrate is composed", async () => {
		const client = new RecordingApi();
		const episodeIdFor = (sessionId: string) => `ep-${sessionId}`;
		const harness = makeHarness(client, { episodeIdFor });
		await harness.state.retainSession([{ role: "user", content: "remember tabs" }], { forceReplace: true });
		harness.state.enqueueRetain("operator uses tabs");
		await harness.state.flushRetainQueue();

		expect(client.retainCalls[0]!.metadata).toMatchObject({
			session_id: harness.sessionManager.getSessionId(),
			memory_document_id: harness.sessionManager.getSessionId(),
			episode_id: `ep-${harness.sessionManager.getSessionId()}`,
		});
		expect(client.batchCalls[0]![0]!.metadata).toMatchObject({
			session_id: harness.sessionManager.getSessionId(),
			episode_id: `ep-${harness.sessionManager.getSessionId()}`,
		});
	});

	it("omits the episode when the resolver has no episode for this session", async () => {
		const client = new RecordingApi();
		const harness = makeHarness(client, { episodeIdFor: () => null });
		await harness.state.retainSession([{ role: "user", content: "remember tabs" }], { forceReplace: true });

		expect(client.retainCalls[0]!.metadata).not.toHaveProperty("episode_id");
	});
});

describe("retain anti-feedback", () => {
	it("strips a recalled block from a tool-initiated retain so memory cannot feed on itself", async () => {
		const client = new RecordingApi();
		const harness = makeHarness(client, {});
		harness.state.enqueueRetain("<memories>\npreamble\n\n- deploy host is beta-9\n</memories>\noperator uses tabs");
		harness.state.enqueueRetain("<memories>\npreamble\n\n- only a recall block\n</memories>");
		await harness.state.flushRetainQueue();

		expect(client.batchCalls).toHaveLength(1);
		expect(client.batchCalls[0]).toHaveLength(1);
		expect(client.batchCalls[0]![0]!.content).toBe("operator uses tabs");
	});
});

describe("retain anti-feedback", () => {
	it("keeps a delivered recall out of the retained transcript", async () => {
		const client = new RecordingApi();
		const harness = makeHarness(client, {});
		const preparation = await harness.state.beforeAgentStartPrompt("hello");
		const entry = preparation!.contextEntry!;
		harness.sessionManager.appendCustomMessageEntry(entry.customType, entry.content, false, entry.details);
		expect(preparation!.commit()).toBe(true);
		appendTurn(harness.sessionManager, "hello", "the host is beta-9");

		await harness.state.retainSession(extractMessages(harness.sessionManager), { forceReplace: true });

		expect(client.retainCalls).toHaveLength(1);
		const retained = client.retainCalls[0]!.content;
		expect(retained).toContain("the host is beta-9");
		expect(retained).not.toContain("<memories>");
		expect(retained).not.toContain("preamble");
	});
});

describe("resumed transcripts", () => {
	it("recalls against the resumed history instead of replaying a frozen block", async () => {
		const client = new RecordingApi();
		const sessionManager = SessionManager.inMemory();
		const live = makeHarness(client, { sessionManager });
		live.state.attachSessionListeners();
		expect(await deliverRecall(live, "old question")).toContain("beta-9");
		expect(sessionManager.getBranch().some(entry => entry.type === "custom")).toBe(true);

		appendTurn(sessionManager, "first follow-up", "first follow-up answer");
		appendTurn(sessionManager, "second follow-up", "second follow-up answer");
		client.recallResponse = { results: [{ id: "m9", text: "new deployment fact" }] };

		const resumed = makeHarness(client, { sessionManager });
		resumed.state.attachSessionListeners();
		const block = await deliverRecall(resumed, "new question");

		expect(block).toContain("new deployment fact");
		expect(block).not.toContain("beta-9");
		expect(client.recallCalls).toHaveLength(2);
		expect(client.recallCalls[1]!.query).toContain("Prior context:");
		expect(client.recallCalls[1]!.query).toContain("second follow-up");
	});
});

describe("per-turn cadence", () => {
	it("asks the bank again each turn and delivers only memories the transcript lacks", async () => {
		const client = new RecordingApi();
		const harness = makeHarness(client, { config: makeConfig({ recallCadence: "per-turn" }) });

		expect(await deliverRecall(harness, "first question")).toContain("beta-9");
		client.recallResponse = {
			results: [
				{ id: "m1", text: "deploy host is beta-9", type: "world" },
				{ id: "m2", text: "deploy host moved to gamma-2", type: "world" },
			],
		};

		appendTurn(harness.sessionManager, "first question", "first answer");
		const block = await deliverRecall(harness, "second question about deploys");

		expect(client.recallCalls).toHaveLength(2);
		expect(block).toContain("gamma-2");
		expect(block).not.toContain("beta-9");
	});

	it("skips a trivial acknowledgement and asks again on a real question", async () => {
		const client = new RecordingApi();
		const harness = makeHarness(client, { config: makeConfig({ recallCadence: "per-turn" }) });

		expect(await deliverRecall(harness, "first question")).toContain("beta-9");
		appendTurn(harness.sessionManager, "first question", "first answer");

		expect(await deliverRecall(harness, "ok")).toBeUndefined();
		expect(await deliverRecall(harness, "continue please")).toBeUndefined();
		expect(client.recallCalls).toHaveLength(1);

		client.recallResponse = { results: [{ id: "m2", text: "deploy host moved to gamma-2", type: "world" }] };
		expect(await deliverRecall(harness, "where did the deploy host move?")).toContain("gamma-2");
		expect(client.recallCalls).toHaveLength(2);
	});
});

describe("recall refresh boundaries", () => {
	it("refreshes the recall at a committed compaction boundary with the new query shape", async () => {
		const client = new RecordingApi();
		const harness = makeHarness(client);
		harness.state.attachSessionListeners();

		expect(await deliverRecall(harness, "first question")).toContain("deploy host is beta-9");
		expect(client.recallCalls).toHaveLength(1);
		expect(client.recallCalls[0]!.query).not.toContain("Prior context:");

		appendTurn(harness.sessionManager, "first question", "first answer");
		appendTurn(harness.sessionManager, "second question", "second answer");
		client.recallResponse = { results: [{ id: "m2", text: "deploy host moved to gamma-2", type: "world" }] };
		harness.session.emit({
			type: "auto_compaction_end",
			action: "context-full",
			result: { summary: "summary", firstKeptEntryId: "", tokensBefore: 10 },
			aborted: false,
			willRetry: false,
		});

		expect(await deliverRecall(harness, "third question")).toContain("deploy host moved to gamma-2");
		expect(client.recallCalls).toHaveLength(2);
		expect(client.recallCalls[1]!.query).toContain("Prior context:");
		expect(client.recallCalls[1]!.query).toContain("second question");
	});
});
