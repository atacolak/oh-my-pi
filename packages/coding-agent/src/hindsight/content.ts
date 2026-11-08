/**
 * Pure content utilities for the Hindsight backend.
 *
 * Ports the semantics of the upstream OpenCode plugin
 * (vectorize-io/hindsight @ hindsight-integrations/opencode/src/content.ts):
 *   - tag stripping for anti-feedback (a recalled <memories> block must
 *     never end up retained as a new memory)
 *   - recall query composition + truncation under a character budget
 *   - retention transcript framing
 */

import type { HindsightMemoryUnit } from "./client";

export interface HindsightMessage {
	role: string;
	content: string;
	/** Original SessionEntry.timestamp; omitted when the source had none. */
	timestamp?: string;
}

export interface RecallResultLike {
	text: string;
	/** Bank id when the server reports one; recalled bullets link it as `memory://<id>`. */
	id?: string | null;
	type?: string | null;
	mentioned_at?: string | null;
	/** Tags carried by the recalled memory; actor/role entries render as a provenance badge. */
	tags?: readonly string[];
	/** Memory metadata as retained; `episode_id` links the memory to its session episode. */
	metadata?: Record<string, unknown> | null;
}

const MEMORIES_REGEX = /<memories>[\s\S]*?<\/memories>/g;
const LEGACY_HINDSIGHT_MEMORIES_REGEX = /<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g;
const LEGACY_RELEVANT_MEMORIES_REGEX = /<relevant_memories>[\s\S]*?<\/relevant_memories>/g;
const MENTAL_MODELS_REGEX = /<mental_models>[\s\S]*?<\/mental_models>/g;

const RETENTION_PROTOCOL_MARKER_REGEX = /^\[(?:role:\s*[-_a-zA-Z0-9]+|[-_a-zA-Z0-9]+:end|timestamp:\s+.+)\]$/;
/**
 * Strip `<memories>`, `<mental_models>`, and legacy memory blocks.
 *
 * `<memories>` rides a hidden turn entry and `<mental_models>` the developer
 * instructions; both are context the model was handed, not knowledge it gained.
 * If either leaks into a retention transcript or a `retain` call, every retain
 * becomes a tighter feedback loop — paraphrased memories feed the next
 * consolidation, which feeds the next mental-model refresh, which feeds the next
 * retain. Always strip before retaining.
 */
export function stripMemoryTags(content: string): string {
	return content
		.replace(MEMORIES_REGEX, "")
		.replace(MENTAL_MODELS_REGEX, "")
		.replace(LEGACY_HINDSIGHT_MEMORIES_REGEX, "")
		.replace(LEGACY_RELEVANT_MEMORIES_REGEX, "");
}

// At least one letter or digit means the message carries a token a retriever
// can actually match on. Punctuation/whitespace-only strings (e.g. the lone
// `.` some providers emit for tool-call-only or thinking-only assistant turns)
// are dropped before retain/recall touches them — see issue #1806.
const SUBSTANTIVE_CHAR_RE = /[\p{L}\p{N}]/u;

/**
 * True when `content` carries at least one letter or digit. Used by retain
 * and recall paths to drop placeholder assistant turns ("." / "..." / pure
 * whitespace) that would otherwise pollute the bank and waste tokens on
 * embeddings with no semantic content.
 */
export function hasSubstantiveContent(content: string): boolean {
	return SUBSTANTIVE_CHAR_RE.test(content);
}

/**
 * Merge recall filters without allowing callers to change the hard scope axis.
 * Explicit project tags replace the default project; `project:*` removes that
 * default without sending a literal wildcard tag to the server. Other tags
 * remain additive. Omitted extra tags leave the session filter unchanged.
 */
export function mergeRecallTags(
	scopeTags: string[] | undefined,
	extraTags: readonly string[] | undefined,
): string[] | undefined {
	if (!extraTags || extraTags.length === 0) return scopeTags;
	const required = (scopeTags ?? []).map(tag => tag.trim()).filter(Boolean);
	const extra = extraTags.map(tag => tag.trim()).filter(Boolean);
	const overrideProject = extra.some(tag => tag.startsWith("project:"));
	const merged = [
		...new Set([
			...required.filter(tag => !overrideProject || !tag.startsWith("project:")),
			...extra.filter(tag => tag !== "project:*" && (!tag.startsWith("scope:") || required.includes(tag))),
		]),
	];
	return merged.length > 0 ? merged : undefined;
}

