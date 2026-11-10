import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { NonSharedBuffer } from "node:buffer";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { SESSION_OWNER_WORKER_ARG } from "@oh-my-pi/pi-coding-agent/cli/worker-selectors";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createDaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import {
	consumeSessionOwnerContext,
	resetSessionOwnerContextForTest,
	SESSION_OWNER_CONTEXT_ENV,
	type SessionOwnerContext,
} from "@oh-my-pi/pi-coding-agent/launch/session-owner";
import type { SessionRestartTarget } from "@oh-my-pi/pi-coding-agent/launch/session-attach";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { serveInteractiveSessionSocket } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-command-surface";
import { createAgentSessionSocket } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-socket";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as natives from "@oh-my-pi/pi-natives";
import * as workerClient from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { isEnoent, isRecord, postmortem, readJsonl, TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import type { SessionOverrides } from "./helpers/interactive-mode-context";
import { createRpcSurfaceHarness } from "./helpers/rpc-command-surface";

const GEN_A = "a".repeat(40);
const GEN_B = "b".repeat(40);
const ENTRY_RELATIVE = path.join("packages", "coding-agent", "src", "cli.ts");
const GENERATIONS = "generations";
const CURRENT = "current";
const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");

let temp: TempDir;
let previousLink: string | undefined;
let previousEntry: string | undefined;

function generationDir(root: string, generation: string): string {
	return path.join(root, GENERATIONS, generation);
}

function generationEntry(root: string, generation: string): string {
	return path.join(generationDir(root, generation), ENTRY_RELATIVE);
}

function createGenerations(root: string): void {
	for (const generation of [GEN_A, GEN_B]) {
		const entry = generationEntry(root, generation);
		fs.mkdirSync(path.dirname(entry), { recursive: true });
		fs.rmSync(entry, { force: true });
		fs.symlinkSync(CLI, entry);
	}
	pointCurrent(root, GEN_A);
}

function pointCurrent(root: string, generation: string): void {
	const link = path.join(root, GENERATIONS, CURRENT);
	fs.rmSync(link, { force: true });
	fs.symlinkSync(generationDir(root, generation), link);
}

function activateGeneration(root: string, generation: string = GEN_A): void {
	process.env.OMP_GENERATION_LINK = path.join(root, GENERATIONS, CURRENT);
	process.env.OMP_RUNNING_GENERATION_ENTRY = generationEntry(root, generation);
}

interface StateSession {
	session: SessionOverrides;
	emit(event: unknown): void;
}

function stateSession(): StateSession {
	const listeners = new Set<(event: unknown) => void>();
	const session = {
		model: undefined,
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		hasAdmittedSubmission: false,
		steeringMode: "all",
		followUpMode: "all",
		interruptMode: "immediate",
		sessionFile: undefined,
		sessionId: "stub-session",
		sessionName: undefined,
		autoCompactionEnabled: true,
		queuedMessageCount: 0,
		hasPendingAsyncWork: () => false,
		getQueuedMessages: () => ({ steering: [], followUp: [], liveSteered: 0 }),
		getTodoPhases: () => [],
		isFastModeEnabled: () => false,
		isFastModeActive: () => false,
		isSlowModeSupported: () => false,
		isSlowModeEnabled: () => false,
		getSlowModeScope: () => undefined,
		getUsageLimitState: () => undefined,
		messages: [],
		systemPrompt: "",
		agent: {
			state: { tools: [], streamMessage: null },
			getPendingToolResults: () => [],
			metadataForProvider: () => undefined,
		},
		getContextUsage: () => undefined,
		getGoalModeState: () => undefined,
		subscribe: (listener: (event: unknown) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as SessionOverrides;
	return {
		session,
		emit: event => {
			for (const listener of Array.from(listeners)) listener(event);
		},
	};
}

function generationOf(response: RpcResponse): unknown {
	if (response.type !== "response" || response.command !== "get_state" || response.success !== true) {
		throw new Error("expected a state response");
	}
	return responseData(response).generation;
}

function responseData(response: RpcResponse): Record<string, unknown> {
	if (response.type !== "response" || response.success !== true) throw new Error("expected a successful response");
	if (!("data" in response)) return {};
	return isRecord(response.data) ? response.data : {};
}

beforeAll(() => initTheme());

beforeEach(() => {
	previousLink = process.env.OMP_GENERATION_LINK;
	previousEntry = process.env.OMP_RUNNING_GENERATION_ENTRY;
	temp = TempDir.createSync("@omp-runtime-generation-");
	createGenerations(temp.path());
});

afterEach(() => {
	if (previousLink === undefined) delete process.env.OMP_GENERATION_LINK;
	else process.env.OMP_GENERATION_LINK = previousLink;
	if (previousEntry === undefined) delete process.env.OMP_RUNNING_GENERATION_ENTRY;
	else process.env.OMP_RUNNING_GENERATION_ENTRY = previousEntry;
	vi.restoreAllMocks();
	temp.removeSync();
	resetSettingsForTest();
});

describe("runtime generation state", () => {
	it("omits generation outside a generations layout", async () => {
		delete process.env.OMP_GENERATION_LINK;
		delete process.env.OMP_RUNNING_GENERATION_ENTRY;
		const stub = stateSession();
		const harness = createRpcSurfaceHarness({ session: stub.session });
		try {
			const response = await harness.handle({ id: "state", type: "get_state" } as RpcCommand);
			expect(generationOf(response)).toBeUndefined();
		} finally {
			harness.dispose();
		}
	});

	it("reports the birth generation, then flips behind on the next read of the same session", async () => {
		activateGeneration(temp.path(), GEN_A);
		const stub = stateSession();
		const harness = createRpcSurfaceHarness({ session: stub.session });
		try {
			const first = await harness.handle({ id: "state-1", type: "get_state" } as RpcCommand);
			expect(generationOf(first)).toEqual({ running: GEN_A, current: GEN_A, behind: false });

			pointCurrent(temp.path(), GEN_B);
			const second = await harness.handle({ id: "state-2", type: "get_state" } as RpcCommand);
			expect(generationOf(second)).toEqual({ running: GEN_A, current: GEN_B, behind: true });
		} finally {
			harness.dispose();
		}
	});
});

describe("upgrade_runtime", () => {
	it("refuses when the runtime is not generation-managed", async () => {
		delete process.env.OMP_GENERATION_LINK;
		delete process.env.OMP_RUNNING_GENERATION_ENTRY;
		const stub = stateSession();
		const upgrade = vi.fn();
		const harness = createRpcSurfaceHarness({ session: stub.session, upgradeRuntime: upgrade });
		try {
			const response = await harness.handle({ id: "upgrade", type: "upgrade_runtime" } as RpcCommand);
			expect(responseData(response)).toMatchObject({
				upgraded: false,
				scheduled: false,
				reason: "not_generation_managed",
			});
			expect(upgrade).not.toHaveBeenCalled();
		} finally {
			harness.dispose();
		}
	});

	it("reports already_current without restarting", async () => {
		activateGeneration(temp.path(), GEN_A);
		const stub = stateSession();
		const upgrade = vi.fn();
		const harness = createRpcSurfaceHarness({ session: stub.session, upgradeRuntime: upgrade });
		try {
			const response = await harness.handle({ id: "upgrade", type: "upgrade_runtime" } as RpcCommand);
			expect(responseData(response)).toEqual({
				upgraded: false,
				scheduled: false,
				running: GEN_A,
				current: GEN_A,
				reason: "already_current",
			});
			expect(upgrade).not.toHaveBeenCalled();
		} finally {
			harness.dispose();
		}
	});

	it.each(["missing-target", "force"] as const)("refuses an unsafe same-generation refresh (%s)", async state => {
		activateGeneration(temp.path(), GEN_A);
		const stub = stateSession();
		Object.assign(stub.session, { isStreaming: state === "force" });
		const upgrade = vi.fn();
		const harness = createRpcSurfaceHarness({ session: stub.session, upgradeRuntime: upgrade });
		try {
			const response = await harness.handle({
				id: "unsafe-refresh",
				type: "upgrade_runtime",
				refresh: true,
				...(state === "force" ? { force: true } : {}),
			} as RpcCommand);
			expect(response).toMatchObject({
				success: false,
				code: state === "force" ? "refresh_force_unsupported" : "session_target_required",
			});
			await flushImmediate();
			expect(upgrade).not.toHaveBeenCalled();
		} finally {
			harness.dispose();
		}
	});

	it.each(["single", "overlapping-legacy"] as const)(
		"keeps same-generation refresh pending across initial and late foreground admission (%s)",
		async mode => {
			activateGeneration(temp.path(), GEN_A);
			const manager = SessionManager.create(temp.path(), path.join(temp.path(), "refresh-sessions"));
			manager.appendMessage({ role: "user", content: "retained conversation", timestamp: 1 });
			await manager.ensureOnDisk();
			const file = manager.getSessionFile();
			if (!file) throw new Error("expected persisted refresh journal");
			const stub = stateSession();
			Object.assign(stub.session, {
				sessionManager: manager,
				sessionId: manager.getSessionId(),
				sessionFile: file,
				hasAdmittedSubmission: true,
			});
			const upgrade = vi.fn<(target?: SessionRestartTarget, canRestart?: () => boolean) => void>();
			const harness = createRpcSurfaceHarness({ session: stub.session, upgradeRuntime: upgrade });
			try {
				if (mode === "overlapping-legacy") {
					pointCurrent(temp.path(), GEN_B);
					const legacy = await harness.handle({ id: "legacy-idle", type: "upgrade_runtime", whenIdle: true });
					expect(responseData(legacy)).toMatchObject({ scheduled: true });
					await flushImmediate();
					expect(upgrade).not.toHaveBeenCalled();
					pointCurrent(temp.path(), GEN_A);
				}
				const expectedTarget = { sessionId: manager.getSessionId(), sessionFile: await fsPromises.realpath(file) };
				const response = await harness.handle({
					id: "refresh-when-settled",
					type: "upgrade_runtime",
					refresh: true,
					whenIdle: true,
					expectedSessionId: expectedTarget.sessionId,
					expectedSessionFile: expectedTarget.sessionFile,
				});
				expect(responseData(response)).toMatchObject({
					upgraded: false,
					scheduled: true,
					reason: "scheduled_on_idle",
				});
				await flushImmediate();
				expect(upgrade).not.toHaveBeenCalled();
				Object.assign(harness.session, { hasAdmittedSubmission: false });
				stub.emit({ type: "queue_update" });
				await flushImmediate();
				expect(upgrade).toHaveBeenCalledTimes(1);
				expect(upgrade.mock.calls[0]?.[0]).toEqual(expectedTarget);
				const firstAdmission = upgrade.mock.calls[0]?.[1];
				if (!firstAdmission) throw new Error("expected exact refresh admission check");
				Object.assign(harness.session, { hasAdmittedSubmission: true });
				expect(firstAdmission()).toBe(false);
				await flushImmediate();
				expect(upgrade).toHaveBeenCalledTimes(1);
				Object.assign(harness.session, { hasAdmittedSubmission: false });
				stub.emit({ type: "queue_update" });
				await flushImmediate();
				expect(upgrade).toHaveBeenCalledTimes(2);
				const retriedAdmission = upgrade.mock.calls[1]?.[1];
				if (!retriedAdmission) throw new Error("expected retried exact refresh admission");
				expect(retriedAdmission()).toBe(true);
				expect(firstAdmission()).toBe(false);
				expect(await Bun.file(file).text()).toContain("retained conversation");
			} finally {
				harness.dispose();
				await manager.close();
			}
		},
	);

	it("refuses a busy session, arms an idle upgrade, and restarts once settled", async () => {
		activateGeneration(temp.path(), GEN_A);
		pointCurrent(temp.path(), GEN_B);
		const stub = stateSession();
		Object.assign(stub.session, { isStreaming: true });
		const upgrade = vi.fn();
		const harness = createRpcSurfaceHarness({ session: stub.session, upgradeRuntime: upgrade });
		try {
			const refused = await harness.handle({ id: "busy", type: "upgrade_runtime" } as RpcCommand);
			expect(refused).toMatchObject({ success: false, code: "session_busy" });
			expect(upgrade).not.toHaveBeenCalled();

			const scheduled = await harness.handle({ id: "idle", type: "upgrade_runtime", whenIdle: true } as RpcCommand);
			expect(responseData(scheduled)).toEqual({
				upgraded: false,
				scheduled: true,
				running: GEN_A,
				current: GEN_B,
				reason: "scheduled_on_idle",
			});
			expect(upgrade).not.toHaveBeenCalled();

			Object.assign(harness.session, { isStreaming: false });
			stub.emit({ type: "agent_end" });
			await flushImmediate();
			expect(upgrade).toHaveBeenCalledTimes(1);
		} finally {
			harness.dispose();
		}
	});

	it("refuses an admitted foreground submission before streaming and upgrades only after it settles", async () => {
		activateGeneration(temp.path(), GEN_A);
		pointCurrent(temp.path(), GEN_B);
		const stub = stateSession();
		Object.assign(stub.session, { hasAdmittedSubmission: true });
		const upgrade = vi.fn();
		const harness = createRpcSurfaceHarness({ session: stub.session, upgradeRuntime: upgrade });
		try {
			const refused = await harness.handle({ id: "admitted", type: "upgrade_runtime" } as RpcCommand);
			expect(refused).toMatchObject({ success: false, code: "session_busy" });
			const scheduled = await harness.handle({ id: "idle", type: "upgrade_runtime", whenIdle: true } as RpcCommand);
			expect(responseData(scheduled)).toMatchObject({ scheduled: true, reason: "scheduled_on_idle" });
			await flushImmediate();
			expect(upgrade).not.toHaveBeenCalled();

			Object.assign(harness.session, { hasAdmittedSubmission: false });
			stub.emit({ type: "agent_end" });
			await flushImmediate();
			expect(upgrade).toHaveBeenCalledTimes(1);
		} finally {
			harness.dispose();
		}
	});

	it.each(["immediate", "idle"] as const)(
		"defers a %s upgrade when a new submission arrives before the callback",
		async mode => {
			activateGeneration(temp.path(), GEN_A);
			pointCurrent(temp.path(), GEN_B);
			const stub = stateSession();
			Object.assign(stub.session, { isStreaming: mode === "idle" });
			const upgrade = vi.fn();
			const harness = createRpcSurfaceHarness({ session: stub.session, upgradeRuntime: upgrade });
			try {
				await harness.handle({ id: "upgrade", type: "upgrade_runtime", whenIdle: true } as RpcCommand);
				Object.assign(harness.session, { isStreaming: false });
				if (mode === "idle") stub.emit({ type: "agent_end" });
				Object.assign(harness.session, { hasAdmittedSubmission: true });
				await flushImmediate();
				expect(upgrade).not.toHaveBeenCalled();

				Object.assign(harness.session, { hasAdmittedSubmission: false });
				stub.emit({ type: "agent_end" });
				await flushImmediate();
				await flushImmediate();
				expect(upgrade).toHaveBeenCalledTimes(1);
			} finally {
				harness.dispose();
			}
		},
	);

	it.each(["immediate", "idle"] as const)("cancels a deferred %s upgrade when the surface closes", async mode => {
		activateGeneration(temp.path(), GEN_A);
		pointCurrent(temp.path(), GEN_B);
		const stub = stateSession();
		Object.assign(stub.session, { isStreaming: mode === "idle" });
		const upgrade = vi.fn();
		const harness = createRpcSurfaceHarness({ session: stub.session, upgradeRuntime: upgrade });
		try {
			await harness.handle({ id: "upgrade", type: "upgrade_runtime", whenIdle: true } as RpcCommand);
			Object.assign(harness.session, { isStreaming: false });
			if (mode === "idle") stub.emit({ type: "agent_end" });
			harness.dispose();
			await flushImmediate();
			stub.emit({ type: "agent_end" });
			await flushImmediate();
			expect(upgrade).not.toHaveBeenCalled();
		} finally {
			harness.dispose();
		}
	});

	for (const mode of ["immediate", "idle"] as const) {
		it.each(["sessionId", "sessionFile"] as const)(
			`cancels a deferred ${mode} upgrade when its selected %s changes`,
			async field => {
				activateGeneration(temp.path(), GEN_A);
				pointCurrent(temp.path(), GEN_B);
				const stub = stateSession();
				Object.assign(stub.session, {
					isStreaming: mode === "idle",
					sessionFile: "/selected/conversation.jsonl",
					sessionManager: SessionManager.inMemory(temp.path()),
				});
				const upgrade = vi.fn();
				const harness = createRpcSurfaceHarness({ session: stub.session, upgradeRuntime: upgrade });
				try {
					await harness.handle({ id: "selected-upgrade", type: "upgrade_runtime", whenIdle: true } as RpcCommand);
					Object.assign(harness.session, {
						[field]: field === "sessionId" ? "another-session" : "/another/conversation.jsonl",
						isStreaming: false,
					});
					if (mode === "idle") stub.emit({ type: "agent_end" });
					await flushImmediate();
					await flushImmediate();
					expect(upgrade).not.toHaveBeenCalled();

					const retry = await harness.handle({ id: "current-upgrade", type: "upgrade_runtime" } as RpcCommand);
					expect(responseData(retry)).toMatchObject({ upgraded: true, scheduled: false });
					await flushImmediate();
					expect(upgrade).toHaveBeenCalledTimes(1);
				} finally {
					harness.dispose();
				}
			},
		);
	}

	it.each([
		"available",
		"missing",
		"closed",
		"caller-target",
		"same-generation-refresh",
		"wrong-id",
		"copied-path",
		"relative-path",
		"symlink-path",
		"id-only",
		"path-only",
	] as const)("checks the selected conversation before restarting over the real socket (%s)", async state => {
		activateGeneration(temp.path(), GEN_A);
		pointCurrent(temp.path(), state === "same-generation-refresh" ? GEN_A : GEN_B);
		const original = SessionManager.create(temp.path(), path.join(temp.path(), "selected-sessions"));
		original.appendMessage({ role: "user", content: "selected conversation", timestamp: 1 });
		await original.ensureOnDisk();
		const file = original.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const id = original.getSessionId();
		await original.close();
		const alias = path.join(temp.path(), "selected-journal.jsonl");
		await fs.promises.symlink(file, alias);
		const manager = await SessionManager.open(alias);
		const auth = await AuthStorage.create(":memory:");
		const registry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"), {
			ignoreLocalModelConfig: true,
		});
		const model = createMockModel({ responses: [] }).model;
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: registry,
		});
		const received: unknown[] = [];
		const endpointDir = path.join(temp.path(), "target-run");
		const served = await serveInteractiveSessionSocket({
			session,
			socket: createAgentSessionSocket(session, { endpointDir }),
			upgradeRuntime: (target?: unknown) => {
				received.push(target);
			},
		});
		let peer: natives.IpcConnection | undefined;
		let closing: Promise<void> | undefined;
		const lookupEntered = Promise.withResolvers<void>();
		const lookupRelease = Promise.withResolvers<void>();
		const lookupCompleted = Promise.withResolvers<void>();
		try {
			expect(session.sessionFile).toBe(alias);
			const feed = new FrameFeed();
			peer = await natives.IpcConnection.connect(path.join(endpointDir, `${id}.sock`), { framing: "lines" });
			peer.start(
				line => feed.push(JSON.parse(line) as Frame),
				() => {},
			);
			await feed.wait(frame => frame.type === "ready", 5000);
			const canonicalFile = await fs.promises.realpath(file);
			const copiedFile = path.join(temp.path(), "copied-journal.jsonl");
			if (state === "copied-path") await Bun.write(copiedFile, Bun.file(file));
			const callerTarget =
				state === "available" || state === "missing" || state === "closed"
					? {}
					: {
							...(state === "path-only"
								? {}
								: { expectedSessionId: state === "wrong-id" ? id.slice(0, 8) : id }),
							...(state === "id-only"
								? {}
								: {
										expectedSessionFile:
											state === "copied-path"
												? copiedFile
												: state === "relative-path"
													? path.relative(process.cwd(), canonicalFile)
													: state === "symlink-path"
														? alias
														: canonicalFile,
									}),
						};
			if (state === "missing") await fs.promises.unlink(file);
			if (state === "closed") {
				const realpath = fsPromises.realpath;
				function heldRealpath(
					input: fs.PathLike,
					options?: fs.ObjectEncodingOptions | BufferEncoding | null,
				): Promise<string>;
				function heldRealpath(input: fs.PathLike, options: fs.BufferEncodingOption): Promise<NonSharedBuffer>;
				async function heldRealpath(
					input: fs.PathLike,
					options?: fs.ObjectEncodingOptions | BufferEncoding | fs.BufferEncodingOption | null,
				): Promise<string | NonSharedBuffer> {
					lookupEntered.resolve();
					await lookupRelease.promise;
					const resolved =
						options === "buffer" || (typeof options === "object" && options?.encoding === "buffer")
							? await realpath(input, { encoding: "buffer" })
							: await realpath(input, options);
					lookupCompleted.resolve();
					return resolved;
				}
				vi.spyOn(fsPromises, "realpath").mockImplementationOnce(heldRealpath);
			}
			peer.send(
				JSON.stringify({
					id: "exact-target",
					type: "upgrade_runtime",
					...(state === "same-generation-refresh" ? { refresh: true } : {}),
					...callerTarget,
				}),
			);
			if (state === "closed") {
				await withTimeout(lookupEntered.promise, 5000, "restart target lookup did not start");
				closing = served.close();
				lookupRelease.resolve();
				await closing;
				await withTimeout(lookupCompleted.promise, 5000, "restart target lookup did not finish");
				await flushImmediate();
				await flushImmediate();
				expect(received).toEqual([]);
				return;
			}
			const response = await feed.wait(frame => frame.id === "exact-target", 5000);
			await flushImmediate();
			if (state === "missing") {
				expect(response).toMatchObject({ success: false, code: "session_target_unavailable" });
				expect(received).toEqual([]);
				expect(await Bun.file(file).exists()).toBe(false);
			} else if (state !== "available" && state !== "caller-target" && state !== "same-generation-refresh") {
				expect(response).toMatchObject({ success: false, code: "session_target_mismatch" });
				expect(received).toEqual([]);
				expect(await Bun.file(file).text()).toContain(id);
			} else {
				expect(response).toMatchObject({ success: true });
				expect(received).toEqual([{ sessionId: id, sessionFile: await fs.promises.realpath(file) }]);
			}
		} finally {
			lookupRelease.resolve();
			peer?.destroy();
			await (closing ?? served.close());
			await session.dispose();
			auth.close();
		}
	});

	it("refuses upgrade_runtime over the real socket while prompt setup owns an admitted submission", async () => {
		activateGeneration(temp.path(), GEN_A);
		pointCurrent(temp.path(), GEN_B);
		const auth = await AuthStorage.create(":memory:");
		const registry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"), { ignoreLocalModelConfig: true });
		const mock = createMockModel({ responses: [{ content: ["accepted input completed"] }] });
		const model = mock.model;
		vi.spyOn(registry, "getApiKey").mockResolvedValue("test-key");
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["test"], tools: [], messages: [] },
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(temp.path()),
			settings: Settings.isolated(),
			modelRegistry: registry,
		});
		const endpointDir = path.join(temp.path(), "run");
		const socket = createAgentSessionSocket(session, { endpointDir });
		const upgrade = vi.fn();
		const served = await serveInteractiveSessionSocket({ session, socket, upgradeRuntime: upgrade });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let submission: Promise<unknown> | undefined;
		let peer: natives.IpcConnection | undefined;
		try {
			const feed = new FrameFeed();
			peer = await natives.IpcConnection.connect(path.join(endpointDir, `${session.sessionId}.sock`), {
				framing: "lines",
			});
			peer.start(
				line => feed.push(JSON.parse(line) as Frame),
				() => {},
			);
			await feed.wait(frame => frame.type === "ready", 5000);
			session.setDeferredExtensionLoader(async () => {
				entered.resolve();
				await release.promise;
			});
			submission = session.prompt("hold this input during extension setup").catch(error => error);
			await withTimeout(entered.promise, 5000, "submission never entered deferred extension setup");
			expect(session.hasAdmittedSubmission).toBe(true);
			expect(session.isStreaming).toBe(false);
			expect(session.queuedMessageCount).toBe(0);

			peer.send(JSON.stringify({ id: "admitted-upgrade", type: "upgrade_runtime" }));
			const response = await feed.wait(frame => frame.id === "admitted-upgrade", 5000);
			expect(response).toMatchObject({ type: "response", success: false, code: "session_busy" });
			expect(upgrade).not.toHaveBeenCalled();
			release.resolve();
			expect(await submission).toBe(true);
			expect(session.hasAdmittedSubmission).toBe(false);
		} finally {
			if (submission) {
				release.resolve();
				await submission;
			}
			peer?.destroy();
			await served.close();
			await session.dispose();
			auth.close();
		}
	});

	it("preflights real owner work without restarting or treating unavailable inventories as idle", async () => {
		activateGeneration(temp.path(), GEN_A);
		pointCurrent(temp.path(), GEN_B);
		const auth = await AuthStorage.create(":memory:");
		const registry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"), { ignoreLocalModelConfig: true });
		const mock = createMockModel({ responses: [] });
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(temp.path()),
			settings: Settings.isolated(),
			modelRegistry: registry,
		});
		const endpointDir = path.join(temp.path(), "preflight-run");
		const upgrade = vi.fn();
		const served = await serveInteractiveSessionSocket({
			session,
			socket: createAgentSessionSocket(session, { endpointDir }),
			upgradeRuntime: upgrade,
		});
		let peer: natives.IpcConnection | undefined;
		try {
			const feed = new FrameFeed();
			peer = await natives.IpcConnection.connect(path.join(endpointDir, `${session.sessionId}.sock`), {
				framing: "lines",
			});
			peer.start(
				line => feed.push(JSON.parse(line) as Frame),
				() => {},
			);
			await feed.wait(frame => frame.type === "ready", 5000);
			session.agent.state.pendingToolCalls.add("in-flight-tool");
			peer.send(JSON.stringify({ id: "work-preflight", type: "get_refresh_preflight" }));
			const busy = await feed.wait(frame => frame.id === "work-preflight", 5000);
			expect(busy).toMatchObject({
				success: true,
				data: {
					sessionId: session.sessionId,
					ephemeralWork: {
						inFlightTools: 1,
						taskSubagents: null,
						backgroundJobs: null,
						services: null,
						hasEphemeralWork: true,
					},
				},
			});
			session.agent.state.pendingToolCalls.clear();
			peer.send(JSON.stringify({ id: "unknown-preflight", type: "get_refresh_preflight" }));
			const unknown = await feed.wait(frame => frame.id === "unknown-preflight", 5000);
			expect(unknown).toMatchObject({
				success: true,
				data: { ephemeralWork: { inFlightTools: 0, hasEphemeralWork: null } },
			});
			await flushImmediate();
			expect(upgrade).not.toHaveBeenCalled();
			expect(session.messages).toEqual([]);
		} finally {
			session.agent.state.pendingToolCalls.clear();
			peer?.destroy();
			await served.close();
			await session.dispose();
			auth.close();
		}
	});

	it("rearms a non-force upgrade rejected by late admission and retries only after settlement", async () => {
		activateGeneration(temp.path(), GEN_A);
		pointCurrent(temp.path(), GEN_B);
		const stub = stateSession();
		const upgrade = vi.fn<(target?: SessionRestartTarget, canRestart?: () => boolean) => void>();
		const harness = createRpcSurfaceHarness({ session: stub.session, upgradeRuntime: upgrade });
		try {
			await harness.handle({ id: "late-admission", type: "upgrade_runtime" });
			await flushImmediate();
			const firstAdmission = upgrade.mock.calls[0]?.[1];
			if (!firstAdmission) throw new Error("expected native final-admission check");
			Object.assign(harness.session, { isStreaming: true });
			expect(firstAdmission()).toBe(false);
			await flushImmediate();
			expect(upgrade).toHaveBeenCalledTimes(1);
			Object.assign(harness.session, { isStreaming: false });
			stub.emit({ type: "agent_end" });
			await flushImmediate();
			expect(upgrade).toHaveBeenCalledTimes(2);
			const nextAdmission = upgrade.mock.calls[1]?.[1];
			if (!nextAdmission) throw new Error("expected retried native admission");
			expect(nextAdmission()).toBe(true);
			expect(firstAdmission()).toBe(false);
		} finally {
			harness.dispose();
		}
	});

	it("restarts immediately on a settled session", async () => {
		activateGeneration(temp.path(), GEN_A);
		pointCurrent(temp.path(), GEN_B);
		const stub = stateSession();
		const upgrade = vi.fn();
		const harness = createRpcSurfaceHarness({ session: stub.session, upgradeRuntime: upgrade });
		try {
			const response = await harness.handle({ id: "upgrade", type: "upgrade_runtime" } as RpcCommand);
			expect(responseData(response)).toEqual({ upgraded: true, scheduled: false, running: GEN_A, current: GEN_B });
			expect(upgrade).not.toHaveBeenCalled();
			await flushImmediate();
			expect(upgrade).toHaveBeenCalledTimes(1);
		} finally {
			harness.dispose();
		}
	});
});

