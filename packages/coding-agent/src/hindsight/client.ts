/**
 * Minimal fetch-based client for the Hindsight HTTP API.
 *
 * Replaces the `@vectorize-io/hindsight-client` SDK with hand-rolled fetch
 * calls so we depend on nothing more than the API endpoints we actually use:
 * `retain`, `retainBatch`, `recall`, `reflect`, bank + document management,
 * and bulk listing. Centralising construction here keeps a single seam for
 * tests to spy on.
 */

import { countTokens } from "@oh-my-pi/pi-natives";
import { USER_AGENT, truncate, tryParseJson } from "@oh-my-pi/pi-utils";
import { isTimeoutError, withTimeoutSignal } from "../utils/fetch-timeout";
import type { HindsightConfig } from "./config";

const DEFAULT_USER_AGENT = USER_AGENT;
/** Fallback deadlines (ms) applied when the caller supplies no override. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_REFLECT_TIMEOUT_MS = 120_000;
const DEFAULT_RECALL_TIMEOUT_MS = 30_000;
const DEFAULT_RETAIN_TIMEOUT_MS = 60_000;
/** Server-side maximum `limit` on the mental-model list endpoint; keeps typical banks to one request. */
const MENTAL_MODEL_PAGE_SIZE = 1000;
/** Cap on server-supplied error text copied into `HindsightError.message` (logged unconditionally). */
const MAX_ERROR_DETAIL_CHARS = 2000;
/** System One decision model that votes on a lone recall survivor. */
const DECISION_MODEL_ID = "hs-decide-1-flash";
/** A dead local decision service must not stall a turn. */
const DEFAULT_DECISION_TIMEOUT_MS = 2_000;
const DECISION_TASK =
	"Showing this memory to someone answering the question would help them, rather than distract them.";

/** Server-side recall depth; the deep gears translate into these, never forward to the client. */
export type Budget = "low" | "mid" | "high";
export type TagsMatch = "any" | "all" | "any_strict" | "all_strict";
export type UpdateMode = "replace" | "append";
export type ConsolidationState = "failed" | "pending" | "done";

/** Per-operation request deadlines (ms). Each falls back to a built-in default. */
export interface HindsightTimeouts {
	/** Default deadline for ops without a specific override. */
	request?: number;
	reflect?: number;
	recall?: number;
	retain?: number;
}

export interface HindsightApiOptions {
	baseUrl: string;
	apiKey?: string;
	userAgent?: string;
	/** Per-op deadlines; unset entries fall back to built-in defaults. */
	timeouts?: HindsightTimeouts;
}

/** Caller cancellation shared by Hindsight request option bags. */
export interface HindsightRequestOptions {
	signal?: AbortSignal;
}

export interface RecallResult {
	id?: string;
	text: string;
	type?: string | null;
	mentioned_at?: string | null;
	[key: string]: unknown;
}

/** One entry of the server's RRF trace: the ranked candidate list behind a recall. */
export interface RecallTraceCandidate {
	node_id: string;
	text: string;
	rrf_score?: number;
	source_ranks?: unknown;
	final_rrf_rank?: number;
}

export interface RecallTrace {
	rrf_merged?: RecallTraceCandidate[];
}

export interface RecallResponse {
	results: RecallResult[];
	trace?: RecallTrace;
	[key: string]: unknown;
}

export interface ReflectResponse {
	text?: string;
	[key: string]: unknown;
}

export interface RetainResponse {
	[key: string]: unknown;
}

export interface BankProfileResponse {
	[key: string]: unknown;
}

export interface ListMemoryItem {
	id: string;
	text: string;
	/** Wire name of the recall `type` field. */
	fact_type?: string | null;
	tags?: string[];
	metadata?: Record<string, unknown> | null;
	mentioned_at?: string | null;
}

export interface ListMemoriesResponse {
	items: ListMemoryItem[];
	total?: number;
	limit?: number;
	offset?: number;
}

/** One source memory behind a consolidated memory, as `GET /memories/{id}` reports it. */
export interface HindsightMemorySource {
	id?: string;
	text?: string;
	type?: string | null;
	context?: string | null;
	mentioned_at?: string | null;
}

/** A single memory unit with its provenance: the shape `GET /v1/default/banks/{bank_id}/memories/{id}` returns. */
export interface HindsightMemoryUnit {
	id: string;
	text: string;
	type?: string | null;
	fact_type?: string | null;
	date?: string | null;
	mentioned_at?: string | null;
	tags?: string[] | null;
	metadata?: Record<string, unknown> | null;
	history?: Record<string, unknown>[] | null;
	source_memories?: HindsightMemorySource[] | null;
}

export interface DocumentResponse {
	[key: string]: unknown;
}

export interface ListDocumentsResponse {
	[key: string]: unknown;
}

