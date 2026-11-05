import { logger, sanitizeText, truncate } from "@oh-my-pi/pi-utils";
import type { MemoryWriteScope } from "../memory-backend/global-scope";
import {
	findPersistedRecall,
	MEMORY_RECALL_CONTEXT_MESSAGE_TYPE,
	persistRecall,
	type RecalledMemory,
} from "../memory-backend/recall-entry";
import type { MemoryPromptPreparation } from "../memory-backend/types";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { type BankScope, ensureBankExists } from "./bank";
import { HindsightRecallDecision, type HindsightApi, type MemoryItemInput, type UpdateMode } from "./client";
import type { HindsightConfig } from "./config";
import {
	composeRecallQuery,
	formatMemories,
	hasSubstantiveContent,
	type HindsightMessage,
	prepareRetentionTranscript,
	recallMemoryKey,
	sliceLastTurnsByUserBoundary,
	stripMemoryTags,
	truncateRecallQuery,
} from "./content";
import {
	ensureMentalModels,
	MENTAL_MODEL_FIRST_TURN_DEADLINE_MS,
	resolveSeedsForScope,
	tryLoadMentalModelsBlock,
} from "./mental-models";
import { countRetainableUserTurns, extractMessages } from "./transcript";

/** `notice` source of Hindsight recall/retain failures; print mode writes these to stderr. */
export const HINDSIGHT_NOTICE_SOURCE = "Hindsight";

/** Error text for a failure notice: it can carry server response text, so strip terminal controls and bound it. */
function noticeErrorText(errorText: string): string {
	return truncate(sanitizeText(errorText).replace(/\s+/g, " ").trim(), 200);
}

const RETAIN_FLUSH_BATCH_SIZE = 16;
const RETAIN_FLUSH_INTERVAL_MS = 5_000;
const MENTAL_MODEL_LOAD_TIMED_OUT = Symbol("mental-model-load-timed-out");
/** A prompt this short is an acknowledgement, not a question worth asking the bank. */
const TRIVIAL_ACK_MAX_CHARS = 12;
const TRIVIAL_ACK_MAX_WORDS = 3;

/** A compaction that rewrote the transcript, so the next turn asks its question of a new segment. */
function isCommittedCompaction(event: AgentSessionEvent): boolean {
	if (event.type !== "auto_compaction_end" && event.type !== "manual_compaction_end") return false;
	return event.result !== undefined && !event.aborted && !event.skipped;
}

/** Scope retain tags plus write-only provenance tags, deduped in order; undefined when both are empty. */
function mergeRetainWriteTags(
	retainTags: readonly string[] | undefined,
	provenanceTags: readonly string[] | undefined,
): string[] | undefined {
	const merged = [
		...new Set([...(retainTags ?? []), ...(provenanceTags ?? [])].map(tag => tag.trim()).filter(Boolean)),
	];
	return merged.length > 0 ? merged : undefined;
}

interface PendingRetainItem {
	content: string;
	context?: string;
	scope: MemoryWriteScope;
	timestamp: Date;
	/** Bank routing captured at enqueue so a later primary rebuild cannot reroute this item. */
	client: HindsightApi;
	bankId: string;
	retainTags?: string[];
	observationScopes?: string[][];
	banksSet: Set<string>;
	config: HindsightConfig;
}

interface RetainFailure {
	count: number;
	/** `undefined` when the scope has no project tags and every item went in one request. */
	scope: MemoryWriteScope | undefined;
	errorText: string;
}

interface RecallOutcome {
	context: string | null;
	ok: boolean;
	/** Memories this block carries, in the order the model will read them. */
	delivered: RecalledMemory[];
}

export interface HindsightConversationTrackingSnapshot {
	lastRetainedTurn: number;
	closeRetainBaselineTurns: number;
	recallDelivered: boolean;
	recallRefreshRequested: boolean;
	recalledMemoryIds: string[];
	lastRetainedMessageIndex: number;
	cachedTranscript: string;
	lastRetainedPrefixKey: string;
	loadedMessageCount: number;
	loadedPrefixKey: string;
}

export interface HindsightSessionStateOptions {
	/** Session id used for retain-queue metadata. */
	sessionId: string;
	client: HindsightApi;
	bankId: string;
	/** Fully resolved deterministic scope tags (no write-only provenance). */
	resolvedTags?: string[];
	/** Tags on project-scoped retains (transcripts and tool writes) — non-empty in per-project-tagged mode. Global tool writes omit them; provenance is merged only at write time. */
	retainTags?: string[];
	/**
	 * Write-only provenance tags (actor/role) merged into every retain. Never
	 * applied to recall filters or observation scopes, so provenance cannot
	 * narrow what this session can recall.
	 */
	provenanceTags?: string[];
	/** Tag filter applied to every recall/reflect — non-empty in per-project-tagged mode. */
	recallTags?: string[];
	recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	/** Exact deterministic observation consolidation scopes applied to every retain. */
	observationScopes?: string[][];
	config: HindsightConfig;
	session: AgentSession;
	banksSet: Set<string>;
	lastRetainedTurn?: number;
	/** A recall was already delivered for the transcript this state belongs to. */
	recallDelivered?: boolean;
	/** User turns loaded before this process added new activity. */
	closeRetainBaselineTurns?: number;
	/** Retainable messages present at delayed-startup baseline capture. */
	loadedMessageCount?: number;
	/**
	 * Resolves the session episode that backs recall links. Absent unless the
	 * episode substrate is composed into this runtime; a state without it stamps
	 * no `episode_id` and renders no `ep:` footer, never a guessed one.
	 */
	episodeIdFor?: (sessionId: string) => string | null;
	/**
	 * When set, this entry is a subagent alias that reuses the parent's bank,
	 * scope, config, client, and banksSet. Aliases skip auto-recall and
	 * auto-retain — those run on the parent only — but the recall/retain/reflect
	 * tools resolve via the alias so they persist to the same bank as the parent.
	 */
	aliasOf?: HindsightSessionState;
}

/**
 * Debounced batch queue for tool-initiated `retain` calls owned by one
 * Hindsight session state instance.
 *
 * Auto-retain (`HindsightSessionState.retainSession`) is intentionally not
 * routed through this queue — it submits a full transcript as one large item
 * and waits for server-side processing (`async: false`) so the local cursor
 * only advances after that retain is durable.
 */
export class HindsightRetainQueue {
	readonly #state: HindsightSessionState;
	#items: PendingRetainItem[] = [];
	#timer?: NodeJS.Timeout;
	#flushing?: Promise<void>;
	#closed = false;

	constructor(state: HindsightSessionState) {
		this.#state = state;
	}

	get depth(): number {
		return this.#items.length;
	}

