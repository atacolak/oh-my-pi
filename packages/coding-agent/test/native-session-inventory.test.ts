import { expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { NativeSessionService } from "@oh-my-pi/pi-coding-agent/session/session-service";
import { TempDir } from "@oh-my-pi/pi-utils";

it("reports both historical claimants even when neither appears on the requested inventory page", async () => {
	await using tmp = await TempDir.create("omp-native-inventory-");
	const sessionsRoot = path.join(tmp.path(), "sessions");
	const service = new NativeSessionService({ sessionsRoot, endpointDir: path.join(tmp.path(), "run") });
	async function historicalSession(handle: string): Promise<string> {
		const manager = SessionManager.create(tmp.path(), sessionsRoot);
		try {
			await manager.ensureOnDisk();
			// Fixtures represent claims already on disk, not the public name-assignment operation.
			manager.appendSessionIdentityMetadata({ version: 1, actorHandle: handle });
			await manager.flush();
			return manager.getSessionId();
		} finally {
			await manager.close();
		}
	}
	const first = await historicalSession("Games");
	const second = await historicalSession("games");
	const unaffected = await historicalSession("atlas");
	const page = await service.list({ query: "ATLAS", limit: 1, probe: false });
	expect(page.sessions.map(session => session.sessionId)).toEqual([unaffected]);
	expect(page.conflicts).toEqual([{ code: "duplicate_handle", handle: "games", sessionIds: [first, second].sort() }]);
});
