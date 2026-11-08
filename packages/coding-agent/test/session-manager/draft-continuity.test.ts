import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ComposerDraftPersistence } from "../../src/modes/draft-persistence";
import { TempDir } from "@oh-my-pi/pi-utils";

const DRAFT_HISTORY_FILENAME = "draft-history.jsonl";
const DRAFT_META_FILENAME = "draft.meta.json";
const DRAFT_FILENAME = "draft.txt";

async function fileText(file: string): Promise<string | null> {
	try {
		return await Bun.file(file).text();
	} catch {
		return null;
	}
}

async function fileExists(file: string): Promise<boolean> {
	return (await fileText(file)) !== null;
}

function artifactsDir(session: SessionManager): string {
	const dir = session.getArtifactsDir();
	if (!dir) throw new Error("Expected a persistent artifacts directory");
	return dir;
}

function draftPath(dir: string): string {
	return path.join(dir, DRAFT_FILENAME);
}

function metaPath(dir: string): string {
	return path.join(dir, DRAFT_META_FILENAME);
}

function historyPath(dir: string): string {
	return path.join(dir, DRAFT_HISTORY_FILENAME);
}

async function readHistory(dir: string): Promise<Record<string, unknown>[]> {
	const text = (await fileText(historyPath(dir))) ?? "";
	return text
		.split("\n")
		.filter(line => line.trim().length > 0)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

async function readMeta(dir: string): Promise<Record<string, unknown> | null> {
	const text = await fileText(metaPath(dir));
	return text === null ? null : (JSON.parse(text) as Record<string, unknown>);
}

const ROW_FIELDS = ["rev", "source", "text", "updatedAt"];

/** Simulate the Exocortex `omp-rpc` writer advancing the shared host files. */
async function writeForeignDraft(dir: string, text: string, rev: number, source: "tui" | "rpc" = "rpc"): Promise<void> {
	await Bun.write(draftPath(dir), text);
	await Bun.write(metaPath(dir), JSON.stringify({ rev, updatedAt: new Date().toISOString(), source }));
}

describe("composer draft continuity", () => {
	it("restores the same draft twice without deleting it", async () => {
		using tempDir = TempDir.createSync("@pi-draft-double-restore-");
		const first = SessionManager.create(tempDir.path(), tempDir.path());
		const body = "line one\nline two\nline three";
		await first.saveDraft(body);
		const dir = artifactsDir(first);
		const sessionFile = first.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const metaBefore = await fileText(metaPath(dir));

		const resumed = SessionManager.create(tempDir.path(), tempDir.path());
		await resumed.setSessionFile(sessionFile);

		expect(await resumed.consumeDraft()).toBe(body);
		expect(await fileExists(draftPath(dir))).toBe(true);
		expect(await resumed.consumeDraft()).toBe(body);
		expect(await fileExists(draftPath(dir))).toBe(true);
		expect(await fileText(metaPath(dir))).toBe(metaBefore);
	});

	it("clears draft.txt on submission and archives the submitted text with its source", async () => {
		using tempDir = TempDir.createSync("@pi-draft-submit-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		const submitted = "submitted\nmulti-line\nprompt";
		await session.saveDraft(submitted);
		await session.discardDraft(submitted, "tui");

		const dir = artifactsDir(session);
		expect(await fileExists(draftPath(dir))).toBe(false);
		const rows = await readHistory(dir);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ rev: 1, source: "tui", text: submitted });
		expect(Object.keys(rows[0]).sort()).toEqual(ROW_FIELDS);
		expect(Number.isNaN(Date.parse(String(rows[0].updatedAt)))).toBe(false);
		expect(await readMeta(dir)).toMatchObject({ rev: 2, source: "tui" });

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const resumed = SessionManager.create(tempDir.path(), tempDir.path());
		await resumed.setSessionFile(sessionFile);
		expect(await resumed.consumeDraftEntry()).toBeNull();
	});

	it("does not clear a newer foreign draft when an empty teardown flush loses the CAS", async () => {
		using tempDir = TempDir.createSync("@pi-draft-cas-empty-lose-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		await session.saveDraft("terminal draft");
		const dir = artifactsDir(session);
		await writeForeignDraft(dir, "web draft", 2);

		await session.saveDraft("");

		expect(await fileText(draftPath(dir))).toBe("web draft");
		expect(await readMeta(dir)).toMatchObject({ rev: 2, source: "rpc" });
		expect(await readHistory(dir)).toHaveLength(0);
	});

	it("takes a draft write when the on-disk revision is still the observed one", async () => {
		using tempDir = TempDir.createSync("@pi-draft-cas-win-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());

		await session.saveDraft("first body");
		const dir = artifactsDir(session);
		expect(await fileText(draftPath(dir))).toBe("first body");
		expect(await readMeta(dir)).toMatchObject({ rev: 1, source: "tui" });

		await session.saveDraft("second body");
		expect(await fileText(draftPath(dir))).toBe("second body");
		expect(await readMeta(dir)).toMatchObject({ rev: 2, source: "tui" });
		expect(await readHistory(dir)).toHaveLength(0);
	});

	it("converges without a rewrite when a newer revision already holds the same body", async () => {
		using tempDir = TempDir.createSync("@pi-draft-cas-identical-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		await session.saveDraft("same body");
		const dir = artifactsDir(session);
		await writeForeignDraft(dir, "same body", 2);

		await session.saveDraft("same body");

		expect(await fileText(draftPath(dir))).toBe("same body");
		expect(await readMeta(dir)).toMatchObject({ rev: 2, source: "rpc" });
		expect(await readHistory(dir)).toHaveLength(0);
	});

	it("parks a losing newer body in the ring and leaves the foreign draft in place", async () => {
		using tempDir = TempDir.createSync("@pi-draft-cas-different-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		await session.saveDraft("terminal body");
		const dir = artifactsDir(session);
		await writeForeignDraft(dir, "web body", 2);

		await session.saveDraft("terminal body v2");

		expect(await fileText(draftPath(dir))).toBe("web body");
		expect(await readMeta(dir)).toMatchObject({ rev: 2, source: "rpc" });
		const rows = await readHistory(dir);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ rev: 2, source: "tui", text: "terminal body v2" });
		expect(Object.keys(rows[0]).sort()).toEqual(ROW_FIELDS);
	});

	it("reads a legacy five-entry history and keeps its entries", async () => {
		using tempDir = TempDir.createSync("@pi-draft-legacy-history-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		await session.saveDraft("materialize");
		const dir = artifactsDir(session);
		const legacy = Array.from({ length: 5 }, (_, index) => ({
			text: `legacy ${index}`,
			archivedAt: 1_700_000_000_000 + index,
		}));
		await Bun.write(historyPath(dir), `${legacy.map(entry => JSON.stringify(entry)).join("\n")}\n`);

		await session.saveDraft("live body");
		await session.saveDraft("");

		const rows = await readHistory(dir);
		expect(rows).toHaveLength(6);
		expect(rows.slice(0, 5).map(row => row.text)).toEqual(legacy.map(entry => entry.text));
		for (const row of rows) expect(Object.keys(row).sort()).toEqual(ROW_FIELDS);
		expect(rows[5]).toMatchObject({ rev: 2, source: "tui", text: "live body" });
	});

	it("bounds the recovery ring at ten entries", async () => {
		using tempDir = TempDir.createSync("@pi-draft-ring-bound-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());

		for (let index = 0; index < 12; index++) {
			await session.saveDraft(`draft ${index}`);
			await session.saveDraft("");
		}

		const rows = await readHistory(artifactsDir(session));
		expect(rows).toHaveLength(10);
		expect(rows.map(row => row.text)).toEqual(Array.from({ length: 10 }, (_, index) => `draft ${index + 2}`));
		for (const row of rows) expect(Object.keys(row).sort()).toEqual(ROW_FIELDS);
	});

	it("treats an absent meta file as revision zero", async () => {
		using tempDir = TempDir.createSync("@pi-draft-legacy-no-meta-");
		const first = SessionManager.create(tempDir.path(), tempDir.path());
		await first.saveDraft("legacy body");
		const dir = artifactsDir(first);
		const sessionFile = first.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		await fs.promises.rm(metaPath(dir));

		const resumed = SessionManager.create(tempDir.path(), tempDir.path());
		await resumed.setSessionFile(sessionFile);
		expect(await resumed.consumeDraft()).toBe("legacy body");

		const writer = SessionManager.create(tempDir.path(), tempDir.path());
		await writer.setSessionFile(sessionFile);
		await writer.saveDraft("next body");
		expect(await readMeta(dir)).toMatchObject({ rev: 1, source: "tui" });
	});

	// P0 data loss: the composer was cleared (Escape / Ctrl+C) and teardown then
	// saved an empty draft, which unlinked the only copy. The clear beats the
	// typing debounce here; an empty overwrite must preserve the live sidecar so
	// the next manager can still restore the text.
	it("restores typed text when a clear beats the debounce and teardown saves empty", async () => {
		using tempDir = TempDir.createSync("@pi-draft-continuity-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		const persistence = new ComposerDraftPersistence({
			saveDraft: text => session.saveDraft(text),
			discardDraft: text => session.discardDraft(text),
		});
		const typed = "line one\nline two\nline three";

		persistence.schedule(typed);
		persistence.schedule("");
		await persistence.flush();
		await session.saveDraft("");

		const dir = artifactsDir(session);
		expect(await fileText(draftPath(dir))).toBe(typed);
		const rows = await readHistory(dir);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ source: "tui", text: typed });

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const resumed = SessionManager.create(tempDir.path(), tempDir.path());
		await resumed.setSessionFile(sessionFile);
		expect(await resumed.consumeDraft()).toBe(typed);
	});

	it("does not resurrect a submitted draft on resume", async () => {
		using tempDir = TempDir.createSync("@pi-draft-submit-no-resurrect-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		const persistence = new ComposerDraftPersistence({
			saveDraft: text => session.saveDraft(text),
			discardDraft: text => session.discardDraft(text),
		});
		const submitted = "submitted\nmulti-line\nprompt";

		persistence.schedule(submitted);
		await persistence.flush();
		persistence.schedule("");
		await persistence.discard(submitted);
		await persistence.flush();
		await session.saveDraft("");

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const resumed = SessionManager.create(tempDir.path(), tempDir.path());
		await resumed.setSessionFile(sessionFile);

		expect(await resumed.consumeDraftEntry()).toBeNull();
	});
});