/** Mirrors the shape accepted by `POST /v1/default/banks/{bank_id}/memories`. */
export interface MemoryItemInput {
	content: string;
	timestamp?: Date | string;
	context?: string;
	metadata?: Record<string, string>;
	documentId?: string;
	tags?: string[];
	/** Scoping policy for observations derived from this item. */
	observationScopes?: "per_tag" | "combined" | "all_combinations" | string[][];
	/** Per-item extraction strategy override. */
	strategy?: string;
	updateMode?: UpdateMode;
}

export interface RetainOptions extends HindsightRequestOptions {
	timestamp?: Date | string;
	context?: string;
	metadata?: Record<string, string>;
	documentId?: string;
	async?: boolean;
	tags?: string[];
	/** Exact deterministic observation consolidation scopes for this item. */
	observationScopes?: string[][];
	updateMode?: UpdateMode;
	/** Per-item extraction strategy override. Omitted from the body when unset. */
	strategy?: string;
}

export interface RetainBatchOptions extends HindsightRequestOptions {
	/** Document id applied to every item that doesn't carry its own. */
	documentId?: string;
	/** Tags attached to the resulting document(s), not individual items. */
	documentTags?: string[];
	async?: boolean;
}

export interface RecallOptions extends HindsightRequestOptions {
	types?: string[];
	maxTokens?: number;
	budget?: Budget;
	tags?: string[];
	tagsMatch?: TagsMatch;
	/** Drop raw facts an observation already supersedes; no effect unless observations are recalled too. */
	preferObservations?: boolean;
	/** Recall-stage pruning and dedup; a no-op on servers without a recall decision model. */
	rerank?: { prune?: boolean; dedup?: boolean };
	/** Ask for the RRF candidate trace (`trace.rrf_merged`), which carries no type or tags. */
	trace?: boolean;
}

export interface ReflectOptions extends HindsightRequestOptions {
	context?: string;
	budget?: Budget;
	tags?: string[];
	tagsMatch?: TagsMatch;
}

export interface CreateBankOptions extends HindsightRequestOptions {
	reflectMission?: string;
	retainMission?: string;
}

export interface ListMemoriesOptions extends HindsightRequestOptions {
	limit?: number;
	offset?: number;
	type?: string;
	q?: string;
	consolidationState?: ConsolidationState;
	/** Repeated `tags` params; combined with `tagsMatch: "all_strict"` they scope the sweep server-side. */
	tags?: string[];
	tagsMatch?: TagsMatch;
}

export interface ListDocumentsOptions extends HindsightRequestOptions {
	limit?: number;
	offset?: number;
}

export interface UpdateDocumentOptions extends HindsightRequestOptions {
	tags?: string[];
}

export type MentalModelDetail = "metadata" | "content" | "full";
export type MentalModelMode = "full" | "delta";

export interface MentalModelTrigger {
	mode?: MentalModelMode;
	refresh_after_consolidation?: boolean;
}

/** Shape returned by list/get on the mental-models endpoint. Fields are populated by `detail`. */
export interface MentalModelSummary {
	id: string;
	bank_id: string;
	name: string;
	tags?: string[];
	last_refreshed_at?: string | null;
	created_at?: string | null;
	source_query?: string;
	content?: string;
	max_tokens?: number;
	trigger?: MentalModelTrigger;
	[key: string]: unknown;
}

/** Complete mental-model listing; also the wire shape of one list page. */
export interface MentalModelListResponse {
	items: MentalModelSummary[];
	/**
	 * Match count across all pages. `listMentalModels` always sets it to the complete item count;
	 * on a single wire page it is server-reported (Hindsight ≥ 0.9) and absent on older servers.
	 */
	total?: number;
	[key: string]: unknown;
}

export interface MentalModelHistoryEntry {
	previous_content: string | null;
	changed_at: string;
	[key: string]: unknown;
}

export interface CreateMentalModelOptions extends HindsightRequestOptions {
	id?: string;
	tags?: string[];
	maxTokens?: number;
	trigger?: MentalModelTrigger;
}

export interface CreateMentalModelResponse {
	operation_id?: string;
	[key: string]: unknown;
}

export interface RefreshMentalModelResponse {
	operation_id?: string;
	[key: string]: unknown;
}

export interface ListMentalModelsOptions extends HindsightRequestOptions {
	detail?: MentalModelDetail;
}

export interface GetMentalModelOptions extends HindsightRequestOptions {
	detail?: MentalModelDetail;
}

export type KnowledgeNodeKind = "folder" | "page";

export interface KnowledgeNode {
	id: string;
	kind: KnowledgeNodeKind;
	name: string;
	parent_id?: string | null;
	mental_model_id?: string | null;
	managed?: boolean;
	description?: string | null;
	tags?: string[];
	timestamp?: string | null;
	is_stale?: boolean | null;
	children?: KnowledgeNode[];
}

