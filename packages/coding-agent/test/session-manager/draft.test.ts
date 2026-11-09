import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isEnoent, TempDir } from "@oh-my-pi/pi-utils";

async function fileExists(p: string): Promise<boolean> {
	try {
		await Bun.file(p).stat();
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

describe("SessionManager draft", () => {
	it("round-trips text through saveDraft + consumeDraft", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-roundtrip-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.flush();

		await session.saveDraft("unsent text");

		// Restoring is a read: repeated resumes return the same body and keep it.
		expect(await session.consumeDraft()).toBe("unsent text");
		expect(await session.consumeDraft()).toBe("unsent text");
		const artifactsDir = session.getArtifactsDir();
		if (!artifactsDir) throw new Error("Expected persistent artifacts directory");
		expect(await fileExists(path.join(artifactsDir, "draft.txt"))).toBe(true);
	});

	it("places the draft inside the artifacts directory so dropSession cleans it", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-location-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.flush();

		await session.saveDraft("inside artifacts");

		const artifactsDir = session.getArtifactsDir();
		expect(artifactsDir).not.toBeNull();
		const draftPath = path.join(artifactsDir!, "draft.txt");
		expect(await fileExists(draftPath)).toBe(true);

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await session.dropSession(sessionFile);

		expect(await fileExists(draftPath)).toBe(false);
	});

	// P0: an empty overwrite used to unlink the only copy of a typed draft.
	// It now keeps `draft.txt` as the live source (only a submission clears it)
	// and copies the body into the ring for audit.
	it("keeps the live draft when saving an empty string and records it in the ring", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-empty-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.flush();

		await session.saveDraft("first attempt");
		await session.saveDraft("");

		const artifactsDir = session.getArtifactsDir();
		expect(artifactsDir).not.toBeNull();
		expect(await Bun.file(path.join(artifactsDir!, "draft.txt")).text()).toBe("first attempt");
		expect(await session.consumeDraft()).toBe("first attempt");
		const history = await Bun.file(path.join(artifactsDir!, "draft-history.jsonl")).text();
		expect(history.trim().split("\n")).toHaveLength(1);
		expect(JSON.parse(history.trim())).toMatchObject({ source: "tui", text: "first attempt" });
	});

	it("forces the session header onto disk so resume can find the draft owner", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-ensure-on-disk-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		// No assistant reply yet: without ensureOnDisk the session file would not
		// exist, leaving an orphan draft sidecar that --resume can never reach.
		session.appendMessage({ role: "user", content: "draft only", timestamp: 1 });

		await session.saveDraft("queued for next time");

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(await fileExists(sessionFile)).toBe(true);
	});

	it("starts the revision guard over for a new session file", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-new-session-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "old", timestamp: 1 });
		await session.flush();
		await session.saveDraft("old session draft");

		await session.newSession();
		session.appendMessage({ role: "user", content: "new", timestamp: 2 });
		await session.flush();
		await session.saveDraft("fresh draft");

		const artifactsDir = session.getArtifactsDir();
		if (!artifactsDir) throw new Error("Expected persistent artifacts directory");
		expect(await Bun.file(path.join(artifactsDir, "draft.txt")).text()).toBe("fresh draft");
	});

	it("is a no-op for in-memory sessions", async () => {
		const session = SessionManager.inMemory();

		await session.saveDraft("ignored");
		expect(await session.consumeDraft()).toBeNull();
	});
});
