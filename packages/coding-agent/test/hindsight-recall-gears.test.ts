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
function stubDecisionModel(noul: number | null | ((memory: string) => number | null)): {
	count: number;
	sizes: number[];
} {
	const state = { count: 0, sizes: [] as number[] };
	const score = (memory: string): number | null => (typeof noul === "function" ? noul(memory) : noul);
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

/** Pages `memories/list` from per-collection totals and records every call. */
function stubSweep(totals: { observation: number; pending: number; failed: number }) {
	const calls: { collection: string; limit: number; offset: number }[] = [];
	vi.spyOn(HindsightApi.prototype, "listMemories").mockImplementation(async (_bankId, options) => {
		const collection = options?.type ?? options?.consolidationState ?? "observation";
		const offset = options?.offset ?? 0;
		const limit = options?.limit ?? 0;
		calls.push({ collection, limit, offset });
		const total = totals[collection as keyof typeof totals] ?? 0;
		const count = Math.max(0, Math.min(limit, total - offset));
		return {
			items: Array.from({ length: count }, (_, index) => ({
				id: `${collection}-${offset + index}`,
				text: `${collection} ${offset + index} body`,
				fact_type: collection === "observation" ? "observation" : "world",
			})),
			total,
			limit,
			offset,
		};
	});
	return { calls };
}

function stubFailedRows(rows: { id: string; text: string }[]) {
	vi.spyOn(HindsightApi.prototype, "listMemories").mockImplementation(async (_bankId, options) => {
		const collection = options?.type ?? options?.consolidationState ?? "observation";
		const offset = options?.offset ?? 0;
		const limit = options?.limit ?? 0;
		if (collection === "pending") return { items: [], total: 0, limit, offset };
		if (collection === "failed") {
			const count = Math.max(0, Math.min(limit, rows.length - offset));
			return {
				items: rows.slice(offset, offset + count).map(row => ({ ...row, fact_type: "world" })),
				total: rows.length,
				limit,
				offset,
			};
		}
		const count = Math.max(0, Math.min(limit, 4800 - offset));
		return {
			items: Array.from({ length: count }, (_, index) => ({
				id: `observation-${offset + index}`,
				text: `observation ${offset + index} body`,
				fact_type: "observation",
			})),
			total: 4800,
			limit,
			offset,
		};
	});
}

/** Answers the first sweep page with a full page and a total past any deep ceiling. */
function stubOversizedBank() {
	const calls: { collection: string; limit: number; offset: number }[] = [];
	vi.spyOn(HindsightApi.prototype, "listMemories").mockImplementation(async (_bankId, options) => {
		const collection = options?.type ?? options?.consolidationState ?? "observation";
		const offset = options?.offset ?? 0;
		const limit = options?.limit ?? 0;
		calls.push({ collection, limit, offset });
		return {
			items: Array.from({ length: limit }, (_, index) => ({
				id: `oversized-${offset + index}`,
				text: `oversized ${offset + index} body`,
				fact_type: "observation",
			})),
			total: 5001,
			limit,
			offset,
		};
	});
	return { calls };
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
		stubOversizedBank();
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
		stubOversizedBank();
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
		stubOversizedBank();
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
	it("sweeps every scoped collection for xhigh and skips the recall call", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		const sweep = stubSweep({ observation: 3, pending: 0, failed: 0 });
		const requests = stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const block = textOf(
			await recallTool().execute("call-xhigh-sweep", { query: "where is the deploy host?", budget: "xhigh" }),
		);

		expect(recallSpy).not.toHaveBeenCalled();
		expect(sweep.calls).toEqual([
			{ collection: "observation", limit: 1000, offset: 0 },
			{ collection: "pending", limit: 1000, offset: 0 },
			{ collection: "failed", limit: 1000, offset: 0 },
		]);
		expect(requests.sizes).toEqual([3]);
		expect(block).toContain("observation 0 body");
		expect(block).toContain("observation 2 body");
	});

	it("sweeps only the requested types for xhigh", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		const calls: { type?: string; consolidationState?: string }[] = [];
		vi.spyOn(HindsightApi.prototype, "listMemories").mockImplementation(async (_bankId, options) => {
			const offset = options?.offset ?? 0;
			const limit = options?.limit ?? 0;
			calls.push({ type: options?.type, consolidationState: options?.consolidationState });
			const count = Math.max(0, Math.min(limit, 2 - offset));
			return {
				items: Array.from({ length: count }, (_, index) => ({
					id: `world-${offset + index}`,
					text: `world fact ${offset + index}`,
					fact_type: "world",
				})),
				total: 2,
				limit,
				offset,
			};
		});
		const requests = stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const block = textOf(
			await recallTool().execute("call-xhigh-types", {
				query: "where is the deploy host?",
				budget: "xhigh",
				types: ["world"],
			}),
		);

		expect(recallSpy).not.toHaveBeenCalled();
		expect(calls).toEqual([{ type: "world", consolidationState: undefined }]);
		expect(requests.sizes).toEqual([2]);
		expect(block).toContain("world fact 0");
	});

	it("hands xhigh back to a traced high recall when page one busts the ceiling", async () => {
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
		const bank = stubOversizedBank();
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const block = textOf(
			await recallTool().execute("call-xhigh-bust", { query: "where is the deploy host?", budget: "xhigh" }),
		);

		expect(bank.calls).toEqual([{ collection: "observation", limit: 1000, offset: 0 }]);
		expect(recallSpy.mock.calls.map(call => call[2]?.budget)).toEqual(["high"]);
		expect(recallSpy).toHaveBeenCalledWith(
			"test-bank",
			"where is the deploy host?",
			expect.objectContaining({ budget: "high", trace: true }),
		);
		expect(block).toContain("alpha observation");
		expect(block).toContain("beta observation");
	});

	it("hands xhigh back to recall when the collection totals sum past the ceiling", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [],
			trace: { rrf_merged: [{ node_id: "a", text: "alpha observation" }] },
		} as never);
		const calls: { collection: string; limit: number; offset: number }[] = [];
		vi.spyOn(HindsightApi.prototype, "listMemories").mockImplementation(async (_bankId, options) => {
			const collection = options?.type ?? options?.consolidationState ?? "observation";
			const offset = options?.offset ?? 0;
			const limit = options?.limit ?? 0;
			calls.push({ collection, limit, offset });
			const total = collection === "observation" ? 2000 : collection === "pending" ? 500 : 0;
			const count = Math.max(0, Math.min(limit, total - offset));
			return {
				items: Array.from({ length: count }, (_, index) => ({
					id: `${collection}-${offset + index}`,
					text: `${collection} ${offset + index} body`,
					fact_type: "observation",
				})),
				total,
				limit,
				offset,
			};
		});
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const block = textOf(await recallTool().execute("call-xhigh-sum", { query: "q", budget: "xhigh" }));

		expect(calls).toEqual([
			{ collection: "observation", limit: 1000, offset: 0 },
			{ collection: "observation", limit: 1000, offset: 1000 },
			{ collection: "pending", limit: 400, offset: 0 },
		]);
		expect(recallSpy.mock.calls.map(call => call[2]?.budget)).toEqual(["high"]);
		expect(block).toContain("alpha observation");
	});

	it("hands xhigh back to recall when a total-less bank fills the ceiling", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [],
			trace: { rrf_merged: [{ node_id: "a", text: "alpha observation" }] },
		} as never);
		const offsets: number[] = [];
		vi.spyOn(HindsightApi.prototype, "listMemories").mockImplementation(async (_bankId, options) => {
			const offset = options?.offset ?? 0;
			const limit = options?.limit ?? 0;
			offsets.push(offset);
			const count = Math.max(0, Math.min(limit, 3000 - offset));
			return {
				items: Array.from({ length: count }, (_, index) => ({
					id: `observation-${offset + index}`,
					text: `observation ${offset + index} body`,
					fact_type: "observation",
				})),
				limit,
				offset,
			};
		});
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const block = textOf(await recallTool().execute("call-xhigh-no-total", { query: "q", budget: "xhigh" }));

		expect(offsets).toEqual([0, 1000, 1000, 2000, 2000, 2400]);
		expect(recallSpy.mock.calls.map(call => call[2]?.budget)).toEqual(["high"]);
		expect(block).toContain("alpha observation");
	});

	it("keeps server-ranked order for xhigh when no scorer is configured", async () => {
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
		const listSpy = vi.spyOn(HindsightApi.prototype, "listMemories").mockResolvedValue({
			items: [{ id: "obs-1", text: "swept observation", fact_type: "observation" }],
			total: 1,
			limit: 1000,
			offset: 0,
		} as never);
		registerState(client);

		const block = textOf(await recallTool().execute("call-xhigh-unscored", { query: "q", budget: "xhigh" }));

		expect(listSpy).not.toHaveBeenCalled();
		expect(recallSpy).toHaveBeenCalledWith(
			"test-bank",
			"q",
			expect.objectContaining({ budget: "high", trace: true }),
		);
		expect(block).toContain("Scoring unavailable");
		expect(block).toContain("in recall order");
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

	it("does not report truncation when the sweep ends exactly at the ceiling", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const sweep = stubSweep({ observation: 4800, pending: 0, failed: 0 });
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const result = await recallTool().execute("call-exact", { query: "anything", budget: "max" });
		const block = textOf(result);

		expect(block).not.toContain("Deep recall truncated");
		expect(result.details).toEqual({ truncated: false });
		expect(sweep.calls).toHaveLength(7);
		expect(sweep.calls.slice(-2).map(call => [call.collection, call.limit])).toEqual([
			["pending", 200],
			["failed", 200],
		]);
	});

	it("reports truncation when the bank holds one row past the ceiling", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const sweep = stubSweep({ observation: 4801, pending: 0, failed: 0 });
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const result = await recallTool().execute("call-over", { query: "anything", budget: "max" });
		const block = textOf(result);

		expect(block).toContain("Deep recall truncated");
		expect(result.details).toEqual({ truncated: true });
		expect(sweep.calls).toHaveLength(5);
	});

	it("reports truncation when a collection the cap never reached still holds rows", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const sweep = stubSweep({ observation: 4800, pending: 0, failed: 1 });
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const result = await recallTool().execute("call-probe", { query: "anything", budget: "max" });

		expect(textOf(result)).toContain("Deep recall truncated");
		expect(result.details).toEqual({ truncated: true });
		expect(sweep.calls).toHaveLength(7);
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
		stubOversizedBank();
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
		stubOversizedBank();
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
		stubOversizedBank();
		stubDecisionModel(memory => (memory === "alpha" ? 0.55 : 0.9));
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const block = textOf(await recallTool().execute("call-order", { query: "q", budget: "xhigh" }));

		expect(block.indexOf("beta")).toBeLessThan(block.indexOf("alpha"));
	});

	it("does not report truncation when a total-less bank ends exactly at the ceiling", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "listMemories").mockImplementation(async (_bankId, options) => {
			const collection = options?.type ?? options?.consolidationState ?? "observation";
			const offset = options?.offset ?? 0;
			const limit = options?.limit ?? 0;
			if (collection !== "observation") return { items: [], limit, offset };
			const count = Math.max(0, Math.min(limit, 4800 - offset));
			return {
				items: Array.from({ length: count }, (_, index) => ({
					id: `observation-${offset + index}`,
					text: `observation ${offset + index} body`,
					fact_type: "observation",
				})),
				limit,
				offset,
			};
		});
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const result = await recallTool().execute("call-total-less", { query: "anything", budget: "max" });

		expect(textOf(result)).not.toContain("Deep recall truncated");
		expect(result.details).toEqual({ truncated: false });
	});

	it("does not report truncation when an unvisited collection only repeats scored ids", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const probes: { collection: string; limit: number }[] = [];
		vi.spyOn(HindsightApi.prototype, "listMemories").mockImplementation(async (_bankId, options) => {
			const collection = options?.type ?? options?.consolidationState ?? "observation";
			const offset = options?.offset ?? 0;
			const limit = options?.limit ?? 0;
			if (collection === "failed") {
				probes.push({ collection, limit });
				return {
					items: [
						{ id: "observation-0", text: "duplicate a", fact_type: "world" },
						{ id: "observation-1", text: "duplicate b", fact_type: "world" },
						{ id: "observation-2", text: "duplicate c", fact_type: "world" },
					],
					total: 3,
					limit,
					offset,
				};
			}
			if (collection === "pending") {
				probes.push({ collection, limit });
				return { items: [], total: 0, limit, offset };
			}
			const count = Math.max(0, Math.min(limit, 4800 - offset));
			return {
				items: Array.from({ length: count }, (_, index) => ({
					id: `observation-${offset + index}`,
					text: `observation ${offset + index} body`,
					fact_type: "observation",
				})),
				total: 4800,
				limit,
				offset,
			};
		});
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const result = await recallTool().execute("call-duplicates", { query: "anything", budget: "max" });

		expect(textOf(result)).not.toContain("Deep recall truncated");
		expect(result.details).toEqual({ truncated: false });
		expect(probes).toEqual([
			{ collection: "pending", limit: 200 },
			{ collection: "failed", limit: 200 },
		]);
	});

	it("walks past duplicates to find an unread raw fact beyond the first probe page", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const failed = Array.from({ length: 201 }, (_, index) => ({
			id: `observation-${index}`,
			text: `duplicate ${index}`,
		}));
		failed.push({ id: "fresh-1", text: "fresh raw fact" });
		stubFailedRows(failed);
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const result = await recallTool().execute("call-duplicate-walk", { query: "anything", budget: "max" });
		const block = textOf(result);

		expect(block).toContain("Deep recall truncated");
		expect(block).toContain("some rows were left unread");
		expect(result.details).toEqual({ truncated: true });
	});

	it("reports truncation when the probe budget is spent proving a collection is all duplicates", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const duplicates = Array.from({ length: 2000 }, (_, index) => ({
			id: `observation-${index}`,
			text: `duplicate ${index}`,
		}));
		stubFailedRows(duplicates);
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const result = await recallTool().execute("call-duplicate-bound", { query: "anything", budget: "max" });
		const block = textOf(result);

		expect(block).toContain("Deep recall truncated");
		expect(block).toContain("some rows were left unread");
		expect(result.details).toEqual({ truncated: true });
	});

	it("reports truncation when a small unread collection holds a fresh id on its first page", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		stubFailedRows([
			{ id: "observation-0", text: "duplicate" },
			{ id: "fresh-small", text: "fresh raw fact" },
		]);
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const result = await recallTool().execute("call-small-collection", { query: "anything", budget: "max" });
		const block = textOf(result);

		expect(block).toContain("Deep recall truncated");
		expect(block).toContain("some rows were left unread");
		expect(result.details).toEqual({ truncated: true });
	});

	it("says how many candidates went unscored when the best score misses the threshold", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [],
			trace: {
				rrf_merged: [
					{ node_id: "a", text: "alpha" },
					{ node_id: "b", text: "beta" },
					{ node_id: "c", text: "gamma" },
					{ node_id: "d", text: "delta" },
				],
			},
		} as never);
		stubOversizedBank();
		stubDecisionModel(memory => (memory === "alpha" ? 0.1 : null));
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const result = await recallTool().execute("call-abstain-nulls", { query: "q", budget: "xhigh" });

		expect(textOf(result)).toBe("No relevant memories found. 3 candidates could not be scored.");
		expect(result.useless).toBe(true);
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
		stubOversizedBank();
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
		stubOversizedBank();
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

	it("drops candidates the scorer left unanswered and says how many", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [],
			trace: {
				rrf_merged: [
					{ node_id: "a", text: "alpha" },
					{ node_id: "b", text: "beta" },
					{ node_id: "c", text: "gamma" },
					{ node_id: "d", text: "delta" },
				],
			},
		} as never);
		stubOversizedBank();
		stubDecisionModel(memory => (memory === "alpha" ? 0.9 : null));
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const block = textOf(await recallTool().execute("call-partial", { query: "q", budget: "xhigh" }));

		expect(block).toContain("3 candidates could not be scored");
		expect(block).toContain("alpha");
		expect(block).not.toContain("beta");
		expect(block).not.toContain("gamma");
		expect(block).not.toContain("delta");
	});

	it("degrades to unscored candidates when the query alone busts the scoring budget", async () => {
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
		const requests = stubDecisionModel(0.9);
		stubOversizedBank();
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const block = textOf(
			await recallTool().execute("call-big-query", { query: "term ".repeat(20_000), budget: "xhigh" }),
		);

		expect(requests.count).toBe(0);
		expect(block).toContain("Scoring unavailable");
		expect(block).toContain("alpha");
		expect(block).toContain("beta");
	});
});

