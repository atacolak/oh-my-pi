/**
 * Shared bank-sweep primitives for Hindsight recall.
 *
 * Every recall surface (`recallForContext`'s hidden `<memories>` refresh and the `recall` tool)
 * reads the whole in-scope bank through `memories/list` when the scope fits under its gear
 * ceiling, then scores and packs those candidates itself. Keeping the ceiling ladder, the
 * collection filter, the sweep, and the token packer here is what stops the two surfaces from
 * drifting into two different definitions of "the whole scope".
 */

import { countTokens } from "@oh-my-pi/pi-natives";
import type { HindsightClientApi, ListMemoriesOptions, RecallResult, TagsMatch } from "./client";
import type { HindsightConfig } from "./config";
import { HINDSIGHT_RECALL_TYPES_DEFAULT } from "./settings";
import { GEAR_SWEEP_CAPS, type RecallGear, recallSweepCeiling } from "./recall-budget";

export { GEAR_SWEEP_CAPS, type RecallGear, SWEEP_CROSSOVER } from "./recall-budget";

export interface RecallCandidatePool {
	candidates: RecallResult[];
	mode: "swept" | "shortlisted";
	totalAvailable: number | null;
}

/** Both recall surfaces use the same depth ceiling and ranked shortlist. */
export async function loadRecallCandidates(
	client: HindsightClientApi,
	bankId: string,
	query: string,
	config: HindsightConfig,
	options: {
		gear: RecallGear;
		tags: string[] | undefined;
		tagsMatch: TagsMatch | undefined;
		types?: string[];
		canScore: boolean;
		rankedOnly?: boolean;
	},
	signal?: AbortSignal,
): Promise<RecallCandidatePool> {
	let totalAvailable: number | null = null;
	if (!options.rankedOnly && (options.canScore || options.gear === "max")) {
		const sweep = await sweepBankMemories(
			client,
			bankId,
			resolveSweepCollections(options.types, config),
			options.tags,
			options.tagsMatch,
			{
				ceiling: recallSweepCeiling(options.gear),
				bailOnOverflow: true,
			},
			signal,
		);
		totalAvailable = sweep.distinctTotalAvailable;
		if (!sweep.truncated) return { candidates: sweep.candidates, mode: "swept", totalAvailable };
	}
	const response = await client.recall(bankId, query, {
		budget: "high",
		maxTokens: 16384,
		trace: true,
		types: options.types ?? (config.recallTypes.length > 0 ? config.recallTypes : undefined),
		tags: options.tags,
		tagsMatch: options.tagsMatch,
		preferObservations: config.recallPreferObservations,
		rerank: { prune: config.recallPrune, dedup: config.recallDedup },
		signal,
	});
	const candidates =
		response.trace?.rrf_merged?.map(candidate => ({ id: candidate.node_id, text: candidate.text })) ??
		response.results ??
		[];
	return { candidates: candidates.slice(0, GEAR_SWEEP_CAPS[options.gear]), mode: "shortlisted", totalAvailable };
}

/** Page size for the bank sweep; one page per round trip keeps the pass a handful of requests. */
const BANK_SWEEP_PAGE_SIZE = 1000;

/** Rows per request when checking whether a collection the ceiling skipped holds unread rows. */
const UNREAD_PROBE_PAGE_SIZE = 200;

/** Rows the unread check may read before it reports truncation rather than proving the collection is duplicate. */
const UNREAD_PROBE_ROW_BUDGET = 2000;

/**
 * Collections swept when the scope prefers consolidated observations. Observations carry the
 * durable beliefs, so they come first; `pending` and `failed` catch raw facts that have not folded
 * into an observation yet. Sweeping the raw `world`/`experience` rows instead would re-score what
 * observations already say.
 */
export const MAX_SWEEP_COLLECTIONS: readonly ListMemoriesOptions[] = [
	{ type: "observation" },
	{ consolidationState: "pending" },
	{ consolidationState: "failed" },
];

/** How much of the bank a gear wants, and whether an oversized scope is worth paging at all. */
export interface SweepOptions {
	ceiling: number;
	bailOnOverflow?: boolean;
}

