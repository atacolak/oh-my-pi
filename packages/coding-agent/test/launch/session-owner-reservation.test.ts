import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { readSessionHeaderId } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	isSessionLeaseHeld,
	SessionReservationBusyError,
	SessionReservationUnavailableError,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "../helpers/rejection";

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

	it("refuses with a typed busy error while another process holds the lease", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);
		const holder = await LeaseHolder.spawn(tempDir, sessionId, sessionPath);
		try {
			expect(await holder.held()).toBe("held");

			expect(() => new FileSessionStorage().reserveSession(sessionId, sessionPath)).toThrow(
				SessionReservationBusyError,
			);
			expect(isSessionLeaseHeld(sessionId)).toBe(true);
		} finally {
			await holder.close();
		}

		const reservation = new FileSessionStorage().reserveSession(sessionId, sessionPath);
		reservation.release();
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	}, 30_000);

	it("refuses when the journal at the path does not identify the session", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);
		const storage = new FileSessionStorage();

		const foreign = path.join(tempDir.path(), "foreign.jsonl");
		fs.writeFileSync(foreign, `${JSON.stringify({ type: "session", id: "another-session" })}\n`);
		expect(() => storage.reserveSession(sessionId, foreign)).toThrow(SessionReservationUnavailableError);
		expect(isSessionLeaseHeld(sessionId)).toBe(false);

		const unreadable = path.join(tempDir.path(), "unreadable.jsonl");
		fs.writeFileSync(unreadable, "not a session journal\n");
		expect(() => storage.reserveSession(sessionId, unreadable)).toThrow(SessionReservationUnavailableError);
		expect(isSessionLeaseHeld(sessionId)).toBe(false);

		// Legacy claim semantics are untouched: a foreign journal is not this session.
		expect(storage.claimSession(sessionId, foreign)).toBeNull();
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
		expect(fs.readFileSync(sessionPath, "utf8")).toContain(sessionId);
	}, 30_000);

	it("refuses to branch a strict owner onto a sibling while another process writes the session", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);
		const before = fs.readFileSync(sessionPath, "utf8");
		const holder = await LeaseHolder.spawn(tempDir, sessionId, sessionPath);
		try {
			expect(await holder.held()).toBe("held");
			const manager = await SessionManager.open(sessionPath, tempDir.path(), new FileSessionStorage(), {
				suppressBreadcrumb: true,
				ownershipPolicy: "require-owner",
			});
			manager.appendMessage(userTurn("strict owner"));
			const failure = await rejectionOf(manager.flush());
			expect((failure as Error).name).toBe("SessionOwnershipConflictError");
			expect((failure as Error).message).toContain(sessionId);
			expect(manager.getSessionFile()).toBe(sessionPath);
			// A strict owner never reports a clean close after losing the journal.
			expect(await rejectionOf(manager.close())).toBe(failure);
		} finally {
			await holder.close();
		}

		expect(jsonlFiles(tempDir.path())).toEqual([sessionPath]);
		expect(fs.readFileSync(sessionPath, "utf8")).toBe(before);
	}, 30_000);
});

function jsonlFiles(dir: string): string[] {
	return fs
		.readdirSync(dir)
		.filter(name => name.endsWith(".jsonl"))
		.map(name => path.join(dir, name))
		.sort();
}

const STORAGE_MODULE = path.join(import.meta.dir, "../../src/session/session-storage.ts");

/** A separate OS process that holds the session lease until this test releases it. */
class LeaseHolder {
	readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #stdout: { read(): Promise<{ done: boolean; value?: Uint8Array }> };
	#buffered = "";

	private constructor(child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
		this.#child = child;
		this.#stdout = child.stdout.getReader();
	}

	static async spawn(tempDir: TempDir, sessionId: string, sessionPath: string): Promise<LeaseHolder> {
		const script = tempDir.join("lease-holder.ts");
		await Bun.write(
			script,
			[
				`import { FileSessionStorage } from ${JSON.stringify(STORAGE_MODULE)};`,
				"const reservation = new FileSessionStorage().reserveSession(process.argv[2], process.argv[3]);",
				'process.stdout.write("held\\n");',
				"for await (const line of console) {",
				'	if (line === "release") {',
				"		reservation.release();",
				'		process.stdout.write("released\\n");',
				"	}",
				'	if (line === "exit") break;',
				"}",
			].join("\n"),
		);
		const child = Bun.spawn([process.execPath, script, sessionId, sessionPath], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		});
		return new LeaseHolder(child);
	}

	async held(): Promise<string> {
		return this.#nextLine();
	}

	async close(): Promise<void> {
		this.#child.stdin.write("exit\n");
		this.#child.stdin.end();
		await this.#child.exited;
	}

	async #nextLine(): Promise<string> {
		let newline = this.#buffered.indexOf("\n");
		while (newline === -1) {
			const { done, value } = await this.#stdout.read();
			if (done) throw new Error(`The lease holder exited early: ${await new Response(this.#child.stderr).text()}`);
			this.#buffered += new TextDecoder().decode(value);
			newline = this.#buffered.indexOf("\n");
		}
		const line = this.#buffered.slice(0, newline);
		this.#buffered = this.#buffered.slice(newline + 1);
		return line;
	}
}
