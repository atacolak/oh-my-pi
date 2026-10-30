import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadQueuedMessages, persistQueuedMessages, queuedMessagesPath } from "../src/session/queued-message-persist";

describe("queued-message-persist", () => {
	it("round-trips steering and follow-up, then unlinks on drain", () => {
		const dir = mkdtempSync(join(tmpdir(), "queued-persist-"));
		const sessionFile = join(dir, "session.jsonl");
		try {
			persistQueuedMessages(sessionFile, {
				steering: [{ role: "user", content: [{ type: "text", text: "steer-me" }], timestamp: 1 }],
				followUp: [{ role: "user", content: [{ type: "text", text: "later" }], timestamp: 2 }],
			});
			expect(existsSync(queuedMessagesPath(sessionFile))).toBe(true);
			expect(statSync(queuedMessagesPath(sessionFile)).mode & 0o777).toBe(0o600);
			const loaded = loadQueuedMessages(sessionFile);
			expect(loaded?.steering[0] && "content" in loaded.steering[0] ? loaded.steering[0].content : null).toEqual([
				{ type: "text", text: "steer-me" },
			]);
			expect(loaded?.followUp).toHaveLength(1);
			persistQueuedMessages(sessionFile, { steering: [], followUp: [] });
			expect(existsSync(queuedMessagesPath(sessionFile))).toBe(false);
			expect(loadQueuedMessages(sessionFile)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