const PROVENANCE_TAG_RE = /^(?:actor|role):\S+$/;

/** Compact `[role:builder actor:id]` footer for recall provenance; empty when the item carries none. */
function provenanceBadge(tags: readonly string[] | undefined): string {
	if (!tags || tags.length === 0) return "";
	const labels = tags.map(tag => tag.trim()).filter(tag => PROVENANCE_TAG_RE.test(tag));
	return labels.length > 0 ? ` [${labels.join(" ")}]` : "";
}

/**
 * Identity of one recalled memory as the model read it, for session dedupe.
 *
 * The key pairs the server id (when there is one) with the text, so a refresh
 * never repeats what the transcript already shows while a memory whose content
 * changed under the same id is delivered as the new fact it is. Results without
 * an id still dedupe on their text.
 */
export function recallMemoryKey(memory: { id?: string | null; text: string }): string {
	const text = Bun.hash(memory.text.trim()).toString(36);
	const id = memory.id?.trim();
	return id ? `id:${id}:${text}` : `text:${text}`;
}

/** Characters of an episode id rendered in a recall footer; enough to address it, short enough to read. */
const EPISODE_SHORT_CHARS = 8;

/**
 * `[ep:<short id>]` footer for a recalled memory's session episode.
 *
 * Only a real episode id earns the link: a footer is a promise that
 * `episode://<id>` resolves, and a document or session id would not.
 */
function episodeBadge(metadata: Record<string, unknown> | null | undefined): string {
	const episodeId = metadata?.episode_id;
	if (typeof episodeId !== "string") return "";
	const short = episodeId.trim().slice(0, EPISODE_SHORT_CHARS);
	return short ? ` [ep:${short}]` : "";
}

/** Format recall results into a bullet list for context injection. */
export function formatMemories(results: RecallResultLike[]): string {
	if (results.length === 0) return "";
	return results
		.map(r => {
			const idStr = r.id?.trim() ? ` [memory://${r.id.trim()}]` : "";
			const typeStr = r.type ? ` [${r.type}]` : "";
			const episodeStr = episodeBadge(r.metadata);
			const provenanceStr = provenanceBadge(r.tags);
			const dateStr = r.mentioned_at ? ` (${r.mentioned_at})` : "";
			return `- ${r.text}${idStr}${typeStr}${episodeStr}${provenanceStr}${dateStr}`;
		})
		.join("\n\n");
}

/**
 * True when a memory's tags belong to the caller's memory scope.
 *
 * Coding callers may dereference coding memories across project tags, while
 * personal memories remain invisible to non-personal callers. Other scopes
 * retain their configured tag-match semantics.
 */
export function isHindsightMemoryInScope(
	memoryTags: readonly string[] | null | undefined,
	scope: { scoping: string; recallTags?: readonly string[]; recallTagsMatch?: string },
): boolean {
	const tags = new Set((memoryTags ?? []).map(tag => tag.trim()).filter(Boolean));
	const required = (scope.recallTags ?? []).map(tag => tag.trim()).filter(Boolean);
	if (scope.scoping !== "per-project" && required.length === 0) {
		return false;
	}
	if (!required.includes("scope:personal") && tags.has("scope:personal")) {
		return false;
	}
	if (required.includes("scope:coding")) return tags.has("scope:coding");
	const mode = scope.recallTagsMatch ?? "all_strict";
	if (mode === "any" || mode === "any_strict") {
		return required.length === 0 || required.some(tag => tags.has(tag));
	}
	return required.every(tag => tags.has(tag));
}