export interface KnowledgeTreeResponse {
	roots: KnowledgeNode[];
}

export interface KnowledgeSearchHit {
	id: string;
	name: string;
	mental_model_id?: string | null;
	snippet: string;
	score: number;
	updated_at?: string | null;
}

export interface KnowledgeSearchResponse {
	results: KnowledgeSearchHit[];
	total: number;
}

export interface KnowledgePageDocument {
	id: string;
	name: string;
	type: string;
	description?: string | null;
	tags: string[];
	timestamp?: string | null;
	body: string;
	markdown: string;
}

export interface KnowledgeSearchOptions extends HindsightRequestOptions {
	limit?: number;
}

export class HindsightError extends Error {
	statusCode?: number;
	details?: unknown;

	constructor(message: string, statusCode?: number, details?: unknown) {
		super(message);
		this.name = "HindsightError";
		this.statusCode = statusCode;
		this.details = details;
	}
}

interface RequestOptions {
	body?: Record<string, unknown>;
	query?: Record<string, unknown>;
	/** Return null instead of throwing on a 404 response. */
	allow404?: boolean;
	signal?: AbortSignal;
	/** Op deadline (ms); defaults to the client's request timeout. */
	timeoutMs?: number;
}

/** Public surface of {@link HindsightApi}; a subagent worker holds a remote implementation of main's client. */
export interface HindsightClientApi {
	retain(bankId: string, content: string, options?: RetainOptions): Promise<RetainResponse>;
	retainBatch(bankId: string, items: MemoryItemInput[], options?: RetainBatchOptions): Promise<RetainResponse>;
	recall(bankId: string, query: string, options?: RecallOptions): Promise<RecallResponse>;
	reflect(bankId: string, query: string, options?: ReflectOptions): Promise<ReflectResponse>;
	createBank(bankId: string, options?: CreateBankOptions): Promise<BankProfileResponse>;
	listMemories(bankId: string, options?: ListMemoriesOptions): Promise<ListMemoriesResponse>;
	/** Read one memory unit, the `memory://<id>` read counterpart to `recall`. */
	getMemory(bankId: string, memoryId: string, options?: HindsightRequestOptions): Promise<HindsightMemoryUnit | null>;
	listDocuments(bankId: string, options?: ListDocumentsOptions): Promise<ListDocumentsResponse>;
	getDocument(bankId: string, documentId: string): Promise<DocumentResponse | null>;
	updateDocument(bankId: string, documentId: string, options: UpdateDocumentOptions): Promise<DocumentResponse>;
	deleteDocument(bankId: string, documentId: string): Promise<boolean>;
	listMentalModels(bankId: string, options?: ListMentalModelsOptions): Promise<MentalModelListResponse>;
	getMentalModel(
		bankId: string,
		mentalModelId: string,
		options?: GetMentalModelOptions,
	): Promise<MentalModelSummary | null>;
	createMentalModel(
		bankId: string,
		name: string,
		sourceQuery: string,
		options?: CreateMentalModelOptions,
	): Promise<CreateMentalModelResponse>;
	refreshMentalModel(bankId: string, mentalModelId: string): Promise<RefreshMentalModelResponse>;
	deleteMentalModel(bankId: string, mentalModelId: string): Promise<boolean>;
	getMentalModelHistory(bankId: string, mentalModelId: string): Promise<MentalModelHistoryEntry[]>;
	/** Knowledge-base tree; knowledge pages are backed by mental models filed under it. */
	getKnowledgeBaseTree(bankId: string, options?: HindsightRequestOptions): Promise<KnowledgeTreeResponse>;
}

export class HindsightApi implements HindsightClientApi {
	#baseUrl: string;
	#headers: Record<string, string>;
	#reflectTimeoutMs: number;
	#recallTimeoutMs: number;
	#retainTimeoutMs: number;
	#requestTimeoutMs: number;

