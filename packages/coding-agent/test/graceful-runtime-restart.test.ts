import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { type AsyncJob, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRuntimeUpgrade } from "@oh-my-pi/pi-coding-agent/modes/rpc/model-runtime-upgrade";
import {
	GracefulRestartResults,
	getRpcRefreshPreflight,
	getRpcRuntimeRestartReceipt,
	isGracefulRestartSettled,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-refresh-preflight";
import { serveInteractiveSessionSocket } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-command-surface";
import { createAgentSessionSocket } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-socket";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { systemPromptDigest } from "@oh-my-pi/pi-coding-agent/session/session-tools";
import { isRecord, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const GENERATION = "a".repeat(40);
let temp: TempDir;
let auth: AuthStorage;
let session: AgentSession | undefined;
let borrowedJobs: AsyncJobManager | undefined;

beforeEach(async () => {
	temp = TempDir.createSync("@omp-graceful-restart-");
	auth = await AuthStorage.create(":memory:");
});

afterEach(async () => {
	vi.restoreAllMocks();
	await session?.dispose();
	session = undefined;
	await borrowedJobs?.dispose();
	borrowedJobs = undefined;
	auth.close();
	temp.removeSync();
});

async function makeSession(adapter: ModelRuntimeUpgrade, retentionMs?: number) {
	const registry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"), { ignoreLocalModelConfig: true });
	const model = createMockModel({ handler: { content: ["checkpoint saved"] } });
	vi.spyOn(registry, "getApiKey").mockResolvedValue("test-key");
	const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
	manager.appendMessage({ role: "user", content: "original conversation", timestamp: 1 });
	await manager.ensureOnDisk();
	if (retentionMs !== undefined) borrowedJobs = new AsyncJobManager({ retentionMs });
	const created = await createAgentSession({
		cwd: temp.path(),
		agentDir: path.join(temp.path(), "agent"),
		authStorage: auth,
		modelRegistry: registry,
		model: model.model,
		sessionManager: manager,
		customTools: [adapter.tool],
		...(borrowedJobs ? { parentTaskPrefix: "Main", agentId: "Main", asyncJobManager: borrowedJobs } : {}),
		settings: Settings.isolated({ "bash.autoBackground.enabled": true, "compaction.enabled": false }),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	session = created.session;
	session.agent.streamFn = model.stream;
	return { session, manager, model };
}

async function tick(): Promise<void> {
	const done = Promise.withResolvers<void>();
	setImmediate(done.resolve);
	await done.promise;
}

describe("graceful runtime restart", () => {
	it("keeps unknown inventories blocked while external services remain explicitly uninspected", async () => {
		const adapter = new ModelRuntimeUpgrade();
		const { session } = await makeSession(adapter);
		const observed = getRpcRefreshPreflight(session);
		expect(isGracefulRestartSettled(observed)).toBe(true);
		expect(observed.ephemeralWork).toMatchObject({
			services: null,
			servicesUninspected: true,
			hasEphemeralWork: null,
		});
		for (const field of ["inFlightTools", "taskSubagents", "backgroundJobs"] as const) {
			expect(
				isGracefulRestartSettled({ ...observed, ephemeralWork: { ...observed.ephemeralWork, [field]: null } }),
			).toBe(false);
			expect(
				isGracefulRestartSettled({ ...observed, ephemeralWork: { ...observed.ephemeralWork, [field]: 1 } }),
			).toBe(false);
		}
		for (const field of ["streaming", "admittedSubmission", "compacting"] as const) {
			expect(
				isGracefulRestartSettled({ ...observed, ephemeralWork: { ...observed.ephemeralWork, [field]: true } }),
			).toBe(false);
		}
	});

	it.each([
		"available",
		"missing-restart-route",
		"missing-model-tool",
		"released-journal",
		"unmanaged-entry",
	] as const)("advertises graceful restart only for an owned native-capable conversation: %s", async state => {
		const adapter = new ModelRuntimeUpgrade();
		const { session, manager } = await makeSession(adapter);
		const runningEntry = path.join(temp.path(), "generations", GENERATION, "cli.ts");
		await Bun.write(runningEntry, "// private generation fixture\n");
		await fs.symlink(path.dirname(runningEntry), path.join(temp.path(), "generations", "current"));
		if (state === "released-journal") await manager.close();
		const upgrade = vi.fn();
		const send = vi.spyOn(session, "sendCustomMessage");
		const served = await serveInteractiveSessionSocket({
			session,
			socket: createAgentSessionSocket(session, { endpointDir: path.join(temp.path(), "run") }),
			...(state === "missing-restart-route" ? {} : { upgradeRuntime: upgrade }),
			...(state === "missing-model-tool" ? {} : { modelRuntimeUpgrade: adapter }),
		});
		const previousEntry = process.env.OMP_RUNNING_GENERATION_ENTRY;
		const previousLink = process.env.OMP_GENERATION_LINK;
		process.env.OMP_RUNNING_GENERATION_ENTRY =
			state === "unmanaged-entry" ? path.join(temp.path(), "cli.ts") : runningEntry;
		process.env.OMP_GENERATION_LINK = path.join(temp.path(), "generations", "current");
		try {
			expect(await served.surface.handleCommand({ type: "get_refresh_preflight" })).toMatchObject({
				success: true,
				data: {
					refreshModes: { graceful: state === "available", force: false },
					ephemeralWork: { services: null, servicesUninspected: true, hasEphemeralWork: null },
				},
			});
			expect(upgrade).not.toHaveBeenCalled();
			expect(send).not.toHaveBeenCalled();
		} finally {
			await served.close();
			if (previousEntry === undefined) delete process.env.OMP_RUNNING_GENERATION_ENTRY;
			else process.env.OMP_RUNNING_GENERATION_ENTRY = previousEntry;
			if (previousLink === undefined) delete process.env.OMP_GENERATION_LINK;
			else process.env.OMP_GENERATION_LINK = previousLink;
		}
	});

	it.each(["bash", "task", "watched", "expired", "already-finished", "later-foreground-turn"] as const)(
		"checkpoints and preserves %s job results before restart",
		async jobType => {
			const adapter = new ModelRuntimeUpgrade();
			const { session, manager } = await makeSession(adapter, jobType === "expired" ? 0 : undefined);
			const file = manager.getSessionFile();
			if (!file) throw new Error("expected persisted session");
			const runningEntry = path.join(temp.path(), "generations", GENERATION, "cli.ts");
			await Bun.write(runningEntry, "// private generation fixture\n");
			await fs.symlink(path.dirname(runningEntry), path.join(temp.path(), "generations", "current"));
			const jobs = session.asyncJobManager;
			if (!jobs) throw new Error("expected owning async job manager");
			const release = Promise.withResolvers<string>();
			const jobId = jobs.register(
				jobType === "task" ? "task" : "bash",
				"finish existing work",
				async () => release.promise,
				{ ownerId: "Main" },
			);
			if (jobType === "watched" || jobType === "expired") jobs.watchJobs([jobId]);
			if (jobType === "already-finished") {
				release.resolve("existing work completed");
				await jobs.waitForAll();
				await jobs.drainDeliveries();
				await session.waitForIdle();
				await tick();
			}
			const entered = Promise.withResolvers<void>();
			const allowCheckpoint = Promise.withResolvers<void>();
			const laterEntered = Promise.withResolvers<void>();
			const allowLaterTurn = Promise.withResolvers<void>();
			let acknowledged = false;
			const mock = createMockModel({
				handler: async context => {
					const text = JSON.stringify(context.messages);
					const request = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
					if (request && !acknowledged) {
						entered.resolve();
						await allowCheckpoint.promise;
						acknowledged = true;
						return { content: [{ type: "toolCall", name: "upgrade_runtime", arguments: { request } }] };
					}
					if (text.includes("later foreground input")) {
						laterEntered.resolve();
						await allowLaterTurn.promise;
					}
					return { content: ["checkpoint saved"] };
				},
			});
			session.agent.streamFn = mock.stream;
			const called = Promise.withResolvers<void>();
			const upgrade = vi.fn(() => called.resolve());
			const served = await serveInteractiveSessionSocket({
				session,
				socket: createAgentSessionSocket(session, { endpointDir: path.join(temp.path(), "run") }),
				upgradeRuntime: upgrade,
				modelRuntimeUpgrade: adapter,
			});
			const previousEntry = process.env.OMP_RUNNING_GENERATION_ENTRY;
			const previousLink = process.env.OMP_GENERATION_LINK;
			process.env.OMP_RUNNING_GENERATION_ENTRY = runningEntry;
			process.env.OMP_GENERATION_LINK = path.join(temp.path(), "generations", "current");
			try {
				const response = await served.surface.handleCommand({
					type: "upgrade_runtime",
					graceful: true,
					expectedSessionId: session.sessionId,
					expectedSessionFile: await fs.realpath(file),
				});
				expect(response).toMatchObject({
					success: true,
					data: { upgraded: false, scheduled: true, reason: "checkpoint_requested" },
				});
				await withTimeout(entered.promise, 5000, "model did not receive checkpoint request");
				expect(upgrade).not.toHaveBeenCalled();
				if (jobType === "already-finished") {
					allowCheckpoint.resolve();
					await withTimeout(called.promise, 5000, "checkpoint completion did not wake graceful restart");
					expect(upgrade).toHaveBeenCalledTimes(1);
					await manager.flush();
					expect(await Bun.file(file).text()).toContain("existing work completed");
					return;
				}
				if (jobType === "expired") {
					release.resolve("expired undelivered output");
					await jobs.waitForAll();
					expect(jobs.getJob(jobId)).toBeUndefined();
					allowCheckpoint.resolve();
					await session.waitForIdle();
					expect(
						session.messages.filter(
							message => message.role === "toolResult" && message.toolName === "upgrade_runtime",
						),
					).toMatchObject([{ isError: false }]);
					await tick();
					await tick();
					expect(getRpcRefreshPreflight(session).ephemeralWork).toMatchObject({
						streaming: false,
						admittedSubmission: false,
						compacting: false,
						inFlightTools: 0,
						taskSubagents: 0,
						backgroundJobs: 0,
					});
					expect(upgrade).not.toHaveBeenCalled();
					expect(await Bun.file(file).text()).not.toContain("expired undelivered output");
					return;
				}
				allowCheckpoint.resolve();
				await session.waitForIdle();
				await tick();
				expect(upgrade).not.toHaveBeenCalled();
				expect(jobs.getJob(jobId)?.status).toBe("running");
				const tool = session.getToolByName("upgrade_runtime");
				if (!tool) throw new Error("expected model restart tool");
				await expect(tool.execute("stale-request", { request: "obsolete" })).rejects.toThrow(
					"matching restart request",
				);
				if (jobType === "later-foreground-turn") {
					const laterTurn = session.prompt("later foreground input");
					try {
						await withTimeout(laterEntered.promise, 5000, "later foreground turn did not start");
						release.resolve("existing work completed");
						await jobs.waitForAll();
						await tick();
						expect(upgrade).not.toHaveBeenCalled();
					} finally {
						allowLaterTurn.resolve();
						await laterTurn;
					}
					await withTimeout(called.promise, 1000, "restart did not wake after later foreground turn");
					expect(upgrade).toHaveBeenCalledTimes(1);
					return;
				}
				release.resolve("existing work completed");
				if (jobType === "watched") {
					await jobs.waitForAll();
					await tick();
					await tick();
					expect(upgrade).not.toHaveBeenCalled();
					expect(await Bun.file(file).text()).not.toContain("existing work completed");
					jobs.unwatchJobs([jobId]);
				}
				await withTimeout(called.promise, 10000, "restart did not resume after work settled");
				expect(upgrade).toHaveBeenCalledTimes(1);
				expect(jobs.getJob(jobId)?.status).toBe("completed");
				await manager.flush();
				const journal = await Bun.file(file).text();
				expect(journal).toContain("original conversation");
				expect(journal).toContain("checkpoint saved");
				expect(journal).toContain("existing work completed");
			} finally {
				release.resolve("cleanup");
				allowCheckpoint.resolve();
				allowLaterTurn.resolve();
				await served.close();
				if (previousEntry === undefined) delete process.env.OMP_RUNNING_GENERATION_ENTRY;
				else process.env.OMP_RUNNING_GENERATION_ENTRY = previousEntry;
				if (previousLink === undefined) delete process.env.OMP_GENERATION_LINK;
				else process.env.OMP_GENERATION_LINK = previousLink;
			}
		},
		30000,
	);
	it("does not let a delivered reused job id release an expired incarnation's unsaved result", async () => {
		const { session, manager } = await makeSession(new ModelRuntimeUpgrade(), 0);
		const jobs = session.asyncJobManager;
		if (!jobs) throw new Error("expected async manager");
		const fence = new GracefulRestartResults(session);
		const incarnations: AsyncJob[] = [];
		const unsubscribe = jobs.onJobSettled(() => {
			const job = jobs.getJob("reused");
			if (job) incarnations.push(job);
		});
		const release = Promise.withResolvers<string>();
		try {
			const id = jobs.register("bash", "first incarnation", async () => release.promise, {
				id: "reused",
				ownerId: "Main",
			});
			jobs.watchJobs([id]);
			release.resolve("old unsaved result");
			await jobs.waitForAll();
			expect(jobs.getJob(id)).toBeUndefined();
			expect(fence.areConsumed()).toBe(false);
			const nextId = jobs.publishCompleted(
				"bash",
				"second incarnation",
				{ text: "new saved result" },
				{ id, ownerId: "Main" },
			);
			expect(nextId).toBe(id);
			await jobs.drainDeliveries();
			await session.waitForIdle();
			await manager.flush();
			const [first, second] = incarnations;
			if (!first || !second) throw new Error("expected both settled incarnations");
			expect(jobs.isJobResultConsumed(id, first)).toBe(false);
			expect(jobs.isJobResultConsumed(id, second)).toBe(true);
			expect(fence.areConsumed()).toBe(false);
			const file = manager.getSessionFile();
			if (!file) throw new Error("expected journal");
			const journal = await Bun.file(file).text();
			expect(journal).toContain("new saved result");
			expect(journal).not.toContain("old unsaved result");
		} finally {
			release.resolve("cleanup");
			unsubscribe();
			fence.dispose();
		}
	});

	it.each(["reused-id", "same-id"] as const)(
		"does not falsely consume an in-flight result under a %s watch",
		async mode => {
			const deliveryFinished = Promise.withResolvers<void>();
			const registerSink = AsyncJobManager.prototype.registerDeliverySink;
			vi.spyOn(AsyncJobManager.prototype, "registerDeliverySink").mockImplementation(
				function (this: AsyncJobManager, ownerId, sink) {
					return registerSink.call(this, ownerId, async (id, text, job) => {
						try {
							return await sink(id, text, job);
						} finally {
							deliveryFinished.resolve();
						}
					});
				},
			);
			const { session, manager } = await makeSession(new ModelRuntimeUpgrade(), mode === "reused-id" ? 0 : 60_000);
			const jobs = borrowedJobs;
			if (!jobs) throw new Error("expected retained async manager");
			const fence = new GracefulRestartResults(session);
			const formatting = Promise.withResolvers<void>();
			const allowFormat = Promise.withResolvers<void>();
			const allowNewJob = Promise.withResolvers<string>();
			const allocate = manager.allocateArtifactPath.bind(manager);
			vi.spyOn(manager, "allocateArtifactPath").mockImplementation(async (...args) => {
				formatting.resolve();
				await allowFormat.promise;
				return allocate(...args);
			});
			try {
				const id = jobs.publishCompleted(
					"bash",
					"old in-flight incarnation",
					{ text: "old in-flight output\n".repeat(5000) },
					{ id: "reused-in-flight", ownerId: "Main" },
				);
				await withTimeout(formatting.promise, 5000, "old result did not enter formatting");
				expect(jobs.getJob(id) === undefined).toBe(mode === "reused-id");
				expect(fence.areConsumed()).toBe(false);
				if (mode === "reused-id") {
					jobs.register("bash", "new watched incarnation", async () => allowNewJob.promise, {
						id,
						ownerId: "Main",
					});
				}
				jobs.watchJobs([id]);
				allowFormat.resolve();
				await withTimeout(deliveryFinished.promise, 5000, "old result delivery did not settle");
				await tick();
				if (mode === "same-id") {
					await manager.flush();
					expect(jobs.isJobResultConsumed(id)).toBe(false);
					expect(fence.areConsumed()).toBe(false);
					const file = manager.getSessionFile();
					if (!file) throw new Error("expected journal");
					expect(await Bun.file(file).text()).not.toContain("old in-flight output");
				}
				jobs.unwatchJobs([id]);
				allowNewJob.resolve("new incarnation output");
				await jobs.waitForAll();
				await jobs.drainDeliveries();
				await session.waitForIdle();
				await manager.flush();
				expect(fence.areConsumed()).toBe(true);
				const file = manager.getSessionFile();
				if (!file) throw new Error("expected journal");
				const journal = await Bun.file(file).text();
				if (mode === "reused-id") expect(journal).toContain("new incarnation output");
				expect(journal).toContain("old in-flight output");
			} finally {
				allowFormat.resolve();
				allowNewJob.resolve("cleanup");
				fence.dispose();
			}
		},
	);

	it("recognizes a late result delivered after immediate retention expiry without blocking a safe restart", async () => {
		const { session, manager } = await makeSession(new ModelRuntimeUpgrade(), 0);
		const jobs = session.asyncJobManager;
		if (!jobs) throw new Error("expected async manager");
		const fence = new GracefulRestartResults(session);
		try {
			const id = jobs.publishCompleted(
				"bash",
				"late completion",
				{ text: "durable late result" },
				{ ownerId: "Main" },
			);
			expect(jobs.getJob(id)).toBeUndefined();
			expect(fence.areConsumed()).toBe(false);
			await jobs.drainDeliveries();
			await session.waitForIdle();
			await manager.flush();
			expect(fence.areConsumed()).toBe(true);
			const file = manager.getSessionFile();
			if (!file) throw new Error("expected journal");
			expect(await Bun.file(file).text()).toContain("durable late result");
		} finally {
			fence.dispose();
		}
	});

	it("returns canonical loaded-owner evidence and refuses a released journal owner", async () => {
		const { session, manager } = await makeSession(new ModelRuntimeUpgrade());
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected journal");
		const receipt = await getRpcRuntimeRestartReceipt(session);
		expect(receipt).toMatchObject({
			sessionId: session.sessionId,
			sessionFile: await fs.realpath(file),
			basePromptDigest: systemPromptDigest(session.baseSystemPrompt),
		});
		await manager.close();
		expect(await getRpcRuntimeRestartReceipt(session)).toBeNull();
	});

	it("keeps imported code identity fixed when selection changes and creates a fresh identity on the next boot", async () => {
		const root = temp.path();
		const modulePath = path.join(root, "generations", GENERATION, "runtime-generation.ts");
		const source = new URL(import.meta.resolve("@oh-my-pi/pi-coding-agent/launch/runtime-generation"));
		await Bun.write(modulePath, Bun.file(source));
		await fs.symlink(path.resolve(import.meta.dir, "../../../node_modules"), path.join(root, "node_modules"), "dir");
		const entry = path.join(path.dirname(modulePath), "probe.ts");
		await Bun.write(
			entry,
			[
				'import { readRuntimeBootIdentity } from "./runtime-generation.ts";',
				"const before = readRuntimeBootIdentity();",
				`process.env.OMP_RUNNING_GENERATION_ENTRY = ${JSON.stringify(path.join(root, "generations", "b".repeat(40), "cli.ts"))};`,
				"console.log(JSON.stringify({ before, after: readRuntimeBootIdentity() }));",
			].join("\n"),
		);
		const results: Array<{ bootId: string }> = [];
		for (let run = 0; run < 2; run++) {
			const child = Bun.spawn([process.execPath, entry], {
				cwd: root,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					HCOM_PROCESS_ID: undefined,
					HCOM_INSTANCE_NAME: undefined,
					OMP_SESSION_OWNER_CONTEXT: undefined,
				},
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
			const output: unknown = JSON.parse(stdout);
			if (!isRecord(output) || !isRecord(output.before) || typeof output.before.bootId !== "string") {
				throw new Error("invalid boot receipt");
			}
			expect(output.after).toEqual(output.before);
			expect(output.before.importedGeneration).toBe(GENERATION);
			results.push({ bootId: output.before.bootId });
		}
		expect(results[0]?.bootId).not.toBe(results[1]?.bootId);
	});

	it("refuses forced graceful restart before sending model input", async () => {
		const adapter = new ModelRuntimeUpgrade();
		const { session } = await makeSession(adapter);
		const send = vi.spyOn(session, "sendCustomMessage");
		const upgrade = vi.fn();
		const served = await serveInteractiveSessionSocket({
			session,
			socket: createAgentSessionSocket(session, { endpointDir: path.join(temp.path(), "run") }),
			upgradeRuntime: upgrade,
			modelRuntimeUpgrade: adapter,
		});
		try {
			const response = await served.surface.handleCommand({ type: "upgrade_runtime", graceful: true, force: true });
			expect(response).toMatchObject({ success: false, code: "refresh_force_unsupported" });
			expect(send).not.toHaveBeenCalled();
			expect(upgrade).not.toHaveBeenCalled();
			expect(session.isDisposed).toBe(false);
		} finally {
			await served.close();
		}
	});
});
