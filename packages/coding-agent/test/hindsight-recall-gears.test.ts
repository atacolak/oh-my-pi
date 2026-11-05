/**
 * Contract tests for the recall tool's gear ladder: per-call budget/maxTokens/types, the
 * lone-survivor decision gate, and the deep `xhigh`/`max` scoring gears.
 *
 * These spy on `HindsightApi.prototype.{recall,listMemories}` and stub the System One decision
 * service through `globalThis.fetch`, so no server is required. Kept out of
 * `memory-tools.test.ts` on purpose: that file owns Mnemopi's shared SQLite state, and booting
 * it for Hindsight-only gear tests perturbs an interaction these tests do not own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";

const TEST_SESSION_ID = "test-session-id";
let registeredState: HindsightSessionState | undefined;

function makeConfig(overrides: Partial<HindsightConfig> = {}): HindsightConfig {
	return {
		hindsightApiUrl: "http://localhost:8888",
		hindsightApiToken: null,
		bankId: null,
		bankIdPrefix: "",
		scopeTags: [],
		provenanceTags: [],
		scoping: "global",
		globalScope: false,
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
		reflectTimeoutMs: 120_000,
		recallTimeoutMs: 30_000,
		retainTimeoutMs: 60_000,
		mentalModelsEnabled: false,
		mentalModelAutoSeed: false,
		mentalModelMaxRenderChars: 16_000,
		...overrides,
	};
}

function makeSession(settings: Settings): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionId: () => TEST_SESSION_ID,
		getSessionSpawns: () => null,
		getHindsightSessionState: () => registeredState,
	} as unknown as ToolSession;
}

interface RegisterStateOptions {
	recallTags?: string[];
	recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	config?: Partial<HindsightConfig>;
}

function registerState(client: HindsightApi, opts: RegisterStateOptions = {}) {
	registeredState = new HindsightSessionState({
		sessionId: TEST_SESSION_ID,
		client,
		bankId: "test-bank",
		recallTags: opts.recallTags,
		recallTagsMatch: opts.recallTagsMatch,
		config: makeConfig(opts.config),
		session: {
			sessionId: TEST_SESSION_ID,
			sessionManager: { getEntries: () => [] } as never,
			emitNotice: () => {},
			getHindsightSessionState: () => registeredState,
		} as never,
		banksSet: new Set(),
		lastRetainedTurn: 0,
		recallDelivered: false,
	});
}

/** Answers every System One question with `noul` (or `noul(memory)`); counts requests and questions. */
function stubDecisionModel(noul: number | ((memory: string) => number)): { count: number; sizes: number[] } {
	const state = { count: 0, sizes: [] as number[] };
	const score = (memory: string): number => (typeof noul === "number" ? noul : noul(memory));
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (_input: unknown, init?: { body?: unknown }): Promise<Response> => {
				state.count += 1;
				const body = JSON.parse(String(init?.body)) as {
					questions?: Record<string, { instructions?: { memory?: string } }>;
				};
				const questions = Object.entries(body.questions ?? {});
				state.sizes.push(questions.length);
				const answers = Object.fromEntries(
					questions.map(([key, question]) => [
						key,
						{ type: "noul", noul: score(question.instructions?.memory ?? "") },
					]),
				);
				return Response.json({ answers });
			},
			{ preconnect: globalThis.fetch.preconnect },
		),
	);
	return state;
}

function settings(): Settings {
	return Settings.isolated({ "memory.backend": "hindsight" });
}

function recallTool(): MemoryRecallTool {
	return MemoryRecallTool.createIf(makeSession(settings()))!;
}

function textOf(result: AgentToolResult): string {
	return (result.content[0] as { text: string }).text;
}

beforeEach(() => {
	resetSettingsForTest();
	registeredState = undefined;
});

afterEach(() => {
	vi.restoreAllMocks();
	registeredState = undefined;
});