	constructor(options: HindsightApiOptions) {
		this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.#headers = {
			"User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
			"Content-Type": "application/json",
		};
		if (options.apiKey) {
			this.#headers.Authorization = `Bearer ${options.apiKey}`;
		}
		const timeouts = options.timeouts;
		this.#requestTimeoutMs = timeouts?.request ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.#reflectTimeoutMs = timeouts?.reflect ?? DEFAULT_REFLECT_TIMEOUT_MS;
		this.#recallTimeoutMs = timeouts?.recall ?? DEFAULT_RECALL_TIMEOUT_MS;
		this.#retainTimeoutMs = timeouts?.retain ?? DEFAULT_RETAIN_TIMEOUT_MS;
	}

	async retain(bankId: string, content: string, options?: RetainOptions): Promise<RetainResponse> {
		const item = buildMemoryItem({
			content,
			timestamp: options?.timestamp,
			context: options?.context,
			metadata: options?.metadata,
			documentId: options?.documentId,
			tags: options?.tags,
			observationScopes: options?.observationScopes,

			updateMode: options?.updateMode,
			strategy: options?.strategy,
		});

		return this.#request<RetainResponse>(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bankId)}/memories`,
			"retain",
			{
				body: { items: [item], async: options?.async },
				signal: options?.signal,
				timeoutMs: this.#retainTimeoutMs,
			},
		);
	}

	/**
	 * Retain multiple memories in a single request. Mirrors the official
	 * client's `retainBatch` — items hit `POST /memories` together so the
	 * server can dedupe and consolidate as a batch instead of N round-trips.
	 *
	 * Per-item `documentId` wins; `options.documentId` only fills the gaps.
	 */
	async retainBatch(bankId: string, items: MemoryItemInput[], options?: RetainBatchOptions): Promise<RetainResponse> {
		const processed = items.map(item => {
			const built = buildMemoryItem(item);
			if (built.document_id === undefined && options?.documentId !== undefined) {
				built.document_id = options.documentId;
			}
			return built;
		});

		return this.#request<RetainResponse>(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bankId)}/memories`,
			"retainBatch",
			{
				body: {
					items: processed,
					document_tags: options?.documentTags,
					async: options?.async,
				},
				signal: options?.signal,
				timeoutMs: this.#retainTimeoutMs,
			},
		);
	}

	async recall(bankId: string, query: string, options?: RecallOptions): Promise<RecallResponse> {
		return this.#request<RecallResponse>(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`,
			"recall",
			{
				body: {
					query,
					types: options?.types,
					max_tokens: options?.maxTokens,
					budget: options?.budget ?? "mid",
					tags: options?.tags,
					tags_match: options?.tagsMatch,
					prefer_observations: options?.preferObservations,
					rerank: options?.rerank,
					trace: options?.trace,
				},
				signal: options?.signal,
				timeoutMs: this.#recallTimeoutMs,
			},
		);
	}

	async reflect(bankId: string, query: string, options?: ReflectOptions): Promise<ReflectResponse> {
		return this.#request<ReflectResponse>(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bankId)}/reflect`,
			"reflect",
			{
				body: {
					query,
					context: options?.context,
					budget: options?.budget ?? "low",
					tags: options?.tags,
					tags_match: options?.tagsMatch,
				},
				signal: options?.signal,
				timeoutMs: this.#reflectTimeoutMs,
			},
		);
	}

	async createBank(bankId: string, options: CreateBankOptions = {}): Promise<BankProfileResponse> {
		return this.#request<BankProfileResponse>(
			"PUT",
			`/v1/default/banks/${encodeURIComponent(bankId)}`,
			"createBank",
			{
				body: {
					reflect_mission: options.reflectMission,
					retain_mission: options.retainMission,
				},
				signal: options.signal,
			},
		);
	}

	/**
	 * Bulk-list memory units in a bank with optional filters and pagination.
	 * Endpoint: `GET /v1/default/banks/{bank_id}/memories/list`.
	 */
	async listMemories(bankId: string, options?: ListMemoriesOptions): Promise<ListMemoriesResponse> {
		return this.#request<ListMemoriesResponse>(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bankId)}/memories/list`,
			"listMemories",
			{
				query: {
					type: options?.type,
					q: options?.q,
					consolidation_state: options?.consolidationState,
					tags: options?.tags,
					tags_match: options?.tagsMatch,
					limit: options?.limit,
					offset: options?.offset,
				},
				signal: options?.signal,
			},
		);
	}

	/** Read one memory unit (with source memories and history); null when the bank has no such id. */
	async getMemory(
		bankId: string,
		memoryId: string,
		options?: HindsightRequestOptions,
	): Promise<HindsightMemoryUnit | null> {
		return this.#request<HindsightMemoryUnit | null>(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bankId)}/memories/${encodeURIComponent(memoryId)}`,
			"getMemory",
			{ allow404: true, signal: options?.signal },
		);
	}

	/** Bulk-list documents in a bank. */
	async listDocuments(bankId: string, options?: ListDocumentsOptions): Promise<ListDocumentsResponse> {
		return this.#request<ListDocumentsResponse>(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bankId)}/documents`,
			"listDocuments",
			{ query: { limit: options?.limit, offset: options?.offset }, signal: options?.signal },
		);
	}

	/** Fetch a document. Returns `null` on 404 instead of throwing. */
	async getDocument(bankId: string, documentId: string): Promise<DocumentResponse | null> {
		return this.#request<DocumentResponse | null>(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bankId)}/documents/${encodeURIComponent(documentId)}`,
			"getDocument",
			{ allow404: true },
		);
	}

	/** Update a document's mutable fields (currently just tags). */
	async updateDocument(bankId: string, documentId: string, options: UpdateDocumentOptions): Promise<DocumentResponse> {
		return this.#request<DocumentResponse>(
			"PATCH",
			`/v1/default/banks/${encodeURIComponent(bankId)}/documents/${encodeURIComponent(documentId)}`,
			"updateDocument",
			{ body: { tags: options.tags }, signal: options.signal },
		);
	}

	/**
	 * Delete a document and every memory derived from it. Returns `true` on
	 * success, `false` if the document was already gone (404).
	 */
	async deleteDocument(bankId: string, documentId: string): Promise<boolean> {
		const result = await this.#request<{ __deleted: boolean } | null>(
			"DELETE",
			`/v1/default/banks/${encodeURIComponent(bankId)}/documents/${encodeURIComponent(documentId)}`,
			"deleteDocument",
			{ allow404: true },
		);
		return result !== null;
	}

	/**
	 * List every mental model in a bank, following `limit`/`offset` pages until
	 * the server runs out — the endpoint defaults to 100 per page, so a single
	 * request would silently drop the rest of a shared bank. Default
	 * `detail=content` includes the generated `content` text but excludes the
	 * heavyweight `reflect_response` provenance chain (which can exceed 200KB).
	 * Use `detail=metadata` for inventory and `detail=full` only for debug surfaces.
	 */
	async listMentalModels(bankId: string, options?: ListMentalModelsOptions): Promise<MentalModelListResponse> {
		const path = `/v1/default/banks/${encodeURIComponent(bankId)}/mental-models`;
		const detail = options?.detail ?? "content";
		const items: MentalModelSummary[] = [];
		while (true) {
			const page = await this.#request<MentalModelListResponse>("GET", path, "listMentalModels", {
				query: { detail, limit: MENTAL_MODEL_PAGE_SIZE, offset: items.length },
				signal: options?.signal,
			});
			const pageItems = page.items ?? [];
			items.push(...pageItems);
			if (pageItems.length < MENTAL_MODEL_PAGE_SIZE) break;
			if (typeof page.total === "number" && items.length >= page.total) break;
		}
		return { items, total: items.length };
	}

	/** Fetch a single mental model. Returns `null` on 404. */
	async getMentalModel(
		bankId: string,
		mentalModelId: string,
		options?: GetMentalModelOptions,
	): Promise<MentalModelSummary | null> {
		return this.#request<MentalModelSummary | null>(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bankId)}/mental-models/${encodeURIComponent(mentalModelId)}`,
			"getMentalModel",
			{ query: { detail: options?.detail ?? "content" }, allow404: true, signal: options?.signal },
		);
	}

	/**
	 * Create a mental model. Asynchronous on the server: returns an
	 * `operation_id`; the model's `content` populates after the background
	 * reflect completes.
	 */
	async createMentalModel(
		bankId: string,
		name: string,
		sourceQuery: string,
		options?: CreateMentalModelOptions,
	): Promise<CreateMentalModelResponse> {
		return this.#request<CreateMentalModelResponse>(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bankId)}/mental-models`,
			"createMentalModel",
			{
				body: {
					id: options?.id,
					name,
					source_query: sourceQuery,
					tags: options?.tags,
					max_tokens: options?.maxTokens,
					trigger: options?.trigger,
				},
				signal: options?.signal,
			},
		);
	}

	/** Trigger an out-of-band refresh of a mental model. Returns the operation handle. */
	async refreshMentalModel(bankId: string, mentalModelId: string): Promise<RefreshMentalModelResponse> {
		return this.#request<RefreshMentalModelResponse>(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bankId)}/mental-models/${encodeURIComponent(mentalModelId)}/refresh`,
			"refreshMentalModel",
			{},
		);
	}

	/** Delete a mental model. Returns `true` on success, `false` if it was already gone (404). */
	async deleteMentalModel(bankId: string, mentalModelId: string): Promise<boolean> {
		const result = await this.#request<{ __deleted: boolean } | null>(
			"DELETE",
			`/v1/default/banks/${encodeURIComponent(bankId)}/mental-models/${encodeURIComponent(mentalModelId)}`,
			"deleteMentalModel",
			{ allow404: true },
		);
		return result !== null;
	}

	/**
	 * Fetch the change history of a mental model. Each entry captures the
	 * content snapshot BEFORE that change; the current content is read via
	 * `getMentalModel`. Most-recent first.
	 */
	async getMentalModelHistory(bankId: string, mentalModelId: string): Promise<MentalModelHistoryEntry[]> {
		const response = await this.#request<MentalModelHistoryEntry[] | { items?: MentalModelHistoryEntry[] }>(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bankId)}/mental-models/${encodeURIComponent(mentalModelId)}/history`,
			"getMentalModelHistory",
			{},
		);
		if (Array.isArray(response)) return response;
		return response.items ?? [];
	}

	async getKnowledgeBaseTree(bankId: string, options?: HindsightRequestOptions): Promise<KnowledgeTreeResponse> {
		return this.#request<KnowledgeTreeResponse>(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bankId)}/knowledge-base/tree`,
			"getKnowledgeBaseTree",
			{ signal: options?.signal },
		);
	}

	async searchKnowledgeBase(
		bankId: string,
		query: string,
		options?: KnowledgeSearchOptions,
	): Promise<KnowledgeSearchResponse> {
		return this.#request<KnowledgeSearchResponse>(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bankId)}/knowledge-base/search`,
			"searchKnowledgeBase",
			{ query: { q: query, limit: options?.limit }, signal: options?.signal },
		);
	}

	async getKnowledgePage(
		bankId: string,
		pageId: string,
		options?: HindsightRequestOptions,
	): Promise<KnowledgePageDocument | null> {
		return this.#request<KnowledgePageDocument | null>(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bankId)}/knowledge-base/pages/${encodeURIComponent(pageId)}`,
			"getKnowledgePage",
			{ allow404: true, signal: options?.signal },
		);
	}

	async #request<T>(method: string, path: string, operation: string, opts?: RequestOptions): Promise<T> {
		let url = `${this.#baseUrl}${path}`;
		if (opts?.query) {
			const qs = buildQueryString(opts.query);
			if (qs) url += `?${qs}`;
		}

		const timeoutMs = opts?.timeoutMs ?? this.#requestTimeoutMs;
		const init: RequestInit = {
			method,
			headers: this.#headers,
			signal: withTimeoutSignal(timeoutMs, opts?.signal),
		};
		if (opts?.body !== undefined) {
			init.body = JSON.stringify(pruneUndefined(opts.body));
		}

		let response: Response;
		try {
			response = await fetch(url, init);
		} catch (err) {
			const message = isTimeoutError(err)
				? `${operation} request timed out after ${Math.round(timeoutMs / 1000)}s`
				: `${operation} request failed: ${err instanceof Error ? err.message : String(err)}`;
			throw new HindsightError(message, undefined, err);
		}

		if (opts?.allow404 && response.status === 404) {
			return null as T;
		}

		const text = await response.text();
		const parsed = text ? tryParseJson(text) : null;

		if (!response.ok) {
			const details = errorDetails(parsed, text);
			const detailText = typeof details === "string" ? details : JSON.stringify(details);
			throw new HindsightError(
				`${operation} failed: ${truncate(detailText, MAX_ERROR_DETAIL_CHARS)}`,
				response.status,
				details,
			);
		}

		return (parsed ?? {}) as T;
	}
}

