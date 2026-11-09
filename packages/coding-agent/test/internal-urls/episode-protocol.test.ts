/**
 * Contracts: episode:// protocol handler.
 *
 * - `episode://<id>` is the high-level overview: intent plus one bounded line
 *   per tool call. It is for orientation, so it never carries a full payload.
 * - `episode://<id>/<call_id>` is the recovery route: the untruncated arguments
 *   AND output of that one call.
 * - `episode://search?q=` is an FTS lookup over focus title, trigger summary,
 *   recap and tool targets.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	closeSessionIndex,
	finishSessionEpisode,
	recordSessionEpisodeRecap,
	startSessionEpisode,
} from "@oh-my-pi/pi-coding-agent/session/session-index";
import { sessionDirForCwd } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const ARG_MARKER = `ARG-${"a".repeat(4_000)}`;
const OUTPUT_MARKER = `OUT-${"b".repeat(4_000)}`;
const episodeId = "episode:1234-abcd";
const sessionId = "sid-episode-route";
const cwd = "/repo/episode-route";
let root = "";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-episode-route-"));
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

function message(
	role: "user" | "assistant" | "toolResult",
	content: unknown,
	id: string,
	extra: Record<string, unknown> = {},
): SessionEntry {
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
			...extra,
		} as never,
	};
}

function writeSession(entries: SessionEntry[]): void {
	const dir = sessionDirForCwd(cwd);
	fs.mkdirSync(dir, { recursive: true });
	const header = { type: "session", version: 3, id: sessionId, timestamp: new Date(0).toISOString(), cwd };
	fs.writeFileSync(
		path.join(dir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`),
		`${[header, ...entries].map(value => JSON.stringify(value)).join("\n")}\n`,
		"utf8",
	);
}

function seedEpisode(): void {
	const entries: SessionEntry[] = [
		message("user", [{ type: "text", text: "an earlier prompt" }], "start"),
		message("user", [{ type: "text", text: "Refactor the retry loop" }], "prompt"),
		message(
			"assistant",
			[
				{
					type: "toolCall",
					id: "call_long",
					name: "bash",
					arguments: { command: `printf '%s' '${ARG_MARKER}'` },
				},
			],
			"call",
		),
		message("toolResult", [{ type: "text", text: OUTPUT_MARKER }], "result", {
			toolCallId: "call_long",
			toolName: "bash",
			isError: false,
		}),
		message("assistant", [{ type: "text", text: "Done." }], "reply"),
	];
	writeSession(entries);
	startSessionEpisode({ episodeId, sessionId, cwd, startedAtMs: 1_000, startEntryId: "start" });
	finishSessionEpisode({
		episodeId,
		endedAtMs: 2_000,
		stepCount: 2,
		outcome: "ok",
		endEntryId: "reply",
		entries,
	});
	recordSessionEpisodeRecap(episodeId, "zebra migration finished");
}

describe("episode:// protocol", () => {
	it("renders a bounded overview and an untruncated detail route for the same call", async () => {
		seedEpisode();
		const router = InternalUrlRouter.instance();

		const overview = await router.resolve(`episode://${episodeId}`);
		expect(overview.content).toContain("Refactor the retry loop");
		expect(overview.content).toContain("call_long");
		expect(overview.content).toContain("bash(");
		expect(overview.content).not.toContain(ARG_MARKER);
		expect(overview.content).not.toContain(OUTPUT_MARKER);

		const detail = await router.resolve(`episode://${episodeId}/call_long`);
		expect(detail.content).toContain(ARG_MARKER);
		expect(detail.content).toContain(OUTPUT_MARKER);
	});

	it("finds an episode by a term in its trigger and returns nothing for an absent term", async () => {
		seedEpisode();
		const router = InternalUrlRouter.instance();

		const hit = await router.resolve("episode://search?q=retry");
		expect(hit.content).toContain(episodeId);

		const miss = await router.resolve("episode://search?q=quasar");
		expect(miss.content).not.toContain(episodeId);
	});

	it("finds an episode by a term that only its recap carries", async () => {
		seedEpisode();
		const router = InternalUrlRouter.instance();
		const hit = await router.resolve("episode://search?q=zebra");
		expect(hit.content).toContain(episodeId);
	});
});
