import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import { formatToolCallPrimaryArg } from "./session-history-format";
import type { SessionEntry } from "./session-entries";

export interface EpisodeFacts {
	triggerSummary: string | null;
	toolTargets: string | null;
}

const TRIGGER_MAX_CHARS = 240;
const TOOL_TARGET_MAX_ENTRIES = 40;
const TOOL_TARGETS_MAX_CHARS = 2_000;

/** Collapse whitespace runs and truncate to one bounded line. */
function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Text of a user message, including a subagent session's initial task. */
function triggerText(entry: SessionEntry): string | undefined {
	if (entry.type === "session_init") return entry.task;
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role !== "user") return undefined;
	const { content } = message;
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join(" ");
}

function toolCalls(message: AgentMessage): readonly ToolCall[] {
	if (message.role !== "assistant") return [];
	return (message as AssistantMessage).content.filter((block): block is ToolCall => block.type === "toolCall");
}

function sliceEntries(
	entries: readonly SessionEntry[],
	startEntryId: string | null,
	endEntryId: string | null,
): readonly SessionEntry[] {
	if (!startEntryId) return [];
	const start = entries.findIndex(entry => entry.id === startEntryId);
	if (start < 0) return [];
	const end = endEntryId ? entries.findIndex((entry, index) => index > start && entry.id === endEntryId) : -1;
	return entries.slice(start + 1, end < 0 ? entries.length : end + 1);
}

/**
 * Trigger and tool targets of the run an episode row describes, read from the
 * entries between its start entry (exclusive) and end entry (inclusive).
 *
 * The start entry is the leaf the run began from, so the run's own first user
 * message follows it; reading backwards or guessing by timestamp would label
 * the episode with the previous run's prompt.
 */
export function deriveEpisodeFacts(
	entries: readonly SessionEntry[],
	startEntryId: string | null,
	endEntryId: string | null,
): EpisodeFacts {
	const slice = sliceEntries(entries, startEntryId, endEntryId);
	let triggerSummary: string | null = null;
	const targets: string[] = [];
	const seen = new Set<string>();
	for (const entry of slice) {
		triggerSummary ??= triggerText(entry) ? oneLine(triggerText(entry)!, TRIGGER_MAX_CHARS) : null;
		if (entry.type !== "message") continue;
		for (const call of toolCalls(entry.message)) {
			const target = `${call.name}(${formatToolCallPrimaryArg(call.name, call.arguments)})`;
			if (seen.has(target)) continue;
			seen.add(target);
			targets.push(target);
		}
	}
	let toolTargets: string | null = null;
	if (targets.length > 0) {
		const joined = targets.slice(0, TOOL_TARGET_MAX_ENTRIES).join("; ");
		toolTargets = oneLine(joined, TOOL_TARGETS_MAX_CHARS);
	}
	return { triggerSummary, toolTargets };
}