	enqueue(content: string, context?: string, scope: MemoryWriteScope = "project"): void {
		if (this.#closed) {
			throw new Error("Hindsight retain queue is closed.");
		}
		// A recalled block is context the model was given, not something it learned.
		// Storing it would let the next recall retrieve and re-deliver the block.
		const stripped = stripMemoryTags(content).trim();
		if (!hasSubstantiveContent(stripped)) return;
		if (scope === "global") this.#state.assertGlobalRetainAvailable();
		const state = this.#state;
		// Global items are retained untagged, which every project's `any`-match recall surfaces. They also carry no
		// project observation scopes: Hindsight tags a request's generated document(s) with the union of item tags, so
		// a project tag or scope on a global item would make document-level reads treat it as project-scoped.
		const global = scope === "global";
		this.#items.push({
			content: stripped,
			context,
			scope,
			timestamp: new Date(),
			client: state.client,
			bankId: state.bankId,
			retainTags: global ? undefined : mergeRetainWriteTags(state.retainTags, state.provenanceTags),
			banksSet: state.banksSet,
			config: state.config,
			observationScopes: global ? undefined : state.observationScopes,
		});
		if (this.#items.length >= RETAIN_FLUSH_BATCH_SIZE) {
			void this.flush();
			return;
		}
		if (!this.#timer) {
			this.#timer = setTimeout(() => {
				void this.flush();
			}, RETAIN_FLUSH_INTERVAL_MS);
			// Don't pin the event loop alive just for a pending retain flush.
			this.#timer.unref?.();
		}
	}

	async flush(): Promise<void> {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}

		if (this.#flushing) {
			// Coalesce: wait for the in-flight flush, then drain anything that
			// landed after it started so we don't strand items.
			await this.#flushing;
			if (this.#items.length > 0) await this.flush();
			return;
		}

		if (this.#items.length === 0) return;

		const items = this.#items.splice(0);
		const flushPromise = this.#doFlush(items);
		this.#flushing = flushPromise;
		try {
			await flushPromise;
		} finally {
			this.#flushing = undefined;
		}
	}

	dispose(): void {
		this.#closed = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#items = [];
	}

	async #doFlush(items: PendingRetainItem[]): Promise<void> {
		const state = this.#state;
		const sessionId = state.sessionId;
		if (state.session.getHindsightSessionState() !== state) {
			// Session went away before we could flush. We can't notify anyone, so
			// log and drop — these are best-effort facts, not transactional writes.
			logger.warn("Hindsight retain queue: session vanished, dropping batch", {
				providerSessionId: sessionId,
				items: items.length,
			});
			return;
		}

		// Route identity is a key, not a run of adjacent items: a global item between two project items must not split
		// them into separate requests. Each group is one request, and its order decides the combined notice wording,
		// so project-tagged groups stay ahead of global ones.
		const routes: PendingRetainItem[][] = [];
		for (const item of items) {
			const route = routes.find(group => sameRetainRoute(group[0]!, item));
			if (route) route.push(item);
			else routes.push([item]);
		}
		routes.sort((a, b) => Number(a[0]?.retainTags === undefined) - Number(b[0]?.retainTags === undefined));
		// One notice per flush, even when several requests failed.
		const failures: RetainFailure[] = [];
		for (const route of routes) {
			const failure = await this.#flushRoute(sessionId, route);
			if (failure) failures.push(failure);
		}
		if (failures.length > 0) this.#notifyRetainFailures(failures);
	}

	async #flushRoute(sessionId: string, items: PendingRetainItem[]): Promise<RetainFailure | undefined> {
		const route = items[0];
		if (!route) return undefined;

		try {
			// Best-effort and self-catching, so it never rejects.
			await ensureBankExists(route.client, route.bankId, route.config, route.banksSet);
			const metadata = this.#state.buildRetainMetadata();
			const batch: MemoryItemInput[] = items.map(item => ({
				content: item.content,
				context: item.context ?? item.config.retainContext,
				metadata,
				tags: item.retainTags,
				timestamp: item.timestamp,
				strategy: item.config.retainStrategy || undefined,
				observationScopes: item.observationScopes,
			}));
			await route.client.retainBatch(route.bankId, batch, { async: true });
			if (route.config.debug) {
				logger.debug("Hindsight retain queue: batch flushed", {
					providerSessionId: sessionId,
					bankId: route.bankId,
					items: items.length,
					tags: route.retainTags,
				});
			}
			return undefined;
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			logger.warn("Hindsight retain queue: batch flush failed", {
				providerSessionId: sessionId,
				bankId: route.bankId,
				items: items.length,
				scope: route.scope,
				error: errorText,
			});
			// `undefined` keeps the wording for an untagged batch that carried every item.
			const scope: MemoryWriteScope | undefined = route.retainTags
				? "project"
				: route.scope === "global"
					? "global"
					: undefined;
			return { count: items.length, scope, errorText };
		}
	}

	#notifyRetainFailures(failures: RetainFailure[]): void {
		const what = failures
			.map(({ count, scope }) => {
				const noun = count === 1 ? "memory" : "memories";
				return `${count} ${scope === "global" ? `global ${noun}` : noun}`;
			})
			.join(" and ");
		const errorText = [...new Set(failures.map(failure => failure.errorText))].join("; ");
		this.#state.session.emitNotice(
			"warning",
			`Memory retention failed for ${what}: ${noticeErrorText(errorText)}`,
			HINDSIGHT_NOTICE_SOURCE,
		);
	}
}

function sameRetainRoute(a: PendingRetainItem, b: PendingRetainItem): boolean {
	if (
		a.client !== b.client ||
		a.bankId !== b.bankId ||
		a.banksSet !== b.banksSet ||
		a.config !== b.config ||
		a.observationScopes !== b.observationScopes
	) {
		return false;
	}
	const aTags = a.retainTags;
	const bTags = b.retainTags;
	if (aTags === bTags) return true;
	if (!aTags || !bTags || aTags.length !== bTags.length) return false;
	for (let i = 0; i < aTags.length; i++) {
		if (aTags[i] !== bTags[i]) return false;
	}
	return true;
}

/**
 * Rolling hash of messages[0, to) for retention-cache validation (see #lastRetainedPrefixKey),
 * continued from `key` = the rolling hash of messages[0, from).
 */
function extendRetentionPrefixKey(key: string, messages: HindsightMessage[], from: number, to: number): string {
	for (let i = from; i < to; i++) {
		const m = messages[i];
		if (m === undefined) break;
		key = Bun.hash(`${key}\u0000${m.role}\u0000${m.content}\u0000${m.timestamp ?? ""}`).toString(36);
	}
	return key;
}

function retentionPrefixKey(messages: HindsightMessage[], count: number): string {
	return extendRetentionPrefixKey("", messages, 0, count);
}

