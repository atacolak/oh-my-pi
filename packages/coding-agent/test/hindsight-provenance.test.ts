import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	HindsightApi,
	type MemoryItemInput,
	type RecallOptions,
	type RecallResponse,
	type ReflectOptions,
	type ReflectResponse,
	type RetainBatchOptions,
	type RetainOptions,
	type RetainResponse,
} from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { hindsightBackend } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import { MemoryReflectTool } from "@oh-my-pi/pi-coding-agent/tools/memory-reflect";

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
		autoRetain: true,
		retainMode: "full-session",
		retainEveryNTurns: 3,
		retainOverlapTurns: 2,
		retainContext: "omp",
		retainUpdateMode: "replace",
		retainStrategy: null,
		recallBudget: "mid",
		recallMaxTokens: 1024,
		recallTypes: ["world", "experience"],
		recallContextTurns: 1,
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

interface RetainCall {
	bankId: string;
	tags?: string[];
	observationScopes?: RetainOptions["observationScopes"];
}

class RecordingApi extends HindsightApi {
	readonly retainCalls: RetainCall[] = [];
	readonly batchCalls: {
		bankId: string;
		tags?: string[];
		observationScopes?: MemoryItemInput["observationScopes"];
	}[] = [];
	readonly recallCalls: { bankId: string; query: string; options?: RecallOptions }[] = [];
	readonly reflectCalls: { bankId: string; query: string; options?: ReflectOptions }[] = [];
	recallResponse: RecallResponse = { results: [{ text: "shared fact", type: "world" }] };

	constructor() {
		super({ baseUrl: "http://localhost" });
	}

	override async createBank(): Promise<Record<string, unknown>> {
		return {};
	}

	override async retain(_bankId: string, _content: string, options?: RetainOptions): Promise<RetainResponse> {
		this.retainCalls.push({
			bankId: _bankId,
			tags: options?.tags,
			observationScopes: options?.observationScopes,
		});
		return {};
	}

	override async retainBatch(
		bankId: string,
		items: MemoryItemInput[],
		_options?: RetainBatchOptions,
	): Promise<RetainResponse> {
		const first = items[0];
		this.batchCalls.push({
			bankId,
			tags: first?.tags,
			observationScopes: first?.observationScopes,
		});
		return {};
	}

	override async recall(bankId: string, query: string, options?: RecallOptions): Promise<RecallResponse> {
		this.recallCalls.push({ bankId, query, options });
		return this.recallResponse;
	}

	override async reflect(bankId: string, query: string, options?: ReflectOptions): Promise<ReflectResponse> {
		this.reflectCalls.push({ bankId, query, options });
		return { text: "synthesized answer" };
	}
}

interface StateOptions {
	retainTags?: string[];
	recallTags?: string[];
	recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	observationScopes?: string[][];
	provenanceTags?: string[];
	config?: HindsightConfig;
	session?: object;
	aliasOf?: HindsightSessionState;
}

function makeState(client: HindsightApi, options: StateOptions = {}): HindsightSessionState {
	const sessionId = options.aliasOf ? "child-session" : "parent-session";
	const holder: { current?: HindsightSessionState } = {};
	const session = (options.session ?? {
		sessionId,
		getHindsightSessionState: () => holder.current,
		emitNotice: () => {},
	}) as object as AgentSession;
	const state = new HindsightSessionState({
		sessionId,
		client,
		bankId: "personal",
		retainTags: options.retainTags,
		recallTags: options.recallTags,
		recallTagsMatch: options.recallTagsMatch,
		observationScopes: options.observationScopes,
		provenanceTags: options.provenanceTags,
		config: options.config ?? makeConfig(),
		session,
		banksSet: new Set(["personal"]),
		aliasOf: options.aliasOf,
	});
	holder.current = state;
	return state;
}

function makeToolSession(state: HindsightSessionState): ToolSession {
	const settings = Settings.isolated({
		"memory.backend": "hindsight",
		"hindsight.apiUrl": "http://localhost:8888",
	});
	return {
		settings,
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => state.sessionId,
		getSessionSpawns: () => null,
		getHindsightSessionState: () => state,
	} as unknown as ToolSession;
}

