import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runNamedSessionAttach } from "@oh-my-pi/pi-coding-agent/launch/named-session-attach";
import * as sessionAttachOwner from "@oh-my-pi/pi-coding-agent/launch/session-attach";
import * as attachRunOwner from "@oh-my-pi/pi-coding-agent/launch/session-attach-run";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import {
	assignSessionIdentity,
	createOrOpenSessionIdentity,
	listSessionIdentities,
	resolveSessionIdentity,
	SessionIdentityAmbiguousError,
	SessionIdentityConflictError,
	SessionIdentityNotFoundError,
	SessionIdentityPinConflictError,
} from "@oh-my-pi/pi-coding-agent/session/session-identity";
import {
	closeSessionIndex,
	listSessionIdentityProjection,
	listSessionRecaps,
	lookupSessionTitle,
	recordSessionRecap,
	recordSessionTitle,
	replaceSessionIdentityProjection,
} from "@oh-my-pi/pi-coding-agent/session/session-index";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import * as sessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import {
	SESSION_IDENTITY_CUSTOM_TYPE,
	SessionIdentityMetadataError,
	SessionManager,
} from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	isSessionLeaseHeld,
	SessionReservationBusyError,
	SessionReservationUnavailableError,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	getConfigRootDir,
	getSessionsDir,
	isSqliteBusyError,
	readJsonl,
	setAgentDir,
	withTimeout,
} from "@oh-my-pi/pi-utils";
import { getHistoryDbPath } from "@oh-my-pi/pi-utils/dirs";

