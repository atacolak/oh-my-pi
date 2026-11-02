import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	closeSessionIndex,
	finishSessionEpisode,
	listSessionEpisodes,
	recordSessionEpisodeRecap,
	startSessionEpisode,
} from "@oh-my-pi/pi-coding-agent/session/session-index";
import { ensureEpisodeSearchIndex, searchEpisodes } from "@oh-my-pi/pi-coding-agent/session/episode-store";
import { sessionDirForCwd } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let root = "";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-episode-search-"));
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	setAgentDir(path.join(root, "agent"));
	closeSessionIndex();
});

afterEach(() => {
	closeSessionIndex();
	removeSyncWithRetries(root);
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	setAgentDir(originalAgentDir ?? path.join(getConfigRootDir(), "agent"));
});

function entry(role: "user" | "assistant", content: unknown, id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role,
			content,
			api: "x",
			provider: "x",
			model: "x",
			usage: {},
			stopReason: "stop",
			timestamp: 0,
		} as never,
	};
}

const userText = (text: string, id: string) => entry("user", [{ type: "text", text }], id);

function writeSession(cwd: string, sessionId: string, entries: SessionEntry[], fileName?: string): string {
	const dir = sessionDirForCwd(cwd);
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(dir, fileName ?? `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
	const header = { type: "session", version: 3, id: sessionId, timestamp: new Date(0).toISOString(), cwd };
	fs.writeFileSync(target, `${[header, ...entries].map(value => JSON.stringify(value)).join("\n")}\n`, "utf8");
	return target;
}

function legacyEpisode(sessionId: string, cwd: string, startEntryId: string): void {
	startSessionEpisode({ episodeId: `episode:${sessionId}`, sessionId, cwd, startedAtMs: 1_000, startEntryId });
	finishSessionEpisode({ episodeId: `episode:${sessionId}`, endedAtMs: 2_000, stepCount: 0, outcome: "ok" });
}

describe("episode search index", () => {
	it("backfills a legacy NULL row from its JSONL once, and search finds it", async () => {
		const sessionId = "sid-legacy";
		const cwd = "/repo/legacy";
		legacyEpisode(sessionId, cwd, "leaf");
		const file = writeSession(cwd, sessionId, [
			userText("an earlier prompt", "leaf"),
			userText("Fix the retry loop in sync.ts", "prompt"),
			entry(
				"assistant",
				[{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "bun test retry.test.ts" } }],
				"call",
			),
		]);
		expect(listSessionEpisodes(sessionId)[0]!.triggerSummary).toBeNull();

		await ensureEpisodeSearchIndex();
		const row = listSessionEpisodes(sessionId)[0]!;
		expect(row.triggerSummary).toBe("Fix the retry loop in sync.ts");
		expect(row.toolTargets).toContain("bun test retry.test.ts");

		const hits = await searchEpisodes("retry");
		expect(hits.map(hit => hit.episodeId)).toContain(`episode:${sessionId}`);
		expect(await searchEpisodes("quasar")).toEqual([]);

		fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd }) + "\n");
		await ensureEpisodeSearchIndex();
		expect(listSessionEpisodes(sessionId)[0]!.triggerSummary).toBe("Fix the retry loop in sync.ts");
		expect(await searchEpisodes("retry")).toHaveLength(1);
	});

	it("indexes a recap even when no title or trigger mentions the term", async () => {
		const sessionId = "sid-recap";
		const cwd = "/repo/recap";
		writeSession(cwd, sessionId, [userText("an earlier prompt", "leaf"), userText("do the thing", "prompt")]);
		legacyEpisode(sessionId, cwd, "leaf");
		await ensureEpisodeSearchIndex();
		expect(await searchEpisodes("zebra")).toEqual([]);

		recordSessionEpisodeRecap(`episode:${sessionId}`, "zebra migration finished");
		const hits = await searchEpisodes("zebra");
		expect(hits.map(hit => hit.episodeId)).toEqual([`episode:${sessionId}`]);
	});

	it("indexes an episode written after the build through the write path", async () => {
		writeSession("/repo/fresh", "sid-fresh", [userText("older", "root")]);
		legacyEpisode("sid-seed", "/repo/seed", "root");
		await ensureEpisodeSearchIndex();

		const entries = [userText("older", "start"), userText("kestrel migration", "prompt")];
		startSessionEpisode({
			episodeId: "episode:fresh",
			sessionId: "sid-fresh",
			cwd: "/repo/fresh",
			startedAtMs: 3_000,
			startEntryId: "start",
		});
		finishSessionEpisode({
			episodeId: "episode:fresh",
			endedAtMs: 4_000,
			stepCount: 1,
			outcome: "ok",
			endEntryId: "prompt",
			entries,
		});
		const hits = await searchEpisodes("kestrel");
		expect(hits.map(hit => hit.episodeId)).toEqual(["episode:fresh"]);
	});
});