describe("InteractiveMode.restart across an in-place upgrade", () => {
	let authStorage: AuthStorage;
	let sessionManager: SessionManager;
	let session: AgentSession | undefined;
	let originalArgv: string[];

	const owner: SessionOwnerContext = { projectDir: "/tmp/owner-project", name: "owner", id: "owner-1" };

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: temp.path() });
		authStorage = await AuthStorage.create(path.join(temp.path(), "auth.db"));
		originalArgv = process.argv;
		sessionManager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
		consumeSessionOwnerContext({ [SESSION_OWNER_CONTEXT_ENV]: JSON.stringify(owner) });
		activateGeneration(temp.path(), GEN_A);
		pointCurrent(temp.path(), GEN_B);
	});

	afterEach(async () => {
		process.argv = originalArgv;
		resetSessionOwnerContextForTest();
		await session?.dispose();
		session = undefined;
		await sessionManager.close();
		authStorage.close();
	});

	async function restart(
		argv: string[],
		target?: SessionRestartTarget,
		options?: { viaRpc?: boolean; allowRefusal?: boolean },
	): Promise<readonly string[]> {
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});
		const mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = () => {};
		mode.ui.terminal.drainInput = async () => {};
		process.argv = [originalArgv[0], originalArgv[1], ...argv];
		const exec = vi.spyOn(natives, "execReplace").mockImplementation(() => undefined as never);
		const nativeSpawn = Bun.spawn;
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation((...args) => {
			if (!Array.isArray(args[0])) return nativeSpawn(args[0]);
			return { exited: Promise.resolve(0) } as never;
		});
		vi.spyOn(postmortem, "cleanup").mockResolvedValue();
		vi.spyOn(postmortem, "drainStdout").mockResolvedValue();
		vi.spyOn(postmortem, "quit").mockResolvedValue();
		if (options?.viaRpc) {
			let pendingRestart: Promise<void> | undefined;
			const socket = createAgentSessionSocket(session, { endpointDir: path.join(temp.path(), "restart-race-run") });
			const served = await serveInteractiveSessionSocket({
				session,
				socket,
				upgradeRuntime: (selected, canRestart?: () => boolean) => {
					pendingRestart = mode.restart(selected, canRestart);
				},
			});
			try {
				const response = await served.surface.handleCommand({ id: "probe-race", type: "upgrade_runtime" });
				expect(response).toMatchObject({ success: true });
				await flushImmediate();
				if (!pendingRestart) throw new Error("expected scheduled native restart");
				await pendingRestart;
			} finally {
				await served.close();
			}
		} else {
			await mode.restart(target);
		}
		const command =
			process.platform === "win32"
				? spawn.mock.calls.find(([command]) => Array.isArray(command))?.[0]
				: exec.mock.calls[0]?.[0];
		if (!Array.isArray(command) && options?.allowRefusal) return [];
		if (!Array.isArray(command)) throw new Error("expected replacement command");
		return command;
	}

	it("defers a non-force upgrade when work becomes active during receiver attestation", async () => {
		sessionManager.appendMessage({ role: "user", content: "original conversation", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected original journal");
		const before = await Bun.file(file).text();
		vi.spyOn(workerClient, "attestCliRestartReceiver").mockImplementation(async () => {
			if (!session) throw new Error("expected native session");
			session.agent.state.isStreaming = true;
			return { type: "restart_receiver", protocol: 1, nonce: "fixture", version: "fixture" };
		});
		vi.spyOn(InteractiveMode.prototype, "showWarning").mockImplementation(() => {});
		try {
			const command = await restart(["--model", "anthropic/claude-sonnet-4-5"], undefined, {
				viaRpc: true,
				allowRefusal: true,
			});
			expect(command).toEqual([]);
			expect(session?.isDisposed).toBe(false);
			expect(await Bun.file(file).text()).toBe(before);
		} finally {
			if (session) session.agent.state.isStreaming = false;
		}
	});

	it("keeps the owner route and resumes the journal on the upgraded generation", async () => {
		sessionManager.appendMessage({ role: "user", content: "saved request", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");

		const command = await restart(["--model", "anthropic/claude-sonnet-4-5"]);
		const upgradedEntry = generationEntry(temp.path(), GEN_B);

		if (process.platform === "win32") {
			expect(command[0]).toBe(process.execPath);
			return;
		}
		expect(command[0]).toBe("env");
		expect(command[1]).toBe(`${SESSION_OWNER_CONTEXT_ENV}=${JSON.stringify(owner)}`);
		expect(command[2]).toBe(`OMP_RUNNING_GENERATION_ENTRY=${upgradedEntry}`);
		const entryIndex = command.indexOf(upgradedEntry);
		expect(entryIndex).toBeGreaterThan(2);
		expect(command[entryIndex + 1]).toBe(SESSION_OWNER_WORKER_ARG);
		const restoreIndex = command.indexOf("--restore");
		expect(restoreIndex).toBeGreaterThan(entryIndex);
		expect(command[restoreIndex + 1]).toBe(path.resolve(file));

		const parsed = parseArgs(command.slice(command.indexOf("--model")));
		expect(parsed.model).toBe("anthropic/claude-sonnet-4-5");
		expect(parsed.restore).toBe(true);
		expect(parsed.resume).toBe(path.resolve(file));
	});

	it.skipIf(process.platform === "win32")(
		"carries the selected conversation through owner reentry into a strictly leased receiver",
		async () => {
			sessionManager.appendMessage({ role: "user", content: "original conversation", timestamp: 1 });
			await sessionManager.ensureOnDisk();
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("expected persisted journal");
			const target = { sessionId: sessionManager.getSessionId(), sessionFile: await fs.promises.realpath(file) };
			const command = await restart(["--model", "anthropic/claude-sonnet-4-5"], target);
			const context = command.find(arg => arg.startsWith(`${SESSION_OWNER_CONTEXT_ENV}=`));
			if (!context) throw new Error("expected carried owner context");
			consumeSessionOwnerContext({
				[SESSION_OWNER_CONTEXT_ENV]: context.slice(SESSION_OWNER_CONTEXT_ENV.length + 1),
			});
			const reopened = await createSessionManager(
				parseArgs(command.slice(command.indexOf("--model"))),
				temp.path(),
				Settings.isolated(),
			);
			if (!reopened) throw new Error("expected exact receiver");
			try {
				expect(reopened.getSessionId()).toBe(target.sessionId);
				expect(reopened.getSessionFile()).toBe(target.sessionFile);
				expect(reopened.hasSessionOwnership()).toBe(true);
				reopened.appendMessage({ role: "user", content: "continued conversation", timestamp: 2 });
				await reopened.flush();
				const journal = await Bun.file(file).text();
				expect(journal).toContain("original conversation");
				expect(journal).toContain("continued conversation");
				expect(reopened.getSessionFile()).toBe(file);
			} finally {
				await reopened.close();
			}
		},
	);
});

type Frame = Record<string, unknown> & { type?: string; id?: string; success?: boolean };

interface Waiter {
	predicate: (frame: Frame) => boolean;
	resolve: (frame: Frame) => void;
}

class FrameFeed {
	readonly frames: Frame[] = [];
	readonly #waiters: Waiter[] = [];

	push(frame: Frame): void {
		this.frames.push(frame);
		for (const waiter of Array.from(this.#waiters)) {
			if (!waiter.predicate(frame)) continue;
			this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
			waiter.resolve(frame);
		}
	}

	wait(predicate: (frame: Frame) => boolean, timeoutMs: number): Promise<Frame> {
		const existing = this.frames.find(predicate);
		if (existing) return Promise.resolve(existing);
		const { promise, resolve } = Promise.withResolvers<Frame>();
		const waiter: Waiter = { predicate, resolve };
		this.#waiters.push(waiter);
		const pending = withTimeout(promise, timeoutMs, `timed out; saw ${JSON.stringify(this.frames.slice(-8))}`);
		return pending.finally(() => {
			const index = this.#waiters.indexOf(waiter);
			if (index !== -1) this.#waiters.splice(index, 1);
		});
	}
}

async function flushImmediate(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

/** Publication files land after the owner reports ready; poll without a wall-clock delay. */
async function waitForPublication(runDir: string): Promise<string> {
	for (let attempt = 0; attempt < 2_000; attempt++) {
		const names = await fs.promises.readdir(runDir).catch(() => [] as string[]);
		const name = names.find(entry => entry.endsWith(".json") && !entry.startsWith("bridge-"));
		if (name) return path.join(runDir, name);
		await flushImmediate();
	}
	throw new Error(`no session publication appeared in ${runDir}`);
}

function generationFields(frame: Frame): unknown {
	const data = frame.data;
	if (!isRecord(data)) return undefined;
	return data.generation;
}

describe("brokered owner upgrade end to end", () => {
	it("re-executes in place onto generations/current with the same pid and session", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-generation-upgrade-"));
		const home = path.join(root, "home");
		const agentDir = path.join(home, ".omp/agent");
		const runDir = path.join(root, "run");
		const brokersRoot = path.join(home, ".omp", "run", "daemons");
		const stderrPath = path.join(root, "bridge-stderr.log");
		const project = path.join(root, "project");
		await fs.promises.mkdir(agentDir, { recursive: true });
		await fs.promises.mkdir(project, { recursive: true });
		await Bun.write(path.join(agentDir, "config.yml"), "setupVersion: 99\n");
		createGenerations(root);
		// A restart only resumes a journal that is already on disk; seed one so the
		// re-executed owner keeps the same session id (and therefore socket path).
		const seeded = SessionManager.create(project, path.join(agentDir, "sessions"));
		seeded.appendMessage({ role: "user", content: "seeded request", timestamp: 1 });
		await seeded.ensureOnDisk();
		const seededFile = seeded.getSessionFile();
		await seeded.close();
		if (!seededFile) throw new Error("expected a seeded session file");
		const env = {
			PATH: process.env.PATH ?? "",
			HOME: home,
			USERPROFILE: home,
			TMPDIR: os.tmpdir(),
			PI_CODING_AGENT_DIR: agentDir,
			PI_NO_TITLE: "1",
			NO_COLOR: "1",
			OMP_RUN_DIR: runDir,
			OMP_GENERATION_LINK: path.join(root, GENERATIONS, CURRENT),
			OMP_RUNNING_GENERATION_ENTRY: generationEntry(root, GEN_A),
		};
		const child = Bun.spawn(
			[
				process.execPath,
				CLI,
				"--mode",
				"rpc",
				"--resume",
				seededFile,
				"--model",
				"claude-sonnet-4-5",
				"--no-extensions",
			],
			{ cwd: project, env, stdin: "pipe", stdout: "pipe", stderr: Bun.file(stderrPath) },
		);
		const feed = new FrameFeed();
		void (async () => {
			for await (const frame of readJsonl<unknown>(child.stdout)) {
				if (isRecord(frame)) feed.push(frame as Frame);
			}
			feed.push({ type: "__bridge_exit", code: child.exitCode });
		})();
		const write = (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			child.stdin.flush();
		};
		let ownerPid: number | undefined;
		let sessionId: string | undefined;
		let failure: unknown;
		try {
			await feed.wait(() => feed.frames.some(frame => frame.type === "ready"), 90_000);
			write({ id: "state-a", type: "get_state" });
			const stateA = await feed.wait(frame => frame.type === "response" && frame.id === "state-a", 20_000);
			expect(stateA.success).toBe(true);
			expect(generationFields(stateA)).toEqual({ running: GEN_A, current: GEN_A, behind: false });

			const publicationPath = await waitForPublication(runDir);
			const publication = JSON.parse(await fs.promises.readFile(publicationPath, "utf8")) as {
				pid: number;
				sessionId: string;
				generation?: string;
			};
			ownerPid = publication.pid;
			sessionId = publication.sessionId;
			expect(publication.generation).toBe(GEN_A);
			expect(ownerPid).not.toBe(child.pid);

			pointCurrent(root, GEN_B);
			write({ id: "state-b", type: "get_state" });
			const stateB = await feed.wait(frame => frame.type === "response" && frame.id === "state-b", 20_000);
			expect(generationFields(stateB)).toEqual({ running: GEN_A, current: GEN_B, behind: true });

			write({
				id: "upgrade",
				type: "upgrade_runtime",
				expectedSessionId: sessionId,
				expectedSessionFile: await fs.promises.realpath(seededFile),
			});
			const upgraded = await feed.wait(frame => frame.type === "response" && frame.id === "upgrade", 20_000);
			expect(upgraded.success).toBe(true);
			expect(responseData(upgraded as RpcResponse)).toMatchObject({
				upgraded: true,
				scheduled: false,
				running: GEN_A,
				current: GEN_B,
			});

			let after: Frame | undefined;
			const deadline = Date.now() + 25_000;
			for (let attempt = 0; Date.now() < deadline; attempt++) {
				write({ id: `state-after-${attempt}`, type: "get_state" });
				try {
					const frame = await feed.wait(
						item => item.type === "response" && item.id === `state-after-${attempt}`,
						5_000,
					);
					if (frame.success === true && isRecord(frame.data)) {
						const generation = frame.data.generation;
						if (isRecord(generation) && generation.running === GEN_B) {
							after = frame;
							break;
						}
					}
				} catch {
					// The bridge is reconnecting across the owner exec; retry.
				}
				await Bun.sleep(100);
			}
			if (!after) {
				const publication = await fs.promises
					.readFile(path.join(runDir, `${sessionId}.json`), "utf8")
					.catch(error => `unreadable: ${String(error)}`);
				const listing = await fs.promises.readdir(runDir).catch(error => [`unreadable: ${String(error)}`]);
				const frames = feed.frames
					.slice(-8)
					.map(frame =>
						JSON.stringify({
							type: frame.type,
							id: frame.id,
							success: frame.success,
							code: frame.code,
							generation: generationFields(frame),
						}),
					)
					.join("\n");
				throw new Error(
					`owner never reported genB; runDir=${listing.join(",")}; publication=${publication}; ` +
						`stderr=${await Bun.file(stderrPath).slice(-1500).text()}; frames=${frames}`,
				);
			}
			expect(generationFields(after)).toEqual({ running: GEN_B, current: GEN_B, behind: false });
			expect(isRecord(after.data) ? after.data.sessionId : undefined).toBe(sessionId);

			const republished = JSON.parse(await fs.promises.readFile(path.join(runDir, `${sessionId}.json`), "utf8")) as {
				pid: number;
				sessionId: string;
				generation?: string;
			};
			expect(republished.pid).toBe(ownerPid);
			expect(republished.sessionId).toBe(sessionId);
			expect(republished.generation).toBe(GEN_B);
			write({ id: "history-after", type: "get_entries" });
			const history = await feed.wait(frame => frame.type === "response" && frame.id === "history-after", 20_000);
			expect(history.success).toBe(true);
			expect(isRecord(history.data) ? JSON.stringify(history.data.entries) : "").toContain("seeded request");
		} catch (error) {
			failure = error;
			const diagnostics = await Bun.file(stderrPath)
				.slice(-1500)
				.text()
				.catch(() => "stderr unavailable");
			throw new Error(`private restart fixture ${root}: ${String(error)}; stderr=${diagnostics}`, { cause: error });
		} finally {
			child.kill();
			await withTimeout(child.exited, 5_000, `private bridge did not exit; fixture retained at ${root}`);
			try {
				const names = await fs.promises.readdir(brokersRoot).catch((error: unknown) => {
					if (isEnoent(error)) return [];
					throw error;
				});
				for (const name of names) {
					const runtimeDir = path.join(brokersRoot, name);
					const scope: unknown = await Bun.file(path.join(runtimeDir, "scope.json")).json();
					if (!isRecord(scope) || scope.projectDir !== (await fs.promises.realpath(project))) {
						throw new Error("private broker scope does not match the fixture project");
					}
					const client = await withTimeout(
						createDaemonBrokerClient(project, { runtimeDir, existingOnly: true }),
						5_000,
						"private broker connection timed out",
					);
					try {
						const listed = await withTimeout(
							client.request({ op: "list" }),
							5_000,
							"private broker list timed out",
						);
						if (listed.op !== "list") throw new Error("unexpected private broker list result");
						for (const daemon of listed.daemons) {
							if (failure !== undefined) {
								try {
									const logs = await withTimeout(
										client.request({
											op: "logs",
											name: daemon.name,
											lines: 30,
											head: false,
											grep: "Restart|restart|refused|error",
											follow: false,
											timeoutMs: 1_000,
										}),
										5_000,
										"private owner warning capture timed out",
									);
									if (logs.op === "logs") {
										await Bun.write(path.join(root, `owner-warnings-${daemon.id}.log`), logs.text);
									}
								} catch (error) {
									await Bun.write(
										path.join(root, `owner-warning-error-${daemon.id}.log`),
										String(error),
									).catch(() => 0);
								}
							}
							const stopped = await withTimeout(
								client.request({ op: "stop", name: daemon.name, id: daemon.id, timeoutMs: 5_000 }),
								10_000,
								"private owner stop timed out",
							);
							if (stopped.op !== "stop") throw new Error("unexpected private broker stop result");
							expect(stopped.daemon.id).toBe(daemon.id);
							expect(["exited", "failed", "stopped"]).toContain(stopped.daemon.state);
							await Bun.write(
								path.join(root, `owner-cleanup-${daemon.id}.json`),
								JSON.stringify({ id: stopped.daemon.id, state: stopped.daemon.state }),
							);
						}
						await withTimeout(client.request({ op: "shutdown" }), 5_000, "private broker shutdown timed out");
					} finally {
						client.close();
					}
				}
			} catch (cleanupError) {
				throw new AggregateError(
					[failure, cleanupError].filter(error => error !== undefined),
					`private broker cleanup failed; fixture retained at ${root}`,
				);
			}
			if (failure === undefined) await fs.promises.rm(root, { recursive: true, force: true });
		}
	}, 240_000);
});