describe("recall.execute gears", () => {
	it("forwards a per-call budget to the client", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		registerState(client);

		await recallTool().execute("call-budget", { query: "anything", budget: "high" });

		expect(recallSpy).toHaveBeenCalledWith("test-bank", "anything", expect.objectContaining({ budget: "high" }));
	});

	it("forwards a per-call maxTokens instead of the configured size", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		registerState(client);

		await recallTool().execute("call-max-tokens", { query: "anything", maxTokens: 4096 });

		expect(recallSpy).toHaveBeenCalledWith("test-bank", "anything", expect.objectContaining({ maxTokens: 4096 }));
	});

	it("clamps a per-call maxTokens into the documented 512..16384 range", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		registerState(client);

		const tool = recallTool();
		await tool.execute("call-max-tokens-low", { query: "anything", maxTokens: 100 });
		await tool.execute("call-max-tokens-high", { query: "anything", maxTokens: 1_000_000 });

		expect(recallSpy).toHaveBeenNthCalledWith(
			1,
			"test-bank",
			"anything",
			expect.objectContaining({ maxTokens: 512 }),
		);
		expect(recallSpy).toHaveBeenNthCalledWith(
			2,
			"test-bank",
			"anything",
			expect.objectContaining({ maxTokens: 16384 }),
		);
	});

	it("forwards a per-call type filter instead of the configured types", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		registerState(client);

		await recallTool().execute("call-types", { query: "anything", types: ["observation"] });

		expect(recallSpy).toHaveBeenCalledWith(
			"test-bank",
			"anything",
			expect.objectContaining({ types: ["observation"] }),
		);
	});

	it("falls back to the configured controls when the caller omits them", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		registerState(client);

		await recallTool().execute("call-defaults", { query: "anything" });

		expect(recallSpy).toHaveBeenCalledWith(
			"test-bank",
			"anything",
			expect.objectContaining({ budget: "mid", maxTokens: 1024, types: ["world", "experience"] }),
		);
	});

	it("drops a lone survivor the decision model rejects", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [{ text: "unrelated trivia", type: "world", id: "1" }],
		} as never);
		const requests = stubDecisionModel(0.1);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const result = await recallTool().execute("call-lone-reject", { query: "where is the deploy host?" });

		expect(result.content[0]).toEqual({ type: "text", text: "No relevant memories found." });
		expect(requests.count).toBe(1);
	});

	it("returns two results without consulting the decision model", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [
				{ text: "fact one", type: "world", id: "1" },
				{ text: "fact two", type: "world", id: "2" },
			],
		} as never);
		const requests = stubDecisionModel(0);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const block = textOf(await recallTool().execute("call-two-results", { query: "where is the deploy host?" }));

		expect(block).toContain("fact one");
		expect(block).toContain("fact two");
		expect(requests.count).toBe(0);
	});

	it("keeps a lone survivor the decision model accepts", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [{ text: "deploy host is beta-9", type: "world", id: "1" }],
		} as never);
		const requests = stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const block = textOf(await recallTool().execute("call-lone-keep", { query: "where is the deploy host?" }));

		expect(block).toContain("deploy host is beta-9");
		expect(requests.count).toBe(1);
	});

	it("rethrows underlying client errors", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockRejectedValue(new Error("HTTP 503"));
		registerState(client);

		await expect(recallTool().execute("call-5", { query: "anything" })).rejects.toThrow(/HTTP 503/);
	});
});

