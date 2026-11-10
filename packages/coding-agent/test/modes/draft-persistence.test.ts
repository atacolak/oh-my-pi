import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ComposerDraftPersistence, type ComposerDraftStore } from "../../src/modes/draft-persistence";
import { TempDir } from "@oh-my-pi/pi-utils";

class RecordingDraftStore implements ComposerDraftStore {
	readonly calls: string[] = [];
	async saveDraft(text: string): Promise<void> {
		this.calls.push(`save:${text}`);
	}
	async discardDraft(text: string): Promise<void> {
		this.calls.push(`discard:${text}`);
	}
}

describe("ComposerDraftPersistence", () => {
	it("coalesces a typing burst into one write of the latest text", async () => {
		const store = new RecordingDraftStore();
		const persistence = new ComposerDraftPersistence(store, 1000);

		persistence.schedule("line one");
		persistence.schedule("line one\nline two");
		persistence.schedule("line one\nline two\nline three");
		await persistence.flush();

		expect(store.calls).toEqual(["save:line one\nline two\nline three"]);
	});

	it("persists the newest typed text before a clear can archive it", async () => {
		const store = new RecordingDraftStore();
		const persistence = new ComposerDraftPersistence(store, 1000);

		persistence.schedule("typed but not yet written");
		persistence.schedule("");
		await persistence.flush();

		expect(store.calls).toEqual(["save:typed but not yet written", "save:"]);
	});

	it("does not write anything for a clear that follows a completed save", async () => {
		const store = new RecordingDraftStore();
		const persistence = new ComposerDraftPersistence(store, 1000);

		persistence.schedule("written");
		await persistence.flush();
		persistence.schedule("");
		await persistence.flush();

		expect(store.calls).toEqual(["save:written", "save:"]);
	});

	it("archives the submitted text even when its debounced write has not landed", async () => {
		const store = new RecordingDraftStore();
		const persistence = new ComposerDraftPersistence(store, 1000);

		persistence.schedule("submitted");
		await persistence.discard("submitted");
		await persistence.flush();

		expect(store.calls).toEqual(["discard:submitted"]);
	});

	it("waits for the debounce before handing the draft to the store", async () => {
		vi.useFakeTimers();
		try {
			const store = new RecordingDraftStore();
			const persistence = new ComposerDraftPersistence(store, 175);

			persistence.schedule("deferred");
			vi.advanceTimersByTime(174);
			expect(store.calls).toEqual([]);

			vi.advanceTimersByTime(1);
			await persistence.flush();
			expect(store.calls).toEqual(["save:deferred"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("writes the debounced draft to the session atomically", async () => {
		using tempDir = TempDir.createSync("@pi-draft-debounce-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		const persistence = new ComposerDraftPersistence(
			{
				saveDraft: (text, source) => session.saveDraft(text, source),
				discardDraft: (text, source) => session.discardDraft(text, source),
			},
			30,
		);
		const draftPath = path.join(session.getArtifactsDir() ?? tempDir.path(), "draft.txt");
		vi.useFakeTimers();
		try {
			persistence.schedule("multi\nline\ndraft");
			expect(await Bun.file(draftPath).exists()).toBe(false);
			vi.advanceTimersByTime(30);
			await persistence.flush();
		} finally {
			vi.useRealTimers();
		}
		expect(await Bun.file(draftPath).text()).toBe("multi\nline\ndraft");
	});
});
