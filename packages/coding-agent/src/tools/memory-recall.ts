import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { countTokens } from "@oh-my-pi/pi-natives";
import { logger, prompt, untilAborted, toError } from "@oh-my-pi/pi-utils";
import type { HindsightApi, ListMemoriesOptions, RecallResult, TagsMatch } from "../hindsight/client";
import { RECALL_SCORE_FLOOR, RECALL_SCORE_FLOOR_RATIO } from "../hindsight/client";
import { isHindsightConfigured, loadHindsightConfig } from "../hindsight/config";
import { formatCurrentTime, formatMemories, mergeRecallTags } from "../hindsight/content";
import type { HindsightSessionState } from "../hindsight/state";
import recallDescription from "../prompts/tools/recall.md" with { type: "text" };
import { sessionMemoryToolRefs } from "../memory-backend/tool-names";
import type { ToolSession } from ".";

import { cfgMemoryBackend } from "../memory-backend/settings";

const memoryRecallSchema = type({
	query: type("string").describe("natural language search query"),
	"budget?": type("'low' | 'mid' | 'high' | 'xhigh' | 'max'").describe(
		"search depth: low = quick lookup, mid = everyday default, high = multi-hop history, xhigh = score ~2400 recall candidates (measured ~32s), max = score all observations plus pending/failed facts (measured ~14s, critical use only, may truncate) (omitted = session setting)",
	),
	"maxTokens?": type("number").describe(
		"tokens of surviving memories to return, clamped to 512..16384 (omitted = session setting)",
	),
	"types?": type("('observation' | 'world' | 'experience')[]").describe(
		"restrict results to these memory types (omitted = session setting)",
	),
	"tags?": type("string[]").describe("additional tag filters merged with the session's recall scope"),
});

const RECALL_MAX_TOKENS_MIN = 512;
const RECALL_MAX_TOKENS_MAX = 16384;

/** Gears that score a whole candidate pool instead of trusting one server-side ranking. */
type DeepRecallGear = "xhigh" | "max";

/** Candidates the `xhigh` gear pulls from the recall trace once the server has ranked them. */
const XHIGH_TRACE_CANDIDATES = 2400;

/** Page size for the bank sweep; one page per round trip keeps the pass a handful of requests. */
const BANK_SWEEP_PAGE_SIZE = 1000;

/** Hard cap on memories the `max` gear scores; the sweep stops there and says so. */
const MAX_BANK_SWEEP_CEILING = 4800;

/** Rows per request when checking whether a collection the ceiling skipped holds unread rows. */
const UNREAD_PROBE_PAGE_SIZE = 200;

/** Rows the unread check may read before it reports truncation rather than proving the collection is duplicate. */
const UNREAD_PROBE_ROW_BUDGET = 2000;

/**
 * Default `max` collections. Consolidated observations carry the durable beliefs, so they come
 * first; `pending` and `failed` catch raw facts that have not folded into an observation yet.
 * Sweeping the raw `world`/`experience` rows instead would re-score what observations already say.
 */
const MAX_SWEEP_COLLECTIONS: readonly ListMemoriesOptions[] = [
	{ type: "observation" },
	{ consolidationState: "pending" },
	{ consolidationState: "failed" },
];

/** Per-call return size, clamped into the documented window instead of rejected. */
function clampRecallMaxTokens(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	return Math.min(RECALL_MAX_TOKENS_MAX, Math.max(RECALL_MAX_TOKENS_MIN, Math.round(value)));
}

interface BankSweep {
	tags?: string[];
	tagsMatch?: TagsMatch;
	seen: Set<string>;
	candidates: RecallResult[];
}

interface BankSweepResult {
	candidates: RecallResult[];
	/** The ceiling stopped the sweep while a collection still had unread rows. */
	truncated: boolean;
}