describe("recall.execute deep gears", () => {
	it("translates xhigh into a high-budget traced recall and never sends xhigh to the wire", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [],
			trace: {
				rrf_merged: [
					{ node_id: "a", text: "alpha observation" },
					{ node_id: "b", text: "beta observation" },
				],
			},
		} as never);
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const block = textOf(
			await recallTool().execute("call-xhigh", { query: "where is the deploy host?", budget: "xhigh" }),
		);

		expect(recallSpy.mock.calls.map(call => call[2]?.budget)).toEqual(["high"]);
		expect(recallSpy).toHaveBeenCalledWith(
			"test-bank",
			"where is the deploy host?",
			expect.objectContaining({ budget: "high", trace: true }),
		);
		expect(block).toContain("alpha observation");
		expect(block).toContain("beta observation");
	});

	it("sweeps the bank for max instead of calling recall", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		const listSpy = vi.spyOn(HindsightApi.prototype, "listMemories").mockResolvedValue({
			items: [
				{ id: "obs-1", text: "deploy host is beta-9", fact_type: "observation" },
				{ id: "obs-2", text: "deploy host is gamma-2", fact_type: "observation" },
			],
			total: 2,
			limit: 1000,
			offset: 0,
		} as never);
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const block = textOf(
			await recallTool().execute("call-max", { query: "where is the deploy host?", budget: "max" }),
		);

		expect(recallSpy).not.toHaveBeenCalled();
		expect(listSpy.mock.calls.map(call => call[1]?.type)).toEqual(["observation", undefined, undefined]);
		expect(listSpy.mock.calls.map(call => call[1]?.consolidationState)).toEqual([undefined, "pending", "failed"]);
		expect(block).toContain("deploy host is beta-9");
		expect(block).toContain("[observation]");
	});

	it("stops the max sweep at 4800 candidates and reports the truncation", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const listSpy = vi.spyOn(HindsightApi.prototype, "listMemories").mockImplementation(async (_bankId, options) => {
			const offset = options?.offset ?? 0;
			const limit = options?.limit ?? 0;
			return {
				items: Array.from({ length: limit }, (_, index) => ({
					id: `obs-${offset + index}`,
					text: `observation ${offset + index} body`,
					fact_type: "observation",
				})),
				total: 9000,
				limit,
				offset,
			};
		});
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const result = await recallTool().execute("call-ceiling", { query: "anything", budget: "max" });
		const block = textOf(result);

		expect(listSpy).toHaveBeenCalledTimes(5);
		expect(block).toContain("Deep recall truncated");
		expect(block).toContain("4800");
		expect(result.details).toEqual({ truncated: true });
	});

	it("prunes candidates below 40% of the best deep score", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [],
			trace: {
				rrf_merged: [
					{ node_id: "a", text: "alpha" },
					{ node_id: "b", text: "beta" },
					{ node_id: "c", text: "gamma" },
				],
			},
		} as never);
		const requests = stubDecisionModel(memory => (memory === "alpha" ? 0.9 : memory === "beta" ? 0.35 : 0.1));
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const block = textOf(await recallTool().execute("call-prune", { query: "q", budget: "xhigh" }));

		expect(requests.count).toBe(1);
		expect(block).toContain("alpha");
		expect(block).not.toContain("beta");
		expect(block).not.toContain("gamma");
	});

	it("keeps candidates above the absolute floor when the best score is low", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [],
			trace: {
				rrf_merged: [
					{ node_id: "a", text: "alpha" },
					{ node_id: "b", text: "beta" },
					{ node_id: "c", text: "gamma" },
				],
			},
		} as never);
		stubDecisionModel(memory => (memory === "alpha" ? 0.3 : memory === "beta" ? 0.25 : 0.15));
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const block = textOf(await recallTool().execute("call-floor", { query: "q", budget: "xhigh" }));

		expect(block).toContain("alpha");
		expect(block).toContain("beta");
		expect(block).not.toContain("gamma");
	});

	it("orders surviving candidates by descending deep score", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [],
			trace: {
				rrf_merged: [
					{ node_id: "a", text: "alpha" },
					{ node_id: "b", text: "beta" },
				],
			},
		} as never);
		stubDecisionModel(memory => (memory === "alpha" ? 0.55 : 0.9));
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const block = textOf(await recallTool().execute("call-order", { query: "q", budget: "xhigh" }));

		expect(block.indexOf("beta")).toBeLessThan(block.indexOf("alpha"));
	});

	it("abstains when even the best deep score misses the decision threshold", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [],
			trace: {
				rrf_merged: [
					{ node_id: "a", text: "alpha" },
					{ node_id: "b", text: "beta" },
				],
			},
		} as never);
		stubDecisionModel(memory => (memory === "alpha" ? 0.22 : 0.21));
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const result = await recallTool().execute("call-abstain", { query: "q", budget: "xhigh" });

		expect(textOf(result)).toBe("No relevant memories found.");
		expect(result.useless).toBe(true);
	});

	it("returns unscored candidates with a note when the scorer throws", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [],
			trace: {
				rrf_merged: [
					{ node_id: "a", text: "alpha" },
					{ node_id: "b", text: "beta" },
				],
			},
		} as never);
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("decision service down"));
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const block = textOf(await recallTool().execute("call-degrade", { query: "q", budget: "xhigh" }));

		expect(block).toContain("Scoring unavailable");
		expect(block).toContain("in recall order");
		expect(block).toContain("alpha");
		expect(block).toContain("beta");
	});

	it("returns unscored candidates with a note when no decision model is configured", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "listMemories").mockResolvedValue({
			items: [{ id: "obs-1", text: "deploy host is beta-9", fact_type: "observation" }],
			total: 1,
			limit: 1000,
			offset: 0,
		} as never);
		registerState(client);

		const block = textOf(await recallTool().execute("call-no-model", { query: "q", budget: "max" }));

		expect(block).toContain("Scoring unavailable");
		expect(block).toContain("in bank order");
		expect(block).toContain("deploy host is beta-9");
	});
});
