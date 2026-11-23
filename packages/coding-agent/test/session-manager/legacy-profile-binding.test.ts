import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	SessionReservationBusyError,
	SessionReservationUnavailableError,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "../helpers/rejection";

interface LegacySession {
	cwd: string;
	sessionId: string;
	sessionFile: string;
}

interface SessionSnapshot {
	header: Record<string, unknown>;
	entries: unknown[];
}

function rootAgentOf(header: Record<string, unknown>): unknown {
	return header.rootAgent;
}

async function readSession(sessionFile: string): Promise<SessionSnapshot> {
	const loaded = await loadSessionFile(sessionFile, new FileSessionStorage());
	const header = loaded.entries.find(entry => entry.type === "session");
	if (!header) throw new Error("Expected a session header");
	return {
		header: header as unknown as Record<string, unknown>,
		entries: loaded.entries.filter(entry => entry.type !== "session"),
	};
}

async function createLegacySession(temp: TempDir): Promise<LegacySession> {
	const root = fs.realpathSync(temp.path());
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const cwd = fs.realpathSync(project);
	const session = SessionManager.create(cwd, path.join(root, "sessions"), new FileSessionStorage());
	session.appendMessage({ role: "user", content: "legacy transcript", timestamp: 1 });
	await session.ensureOnDisk();
	await session.flush();
	const sessionId = session.getSessionId();
	const sessionFile = session.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	await session.close();
	return { cwd, sessionId, sessionFile };
}

function bind(sessionPath: string, sessionId: string, cwd: string, profile: string): Promise<boolean> {
	return SessionManager.bindLegacyProfile(sessionPath, sessionId, cwd, profile, new FileSessionStorage());
}

describe("SessionManager legacy profile binding", () => {
	it("binds an unbound exact session without rewriting its history", async () => {
		using temp = TempDir.createSync("@omp-legacy-profile-bind-");
		const { cwd, sessionId, sessionFile } = await createLegacySession(temp);
		const before = await readSession(sessionFile);
		expect(rootAgentOf(before.header)).toBeUndefined();

		expect(await bind(sessionFile, sessionId, cwd, "reviewer")).toBe(true);

		const after = await readSession(sessionFile);
		expect(rootAgentOf(after.header)).toBe("reviewer");
		expect(after.header.id).toBe(sessionId);
		expect(after.header.cwd).toBe(before.header.cwd);
		expect(after.entries).toEqual(before.entries);
	});

	it("treats the same binding as idempotent", async () => {
		using temp = TempDir.createSync("@omp-legacy-profile-idempotent-");
		const { cwd, sessionId, sessionFile } = await createLegacySession(temp);
		expect(await bind(sessionFile, sessionId, cwd, "reviewer")).toBe(true);
		const bytes = fs.readFileSync(sessionFile, "utf8");

		expect(await bind(sessionFile, sessionId, cwd, "reviewer")).toBe(false);

		expect(fs.readFileSync(sessionFile, "utf8")).toBe(bytes);
		expect(rootAgentOf((await readSession(sessionFile)).header)).toBe("reviewer");
	});

	it("refuses a session id the journal does not identify without changing bytes", async () => {
		using temp = TempDir.createSync("@omp-legacy-profile-id-");
		const { cwd, sessionId, sessionFile } = await createLegacySession(temp);
		const bytes = fs.readFileSync(sessionFile, "utf8");

		const failure = await rejectionOf(bind(sessionFile, `${sessionId}-wrong`, cwd, "reviewer"));

		expect(failure).toBeInstanceOf(SessionReservationUnavailableError);
		expect(fs.readFileSync(sessionFile, "utf8")).toBe(bytes);
		expect(rootAgentOf((await readSession(sessionFile)).header)).toBeUndefined();
	});

	it("refuses a canonical cwd the journal was not recorded in without changing bytes", async () => {
		using temp = TempDir.createSync("@omp-legacy-profile-cwd-");
		const { sessionId, sessionFile } = await createLegacySession(temp);
		const other = path.join(fs.realpathSync(temp.path()), "other");
		fs.mkdirSync(other);
		const bytes = fs.readFileSync(sessionFile, "utf8");

		const failure = await rejectionOf(bind(sessionFile, sessionId, fs.realpathSync(other), "reviewer"));

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toMatch(/working directory/i);
		expect(fs.readFileSync(sessionFile, "utf8")).toBe(bytes);
		expect(rootAgentOf((await readSession(sessionFile)).header)).toBeUndefined();
	});

	it("refuses a different profile on an already bound transcript without changing bytes", async () => {
		using temp = TempDir.createSync("@omp-legacy-profile-mismatch-");
		const { cwd, sessionId, sessionFile } = await createLegacySession(temp);
		expect(await bind(sessionFile, sessionId, cwd, "reviewer")).toBe(true);
		const bytes = fs.readFileSync(sessionFile, "utf8");

		const failure = await rejectionOf(bind(sessionFile, sessionId, cwd, "planner"));

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toMatch(/bound to a different/i);
		expect(fs.readFileSync(sessionFile, "utf8")).toBe(bytes);
		expect(rootAgentOf((await readSession(sessionFile)).header)).toBe("reviewer");
	});

	it("refuses while a same-process owner holds the session lease without changing bytes", async () => {
		using temp = TempDir.createSync("@omp-legacy-profile-owner-");
		const { cwd, sessionId, sessionFile } = await createLegacySession(temp);
		const bytes = fs.readFileSync(sessionFile, "utf8");
		const holder = new FileSessionStorage();
		const release = holder.claimSession(sessionId, sessionFile);
		if (typeof release !== "function") throw new Error("Expected the fixture owner to hold the lease");

		try {
			const failure = await rejectionOf(bind(sessionFile, sessionId, cwd, "reviewer"));

			expect(failure).toBeInstanceOf(SessionReservationBusyError);
			expect(fs.readFileSync(sessionFile, "utf8")).toBe(bytes);
			expect(rootAgentOf((await readSession(sessionFile)).header)).toBeUndefined();
		} finally {
			release();
		}
	});

	it("refuses missing or invalid journals without creating one", async () => {
		using temp = TempDir.createSync("@omp-legacy-profile-invalid-");
		const { cwd } = await createLegacySession(temp);
		const missing = path.join(fs.realpathSync(temp.path()), "missing.jsonl");
		const invalid = path.join(fs.realpathSync(temp.path()), "invalid.jsonl");
		fs.writeFileSync(invalid, "not a session journal\n");
		const invalidBytes = fs.readFileSync(invalid, "utf8");

		expect(await rejectionOf(bind(missing, "missing-session", cwd, "reviewer"))).toBeInstanceOf(
			SessionReservationUnavailableError,
		);
		expect(fs.existsSync(missing)).toBe(false);

		expect(await rejectionOf(bind(invalid, "invalid-session", cwd, "reviewer"))).toBeInstanceOf(
			SessionReservationUnavailableError,
		);
		expect(fs.readFileSync(invalid, "utf8")).toBe(invalidBytes);
	});
});