/** Page one `memories/list` collection, deduping into the shared union; true when more rows remain. */
async function sweepCollection(
	client: HindsightApi,
	bankId: string,
	filter: ListMemoriesOptions,
	sweep: BankSweep,
	signal?: AbortSignal,
): Promise<boolean> {
	let offset = 0;
	let hasMore = true;
	while (hasMore && sweep.candidates.length < MAX_BANK_SWEEP_CEILING) {
		const limit = Math.min(BANK_SWEEP_PAGE_SIZE, MAX_BANK_SWEEP_CEILING - sweep.candidates.length);
		const page = await client.listMemories(bankId, {
			...filter,
			tags: sweep.tags,
			tagsMatch: sweep.tagsMatch,
			limit,
			offset,
			signal,
		});
		const items = page.items ?? [];
		for (const item of items) {
			if (sweep.seen.has(item.id)) continue;
			sweep.seen.add(item.id);
			sweep.candidates.push({
				id: item.id,
				text: item.text,
				type: item.fact_type ?? undefined,
				tags: item.tags,
				metadata: item.metadata,
				mentioned_at: item.mentioned_at,
			});
		}
		offset += items.length;
		if (items.length < limit) {
			hasMore = false;
			continue;
		}
		if (page.total !== undefined) {
			hasMore = offset < page.total;
			continue;
		}
		const probe = await client.listMemories(bankId, {
			...filter,
			tags: sweep.tags,
			tagsMatch: sweep.tagsMatch,
			limit: 1,
			offset,
			signal,
		});
		hasMore = (probe.items ?? []).length > 0;
	}
	return hasMore;
}

/**
 * Any row left in a collection the cap never reached means the sweep stopped short. Walk the
 * collection until an id absent from `sweep.seen` appears, a short page ends it, or the row budget
 * is spent. A collection that is entirely duplicates adds nothing when read, but the budget cannot
 * prove that beyond its bound, so exhausting it reports truncation: a possibly-unnecessary warning
 * is cheaper than silently dropping a raw fact the gear promised to score.
 */
async function hasUnreadRows(
	client: HindsightApi,
	bankId: string,
	filters: readonly ListMemoriesOptions[],
	sweep: BankSweep,
	signal?: AbortSignal,
): Promise<boolean> {
	for (const filter of filters) {
		let offset = 0;
		let read = 0;
		while (read < UNREAD_PROBE_ROW_BUDGET) {
			const limit = Math.min(UNREAD_PROBE_PAGE_SIZE, UNREAD_PROBE_ROW_BUDGET - read);
			const page = await client.listMemories(bankId, {
				...filter,
				tags: sweep.tags,
				tagsMatch: sweep.tagsMatch,
				limit,
				offset,
				signal,
			});
			const items = page.items ?? [];
			if (items.some(item => !sweep.seen.has(item.id))) return true;
			read += items.length;
			offset += items.length;
			if (items.length < limit) break;
		}
		if (read >= UNREAD_PROBE_ROW_BUDGET) return true;
	}
	return false;
}

/**
 * Sweep the bank through `memories/list` instead of a ranked recall: the union of every requested
 * collection, deduped by id, capped at the ceiling. Truncation is reported when the cap cut a
 * collection short, or when an unvisited collection holds rows the bounded probe could not prove
 * were already scored.
 */
async function sweepBankMemories(
	client: HindsightApi,
	bankId: string,
	filters: readonly ListMemoriesOptions[],
	tags: string[] | undefined,
	tagsMatch: TagsMatch | undefined,
	signal?: AbortSignal,
): Promise<BankSweepResult> {
	const sweep: BankSweep = { tags, tagsMatch, seen: new Set<string>(), candidates: [] };
	let truncated = false;
	for (let index = 0; index < filters.length; index++) {
		if (sweep.candidates.length >= MAX_BANK_SWEEP_CEILING) {
			truncated = await hasUnreadRows(client, bankId, filters.slice(index), sweep, signal);
			break;
		}
		const hasMore = await sweepCollection(client, bankId, filters[index]!, sweep, signal);
		if (hasMore) {
			truncated = true;
			break;
		}
	}
	return { candidates: sweep.candidates, truncated };
}

