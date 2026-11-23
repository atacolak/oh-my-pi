import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { serveInteractiveSessionSocket } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-command-surface";
import { createAgentSessionSocket } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-socket";
import type { RpcRuntimeRestartReceipt } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { isRecord, postmortem, readLines, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

let temp: TempDir;
let auth: AuthStorage;
let session: AgentSession | undefined;
let closeSocket: (() => Promise<void>) | undefined;
let peer: IpcConnection | undefined;
let modeToStop: InteractiveMode | undefined;

beforeAll(() => initTheme());
beforeEach(async () => {
	temp = TempDir.createSync("@omp-owner-exit-");
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: temp.path() });
	auth = await AuthStorage.create(":memory:");
});
afterEach(async () => {
	peer?.destroy();
	peer = undefined;
	await closeSocket?.();
	closeSocket = undefined;
	if (session) session.agent.state.isStreaming = false;
	await session?.dispose();
	session = undefined;
	modeToStop?.stop();
	modeToStop = undefined;
	auth.close();
	vi.restoreAllMocks();
	temp.removeSync();
	resetSettingsForTest();
});

async function fixture(options: { route?: boolean; alias?: boolean } = {}) {
	const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
	manager.appendMessage({ role: "user", content: "retained conversation", timestamp: 1 });
	await manager.ensureOnDisk();
	const originalFile = manager.getSessionFile();
	if (!originalFile) throw new Error("missing fixture journal");
	let selected = manager;
	const alias = path.join(temp.path(), "selected.jsonl");
	if (options.alias) {
		await manager.close();
		await fs.symlink(originalFile, alias);
		selected = await SessionManager.open(alias);
		selected.appendCustomEntry("owner-claim", {});
		await selected.flush();
	}
	const registry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"), { ignoreLocalModelConfig: true });
	const model = createMockModel({ handler: { content: ["unused"] } });
	const created = await createAgentSession({
		cwd: temp.path(),
		agentDir: path.join(temp.path(), "agent"),
		authStorage: auth,
		modelRegistry: registry,
		model: model.model,
		sessionManager: selected,
		settings: Settings.isolated({ "compaction.enabled": false }),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	session = created.session;
	const activeSession = session;
	const mode = new InteractiveMode(activeSession, "fixture");
	modeToStop = mode;
	mode.ui.requestRender = () => {};
	mode.ui.terminal.drainInput = async () => {};
	vi.spyOn(postmortem, "quit").mockResolvedValue();
	const exited = Promise.withResolvers<boolean>();
	const endpointDir = path.join(temp.path(), "run");
	const served = await serveInteractiveSessionSocket({
		session: activeSession,
		socket: createAgentSessionSocket(activeSession, { endpointDir }),
		hasPendingHostWork: () => mode.hasPendingTerminalWork(),
		...(options.route === false
			? {}
			: {
					exitSession: async (canExit: () => boolean) => {
						const result = await mode.exitIdleSession(canExit);
						exited.resolve(result);
						return result;
					},
				}),
	});
	closeSocket = served.close;
	let sequence = 0;
	const pending = new Map<string, (frame: Record<string, unknown>) => void>();
	const ready = Promise.withResolvers<void>();
	peer = await IpcConnection.connect(path.join(endpointDir, `${activeSession.sessionId}.sock`), { framing: "lines" });
	peer.start(
		line => {
			const frame: unknown = JSON.parse(line);
			if (!isRecord(frame)) return;
			if (frame.type === "ready") ready.resolve();
			if (typeof frame.id === "string") pending.get(frame.id)?.(frame);
		},
		() => {},
	);
	await withTimeout(ready.promise, 3000, "native owner socket not ready");
	async function request(command: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = `exit-test-${++sequence}`;
		const result = Promise.withResolvers<Record<string, unknown>>();
		pending.set(id, result.resolve);
		peer!.send(JSON.stringify({ ...command, id }));
		try {
			return await withTimeout(result.promise, 3000, "native owner did not respond");
		} finally {
			pending.delete(id);
		}
	}
	const preflight = await request({ type: "get_refresh_preflight" });
	if (!isRecord(preflight.data) || !isRecord(preflight.data.restartReceipt)) throw new Error("missing owner receipt");
	const receipt = preflight.data.restartReceipt as unknown as RpcRuntimeRestartReceipt;
	const command = {
		type: "exit_session",
		expectedSessionId: receipt.sessionId,
		expectedSessionFile: receipt.sessionFile,
		expectedBootId: receipt.bootId,
	};
	return { session: activeSession, manager: selected, originalFile, alias, mode, request, command, exited, served };
}

describe("native cooperative owner exit", () => {
	it("acknowledges scheduling, exits the idle journal owner, and retains its exact resumable conversation", async () => {
		const f = await fixture();
		const before = await Bun.file(f.originalFile).text();
		const response = await f.request(f.command);
		expect(response).toMatchObject({
			success: true,
			data: { scheduled: true, owner: { sessionId: f.session.sessionId } },
		});
		expect(await withTimeout(f.exited.promise, 3000, "owner teardown did not finish")).toBe(true);
		expect(f.session.isDisposed).toBe(true);
		expect(await Bun.file(f.originalFile).text()).toBe(before);
		expect(f.manager.hasSessionOwnership()).toBe(false);
	});

	it("refuses sleep on a draft-save failure, keeps serving the owner and can retry without losing the draft", async () => {
		const f = await fixture();
		f.mode.editor.setText("keep this unsent draft");
		const before = await Bun.file(f.originalFile).text();
		const save = vi.spyOn(f.manager, "saveDraft").mockRejectedValueOnce(new Error("draft storage unavailable"));
		const dispose = vi.spyOn(f.session, "beginDispose");
		const showError = vi.spyOn(f.mode, "showError").mockImplementation(() => {});
		expect(await f.request(f.command)).toMatchObject({ success: true, data: { scheduled: true } });
		expect(await withTimeout(f.exited.promise, 3000, "draft failure did not refuse sleep")).toBe(false);
		expect(dispose).not.toHaveBeenCalled();
		expect(f.session.isDisposed).toBe(false);
		expect(f.manager.hasSessionOwnership()).toBe(true);
		expect(await Bun.file(f.originalFile).text()).toBe(before);
		expect(await f.request({ type: "get_state" })).toMatchObject({ success: true });
		expect(showError).toHaveBeenCalled();
		expect(await f.mode.exitIdleSession(() => true)).toBe(true);
		expect(save).toHaveBeenCalledTimes(2);
		expect(await f.manager.consumeDraft()).toBe("keep this unsent draft");
	});

	it.each(["terminal work", "changed draft"])(
		"rechecks %s after awaited draft saving and leaves sleep retryable",
		async state => {
			const f = await fixture();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const save = vi.spyOn(f.manager, "saveDraft").mockImplementationOnce(async () => {
				entered.resolve();
				await release.promise;
			});
			const dispose = vi.spyOn(f.session, "beginDispose");
			try {
				expect(await f.request(f.command)).toMatchObject({ success: true, data: { scheduled: true } });
				await withTimeout(entered.promise, 3000, "draft save did not start");
				if (state === "terminal work")
					f.mode.startPendingSubmission({ text: "new work while saving", customType: "fixture" });
				else f.mode.editor.setText("new unsent draft while saving");
				release.resolve();
				expect(await withTimeout(f.exited.promise, 3000, "new work did not cancel sleep")).toBe(false);
				expect(dispose).not.toHaveBeenCalled();
				expect(f.session.isDisposed).toBe(false);
				expect(await f.request({ type: "get_state" })).toMatchObject({ success: true });
			} finally {
				release.resolve();
				f.mode.cancelPendingSubmission();
				save.mockRestore();
			}
		},
	);

	it.each([
		"session",
		"path",
		"boot",
		"absent-boot",
		"force",
		"busy",
		"queued",
		"unknown-jobs",
		"missing-route",
		"extra-field",
	] as const)("refuses %s without disposing or rewriting the current owner", async state => {
		const f = await fixture({ route: state !== "missing-route" });
		const before = await Bun.file(f.originalFile).text();
		const command: Record<string, unknown> = { ...f.command };
		let code = "owner_target_mismatch";
		if (state === "session") command.expectedSessionId = "other-session";
		if (state === "path") command.expectedSessionFile = path.join(temp.path(), "other.jsonl");
		if (state === "boot") command.expectedBootId = "stale-incarnation";
		if (state === "absent-boot") {
			delete command.expectedBootId;
			code = "owner_target_required";
		}
		if (state === "force") {
			command.force = true;
			code = "force_termination_unavailable";
		}
		if (state === "busy") {
			f.session.agent.state.isStreaming = true;
			code = "session_busy";
		}
		if (state === "queued") {
			f.session.agent.followUp({ role: "user", content: "keep this request", timestamp: Date.now() });
			code = "session_busy";
		}
		if (state === "unknown-jobs") {
			vi.spyOn(f.session, "getAsyncJobTree").mockReturnValue(null);
			code = "session_busy";
		}
		if (state === "missing-route") code = "owner_exit_unavailable";
		if (state === "extra-field") {
			command.signal = "SIGKILL";
			code = "invalid_exit_request";
		}
		expect(await f.request(command)).toMatchObject({ success: false, code });
		expect(f.session.isDisposed).toBe(false);
		expect(await Bun.file(f.originalFile).text()).toBe(before);
	});

	it.each(["submission", "loop"] as const)("refuses terminal-owned %s work before session admission", async kind => {
		const f = await fixture();
		if (kind === "submission")
			f.mode.startPendingSubmission({ text: "pending terminal request", customType: "fixture" });
		else {
			f.mode.loopModeEnabled = true;
			f.mode.loopPrompt = "continue later";
			void f.mode.getUserInput();
		}
		try {
			expect(f.session.hasAdmittedSubmission).toBe(false);
			expect(await f.request(f.command)).toMatchObject({ success: false, code: "session_busy" });
			expect(f.session.isDisposed).toBe(false);
		} finally {
			f.mode.cancelPendingSubmission();
			f.mode.pauseLoop();
		}
	});

	it("refuses exit while foreground bash is running and preserves its completion", async () => {
		const f = await fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async () => {
			started.resolve();
			await release.promise;
			return {
				output: "completed shell work",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 20,
				outputLines: 1,
				outputBytes: 20,
			};
		});
		const bash = f.request({ type: "bash", command: "held foreground command" });
		try {
			await withTimeout(started.promise, 3000, "bash admission did not start");
			expect(await f.request(f.command)).toMatchObject({ success: false, code: "session_busy" });
			expect(f.session.isDisposed).toBe(false);
		} finally {
			release.resolve();
		}
		expect(await bash).toMatchObject({ success: true, data: { output: "completed shell work" } });
	});

	it("refuses RPC shell execution after the owner closes disposal admission", async () => {
		const f = await fixture();
		const spawn = vi.spyOn(bashExecutor, "executeBash");
		f.session.beginDispose();
		expect(await f.request({ type: "bash", command: "echo must-not-run" })).toMatchObject({ success: false });
		expect(spawn).not.toHaveBeenCalled();
	});

	it("refuses exit while accepted input is still preparing before AgentSession admission", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(f.session, "prompt").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return false;
		});
		const pending = f.request({ type: "prompt", message: "pending input" });
		try {
			await withTimeout(entered.promise, 3000, "input preparation did not start");
			expect(f.session.hasAdmittedSubmission).toBe(false);
			expect(await f.request(f.command)).toMatchObject({ success: false, code: "session_busy" });
			expect(f.session.isDisposed).toBe(false);
		} finally {
			release.resolve();
			await pending;
		}
	});

	it.each([
		"busy",
		"terminal-input",
		"released",
		"replaced-journal",
		"retargeted-alias",
		"socket-closed",
		"veto",
	] as const)("rechecks %s after awaiting extension decisions and leaves the journal intact", async state => {
		const f = await fixture({ alias: state === "retargeted-alias" });
		const before = await Bun.file(f.originalFile).text();
		let expectedContent = before;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(f.session, "confirmClose").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return state !== "veto";
		});
		try {
			expect(await f.request(f.command)).toMatchObject({ success: true, data: { scheduled: true } });
			await withTimeout(entered.promise, 3000, "extension close decision did not start");
			if (state === "busy") f.session.agent.state.isStreaming = true;
			if (state === "released") await f.manager.close();
			if (state === "terminal-input")
				f.mode.startPendingSubmission({ text: "new terminal request", customType: "fixture" });
			if (state === "replaced-journal") {
				const header = Bun.JSONL.parse(before).find(
					(entry): entry is Record<string, unknown> => isRecord(entry) && entry.type === "session",
				);
				if (!header) throw new Error("missing fixture session header");
				expectedContent = before.replace(
					JSON.stringify(header),
					JSON.stringify({ ...header, id: "replacement-owner" }),
				);
				if (expectedContent === before) throw new Error("fixture did not replace the session header");
				await Bun.write(f.originalFile, expectedContent);
			}
			if (state === "retargeted-alias") {
				const copied = path.join(temp.path(), "copied.jsonl");
				await Bun.write(copied, Bun.file(f.originalFile));
				await fs.unlink(f.alias);
				await fs.symlink(copied, f.alias);
			}
			if (state === "socket-closed") await f.served.close();
			release.resolve();
			expect(await withTimeout(f.exited.promise, 3000, "cancelled exit did not settle")).toBe(false);
			expect(f.session.isDisposed).toBe(false);
			expect(await Bun.file(f.originalFile).text()).toBe(expectedContent);
		} finally {
			release.resolve();
			if (state === "retargeted-alias") {
				await fs.unlink(f.alias);
				await fs.symlink(f.originalFile, f.alias);
			}
			if (state === "replaced-journal") await Bun.write(f.originalFile, before);
			if (state === "terminal-input") f.mode.cancelPendingSubmission();
		}
	});
});