export interface RecallDecisionOptions {
	baseUrl: string;
	apiKey?: string | null;
	/** Minimum `noul` score for the lone survivor to be delivered. */
	threshold: number;
	/** Request deadline (ms). */
	timeoutMs?: number;
}

interface SystemOneResponse {
	answers?: Record<string, { noul?: unknown } | undefined>;
}

type DecisionQuestion = { type: "noul"; instructions: { task: string; memory: string } };

interface DecisionChunkItem {
	index: number;
	text: string;
}

/** One queued System One batch: items still to score and how many splits it may still undergo. */
interface DecisionBatchTask {
	items: DecisionChunkItem[];
	retriesLeft: number;
}

/** Absolute score floor the server itself applies to recall candidates. */
export const RECALL_SCORE_FLOOR = 0.2;
/** Relative score floor: candidates within this ratio of the best score survive the server's prune. */
export const RECALL_SCORE_FLOOR_RATIO = 0.4;

/** Rendered-token budget per System One batch; the server rejects requests over 18432 rendered tokens. */
const DECISION_CHUNK_MAX_TOKENS = 15_000;
/** Question cap per System One batch; the server accepts at most 700. */
const DECISION_CHUNK_MAX_ITEMS = 80;
/** Batches allowed in flight at once; more only queues behind the decision service. */
const DECISION_CHUNK_CONCURRENCY = 2;
/** Per-batch deadline (ms); one memory vote keeps the short default, a batch is explicitly slow. */
const DECISION_BATCH_TIMEOUT_MS = 60_000;
/** Rendered scaffolding per question: JSON keys, the `noul` type, and the instructions wrapper. */
const DECISION_QUESTION_OVERHEAD_TOKENS = 24;
/** Server error type returned when a rendered question set exceeds the token ceiling. */
const MAX_TOKENS_EXCEEDED = "max_tokens_exceeded";

