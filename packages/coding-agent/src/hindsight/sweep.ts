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

/** Recall depth ladder; the deep gears score a whole pool instead of trusting one server ranking. */
export type RecallGear = "low" | "mid" | "high" | "xhigh" | "max";

/**
 * Memories each gear reads before it stops sweeping. A scope that does not fit hands off to the
 * server's ranked recall instead of reading past the cap.
 */
export const GEAR_SWEEP_CAPS: Readonly<Record<RecallGear, number>> = {
	low: 300,
	mid: 600,
	high: 1200,
	xhigh: 2400,
	max: 4800,
};

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
	if (prefersObservations && (types.length === 0 || defaultTypes)) return MAX_SWEEP_COLLECTIONS;
	return types.length > 0 ? types.map(type => ({ type })) : MAX_SWEEP_COLLECTIONS;
}

/**
 * Page one `memories/list` collection, deduping into the shared union; true when more rows remain.
 * With `bailOnOverflow`, a page whose reported total would push the union past the ceiling stops
 * the sweep before its items are read, so the caller can hand the whole scope to a ranked recall.
 */
async function sweepCollection(
	client: HindsightClientApi,
	bankId: string,
	filter: ListMemoriesOptions,
	sweep: BankSweep,
	alreadyCollected: number,
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
		if (sweep.bailOnOverflow && page.total !== undefined && alreadyCollected + page.total > sweep.ceiling) {
			return true;
		}
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
	client: HindsightClientApi,
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
	};
	let truncated = false;
	for (let index = 0; index < filters.length; index++) {
		if (sweep.candidates.length >= sweep.ceiling) {
			truncated = await hasUnreadRows(client, bankId, filters.slice(index), sweep, signal);
			break;
		}
		const alreadyCollected = sweep.candidates.length;
		const hasMore = await sweepCollection(client, bankId, filters[index]!, sweep, alreadyCollected, signal);
		if (hasMore) {
			truncated = true;
			break;
		}
	}
	return { candidates: sweep.candidates, truncated };
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
