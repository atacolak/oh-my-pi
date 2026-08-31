import { describe, expect, test } from "bun:test";
import {
	type CompactionEntry,
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
	prepareCompactionThroughEntry,
	type SessionEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import { createAssistantMessage, createUserMessage } from "./helpers";

let seq = 0;
function base(type: string) {
	const id = `e${seq++}`;
	return { id, parentId: null, timestamp: new Date().toISOString(), type };
}
function userEntry(text: string): SessionEntry {
	return { ...base("message"), type: "message", message: createUserMessage(text) };
}
function assistantEntry(text: string): SessionEntry {
	return {
		...base("message"),
		type: "message",
		message: createAssistantMessage([{ type: "text", text }]),
	};
}
function resetBoundary(): SessionEntry {
	return { ...base("reset_boundary"), type: "reset_boundary" };
}
function compaction(summary: string, firstKeptEntryId: string): SessionEntry {
	const entry: CompactionEntry = {
		...base("compaction"),
		type: "compaction",
		summary,
		firstKeptEntryId,
		tokensBefore: 0,
	};
	return entry;
}

describe("prepareCompaction reset boundary", () => {
	test("does not resurrect pre-clear turns into the summary", () => {
		const entries: SessionEntry[] = [
			userEntry("PRECLEAR user request"),
			assistantEntry("PRECLEAR assistant answer"),
			resetBoundary(),
			userEntry("POSTCLEAR first request"),
			assistantEntry("POSTCLEAR first answer"),
			userEntry("POSTCLEAR second request"),
			assistantEntry("POSTCLEAR second answer"),
		];
		const prep = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 });
		expect(prep).toBeDefined();
		const summarized = JSON.stringify(prep?.messagesToSummarize ?? []);
		const kept = JSON.stringify([...(prep?.turnPrefixMessages ?? []), ...(prep?.recentMessages ?? [])]);
		expect(summarized).not.toContain("PRECLEAR");
		expect(kept).not.toContain("PRECLEAR");
		expect(summarized).toContain("POSTCLEAR first");
	});

	test("a reset boundary after the last compaction drops that compaction's summary reuse", () => {
		const entries: SessionEntry[] = [
			userEntry("OLD user"),
			assistantEntry("OLD assistant"),
			compaction("OLD SUMMARY", "kept-old"),
			userEntry("MIDCLEAR user"),
			assistantEntry("MIDCLEAR assistant"),
			resetBoundary(),
			userEntry("POST first"),
			assistantEntry("POST first answer"),
			userEntry("POST second"),
			assistantEntry("POST second answer"),
		];
		const prep = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 });
		expect(prep).toBeDefined();
		// The cleared compaction is not reused as previous context.
		expect(prep?.previousSummary).toBeUndefined();
		const summarized = JSON.stringify(prep?.messagesToSummarize ?? []);
		expect(summarized).not.toContain("MIDCLEAR");
		expect(summarized).not.toContain("OLD");
		expect(summarized).toContain("POST first");
	});

	test("a reset boundary before the last compaction is superseded by it", () => {
		const entries: SessionEntry[] = [
			userEntry("PRE user"),
			resetBoundary(),
			userEntry("MID user"),
			assistantEntry("MID assistant"),
			compaction("KEEP SUMMARY", "kept-mid"),
			userEntry("TAIL one"),
			assistantEntry("TAIL one answer"),
			userEntry("TAIL two"),
			assistantEntry("TAIL two answer"),
		];
		const prep = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 });
		expect(prep).toBeDefined();
		// Compaction after the boundary wins: its summary is still reused.
		expect(prep?.previousSummary).toBe("KEEP SUMMARY");
		const summarized = JSON.stringify(prep?.messagesToSummarize ?? []);
		expect(summarized).toContain("TAIL one");
		expect(summarized).not.toContain("MID");
	});
});

describe("prepareCompactionThroughEntry", () => {
	test("includes stock recentMessages in the semantic input through the checkpoint", () => {
		const entries: SessionEntry[] = [
			userEntry("OLD one"),
			assistantEntry("OLD one answer"),
			userEntry("OLD two"),
			assistantEntry("OLD two answer"),
			userEntry("RECENT request"),
			assistantEntry("RECENT answer"),
		];
		const checkpoint = entries.at(-1)!;
		const stock = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 });
		expect(stock).toBeDefined();
		expect(JSON.stringify(stock?.recentMessages ?? [])).toContain("RECENT");
		expect(JSON.stringify(stock?.messagesToSummarize ?? [])).not.toContain("RECENT");

		const through = prepareCompactionThroughEntry(
			entries,
			{ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 },
			checkpoint.id,
		);
		expect(through).toBeDefined();
		expect(through?.firstKeptEntryId).toBe(checkpoint.id);
		expect(through?.recentMessages).toEqual([]);
		expect(through?.turnPrefixMessages).toEqual([]);
		expect(through?.isSplitTurn).toBe(false);
		const summarized = JSON.stringify(through?.messagesToSummarize ?? []);
		expect(summarized).toContain("OLD one");
		expect(summarized).toContain("RECENT");
	});
});