describe("provenance is write-only", () => {
	it("retain attaches provenance tags while observation scopes stay scope-only", async () => {
		const client = new RecordingApi();
		const state = makeState(client, {
			retainTags: ["scope:coding", "project:omp"],
			recallTags: ["scope:coding", "project:omp"],
			recallTagsMatch: "all_strict",
			observationScopes: [["scope:coding", "project:omp"]],
			provenanceTags: ["role:builder", "actor:HindsightProvenance"],
		});

		await state.retainSession([{ role: "user", content: "remember the tag split" }], { forceReplace: true });

		expect(client.retainCalls).toHaveLength(1);
		expect(client.retainCalls[0]?.tags).toEqual([
			"scope:coding",
			"project:omp",
			"role:builder",
			"actor:HindsightProvenance",
		]);
		expect(client.retainCalls[0]?.observationScopes).toEqual([["scope:coding", "project:omp"]]);
	});

	it("tool-initiated retains attach provenance through the retain queue", async () => {
		const client = new RecordingApi();
		const state = makeState(client, {
			retainTags: ["scope:coding"],
			recallTags: ["scope:coding"],
			recallTagsMatch: "all_strict",
			observationScopes: [["scope:coding"]],
			provenanceTags: ["role:builder"],
		});

		state.enqueueRetain("operator prefers tabs");
		await state.flushRetainQueue();

		expect(client.batchCalls).toHaveLength(1);
		expect(client.batchCalls[0]?.tags).toEqual(["scope:coding", "role:builder"]);
		expect(client.batchCalls[0]?.observationScopes).toEqual([["scope:coding"]]);
	});

	it("recall is unaffected: identical request filters and results with or without provenance", async () => {
		const plainClient = new RecordingApi();
		const stampedClient = new RecordingApi();
		const base = {
			retainTags: ["scope:coding"],
			recallTags: ["scope:coding"],
			recallTagsMatch: "all_strict" as const,
			observationScopes: [["scope:coding"]],
		};
		const plain = makeState(plainClient, base);
		const stamped = makeState(stampedClient, {
			...base,
			provenanceTags: ["role:builder", "actor:HindsightProvenance"],
		});
		expect(stamped.provenanceTags).toEqual(["role:builder", "actor:HindsightProvenance"]);

		const plainOutcome = await plain.recallForContext("same query");
		const stampedOutcome = await stamped.recallForContext("same query");

		expect(stampedClient.recallCalls[0]?.options?.tags).toEqual(["scope:coding"]);
		expect(stampedClient.recallCalls[0]?.options?.tagsMatch).toBe("all_strict");
		expect(stampedClient.recallCalls[0]?.options?.tags).toEqual(plainClient.recallCalls[0]?.options?.tags);
		expect(stampedOutcome.context).toBe(plainOutcome.context);
		expect(stampedOutcome.context).toContain("shared fact");

		// The same session really stamps provenance on its writes; recall just never
		// sees it. Without this precondition the invariance assertion above is vacuous.
		stamped.enqueueRetain("shared fact");
		await stamped.flushRetainQueue();
		expect(stampedClient.batchCalls[0]?.tags).toContain("role:builder");
		expect(stampedClient.recallCalls[0]?.options?.tags).not.toContain("role:builder");
	});

	it("a subagent's explicit retain stamps its own role, not the parent's", async () => {
		const client = new RecordingApi();
		const parent = makeState(client, {
			retainTags: ["scope:coding"],
			recallTags: ["scope:coding"],
			recallTagsMatch: "all_strict",
			observationScopes: [["scope:coding"]],
			provenanceTags: ["role:builder"],
			config: makeConfig({ provenanceTags: ["team:infra"] }),
		});
		const child = makeState(client, {
			retainTags: parent.retainTags,
			recallTags: parent.recallTags,
			recallTagsMatch: parent.recallTagsMatch,
			observationScopes: parent.observationScopes,
			provenanceTags: ["team:infra", "role:scout"],
			config: parent.config,
			aliasOf: parent,
		});

		child.enqueueRetain("subagent discovered a constraint");
		await child.flushRetainQueue();

		expect(client.batchCalls).toHaveLength(1);
		expect(client.batchCalls[0]?.tags).toEqual(["scope:coding", "team:infra", "role:scout"]);
		expect(client.batchCalls[0]?.tags).not.toContain("role:builder");
	});
});

describe("recall and reflect additive tag filters", () => {
	it("declares an optional tags array on both tool schemas", () => {
		const state = makeState(new RecordingApi());
		const recall = new MemoryRecallTool(makeToolSession(state));
		const reflect = new MemoryReflectTool(makeToolSession(state));
		expect(JSON.stringify(recall.parameters.toJsonSchema())).toContain('"tags"');
		expect(JSON.stringify(reflect.parameters.toJsonSchema())).toContain('"tags"');
	});

	it("recall leaves the session filter untouched when tags is omitted", async () => {
		const client = new RecordingApi();
		const state = makeState(client, {
			recallTags: ["scope:coding"],
			recallTagsMatch: "all_strict",
			provenanceTags: ["role:builder"],
		});
		const tool = new MemoryRecallTool(makeToolSession(state));

		await tool.execute("call-omit", { query: "tabs" });

		expect(client.recallCalls[0]?.options?.tags).toEqual(["scope:coding"]);
		expect(client.recallCalls[0]?.options?.tagsMatch).toBe("all_strict");
	});

	it("recall merges provided tags additively with the session filter", async () => {
		const client = new RecordingApi();
		const state = makeState(client, { recallTags: ["scope:coding"], recallTagsMatch: "all_strict" });
		const tool = new MemoryRecallTool(makeToolSession(state));

		await tool.execute("call-add", { query: "tabs", tags: ["actor:HindsightProvenance", "scope:coding"] });

		expect(client.recallCalls[0]?.options?.tags).toEqual(["scope:coding", "actor:HindsightProvenance"]);
	});

	it("reflect leaves the session filter untouched when tags is omitted", async () => {
		const client = new RecordingApi();
		const state = makeState(client, { recallTags: ["scope:coding"], recallTagsMatch: "all_strict" });
		const tool = new MemoryReflectTool(makeToolSession(state));

		await tool.execute("call-reflect-omit", { query: "what changed?" });

		expect(client.reflectCalls[0]?.options?.tags).toEqual(["scope:coding"]);
	});

	it("reflect merges provided tags additively with the session filter", async () => {
		const client = new RecordingApi();
		const state = makeState(client, { recallTags: ["scope:coding"], recallTagsMatch: "all_strict" });
		const tool = new MemoryReflectTool(makeToolSession(state));

		await tool.execute("call-reflect-add", { query: "what changed?", tags: ["role:builder"] });

		expect(client.reflectCalls[0]?.options?.tags).toEqual(["scope:coding", "role:builder"]);
	});
});