let decisionTaskTokens: number | undefined;

/** Rendered tokens one question costs: the memory, the shared task string, and JSON scaffolding. */
function estimateQuestionTokens(memory: string): number {
	decisionTaskTokens ??= countTokens(DECISION_TASK);
	return countTokens(memory) + decisionTaskTokens + DECISION_QUESTION_OVERHEAD_TOKENS;
}

/**
 * Greedy packing under the per-request item and token caps; the query rides every request as its
 * state, so its rendered tokens come out of the batch budget first. An oversized memory still gets
 * its own single-question batch, and never an empty one: the server rejects a zero-question request.
 */
function packDecisionChunks(memories: readonly string[], queryTokens: number): DecisionChunkItem[][] {
	const budget = DECISION_CHUNK_MAX_TOKENS - queryTokens;
	const chunks: DecisionChunkItem[][] = [];
	let current: DecisionChunkItem[] = [];
	let tokens = 0;
	for (let index = 0; index < memories.length; index++) {
		const text = memories[index]!;
		const estimate = estimateQuestionTokens(text);
		if (current.length > 0 && (current.length >= DECISION_CHUNK_MAX_ITEMS || tokens + estimate > budget)) {
			chunks.push(current);
			current = [];
			tokens = 0;
		}
		current.push({ index, text });
		tokens += estimate;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

function isMaxTokensExceeded(err: unknown): boolean {
	if (!(err instanceof HindsightError) || err.statusCode !== 400) return false;
	const detail = err.details;
	const body = typeof detail === "string" ? detail : JSON.stringify(detail ?? "");
	return `${err.message} ${body}`.includes(MAX_TOKENS_EXCEEDED);
}

function readNoul(answer: { noul?: unknown } | undefined): number | null {
	const noul = answer?.noul;
	return typeof noul === "number" && Number.isFinite(noul) ? noul : null;
}

/**
 * Hindsight keeps every recall candidate above `max(0.20, 0.40 * best)`, so a bank with no
 * matching memory still returns one survivor; only a lone result can be a floor artefact.
 * A System One decision model scores that memory against the question, and anything but a
 * definite answer below `threshold` keeps it: a decision service that is down never withholds
 * memory, and a short deadline keeps a stalled one from holding the turn.
 *
 * Deep gears re-score a whole candidate pool through the same endpoint: `scoreBatch` packs
 * questions under the rendered-token ceiling, runs two batches at a time, and splits a batch
 * the server refuses for `max_tokens_exceeded` instead of dropping the pass.
 */
export class HindsightRecallDecision {
	#baseUrl: string;
	#apiKey?: string;
	#threshold: number;
	#timeoutMs: number;

	constructor(options: RecallDecisionOptions) {
		this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.#apiKey = options.apiKey ?? undefined;
		this.#threshold = options.threshold;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
	}

	/**
	 * Score every memory against `query`, aligned to the input. A memory the service leaves
	 * unanswered scores `null` — no evidence either way — while a failed request throws so the
	 * caller can fall back to unscored candidates. A batch the server refuses for
	 * `max_tokens_exceeded` is split back into the shared queue, so in-flight requests never exceed
	 * the configured concurrency, and a single memory that still cannot fit scores `null`.
	 */
	async scoreBatch(query: string, memories: readonly string[], signal?: AbortSignal): Promise<(number | null)[]> {
		if (memories.length === 0) return [];
		const queryTokens = countTokens(`Question: ${query}`);
		if (queryTokens >= DECISION_CHUNK_MAX_TOKENS) {
			return Array.from({ length: memories.length }, () => null);
		}
		const tasks: DecisionBatchTask[] = packDecisionChunks(memories, queryTokens).map(items => ({
			items,
			retriesLeft: 1,
		}));
		const scores: (number | null)[] = Array.from({ length: memories.length }, () => null);
		let next = 0;
		const worker = async (): Promise<void> => {
			while (next < tasks.length) {
				const task = tasks[next++]!;
				try {
					const batch = await this.#scoreChunk(
						query,
						task.items.map(item => item.text),
						signal,
					);
					for (let index = 0; index < task.items.length; index++) {
						scores[task.items[index]!.index] = batch[index] ?? null;
					}
				} catch (err) {
					if (!isMaxTokensExceeded(err)) throw err;
					if (task.items.length < 2 || task.retriesLeft <= 0) continue;
					const mid = Math.ceil(task.items.length / 2);
					tasks.push({ items: task.items.slice(0, mid), retriesLeft: task.retriesLeft - 1 });
					tasks.push({ items: task.items.slice(mid), retriesLeft: task.retriesLeft - 1 });
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(DECISION_CHUNK_CONCURRENCY, tasks.length) }, () => worker()));
		return scores;
	}

	async #scoreChunk(query: string, memories: readonly string[], signal?: AbortSignal): Promise<(number | null)[]> {
		const questions: Record<string, DecisionQuestion> = {};
		memories.forEach((memory, index) => {
			questions[`m${index}`] = { type: "noul", instructions: { task: DECISION_TASK, memory } };
		});
		const response = await this.#post(`Question: ${query}`, questions, DECISION_BATCH_TIMEOUT_MS, signal);
		const text = await response.text();
		const parsed: unknown = text ? tryParseJson(text) : undefined;
		if (!response.ok) {
			const details = errorDetails(parsed, text);
			const detailText = typeof details === "string" ? details : JSON.stringify(details);
			throw new HindsightError(
				`scoreRecallBatch failed: ${truncate(detailText, MAX_ERROR_DETAIL_CHARS)}`,
				response.status,
				details,
			);
		}
		const answers = (parsed as SystemOneResponse | undefined)?.answers ?? {};
		return memories.map((_, index) => readNoul(answers[`m${index}`]));
	}

	#post(
		state: string,
		questions: Record<string, unknown>,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<Response> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;
		return fetch(`${this.#baseUrl}/v1/systemone`, {
			method: "POST",
			headers,
			body: JSON.stringify({ model: DECISION_MODEL_ID, state, questions }),
			signal: withTimeoutSignal(timeoutMs, signal),
		});
	}

	async keep(query: string, memory: string, signal?: AbortSignal): Promise<boolean> {
		try {
			const response = await this.#post(
				`Question: ${query}`,
				{ m0: { type: "noul", instructions: { task: DECISION_TASK, memory } } },
				this.#timeoutMs,
				signal,
			);
			if (!response.ok) return true;
			const parsed = tryParseJson(await response.text()) as SystemOneResponse | undefined;
			const score = readNoul(parsed?.answers?.m0);
			return score === null || score >= this.#threshold;
		} catch {
			return true;
		}
	}
}