/** Per-session Hindsight runtime state owned by its AgentSession. */
export class HindsightSessionState {
	/** Session id used for retain-queue metadata. */
	sessionId: string;
	#client: HindsightApi;
	#bankId: string;
	/** Fully resolved deterministic scope tags; seeds derive from these, never from write-only provenance. */
	#resolvedTags?: string[];
	/** Tags on project-scoped retains (transcripts and tool writes) — non-empty in per-project-tagged mode. Global tool writes omit them; provenance is merged only at write time. */
	#retainTags?: string[];
	/**
	 * Write-only provenance tags for this state's own writes. Deliberately not
	 * delegated through `aliasOf`: a subagent stamps its own role on retained
	 * facts even though it shares the parent's scope and client.
	 */
	#provenanceTags?: string[];
	/** Tag filter applied to every recall/reflect — non-empty in per-project-tagged mode. */
	#recallTags?: string[];
	#recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	#observationScopes?: string[][];
	#config: HindsightConfig;
	session: AgentSession;
	#banksSet: Set<string>;
	lastRetainedTurn: number;
	#lastRetainedMessageIndex: number = 0;
	#cachedTranscript: string = "";
	// Rolling hash of ALL messages in [0, #lastRetainedMessageIndex) at cache
	// time. The incremental full-session cache assumes the branch is append-only;
	// a rewind, branch switch, compaction, or in-place edit rewrites the prefix
	// without changing the session id. Re-hashing the current prefix at use time
	// makes the cache self-healing: on ANY prefix change (not just the boundary
	// message) we rebuild the full transcript instead of retaining stale content
	// or silently retaining nothing forever. Hashing is orders of magnitude
	// cheaper than the re-formatting this cache avoids.
	#lastRetainedPrefixKey: string = "";
	#retainInFlight: Promise<void> = Promise.resolve();
	#sessionRetainInFlight: Promise<void> = Promise.resolve();
	#retainGeneration = 0;
	#closeRetainBaselineTurns = 0;
	#loadedMessageCount = 0;
	#loadedPrefixKey = "";
	#forceNextRetainReplace = false;
	#lastCompletedLastTurnRetainBySession = new Map<
		string,
		{ messageCount: number; prefixKey: string; userTurns: number }
	>();
	#lastTurnRollbackSessions = new Set<string>();
	/** A recall is in the transcript for the current context, so later turns need no new one. */
	recallDelivered: boolean;
	/** Memories already delivered in this transcript; a refresh never repeats them. */
	readonly recalledMemoryIds = new Set<string>();
	/** A compaction boundary or a genuine retitle asked the next turn to recall afresh. */
	#recallRefreshRequested = false;
	/** Title committed to the session, so a repeated identical rename is not a new question. */
	#committedTitle?: string;
	#unsubscribeSessionName?: () => void;
	#recallGeneration = 0;
	/** Bounded System One vote on a lone recall survivor; unset unless a decision model is configured. */
	#recallDecision?: HindsightRecallDecision;
	/** Cached `<mental_models>` block injected into developer instructions. */
	mentalModelsSnippet?: string;
	/** When the current bootstrap/boundary load settled; gates the first-turn race. */
	mentalModelsLoadedAt?: number;
	/**
	 * In-flight bootstrap or transcript-boundary load. `beforeAgentStartPrompt`
	 * awaits it on the first turn so a timely snapshot lands before generation,
	 * even though startup and transcript transitions remain non-blocking.
	 */
	mentalModelsLoadPromise?: Promise<void>;
	#mentalModelsLoadGeneration = 0;
	unsubscribe?: () => void;
	/**
	 * Releases the `onHindsightScopeChanged` subscription that drives live
	 * rebuilds when `hindsight.bankId` / `bankIdPrefix` / `scoping` change.
	 * Only set on primary states; aliases inherit the parent's subscription.
	 */
	unsubscribeScope?: () => void;
	/**
	 * When this primary is replaced by a live rebuild, aliases still holding
	 * the disposed object follow `#successor` to the currently installed parent.
	 */
	#successor?: HindsightSessionState;
	#aliasOf?: HindsightSessionState;
	#episodeIdFor?: (sessionId: string) => string | null;
	readonly retainQueue: HindsightRetainQueue;

	constructor(options: HindsightSessionStateOptions) {
		this.sessionId = options.sessionId;
		this.#aliasOf = options.aliasOf;
		this.#client = options.client;
		this.#bankId = options.bankId;
		this.#resolvedTags = options.resolvedTags;
		this.#retainTags = options.retainTags;
		this.#provenanceTags = options.provenanceTags;
		this.#recallTags = options.recallTags;
		this.#recallTagsMatch = options.recallTagsMatch;
		this.#observationScopes = options.observationScopes;
		this.#config = options.config;
		this.session = options.session;
		this.#banksSet = options.banksSet;
		this.#episodeIdFor = options.episodeIdFor;
		this.lastRetainedTurn = options.lastRetainedTurn ?? 0;
		this.#lastRetainedMessageIndex = 0;
		this.#cachedTranscript = "";
		this.#lastRetainedPrefixKey = "";
		this.recallDelivered = options.recallDelivered ?? false;
		this.#recallDecision = options.config.decisionModelUrl
			? new HindsightRecallDecision({
					baseUrl: options.config.decisionModelUrl,
					apiKey: options.config.decisionModelApiKey,
					threshold: options.config.decisionModelThreshold,
				})
			: undefined;
		this.retainQueue = new HindsightRetainQueue(this);
		this.#closeRetainBaselineTurns =
			options.closeRetainBaselineTurns ??
			(this.session.sessionManager ? countRetainableUserTurns(this.session.sessionManager) : 0);
		this.#captureLoadedBranchIdentity(options.loadedMessageCount);
	}

	/** Alias states delegate persistence routing to the live primary parent. */
	get aliasOf(): HindsightSessionState | undefined {
		let primary = this.#aliasOf;
		const seen = new Set<HindsightSessionState>();
		while (primary && primary.#successor) {
			if (seen.has(primary)) break;
			seen.add(primary);
			primary = primary.#successor;
		}
		return primary;
	}

	set aliasOf(value: HindsightSessionState | undefined) {
		this.#aliasOf = value;
	}

	get client(): HindsightApi {
		return this.aliasOf ? this.aliasOf.client : this.#client;
	}

	set client(value: HindsightApi) {
		if (this.aliasOf) this.aliasOf.client = value;
		else this.#client = value;
	}

	get bankId(): string {
		return this.aliasOf ? this.aliasOf.bankId : this.#bankId;
	}

	set bankId(value: string) {
		if (this.aliasOf) this.aliasOf.bankId = value;
		else this.#bankId = value;
	}

	get retainTags(): string[] | undefined {
		return this.aliasOf ? this.aliasOf.retainTags : this.#retainTags;
	}