/** Take memories in the given order until the token budget is spent; one oversized memory still fits. */
function packByTokens(candidates: readonly RecallResult[], maxTokens: number): RecallResult[] {
	const packed: RecallResult[] = [];
	let used = 0;
	for (const candidate of candidates) {
		const cost = countTokens(candidate.text);
		if (packed.length > 0 && used + cost > maxTokens) break;
		packed.push(candidate);
		used += cost;
	}
	return packed;
}

export type MemoryRecallParams = typeof memoryRecallSchema.infer;

export class MemoryRecallTool implements AgentTool<typeof memoryRecallSchema> {
	readonly name = "recall";
	readonly approval = "read" as const;
	readonly label = "Recall";
	get description(): string {
		return prompt.render(recallDescription, {
			toolRefs: sessionMemoryToolRefs(this.session),
		});
	}
	readonly parameters = memoryRecallSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search memory for relevant prior context";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRecallTool | null {
		const backend = cfgMemoryBackend.get(session.settings);
		if (backend !== "hindsight" && backend !== "mnemopi") return null;
		if (backend === "hindsight" && !isHindsightConfigured(loadHindsightConfig(session.settings))) return null;
		return new MemoryRecallTool(session);
	}

	async execute(_id: string, params: MemoryRecallParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const backend = cfgMemoryBackend.get(this.session.settings);
			if (backend === "mnemopi") {
				const state = this.session.getMnemopiSessionState?.();
				if (!state) {
					throw new Error("Mnemopi backend is not initialised for this session.");
				}
				try {
					const results = await state.recallResultsScoped(params.query);
					if (results.length === 0) {
						return {
							content: [{ type: "text", text: "No relevant memories found." }],
							details: {},
							useless: true,
						};
					}
					const formatted = state.formatScopedRecallWithIds(results);
					return {
						content: [
							{
								type: "text",
								text: `Found ${results.length} relevant ${results.length === 1 ? "memory" : "memories"} (as of ${formatCurrentTime()} UTC):\n\n${formatted}`,
							},
						],
						details: {},
					};
				} catch (err) {
					logger.warn("recall failed", { backend: "mnemopi", bank: state.config.bank, error: String(err) });
					throw toError(err);
				}
			}

			const state = this.session.getHindsightSessionState?.();
			if (!state) {
				throw new Error("Hindsight backend is not initialised for this session.");
			}

			try {
				if (params.budget === "xhigh" || params.budget === "max") {
					return await this.#executeDeepGear(state, params, params.budget, signal);
				}
				const response = await state.client.recall(state.bankId, params.query, {
					budget: params.budget ?? state.config.recallBudget,
					maxTokens: clampRecallMaxTokens(params.maxTokens) ?? state.config.recallMaxTokens,
					types: params.types ?? (state.config.recallTypes.length > 0 ? state.config.recallTypes : undefined),
					tags: mergeRecallTags(state.recallTags, params.tags),
					tagsMatch: state.recallTagsMatch,
				});
				let results = response.results ?? [];
				if (results.length === 1 && !(await state.keepLoneRecallSurvivor(params.query, results[0]!.text, signal))) {
					results = [];
				}
				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No relevant memories found." }],
						details: {},
						useless: true,
					};
				}
				const formatted = formatMemories(results);
				return {
					content: [
						{
							type: "text",
							text: `Found ${results.length} relevant ${results.length === 1 ? "memory" : "memories"} (as of ${formatCurrentTime()} UTC):\n\n${formatted}`,
						},
					],
					details: {},
				};
			} catch (err) {
				logger.warn("recall failed", { bankId: state.bankId, error: String(err) });
				throw toError(err);
			}
		});
	}

	/**
	 * Deep gears score a whole candidate pool instead of trusting one server-side ranking.
	 * `xhigh` asks the server for a `high`-budget recall plus its RRF trace and scores the top
	 * candidates; `max` skips recall entirely and sweeps the bank through `memories/list`.
	 */
	async #executeDeepGear(
		state: HindsightSessionState,
		params: MemoryRecallParams,
		gear: DeepRecallGear,
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		const config = state.config;
		const maxTokens = clampRecallMaxTokens(params.maxTokens) ?? config.recallMaxTokens;
		const tags = mergeRecallTags(state.recallTags, params.tags);
		let candidates: RecallResult[];
		let truncated = false;
		if (gear === "xhigh") {
			const response = await state.client.recall(state.bankId, params.query, {
				budget: "high",
				trace: true,
				maxTokens: RECALL_MAX_TOKENS_MAX,
				types: params.types ?? (config.recallTypes.length > 0 ? config.recallTypes : undefined),
				tags,
				tagsMatch: state.recallTagsMatch,
				signal,
			});
			candidates = (response.trace?.rrf_merged ?? []).slice(0, XHIGH_TRACE_CANDIDATES).map(candidate => ({
				id: candidate.node_id,
				text: candidate.text,
			}));
		} else {
			const filters =
				params.types && params.types.length > 0
					? params.types.map(item => ({ type: item }))
					: MAX_SWEEP_COLLECTIONS;
			const sweep = await sweepBankMemories(
				state.client,
				state.bankId,
				filters,
				tags,
				state.recallTagsMatch,
				signal,
			);
			candidates = sweep.candidates;
			truncated = sweep.truncated;
		}
		return this.#packDeepResults(
			state,
			params.query,
			candidates,
			{ maxTokens, truncated, swept: gear === "max" },
			signal,
		);
	}

	/** Score the candidates, drop what falls under the deep floor, then pack into the token budget. */
	async #packDeepResults(
		state: HindsightSessionState,
		query: string,
		candidates: RecallResult[],
		options: { maxTokens: number; truncated: boolean; swept: boolean },
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		const notes: string[] = [];
		if (options.truncated) {
			notes.push(
				`Deep recall truncated: swept the first ${MAX_BANK_SWEEP_CEILING} memories; some rows were left unread.`,
			);
		}
		const scorer = state.recallScorer;
		let scores: (number | null)[] | undefined;
		if (scorer && candidates.length > 0) {
			try {
				scores = await scorer.scoreBatch(
					query,
					candidates.map(candidate => candidate.text),
					signal,
				);
			} catch (err) {
				logger.warn("deep recall scoring failed", { bankId: state.bankId, error: String(err) });
			}
		}
		const answered = scores?.filter((score): score is number => score !== null) ?? [];
		if (scores && answered.length === 0) scores = undefined;
		let ordered = candidates;
		if (!scores) {
			notes.push(
				`Scoring unavailable: ${candidates.length} candidates below are unscored, in ${options.swept ? "bank" : "recall"} order.`,
			);
		} else {
			const unscored = scores.filter(score => score === null).length;
			const best = Math.max(...answered);
			if (best < state.config.decisionModelThreshold) {
				const text =
					unscored > 0
						? `No relevant memories found. ${unscored} candidates could not be scored.`
						: "No relevant memories found.";
				return { content: [{ type: "text", text }], details: {}, useless: true };
			}
			if (unscored > 0) notes.push(`${unscored} candidates could not be scored.`);
			const floor = Math.max(RECALL_SCORE_FLOOR, RECALL_SCORE_FLOOR_RATIO * best);
			ordered = candidates
				.map((candidate, index) => ({ candidate, score: scores[index] ?? null }))
				.filter(
					(entry): entry is { candidate: RecallResult; score: number } =>
						entry.score !== null && entry.score >= floor,
				)
				.sort((left, right) => right.score - left.score)
				.map(({ candidate }) => candidate);
		}
		const packed = packByTokens(ordered, options.maxTokens);
		if (packed.length === 0) {
			return { content: [{ type: "text", text: "No relevant memories found." }], details: {}, useless: true };
		}
		const header = `Found ${packed.length} relevant ${packed.length === 1 ? "memory" : "memories"} (as of ${formatCurrentTime()} UTC):`;
		return {
			content: [{ type: "text", text: [header, ...notes, formatMemories(packed)].join("\n\n") }],
			details: { truncated: options.truncated },
		};
	}
}
