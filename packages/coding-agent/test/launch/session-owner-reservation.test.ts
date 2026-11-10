import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
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
import { TERMINAL } from "./session-attach-fixture";
import { sessionAttachEndpoint, type SessionAttachProbe } from "../../src/launch/session-attach";
import * as owner from "../../src/launch/session-owner";

function sequenceProbe(sequence: SessionAttachProbe[]): (sessionId: string) => Promise<SessionAttachProbe> {
	let index = 0;
	return async () => {
		const probe = sequence[Math.min(index, sequence.length - 1)]!;
		index++;
		return probe;
	};
}

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

async function openExactReceiver(tempDir: TempDir, sessionId: string, sessionPath: string): Promise<SessionManager> {
	owner.consumeSessionOwnerContext({
		[owner.SESSION_OWNER_CONTEXT_ENV]: JSON.stringify({
			projectDir: tempDir.path(),
			name: "exact-receiver",
			id: "private-receiver-generation",
			restartTarget: { sessionId, sessionFile: sessionPath },
		}),
	});
	const manager = await createSessionManager(
		parseArgs(["--restore", sessionPath]),
		tempDir.path(),
		Settings.isolated(),
	);
	if (!manager) throw new Error("expected exact receiver");
	return manager;
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

	it.each(["exact", "wrong-id", "copied-path", "missing", "busy"] as const)(
		"keeps an exact restart receiver on its selected journal or refuses (%s)",
		async state => {
			using tempDir = TempDir.createSync("@omp-exact-receiver-");
			const { sessionId, sessionPath } = await createSession(tempDir);
			const before = await Bun.file(sessionPath).text();
			const canonical = await fs.promises.realpath(sessionPath);
			const copied = path.join(tempDir.path(), "copied.jsonl");
			if (state === "copied-path") await Bun.write(copied, before);
			if (state === "missing") await fs.promises.unlink(sessionPath);
			const holder = state === "busy" ? await LeaseHolder.spawn(tempDir, sessionId, sessionPath) : undefined;
			let manager: SessionManager | undefined;
			try {
				if (holder) expect(await holder.held()).toBe("held");
				owner.consumeSessionOwnerContext({
					[owner.SESSION_OWNER_CONTEXT_ENV]: JSON.stringify({
						projectDir: tempDir.path(),
						name: "exact-receiver",
						id: "private-receiver-generation",
						restartTarget: {
							sessionId: state === "wrong-id" ? "another-full-session-id" : sessionId,
							sessionFile: canonical,
						},
					}),
				});
				const open = createSessionManager(
					parseArgs(["--restore", state === "copied-path" ? copied : canonical]),
					tempDir.path(),
					Settings.isolated(),
				);
				if (state !== "exact") {
					const error = await rejectionOf(open.then(value => (manager = value)));
					expect(error).toBeInstanceOf(Error);
					expect(manager).toBeUndefined();
					if (state === "missing") {
						expect(await Bun.file(sessionPath).exists()).toBe(false);
					} else {
						expect(await Bun.file(sessionPath).text()).toBe(before);
					}
					return;
				}
				manager = await open;
				if (!manager) throw new Error("expected exact receiver session");
				expect(manager.getSessionId()).toBe(sessionId);
				expect(manager.getSessionFile()).toBe(canonical);
				expect(manager.hasSessionOwnership()).toBe(true);
				manager.appendMessage(userTurn("continued exact conversation"));
				await manager.flush();
				expect(jsonlFiles(tempDir.path())).toEqual([sessionPath]);
				const after = await Bun.file(sessionPath).text();
				expect(after.startsWith(before)).toBe(true);
				expect(after).toContain("continued exact conversation");
			} finally {
				owner.resetSessionOwnerContextForTest();
				await manager?.close().catch(() => {});
				await holder?.close();
			}
		},
		30_000,
	);

	it.each(["before-first-write", "after-first-write"] as const)(
		"refuses a receiver journal deleted %s instead of recreating it",
		async phase => {
			using tempDir = TempDir.createSync("@omp-receiver-deleted-");
			const { sessionId, sessionPath } = await createSession(tempDir);
			let manager: SessionManager | undefined;
			try {
				manager = await openExactReceiver(tempDir, sessionId, sessionPath);
				if (phase === "after-first-write") {
					manager.appendMessage(userTurn("first receiver turn"));
					await manager.flush();
				}
				await fs.promises.unlink(sessionPath);
				manager.appendMessage(userTurn("must remain pending in memory"));
				expect(await rejectionOf(manager.flush())).toBeInstanceOf(Error);
				expect(manager.getSessionId()).toBe(sessionId);
				expect(manager.getSessionFile()).toBe(sessionPath);
				expect(await Bun.file(sessionPath).exists()).toBe(false);
				manager.appendMessage(userTurn("must not recover into a fresh journal"));
				expect(await rejectionOf(manager.flush())).toBeInstanceOf(Error);
				expect(jsonlFiles(tempDir.path())).toEqual([]);
			} finally {
				owner.resetSessionOwnerContextForTest();
				await manager?.close().catch(() => {});
			}
		},
	);

	it.each(["deleted-before-open", "replaced-after-open"] as const)(
		"refuses a receiver append when its journal is %s at the file-writer boundary",
		async phase => {
			using tempDir = TempDir.createSync("@omp-receiver-writer-fence-");
			const { sessionId, sessionPath } = await createSession(tempDir);
			const replacement = `${JSON.stringify({ type: "session", id: "foreign-journal", version: 3 })}\n`;
			let manager: SessionManager | undefined;
			let stopInterference = () => {};
			try {
				manager = await openExactReceiver(tempDir, sessionId, sessionPath);
				if (phase === "replaced-after-open") {
					manager.appendMessage(userTurn("first receiver turn"));
					await manager.flush();
					await Bun.write(sessionPath, replacement);
				} else {
					const openWriter = FileSessionStorage.prototype.openWriter;
					let removed = false;
					const spy = vi
						.spyOn(FileSessionStorage.prototype, "openWriter")
						.mockImplementation(function (this: FileSessionStorage, file, options) {
							if (file === sessionPath && !removed) {
								removed = true;
								fs.unlinkSync(file);
							}
							return openWriter.call(this, file, options);
						});
					stopInterference = () => spy.mockRestore();
				}
				manager.appendMessage(userTurn("must not reach a missing or foreign journal"));
				expect(await rejectionOf(manager.flush())).toBeInstanceOf(Error);
				expect(manager.getSessionId()).toBe(sessionId);
				expect(manager.getSessionFile()).toBe(sessionPath);
				if (phase === "deleted-before-open") {
					expect(jsonlFiles(tempDir.path())).toEqual([]);
				} else {
					expect(await Bun.file(sessionPath).text()).toBe(replacement);
					expect(jsonlFiles(tempDir.path())).toEqual([sessionPath]);
				}
			} finally {
				stopInterference();
				owner.resetSessionOwnerContextForTest();
				await manager?.close().catch(() => {});
			}
		},
	);

	for (const operation of ["sync", "async"] as const) {
		it.each(["replaced", "equal-size-replaced", "contested"] as const)(
			`refuses ${operation} receiver rewrite recovery on a %s journal instead of forking`,
			async conflict => {
				using tempDir = TempDir.createSync("@omp-receiver-conflict-");
				const { sessionId, sessionPath } = await createSession(tempDir);
				let manager: SessionManager | undefined;
				let stopRace = () => {};
				try {
					manager = await openExactReceiver(tempDir, sessionId, sessionPath);
					manager.appendMessage(userTurn("first receiver turn"));
					await manager.flush();
					const before = await Bun.file(sessionPath).text();
					const replacement =
						conflict === "equal-size-replaced"
							? before.replace(sessionId, Bun.randomUUIDv7())
							: `${JSON.stringify({ type: "session", id: "foreign-journal", version: 3 })}\n`;
					if (conflict === "equal-size-replaced") {
						expect(replacement).not.toBe(before);
						expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(before));
					}
					let interference = 0;
					if (conflict !== "contested") await Bun.write(sessionPath, replacement);
					const race = (file: string) => {
						if (file !== sessionPath || conflict !== "contested") return;
						interference++;
						fs.appendFileSync(
							file,
							`${JSON.stringify({
								type: "message",
								id: `external-${interference}`,
								parentId: null,
								timestamp: new Date().toISOString(),
								message: userTurn(`external writer ${interference}`),
							})}\n`,
						);
					};
					const syncWrite = FileSessionStorage.prototype.writeLinesSync;
					const atomicWrite = FileSessionStorage.prototype.writeLinesAtomic;
					const syncSpy = vi
						.spyOn(FileSessionStorage.prototype, "writeLinesSync")
						.mockImplementation(function (this: FileSessionStorage, file, lines, options) {
							race(file);
							return syncWrite.call(this, file, lines, options);
						});
					let forcedSync = false;
					const receiver = manager;
					const atomicSpy = vi
						.spyOn(FileSessionStorage.prototype, "writeLinesAtomic")
						.mockImplementation(function (this: FileSessionStorage, file, lines, options) {
							if (operation === "sync" && file === sessionPath && !forcedSync) {
								forcedSync = true;
								// A real append during the atomic publish takes the synchronous rewrite path.
								receiver.appendMessage(userTurn("sync append during rewrite"));
								receiver.flushSync();
							}
							race(file);
							return atomicWrite.call(this, file, lines, options);
						});
					stopRace = () => {
						syncSpy.mockRestore();
						atomicSpy.mockRestore();
					};
					const failure = await rejectionOf(manager.rewriteEntries());
					expect(failure).toBeInstanceOf(Error);
					expect(manager.getSessionId()).toBe(sessionId);
					expect(manager.getSessionFile()).toBe(sessionPath);
					expect(jsonlFiles(tempDir.path())).toEqual([sessionPath]);
					const after = await Bun.file(sessionPath).text();
					if (conflict !== "contested") {
						expect(after).toBe(replacement);
					} else {
						expect(interference).toBeGreaterThan(0);
						expect(after.startsWith(before)).toBe(true);
						for (let index = 1; index <= interference; index++) {
							expect(after).toContain(`external writer ${index}`);
						}
					}
				} finally {
					stopRace();
					owner.resetSessionOwnerContextForTest();
					await manager?.close().catch(() => {});
				}
			},
		);
	}

	for (const ownership of ["reserved", "written"] as const) {
		it.each(["new", "fork", "branch"] as const)(
			`permits an explicit %s from a ${ownership} exact receiver without changing the original journal`,
			async transition => {
				using tempDir = TempDir.createSync("@omp-receiver-transition-");
				const { sessionId, sessionPath } = await createSession(tempDir);
				let manager: SessionManager | undefined;
				try {
					manager = await openExactReceiver(tempDir, sessionId, sessionPath);
					if (ownership === "written") {
						manager.appendMessage(userTurn("owner turn before transition"));
						await manager.flush();
					}
					const original = await Bun.file(sessionPath).text();
					const history = manager.buildSessionContext().messages;
					let destination: string | undefined;
					if (transition === "new") destination = await manager.newSession();
					else if (transition === "fork") destination = (await manager.fork())?.newSessionFile;
					else {
						const leafId = manager.getLeafId();
						if (!leafId) throw new Error("expected an original branch leaf");
						destination = manager.createBranchedSession(leafId);
					}
					if (!destination) throw new Error("expected an explicit destination");
					const nextId = manager.getSessionId();
					expect(nextId).not.toBe(sessionId);
					expect(manager.getSessionFile()).toBe(destination);
					expect(isSessionLeaseHeld(sessionId)).toBe(false);
					const turn = userTurn("turn after explicit transition");
					manager.appendMessage(turn);
					await manager.flush();
					expect(await Bun.file(sessionPath).text()).toBe(original);
					expect(jsonlFiles(tempDir.path()).sort()).toEqual([sessionPath, destination].sort());
					const reopened = await SessionManager.open(destination, tempDir.path());
					try {
						expect(reopened.getSessionId()).toBe(nextId);
						expect(reopened.buildSessionContext().messages).toEqual(
							transition === "new" ? [turn] : [...history, turn],
						);
					} finally {
						await reopened.close();
					}
				} finally {
					owner.resetSessionOwnerContextForTest();
					await manager?.close().catch(() => {});
				}
			},
		);
	}

	it("releases a reservation the manager never adopts", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);
		const storage = new FileSessionStorage();
		const reservation = storage.reserveSession(sessionId, sessionPath);
		expect(isSessionLeaseHeld(sessionId)).toBe(true);

		const manager = await SessionManager.open(sessionPath, tempDir.path(), storage, {
			suppressBreadcrumb: true,
			ownershipPolicy: "require-owner",
			ownershipReservation: reservation,
		});
		expect(isSessionLeaseHeld(sessionId)).toBe(true);
		await manager.close();

		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("refuses a cold resume whose lease state cannot be determined", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);

		const outcome = await owner.reserveSessionOwnerTarget(sessionId, sessionPath, {
			probe: async () => ({ status: "absent", sessionId, leaseHeld: null }),
		});

		expect(outcome).toEqual({ kind: "refuse", code: "ownership-unknown" });
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("attaches to a live owner instead of reserving its session", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);

		const outcome = await owner.reserveSessionOwnerTarget(sessionId, sessionPath, {
			probe: async () => ({ status: "live", sessionId, terminal: TERMINAL }),
		});

		expect(outcome).toEqual({ kind: "attach", terminal: TERMINAL });
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("diverts to an owner that published after the reservation", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);

		const outcome = await owner.reserveSessionOwnerTarget(sessionId, sessionPath, {
			probe: sequenceProbe([
				{ status: "absent", sessionId, leaseHeld: false },
				{ status: "live", sessionId, terminal: TERMINAL },
			]),
		});

		expect(outcome).toEqual({ kind: "attach", terminal: TERMINAL });
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("diverts to a refuse for an owner that became unreachable after the reservation", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);

		const outcome = await owner.reserveSessionOwnerTarget(sessionId, sessionPath, {
			probe: sequenceProbe([
				{ status: "absent", sessionId, leaseHeld: false },
				{ status: "unreachable", sessionId, endpoint: sessionAttachEndpoint(sessionId) },
			]),
		});

		expect(outcome).toEqual({ kind: "refuse", code: "owner-unreachable" });
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("diverts to a refuse when ownership becomes unknown after the reservation", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);

		const outcome = await owner.reserveSessionOwnerTarget(sessionId, sessionPath, {
			probe: sequenceProbe([
				{ status: "absent", sessionId, leaseHeld: false },
				{ status: "unknown", sessionId, reason: "publication is unreadable" },
			]),
		});

		expect(outcome).toEqual({ kind: "refuse", code: "ownership-unknown" });
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("diverts to a refuse when the terminal stays unavailable after the reservation", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);

		const outcome = await owner.reserveSessionOwnerTarget(sessionId, sessionPath, {
			probe: sequenceProbe([
				{ status: "absent", sessionId, leaseHeld: false },
				{ status: "live", sessionId },
			]),
		});

		expect(outcome).toEqual({ kind: "refuse", code: "terminal-unavailable" });
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("keeps the reservation when the post-reservation probe sees only itself", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);

		const outcome = await owner.reserveSessionOwnerTarget(sessionId, sessionPath, {
			probe: sequenceProbe([
				{ status: "absent", sessionId, leaseHeld: false },
				{ status: "absent", sessionId, leaseHeld: true },
			]),
		});

		expect(outcome.kind).toBe("reserved");
		if (outcome.kind !== "reserved") throw new Error("expected a reservation");
		expect(isSessionLeaseHeld(sessionId)).toBe(true);
		outcome.reservation.release();
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("elects one writer between two processes racing to resume the same session", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);
		const before = fs.readFileSync(sessionPath, "utf8");
		const runDir = tempDir.join("run");
		fs.mkdirSync(runDir);

		const racers = [
			await RaceWriter.spawn(tempDir, sessionId, sessionPath, runDir),
			await RaceWriter.spawn(tempDir, sessionId, sessionPath, runDir),
		];
		try {
			await Promise.all(racers.map(racer => racer.reserve()));

			const outcomes = [await racers[0].report(), await racers[1].report()];
			const winners = outcomes.filter(outcome => outcome.kind === "reserved");
			const losers = outcomes.filter(outcome => outcome.kind === "refuse");
			expect(winners).toHaveLength(1);
			expect(losers).toHaveLength(1);
			expect(losers[0].code).toBe("owner-busy");
			expect(isSessionLeaseHeld(sessionId)).toBe(true);

			// Keep the winner reserved until the loser's write has reached the fence.
			// Otherwise a valid write after the winner closes depends on scheduling.
			const loserIndex = outcomes.findIndex(outcome => outcome.kind === "refuse");
			await racers[loserIndex].write();
			const loser = await racers[loserIndex].report();
			expect(isSessionLeaseHeld(sessionId)).toBe(true);

			const winnerIndex = outcomes.findIndex(outcome => outcome.kind === "reserved");
			await racers[winnerIndex].write();
			const winner = await racers[winnerIndex].report();
			expect(winner?.writeError).toBeUndefined();
			expect(winner?.savedTo).toBe(sessionPath);
			expect(loser?.writeError).toBe("SessionOwnershipConflictError");
			expect(loser?.savedTo).toBeUndefined();

			expect(jsonlFiles(tempDir.path())).toEqual([sessionPath]);
			const journal = fs.readFileSync(sessionPath, "utf8");
			expect(journal.startsWith(before)).toBe(true);
			expect(journal).toContain(`writer ${winner?.pid}`);
			expect(journal).not.toContain(`writer ${loser?.pid}`);
			expect(isSessionLeaseHeld(sessionId)).toBe(false);
		} finally {
			for (const racer of racers) await racer.close();
		}
	}, 60_000);

	// Residual lease-adoption window, documented rather than closed: a live
	// owner that has opened but not yet claimed holds no lease, and a writer
	// that ignores the reservation is not fenced by it. The strict path refuses
	// (previous test); the legacy path still forks a sibling. Closing this
	// needs the peer to reserve too, which is stage 8's CLI cutover.
	it("documents the residual window: a legacy-policy writer still forks around a held reservation", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);
		const before = fs.readFileSync(sessionPath, "utf8");
		const runDir = tempDir.join("run");
		fs.mkdirSync(runDir);

		const reservation = new FileSessionStorage().reserveSession(sessionId, sessionPath);
		let report: RaceReport;
		const legacy = await RaceWriter.spawn(tempDir, sessionId, sessionPath, runDir, false);
		try {
			await legacy.write();
			report = await legacy.report();
		} finally {
			await legacy.close();
			reservation.release();
		}

		expect(report.writeError).toBeUndefined();
		expect(report.savedTo).toBeDefined();
		expect(report.savedTo).not.toBe(sessionPath);
		expect(fs.readFileSync(sessionPath, "utf8")).toBe(before);
		expect(jsonlFiles(tempDir.path())).toHaveLength(2);
	}, 60_000);
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