export interface BankSweepResult {
	candidates: RecallResult[];
	/** Sum of first-page collection totals; collections may overlap. */
	totalAvailable: number;
	/** False when a full first page omitted its total, so the sum is only a lower bound. */
	totalAvailableExact: boolean;
	/** Exact distinct union when exhausted, or a known single-collection total; otherwise unknown. */
	distinctTotalAvailable: number | null;
	/** The ceiling stopped the sweep while a collection still had unread rows. */
	truncated: boolean;
}

interface BankSweep {
	tags?: string[];
	tagsMatch?: TagsMatch;
	ceiling: number;
	/** Stop on the page that proves the scope outgrows the ceiling instead of reading to the cap. */
	bailOnOverflow: boolean;
	seen: Set<string>;
	candidates: RecallResult[];
	totalAvailable: number;
	totalAvailableExact: boolean;
	nonEmptyCollections: number;
	countedCollections: Set<ListMemoriesOptions>;
}

/**
 * Collections one sweep reads. An explicit caller filter wins. Otherwise the session's configured
 * types decide: the default scope pairs `world`/`experience` with the recall endpoint's
 * `preferObservations` substitution, which `memories/list` has no equivalent of, so it must sweep
 * the consolidated set instead of re-reading the raw rows observations already replace.
 */
export function resolveSweepCollections(
	requestedTypes: readonly string[] | undefined,
	config: Pick<HindsightConfig, "recallTypes" | "recallPreferObservations">,
): readonly ListMemoriesOptions[] {
	if (requestedTypes && requestedTypes.length > 0) return requestedTypes.map(type => ({ type }));
	const types = config.recallTypes.map(type => type.trim()).filter(Boolean);
	const prefersObservations = config.recallPreferObservations !== false;
	const defaultTypes =
		types.length === HINDSIGHT_RECALL_TYPES_DEFAULT.length &&
		HINDSIGHT_RECALL_TYPES_DEFAULT.every(type => types.includes(type));
	const observationsOnly = types.length === 1 && types[0] === "observation";
	if (prefersObservations && (types.length === 0 || defaultTypes || observationsOnly)) return MAX_SWEEP_COLLECTIONS;
	return types.length > 0 ? types.map(type => ({ type })) : MAX_SWEEP_COLLECTIONS;
}

/**
 * Page one `memories/list` collection, deduping into the shared union; true when more rows remain.
 * With `bailOnOverflow`, a collection individually larger than the ceiling stops immediately.
 * Collection totals cannot be added to prove overflow because their ids may overlap.
 */
