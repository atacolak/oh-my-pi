import { afterEach, describe, expect, it, vi } from "bun:test";
import { HindsightApi, HindsightRecallDecision } from "../../src/hindsight/client";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("HindsightApi fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("combines caller cancellation with the request timeout", async () => {
		let requestSignal: AbortSignal | undefined;
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json({ results: [] });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const caller = new AbortController();
		const client = new HindsightApi({ baseUrl: "https://hindsight.example" });
		await client.recall("bank", "query", { signal: caller.signal });

		expect(requestSignal).toBeInstanceOf(AbortSignal);
		expect(requestSignal).not.toBe(caller.signal);
		caller.abort(new Error("caller aborted"));
		expect(requestSignal?.aborted).toBe(true);
		expect(requestSignal?.reason).toBe(caller.signal.reason);
	});
});

describe("HindsightApi recall request", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends the observation preference and rerank switches", async () => {
		let body: Record<string, unknown> | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_input: FetchInput, init?: FetchInit): Promise<Response> => {
					body = JSON.parse(String(init?.body)) as Record<string, unknown>;
					return Response.json({ results: [] });
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const client = new HindsightApi({ baseUrl: "https://hindsight.example" });
		await client.recall("bank", "query", {
			preferObservations: true,
			rerank: { prune: true, dedup: false },
		});

		expect(body?.prefer_observations).toBe(true);
		expect(body?.rerank).toEqual({ prune: true, dedup: false });
	});

	it("forwards trace so a deep gear can read the ranked candidate list", async () => {
		let body: Record<string, unknown> | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_input: FetchInput, init?: FetchInit): Promise<Response> => {
					body = JSON.parse(String(init?.body)) as Record<string, unknown>;
					return Response.json({ results: [], trace: { rrf_merged: [] } });
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const client = new HindsightApi({ baseUrl: "https://hindsight.example" });
		await client.recall("bank", "query", { budget: "high", trace: true });

		expect(body?.trace).toBe(true);
		expect(body?.budget).toBe("high");
	});
});

describe("HindsightApi memory list request", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends repeated tags and tags_match so a bank sweep scopes server-side", async () => {
		let url = "";
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput): Promise<Response> => {
					url = String(input);
					return Response.json({ items: [], total: 0, limit: 100, offset: 0 });
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const client = new HindsightApi({ baseUrl: "https://hindsight.example" });
		const page = await client.listMemories("bank", {
			limit: 100,
			offset: 0,
			type: "observation",
			tags: ["scope:coding", "project:oh-my-pi"],
			tagsMatch: "all_strict",
		});

		const search = new URL(url).searchParams;
		expect(search.getAll("tags")).toEqual(["scope:coding", "project:oh-my-pi"]);
		expect(search.get("tags_match")).toBe("all_strict");
		expect(page.items).toEqual([]);
	});
});

type QuestionBody = { questions?: Record<string, { instructions?: { memory?: string } }> };

/**
 * Answers each question with the numeric tail of its memory text, tracking batch sizes and
 * concurrency. Requests park on a barrier that opens once the expected number is in flight,
 * so overlap is observed instead of guessed with a wall-clock sleep.
 */
function stubBatchScorer(options: { expectedInFlight?: number } = {}) {
	const sizes: number[] = [];
	const expected = options.expectedInFlight ?? 2;
	let inFlight = 0;
	let peak = 0;
	let arrivals = 0;
	const gate = Promise.withResolvers<void>();
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (_input: FetchInput, init?: FetchInit): Promise<Response> => {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				const body = JSON.parse(String(init?.body)) as QuestionBody;
				const questions = body.questions ?? {};
				const keys = Object.keys(questions);
				sizes.push(keys.length);
				arrivals += 1;
				if (arrivals >= expected) gate.resolve();
				await gate.promise;
				inFlight -= 1;
				const answers = Object.fromEntries(
					keys.map(key => [key, { type: "noul", noul: Number(questions[key]?.instructions?.memory) }]),
				);
				return Response.json({ answers });
			},
			{ preconnect: globalThis.fetch.preconnect },
		),
	);
	return {
		sizes,
		get peak() {
			return peak;
		},
	};
}

describe("HindsightRecallDecision scoreBatch", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("splits more than 80 memories across requests, keeping at most two in flight", async () => {
		const stub = stubBatchScorer();
		const scorer = new HindsightRecallDecision({ baseUrl: "http://decision.local", threshold: 0.25 });
		const memories = Array.from({ length: 130 }, (_, index) => String((index + 1) / 100));

		const scores = await scorer.scoreBatch("where is the deploy host?", memories);

		expect(scores).toHaveLength(130);
		expect(scores[0]).toBeCloseTo(0.01, 5);
		expect(scores[129]).toBeCloseTo(1.3, 5);
		expect(stub.sizes.length).toBeGreaterThan(1);
		expect(Math.max(...stub.sizes)).toBeLessThanOrEqual(80);
		expect(stub.peak).toBe(2);
	});

	it("halves a chunk the server rejects for max_tokens and retries each half", async () => {
		const sizes: number[] = [];
		let calls = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_input: FetchInput, init?: FetchInit): Promise<Response> => {
					calls += 1;
					const body = JSON.parse(String(init?.body)) as QuestionBody;
					const questions = body.questions ?? {};
					const keys = Object.keys(questions);
					sizes.push(keys.length);
					if (calls === 1) {
						return Response.json(
							{ detail: { error_type: "max_tokens_exceeded", message: "rendered tokens over limit" } },
							{ status: 400 },
						);
					}
					const answers = Object.fromEntries(
						keys.map(key => [key, { type: "noul", noul: Number(questions[key]?.instructions?.memory) }]),
					);
					return Response.json({ answers });
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const scorer = new HindsightRecallDecision({ baseUrl: "http://decision.local", threshold: 0.25 });
		const memories = Array.from({ length: 80 }, (_, index) => String((index + 1) / 100));

		const scores = await scorer.scoreBatch("where is the deploy host?", memories);

		expect(sizes).toEqual([80, 40, 40]);
		expect(scores).toHaveLength(80);
		expect(scores[0]).toBeCloseTo(0.01, 5);
		expect(scores[79]).toBeCloseTo(0.8, 5);
	});
});

describe("HindsightApi per-op timeouts", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reports the effective per-op deadline in the timeout error", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (): Promise<Response> => {
					throw new DOMException("The operation timed out.", "TimeoutError");
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const client = new HindsightApi({
			baseUrl: "https://hindsight.example",
			timeouts: { reflect: 90_000, recall: 15_000 },
		});

		await expect(client.reflect("bank", "q")).rejects.toThrow("reflect request timed out after 90s");
		await expect(client.recall("bank", "q")).rejects.toThrow("recall request timed out after 15s");
	});

	it("falls back to the client request default for ops without an override", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (): Promise<Response> => {
					throw new DOMException("The operation timed out.", "TimeoutError");
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);
		const client = new HindsightApi({
			baseUrl: "https://hindsight.example",
			timeouts: { request: 45_000 },
		});

		await expect(client.createBank("bank")).rejects.toThrow("createBank request timed out after 45s");
	});
});
