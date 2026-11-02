/**
 * Protocol handler for episode:// URLs.
 *
 * Episode rows index one agent run each, but the row alone cannot answer what
 * the run did: the transcript holds the calls and their results. This handler
 * joins the two.
 *
 * URL forms:
 * - `episode://search?q=<term>` — FTS lookup over focus title, trigger summary,
 *   recap and tool targets.
 * - `episode://<id>` — high-level overview: intent and one bounded line per
 *   tool call, for orientation.
 * - `episode://<id>/<call_id>` — the untruncated arguments AND output of that
 *   call, for recovery.
 */
import type { AgentMessage, AssistantMessage, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import episodePromptDoc from "../prompts/internal-urls/episode.md" with { type: "text" };
import { episodeSliceEntries } from "../session/episode-facts";
import { loadEpisodeEntries, searchEpisodes } from "../session/episode-store";
import type { SessionEntry } from "../session/session-entries";
import { formatToolCallPrimaryArg } from "../session/session-history-format";
import { getSessionEpisode, type SessionEpisode } from "../session/session-index";
import type { InternalResource, InternalUrl, ProtocolHandler, SchemeSpec } from "./types";

const INTENT_MAX_CHARS = 1_000;
const RECAP_MAX_CHARS = 600;
const LABEL_MAX_CHARS = 160;
const KNOWN_CALLS_MAX = 20;

type EpisodeRoute =
	| { kind: "search"; query: string }
	| { kind: "overview"; episodeId: string }
	| { kind: "call"; episodeId: string; callId: string };

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function contentToText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

/** Fence at least one backtick longer than the longest run inside `text`. */
function jsonFence(text: string): string {
	let longest = 0;
	for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}json\n${text}\n${fence}`;
}

function parseEpisodeRoute(url: InternalUrl): EpisodeRoute {
	const host = url.rawHost || url.hostname;
	if (!host) throw new Error("episode:// needs an episode id or `search`. Use episode://search?q=<term>.");
	if (host.toLowerCase() === "search") {
		const query = url.searchParams.get("q")?.trim();
		if (!query) throw new Error("episode://search needs a query. Use episode://search?q=<term>.");
		return { kind: "search", query };
	}
	const path = (url.rawPathname ?? url.pathname).replace(/^\/+/, "");
	const segments = path.length > 0 ? path.split("/").filter(Boolean) : [];
	const episodeId = host.startsWith("episode:") ? host : `episode:${host}`;
	if (segments.length === 0) return { kind: "overview", episodeId };
	if (segments.length > 1) {
		throw new Error(`Invalid episode:// route: ${url.href}. Use episode://<id> or episode://<id>/<call_id>.`);
	}
	return { kind: "call", episodeId, callId: decodeURIComponent(segments[0]!) };
}

interface EpisodeCall {
	call: ToolCall;
	result?: ToolResultMessage;
}

/** Every tool call in the episode slice, paired with the result carrying its id. */
function collectCalls(entries: readonly SessionEntry[]): EpisodeCall[] {
	const results = new Map<string, ToolResultMessage>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message: AgentMessage = entry.message;
		if (message.role === "toolResult") results.set(message.toolCallId, message);
	}
	const calls: EpisodeCall[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message: AgentMessage = entry.message;
		if (message.role !== "assistant") continue;
		for (const block of (message as AssistantMessage).content) {
			if (block.type !== "toolCall") continue;
			calls.push({ call: block, result: results.get(block.id) });
		}
	}
	return calls;
}

function resultLineCount(result: ToolResultMessage | undefined): number {
	if (!result) return 0;
	const text = contentToText(result.content);
	return text.length === 0 ? 0 : text.split("\n").length;
}

function describeCall(entry: EpisodeCall): string {
	const { call, result } = entry;
	const head = `- \`${call.id}\` → ${call.name}(${formatToolCallPrimaryArg(call.name, call.arguments)})`;
	const lines = resultLineCount(result);
	const count = `${lines} ${lines === 1 ? "line" : "lines"}`;
	if (!result) return `${head} ⇒ pending`;
	return result.isError ? `${head} ⇒ error · ${count}` : `${head} ⇒ ok · ${count}`;
}

