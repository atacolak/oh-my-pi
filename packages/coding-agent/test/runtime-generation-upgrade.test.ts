import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { SESSION_OWNER_WORKER_ARG } from "@oh-my-pi/pi-coding-agent/cli/worker-selectors";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	consumeSessionOwnerContext,
	resetSessionOwnerContextForTest,
	SESSION_OWNER_CONTEXT_ENV,
	type SessionOwnerContext,
} from "@oh-my-pi/pi-coding-agent/launch/session-owner";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as natives from "@oh-my-pi/pi-natives";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { isRecord, postmortem, readJsonl, TempDir, withTimeout } from "@oh-my-pi/pi-utils";
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

	async function restart(argv: string[]): Promise<readonly string[]> {
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
		const spawn = vi.spyOn(Bun, "spawn").mockReturnValue({ exited: Promise.resolve(0) } as never);
		vi.spyOn(postmortem, "cleanup").mockResolvedValue();
		vi.spyOn(postmortem, "drainStdout").mockResolvedValue();
		vi.spyOn(postmortem, "quit").mockResolvedValue();
		await mode.restart();
		const command = process.platform === "win32" ? spawn.mock.calls[0]?.[0] : exec.mock.calls[0]?.[0];
		if (!Array.isArray(command)) throw new Error("expected replacement command");
		return command;
	}

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
		const resumeIndex = command.indexOf("--resume");
		expect(resumeIndex).toBeGreaterThan(entryIndex);
		expect(command[resumeIndex + 1]).toBe(path.resolve(file));

		const parsed = parseArgs(command.slice(command.indexOf("--model")));
		expect(parsed.model).toBe("anthropic/claude-sonnet-4-5");
		expect(parsed.resume).toBe(path.resolve(file));
	});
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
		const daemonDir = path.join(root, "daemons");
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
			OMP_DAEMON_RUNTIME_DIR: daemonDir,
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
			{ cwd: project, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		const feed = new FrameFeed();
		const stderr = new Response(child.stderr).text();
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

			write({ id: "upgrade", type: "upgrade_runtime" });
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
			}
			if (!after) {
				const publication = await fs.promises
					.readFile(path.join(runDir, `${sessionId}.json`), "utf8")
					.catch(error => `unreadable: ${String(error)}`);
				const listing = await fs.promises.readdir(runDir).catch(error => [`unreadable: ${String(error)}`]);
				const frames = feed.frames
					.slice(-8)
					.map(frame => JSON.stringify(frame))
					.join("\n");
				throw new Error(
					`owner never reported genB; runDir=${listing.join(",")}; publication=${publication}; ` +
						`stderr=${(await stderr).slice(-1500)}; frames=${frames}`,
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
		} finally {
			child.kill();
			await child.exited.catch(() => {});
			if (ownerPid !== undefined) {
				try {
					process.kill(ownerPid, "SIGTERM");
				} catch {}
			}
			for (const name of await fs.promises.readdir(path.join(runDir, "daemons")).catch(() => [] as string[])) {
				try {
					const pid = Number(
						(await fs.promises.readFile(path.join(runDir, "daemons", name, "broker.pid"), "utf8")).trim(),
					);
					if (Number.isInteger(pid)) process.kill(pid, "SIGTERM");
				} catch {}
			}
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	}, 180_000);
});
