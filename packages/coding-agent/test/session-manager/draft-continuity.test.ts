import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ComposerDraftPersistence } from "../../src/modes/draft-persistence";
import { TempDir } from "@oh-my-pi/pi-utils";

const DRAFT_HISTORY_FILENAME = "draft-history.jsonl";

async function fileText(file: string): Promise<string | null> {
	try {
		return await Bun.file(file).text();
	} catch {
		return null;
	}
}

describe("composer draft continuity", () => {
	// P0 data loss: the composer was cleared (Escape / Ctrl+C) and teardown then
	// saved an empty draft, which unlinked the only copy. The clear beats the
	// typing debounce here, so this is the worst case: the text never reached
	// draft.txt before the clear. It still must be recoverable from the same
	// session after the empty teardown save.
	it("keeps typed text recoverable when a clear beats the debounce and teardown saves empty", async () => {
		using tempDir = TempDir.createSync("@pi-draft-continuity-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		const persistence = new ComposerDraftPersistence({
			saveDraft: text => session.saveDraft(text),
			discardDraft: () => session.discardDraft(),
		});
		const typed = "line one\nline two\nline three";

		persistence.schedule(typed); // the person is typing; debounce pending
		persistence.schedule(""); // Escape / Ctrl+C cleared the composer
		await persistence.flush(); // teardown lands the pending write first
		await session.saveDraft(""); // teardown snapshots the now-empty editor

		const artifactsDir = session.getArtifactsDir();
		if (!artifactsDir) throw new Error("Expected a persistent artifacts directory");
		// An empty save still unlinks the sidecar; close-time GC depends on that.
		expect(await fileText(path.join(artifactsDir, "draft.txt"))).toBeNull();

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const resumed = SessionManager.create(tempDir.path(), tempDir.path());
		await resumed.setSessionFile(sessionFile);

		expect(await resumed.consumeDraft()).toBe(typed);
	});

	it("does not resurrect a submitted draft on resume", async () => {
		using tempDir = TempDir.createSync("@pi-draft-submit-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		const persistence = new ComposerDraftPersistence({
			saveDraft: text => session.saveDraft(text),
			discardDraft: () => session.discardDraft(),
		});
		const submitted = "submitted\nmulti-line\nprompt";

		persistence.schedule(submitted);
		await persistence.flush();
		persistence.schedule("");
		await persistence.discard();
		await persistence.flush();
		await session.saveDraft("");

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const resumed = SessionManager.create(tempDir.path(), tempDir.path());
		await resumed.setSessionFile(sessionFile);

		expect(await resumed.consumeDraftEntry()).toBeNull();
	});

	it("bounds the recoverable draft ring", async () => {
		using tempDir = TempDir.createSync("@pi-draft-continuity-bound-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		await session.saveDraft("draft zero");
		for (let index = 1; index <= 8; index++) {
			await session.saveDraft(`draft ${index}`);
			await session.saveDraft("");
			await session.saveDraft(`draft ${index}`);
		}
		await session.saveDraft("");

		const historyPath = path.join(session.getArtifactsDir()!, DRAFT_HISTORY_FILENAME);
		const lines = (await fileText(historyPath))?.split("\n").filter(line => line.trim().length > 0) ?? [];
		expect(lines.length).toBe(5);
	});
});
