import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadQueuedMessages, persistQueuedMessages, queuedMessagesPath } from "../src/session/queued-message-persist";

describe("queued-message-persist", () => {
	it("round-trips steering and follow-up, then unlinks on drain", () => {
		const dir = mkdtempSync(join(tmpdir(), "queued-persist-"));
		const artifactsDir = join(dir, "session");
		const file = queuedMessagesPath(artifactsDir, "sess-1");
		try {
			persistQueuedMessages(artifactsDir, "sess-1", {
				steering: [{ role: "user", content: [{ type: "text", text: "steer-me" }], timestamp: 1 }],
				followUp: [{ role: "user", content: [{ type: "text", text: "later" }], timestamp: 2 }],
			});
			expect(existsSync(file)).toBe(true);
			expect(statSync(file).mode & 0o777).toBe(0o600);
			const loaded = loadQueuedMessages(artifactsDir, "sess-1");
			const steer = loaded?.steering[0];
			expect(steer && "content" in steer ? steer.content : null).toEqual([{ type: "text", text: "steer-me" }]);
			expect(loaded?.followUp).toHaveLength(1);
			persistQueuedMessages(artifactsDir, "sess-1", { steering: [], followUp: [] });
			expect(existsSync(file)).toBe(false);
			expect(loadQueuedMessages(artifactsDir, "sess-1")).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps sessions that share an artifacts directory apart", () => {
		const dir = mkdtempSync(join(tmpdir(), "queued-persist-shared-"));
		try {
			persistQueuedMessages(dir, "child", {
				steering: [{ role: "user", content: [{ type: "text", text: "child-steer" }], timestamp: 1 }],
				followUp: [],
			});
			persistQueuedMessages(dir, "parent", { steering: [], followUp: [] });
			expect(loadQueuedMessages(dir, "child")?.steering).toHaveLength(1);
			expect(loadQueuedMessages(dir, "parent")).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a version-matching sidecar whose queue entries are not messages", () => {
		const dir = mkdtempSync(join(tmpdir(), "queued-persist-bad-"));
		const artifactsDir = join(dir, "session");
		const file = queuedMessagesPath(artifactsDir, "sess-1");
		try {
			mkdirSync(artifactsDir, { recursive: true });
			writeFileSync(file, JSON.stringify({ version: 1, steering: [{ content: [] }], followUp: [] }));
			expect(loadQueuedMessages(artifactsDir, "sess-1")).toBeNull();
			writeFileSync(file, JSON.stringify({ version: 1, steering: [], followUp: [null] }));
			expect(loadQueuedMessages(artifactsDir, "sess-1")).toBeNull();
			writeFileSync(
				file,
				JSON.stringify({
					version: 2,
					steering: [{ role: "user", content: [], timestamp: 1 }],
					followUp: [],
				}),
			);
			expect(loadQueuedMessages(artifactsDir, "sess-1")).toBeNull();
			writeFileSync(
				file,
				JSON.stringify({ version: 1, steering: [{ role: "user", content: [], timestamp: 1 }], followUp: [] }),
			);
			expect(loadQueuedMessages(artifactsDir, "sess-1")?.steering).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
