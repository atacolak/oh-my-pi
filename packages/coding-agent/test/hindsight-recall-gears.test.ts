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
		recallBudget: "default",
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

		await recallTool().execute("call-budget", { query: "anything", budget: "deep" });

		expect(recallSpy).toHaveBeenCalledWith("test-bank", "anything", expect.objectContaining({ budget: "high" }));
	});

	it("packs a wider requested return window locally and clamps both token boundaries", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: Array.from({ length: 40 }, (_, index) => ({
				id: `packed-${index}`,
				text: `entry-${index} ${"word ".repeat(600)}`,
			})),
		});
		registerState(client);
		const tool = recallTool();
		const normal = textOf(await tool.execute("default-window", { query: "q" }));
		const wide = textOf(await tool.execute("wide-window", { query: "q", maxTokens: 4096 }));
		const low = textOf(await tool.execute("low-window", { query: "q", maxTokens: 100 }));
		const high = textOf(await tool.execute("high-window", { query: "q", maxTokens: 1_000_000 }));
		const minimum = textOf(await tool.execute("minimum", { query: "q", maxTokens: 512 }));
		const maximum = textOf(await tool.execute("maximum", { query: "q", maxTokens: 16384 }));
		expect(normal).not.toContain("[memory://packed-1]");
		expect(wide).toContain("[memory://packed-5]");
		expect(wide).not.toContain("[memory://packed-7]");
		expect(low).toBe(minimum);
		expect(high).toBe(maximum);
		expect(high).not.toContain("[memory://packed-39]");
	});

	it("shortlists 1200 judged records when the default scope has 1201, without sending a public gear on the wire", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recall = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [],
			trace: {
				rrf_merged: Array.from({ length: 1201 }, (_, index) => ({
					node_id: `ranked-${index}`,
					text: `ranked ${index}`,
				})),
			},
		});
		stubSweep({ observation: 1201, pending: 0, failed: 0 });
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });
		const result = await recallTool().execute("crossover", { query: "q", budget: "default" });
		expect(result.details).toMatchObject({ mode: "shortlisted", evaluatedCount: 1200, totalAvailable: 1201 });
		expect(recall.mock.calls[0]![2]).toMatchObject({ budget: "high", trace: true });
	});

	it("sweeps all 1668 project records at deep without a ranked request", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recall = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] });
		stubSweep({ observation: 1668, pending: 0, failed: 0 });
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });
		const result = await recallTool().execute("deep-project", { query: "q", budget: "deep" });
		expect(result.details).toMatchObject({ mode: "swept", evaluatedCount: 1668, totalAvailable: 1668 });
		expect(recall).not.toHaveBeenCalled();
	});

	it.each(["per-project-tagged", "per-project"] as const)(
		"max shortlists at most 4800 records in %s scope while retaining the hard coding boundary",
		async scoping => {
			const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
			const recall = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
				results: [],
				trace: {
					rrf_merged: Array.from({ length: 4801 }, (_, index) => ({
						node_id: `ranked-${index}`,
						text: `ranked memory ${index}`,
					})),
				},
			});
			stubSweep({ observation: 5001, pending: 2, failed: 3 });
			const scoring = stubDecisionModel(memory => (memory === "ranked memory 4799" ? 0.99 : 0.1));
			registerState(client, {
				recallTags: ["scope:coding", "project:oh-my-pi"],
				config: { scoping, decisionModelUrl: "http://decision.local" },
			});
			const result = await recallTool().execute("project-max", {
				query: "q",
				budget: "max",
				tags: ["project:memory", "scope:personal"],
			});
			expect(result.details).toMatchObject({
				mode: "shortlisted",
				evaluatedCount: 4800,
				tags: ["scope:coding", "project:memory"],
				truncated: true,
			});
			expect(scoring.sizes.reduce((sum, size) => sum + size, 0)).toBe(4800);
			expect(textOf(result)).toContain("ranked memory 4799");
			expect(textOf(result)).not.toContain("ranked memory 4800");
			expect(recall).toHaveBeenCalledWith(
				"test-bank",
				"q",
				expect.objectContaining({
					trace: true,
					tags: ["scope:coding", "project:memory"],
				}),
			);
		},
	);

	it("keeps wildcard and disjunctive project filters bounded instead of authorizing an exhaustive bank scan", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recall = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] });
		stubSweep({ observation: 5001, pending: 0, failed: 0 });
		stubDecisionModel(0.9);
		registerState(client, {
			recallTags: ["scope:coding", "project:*"],
			config: { decisionModelUrl: "http://decision.local" },
		});
		expect((await recallTool().execute("wildcard", { query: "q", budget: "max" })).details).toMatchObject({
			mode: "shortlisted",
		});
		registerState(client, {
			recallTags: ["scope:coding", "project:valid"],
			recallTagsMatch: "any",
			config: { decisionModelUrl: "http://decision.local" },
		});
		expect((await recallTool().execute("disjunctive", { query: "q", budget: "max" })).details).toMatchObject({
			mode: "shortlisted",
		});
		expect(recall).toHaveBeenCalledTimes(2);
	});

	it("reports an exact empty scope as zero of zero without inventing an unknown denominator", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		stubSweep({ observation: 0, pending: 0, failed: 0 });
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });
		const result = await recallTool().execute("empty", { query: "q" });
		expect(textOf(result)).toContain("0/0 (100%)");
		expect(registeredState!.lastScopeTotalAvailable).toBe(0);
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
			expect.objectContaining({ budget: "high", maxTokens: 16384, types: ["world", "experience"] }),
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

		expect(textOf(result)).toContain("No relevant memories found.");
		expect(result.details).toMatchObject({
			mode: "shortlisted",
			evaluatedCount: 1,
			scoredCandidates: [{ id: "1", score: 0.1, kept: false }],
		});
		expect(requests.count).toBe(1);
	});

	it("judges every shortlisted result, rather than skipping scoring when two survive", async () => {
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

		expect(block).not.toContain("fact one");
		expect(block).not.toContain("fact two");
		expect(requests.count).toBe(1);
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
			await recallTool().execute("call-xhigh-sweep", { query: "where is the deploy host?", budget: "deep" }),
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
				budget: "deep",
				types: ["world"],
			}),
		);

		expect(recallSpy).not.toHaveBeenCalled();
		expect(calls).toEqual([{ type: "world", consolidationState: undefined }]);
		expect(requests.sizes).toEqual([2]);
		expect(block).toContain("world fact 0");
		expect(block).toContain("scanned 2/2 (100%)");
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
			await recallTool().execute("call-xhigh-bust", { query: "where is the deploy host?", budget: "deep" }),
		);

		expect(bank.calls).toEqual([
			{ collection: "observation", limit: 1000, offset: 0 },
			{ collection: "pending", limit: 1, offset: 0 },
			{ collection: "failed", limit: 1, offset: 0 },
		]);
		expect(recallSpy.mock.calls.map(call => call[2]?.budget)).toEqual(["high"]);
		expect(recallSpy).toHaveBeenCalledWith(
			"test-bank",
			"where is the deploy host?",
			expect.objectContaining({ budget: "high", trace: true }),
		);
		expect(block).toContain("alpha observation");
		expect(block).toContain("beta observation");
	});

	it("falls back when the distinct union exceeds deep's ceiling without inventing a union count", async () => {
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

		const result = await recallTool().execute("call-xhigh-sum", { query: "q", budget: "deep" });
		const block = textOf(result);
		expect(result.details).toMatchObject({ mode: "shortlisted", totalAvailable: null });
		expect(calls.length).toBeLessThan(20);
		expect(recallSpy.mock.calls.map(call => call[2]?.budget)).toEqual(["high"]);
		expect(block).toContain("alpha observation");
	});

	it("bounds a total-less duplicate probe and falls back with unknown scope coverage", async () => {
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

		const result = await recallTool().execute("call-xhigh-no-total", { query: "q", budget: "deep" });
		const block = textOf(result);
		expect(result.details).toMatchObject({ mode: "shortlisted", totalAvailable: null });
		expect(offsets.length).toBeLessThan(32);
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

		const block = textOf(await recallTool().execute("call-xhigh-unscored", { query: "q", budget: "deep" }));

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

	it("uses up to 4800 ranked candidates on max overflow instead of scoring the unranked list prefix", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [],
			trace: {
				rrf_merged: Array.from({ length: 4801 }, (_, index) => ({
					node_id: `ranked-${index}`,
					text: index === 4799 ? "relevant near the end of the max shortlist" : `ranked memory ${index}`,
				})),
			},
		});
		const bank = stubSweep({ observation: 5001, pending: 2, failed: 3 });
		stubDecisionModel(memory => (memory.includes("near the end") ? 0.99 : 0.1));
		registerState(client, {
			recallTags: ["scope:coding"],
			config: { decisionModelUrl: "http://decision.local", recallTypes: ["observation"] },
		});
		const result = await recallTool().execute("call-max-overflow", {
			query: "ranked evidence",
			budget: "max",
			tags: ["area:recall", "scope:personal"],
		});
		expect(recallSpy).toHaveBeenCalledWith(
			"test-bank",
			"ranked evidence",
			expect.objectContaining({
				trace: true,
				types: ["observation"],
				tags: ["scope:coding", "area:recall"],
			}),
		);
		expect(bank.calls).toEqual([
			{ collection: "observation", limit: 1000, offset: 0 },
			{ collection: "pending", limit: 1, offset: 0 },
			{ collection: "failed", limit: 1, offset: 0 },
		]);
		expect(result.details).toMatchObject({
			mode: "shortlisted",
			evaluatedCount: 4800,
			totalAvailable: null,
			gear: "max",
			tags: ["scope:coding", "area:recall"],
			truncated: true,
		});
		const details = result.details as { scoredCandidates: { id: string; score: number; kept: boolean }[] };
		expect(details.scoredCandidates[4799]).toMatchObject({ id: "ranked-4799", score: 0.99, kept: true });
		expect(details.scoredCandidates.some(candidate => candidate.id === "ranked-4800")).toBe(false);
		expect(textOf(result)).toContain("scanned 4800/unknown (unknown)");
		expect(textOf(result)).toContain("relevant near the end");
		expect(textOf(result)).not.toContain("observation 0 body");
	});

	it("does not report truncation when the sweep ends exactly at the ceiling", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const sweep = stubSweep({ observation: 4800, pending: 0, failed: 0 });
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const result = await recallTool().execute("call-exact", { query: "anything", budget: "max" });
		const block = textOf(result);

		expect(block).not.toContain("Deep recall truncated");
		expect(result.details).toMatchObject({
			mode: "swept",
			evaluatedCount: 4800,
			totalAvailable: 4800,
			truncated: false,
		});
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

		expect(block).toContain("/4801 (");
		expect(result.details).toMatchObject({ mode: "shortlisted", totalAvailable: 4801, truncated: true });
		expect(sweep.calls).toHaveLength(3);
	});

	it("reports truncation when a collection the cap never reached still holds rows", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const sweep = stubSweep({ observation: 4800, pending: 0, failed: 1 });
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const result = await recallTool().execute("call-probe", { query: "anything", budget: "max" });

		expect(textOf(result)).toContain("/unknown (unknown)");
		expect(result.details).toMatchObject({ mode: "shortlisted", totalAvailable: null, truncated: true });
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

		const block = textOf(await recallTool().execute("call-prune", { query: "q", budget: "deep" }));

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

		const block = textOf(await recallTool().execute("call-floor", { query: "q", budget: "deep" }));

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

		const block = textOf(await recallTool().execute("call-order", { query: "q", budget: "deep" }));

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
		expect(result.details).toMatchObject({
			mode: "swept",
			evaluatedCount: 4800,
			totalAvailable: 4800,
			truncated: false,
		});
		expect(textOf(result)).toContain("scanned 4800/4800");
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
		expect(result.details).toMatchObject({
			mode: "swept",
			evaluatedCount: 4800,
			totalAvailable: 4800,
			truncated: false,
		});
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

		expect(block).toContain("/unknown (unknown)");
		expect(result.details).toMatchObject({ mode: "shortlisted", totalAvailable: null, truncated: true });
	});

	it("reports truncation when the probe budget is spent proving a collection is all duplicates", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const duplicates = Array.from({ length: 5001 }, (_, index) => ({
			id: `observation-${index % 4800}`,
			text: `duplicate ${index}`,
		}));
		stubFailedRows(duplicates);
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const result = await recallTool().execute("call-duplicate-bound", { query: "anything", budget: "max" });
		const block = textOf(result);

		expect(block).toContain("/unknown (unknown)");
		expect(result.details).toMatchObject({ mode: "shortlisted", totalAvailable: null, truncated: true });
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

		expect(block).toContain("/unknown (unknown)");
		expect(result.details).toMatchObject({ mode: "shortlisted", totalAvailable: null, truncated: true });
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

		const result = await recallTool().execute("call-abstain-nulls", { query: "q", budget: "deep" });

		expect(textOf(result)).toContain("No relevant memories found. 3 candidates could not be scored.");
		expect(result.details).toMatchObject({
			evaluatedCount: 1,
			scoredCandidates: [
				{ score: 0.1, kept: false },
				{ score: null, kept: false },
				{ score: null, kept: false },
				{ score: null, kept: false },
			],
		});
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

		const result = await recallTool().execute("call-abstain", { query: "q", budget: "deep" });

		expect(textOf(result)).toContain("No relevant memories found.");
		expect(result.details).toMatchObject({
			evaluatedCount: 2,
			scoredCandidates: [
				{ score: 0.22, kept: false },
				{ score: 0.21, kept: false },
			],
		});
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

		const block = textOf(await recallTool().execute("call-degrade", { query: "q", budget: "deep" }));

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

		const block = textOf(await recallTool().execute("call-partial", { query: "q", budget: "deep" }));

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
			await recallTool().execute("call-big-query", { query: "term ".repeat(20_000), budget: "deep" }),
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
			await recallTool().execute("call-low-sweep", { query: "where is the deploy host?", budget: "default" }),
		);

		expect(recallSpy).not.toHaveBeenCalled();
		expect(sweep.calls.map(call => call.collection)).toEqual(["observation", "pending", "failed"]);
		expect(sweep.calls[0]).toEqual({ collection: "observation", limit: 1000, offset: 0 });
		expect(requests.sizes).toEqual([3]);
		expect(block).toContain("observation 0 body");
	});

	it("keeps a sweep that exactly fills the 1200-record baseline instead of ranking it", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		const sweep = stubSweep({ observation: 1200, pending: 0, failed: 0 });
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const result = await recallTool().execute("call-mid-full", { query: "q", budget: "default" });

		expect(recallSpy).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({
			mode: "swept",
			evaluatedCount: 1200,
			totalAvailable: 1200,
			truncated: false,
		});
		expect(sweep.calls[0]).toEqual({ collection: "observation", limit: 1000, offset: 0 });
	});

	it("hands a scope past the gear cap to the server-ranked recall", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [{ id: "ranked-1", text: "ranked memory body", type: "observation" }],
		} as never);
		const bank = stubOversizedBank();
		stubDecisionModel(0.9);
		registerState(client, { config: { decisionModelUrl: "http://decision.local" } });

		const block = textOf(await recallTool().execute("call-mid-bust", { query: "q", budget: "default" }));

		expect(bank.calls).toEqual([
			{ collection: "observation", limit: 1000, offset: 0 },
			{ collection: "pending", limit: 1, offset: 0 },
			{ collection: "failed", limit: 1, offset: 0 },
		]);
		expect(recallSpy).toHaveBeenCalledTimes(1);
		expect(recallSpy).toHaveBeenCalledWith(
			"test-bank",
			"q",
			expect.objectContaining({ budget: "high", trace: true }),
		);
		expect(block).toContain("ranked memory body");
	});
});

