import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	isSessionLeaseHeld,
	SessionReservationBusyError,
	SessionReservationUnavailableError,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "../helpers/rejection";

interface SavedJournal {
	cwd: string;
	sessionId: string;
	sessionFile: string;
}

/** A saved session whose journal holds only its header, closed and unleased. */
async function createSavedJournal(temp: TempDir): Promise<SavedJournal> {
	const cwd = fs.realpathSync(temp.path());
	const saved = SessionManager.create(cwd, path.join(cwd, "sessions"), new FileSessionStorage());
	await saved.ensureOnDisk();
	const sessionId = saved.getSessionId();
	const sessionFile = saved.getSessionFile();
	if (!sessionFile) throw new Error("Expected a saved journal");
	await saved.close();
	return { cwd, sessionId, sessionFile };
}

describe("SessionManager.withOfflineJournal", () => {
	it("appends a custom record to a saved header-only journal without an owner process", async () => {
		using temp = TempDir.createSync("@omp-offline-journal-");
		const journal = await createSavedJournal(temp);
		expect(await loadEntriesFromFile(journal.sessionFile)).toHaveLength(1);

		const record = { messageId: "message-1", threadId: "message-1", message: "hello" };
		const outcome = await SessionManager.withOfflineJournal(
			journal.sessionId,
			journal.sessionFile,
			async manager => {
				expect(manager.getSessionId()).toBe(journal.sessionId);
				expect(manager.getSessionFile()).toBe(path.resolve(journal.sessionFile));
				expect(manager.hasSessionOwnership()).toBe(true);
				manager.appendCustomEntry("agent_mail", record);
				return "appended";
			},
		);

		expect(outcome).toBe("appended");
		expect(isSessionLeaseHeld(journal.sessionId)).toBe(false);
		const entries = await loadEntriesFromFile(journal.sessionFile);
		expect(entries).toHaveLength(2);
		expect((entries[0] as { id: string }).id).toBe(journal.sessionId);
		expect(entries[1]).toMatchObject({ type: "custom", customType: "agent_mail", data: record });
	});

	it("refuses a journal held by a live owner without touching it", async () => {
		using temp = TempDir.createSync("@omp-offline-journal-live-");
		const journal = await createSavedJournal(temp);
		const owner = await SessionManager.open(journal.sessionFile, path.dirname(journal.sessionFile), undefined, {
			throwIfMissing: true,
		});
		owner.appendCustomEntry("live_owner", { pid: process.pid });
		await owner.flush();
		const before = fs.readFileSync(journal.sessionFile, "utf8");
		let ran = false;
		try {
			expect(isSessionLeaseHeld(journal.sessionId)).toBe(true);
			const error = await rejectionOf(
				SessionManager.withOfflineJournal(journal.sessionId, journal.sessionFile, async () => {
					ran = true;
				}),
			);
			expect(error).toBeInstanceOf(SessionReservationBusyError);
		} finally {
			await owner.close();
		}
		expect(ran).toBe(false);
		expect(fs.readFileSync(journal.sessionFile, "utf8")).toBe(before);
	});

	it("refuses a journal whose header identifies another session", async () => {
		using temp = TempDir.createSync("@omp-offline-journal-wrong-");
		const requested = await createSavedJournal(temp);
		const other = await createSavedJournal(temp);
		const before = fs.readFileSync(other.sessionFile, "utf8");
		let ran = false;

		const error = await rejectionOf(
			SessionManager.withOfflineJournal(requested.sessionId, other.sessionFile, async () => {
				ran = true;
			}),
		);

		expect(error).toBeInstanceOf(SessionReservationUnavailableError);
		expect(ran).toBe(false);
		expect(fs.readFileSync(other.sessionFile, "utf8")).toBe(before);
	});

	it("refuses a missing journal", async () => {
		using temp = TempDir.createSync("@omp-offline-journal-missing-");
		const missing = path.join(temp.path(), "sessions", "absent.jsonl");

		const error = await rejectionOf(
			SessionManager.withOfflineJournal("absent-session", missing, async () => "unreachable"),
		);

		expect(error).toBeInstanceOf(SessionReservationUnavailableError);
		expect(fs.existsSync(missing)).toBe(false);
	});

	it("releases the ownership lease when the operation fails", async () => {
		using temp = TempDir.createSync("@omp-offline-journal-failure-");
		const journal = await createSavedJournal(temp);
		const failure = new Error("offline operation failed");

		const error = await rejectionOf(
			SessionManager.withOfflineJournal(journal.sessionId, journal.sessionFile, async () => {
				throw failure;
			}),
		);

		expect(error).toBe(failure);
		expect(isSessionLeaseHeld(journal.sessionId)).toBe(false);
		await SessionManager.withOfflineJournal(journal.sessionId, journal.sessionFile, async manager => {
			manager.appendCustomEntry("after_failure", { ok: true });
		});
		const entries = await loadEntriesFromFile(journal.sessionFile);
		expect(entries.at(-1)).toMatchObject({ type: "custom", customType: "after_failure" });
	});
});