const OWNER_MODULE = path.join(import.meta.dir, "../../src/launch/session-owner.ts");
const ATTACH_MODULE = path.join(import.meta.dir, "../../src/launch/session-attach.ts");
const MANAGER_MODULE = path.join(import.meta.dir, "../../src/session/session-manager.ts");

interface RaceReport {
	kind: "reserved" | "refuse";
	code?: string;
	pid: number;
	savedTo?: string;
	writeError?: string;
}

/**
 * One process of a cold-resume race. Reservation and writing are separate
 * barriers so the test can hold the winner's lease across the loser's first
 * write: that is the moment the fence has to hold, not session open.
 */
class RaceWriter {
	readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #stdout: { read(): Promise<{ done: boolean; value?: Uint8Array }> };
	#buffered = "";

	private constructor(child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
		this.#child = child;
		this.#stdout = child.stdout.getReader();
	}

	static async spawn(
		tempDir: TempDir,
		sessionId: string,
		sessionPath: string,
		runDir: string,
		strict = true,
	): Promise<RaceWriter> {
		const script = tempDir.join(`race-writer-${Math.random().toString(16).slice(2)}.ts`);
		await Bun.write(
			script,
			[
				`import * as path from "node:path";`,
				`import { reserveSessionOwnerTarget } from ${JSON.stringify(OWNER_MODULE)};`,
				`import { probeSessionAttach } from ${JSON.stringify(ATTACH_MODULE)};`,
				`import { SessionManager } from ${JSON.stringify(MANAGER_MODULE)};`,
				`import { FileSessionStorage } from ${JSON.stringify(STORAGE_MODULE)};`,
				"const [sessionId, sessionPath, runDir, mode] = process.argv.slice(2);",
				'const strict = mode === "strict";',
				"const report = { kind: 'refuse', code: undefined, pid: process.pid, savedTo: undefined, writeError: undefined };",
				"let reservation;",
				"const emit = () => process.stdout.write(JSON.stringify(report) + String.fromCharCode(10));",
				"for await (const line of console) {",
				'	if (line === "reserve") {',
				"		const outcome = await reserveSessionOwnerTarget(sessionId, sessionPath, {",
				"			probe: id => probeSessionAttach(id, { endpointDir: runDir, timeoutMs: 500 }),",
				"		});",
				"		report.kind = outcome.kind;",
				'		if (outcome.kind === "refuse") report.code = outcome.code;',
				'		if (outcome.kind === "reserved") reservation = outcome.reservation;',
				"		emit();",
				"		continue;",
				"	}",
				'	if (line === "write") {',
				"		const options = { suppressBreadcrumb: true };",
				"		if (strict) {",
				'			options.ownershipPolicy = "require-owner";',
				"			options.ownershipReservation = reservation;",
				"		}",
				"		const manager = await SessionManager.open(sessionPath, path.dirname(sessionPath), new FileSessionStorage(), options);",
				"		try {",
				"			manager.appendMessage({ role: 'user', content: `writer ${process.pid}`, timestamp: Date.now() });",
				"			await manager.flush();",
				"			report.savedTo = manager.getSessionFile();",
				"		} catch (error) {",
				"			report.writeError = error.name;",
				"		}",
				"		try { await manager.close(); } catch {}",
				"		reservation?.release();",
				"		emit();",
				"		continue;",
				"	}",
				"	break;",
				"}",
			].join("\n"),
		);
		const child = Bun.spawn(
			[process.execPath, script, sessionId, sessionPath, runDir, strict ? "strict" : "legacy"],
			{
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: process.env,
			},
		);
		return new RaceWriter(child);
	}

	async reserve(): Promise<void> {
		this.#send("reserve");
	}

	async write(): Promise<void> {
		this.#send("write");
	}

	#send(phase: string): void {
		this.#child.stdin.write(`${phase}\n`);
		this.#child.stdin.flush();
	}

	async report(): Promise<RaceReport> {
		let newline = this.#buffered.indexOf("\n");
		while (newline === -1) {
			const { done, value } = await this.#stdout.read();
			if (done) throw new Error(`The race writer exited early: ${await new Response(this.#child.stderr).text()}`);
			this.#buffered += new TextDecoder().decode(value);
			newline = this.#buffered.indexOf("\n");
		}
		const line = this.#buffered.slice(0, newline);
		this.#buffered = this.#buffered.slice(newline + 1);
		return JSON.parse(line) as RaceReport;
	}

	async close(): Promise<void> {
		this.#child.stdin.end();
		await this.#child.exited;
	}
}
