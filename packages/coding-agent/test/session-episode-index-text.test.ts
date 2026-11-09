import { describe, expect, it } from "bun:test";
import { formatEpisodeIndex } from "@oh-my-pi/pi-coding-agent/session/episode-index-text";
import type { SessionEpisode } from "@oh-my-pi/pi-coding-agent/session/session-index";

function episode(overrides: Partial<SessionEpisode> = {}): SessionEpisode {
	return {
		episodeId: "episode:abc",
		sessionId: "sid-1",
		cwd: "/repo",
		startedAtMs: Date.parse("2026-01-02T03:04:05.000Z"),
		endedAtMs: Date.parse("2026-01-02T03:05:05.000Z"),
		focusTitle: null,
		triggerKind: null,
		triggerSummary: "Fix the retry loop in sync.ts",
		stepCount: 3,
		startEntryId: "start",
		endEntryId: "end",
		outcome: "ok",
		recap: "retry loop now retries three times",
		toolTargets: "read(src/sync.ts); bash(bun test sync.test.ts)",
		...overrides,
	};
}

describe("formatEpisodeIndex", () => {
	it("returns undefined when the session has no episodes", () => {
		expect(formatEpisodeIndex([])).toBeUndefined();
	});

	it("writes one bounded line per episode with its trigger, recap and tools", () => {
		const text = formatEpisodeIndex([episode()]);
		expect(text).toContain("episode:abc");
		expect(text).toContain("ok");
		expect(text).toContain("3 steps");
		expect(text).toContain("Fix the retry loop in sync.ts");
		expect(text).toContain("recap: retry loop now retries three times");
		expect(text).toContain("bash(bun test sync.test.ts)");
		expect(text?.split("\n")).toHaveLength(1);
	});

	it("groups consecutive episodes that share a focus title under one chapter header", () => {
		const episodes = [
			episode({ episodeId: "episode:1", focusTitle: "Ship search", startedAtMs: 1_000 }),
			episode({ episodeId: "episode:2", focusTitle: "Ship search", startedAtMs: 2_000 }),
			episode({ episodeId: "episode:3", focusTitle: "Fix recap", startedAtMs: 3_000 }),
			episode({ episodeId: "episode:4", focusTitle: "Fix recap", startedAtMs: 4_000 }),
		];
		const text = formatEpisodeIndex(episodes)!;
		const lines = text.split("\n");
		expect(lines.filter(line => line === "### Ship search")).toHaveLength(1);
		expect(lines.filter(line => line === "### Fix recap")).toHaveLength(1);
		expect(lines.indexOf("### Ship search")).toBeLessThan(lines.indexOf("### Fix recap"));
		expect(lines.indexOf("episode:2")).toBeLessThan(lines.indexOf("### Fix recap"));
	});

	it("starts a new chapter on a title change and never merges non-consecutive duplicates", () => {
		const episodes = [
			episode({ episodeId: "episode:1", focusTitle: "A", startedAtMs: 1_000 }),
			episode({ episodeId: "episode:2", focusTitle: "B", startedAtMs: 2_000 }),
			episode({ episodeId: "episode:3", focusTitle: "A", startedAtMs: 3_000 }),
		];
		const text = formatEpisodeIndex(episodes)!;
		const lines = text.split("\n");
		expect(lines.filter(line => line === "### A")).toHaveLength(2);
		expect(lines.filter(line => line === "### B")).toHaveLength(1);
		expect(lines.indexOf("### A")).toBeLessThan(lines.indexOf("### B"));
		expect(lines.lastIndexOf("### A")).toBeGreaterThan(lines.indexOf("### B"));
	});

	it("leaves untitled episodes as flat lines with no synthetic header", () => {
		const text = formatEpisodeIndex([
			episode({ focusTitle: null }),
			episode({ episodeId: "episode:x", focusTitle: null }),
		])!;
		expect(text).not.toContain("###");
		expect(text.split("\n")).toHaveLength(2);
	});

	it("keeps only the newest twelve episodes", () => {
		const episodes = Array.from({ length: 13 }, (_, index) =>
			episode({ episodeId: `episode:${index}`, startedAtMs: index * 1_000 }),
		);
		const lines = formatEpisodeIndex(episodes)?.split("\n") ?? [];
		expect(lines).toHaveLength(12);
		expect(lines[0]).toContain("episode:1");
		expect(lines.at(-1)).toContain("episode:12");
	});
});
