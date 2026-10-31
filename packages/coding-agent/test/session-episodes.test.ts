import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	closeSessionIndex,
	finishSessionEpisode,
	listSessionEpisodes,
	recordSessionEpisodeRecap,
	startSessionEpisode,
} from "@oh-my-pi/pi-coding-agent/session/session-index";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let root = "";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-episodes-"));
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

const open = (episodeId: string, sessionId = "sid-1", startedAtMs = 1_000) =>
	startSessionEpisode({ episodeId, sessionId, cwd: "/repo", startedAtMs, focusTitle: "focus one" });

describe("session_episodes", () => {
	it("opens a row with no end and closes it with the facts only the end knows", () => {
		open("ep-1");
		const started = listSessionEpisodes("sid-1");
		expect(started).toHaveLength(1);
		expect(started[0]!.outcome).toBe("running");
		expect(started[0]!.endedAtMs).toBeNull();

		finishSessionEpisode({ episodeId: "ep-1", endedAtMs: 5_000, stepCount: 3, outcome: "ok" });
		const closed = listSessionEpisodes("sid-1")[0]!;
		expect(closed.outcome).toBe("ok");
		expect(closed.endedAtMs).toBe(5_000);
		expect(closed.stepCount).toBe(3);
	});

	it("reaps a row the previous run left open instead of reporting it running", () => {
		// The process died before agent_end: the row is still open when the next run
		// starts. It must not keep claiming to run, and it must not be given an end.
		open("ep-1");
		open("ep-2", "sid-1", 9_000);
		const rows = listSessionEpisodes("sid-1");
		expect(rows.map(row => row.outcome)).toEqual(["interrupted", "running"]);
		expect(rows[0]!.endedAtMs).toBeNull();
	});

	it("attaches the settle recap to the episode that produced it", () => {
		open("ep-1");
		recordSessionEpisodeRecap("ep-1", "did the thing");
		expect(listSessionEpisodes("sid-1")[0]!.recap).toBe("did the thing");
	});

	it("keeps sessions apart", () => {
		open("ep-1", "sid-1");
		open("ep-2", "sid-2");
		open("ep-3", "sid-2", 2_000);
		expect(listSessionEpisodes("sid-1").map(row => row.outcome)).toEqual(["running"]);
		expect(listSessionEpisodes("sid-2").map(row => row.outcome)).toEqual(["interrupted", "running"]);
	});
});