describe("native session identity catalog", () => {
	let agentDir: string;
	let cwd: string;
	let sessionsRoot: string;
	let managers: SessionManager[];
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		agentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-identity-"));
		setAgentDir(agentDir);
		closeSessionIndex();
		cwd = path.join(agentDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		sessionsRoot = getSessionsDir();
		managers = [];
	});

	afterEach(async () => {
		for (const manager of managers) {
			try {
				await manager.close();
			} catch {}
		}
		closeSessionIndex();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(agentDir, { recursive: true, force: true });
	});

	async function create(
		handle?: string,
		rootAgent?: string,
	): Promise<{ manager: SessionManager; id: string; file: string }> {
		const opened = await createOrOpenSessionIdentity({ cwd, actorHandle: handle, rootAgent });
		managers.push(opened.manager);
		const file = opened.manager.getSessionFile();
		if (!file) throw new Error("created session has no journal");
		return { manager: opened.manager, id: opened.identity.sessionId, file };
	}

	it("preserves an actor's disabled sleep override through rename and cold reopen, then clears back to inheritance", async () => {
		const created = await create("sleep-owner");
		await assignSessionIdentity(created.manager, { idleSleepSeconds: 0 });
		await assignSessionIdentity(created.manager, { actorHandle: "renamed-sleep-owner" });
		created.manager.appendMessage({ role: "user", content: "Appended conversation text", timestamp: 1 });
		await created.manager.flush();
		await created.manager.close();
		closeSessionIndex();
		expect((await resolveSessionIdentity("renamed-sleep-owner")).idleSleepSeconds).toBe(0);
		const reopened = await createOrOpenSessionIdentity({ cwd, reference: "renamed-sleep-owner" });
		managers.push(reopened.manager);
		expect(reopened.manager.getSessionIdentityMetadata()?.idleSleepSeconds).toBe(0);
		await assignSessionIdentity(reopened.manager, { idleSleepSeconds: null });
		await reopened.manager.close();
		const inherited = await resolveSessionIdentity("renamed-sleep-owner");
		expect(inherited.idleSleepSeconds).toBeNull();
		expect(inherited.sessionId).toBe(created.id);
	});

	it("refuses an invalid actor sleep override without altering its journal or advertising a changed policy", async () => {
		const created = await create("safe-sleep-owner");
		await assignSessionIdentity(created.manager, { idleSleepSeconds: 1800 });
		const before = await Bun.file(created.file).text();
		await expect(assignSessionIdentity(created.manager, { idleSleepSeconds: -1 })).rejects.toBeInstanceOf(
			SessionIdentityMetadataError,
		);
		expect(await Bun.file(created.file).text()).toBe(before);
		expect((await resolveSessionIdentity("safe-sleep-owner")).idleSleepSeconds).toBe(1800);
	});

	async function createSdkOwner(manager: SessionManager) {
		registerMockApi();
		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("mock", "test-key");
		try {
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				sessionManager: manager,
				authStorage: auth,
				modelRegistry: new ModelRegistry(auth, path.join(agentDir, "models.yml")),
				model: createMockModel({ handler: () => ({ content: ["unused"] }) }),
				settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				skills: [],
				rules: [],
				contextFiles: [],
			});
			return { session, auth };
		} catch (error) {
			auth.close();
			throw error;
		}
	}

	it("slash actor naming and renaming change the durable address without changing profile, conversation or automatic titles", async () => {
		const created = await create(undefined, "lead");
		const { session, auth } = await createSdkOwner(created.manager);
		const output: string[] = [];
		const runtime: SlashCommandRuntime = {
			session,
			sessionManager: created.manager,
			settings: session.settings,
			cwd,
			output: text => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};
		const prompt = session.systemPrompt;
		try {
			await executeAcpBuiltinSlashCommand("/name actor atlas", runtime);
			expect((await resolveSessionIdentity("atlas")).sessionId).toBe(created.id);
			await created.manager.setSessionName("Working on the first task", "auto");
			await executeAcpBuiltinSlashCommand("/name actor orbit", runtime);
			expect((await resolveSessionIdentity("orbit")).sessionId).toBe(created.id);
			await expect(resolveSessionIdentity("atlas")).rejects.toBeInstanceOf(SessionIdentityNotFoundError);
			expect(created.manager.getHeader()?.rootAgent).toBe("lead");
			expect(session.systemPrompt).toEqual(prompt);
			await created.manager.setSessionName("Working on the next task", "auto");
			expect(created.manager.getSessionName()).toBe("Working on the next task");
			await executeAcpBuiltinSlashCommand("/name actor", runtime);
			expect(output.at(-1)).toContain("orbit");
			expect(
				(await loadEntriesFromFile(created.file)).some(
					entry =>
						entry.type === "custom" &&
						entry.customType === SESSION_IDENTITY_CUSTOM_TYPE &&
						(entry.data as { actorHandle?: string }).actorHandle === "orbit",
				),
			).toBe(true);
		} finally {
			await session.dispose();
			auth.close();
		}
	});

	it("slash actor rename refuses another conversation's name and keeps both existing bindings", async () => {
		const first = await create("first");
		const second = await create("taken");
		const { session, auth } = await createSdkOwner(first.manager);
		const runtime: SlashCommandRuntime = {
			session,
			sessionManager: first.manager,
			settings: session.settings,
			cwd,
			output: () => {},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};
		try {
			await expect(executeAcpBuiltinSlashCommand("/name actor taken", runtime)).rejects.toBeInstanceOf(
				SessionIdentityConflictError,
			);
			expect((await resolveSessionIdentity("first")).sessionId).toBe(first.id);
			expect((await resolveSessionIdentity("taken")).sessionId).toBe(second.id);
		} finally {
			await session.dispose();
			auth.close();
		}
	});

	it("renames after a same-session reload without requiring a model turn or journal write first", async () => {
		const created = await create("before-reload");
		const { session, auth } = await createSdkOwner(created.manager);
		const runtime: SlashCommandRuntime = {
			session,
			sessionManager: created.manager,
			settings: session.settings,
			cwd,
			output: () => {},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};
		try {
			expect(await session.switchSession(created.file)).toBe(true);
			await executeAcpBuiltinSlashCommand("/name actor after-reload", runtime);
			expect((await resolveSessionIdentity("after-reload")).sessionId).toBe(created.id);
			await expect(resolveSessionIdentity("before-reload")).rejects.toBeInstanceOf(SessionIdentityNotFoundError);
		} finally {
			await session.dispose();
			auth.close();
		}
	});

	it.each(["default", "custom"])(
		"names a fresh %s-directory conversation and refuses a collision in that same catalog",
		async layout => {
			const customRoot = layout === "default" ? sessionsRoot : path.join(agentDir, "slash-custom-sessions");
			const sessionDir = layout === "default" ? undefined : customRoot;
			const manager = SessionManager.create(cwd, sessionDir);
			expect(manager.isSessionOnDisk()).toBe(false);
			managers.push(manager);
			const { session, auth } = await createSdkOwner(manager);
			const runtime: SlashCommandRuntime = {
				session,
				sessionManager: manager,
				settings: session.settings,
				cwd,
				output: () => {},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			};
			try {
				const id = manager.getSessionId();
				await executeAcpBuiltinSlashCommand("/name actor custom-atlas", runtime);
				expect((await resolveSessionIdentity("custom-atlas", { sessionsRoot: customRoot })).sessionId).toBe(id);
				const other = SessionManager.create(cwd, sessionDir);
				managers.push(other);
				await other.ensureOnDisk();
				await assignSessionIdentity(other, { actorHandle: "custom-taken" }, { sessionsRoot: customRoot });
				await expect(executeAcpBuiltinSlashCommand("/name actor custom-taken", runtime)).rejects.toBeInstanceOf(
					SessionIdentityConflictError,
				);
				expect((await resolveSessionIdentity("custom-atlas", { sessionsRoot: customRoot })).sessionId).toBe(id);
				expect((await resolveSessionIdentity("custom-taken", { sessionsRoot: customRoot })).sessionId).toBe(
					other.getSessionId(),
				);
			} finally {
				await session.dispose();
				auth.close();
			}
		},
	);

	function identityEntryCount(entries: readonly { type: string }[]): number {
		return entries.filter(
			entry =>
				entry.type === "custom" && (entry as { customType?: string }).customType === SESSION_IDENTITY_CUSTOM_TYPE,
		).length;
	}

	it("persists a handle in the journal and resolves it across reopen", async () => {
		const created = await createOrOpenSessionIdentity({
			cwd,
			actorHandle: "firstmate",
			assignments: [{ kind: "project", target: "oh-my-pi" }],
		});
		managers.push(created.manager);
		expect(created.created).toBe(true);
		const id = created.identity.sessionId;
		await created.manager.close();

		const resolved = await resolveSessionIdentity("firstmate");
		expect(resolved.sessionId).toBe(id);
		expect(resolved.sessionFile).toBe(fs.realpathSync(created.identity.sessionFile));
		expect(resolved.cwd).toBe(path.resolve(cwd));
		expect(resolved.assignments).toEqual([{ kind: "project", target: "oh-my-pi" }]);

		const reopened = await createOrOpenSessionIdentity({ cwd, actorHandle: "firstmate" });
		managers.push(reopened.manager);
		expect(reopened.created).toBe(false);
		expect(reopened.identity.sessionId).toBe(id);
		expect(reopened.identity.actorHandle).toBe("firstmate");
		expect(reopened.manager.getSessionFile()).toBe(resolved.sessionFile);
		expect(reopened.manager.getEntries().some(entry => entry.type === "message")).toBe(false);
	});

	it("rebuilds a deleted projection and repairs an interrupted advertisement", async () => {
		const created = await create();
		const rows = () => listSessionIdentityProjection(sessionsRoot);
		expect(rows().map(row => row.sessionId)).toEqual([created.id]);

		replaceSessionIdentityProjection(sessionsRoot, []);
		expect(rows()).toHaveLength(0);
		await listSessionIdentities();
		expect(rows().map(row => row.sessionId)).toEqual([created.id]);

		replaceSessionIdentityProjection(sessionsRoot, [
			{
				sessionsRoot,
				sessionId: "stale-interrupted-session",
				sessionFile: path.join(sessionsRoot, "stale.jsonl"),
				cwd,
				rootAgent: null,
				generation: null,
				actorHandle: "pilot",
				assignments: [],
				entryId: "stale",
			},
		]);
		await listSessionIdentities();
		expect(rows().map(row => row.sessionId)).toEqual([created.id]);

		const second = await create();
		await assignSessionIdentity(second.manager, { actorHandle: "pilot" });
		const repaired = rows();
		expect(repaired).toHaveLength(2);
		expect(repaired.find(row => row.sessionId === "stale-interrupted-session")).toBeUndefined();
		expect(repaired.find(row => row.actorHandle === "pilot")?.sessionId).toBe(second.id);
		expect(await resolveSessionIdentity("pilot")).toMatchObject({ sessionId: second.id });
	});

	it("resolves unchanged journals after reopening the persistent index without rereading their contents", async () => {
		const created = await create("indexed-owner");
		closeSessionIndex();
		const read = spyOn(sessionLoader, "visitEntriesFromFileStream");
		try {
			expect((await resolveSessionIdentity("indexed-owner")).sessionId).toBe(created.id);
			expect((await listSessionIdentities()).map(record => record.sessionId)).toEqual([created.id]);
			expect(read).not.toHaveBeenCalled();
		} finally {
			read.mockRestore();
		}
	});

	it("rereads only a changed journal and retires its old cached name", async () => {
		const first = await create("unchanged");
		const changed = await create("before");
		const validatedBytes = (await fsp.stat(changed.file)).size;
		const read = spyOn(sessionLoader, "visitEntriesFromFileStream");
		try {
			changed.manager.appendSessionIdentityMetadata({ version: 1, actorHandle: "after", assignments: [] });
			await changed.manager.flush();
			expect((await resolveSessionIdentity("after")).sessionId).toBe(changed.id);
			await expect(resolveSessionIdentity("before")).rejects.toBeInstanceOf(SessionIdentityNotFoundError);
			expect((await resolveSessionIdentity("unchanged")).sessionId).toBe(first.id);
			expect(read.mock.calls.map(call => call[0])).toEqual([changed.file]);
			expect(read.mock.calls[0]?.[2]?.skipBytes).toBe(validatedBytes);
		} finally {
			read.mockRestore();
		}
	});

	it("does not let a damaged cached row override an unchanged journal's durable name", async () => {
		const created = await create("durable-name");
		const rows = listSessionIdentityProjection(sessionsRoot);
		replaceSessionIdentityProjection(
			sessionsRoot,
			rows.map(row => ({ ...row, actorHandle: "not-in-journal" })),
		);
		await expect(resolveSessionIdentity("not-in-journal")).rejects.toBeInstanceOf(SessionIdentityNotFoundError);
		expect((await resolveSessionIdentity("durable-name")).sessionId).toBe(created.id);
	});

	it("revalidates rewritten prefix bytes even when the journal also grows", async () => {
		const created = await create("before");
		await created.manager.close();
		const source = await Bun.file(created.file).text();
		const rewritten = source.replace('"actorHandle":"before"', '"actorHandle":"afterx"') + "\n";
		expect(rewritten.length).toBeGreaterThan(source.length);
		await Bun.write(created.file, rewritten);
		expect((await resolveSessionIdentity("afterx")).sessionId).toBe(created.id);
		await expect(resolveSessionIdentity("before")).rejects.toBeInstanceOf(SessionIdentityNotFoundError);
	});

	it.each(["replacement", "same-size rewrite with restored mtime"])(
		"invalidates the cached name after a journal %s",
		async change => {
			const created = await create("before");
			await created.manager.close();
			const timestamp = 1_000_000_000;
			await fsp.utimes(created.file, timestamp, timestamp);
			await resolveSessionIdentity("before");
			const before = await fsp.stat(created.file, { bigint: true });
			const source = await Bun.file(created.file).text();
			const changed = source.replace('"actorHandle":"before"', '"actorHandle":"afterx"');
			expect(changed).not.toBe(source);
			if (change === "replacement") {
				const replacement = `${created.file}.replacement`;
				await Bun.write(replacement, changed);
				await fsp.rename(replacement, created.file);
			} else {
				await Bun.write(created.file, changed);
			}
			await fsp.utimes(created.file, timestamp, timestamp);
			const after = await fsp.stat(created.file, { bigint: true });
			expect(after.size).toBe(before.size);
			expect(after.mtimeNs).toBe(before.mtimeNs);
			expect((await resolveSessionIdentity("afterx")).sessionId).toBe(created.id);
			await expect(resolveSessionIdentity("before")).rejects.toBeInstanceOf(SessionIdentityNotFoundError);
		},
	);

	it("does not retain a cached claim after its journal is deleted", async () => {
		const created = await create("removed-owner");
		await created.manager.close();
		await fsp.unlink(created.file);
		await expect(resolveSessionIdentity("removed-owner")).rejects.toBeInstanceOf(SessionIdentityNotFoundError);
		expect(listSessionIdentityProjection(sessionsRoot)).toEqual([]);
		const replacement = await create("removed-owner");
		expect(replacement.id).not.toBe(created.id);
		expect((await resolveSessionIdentity("removed-owner")).sessionId).toBe(replacement.id);
	});

	it("does not cache a mixed snapshot when the journal changes during its read", async () => {
		const created = await create("before-race");
		created.manager.appendMessage({ role: "user", content: "Invalidate the previous stat", timestamp: 1 });
		await created.manager.flush();
		const originalRead = sessionLoader.visitEntriesFromFileStream;
		let appended = false;
		const read = spyOn(sessionLoader, "visitEntriesFromFileStream").mockImplementation(async (...args) => {
			const result = await originalRead(...args);
			if (!appended && args[0] === created.file) {
				appended = true;
				created.manager.appendSessionIdentityMetadata({
					version: 1,
					actorHandle: "after-race",
					assignments: [],
				});
				await created.manager.flush();
			}
			return result;
		});
		try {
			await resolveSessionIdentity("before-race");
			expect((await resolveSessionIdentity("after-race")).sessionId).toBe(created.id);
			expect((await resolveSessionIdentity("after-race")).sessionId).toBe(created.id);
			expect(read).toHaveBeenCalledTimes(2);
		} finally {
			read.mockRestore();
		}
	});

	it("refuses a handle already claimed by another session", async () => {
		const first = await create("shared");
		const second = await create();
		await expect(assignSessionIdentity(second.manager, { actorHandle: "shared" })).rejects.toBeInstanceOf(
			SessionIdentityConflictError,
		);
		expect((await resolveSessionIdentity("shared")).sessionId).toBe(first.id);

		await assignSessionIdentity(first.manager, { actorHandle: "renamed" });
		await assignSessionIdentity(second.manager, { actorHandle: "shared" });
		expect((await resolveSessionIdentity("shared")).sessionId).toBe(second.id);
	});

	it("lets exactly one of two concurrent claims win", async () => {
		const a = await create();
		const b = await create();
		const results = await Promise.allSettled([
			assignSessionIdentity(a.manager, { actorHandle: "race" }),
			assignSessionIdentity(b.manager, { actorHandle: "race" }),
		]);
		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
		expect(rejected?.reason).toBeInstanceOf(SessionIdentityConflictError);

		const catalog = await listSessionIdentities();
		expect(catalog.filter(record => record.actorHandle === "race")).toHaveLength(1);
	});

	it("explains ambiguous prefixes with bounded candidates and resolves unique ones", async () => {
		const ids: string[] = [];
		for (let index = 0; index < 17; index++) ids.push((await create()).id);

		const groups = new Map<string, string[]>();
		for (const id of ids) {
			const bucket = id.slice(0, 1);
			groups.set(bucket, [...(groups.get(bucket) ?? []), id]);
		}
		const ambiguous = [...groups.values()].find(group => group.length > 1);
		if (!ambiguous) throw new Error("expected two session ids to share a prefix character");
		const prefix = ambiguous[0]!.slice(0, 1);
		await expect(resolveSessionIdentity(prefix)).rejects.toBeInstanceOf(SessionIdentityAmbiguousError);
		try {
			await resolveSessionIdentity(prefix, { candidateLimit: 4 });
			throw new Error("expected an ambiguity error");
		} catch (error) {
			expect(error).toBeInstanceOf(SessionIdentityAmbiguousError);
			expect((error as SessionIdentityAmbiguousError).candidates.length).toBeLessThanOrEqual(4);
			expect((error as SessionIdentityAmbiguousError).candidates.length).toBeGreaterThan(1);
		}
		const target = ids[0]!;
		expect((await resolveSessionIdentity(target)).sessionId).toBe(target);
		for (let length = 1; length <= target.length; length++) {
			const candidate = target.slice(0, length);
			if (ids.filter(id => id.startsWith(candidate)).length !== 1) continue;
			expect((await resolveSessionIdentity(candidate)).sessionId).toBe(target);
			break;
		}
	});

	it("answers cold reads from journals without taking a lease or writing", async () => {
		const created = await create("cold-read");
		await created.manager.close();
		const before = await fsp.readFile(created.file, "utf8");

		const resolved = await resolveSessionIdentity(created.id);
		expect(resolved.sessionId).toBe(created.id);
		expect(isSessionLeaseHeld(created.id)).toBe(false);
		expect(await fsp.readFile(created.file, "utf8")).toBe(before);

		const entries = await loadEntriesFromFile(created.file);
		expect(entries.filter(entry => entry.type === "message")).toHaveLength(0);
		expect(identityEntryCount(entries)).toBe(1);
	});

	it("renames in place, keeping the session id and journal path", async () => {
		const created = await create("before-rename");
		const before = fs.realpathSync(created.file);
		const record = await assignSessionIdentity(created.manager, {
			actorHandle: "after-rename",
			assignments: [{ kind: "service", target: "exocortex" }],
			generation: "gen-2",
		});
		expect(record.sessionId).toBe(created.id);
		expect(record.sessionFile).toBe(fs.realpathSync(created.file));
		expect(record.actorHandle).toBe("after-rename");
		expect(record.generation).toBe("gen-2");
		expect(record.assignments).toEqual([{ kind: "service", target: "exocortex" }]);
		expect(fs.realpathSync(created.file)).toBe(before);

		await expect(resolveSessionIdentity("before-rename")).rejects.toBeInstanceOf(SessionIdentityNotFoundError);
		expect((await resolveSessionIdentity(created.id)).actorHandle).toBe("after-rename");
		expect((await resolveSessionIdentity("after-rename")).sessionId).toBe(created.id);
	});

	it("strips exclusive identity entries from forks", async () => {
		const created = await create("fork-parent", "first");
		await assignSessionIdentity(created.manager, {
			assignments: [{ kind: "project", target: "oh-my-pi" }],
		});
		const forkDir = path.join(sessionsRoot, "forks");
		fs.mkdirSync(forkDir, { recursive: true });

		const forked = await SessionManager.forkFrom(created.file, cwd, forkDir);
		managers.push(forked);
		const forkedFile = forked.getSessionFile();
		if (!forkedFile) throw new Error("fork has no journal");
		expect(identityEntryCount(forked.getEntries())).toBe(0);
		expect(identityEntryCount(await loadEntriesFromFile(forkedFile))).toBe(0);
		expect(forked.getSessionIdentityMetadata()).toBeUndefined();
		const catalog = await listSessionIdentities();
		expect(catalog.find(record => record.sessionId === forked.getSessionId())?.actorHandle).toBeNull();
		expect((await resolveSessionIdentity("fork-parent")).sessionId).toBe(created.id);

		const leaf = created.manager.getEntries().at(-1);
		if (!leaf) throw new Error("parent session has no entries");
		const branched = created.manager.createBranchedSession(leaf.id);
		if (!branched) throw new Error("expected a persisted branched session");
		expect(identityEntryCount(await loadEntriesFromFile(branched))).toBe(0);

		const live = await created.manager.fork();
		if (!live) throw new Error("expected a persisted fork");
		expect(identityEntryCount(await loadEntriesFromFile(live.newSessionFile))).toBe(0);

		const copy = await created.manager.persistCopy({ sessionDir: forkDir });
		managers.push(copy);
		const copyFile = copy.getSessionFile();
		if (!copyFile) throw new Error("persisted copy has no journal");
		expect(identityEntryCount(await loadEntriesFromFile(copyFile))).toBe(0);
	});

	it("creates without an inference turn", async () => {
		const created = await createOrOpenSessionIdentity({ cwd, actorHandle: "no-inference" });
		managers.push(created.manager);
		const entries = created.manager.getEntries();
		expect(entries).toHaveLength(1);
		expect(identityEntryCount(entries)).toBe(1);
		expect(await loadEntriesFromFile(created.identity.sessionFile)).toHaveLength(2);
	});

	it("refuses pin conflicts and never creates from a missing reference", async () => {
		const pinned = await create("pinned-actor", "first");
		await pinned.manager.close();
		await expect(
			createOrOpenSessionIdentity({ cwd, reference: pinned.id, rootAgent: "second" }),
		).rejects.toBeInstanceOf(SessionIdentityPinConflictError);

		const generated = await createOrOpenSessionIdentity({ cwd, generation: "gen-1" });
		managers.push(generated.manager);
		await generated.manager.close();
		await expect(
			createOrOpenSessionIdentity({ cwd, reference: generated.identity.sessionId, generation: "gen-2" }),
		).rejects.toBeInstanceOf(SessionIdentityPinConflictError);

		const otherCwd = path.join(agentDir, "other-project");
		fs.mkdirSync(otherCwd, { recursive: true });
		await expect(createOrOpenSessionIdentity({ cwd: otherCwd, reference: pinned.id })).rejects.toBeInstanceOf(
			SessionIdentityPinConflictError,
		);

		const before = (await listSessionIdentities()).length;
		await expect(createOrOpenSessionIdentity({ cwd, reference: "00000000-dead-beef" })).rejects.toBeInstanceOf(
			SessionIdentityNotFoundError,
		);
		expect((await listSessionIdentities()).length).toBe(before);
	});

	it("refuses a cold open while another live owner holds the lease", async () => {
		const live = await create("live-owner");
		await expect(createOrOpenSessionIdentity({ cwd, reference: live.id })).rejects.toBeInstanceOf(
			SessionReservationBusyError,
		);
		expect(isSessionLeaseHeld(live.id)).toBe(true);
		expect(live.manager.hasSessionOwnership()).toBe(true);
	});

	it("discovers named and unnamed sessions and collapses aliases", async () => {
		const named = await create("named-actor");
		const unnamed = await create();
		const bucket = path.dirname(named.file);
		await fsp.symlink(named.file, path.join(bucket, "alias.jsonl"));
		fs.symlinkSync(bucket, path.join(sessionsRoot, "aliased-bucket"));

		const catalog = await listSessionIdentities();
		expect(catalog.map(record => record.sessionId).sort()).toEqual([named.id, unnamed.id].sort());
		expect(catalog.find(record => record.sessionId === named.id)?.actorHandle).toBe("named-actor");
		expect(catalog.find(record => record.sessionId === unnamed.id)?.actorHandle).toBeNull();
	});

	it("refuses a copied journal that would take over an identity", async () => {
		const created = await create("copied-actor");
		const copyBucket = path.join(sessionsRoot, "copied-bucket");
		fs.mkdirSync(copyBucket, { recursive: true });
		await fsp.copyFile(created.file, path.join(copyBucket, "copy.jsonl"));

		await expect(listSessionIdentities()).rejects.toBeInstanceOf(SessionIdentityConflictError);
	});

	it("refuses a rewritten copy that keeps the handle under a new session id", async () => {
		const created = await create("cloned-actor");
		const lines = (await fsp.readFile(created.file, "utf8")).split("\n");
		const headerIndex = lines.findIndex(line => line && JSON.parse(line).type === "session");
		if (headerIndex < 0) throw new Error("missing source session header");
		const header = JSON.parse(lines[headerIndex]) as { id: string };
		header.id = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
		lines[headerIndex] = JSON.stringify(header);
		const copyBucket = path.join(sessionsRoot, "rewritten-bucket");
		fs.mkdirSync(copyBucket, { recursive: true });
		await fsp.writeFile(path.join(copyBucket, "rewritten.jsonl"), lines.join("\n"));

		try {
			await listSessionIdentities();
			throw new Error("expected the catalog to refuse the cloned handle");
		} catch (error) {
			expect(error).toBeInstanceOf(SessionIdentityConflictError);
			expect((error as SessionIdentityConflictError).actorHandle).toBe("cloned-actor");
		}
	});
	it("refuses names that also identify a different session UUID", async () => {
		const first = await create();
		const second = await create(first.id);
		await expect(resolveSessionIdentity(first.id)).rejects.toBeInstanceOf(SessionIdentityAmbiguousError);
		expect((await resolveSessionIdentity(second.id)).sessionId).toBe(second.id);
	});

	it("does not drop a malformed journal claim and let a new session take its handle", async () => {
		const claimed = await create("damaged-owner");
		await claimed.manager.close();
		await fsp.appendFile(claimed.file, "{broken-record\n");
		await expect(listSessionIdentities()).rejects.toBeInstanceOf(SessionIdentityMetadataError);
		await expect(createOrOpenSessionIdentity({ cwd, actorHandle: "damaged-owner" })).rejects.toBeInstanceOf(
			SessionIdentityMetadataError,
		);
		expect(
			listSessionIdentityProjection(sessionsRoot)
				.filter(row => row.actorHandle === "damaged-owner")
				.map(row => row.sessionId),
		).toEqual([claimed.id]);
	});

	it("lists and renames conversations when a session artifact directory contains draft history", async () => {
		const created = await create("before-artifact");
		const artifact = path.join(sessionsRoot, "ordinary-session-artifacts", "draft-history.jsonl");
		const draft = `${JSON.stringify({ rev: 1, source: "editor", text: "unsent draft" })}\n`;
		await Bun.write(artifact, draft);
		expect((await listSessionIdentities()).map(record => record.sessionId)).toEqual([created.id]);
		await assignSessionIdentity(created.manager, { actorHandle: "after-artifact" });
		expect((await resolveSessionIdentity("after-artifact")).sessionId).toBe(created.id);
		await expect(resolveSessionIdentity("before-artifact")).rejects.toBeInstanceOf(SessionIdentityNotFoundError);
		expect(await Bun.file(artifact).text()).toBe(draft);
	});

	it("does not free a durable handle when the leading session record type is damaged", async () => {
		const created = await create("damaged-header-type");
		await created.manager.close();
		const lines = (await Bun.file(created.file).text()).split("\n");
		const index = lines.findIndex(line => line && JSON.parse(line).type === "session");
		if (index < 0) throw new Error("missing fixture session header");
		const header = JSON.parse(lines[index]) as { type: string };
		header.type = "broken-session";
		lines[index] = JSON.stringify(header);
		const damaged = lines.join("\n");
		await Bun.write(created.file, damaged);
		await expect(listSessionIdentities()).rejects.toBeInstanceOf(SessionIdentityMetadataError);
		await expect(createOrOpenSessionIdentity({ cwd, actorHandle: "damaged-header-type" })).rejects.toBeInstanceOf(
			SessionIdentityMetadataError,
		);
		expect(await Bun.file(created.file).text()).toBe(damaged);
	});

	it("rejects released managers even when the requested metadata is unchanged", async () => {
		const created = await create("closed-owner");
		await created.manager.close();
		const before = await Bun.file(created.file).text();
		await expect(assignSessionIdentity(created.manager, { actorHandle: "closed-owner" })).rejects.toBeInstanceOf(
			SessionReservationUnavailableError,
		);
		expect(await Bun.file(created.file).text()).toBe(before);
	});

	it("refuses mutation through a catalog that does not contain the journal", async () => {
		const created = await create("scoped-owner");
		const before = await Bun.file(created.file).text();
		await expect(
			assignSessionIdentity(
				created.manager,
				{ actorHandle: "escaped-owner" },
				{
					sessionsRoot: path.join(agentDir, "other-catalog"),
				},
			),
		).rejects.toBeInstanceOf(SessionIdentityConflictError);
		expect(await Bun.file(created.file).text()).toBe(before);
		expect((await resolveSessionIdentity("scoped-owner")).sessionId).toBe(created.id);
	});

	it("addresses journals stored directly in a custom session directory", async () => {
		const customRoot = path.join(agentDir, "flat-sessions");
		const manager = SessionManager.create(cwd, customRoot);
		managers.push(manager);
		await manager.ensureOnDisk();
		const identity = await assignSessionIdentity(
			manager,
			{ actorHandle: "custom-owner" },
			{ sessionsRoot: customRoot },
		);
		const resolved = await resolveSessionIdentity("custom-owner", { sessionsRoot: customRoot });
		expect(resolved.sessionId).toBe(identity.sessionId);
		const canonical = manager.getCanonicalSessionFile();
		if (!canonical) throw new Error("custom session lost its canonical journal");
		expect(resolved.sessionFile).toBe(canonical);
	});

	it("protects identity assigned after SDK startup and releases protection when the identity is cleared", async () => {
		const created = await create();
		const { session, auth } = await createSdkOwner(created.manager);
		try {
			await assignSessionIdentity(created.manager, { actorHandle: "sdk-owner" });
			await expect(session.newSession()).rejects.toThrow("pins this transcript");
			expect(session.sessionId).toBe(created.id);
			expect(session.sessionFile).toBe(created.file);
			await assignSessionIdentity(created.manager, { actorHandle: null });
			expect(await session.newSession()).toBe(true);
			expect(session.sessionId).not.toBe(created.id);
		} finally {
			await session.dispose();
			auth.close();
		}
	});

	it("real CLI resolves a cold native handle but refuses an unsupported generation without changing the journal", async () => {
		const created = await create("cli-pinned", "fixture");
		await assignSessionIdentity(created.manager, { generation: "a".repeat(40) });
		await created.manager.close();
		const before = await Bun.file(created.file).text();
		const child = Bun.spawn(
			[process.execPath, path.resolve(import.meta.dir, "../src/cli.ts"), "--attach", "cli-pinned"],
			{
				cwd,
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, OMP_RUN_DIR: path.join(agentDir, "run") },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 10_000,
			},
		);
		const [code, , error] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(code).toBe(2);
		expect(error).toMatch(/generation/i);
		expect(await Bun.file(created.file).text()).toBe(before);
		expect(isSessionLeaseHeld(created.id)).toBe(false);
	}, 15_000);

	it("refuses an invalid header without freeing its journaled handle for another session", async () => {
		const claimed = await create("invalid-header");
		await claimed.manager.close();
		const lines = (await Bun.file(claimed.file).text()).split("\n");
		const headerIndex = lines.findIndex(line => line && JSON.parse(line).type === "session");
		if (headerIndex < 0) throw new Error("missing fixture header");
		const header = JSON.parse(lines[headerIndex]) as { id: string };
		header.id = "";
		lines[headerIndex] = JSON.stringify(header);
		await Bun.write(claimed.file, lines.join("\n"));
		await expect(createOrOpenSessionIdentity({ cwd, actorHandle: "invalid-header" })).rejects.toBeInstanceOf(
			SessionIdentityMetadataError,
		);
		expect(
			listSessionIdentityProjection(sessionsRoot)
				.filter(row => row.actorHandle === "invalid-header")
				.map(row => row.sessionId),
		).toEqual([claimed.id]);
	});

	it("canonicalizes assignments before a create or rename is committed and acknowledged", async () => {
		const opened = await createOrOpenSessionIdentity({
			cwd,
			actorHandle: "before-trim",
			assignments: [{ kind: " project ", target: " omp " }],
		});
		managers.push(opened.manager);
		expect(opened.identity.assignments).toEqual([{ kind: "project", target: "omp" }]);
		const changed = await assignSessionIdentity(opened.manager, {
			actorHandle: "after-trim",
			assignments: [{ kind: " service ", target: " exocortex " }],
		});
		expect(changed.assignments).toEqual([{ kind: "service", target: "exocortex" }]);
		expect((await resolveSessionIdentity("after-trim")).assignments).toEqual(changed.assignments);
		const before = await Bun.file(changed.sessionFile).text();
		await expect(
			assignSessionIdentity(opened.manager, {
				actorHandle: "must-not-commit",
				assignments: [{ kind: "project", target: " " }],
			}),
		).rejects.toBeInstanceOf(SessionIdentityMetadataError);
		expect(await Bun.file(changed.sessionFile).text()).toBe(before);
		expect((await resolveSessionIdentity("after-trim")).sessionId).toBe(changed.sessionId);
	});

	it("preserves both parent-root and bucket-root projection rows for the same journal", async () => {
		const created = await create("two-scopes");
		const bucket = path.dirname(created.file);
		await listSessionIdentities({ sessionsRoot: bucket });
		expect(listSessionIdentityProjection(sessionsRoot).map(row => row.sessionId)).toEqual([created.id]);
		expect(listSessionIdentityProjection(bucket).map(row => row.sessionId)).toEqual([created.id]);
		replaceSessionIdentityProjection(bucket, []);
		expect(listSessionIdentityProjection(bucket)).toEqual([]);
		expect(listSessionIdentityProjection(sessionsRoot).map(row => row.sessionId)).toEqual([created.id]);
		await listSessionIdentities({ sessionsRoot: bucket });
		expect(listSessionIdentityProjection(bucket).map(row => row.sessionId)).toEqual([created.id]);
	});

	it("rebuilds an old projection key without losing titles or DB-only recaps", async () => {
		const created = await create("projection-migration");
		recordSessionTitle(created.id, "preserved-title");
		recordSessionRecap(created.id, cwd, "db-only-recap");
		closeSessionIndex();
		{
			using db = new Database(getHistoryDbPath());
			db.run(`DROP TABLE session_identities;
				CREATE TABLE session_identities (
					session_id TEXT PRIMARY KEY, sessions_root TEXT NOT NULL, session_file TEXT NOT NULL,
					cwd TEXT NOT NULL, root_agent TEXT, generation TEXT, actor_handle TEXT,
					assignments TEXT NOT NULL, entry_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
					UNIQUE(sessions_root, actor_handle));`);
		}
		await listSessionIdentities();
		expect(listSessionIdentityProjection(sessionsRoot).map(row => row.sessionId)).toEqual([created.id]);
		expect(lookupSessionTitle(created.id)).toBe("preserved-title");
		expect(listSessionRecaps({ sessionIds: [created.id] }).map(row => row.recap)).toEqual(["db-only-recap"]);
	});

	it("adds file checkpoints and sleep-policy fields to an older scoped index without losing titles or recaps", async () => {
		const created = await create("scoped-index-migration");
		await assignSessionIdentity(created.manager, { idleSleepSeconds: 0 });
		recordSessionTitle(created.id, "preserved-title");
		recordSessionRecap(created.id, cwd, "db-only-recap");
		closeSessionIndex();
		{
			using db = new Database(getHistoryDbPath());
			db.run("ALTER TABLE session_identities DROP COLUMN file_fingerprint");
			db.run("ALTER TABLE session_identities DROP COLUMN idle_sleep_seconds");
		}
		expect(await resolveSessionIdentity("scoped-index-migration")).toMatchObject({
			sessionId: created.id,
			idleSleepSeconds: 0,
		});
		expect(lookupSessionTitle(created.id)).toBe("preserved-title");
		expect(listSessionRecaps({ sessionIds: [created.id] }).map(row => row.recap)).toEqual(["db-only-recap"]);
	});

	it("keeps indexing DB-only recaps when another connection attempts the same schema upgrade", async () => {
		const created = await create("competing-index-migration");
		closeSessionIndex();
		using peer = new Database(getHistoryDbPath());
		peer.run("PRAGMA busy_timeout = 0");
		peer.run("ALTER TABLE session_identities DROP COLUMN file_fingerprint");
		const query = Database.prototype.query;
		const restoreStatements: (() => void)[] = [];
		let attempted = false;
		const querySpy = spyOn(Database.prototype, "query").mockImplementation(function (
			this: Database,
			...args: Parameters<typeof query>
		) {
			const statement = Reflect.apply(query, this, args) as Statement;
			if (args[0] === "PRAGMA table_info(session_identities)") {
				const all = statement.all.bind(statement);
				const allSpy = spyOn(statement, "all").mockImplementation((...params) => {
					const columns = all(...params);
					if (!attempted) {
						attempted = true;
						try {
							peer.run("ALTER TABLE session_identities ADD COLUMN file_fingerprint TEXT");
						} catch (error) {
							if (!isSqliteBusyError(error)) throw error;
						}
					}
					return columns;
				});
				restoreStatements.push(() => allSpy.mockRestore());
			}
			return statement;
		} as typeof query);
		try {
			recordSessionRecap(created.id, cwd, "after-peer-attempt");
			recordSessionRecap(created.id, cwd, "still-indexing");
			expect(attempted).toBe(true);
			expect(listSessionRecaps({ sessionIds: [created.id] }).map(row => row.recap)).toEqual([
				"still-indexing",
				"after-peer-attempt",
			]);
		} finally {
			for (const restore of restoreStatements) restore();
			querySpy.mockRestore();
		}
	});

	it("refuses a live handle attach when generation evidence is missing or mismatched", async () => {
		const created = await create("live-generation");
		await assignSessionIdentity(created.manager, { generation: "required-generation" });
		const probe = spyOn(sessionAttachOwner, "probeSessionAttach");
		const attach = spyOn(attachRunOwner, "runLiveSessionAttach").mockResolvedValue(0);
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
		const exitCode = process.exitCode;
		try {
			for (const generation of [undefined, { running: "other-generation" }]) {
				probe.mockResolvedValue({
					status: "live",
					sessionId: created.id,
					terminal: { protocolVersion: 1, projectDir: cwd, name: "fixture", id: "fixture-terminal" },
					state: { sessionDiagnostics: { execution: { cwd } }, generation },
				});
				process.exitCode = 0;
				await runNamedSessionAttach("live-generation");
				expect(process.exitCode).toBe(2);
				expect(attach).not.toHaveBeenCalled();
				expect(stderr.mock.calls.at(-1)?.[0]).toContain("generation does not match");
			}
			probe.mockResolvedValue({
				status: "live",
				sessionId: created.id,
				terminal: { protocolVersion: 1, projectDir: cwd, name: "fixture", id: "fixture-terminal" },
				state: { sessionDiagnostics: { execution: { cwd } }, generation: { running: "required-generation" } },
			});
			await runNamedSessionAttach("live-generation");
			expect(process.exitCode).toBe(0);
			expect(attach).toHaveBeenCalledTimes(1);
		} finally {
			probe.mockRestore();
			attach.mockRestore();
			stderr.mockRestore();
			process.exitCode = exitCode;
		}
	});

	it("refuses a handle claim while an admitted drop transition awaits cleanup", async () => {
		const created = await create();
		const { session, auth } = await createSdkOwner(created.manager);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const abort = spyOn(session, "abort").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
		});
		const transition = session.newSession({ drop: true });
		try {
			await withTimeout(entered.promise, 3000, "drop transition never entered cleanup");
			await expect(assignSessionIdentity(created.manager, { actorHandle: "must-not-be-deleted" })).rejects.toThrow(
				"during a transcript transition",
			);
			expect(created.manager.getSessionIdentityMetadata()?.actorHandle).toBeNull();
			release.resolve();
			expect(await transition).toBe(true);
			await expect(resolveSessionIdentity("must-not-be-deleted")).rejects.toBeInstanceOf(
				SessionIdentityNotFoundError,
			);
		} finally {
			release.resolve();
			await transition.catch(() => undefined);
			abort.mockRestore();
			await session.dispose();
			auth.close();
		}
	});

	it("refuses transcript replacement until a cleared identity completes durable readback", async () => {
		const created = await create("clearing-owner");
		const { session, auth } = await createSdkOwner(created.manager);
		const committed = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const append = created.manager.appendEntriesAtomically.bind(created.manager);
		const delayedAppend = spyOn(created.manager, "appendEntriesAtomically").mockImplementation(
			async <T>(callback: () => T): Promise<T> => {
				const result = await append(callback);
				committed.resolve();
				await release.promise;
				return result;
			},
		);
		const clearing = assignSessionIdentity(created.manager, { actorHandle: null });
		try {
			await withTimeout(committed.promise, 3000, "identity clear never committed");
			expect(created.manager.getSessionIdentityMetadata()?.actorHandle).toBeNull();
			await expect(session.newSession()).rejects.toThrow("during a session identity mutation");
			expect(session.sessionId).toBe(created.id);
			release.resolve();
			await clearing;
			delayedAppend.mockRestore();
			expect(await session.newSession()).toBe(true);
		} finally {
			release.resolve();
			await clearing.catch(() => undefined);
			delayedAppend.mockRestore();
			await session.dispose();
			auth.close();
		}
	});

	it("lets only one of two real native owner processes claim the same handle", async () => {
		const children = Array.from({ length: 2 }, () =>
			Bun.spawn(
				[process.execPath, path.join(import.meta.dir, "fixtures/session-identity-process.ts"), cwd, "process-race"],
				{
					cwd,
					env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
					timeout: 15_000,
				},
			),
		);
		const errors = children.map(child => new Response(child.stderr).text());
		const readers = children.map(child =>
			readJsonl<{ stage: string; status: string; sessionId: string }>(child.stdout)[Symbol.asyncIterator](),
		);
		const next = async (index: number) => {
			const line = await withTimeout(readers[index].next(), 10_000, "native identity process did not respond");
			if (line.done) throw new Error("native identity process ended before its receipt");
			return line.value;
		};
		try {
			const ready = await Promise.all([next(0), next(1)]);
			expect(ready.map(value => value.stage)).toEqual(["ready", "ready"]);
			for (const child of children) child.stdin.write("claim\n");
			await Promise.all(children.map(child => child.stdin.end()));
			const receipts = await Promise.all([next(0), next(1)]);
			expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0]);
			expect(receipts.map(value => value.status).sort()).toEqual(["accepted", "conflict"]);
			const accepted = receipts.find(value => value.status === "accepted");
			if (!accepted) throw new Error("No native process won the handle claim");
			const catalog = await listSessionIdentities();
			expect(
				catalog.filter(record => record.actorHandle === "process-race").map(record => record.sessionId),
			).toEqual([accepted.sessionId]);
			expect(catalog).toHaveLength(2);
		} finally {
			for (const child of children) if (child.exitCode === null) child.kill();
			await Promise.all(children.map(child => child.exited));
			await Promise.all(errors);
		}
	}, 20_000);
});