function captureFetchBodies(): unknown[] {
	const bodies: unknown[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				bodies.push(JSON.parse(String(init?.body ?? "{}")));
				return new Response("{}", { status: 200 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		),
	);
	return bodies;
}

function retainItem(bodies: unknown[]): { tags?: string[]; observation_scopes?: unknown } {
	for (const body of bodies) {
		if (typeof body !== "object" || body === null || !("items" in body)) continue;
		const items = body.items;
		if (!Array.isArray(items) || items.length === 0) continue;
		const first: unknown = items[0];
		if (typeof first !== "object" || first === null) continue;
		return first as { tags?: string[]; observation_scopes?: unknown };
	}
	throw new Error("no retain body captured");
}

interface FakeSession {
	session: AgentSession;
	installed: () => HindsightSessionState | undefined;
}

function fakeAgentSession(options: { sessionId: string; profile?: string; settings: Settings }): FakeSession {
	let state: HindsightSessionState | undefined;
	const sessionManager = {
		getCwd: () => "/work/omp",
		getSessionId: () => options.sessionId,
		getEntries: () => [],
	};
	const session = {
		sessionId: options.sessionId,
		settings: options.settings,
		sessionManager,
		getHindsightSessionState: () => state,
		setHindsightSessionState: (next: HindsightSessionState | undefined) => {
			const previous = state;
			state = next;
			return previous;
		},
		getAgentProfileName: () => options.profile,
		subscribe: () => () => {},
		emitNotice: () => {},
		refreshBaseSystemPrompt: async () => {},
	} as object as AgentSession;
	return { session, installed: () => state };
}

const provenanceSettings = () =>
	Settings.isolated({
		"memory.backend": "hindsight",
		"hindsight.apiUrl": "http://localhost:8888",
		"hindsight.bankId": "personal",
		"hindsight.scoping": "per-project-tagged",
		"hindsight.scopeTags": ["scope:coding"],
		"hindsight.provenanceTags": ["team:infra"],
		"hindsight.mentalModelsEnabled": false,
	});

describe("backend provenance wiring", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("stamps configured provenance plus the mounted agent profile role on the primary state", async () => {
		const bodies = captureFetchBodies();
		const settings = provenanceSettings();
		const fake = fakeAgentSession({ sessionId: "parent-session", profile: "builder", settings });

		await hindsightBackend.start({
			session: fake.session,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		const state = fake.installed();
		expect(state?.resolvedTags).toEqual(["scope:coding", "project:omp"]);
		expect(state?.provenanceTags).toEqual(["team:infra", "role:builder"]);
		state!.enqueueRetain("the tag split is write-only");
		await state!.flushRetainQueue();

		const item = retainItem(bodies);
		expect(item.tags).toEqual(["scope:coding", "project:omp", "team:infra", "role:builder"]);
		expect(item.observation_scopes).toEqual([["scope:coding", "project:omp"]]);
	});

	it("a subagent aliases the parent scope but stamps its own role and runs no auto-retain", async () => {
		const bodies = captureFetchBodies();
		const settings = provenanceSettings();
		const parent = fakeAgentSession({ sessionId: "parent-session", profile: "builder", settings });
		await hindsightBackend.start({
			session: parent.session,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		const child = fakeAgentSession({ sessionId: "child-session", profile: "scout", settings });
		await hindsightBackend.start({
			session: child.session,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
			parentHindsightSessionState: parent.installed(),
		});

		const childState = child.installed();
		expect(childState?.provenanceTags).toEqual(["team:infra", "role:scout"]);
		// No session listeners means no automatic recall or cadence retain.
		expect(childState?.unsubscribe).toBeUndefined();

		childState!.enqueueRetain("subagent discovered a constraint");
		await childState!.flushRetainQueue();

		const item = retainItem(bodies);
		expect(item.tags).toEqual(["scope:coding", "project:omp", "team:infra", "role:scout"]);
		expect(item.tags).not.toContain("role:builder");
	});
});