	set retainTags(value: string[] | undefined) {
		if (this.aliasOf) this.aliasOf.retainTags = value;
		else this.#retainTags = value;
	}

	/** Deterministic scope tags shared by the whole alias tree; write-only provenance is never included. */
	get resolvedTags(): string[] | undefined {
		return this.aliasOf ? this.aliasOf.resolvedTags : this.#resolvedTags;
	}

	/** Write-only provenance for this state; never inherited from the aliased parent. */
	get provenanceTags(): string[] | undefined {
		return this.#provenanceTags;
	}

	get recallTags(): string[] | undefined {
		return this.aliasOf ? this.aliasOf.recallTags : this.#recallTags;
	}

	set recallTags(value: string[] | undefined) {
		if (this.aliasOf) this.aliasOf.recallTags = value;
		else this.#recallTags = value;
	}

	get recallTagsMatch(): "any" | "all" | "any_strict" | "all_strict" | undefined {
		return this.aliasOf ? this.aliasOf.recallTagsMatch : this.#recallTagsMatch;
	}

	set recallTagsMatch(value: "any" | "all" | "any_strict" | "all_strict" | undefined) {
		if (this.aliasOf) this.aliasOf.recallTagsMatch = value;
		else this.#recallTagsMatch = value;
	}

	get observationScopes(): string[][] | undefined {
		return this.aliasOf ? this.aliasOf.observationScopes : this.#observationScopes;
	}

	set observationScopes(value: string[][] | undefined) {
		if (this.aliasOf) this.aliasOf.observationScopes = value;
		else this.#observationScopes = value;
	}

	get banksSet(): Set<string> {
		return this.aliasOf ? this.aliasOf.banksSet : this.#banksSet;
	}

	set banksSet(value: Set<string>) {
		if (this.aliasOf) this.aliasOf.banksSet = value;
		else this.#banksSet = value;
	}

	get config(): HindsightConfig {
		return this.aliasOf ? this.aliasOf.config : this.#config;
	}

	set config(value: HindsightConfig) {
		if (this.aliasOf) this.aliasOf.config = value;
		else this.#config = value;
	}

	/** Point aliases still holding this object at the replacement primary. */
	replaceWith(next: HindsightSessionState): void {
		if (next === this) return;
		this.#successor = next;
	}

	/**
	 * Metadata stamped on every retain. `memory_document_id` identifies the document
	 * the write lands in and `episode_id` the session episode it belongs to; both are
	 * omitted when this state cannot know them rather than guessed.
	 */
	buildRetainMetadata(documentId?: string): Record<string, string> {
		const metadata: Record<string, string> = { session_id: this.sessionId };
		if (documentId) metadata.memory_document_id = documentId;
		const episodeId = this.#episodeIdFor?.(this.sessionId);
		if (episodeId) metadata.episode_id = episodeId;
		return metadata;
	}

	setSessionId(sessionId: string): void {
		if (this.sessionId === sessionId) return;
		this.#recallGeneration++;
		this.sessionId = sessionId;
		this.#invalidateRetainCache();
	}

	/** Snapshot retain/recall counters so a failed `/resume` can roll them back. */
	captureConversationTracking(): HindsightConversationTrackingSnapshot {
		return {
			lastRetainedTurn: this.lastRetainedTurn,
			closeRetainBaselineTurns: this.#closeRetainBaselineTurns,
			recallDelivered: this.recallDelivered,
			recallRefreshRequested: this.#recallRefreshRequested,
			recalledMemoryIds: [...this.recalledMemoryIds],
			lastRetainedMessageIndex: this.#lastRetainedMessageIndex,
			cachedTranscript: this.#cachedTranscript,
			lastRetainedPrefixKey: this.#lastRetainedPrefixKey,
			loadedMessageCount: this.#loadedMessageCount,
			loadedPrefixKey: this.#loadedPrefixKey,
		};
	}

	restoreConversationTracking(snapshot: HindsightConversationTrackingSnapshot): void {
		this.lastRetainedTurn = snapshot.lastRetainedTurn;
		this.#closeRetainBaselineTurns = snapshot.closeRetainBaselineTurns;
		this.recallDelivered = snapshot.recallDelivered;
		this.#recallRefreshRequested = snapshot.recallRefreshRequested;
		this.recalledMemoryIds.clear();
		for (const id of snapshot.recalledMemoryIds) this.recalledMemoryIds.add(id);
		this.#loadedMessageCount = snapshot.loadedMessageCount;
		this.#loadedPrefixKey = snapshot.loadedPrefixKey;
		this.#lastTurnRollbackSessions.add(this.sessionId);
		this.#reconcileCompletedLastTurnRetain();
		// Rekeying fences any retain that was already in flight. It may still
		// have reached Hindsight, so a pre-switch append cursor is no longer a
		// trustworthy server boundary after rollback. Rebuild canonically next.
		this.#forceNextRetainReplace = true;
		this.#invalidateRetainCache();
	}

	resetConversationTracking(closeRetainBaselineTurns?: number): void {
		this.#recallGeneration++;
		this.lastRetainedTurn = 0;
		this.recallDelivered = false;
		this.#recallRefreshRequested = false;
		this.recalledMemoryIds.clear();
		this.#closeRetainBaselineTurns =
			closeRetainBaselineTurns ??
			(this.session.sessionManager ? countRetainableUserTurns(this.session.sessionManager) : 0);
		this.#invalidateRetainCache();
		this.#captureLoadedBranchIdentity();
	}