function describeEpisode(episode: SessionEpisode): string[] {
	return [
		`- session: ${episode.sessionId}`,
		`- cwd: ${episode.cwd}`,
		`- started: ${new Date(episode.startedAtMs).toISOString()}`,
		`- ended: ${episode.endedAtMs === null ? "(running)" : new Date(episode.endedAtMs).toISOString()}`,
		`- outcome: ${episode.outcome}`,
		`- steps: ${episode.stepCount}`,
	];
}

export class EpisodeProtocolHandler implements ProtocolHandler {
	readonly scheme = "episode";
	readonly spec: SchemeSpec = { backing: "virtual", selectors: "lines", immutable: false, linkable: false };

	promptDoc(): string {
		return episodePromptDoc.trim();
	}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const route = parseEpisodeRoute(url);
		if (route.kind === "search") {
			const hits = await searchEpisodes(route.query, 20);
			const lines = [`# episode search: "${route.query}"`, ""];
			if (hits.length === 0) {
				lines.push(`No episodes matched "${route.query}".`);
			} else {
				for (const episode of hits) {
					const label = episode.focusTitle ?? episode.triggerSummary ?? "(untitled)";
					lines.push(
						`- \`${episode.episodeId}\` · ${new Date(episode.startedAtMs).toISOString()} · ${episode.outcome} · ${episode.stepCount} steps · ${oneLine(label, LABEL_MAX_CHARS)}`,
					);
					if (episode.recap) lines.push(`  recap: ${oneLine(episode.recap, RECAP_MAX_CHARS)}`);
				}
			}
			const content = lines.join("\n");
			return { url: url.href, content, contentType: "text/markdown", size: Buffer.byteLength(content) };
		}

		const episode = getSessionEpisode(route.episodeId);
		if (!episode) throw new Error(`Unknown episode "${route.episodeId}".`);
		const loaded = await loadEpisodeEntries(episode);
		if (!loaded) {
			throw new Error(`Episode "${route.episodeId}" has no readable transcript under ${episode.cwd}.`);
		}
		const slice = episodeSliceEntries(loaded.entries, episode.startEntryId, episode.endEntryId);
		const calls = collectCalls(slice);

		if (route.kind === "call") {
			const match = calls.find(candidate => candidate.call.id === route.callId);
			if (!match) {
				const known = calls
					.slice(0, KNOWN_CALLS_MAX)
					.map(candidate => candidate.call.id)
					.join(", ");
				throw new Error(
					`Episode "${route.episodeId}" has no tool call "${route.callId}".${known ? ` Known calls: ${known}.` : ""}`,
				);
			}
			const args = JSON.stringify(match.call.arguments ?? {}, null, 2);
			const output = match.result ? contentToText(match.result.content) : "(no tool result recorded)";
			const status = match.result ? (match.result.isError ? "error" : "ok") : "pending";
			const content = [
				`# ${route.episodeId} · call ${route.callId}`,
				"",
				`- tool: ${match.call.name}`,
				`- status: ${status}`,
				"",
				"## Arguments",
				"",
				jsonFence(args),
				"",
				"## Output",
				"",
				output,
			].join("\n");
			return { url: url.href, content, contentType: "text/markdown", size: Buffer.byteLength(content) };
		}

		const lines = [
			`# ${route.episodeId}`,
			"",
			...describeEpisode(episode),
			"",
			"## Intent",
			"",
			oneLine(episode.triggerSummary ?? episode.focusTitle ?? "(no recorded trigger)", INTENT_MAX_CHARS),
		];
		if (episode.recap) lines.push("", "## Recap", "", oneLine(episode.recap, RECAP_MAX_CHARS));
		lines.push("", "## Calls", "");
		if (calls.length === 0) lines.push("(no tool calls recorded)");
		else lines.push(...calls.map(describeCall));
		const content = lines.join("\n");
		return { url: url.href, content, contentType: "text/markdown", size: Buffer.byteLength(content) };
	}
}
