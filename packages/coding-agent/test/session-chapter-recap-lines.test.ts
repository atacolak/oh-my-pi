/**
 * The recap prompt may repeat what an earlier recap already logged, so the
 * request carries the chapter's own earlier recaps and only those: a chapter is
 * defined by its `focus_title`, and a retitled session starts a new chapter that
 * must not inherit the previous one's lines.
 */

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	closeSessionIndex,
	finishSessionEpisode,
	listChapterRecapLines,
	recordSessionEpisodeRecap,
	startSessionEpisode,
} from "@oh-my-pi/pi-coding-agent/session/session-index";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

setDefaultTimeout(30_000);

const SESSION = "sid-chapters";
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let root = "";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-chapter-recaps-"));
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

/** One settled episode under `focusTitle`; `null` leaves the row unrecapped. */
function seedEpisode(episodeId: string, focusTitle: string, recap: string | null, startedAtMs: number): void {
	startSessionEpisode({ episodeId, sessionId: SESSION, cwd: "/repo", startedAtMs, focusTitle });
	finishSessionEpisode({ episodeId, endedAtMs: startedAtMs + 500, stepCount: 1, outcome: "ok" });
	if (recap !== null) recordSessionEpisodeRecap(episodeId, recap);
}

describe("chapter recap lines", () => {
	it("returns nothing for a new chapter while the session's earlier chapter has recaps", () => {
		for (let index = 1; index <= 6; index++) {
			seedEpisode(`previous-${index}`, "earlier chapter", `earlier recap ${index}`, index * 1_000);
		}
		expect(listChapterRecapLines(SESSION, "new chapter", 5)).toBe("");
	});

	it("renders the five most recent recaps of the chapter oldest first, one bullet per line", () => {
		for (let index = 1; index <= 6; index++) {
			seedEpisode(`episode-${index}`, "chapter one", `recap ${index}`, index * 1_000);
		}
		expect(listChapterRecapLines(SESSION, "chapter one", 5)).toBe(
			"- recap 2\n- recap 3\n- recap 4\n- recap 5\n- recap 6",
		);
	});

	it("skips episodes with no recap or a blank one instead of rendering an empty bullet", () => {
		seedEpisode("no-recap", "chapter one", null, 1_000);
		seedEpisode("empty-recap", "chapter one", "", 2_000);
		seedEpisode("blank-recap", "chapter one", "  \n", 3_000);
		seedEpisode("real-recap", "chapter one", "the real move", 4_000);
		expect(listChapterRecapLines(SESSION, "chapter one", 5)).toBe("- the real move");
	});

	it("keeps every bullet on one line when a recap spans lines", () => {
		seedEpisode("multi-line", "chapter one", "moved the parser\nand fixed the guard", 1_000);
		expect(listChapterRecapLines(SESSION, "chapter one", 5)).toBe("- moved the parser and fixed the guard");
	});
});
