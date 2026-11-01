import { afterEach, describe, expect, it, vi } from "bun:test";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";

function captureRequestBodies(): string[] {
	const bodies: string[] = [];
	const fetchMock: typeof globalThis.fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
			bodies.push(String(init?.body ?? ""));
			return new Response("{}", { status: 200 });
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
	return bodies;
}

function firstTimestamp(bodyText: string): string | undefined {
	const body: unknown = JSON.parse(bodyText);
	if (typeof body !== "object" || body === null) return undefined;

	const items = Object.getOwnPropertyDescriptor(body, "items")?.value;
	if (!Array.isArray(items)) return undefined;

	const first = items[0];
	if (typeof first !== "object" || first === null) return undefined;

	const timestamp = Object.getOwnPropertyDescriptor(first, "timestamp")?.value;
	return typeof timestamp === "string" ? timestamp : undefined;
}

describe("HindsightApi timestamp serialization", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("serializes Date timestamps with the local timezone offset", async () => {
		const bodies = captureRequestBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });

		await client.retain("omp", "evening memory", {
			timestamp: new Date(2026, 5, 12, 19, 17, 0),
		});

		const timestamp = firstTimestamp(bodies[0] ?? "{}");
		if (timestamp === undefined) throw new Error("Missing serialized timestamp");
		expect(timestamp).toMatch(/^2026-06-12T19:17:00[+-]\d{2}:\d{2}$/);
		expect(timestamp.endsWith("Z")).toBe(false);
	});

	it("preserves caller-provided timestamp strings", async () => {
		const bodies = captureRequestBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });

		await client.retain("omp", "evening memory", {
			timestamp: "2026-06-12T19:17:00+08:00",
		});

		expect(firstTimestamp(bodies[0] ?? "{}")).toBe("2026-06-12T19:17:00+08:00");
	});
});

/** Fake mental-model list endpoint paging like Hindsight's server (limit default 100, max 1000). */
function serveMentalModels(count: number, { reportTotal }: { reportTotal: boolean }): string[] {
	const urls: string[] = [];
	const models = Array.from({ length: count }, (_, i) => ({ id: `m${i}`, bank_id: "shared", name: `Model ${i}` }));
	const fetchMock: typeof globalThis.fetch = Object.assign(
		async (input: string | URL | Request): Promise<Response> => {
			const url = new URL(String(input));
			urls.push(url.search);
			const limit = Number(url.searchParams.get("limit") ?? 100);
			const offset = Number(url.searchParams.get("offset") ?? 0);
			const items = models.slice(offset, offset + limit);
			return Response.json(reportTotal ? { items, total: count, limit, offset } : { items });
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
	return urls;
}

describe("HindsightApi.listMentalModels pagination", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns models beyond the server's first page", async () => {
		serveMentalModels(2500, { reportTotal: true });
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });

		const { items, total } = await client.listMentalModels("shared", { detail: "metadata" });

		expect(items).toHaveLength(2500);
		expect(total).toBe(2500);
		expect(new Set(items.map(m => m.id)).size).toBe(2500);
		expect(items.at(-1)?.id).toBe("m2499");
	});

	it("terminates on an empty page when the server reports no total (pre-0.9 Hindsight)", async () => {
		const urls = serveMentalModels(2000, { reportTotal: false });
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });

		const { items, total } = await client.listMentalModels("shared");

		expect(items).toHaveLength(2000);
		expect(total).toBe(2000);
		expect(urls).toHaveLength(3);
	});
});

describe("HindsightApi knowledge-base reads", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function mockFetch(status: number, body: unknown, capture: { url?: string; method?: string } = {}) {
		const fetchMock: typeof globalThis.fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				capture.url = String(input);
				capture.method = String(init?.method ?? "GET");
				return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		return capture;
	}

	it("GETs the knowledge-base tree", async () => {
		const capture = mockFetch(200, { roots: [] });
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		await client.getKnowledgeBaseTree("test");
		expect(capture.method).toBe("GET");
		expect(capture.url).toBe("http://hindsight.local/v1/default/banks/test/knowledge-base/tree");
	});

	it("GETs knowledge-base search with query and limit", async () => {
		const capture = mockFetch(200, { results: [], total: 0 });
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		await client.searchKnowledgeBase("test", "architecture", { limit: 50 });
		expect(capture.method).toBe("GET");
		expect(capture.url).toBe(
			"http://hindsight.local/v1/default/banks/test/knowledge-base/search?q=architecture&limit=50",
		);
	});

	it("GETs a knowledge page by id", async () => {
		const capture = mockFetch(200, {
			id: "kp-1",
			name: "Architecture",
			type: "knowledge-page",
			tags: [],
			body: "",
			markdown: "",
		});
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		await client.getKnowledgePage("test", "kp-1");
		expect(capture.method).toBe("GET");
		expect(capture.url).toBe("http://hindsight.local/v1/default/banks/test/knowledge-base/pages/kp-1");
	});

	it("returns null for a 404 knowledge page read", async () => {
		mockFetch(404, { detail: "not found" });
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });
		await expect(client.getKnowledgePage("test", "missing")).resolves.toBeNull();
	});
});