/** Render one full memory unit — text, provenance, source memories, and history — as markdown. */
export function formatHindsightMemoryRead(unit: HindsightMemoryUnit, fallbackId: string): string {
	const id = unit.id?.trim() || fallbackId;
	const lines = [`# memory://${id}`];
	const meta: string[] = [];
	const type = unit.type ?? unit.fact_type;
	if (type) meta.push(`type: ${type}`);
	const mentionedAt = unit.mentioned_at || unit.date;
	if (mentionedAt) meta.push(`mentioned_at: ${mentionedAt}`);
	if (unit.tags?.length) meta.push(`tags: ${unit.tags.join(", ")}`);
	const episodeId = typeof unit.metadata?.episode_id === "string" ? unit.metadata.episode_id.trim() : "";
	if (episodeId) meta.push(`episode: episode://${episodeId}`);
	if (meta.length > 0) lines.push(...meta);
	lines.push("", unit.text.trim());

	const sources = unit.source_memories ?? [];
	if (sources.length > 0) {
		lines.push("", "## Source Memories");
		for (const source of sources) {
			const sourceId = source.id ? `memory://${source.id}` : "source";
			const sourceType = source.type ? ` [${source.type}]` : "";
			const sourceDate = source.mentioned_at ? ` (${source.mentioned_at})` : "";
			const sourceText = source.text?.trim();
			lines.push(`- ${sourceId}${sourceType}${sourceDate}${sourceText ? ` ${sourceText}` : ""}`);
		}
	}

	const history = unit.history ?? [];
	if (history.length > 0) {
		lines.push("", "## History");
		for (const entry of history) {
			const priorText =
				typeof entry.previous_text === "string"
					? entry.previous_text
					: typeof entry.text === "string"
						? entry.text
						: JSON.stringify(entry);
			const changedAt =
				typeof entry.changed_at === "string"
					? entry.changed_at
					: typeof entry.updated_at === "string"
						? entry.updated_at
						: "";
			lines.push(changedAt ? `- (${changedAt}) ${priorText}` : `- ${priorText}`);
		}
	}

	return lines.join("\n");
}

/** Format current UTC time for the recall preamble. */
export function formatCurrentTime(now: Date = new Date()): string {
	const y = now.getUTCFullYear();
	const m = String(now.getUTCMonth() + 1).padStart(2, "0");
	const d = String(now.getUTCDate()).padStart(2, "0");
	const h = String(now.getUTCHours()).padStart(2, "0");
	const min = String(now.getUTCMinutes()).padStart(2, "0");
	return `${y}-${m}-${d} ${h}:${min}`;
}

/**
 * Slice messages to the last N turns, where a turn boundary is a user message.
 * Returns the trailing tail starting at the (N-th from the end) user message.
 */
export function sliceLastTurnsByUserBoundary(messages: HindsightMessage[], turns: number): HindsightMessage[] {
	if (messages.length === 0 || turns <= 0) return [];

	let userTurnsSeen = 0;
	let startIndex = -1;

	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			userTurnsSeen += 1;
			if (userTurnsSeen >= turns) {
				startIndex = i;
				break;
			}
		}
	}

	return startIndex === -1 ? [...messages] : messages.slice(startIndex);
}

/**
 * Compose a recall query from the latest user prompt plus optional prior context.
 *
 * When `recallContextTurns <= 1` the query is just the trimmed latest prompt.
 * Otherwise we prepend a `Prior context:` block built from the trailing
 * `recallContextTurns` user-bounded turns (memory tags stripped, latest prompt
 * suppressed to avoid duplicating it inside the context block).
 */
export function composeRecallQuery(
	latestQuery: string,
	messages: HindsightMessage[],
	recallContextTurns: number,
): string {
	const latest = latestQuery.trim();
	if (recallContextTurns <= 1 || messages.length === 0) return latest;

	const contextual = sliceLastTurnsByUserBoundary(messages, recallContextTurns);
	let trailingUserIndex = -1;
	for (let i = contextual.length - 1; i >= 0; i--) {
		if (contextual[i].role === "user") {
			trailingUserIndex = i;
			break;
		}
	}

	const contextLines: string[] = [];
	for (let i = 0; i < contextual.length; i++) {
		const msg = contextual[i];
		const content = stripMemoryTags(msg.content).trim();
		if (!content || (msg.role === "assistant" && !hasSubstantiveContent(content))) continue;
		if (i === trailingUserIndex && content === latest) continue;
		const safeContent = content.replace(/\n(?=(?:user|assistant|system|tool): )/g, "\n  ");
		contextLines.push(`${msg.role}: ${safeContent}`);
	}

	if (contextLines.length === 0) return latest;
	return ["Prior context:", contextLines.join("\n"), latest].join("\n\n");
}

/**
 * Truncate a composed recall query to `maxChars`.
 *
 * Always preserves the latest user message. Drops oldest context lines first
 * and degrades gracefully when even the latest message exceeds the budget.
 */
