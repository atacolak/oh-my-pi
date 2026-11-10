import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SessionRestartTarget } from "@oh-my-pi/pi-coding-agent/launch/session-attach";
import {
	consumeSessionOwnerContext,
	resetSessionOwnerContextForTest,
	SESSION_OWNER_CONTEXT_ENV,
} from "@oh-my-pi/pi-coding-agent/launch/session-owner";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { RuntimeRestartOptions } from "@oh-my-pi/pi-coding-agent/modes/rpc/model-runtime-upgrade";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, isSessionLeaseHeld } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import * as natives from "@oh-my-pi/pi-natives";
import * as workerClient from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import * as fileLocks from "@oh-my-pi/pi-utils/file-lock";

describe("InteractiveMode restart", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let sessionManager: SessionManager;
	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;
	let originalArgv: string[];

	beforeAll(() => initTheme());
	beforeEach(async () => {
		resetSettingsForTest();
		resetSessionOwnerContextForTest();
		tempDir = TempDir.createSync("@omp-restart-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		originalArgv = process.argv;
		sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "persona sessions"));
		consumeSessionOwnerContext({
			[SESSION_OWNER_CONTEXT_ENV]: JSON.stringify({
				projectDir: tempDir.path(),
				name: "private-restart-fixture",
				id: "private-restart-generation",
			}),
		});
	});

	afterEach(async () => {
		mode?.stop();
		mode = undefined;
		vi.restoreAllMocks();
		process.argv = originalArgv;
		await session?.dispose();
		session = undefined;
		resetSessionOwnerContextForTest();
		await sessionManager.close();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	async function restart(
		argv: string[],
		allowRefusal = false,
		expectedTarget?: SessionRestartTarget,
		options: RuntimeRestartOptions = {},
		canRestart?: () => boolean,
	): Promise<string[]> {
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = () => {};
		mode.ui.terminal.drainInput = async () => {};
		process.argv = [originalArgv[0], originalArgv[1], ...argv];
		// Stop only at the process replacement boundary; teardown and argv production run for real.
		const exec = vi.spyOn(natives, "execReplace").mockImplementation(() => undefined as never);
		const nativeSpawn = Bun.spawn;
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation((...args) => {
			if (!Array.isArray(args[0])) return nativeSpawn(args[0]);
			return { exited: Promise.resolve(0) } as never;
		});
		vi.spyOn(postmortem, "cleanup").mockResolvedValue();
		vi.spyOn(postmortem, "drainStdout").mockResolvedValue();
		vi.spyOn(postmortem, "quit").mockResolvedValue();
		await mode.restart(expectedTarget, canRestart, options);
		const command =
			process.platform === "win32"
				? spawn.mock.calls.find(([command]) => Array.isArray(command))?.[0]
				: exec.mock.calls[0]?.[0];
		if (!Array.isArray(command) && allowRefusal) return [];
		if (!Array.isArray(command)) throw new Error("expected replacement command");
		return command;
	}

	it("resumes an explicitly opened persona journal without rediscovering its ID", async () => {
		sessionManager.appendMessage({ role: "user", content: "initial request", timestamp: 1 });
		sessionManager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			api: "anthropic-messages",
			content: [{ type: "text", text: "saved answer" }],
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			timestamp: 2,
		});
		await sessionManager.ensureOnDisk();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const id = sessionManager.getSessionId();
		const transcript = sessionManager.buildSessionContext().messages;
		await sessionManager.close();
		const storage = new FileSessionStorage();
		const ownershipReservation = storage.reserveSession(id, file);
		sessionManager = await SessionManager.open(file, undefined, storage, {
			ownershipPolicy: "require-owner",
			ownershipReservation,
		});
		const command = await restart(
			[
				"--session",
				file,
				"--model",
				"anthropic/claude-sonnet-4-5",
				"--append-system-prompt",
				"persona prompt",
				"--skills",
				"/office/skills",
				"-e",
				"/office/extension.ts",
				"--model",
				"openai-codex/gpt-6.1-sol:high",
				"initial request",
			],
			false,
			{ sessionId: id, sessionFile: await fs.realpath(file) },
		);
		const parsed = parseArgs(command.slice(command.indexOf("--model")));
		expect(parsed.model).toBe("openai-codex/gpt-6.1-sol:high");
		expect(parsed.messages).toEqual([]);
		const resumed = await createSessionManager(parsed, tempDir.path(), Settings.isolated());
		if (!resumed) throw new Error("expected resumed journal");
		try {
			expect(resumed.getSessionFile()).toBe(file);
			expect(resumed.getSessionId()).toBe(id);
			expect(resumed.buildSessionContext().messages).toEqual(transcript);
		} finally {
			await resumed.close();
		}
	});

	it("resumes a journal created in a flag-looking relative directory", async () => {
		using relativeDir = TempDir.createSync("-omp-restart-");
		await sessionManager.close();
		sessionManager = SessionManager.create(tempDir.path(), relativeDir.path());
		sessionManager.appendMessage({ role: "user", content: "saved request", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const id = sessionManager.getSessionId();
		const command = await restart(["--model", "anthropic/claude-sonnet-4-5", `--session-dir=${relativeDir.path()}`]);
		const parsed = parseArgs(command.slice(command.indexOf("--model")));
		const resumed = await createSessionManager(parsed, tempDir.path(), Settings.isolated());
		if (!resumed) throw new Error("expected resumed journal");
		try {
			expect(resumed.getSessionFile()).toBe(path.resolve(file));
			expect(resumed.getSessionId()).toBe(id);
			expect(resumed.buildSessionContext().messages).toEqual([
				{ role: "user", content: "saved request", timestamp: 1 },
			]);
		} finally {
			await resumed.close();
		}
	});

	it.each(["executable", "entry"] as const)(
		"keeps the owner, journal and draft intact when the replacement %s is missing",
		async missing => {
			sessionManager.appendMessage({ role: "user", content: "preserved request", timestamp: 1 });
			await sessionManager.saveDraft("unfinished operator draft");
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("expected persisted journal");
			const before = await Bun.file(file).text();
			const missingPath = tempDir.join(`missing-${missing}`);
			vi.spyOn(workerClient, "resolveCliEntryCmd").mockReturnValue(
				missing === "executable" ? [missingPath] : [process.execPath, missingPath],
			);
			const warning = vi.spyOn(InteractiveMode.prototype, "showWarning").mockImplementation(() => {});
			const command = await restart(["--model", "anthropic/claude-sonnet-4-5"], true);
			expect(command).toEqual([]);
			expect(session?.isDisposed).toBe(false);
			expect(await Bun.file(file).text()).toBe(before);
			expect(await sessionManager.consumeDraft()).toBe("unfinished operator draft");
			expect(warning.mock.calls.some(([message]) => /restart.*receiver/i.test(message))).toBe(true);
		},
	);

	it("keeps the original owner and draft when the replacement image lacks exact restart support", async () => {
		sessionManager.appendMessage({ role: "user", content: "preserved conversation", timestamp: 1 });
		await sessionManager.saveDraft("preserved operator draft");
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const before = await Bun.file(file).text();
		const legacyEntry = path.join(tempDir.path(), "legacy-cli.ts");
		await Bun.write(legacyEntry, 'process.stdout.write("omp/legacy\\n");\n');
		vi.spyOn(workerClient, "resolveCliEntryCmd").mockReturnValue([process.execPath, legacyEntry]);
		const warning = vi.spyOn(InteractiveMode.prototype, "showWarning").mockImplementation(() => {});
		expect(await restart(["--model", "anthropic/claude-sonnet-4-5"], true)).toEqual([]);
		expect(session?.isDisposed).toBe(false);
		expect(await Bun.file(file).text()).toBe(before);
		expect(await sessionManager.consumeDraft()).toBe("preserved operator draft");
		expect(warning.mock.calls.some(([message]) => /restart.*receiver/i.test(message))).toBe(true);
	});

	it("does not follow a conversation changed during receiver attestation", async () => {
		sessionManager.appendMessage({ role: "user", content: "selected conversation", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected selected journal");
		const before = await Bun.file(file).text();
		let nextFile: string | undefined;
		let nextBefore: string | undefined;
		vi.spyOn(workerClient, "attestCliRestartReceiver").mockImplementation(async () => {
			nextFile = await sessionManager.newSession();
			if (!nextFile) throw new Error("expected new conversation journal");
			nextBefore = await Bun.file(nextFile).text();
			return { type: "restart_receiver", protocol: 1, nonce: "fixture", version: "fixture" };
		});
		const warning = vi.spyOn(InteractiveMode.prototype, "showWarning").mockImplementation(() => {});
		expect(await restart(["--model", "anthropic/claude-sonnet-4-5"], true)).toEqual([]);
		expect(session?.isDisposed).toBe(false);
		expect(sessionManager.getSessionFile()).toBe(nextFile);
		expect(await Bun.file(file).text()).toBe(before);
		if (!nextFile || nextBefore === undefined) throw new Error("expected observed new journal and captured content");
		expect(await Bun.file(nextFile).text()).toBe(nextBefore);
		expect(warning.mock.calls.some(([message]) => /restart.*target/i.test(message))).toBe(true);
	});

	it("refuses a disappeared journal instead of restarting a fresh conversation", async () => {
		sessionManager.appendMessage({ role: "user", content: "original request", timestamp: 1 });
		await sessionManager.saveDraft("original draft");
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		await fs.unlink(file);
		const warning = vi.spyOn(InteractiveMode.prototype, "showWarning").mockImplementation(() => {});
		expect(await restart(["--model", "anthropic/claude-sonnet-4-5"], true)).toEqual([]);
		expect(session?.isDisposed).toBe(false);
		expect(await Bun.file(file).exists()).toBe(false);
		expect(await sessionManager.consumeDraft()).toBe("original draft");
		expect(warning.mock.calls.some(([message]) => /restart.*session/i.test(message))).toBe(true);
	});

	it("refuses a journal that now identifies another session without disposing its current owner", async () => {
		sessionManager.appendMessage({ role: "user", content: "original request", timestamp: 1 });
		await sessionManager.saveDraft("original draft");
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const original = await Bun.file(file).text();
		const replaced = original.replace(sessionManager.getSessionId(), Bun.randomUUIDv7());
		await Bun.write(file, replaced);
		const warning = vi.spyOn(InteractiveMode.prototype, "showWarning").mockImplementation(() => {});
		expect(await restart(["--model", "anthropic/claude-sonnet-4-5"], true)).toEqual([]);
		expect(session?.isDisposed).toBe(false);
		expect(await Bun.file(file).text()).toBe(replaced);
		expect(await sessionManager.consumeDraft()).toBe("original draft");
		expect(warning.mock.calls.some(([message]) => /restart.*session/i.test(message))).toBe(true);
	});

	it("refuses restart from a non-owning journal view without disposing it or changing the owner journal", async () => {
		sessionManager.appendMessage({ role: "user", content: "owned conversation", timestamp: 1 });
		await sessionManager.saveDraft("owner draft");
		const owner = sessionManager;
		const file = owner.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const before = await Bun.file(file).text();
		sessionManager = await SessionManager.open(file);
		const warning = vi.spyOn(InteractiveMode.prototype, "showWarning").mockImplementation(() => {});
		try {
			expect(await restart(["--model", "anthropic/claude-sonnet-4-5"], true)).toEqual([]);
			expect(session?.isDisposed).toBe(false);
			expect(await Bun.file(file).text()).toBe(before);
			expect(await owner.consumeDraft()).toBe("owner draft");
			expect(warning.mock.calls.some(([message]) => /restart.*ownership/i.test(message))).toBe(true);
		} finally {
			await owner.close();
		}
	});

	it("refuses restart when lease acquisition failed despite a legacy no-op release callback", async () => {
		sessionManager.appendMessage({ role: "user", content: "preserved conversation", timestamp: 1 });
		await sessionManager.saveDraft("preserved draft");
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const id = sessionManager.getSessionId();
		await sessionManager.close();
		sessionManager = await SessionManager.open(file);
		const acquire = fileLocks.tryAcquireFileLock;
		vi.spyOn(fileLocks, "tryAcquireFileLock").mockImplementation(filePath => {
			if (path.basename(filePath) === id) throw new Error("fixture ownership lease unavailable");
			return acquire(filePath);
		});
		sessionManager.appendMessage({ role: "user", content: "retained local note", timestamp: 2 });
		await sessionManager.flush();
		const before = await Bun.file(file).text();
		expect(isSessionLeaseHeld(id)).toBe(false);
		const warning = vi.spyOn(InteractiveMode.prototype, "showWarning").mockImplementation(() => {});
		expect(await restart(["--model", "anthropic/claude-sonnet-4-5"], true)).toEqual([]);
		expect(session?.isDisposed).toBe(false);
		expect(await Bun.file(file).text()).toBe(before);
		expect(await sessionManager.consumeDraft()).toBe("preserved draft");
		expect(warning.mock.calls.some(([message]) => /restart.*ownership/i.test(message))).toBe(true);
	});

	it("refuses restart after its bootstrap ownership reservation has been released", async () => {
		sessionManager.appendMessage({ role: "user", content: "preserved conversation", timestamp: 1 });
		await sessionManager.saveDraft("preserved draft");
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const id = sessionManager.getSessionId();
		await sessionManager.close();
		const storage = new FileSessionStorage();
		const ownershipReservation = storage.reserveSession(id, file);
		sessionManager = await SessionManager.open(file, undefined, storage, {
			ownershipPolicy: "require-owner",
			ownershipReservation,
		});
		ownershipReservation.release();
		const before = await Bun.file(file).text();
		const warning = vi.spyOn(InteractiveMode.prototype, "showWarning").mockImplementation(() => {});
		expect(await restart(["--model", "anthropic/claude-sonnet-4-5"], true)).toEqual([]);
		expect(session?.isDisposed).toBe(false);
		expect(await Bun.file(file).text()).toBe(before);
		expect(await sessionManager.consumeDraft()).toBe("preserved draft");
		expect(isSessionLeaseHeld(id)).toBe(false);
		expect(warning.mock.calls.some(([message]) => /restart.*ownership/i.test(message))).toBe(true);
	});

	it("refuses an abbreviated caller session id even when the transcript path matches", async () => {
		sessionManager.appendMessage({ role: "user", content: "exact conversation", timestamp: 1 });
		await sessionManager.saveDraft("exact conversation draft");
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const before = await Bun.file(file).text();
		const warning = vi.spyOn(InteractiveMode.prototype, "showWarning").mockImplementation(() => {});
		const expectedTarget = { sessionId: sessionManager.getSessionId().slice(0, 8), sessionFile: file };
		expect(await restart(["--model", "anthropic/claude-sonnet-4-5"], true, expectedTarget)).toEqual([]);
		expect(session?.isDisposed).toBe(false);
		expect(await Bun.file(file).text()).toBe(before);
		expect(await sessionManager.consumeDraft()).toBe("exact conversation draft");
		expect(warning.mock.calls.some(([message]) => /restart.*target/i.test(message))).toBe(true);
	});

	it("refuses an exact restart without a brokered receiver route before disposing the conversation", async () => {
		resetSessionOwnerContextForTest();
		sessionManager.appendMessage({ role: "user", content: "original conversation", timestamp: 1 });
		await sessionManager.saveDraft("original draft");
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const before = await Bun.file(file).text();
		const target = { sessionId: sessionManager.getSessionId(), sessionFile: await fs.realpath(file) };
		const warning = vi.spyOn(InteractiveMode.prototype, "showWarning").mockImplementation(() => {});
		expect(await restart(["--model", "anthropic/claude-sonnet-4-5"], true, target)).toEqual([]);
		expect(session?.isDisposed).toBe(false);
		expect(await Bun.file(file).text()).toBe(before);
		expect(await sessionManager.consumeDraft()).toBe("original draft");
		expect(warning.mock.calls.some(([message]) => /restart.*receiver/i.test(message))).toBe(true);
	});

	it("keeps the caller-selected transcript when the file observation changes after disposal", async () => {
		sessionManager.appendMessage({ role: "user", content: "selected conversation", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const expectedTarget = { sessionId: sessionManager.getSessionId(), sessionFile: await fs.realpath(file) };
		const lateFile = path.join(tempDir.path(), "other-conversation.jsonl");
		const getSessionFile = sessionManager.getSessionFile.bind(sessionManager);
		vi.spyOn(sessionManager, "getSessionFile").mockImplementation(() =>
			session?.isDisposed ? lateFile : getSessionFile(),
		);
		const command = await restart(["--model", "anthropic/claude-sonnet-4-5"], false, expectedTarget);
		const parsed = parseArgs(command.slice(command.indexOf("--model")));
		expect(parsed.resume).toBe(expectedTarget.sessionFile);
		expect(parsed.messages).toEqual([]);
	});

	it("refuses a different caller transcript even when its header repeats the current session id", async () => {
		sessionManager.appendMessage({ role: "user", content: "exact conversation", timestamp: 1 });
		await sessionManager.saveDraft("exact conversation draft");
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const before = await Bun.file(file).text();
		const otherFile = path.join(tempDir.path(), "same-id-copy.jsonl");
		await Bun.write(otherFile, before);
		const warning = vi.spyOn(InteractiveMode.prototype, "showWarning").mockImplementation(() => {});
		const expectedTarget = { sessionId: sessionManager.getSessionId(), sessionFile: otherFile };
		expect(await restart(["--model", "anthropic/claude-sonnet-4-5"], true, expectedTarget)).toEqual([]);
		expect(session?.isDisposed).toBe(false);
		expect(await Bun.file(file).text()).toBe(before);
		expect(await Bun.file(otherFile).text()).toBe(before);
		expect(await sessionManager.consumeDraft()).toBe("exact conversation draft");
		expect(warning.mock.calls.some(([message]) => /restart.*target/i.test(message))).toBe(true);
	});

	it.each(["relative", "symlink"] as const)("refuses a noncanonical %s caller transcript path", async kind => {
		sessionManager.appendMessage({ role: "user", content: "exact conversation", timestamp: 1 });
		await sessionManager.saveDraft("exact conversation draft");
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const before = await Bun.file(file).text();
		let expectedPath = path.relative(process.cwd(), file);
		if (kind === "symlink") {
			expectedPath = path.join(tempDir.path(), "journal-link.jsonl");
			await fs.symlink(file, expectedPath);
		}
		const warning = vi.spyOn(InteractiveMode.prototype, "showWarning").mockImplementation(() => {});
		const expectedTarget = { sessionId: sessionManager.getSessionId(), sessionFile: expectedPath };
		expect(await restart(["--model", "anthropic/claude-sonnet-4-5"], true, expectedTarget)).toEqual([]);
		expect(session?.isDisposed).toBe(false);
		expect(await Bun.file(file).text()).toBe(before);
		expect(await sessionManager.consumeDraft()).toBe("exact conversation draft");
		expect(warning.mock.calls.some(([message]) => /restart.*target/i.test(message))).toBe(true);
	});

	it.each(["compaction-failure", "late-admission", "success"] as const)(
		"prepares optional compaction before teardown and preserves the owner on %s",
		async state => {
			sessionManager.appendMessage({ role: "user", content: "conversation before compaction", timestamp: 1 });
			await sessionManager.saveDraft("preserved compaction draft");
			await sessionManager.ensureOnDisk();
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("expected persisted journal");
			const before = await Bun.file(file).text();
			let admitted = false;
			const compact = vi.spyOn(AgentSession.prototype, "compact").mockImplementation(async () => {
				expect(session?.isDisposed).toBe(false);
				if (state === "compaction-failure") throw new Error("summary could not be saved");
				if (state === "late-admission") admitted = true;
				return { summary: "saved summary", firstKeptEntryId: "entry", tokensBefore: 1 };
			});
			vi.spyOn(InteractiveMode.prototype, "showWarning").mockImplementation(() => {});
			const command = await restart(
				["--model", "anthropic/claude-sonnet-4-5"],
				true,
				{ sessionId: sessionManager.getSessionId(), sessionFile: await fs.realpath(file) },
				{ compactBeforeRestart: true },
				() => !admitted,
			);
			expect(compact).toHaveBeenCalledTimes(1);
			if (state === "success") {
				const parsed = parseArgs(command.slice(command.indexOf("--model")));
				expect(parsed.restore).toBe(true);
				expect(parsed.resume).toBe(await fs.realpath(file));
				expect(session?.isDisposed).toBe(true);
			} else {
				expect(command).toEqual([]);
				expect(session?.isDisposed).toBe(false);
				expect(sessionManager.hasSessionOwnership()).toBe(true);
				expect(await Bun.file(file).text()).toBe(before);
				expect(await sessionManager.consumeDraft()).toBe("preserved compaction draft");
			}
		},
	);

	it("does not resume a journal that has never materialized", async () => {
		const file = sessionManager.getSessionFile();
		const command = await restart(["--model", "anthropic/claude-sonnet-4-5", "initial request"]);
		const parsed = parseArgs(command.slice(command.indexOf("--model")));
		expect(parsed.resume).toBeUndefined();
		expect(parsed.messages).toEqual([]);
		expect(sessionManager.isSessionOnDisk()).toBe(false);
		if (!file) throw new Error("expected allocated journal path");
		expect(await Bun.file(file).exists()).toBe(false);
	});
});