	#invalidateRetainCache(): void {
		this.#retainGeneration++;
		this.#lastRetainedMessageIndex = 0;
		this.#cachedTranscript = "";
		this.#lastRetainedPrefixKey = "";
	}

	#captureLoadedBranchIdentity(loadedMessageCount?: number): void {
		const loaded = this.session.sessionManager ? extractMessages(this.session.sessionManager) : [];
		this.#loadedMessageCount = loadedMessageCount ?? loaded.length;
		this.#loadedPrefixKey = retentionPrefixKey(loaded, this.#loadedMessageCount);
	}

	#recordCompletedLastTurnRetain(sessionId: string, messages: HindsightMessage[]): void {
		const completed = {
			messageCount: messages.length,
			prefixKey: retentionPrefixKey(messages, messages.length),
			userTurns: messages.filter(message => message.role === "user").length,
		};
		this.#lastCompletedLastTurnRetainBySession.set(sessionId, completed);
		if (this.#lastTurnRollbackSessions.has(sessionId)) this.#reconcileCompletedLastTurnRetain();
	}

	#reconcileCompletedLastTurnRetain(): void {
		if (this.config.retainMode !== "last-turn") return;
		if (!this.#lastTurnRollbackSessions.has(this.sessionId)) return;
		const completed = this.#lastCompletedLastTurnRetainBySession.get(this.sessionId);
		if (!completed || !this.session.sessionManager) return;
		const active = extractMessages(this.session.sessionManager);
		if (active.length < completed.messageCount) return;
		if (retentionPrefixKey(active, completed.messageCount) !== completed.prefixKey) return;
		this.lastRetainedTurn = Math.max(this.lastRetainedTurn, completed.userTurns);
		this.#lastTurnRollbackSessions.delete(this.sessionId);
	}

	#scheduleSessionRetain(task: () => Promise<void>): Promise<void> {
		const run = this.#sessionRetainInFlight.then(task, task);
		this.#sessionRetainInFlight = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async waitForSessionRetainIdle(): Promise<void> {
		await this.#sessionRetainInFlight;
	}

	#retainedPrefixDiverged(messages: HindsightMessage[]): boolean {
		if (this.#lastRetainedMessageIndex === 0) return false;
		if (this.#lastRetainedMessageIndex > messages.length) return true;
		return retentionPrefixKey(messages, this.#lastRetainedMessageIndex) !== this.#lastRetainedPrefixKey;
	}

	#sessionHistoryDiverged(messages: HindsightMessage[]): boolean {
		if (this.#retainedPrefixDiverged(messages)) return true;
		// Resume starts with no retained-prefix identity. Detect `/tree` rewinds
		// against the loaded branch so a shorter replacement is not treated as
		// already-retained history.
		if (this.#lastRetainedMessageIndex > 0 || this.#loadedMessageCount === 0) return false;
		if (messages.length < this.#loadedMessageCount) return true;
		return retentionPrefixKey(messages, this.#loadedMessageCount) !== this.#loadedPrefixKey;
	}

	/**
	 * Whether `scope: "global"` is enabled (`hindsight.globalScope`, off by default) and has a destination every
	 * project recalls: untagged memories in the shared bank. `per-project` scoping recalls only the project's own bank,
	 * so a global write there would never surface. Reads this state's config, which a subagent alias copies from its
	 * parent, so tool exposure and enforcement agree even after the live settings change.
	 */
	isGlobalRetainAvailable(): boolean {
		return this.config.globalScope && this.config.scoping !== "per-project";
	}

	/** Throws, naming the reason, unless {@link isGlobalRetainAvailable}. */
	assertGlobalRetainAvailable(): void {
		if (!this.config.globalScope) {
			throw new Error("Hindsight global scope is off; set hindsight.globalScope to true to enable it.");
		}
		if (this.config.scoping === "per-project") {
			throw new Error("Hindsight global scope requires global or per-project-tagged scoping.");
		}
	}

	/** Queues a tool-initiated retain; `scope: "global"` retains it untagged (see {@link assertGlobalRetainAvailable}). */
	enqueueRetain(content: string, context?: string, scope: MemoryWriteScope = "project"): void {
		this.retainQueue.enqueue(content, context, scope);
	}

	async flushRetainQueue(): Promise<void> {
		await this.retainQueue.flush();
	}

	async flushPendingSessionRetain(): Promise<void> {
		if (this.aliasOf) return;
		await this.#scheduleSessionRetain(() => this.#flushPendingSessionRetainLocked());
	}

	async #flushPendingSessionRetainLocked(): Promise<void> {
		if (!this.config.autoRetain) return;
		await this.#retainInFlight;
		const messages = extractMessages(this.session.sessionManager);
		if (messages.length === 0) return;
		const userTurns = messages.filter(m => m.role === "user").length;
		const retainedThrough = Math.max(this.lastRetainedTurn, this.#closeRetainBaselineTurns);
		// Resume starts lastRetainedTurn at 0 even when the transcript already
		// contains history. Treat loaded history as already retained on the close
		// path so idle open/close does not reconsolidate the full document; only
		// a below-cadence tail of new turns is flushed. Last-turn retains still
		// record the retained branch identity so `/tree` rewinds can diverge.
		const prefixDiverged = this.#sessionHistoryDiverged(messages);
		const retainedMessageCount =
			this.#lastRetainedMessageIndex > 0 ? this.#lastRetainedMessageIndex : this.#loadedMessageCount;
		const messageTailPending = messages.length > retainedMessageCount;
		if (userTurns <= retainedThrough && !prefixDiverged && !messageTailPending) return;
		try {
			const generation = this.#retainGeneration;
			const lastTurnWindow =
				this.config.retainMode === "last-turn"
					? Math.max(prefixDiverged ? userTurns : userTurns - retainedThrough, 1) + this.config.retainOverlapTurns
					: undefined;
			await this.retainSession(messages, lastTurnWindow === undefined ? undefined : { lastTurnWindow });
			if (generation === this.#retainGeneration) this.lastRetainedTurn = userTurns;
		} catch (err) {
			logger.warn("Hindsight: session-end retain flush failed", {
				sessionId: this.sessionId,
				bankId: this.bankId,
				error: String(err),
			});
		}
	}

	async drainOnClose(): Promise<void> {
		if (this.aliasOf) return;
		await this.#scheduleSessionRetain(async () => {
			// Reserve the same session-retain barrier as `/memory enqueue`
			// before flushing tool items. Otherwise both callers can finish the
			// shared flush and race while installing their transcript retains.
			await this.flushRetainQueue();
			await this.#flushPendingSessionRetainLocked();
		});
	}

	/** Decide whether a lone recall survivor is worth delivering; unset decision model keeps it. */
	async keepLoneRecallSurvivor(query: string, memory: string, signal?: AbortSignal): Promise<boolean> {
		return this.#recallDecision ? this.#recallDecision.keep(query, memory, signal) : true;
	}

	/** Scorer for the deep recall gears; undefined when no decision model is configured. */
	get recallScorer(): HindsightRecallDecision | undefined {
		return this.aliasOf ? this.aliasOf.recallScorer : this.#recallDecision;
	}

	async recallForContext(query: string, signal?: AbortSignal): Promise<RecallOutcome> {
		const generation = this.#recallGeneration;
		try {
			const response = await this.client.recall(this.bankId, query, {
				budget: this.config.recallBudget,
				maxTokens: this.config.recallMaxTokens,
				types: this.config.recallTypes.length > 0 ? this.config.recallTypes : undefined,
				tags: this.recallTags,
				tagsMatch: this.recallTagsMatch,
				preferObservations: this.config.recallPreferObservations,
				rerank: { prune: this.config.recallPrune, dedup: this.config.recallDedup },
				signal,
			});
			if (signal?.aborted) return { context: null, ok: false, delivered: [] };
			const results = response.results ?? [];
			// Hindsight keeps every candidate above its relevance floor, so a bank with no
			// matching memory still returns one survivor; only a lone result can be a floor
			// artefact. Two results already show a real match cleared the floor.
			if (results.length === 1) {
				if (!(await this.keepLoneRecallSurvivor(query, results[0]!.text, signal))) {
					return { context: null, ok: true, delivered: [] };
				}
				if (signal?.aborted) return { context: null, ok: false, delivered: [] };
			}
			// A refresh exists to surface what the model does not already have. Memories
			// already delivered in this transcript are context it has read.
			const fresh = results.filter(result => !this.recalledMemoryIds.has(recallMemoryKey(result)));
			if (fresh.length === 0) return { context: null, ok: true, delivered: [] };
			const formatted = formatMemories(fresh);
			const block = `<memories>\n${this.config.recallPromptPreamble}\n\n${formatted}\n</memories>`;
			return {
				context: block,
				ok: true,
				delivered: fresh.map(result => ({ id: result.id ?? recallMemoryKey(result), text: result.text })),
			};
		} catch (err) {
			// A cancelled turn (Esc) is not a failure.
			if (signal?.aborted) return { context: null, ok: false, delivered: [] };
			const errorText = err instanceof Error ? err.message : String(err);
			logger.warn("Hindsight: recall failed", { bankId: this.bankId, error: errorText });
			// A conversation reset or session switch since the request makes its failure stale.
			if (this.#recallGeneration === generation) {
				this.session.emitNotice(
					"warning",
					`Memory recall failed: ${noticeErrorText(errorText)}`,
					HINDSIGHT_NOTICE_SOURCE,
				);
			}
			return { context: null, ok: false, delivered: [] };
		}
	}

	#sessionSourceTimestamp(): Date | undefined {
		const header = this.session.sessionManager?.getHeader?.();
		const timestamp = header?.timestamp;
		if (typeof timestamp !== "string") return undefined;
		const trimmed = timestamp.trim();
		if (!trimmed) return undefined;
		const parsed = new Date(trimmed);
		return Number.isNaN(parsed.getTime()) ? undefined : parsed;
	}

	async retainSession(
		messages: HindsightMessage[],
		opts?: { forceReplace?: boolean; lastTurnWindow?: number },
	): Promise<void> {
		const identity = { sessionId: this.sessionId, generation: this.#retainGeneration };
		const run = this.#retainInFlight.then(
			() => this.#retainSessionLocked(messages, opts, identity),
			() => this.#retainSessionLocked(messages, opts, identity),
		);
		this.#retainInFlight = run.then(
			() => undefined,
			() => undefined,
		);
		await run;
	}

	async #retainSessionLocked(
		messages: HindsightMessage[],
		opts: { forceReplace?: boolean; lastTurnWindow?: number } | undefined,
		identity: { sessionId: string; generation: number },
	): Promise<void> {
		const forceReplace = opts?.forceReplace || this.#forceNextRetainReplace;
		if (forceReplace) {
			this.#lastRetainedMessageIndex = 0;
			this.#cachedTranscript = "";
			this.#lastRetainedPrefixKey = "";
		}
		const { sessionId, generation } = identity;
		const retainedAt = new Date();
		const sourceTimestamp = this.#sessionSourceTimestamp() ?? retainedAt;
		const retainFullWindow = this.config.retainMode === "full-session";
		let documentId: string;
		let transcript: string;
		let nextCachedTranscript: string | undefined;
		let updateMode: UpdateMode | undefined;
		let prefixKey = "";
		let hashedThrough = 0;

		if (retainFullWindow) {
			documentId = sessionId;
			const previousBoundary = this.#lastRetainedMessageIndex;
			let rebuiltDivergentPrefix = false;
			if (previousBoundary <= messages.length)
				prefixKey = extendRetentionPrefixKey("", messages, 0, previousBoundary);
			if (previousBoundary > messages.length || prefixKey !== this.#lastRetainedPrefixKey) {
				rebuiltDivergentPrefix = previousBoundary > 0;
				this.#lastRetainedMessageIndex = 0;
				this.#cachedTranscript = "";
				this.#lastRetainedPrefixKey = "";
				prefixKey = "";
			}
			hashedThrough = this.#lastRetainedMessageIndex;
			const start = hashedThrough;
			const newMessages = messages.slice(start);
			const { transcript: newPart } = prepareRetentionTranscript(newMessages, true, { includeTimestamps: true });
			if (!newPart) return;
			nextCachedTranscript = this.#cachedTranscript ? `${this.#cachedTranscript}\n\n${newPart}` : newPart;
			const appendDelta = this.config.retainUpdateMode === "append" && start > 0 && !forceReplace;
			if (appendDelta) {
				transcript = newPart;
				updateMode = "append";
			} else {
				transcript = nextCachedTranscript;
				if (forceReplace || rebuiltDivergentPrefix) updateMode = "replace";
			}
		} else {
			const windowTurns = opts?.lastTurnWindow ?? this.config.retainEveryNTurns + this.config.retainOverlapTurns;
			const target = sliceLastTurnsByUserBoundary(messages, windowTurns);
			documentId = `${sessionId}-${retainedAt.getTime()}`;
			this.#cachedTranscript = "";
			const { transcript: windowTranscript } = prepareRetentionTranscript(target, true, { includeTimestamps: true });
			if (!windowTranscript) return;
			transcript = windowTranscript;
		}

		await ensureBankExists(this.client, this.bankId, this.config, this.banksSet);
		await this.client.retain(this.bankId, transcript, {
			documentId,
			context: this.config.retainContext,
			metadata: this.buildRetainMetadata(documentId),
			tags: mergeRetainWriteTags(this.retainTags, this.provenanceTags),
			observationScopes: this.observationScopes,
			timestamp: sourceTimestamp,
			async: false,
			updateMode,
			strategy: this.config.retainStrategy || undefined,
		});
		if (!retainFullWindow) this.#recordCompletedLastTurnRetain(sessionId, messages);
		if (generation === this.#retainGeneration) {
			if (nextCachedTranscript !== undefined) {
				this.#cachedTranscript = nextCachedTranscript;
				this.#lastRetainedPrefixKey = extendRetentionPrefixKey(prefixKey, messages, hashedThrough, messages.length);
				this.#lastRetainedMessageIndex = messages.length;
			}
			this.#forceNextRetainReplace = false;
		}
	}

	async maybeRetainOnAgentEnd(): Promise<void> {
		const generation = this.#retainGeneration;
		await this.#scheduleSessionRetain(() => this.#maybeRetainOnAgentEndLocked(generation));
	}

	async #maybeRetainOnAgentEndLocked(generation: number): Promise<void> {
		if (!this.config.autoRetain) return;
		// A queued cadence retain can outlive /resume, /new, or a fork. The
		// generation fence after client.retain only skips the cursor write; this
		// check drops the call before it extracts and sends the replacement
		// session's transcript under the new document id.
		if (generation !== this.#retainGeneration) return;
		const messages = extractMessages(this.session.sessionManager);
		if (messages.length === 0) return;
		const userTurns = messages.filter(m => m.role === "user").length;
		if (
			userTurns - this.lastRetainedTurn < this.config.retainEveryNTurns &&
			!this.#sessionHistoryDiverged(messages)
		) {
			return;
		}

		try {
			await this.retainSession(messages);
			if (generation === this.#retainGeneration) this.lastRetainedTurn = userTurns;
			if (this.config.debug) {
				logger.debug("Hindsight: auto-retain succeeded", {
					providerSessionId: this.sessionId,
					bankId: this.bankId,
					userTurns,
					messages: messages.length,
				});
			}
		} catch (err) {
			logger.warn("Hindsight: auto-retain failed", {
				providerSessionId: this.sessionId,
				bankId: this.bankId,
				error: String(err),
			});
		}
	}

	async forceRetainCurrentSession(): Promise<void> {
		const generation = this.#retainGeneration;
		await this.#scheduleSessionRetain(async () => {
			// The command belongs to the session active when it was invoked. If it
			// queued behind another retain and the session changed, do not flush or
			// force-retain the replacement transcript.
			if (generation !== this.#retainGeneration) return;
			// Reserve the session-retain barrier before flushing tool items so a
			// concurrent close cannot schedule a duplicate last-turn document.
			await this.flushRetainQueue();
			if (generation !== this.#retainGeneration) return;
			await this.#forceRetainCurrentSessionLocked(generation);
		});
	}

	async #forceRetainCurrentSessionLocked(generation: number): Promise<void> {
		if (generation !== this.#retainGeneration) return;
		const messages = extractMessages(this.session.sessionManager);
		if (messages.length === 0) return;
		// Forced retains are user-initiated rebuilds (`/memory enqueue`). The
		// incremental cache is dropped inside the serialized retain so an
		// in-flight cadence retain cannot repopulate the cursor and suppress
		// the canonical replace.
		try {
			await this.retainSession(messages, { forceReplace: true });
			if (generation === this.#retainGeneration) {
				this.lastRetainedTurn = messages.filter(m => m.role === "user").length;
			}
		} catch (err) {
			logger.warn("Hindsight: forced retain failed", {
				providerSessionId: this.sessionId,
				bankId: this.bankId,
				error: String(err),
			});
		}
	}

	async beforeAgentStartPrompt(
		promptText: string,
		signal?: AbortSignal,
	): Promise<MemoryPromptPreparation | undefined> {
		if (this.config.mentalModelsEnabled && this.mentalModelsLoadPromise && this.mentalModelsLoadedAt === undefined) {
			await Promise.race([this.mentalModelsLoadPromise, Bun.sleep(MENTAL_MODEL_FIRST_TURN_DEADLINE_MS)]);
		}

		if (!this.config.autoRecall) return undefined;
		const latestPrompt = promptText.trim();
		if (!latestPrompt) return undefined;
		// A boundary cadence recalls once per context epoch: the transcript already carries the
		// delivered block, so only a boundary (compaction, retitle, new transcript) asks the bank
		// again. A per-turn cadence asks every turn, and `recalledMemoryIds` keeps out what the
		// transcript already holds — but an acknowledgement is not a new question.
		if (this.recallDelivered && !this.#recallRefreshRequested) {
			const words = latestPrompt.split(/\s+/).length;
			const trivialAck = latestPrompt.length < TRIVIAL_ACK_MAX_CHARS || words < TRIVIAL_ACK_MAX_WORDS;
			if (this.config.recallCadence !== "per-turn" || trivialAck) return undefined;
		}

		const generation = ++this.#recallGeneration;
		this.#recallRefreshRequested = false;
		this.#seedDeliveredMemories();

		const history = extractMessages(this.session.sessionManager);
		const queryMessages = [...history, { role: "user" as const, content: latestPrompt }];
		const query = composeRecallQuery(latestPrompt, queryMessages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, latestPrompt, this.config.recallMaxQueryChars);
		const { context, ok, delivered } = await this.recallForContext(truncated, signal);
		if (!ok) return undefined;

		return {
			contextEntry: this.#recallEntry(context ?? ""),
			commit: () => this.#commitRecall(generation, context ?? "", delivered),
		};
	}

	/**
	 * Seeds the dedupe set from the transcript's persisted recall so a resumed process
	 * recalls the transcript's next question without repeating what the model has read.
	 */
	#seedDeliveredMemories(): void {
		if (this.recallDelivered) return;
		const persisted = findPersistedRecall(this.session.sessionManager, this.#recallScope());
		if (persisted === undefined) return;
		for (const memory of persisted.memories) this.recalledMemoryIds.add(recallMemoryKey(memory));
	}

	/** The hidden turn entry carrying a recall block; empty content yields no entry. */
	#recallEntry(content: string): MemoryPromptPreparation["contextEntry"] {
		if (!content) return undefined;
		return { customType: MEMORY_RECALL_CONTEXT_MESSAGE_TYPE, content };
	}

	/** Adopts a recall unless a newer turn or reset superseded it; `""` means it found nothing new. */
	#commitRecall(generation: number, context: string, delivered: readonly RecalledMemory[]): boolean {
		if (this.#recallGeneration !== generation) return false;
		this.recallDelivered = true;
		for (const memory of delivered) this.recalledMemoryIds.add(recallMemoryKey(memory));
		// A refresh with nothing new is not a recall: recording it would replace the
		// transcript's recall record with an empty one and lose the resume seed.
		if (context) {
			persistRecall(this.session.sessionManager, this.#recallScope(), { text: context, memories: [...delivered] });
		}
		return true;
	}

	/** Ask the next turn to recall afresh; the delivered block stays in the transcript as history. */
	requestRecallRefresh(): void {
		this.#recallRefreshRequested = true;
	}

	/**
	 * Identifies the server, account, bank and tag filter a recall reads, so a persisted
	 * recall is only reused for the same ones. The account is a hash of the API token.
	 */
	#recallScope(): string {
		return JSON.stringify([
			"hindsight",
			this.config.hindsightApiUrl,
			Bun.hash(this.config.hindsightApiToken ?? "").toString(16),
			this.bankId,
			this.recallTags ?? [],
			this.recallTagsMatch ?? null,
		]);
	}

	async recallForCompaction(messages: HindsightMessage[], signal?: AbortSignal): Promise<string | undefined> {
		const lastUser = messages.findLast(m => m.role === "user");
		if (!lastUser) return undefined;

		const query = composeRecallQuery(lastUser.content, messages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, lastUser.content, this.config.recallMaxQueryChars);
		const { context } = await this.recallForContext(truncated, signal);
		return context ?? undefined;
	}
	async runMentalModelLoad(scope: BankScope): Promise<void> {
		if (!this.config.mentalModelsEnabled) return;
		const generation = ++this.#mentalModelsLoadGeneration;
		const previousSnippet = this.mentalModelsSnippet;
		this.mentalModelsLoadedAt = undefined;

		const bootstrap = (async () => {
			// Create/ensure the bank BEFORE the first mental-model POST so we don't
			// land `createMentalModel` against a bank the server has never seen —
			// that surfaces as a FK / 404 on Hindsight's side. `ensureBankExists`
			// is idempotent (PUT) and skips after the first call via `banksSet`.
			await ensureBankExists(this.client, this.bankId, this.config, this.banksSet);

			// Seeding is opt-in (`hindsight.mentalModelAutoSeed`). Default behaviour is
			// read-only: we surface whatever models the operator has curated on the
			// bank, but we do NOT POST to create new ones unless they explicitly
			// asked. `/memory mm seed` remains the explicit-write entry point.
			if (this.config.mentalModelAutoSeed) {
				const seeds = resolveSeedsForScope(scope, this.config.scoping);
				if (seeds.length > 0) {
					await ensureMentalModels(this.client, this.bankId, seeds, this.config.debug);
				}
			}

			await this.#loadAndPublishMentalModels(generation, previousSnippet, "MM load");
		})();
		await this.#settleMentalModelsLoadWithinDeadline(bootstrap, generation, previousSnippet);
	}

	/**
	 * Starts a bounded reload for a new transcript without blocking the session
	 * transition. A result that misses the first-turn deadline is discarded so
	 * the previous snapshot stays frozen for the whole transcript.
	 */
	beginMentalModelsTranscriptReload(): void {
		if (!this.config.mentalModelsEnabled) return;
		const generation = ++this.#mentalModelsLoadGeneration;
		const previousSnippet = this.mentalModelsSnippet;
		this.mentalModelsLoadedAt = undefined;
		const reload = this.#settleMentalModelsLoadWithinDeadline(
			this.#loadAndPublishMentalModels(generation, previousSnippet, "MM transcript reload"),
			generation,
			previousSnippet,
		).catch(error => {
			if (generation === this.#mentalModelsLoadGeneration) {
				this.mentalModelsSnippet = previousSnippet;
				this.mentalModelsLoadedAt = Date.now();
			}
			logger.debug("Hindsight: mental-model transcript reload failed", { error: String(error) });
		});
		this.mentalModelsLoadPromise = reload;
	}

	async #settleMentalModelsLoadWithinDeadline(
		load: Promise<void>,
		generation: number,
		previousSnippet: string | undefined,
	): Promise<void> {
		const outcome = await Promise.race([
			load,
			Bun.sleep(MENTAL_MODEL_FIRST_TURN_DEADLINE_MS).then(() => MENTAL_MODEL_LOAD_TIMED_OUT),
		]);
		if (outcome !== MENTAL_MODEL_LOAD_TIMED_OUT || generation !== this.#mentalModelsLoadGeneration) return;

		// Invalidate the still-running load before restoring the stable snapshot.
		// SessionTools checks the same generation before committing a prompt build,
		// so a queued publication cannot rewrite the prefix after this deadline.
		this.#mentalModelsLoadGeneration++;
		this.mentalModelsSnippet = previousSnippet;
		this.mentalModelsLoadedAt = Date.now();
	}

	async #loadAndPublishMentalModels(
		generation: number,
		previousSnippet: string | undefined,
		reason: "MM load" | "MM reload" | "MM transcript reload",
	): Promise<void> {
		const result = await tryLoadMentalModelsBlock(
			this.client,
			this.bankId,
			this.config.mentalModelMaxRenderChars,
			this.recallTags,
		);
		if (generation !== this.#mentalModelsLoadGeneration) return;
		if (!result.ok) {
			this.mentalModelsLoadedAt = Date.now();
			return;
		}

		this.mentalModelsSnippet = result.block;
		const published = await this.#refreshBaseSystemPromptAfter(
			reason,
			() => generation === this.#mentalModelsLoadGeneration,
		);
		if (generation !== this.#mentalModelsLoadGeneration) return;
		if (!published) this.mentalModelsSnippet = previousSnippet;
		this.mentalModelsLoadedAt = Date.now();
	}

	async reloadMentalModels(): Promise<boolean> {
		if (this.aliasOf) return false;
		if (!this.config.mentalModelsEnabled) return false;
		const generation = ++this.#mentalModelsLoadGeneration;
		const previousSnippet = this.mentalModelsSnippet;
		await this.#loadAndPublishMentalModels(generation, previousSnippet, "MM reload");
		return generation === this.#mentalModelsLoadGeneration;
	}

	attachSessionListeners(): void {
		this.unsubscribe?.();
		this.#unsubscribeSessionName?.();
		this.#committedTitle = this.session.sessionManager?.getSessionName?.();
		this.#unsubscribeSessionName = this.session.sessionManager?.onSessionNameChanged?.(() => {
			const title = this.session.sessionManager.getSessionName?.();
			if (title === this.#committedTitle) return;
			this.#committedTitle = title;
			this.requestRecallRefresh();
		});
		this.unsubscribe = this.session.subscribe(event => {
			if (isCommittedCompaction(event)) {
				// The pre-compaction recall answered the pre-compaction question. Refresh so the
				// next turn recalls against the transcript it now has; the delivered block stays
				// in history as the memory the model already read.
				this.requestRecallRefresh();
			}
			if (event.type === "agent_end") {
				void this.maybeRetainOnAgentEnd();
				// Drain any queued tool-initiated retain calls now that the turn
				// is settled. The queue is also debounced/size-bounded, but
				// flushing here keeps the bank fresh between turns.
				void this.flushRetainQueue();
				// Mental models are deliberately NOT re-listed here. Rewriting the
				// cached <mental_models> block mid-session changes the base system
				// prompt bytes and busts the provider prompt-cache prefix (#11961).
				// The block is frozen for the current transcript — like local-memory
				// guidance after #3745 — so a background reflect applies when the
				// next transcript/session boundary reloads it. `/memory mm reload`
				// stays the explicit in-session invalidation.
			}
		});
	}

	dispose(): void {
		this.#recallGeneration++;
		this.#mentalModelsLoadGeneration++;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.#unsubscribeSessionName?.();
		this.#unsubscribeSessionName = undefined;
		this.retainQueue.dispose();
	}

	async #refreshBaseSystemPromptAfter(
		reason: "MM load" | "MM reload" | "MM transcript reload",
		commitIf?: () => boolean,
	): Promise<boolean> {
		try {
			await this.session.refreshBaseSystemPrompt(commitIf);
			return !commitIf || commitIf();
		} catch (err) {
			logger.debug(`Hindsight: refreshBaseSystemPrompt after ${reason} failed`, { error: String(err) });
			return false;
		}
	}
}