async function sweepCollection(
	client: HindsightClientApi,
	bankId: string,
	filter: ListMemoriesOptions,
	sweep: BankSweep,
	signal?: AbortSignal,
): Promise<boolean> {
	let offset = 0;
	let hasMore = true;
	while (hasMore && sweep.candidates.length < sweep.ceiling) {
		const limit = Math.min(BANK_SWEEP_PAGE_SIZE, sweep.ceiling - sweep.candidates.length);
		const page = await client.listMemories(bankId, {
			...filter,
			tags: sweep.tags,
			tagsMatch: sweep.tagsMatch,
			limit,
			offset,
			signal,
		});
		const items = page.items ?? [];
		if (offset === 0 && !sweep.countedCollections.has(filter)) {
			sweep.totalAvailable += page.total ?? items.length;
			if ((page.total ?? items.length) > 0) sweep.nonEmptyCollections++;
			if (page.total === undefined && items.length >= limit) sweep.totalAvailableExact = false;
			sweep.countedCollections.add(filter);
		}
		if (sweep.bailOnOverflow && page.total !== undefined && page.total > sweep.ceiling) {
			return true;
		}
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
	client: HindsightClientApi,
	bankId: string,
	filters: readonly ListMemoriesOptions[],
	sweep: BankSweep,
	signal?: AbortSignal,
): Promise<boolean> {
	const budget = Math.max(UNREAD_PROBE_ROW_BUDGET, Number.isFinite(sweep.ceiling) ? sweep.ceiling : 0);
	for (const filter of filters) {
		let offset = 0;
		let read = 0;
		let exhausted = false;
		while (read < budget) {
			const limit = Math.min(UNREAD_PROBE_PAGE_SIZE, budget - read);
			const page = await client.listMemories(bankId, {
				...filter,
				tags: sweep.tags,
				tagsMatch: sweep.tagsMatch,
				limit,
				offset,
				signal,
			});
			const items = page.items ?? [];
			if (offset === 0 && !sweep.countedCollections.has(filter)) {
				sweep.totalAvailable += page.total ?? items.length;
				if ((page.total ?? items.length) > 0) sweep.nonEmptyCollections++;
				if (page.total === undefined && items.length >= limit) sweep.totalAvailableExact = false;
				sweep.countedCollections.add(filter);
			}
			if (items.some(item => !sweep.seen.has(item.id))) return true;
			read += items.length;
			offset += items.length;
			if (items.length < limit || (page.total !== undefined && offset >= page.total)) {
				exhausted = true;
				break;
			}
		}
		if (!exhausted && read >= budget) return true;
	}
	return false;
}

/**
 * Sweep the bank through `memories/list` instead of a ranked recall: the union of every requested
 * collection, deduped by id, capped at the ceiling. Truncation is reported when the cap cut a
 * collection short, or when an unvisited collection holds rows the bounded probe could not prove
 * were already scored. With `bailOnOverflow` the sweep also stops as soon as one page proves the
 * scope outgrows the ceiling.
 */
export async function sweepBankMemories(
	client: HindsightClientApi,
	bankId: string,
	filters: readonly ListMemoriesOptions[],
	tags: string[] | undefined,
	tagsMatch: TagsMatch | undefined,
	options: SweepOptions,
	signal?: AbortSignal,
): Promise<BankSweepResult> {
	const sweep: BankSweep = {
		tags,
		tagsMatch,
		ceiling: options.ceiling,
		bailOnOverflow: options.bailOnOverflow === true,
		seen: new Set<string>(),
		candidates: [],
		totalAvailable: 0,
		totalAvailableExact: true,
		nonEmptyCollections: 0,
		countedCollections: new Set(),
	};
	let truncated = false;
	for (let index = 0; index < filters.length; index++) {
		if (sweep.candidates.length >= sweep.ceiling) {
			truncated = await hasUnreadRows(client, bankId, filters.slice(index), sweep, signal);
			break;
		}
		const hasMore = await sweepCollection(client, bankId, filters[index]!, sweep, signal);
		if (hasMore) {
			truncated =
				sweep.candidates.length >= sweep.ceiling
					? await hasUnreadRows(client, bankId, filters.slice(index), sweep, signal)
					: true;
			break;
		}
	}
	// An overflow may stop before later collections are visited. Read only their
	// first row and reported total so the denominator still covers the scope.
	for (const filter of filters) {
		if (sweep.countedCollections.has(filter)) continue;
		const page = await client.listMemories(bankId, {
			...filter,
			tags,
			tagsMatch,
			limit: 1,
			offset: 0,
			signal,
		});
		sweep.totalAvailable += page.total ?? page.items?.length ?? 0;
		if ((page.total ?? page.items?.length ?? 0) > 0) sweep.nonEmptyCollections++;
		if (page.total === undefined && (page.items?.length ?? 0) >= 1) sweep.totalAvailableExact = false;
		sweep.countedCollections.add(filter);
	}
	return {
		candidates: sweep.candidates,
		truncated,
		totalAvailable: sweep.totalAvailable,
		totalAvailableExact: sweep.totalAvailableExact,
		distinctTotalAvailable: !truncated
			? sweep.candidates.length
			: sweep.totalAvailableExact && sweep.nonEmptyCollections <= 1
				? sweep.totalAvailable
				: null,
	};
}

/** Take memories in the given order until the token budget is spent; one oversized memory still fits. */
export function packByTokens(candidates: readonly RecallResult[], maxTokens: number): RecallResult[] {
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