export function truncateRecallQuery(query: string, latestQuery: string, maxChars: number): string {
	if (maxChars <= 0 || query.length <= maxChars) return query;

	const latest = latestQuery.trim();
	const latestOnly = latest.length > maxChars ? latest.slice(0, maxChars) : latest;

	if (!query.includes("Prior context:")) return latestOnly;

	const contextMarker = "Prior context:\n\n";
	const markerIndex = query.indexOf(contextMarker);
	if (markerIndex === -1) return latestOnly;

	const suffix = `\n\n${latest}`;
	const suffixIndex = query.lastIndexOf(suffix);
	if (suffixIndex === -1) return latestOnly;
	if (suffix.length >= maxChars) return latestOnly;

	const contextBody = query.slice(markerIndex + contextMarker.length, suffixIndex);
	const contextEntries = contextBody.split(/\n(?=(?:user|assistant|system|tool): )/).filter(Boolean);

	const kept: string[] = [];
	for (let i = contextEntries.length - 1; i >= 0; i--) {
		kept.unshift(contextEntries[i]);
		const candidate = `${contextMarker}${kept.join("\n")}${suffix}`;
		if (candidate.length > maxChars) {
			kept.shift();
			break;
		}
	}

	if (kept.length > 0) return `${contextMarker}${kept.join("\n")}${suffix}`;
	return latestOnly;
}

export interface RetentionTranscript {
	transcript: string | null;
	messageCount: number;
}

/**
 * Format messages into a retention transcript using `[role: ...]` markers.
 *
 * - When `retainFullWindow` is true, all messages are included (used when the
 *   caller pre-sliced the window itself).
 * - Otherwise, only the last user turn (last user message → end) is retained.
 *
 * Messages are tag-stripped before framing to break the recall→retain loop.
 * Returns `{ transcript: null }` when nothing meaningful survives.
 */
function formatRetentionMessage(msg: HindsightMessage, includeTimestamps = false): string | null {
	const content = stripMemoryTags(msg.content).trim();
	if (!hasSubstantiveContent(content)) return null;
	const header = `[role: ${msg.role}]`;
	const timestamp = includeTimestamps ? msg.timestamp?.trim() : undefined;
	const stamped = timestamp ? `${header}\n[timestamp: ${timestamp}]` : header;
	return `${stamped}\n${content}\n[${msg.role}:end]`;
}

function formatRetentionMessages(messages: HindsightMessage[], includeTimestamps = false): RetentionTranscript {
	const parts: string[] = [];
	for (const msg of messages) {
		const formatted = formatRetentionMessage(msg, includeTimestamps);
		if (formatted) parts.push(formatted);
	}

	if (parts.length === 0) return { transcript: null, messageCount: 0 };

	const transcript = parts.join("\n\n");
	if (transcript.trim().length < 10) return { transcript: null, messageCount: 0 };

	return { transcript, messageCount: parts.length };
}

function formatEmbeddableRetentionMessages(messages: HindsightMessage[]): RetentionTranscript {
	const parts: string[] = [];
	for (const msg of messages) {
		const content = stripRetentionProtocolMarkers(stripMemoryTags(msg.content)).trim();
		if (!hasSubstantiveContent(content)) continue;
		parts.push(content);
	}

	if (parts.length === 0) return { transcript: null, messageCount: 0 };

	const transcript = parts.join("\n\n");
	if (transcript.trim().length < 10) return { transcript: null, messageCount: 0 };

	return { transcript, messageCount: parts.length };
}

/** Remove retention framing lines from a stored coding-agent episode transcript. */
export function stripRetentionProtocolMarkers(content: string): string {
	return content
		.split(/\r?\n/)
		.filter(line => !RETENTION_PROTOCOL_MARKER_REGEX.test(line.trim()))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function prepareRetentionTranscript(
	messages: HindsightMessage[],
	retainFullWindow = false,
	options?: { includeTimestamps?: boolean },
): RetentionTranscript {
	if (messages.length === 0) return { transcript: null, messageCount: 0 };

	let targetMessages: HindsightMessage[];
	if (retainFullWindow) {
		targetMessages = messages;
	} else {
		let lastUserIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				lastUserIdx = i;
				break;
			}
		}
		if (lastUserIdx === -1) return { transcript: null, messageCount: 0 };
		targetMessages = messages.slice(lastUserIdx);
	}

	return formatRetentionMessages(targetMessages, options?.includeTimestamps === true);
}

/** Format all retention messages without protocol markers for embedding, FTS, and recall display. */
export function prepareEmbeddableRetentionTranscript(messages: HindsightMessage[]): RetentionTranscript {
	return formatEmbeddableRetentionMessages(messages);
}
/** Format only user-authored messages for memory fact/entity extraction. */
export function prepareUserRetentionTranscript(messages: HindsightMessage[]): RetentionTranscript {
	return formatRetentionMessages(messages.filter(message => message.role === "user"));
}