it("exits a real throwaway owner process through its published socket without a PID signal and retains its journal", async () => {
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/owner-exit-agent.ts")], {
		cwd: temp.path(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const lines = readLines(child.stdout);
	const errors = Bun.readableStreamToText(child.stderr);
	let drained: Promise<void> | undefined;
	try {
		const first = await withTimeout(lines.next(), 5000, "throwaway owner did not publish its socket");
		if (first.done) throw new Error(`owner exited before publication: ${await errors}`);
		const publication: unknown = JSON.parse(new TextDecoder().decode(first.value));
		if (
			!isRecord(publication) ||
			typeof publication.socketPath !== "string" ||
			typeof publication.sessionFile !== "string"
		)
			throw new Error("invalid throwaway owner receipt");
		drained = (async () => {
			for await (const _line of lines) {
				/* drain teardown output */
			}
		})();
		const before = await Bun.file(publication.sessionFile).text();
		const response = Promise.withResolvers<Record<string, unknown>>();
		peer = await IpcConnection.connect(publication.socketPath, { framing: "lines" });
		peer.start(
			line => {
				const frame: unknown = JSON.parse(line);
				if (isRecord(frame) && frame.id === "cooperative-exit") response.resolve(frame);
			},
			() => {},
		);
		peer.send(
			JSON.stringify({
				id: "cooperative-exit",
				type: "exit_session",
				expectedSessionId: publication.sessionId,
				expectedSessionFile: publication.sessionFile,
				expectedBootId: publication.bootId,
			}),
		);
		expect(await withTimeout(response.promise, 5000, "exit scheduling receipt missing")).toMatchObject({
			success: true,
			data: { scheduled: true },
		});
		expect(await withTimeout(child.exited, 5000, "cooperative owner did not exit")).toBe(0);
		expect(await Bun.file(publication.sessionFile).text()).toBe(before);
		expect(await fs.stat(publication.socketPath).catch(() => undefined)).toBeUndefined();
	} finally {
		if (child.exitCode === null) child.kill();
		await child.exited;
		await drained;
		await errors;
	}
}, 15_000);
