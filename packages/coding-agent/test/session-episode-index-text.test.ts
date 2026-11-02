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