interface BuiltMemoryItem {
	content: string;
	timestamp?: string;
	context?: string;
	metadata?: Record<string, string>;
	document_id?: string;
	tags?: string[];
	observation_scopes?: "per_tag" | "combined" | "all_combinations" | string[][];
	strategy?: string;
	update_mode?: UpdateMode;
}

function buildMemoryItem(item: MemoryItemInput): BuiltMemoryItem {
	const out: BuiltMemoryItem = { content: item.content };
	if (item.timestamp !== undefined) {
		out.timestamp = item.timestamp instanceof Date ? formatDateWithLocalOffset(item.timestamp) : item.timestamp;
	}
	if (item.context !== undefined) out.context = item.context;
	if (item.metadata !== undefined) out.metadata = item.metadata;
	if (item.documentId !== undefined) out.document_id = item.documentId;
	if (item.tags !== undefined) out.tags = item.tags;
	if (item.observationScopes !== undefined) out.observation_scopes = item.observationScopes;
	if (item.strategy !== undefined) out.strategy = item.strategy;
	if (item.updateMode !== undefined) out.update_mode = item.updateMode;
	return out;
}

function formatDateWithLocalOffset(date: Date): string {
	const offsetMinutes = date.getTimezoneOffset();
	const offsetSign = offsetMinutes <= 0 ? "+" : "-";
	const absoluteOffset = Math.abs(offsetMinutes);
	const offsetHours = Math.floor(absoluteOffset / 60);
	const offsetRemainderMinutes = absoluteOffset % 60;
	const milliseconds = date.getMilliseconds();
	const millisecondsPart = milliseconds === 0 ? "" : `.${pad3(milliseconds)}`;
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(
		date.getHours(),
	)}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${millisecondsPart}${offsetSign}${pad2(
		offsetHours,
	)}:${pad2(offsetRemainderMinutes)}`;
}

function pad2(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

function pad3(value: number): string {
	if (value < 10) return `00${value}`;
	if (value < 100) return `0${value}`;
	return String(value);
}

function buildQueryString(query: Record<string, unknown>): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) {
			for (const item of value) {
				if (item === undefined || item === null) continue;
				params.append(key, String(item));
			}
		} else {
			params.set(key, String(value));
		}
	}
	return params.toString();
}

function pruneUndefined(obj: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) out[k] = v;
	}
	return out;
}

/** Server error payload: prefer `detail`, then `message`, then whatever the body was. */
function errorDetails(parsed: unknown, text: string): unknown {
	if (parsed && typeof parsed === "object") {
		if ("detail" in parsed && parsed.detail !== undefined) return parsed.detail;
		if ("message" in parsed && parsed.message !== undefined) return parsed.message;
	}
	return parsed ?? text;
}

export function createHindsightClient(config: HindsightConfig & { hindsightApiUrl: string }): HindsightApi {
	return new HindsightApi({
		baseUrl: config.hindsightApiUrl,
		apiKey: config.hindsightApiToken ?? undefined,
		userAgent: USER_AGENT,
		timeouts: {
			request: config.requestTimeoutMs,
			reflect: config.reflectTimeoutMs,
			recall: config.recallTimeoutMs,
			retain: config.retainTimeoutMs,
		},
	});
}
