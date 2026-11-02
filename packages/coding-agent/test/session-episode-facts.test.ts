import { describe, expect, it } from "bun:test";
import { deriveEpisodeFacts } from "@oh-my-pi/pi-coding-agent/session/episode-facts";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

let seq = 0;
function message(role: "user" | "assistant" | "toolResult", content: unknown, id?: string): SessionEntry {
	const entryId = id ?? `e${++seq}`;
	const base = { type: "message" as const, id: entryId, parentId: null, timestamp: new Date(0).toISOString() };
	if (role === "toolResult") {
		return { ...base, message: { role, toolCallId: "c1", toolName: "bash", content, isError: false, timestamp: 0 } };
	}
	return { ...base, message: { role, content, api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop", timestamp: 0 } };
}

const text = (value: string) => [{ type: "text", text: value }];

describe("deriveEpisodeFacts", () => {
	it("takes the first user message after the episode's start entry as its trigger", () => {
		const entries: SessionEntry[] = [
			message("user", text("an older turn before this run"), "start"),
			message("assistant", text("older reply"), "old-reply"),
			message("user", text("Fix the\n  retry loop in sync.ts"), "first"),
			message("assistant", text("working"), "reply"),
		];
		const facts = deriveEpisodeFacts(entries, "start", "reply");
		expect(facts.triggerSummary).toBe("Fix the retry loop in sync.ts");
	});

	it("collects one bounded target per tool call in the episode slice", () => {
		const entries: SessionEntry[] = [
			message("user", text("do it"), "start"),
			message("user", text("go"), "go"),
			message(
				"assistant",
				[
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/sync.ts", offset: 10 } },
					{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "bun test sync.test.ts" } },
				],
				"calls",
			),
			message("toolResult", text("ok"), "result"),
		];
		const facts = deriveEpisodeFacts(entries, "start", "result");
		expect(facts.toolTargets).toContain("read(src/sync.ts");
		expect(facts.toolTargets).toContain("bash(bun test sync.test.ts)");
	});

	it("ignores entries outside the episode slice", () => {
		const entries: SessionEntry[] = [
			message("user", text("outside before"), "before"),
			message("user", text("the start marker itself"), "start"),
			message("user", text("inside"), "inside"),
			message("assistant", text("reply"), "end"),
			message("user", text("after the end"), "later"),
		];
		const facts = deriveEpisodeFacts(entries, "start", "end");
		expect(facts.triggerSummary).toBe("inside");
		expect(facts.toolTargets).toBeNull();
	});

	it("returns no facts when the start entry is unknown", () => {
		expect(deriveEpisodeFacts([message("user", text("hi"), "only")], "missing", null)).toEqual({
			triggerSummary: null,
			toolTargets: null,
		});
	});
});