describe("recall coverage", () => {
	it("scores pending and failed retains in an observation-only session and reports every filtering decision", async () => {
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] });
		const bank = stubSweep({ observation: 2, pending: 1, failed: 1 });
		stubDecisionModel(memory => (memory.startsWith("pending") ? 0.1 : memory.startsWith("failed") ? null : 0.9));
		registerState(client, {
			recallTags: ["scope:coding", "project:memory"],
			config: { decisionModelUrl: "http://decision.local", recallTypes: ["observation"] },
		});
		const result = await recallTool().execute("call-coverage", { query: "evidence", budget: "default" });
		expect(bank.calls.map(call => call.collection)).toEqual(["observation", "pending", "failed"]);
		expect(recallSpy).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({
			mode: "swept",
			evaluatedCount: 3,
			totalAvailable: 4,
			gear: "default",
			tags: ["scope:coding", "project:memory"],
			scoredCandidates: [
				{ id: "observation-0", score: 0.9, kept: true },
				{ id: "observation-1", score: 0.9, kept: true },
				{ id: "pending-0", score: 0.1, kept: false },
				{ id: "failed-0", score: null, kept: false },
			],
		});
		expect(textOf(result)).toContain("scanned 3/4 (75%) in [scope:coding, project:memory], depth=default");
		expect(textOf(result)).not.toContain("pending 0 body");
		expect(textOf(result)).not.toContain("failed 0 body");
	});
});
