import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { readSessionHeaderId } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, isSessionLeaseHeld } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

function userTurn(content: string) {
	return { role: "user" as const, content, timestamp: Date.now() };
}

async function createSession(tempDir: TempDir): Promise<{ sessionId: string; sessionPath: string }> {
	const creator = SessionManager.create(tempDir.path(), tempDir.path(), new FileSessionStorage());
	await creator.ensureOnDisk();
	creator.appendMessage(userTurn("before"));
	const sessionPath = creator.getSessionFile();
	if (!sessionPath) throw new Error("Expected session file");
	await creator.close();
	const sessionId = await readSessionHeaderId(sessionPath);
	if (!sessionId) throw new Error("Expected a session header");
	return { sessionId, sessionPath };
}

describe("strict session reservation", () => {
	it("shares one lease between a reservation and the manager claim that adopts it", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);
		const storage = new FileSessionStorage();

		const reservation = storage.reserveSession(sessionId, sessionPath);
		try {
			expect(isSessionLeaseHeld(sessionId)).toBe(true);
			const releaseManagerHolder = storage.claimSession(sessionId, sessionPath);
			expect(typeof releaseManagerHolder).toBe("function");
			reservation.release();
			expect(isSessionLeaseHeld(sessionId)).toBe(true);
			releaseManagerHolder?.();
			expect(isSessionLeaseHeld(sessionId)).toBe(false);
		} finally {
			reservation.release();
		}
		expect(fs.existsSync(sessionPath)).toBe(true);
	});
});