describe("recall.execute uniform sweep gears", () => {
	it("sweeps a fitted low scope inside its cap and skips the server recall", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		const sweep = stubSweep({ observation: 3, pending: 0, failed: 0 });
		const requests = stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const block = textOf(
			await recallTool().execute("call-low-sweep", { query: "where is the deploy host?", budget: "low" }),
		);

		expect(recallSpy).not.toHaveBeenCalled();
		expect(sweep.calls.map(call => call.collection)).toEqual(["observation", "pending", "failed"]);
		expect(sweep.calls[0]).toEqual({ collection: "observation", limit: 300, offset: 0 });
		expect(requests.sizes).toEqual([3]);
		expect(block).toContain("observation 0 body");
	});

	it("keeps a sweep that exactly fills the mid cap instead of ranking it", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		const sweep = stubSweep({ observation: 600, pending: 0, failed: 0 });
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const result = await recallTool().execute("call-mid-full", { query: "q", budget: "mid" });

		expect(recallSpy).not.toHaveBeenCalled();
		expect(result.details).toEqual({ truncated: false });
		expect(sweep.calls[0]).toEqual({ collection: "observation", limit: 600, offset: 0 });
	});

	it("hands a scope past the gear cap to the server-ranked recall", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [{ id: "ranked-1", text: "ranked memory body", type: "observation" }],
		} as never);
		const bank = stubOversizedBank();
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const block = textOf(await recallTool().execute("call-mid-bust", { query: "q", budget: "mid" }));

		expect(bank.calls).toEqual([{ collection: "observation", limit: 600, offset: 0 }]);
		expect(recallSpy).toHaveBeenCalledTimes(1);
		expect(recallSpy).toHaveBeenCalledWith("test-bank", "q", expect.objectContaining({ budget: "mid" }));
		expect(recallSpy.mock.calls[0]![2]?.trace).toBeUndefined();
		expect(block).toContain("ranked memory body");
	});
});
