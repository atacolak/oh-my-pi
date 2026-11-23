// Integration test — real timers are required (ts-no-test-timers exception): the helper consumes the
// process-shared broker client against a live broker and a real PTY child. The awaited signals are
// socket answers and condition polls with explicit deadlines, never fixed sleeps.
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import {
	cancelSessionOwnerIdleRetirement,
	closeDaemonClients,
	createDaemonBrokerClient,
	daemonClientForProject,
	type DaemonBrokerClient,
	prepareSessionOwnerIdleRetirement,
} from "../../src/launch/client";
import { canonicalProjectDir, daemonBrokerEndpoint, daemonRuntimeDir } from "../../src/launch/paths";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";
import { terminalSpec } from "./terminal-fixture";

const VIEWER_SCRIPT =
	"process.stdin.setRawMode(true);" +
	'process.stdin.setEncoding("utf8");' +
	'process.stdout.write("READY\\n");' +
	'process.stdin.on("data", () => {});';

interface OwnerScope {
	readonly projectDir: string;
	readonly runtimeDir: string;
	readonly client: DaemonBrokerClient;
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

async function waitForBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const probe = await createDaemonBrokerClient(projectDir, { runtimeDir, existingOnly: true });
		try {
			const ping = await probe.request({ op: "ping" });
			if (ping.op === "ping") return;
		} catch (error) {
			if (Date.now() >= deadline) throw error;
		} finally {
			probe.close();
		}
		await Bun.sleep(10);
	}
}

async function withOwnerScope(
	runtimeDirKind: "project" | "explicit",
	body: (scope: OwnerScope) => Promise<void>,
): Promise<void> {
	using tempDir = TempDir.createSync("@omp-launch-retire-");
	const projectDir = path.join(tempDir.path(), "project");
	await fs.mkdir(projectDir);
	const runtimeDir =
		runtimeDirKind === "explicit"
			? path.join(tempDir.path(), "runtime")
			: daemonRuntimeDir(await canonicalProjectDir(projectDir));
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const seed = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	seed.close();
	const broker = startBroker(projectDir, runtimeDir);
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	try {
		await waitForBroker(projectDir, runtimeDir);
		await body({ projectDir, runtimeDir, client });
	} finally {
		try {
			await client.request({ op: "shutdown" });
		} catch {
			// The broker may already be gone.
		}
		client.close();
		await closeDaemonClients();
		await broker;
		if (runtimeDirKind === "project") await fs.rm(runtimeDir, { recursive: true, force: true });
	}
}

async function startDetachedTerminal(scope: OwnerScope): Promise<{ name: string; id: string }> {
	const name = `mind-${Snowflake.next()}`;
	const subscriptionId = `view-${Snowflake.next()}`;
	const spec = terminalSpec(scope.projectDir, VIEWER_SCRIPT, {
		name,
		ready: { log: "READY", timeoutMs: 5_000 },
	});
	const started = await scope.client.request({
		op: "terminal_start",
		subscriptionId,
		spec,
		columns: 80,
		rows: 24,
	});
	if (started.op !== "terminal_start") throw new Error(`unexpected terminal_start result ${started.op}`);
	await scope.client.request({ op: "terminal_detach", subscriptionId, name, id: started.daemon.id });
	return { name, id: started.daemon.id };
}

async function attach(scope: OwnerScope, name: string, id: string): Promise<void> {
	const attached = await scope.client.request({
		op: "terminal_attach",
		subscriptionId: `view-${Snowflake.next()}`,
		name,
		id,
		columns: 80,
		rows: 24,
	});
	if (attached.op !== "terminal_attach") throw new Error(`unexpected terminal_attach result ${attached.op}`);
	expect(attached.daemon.id).toBe(id);
}

interface ScriptedOperation {
	readonly op: string;
	readonly name?: string;
	readonly id?: string;
	readonly lease?: string;
}

interface ScriptedRequest {
	readonly id: string;
	readonly operation: ScriptedOperation;
}

interface ScriptedBroker {
	readonly projectDir: string;
	readonly runtimeDir: string;
	readonly requests: Array<{ readonly connection: number; readonly request: ScriptedRequest }>;
}

type ScriptedReply = (result: unknown) => void;
type ScriptedDrop = () => void;

async function withScriptedBroker(
	hook: (connection: number, request: ScriptedRequest, reply: ScriptedReply, drop: ScriptedDrop) => void,
	body: (broker: ScriptedBroker) => Promise<void>,
): Promise<void> {
	using tempDir = TempDir.createSync("@omp-idle-scripted-");
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const connections: IpcConnection[] = [];
	const requests: Array<{ connection: number; request: ScriptedRequest }> = [];
	let accepted = 0;
	const server = await IpcServer.listen(daemonBrokerEndpoint(runtimeDir), { framing: "lines" }, connection => {
		accepted += 1;
		const index = accepted;
		connections.push(connection);
		connection.start(
			line => {
				const request = JSON.parse(line) as ScriptedRequest;
				requests.push({ connection: index, request });
				hook(
					index,
					request,
					result => connection.send(JSON.stringify({ id: request.id, ok: true, result })),
					() => connection.destroy(),
				);
			},
			() => {},
		);
	});
	try {
		await body({ projectDir, runtimeDir, requests });
	} finally {
		await closeDaemonClients();
		for (const connection of connections) connection.destroy();
		await server.close();
	}
}

describe("session owner idle retirement helper", () => {
	it("fences the owner through a shared client pinned to an explicit runtime directory", async () => {
		await withOwnerScope("explicit", async scope => {
			const terminal = await startDetachedTerminal(scope);
			await (async () => {
				await using retirement = await prepareSessionOwnerIdleRetirement({
					...terminal,
					projectDir: scope.projectDir,
					runtimeDir: scope.runtimeDir,
				});
				expect(retirement).toBeDefined();
				await expect(attach(scope, terminal.name, terminal.id)).rejects.toThrow(/retiring/u);
			})();
			await attach(scope, terminal.name, terminal.id);
		});
	}, 30_000);

	it("releases explicitly and idempotently, and refuses without exiting the owner", async () => {
		await withOwnerScope("explicit", async scope => {
			const terminal = await startDetachedTerminal(scope);
			const retirement = await prepareSessionOwnerIdleRetirement({
				...terminal,
				projectDir: scope.projectDir,
				runtimeDir: scope.runtimeDir,
			});
			if (!retirement) throw new Error("owner retirement was refused");
			await expect(attach(scope, terminal.name, terminal.id)).rejects.toThrow(/retiring/u);
			await retirement.release();
			await retirement.release();
			await attach(scope, terminal.name, terminal.id);

			const refused = await prepareSessionOwnerIdleRetirement({
				projectDir: scope.projectDir,
				runtimeDir: scope.runtimeDir,
				name: `missing-${Snowflake.next()}`,
				id: crypto.randomUUID(),
			});
			expect(refused).toBeUndefined();
		});
	}, 30_000);

	it("defaults to the project's canonical broker scope", async () => {
		await withOwnerScope("project", async scope => {
			const terminal = await startDetachedTerminal(scope);
			const retirement = await prepareSessionOwnerIdleRetirement({
				...terminal,
				projectDir: scope.projectDir,
			});
			if (!retirement) throw new Error("owner retirement was refused");
			await expect(attach(scope, terminal.name, terminal.id)).rejects.toThrow(/retiring/u);
			await retirement.release();
			await attach(scope, terminal.name, terminal.id);
		});
	}, 30_000);

	it("reuses the project transport when retirement supplies its exact runtime directory", async () => {
		await withOwnerScope("project", async scope => {
			const terminal = await startDetachedTerminal(scope);
			const client = await daemonClientForProject(scope.projectDir);
			await client.request({ op: "ping" });
			const connect = spyOn(IpcConnection, "connect");
			try {
				await using retirement = await prepareSessionOwnerIdleRetirement({
					...terminal,
					projectDir: scope.projectDir,
					runtimeDir: scope.runtimeDir,
				});
				expect(retirement).toBeDefined();
				expect(connect).not.toHaveBeenCalled();
				await expect(attach(scope, terminal.name, terminal.id)).rejects.toThrow(/retiring/u);
			} finally {
				connect.mockRestore();
			}
		});
	}, 30_000);

	it("refuses a missing owner broker without launching another broker", async () => {
		using temp = TempDir.createSync("omp-idle-no-spawn-");
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("Unexpected broker launch");
		});
		try {
			const retirement = await prepareSessionOwnerIdleRetirement({
				projectDir: temp.path(),
				runtimeDir: path.join(temp.path(), "missing-runtime"),
				name: "missing-owner",
				id: crypto.randomUUID(),
			});
			expect(retirement).toBeUndefined();
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			await closeDaemonClients();
			spawn.mockRestore();
		}
	});

	it("cancels an ambiguous acquisition with the caller's lease", async () => {
		await withOwnerScope("explicit", async scope => {
			const terminal = await startDetachedTerminal(scope);
			const lease = crypto.randomUUID();
			const prepared = await scope.client.request({
				op: "terminal_idle_prepare",
				name: terminal.name,
				id: terminal.id,
				lease,
			});
			expect(prepared.op).toBe("terminal_idle_prepare");
			await expect(attach(scope, terminal.name, terminal.id)).rejects.toThrow(/retiring/u);

			await cancelSessionOwnerIdleRetirement({
				projectDir: scope.projectDir,
				runtimeDir: scope.runtimeDir,
				name: terminal.name,
				id: terminal.id,
				lease,
			});
			await attach(scope, terminal.name, terminal.id);
		});
	}, 30_000);

	it("recovers an acquisition whose prepare reply was lost", async () => {
		const name = "owner";
		const id = crypto.randomUUID();
		const lease = crypto.randomUUID();
		const cancellations: string[] = [];
		await withScriptedBroker(
			(connection, request, reply, drop) => {
				switch (request.operation.op) {
					case "terminal_idle_prepare":
						if (connection === 1) drop();
						else
							reply({
								op: "terminal_idle_prepare",
								name,
								id,
								lease: request.operation.lease ?? lease,
							});
						return;
					case "terminal_idle_cancel":
						cancellations.push(request.operation.lease ?? "");
						reply({ op: "terminal_idle_cancel", name, id, released: true });
						return;
				}
			},
			async broker => {
				const retirement = await prepareSessionOwnerIdleRetirement({
					projectDir: broker.projectDir,
					runtimeDir: broker.runtimeDir,
					name,
					id,
					lease,
				});
				expect(retirement?.lease).toBe(lease);
				expect(prepareLeases(broker)).toEqual([lease, lease]);
				await retirement?.release();
				expect(cancellations).toEqual([lease]);
			},
		);
	});

	it.each([false, true])("retries a lost cancellation existing-only with completion watcher %s", async watcher => {
		const name = "owner";
		const id = crypto.randomUUID();
		const lease = crypto.randomUUID();
		const cancellations: number[] = [];
		const retried = Promise.withResolvers<void>();
		await withScriptedBroker(
			(connection, request, reply, drop) => {
				switch (request.operation.op) {
					case "terminal_idle_prepare":
						reply({ op: "terminal_idle_prepare", name, id, lease: request.operation.lease ?? lease });
						return;
					case "terminal_idle_cancel":
						cancellations.push(connection);
						if (connection === 1) drop();
						else {
							reply({ op: "terminal_idle_cancel", name, id, released: true });
							retried.resolve();
						}
						return;
					case "ping":
						reply({ projectDir: "/scripted-project" });
						return;
				}
			},
			async broker => {
				const client = await createDaemonBrokerClient(broker.projectDir, { runtimeDir: broker.runtimeDir });
				try {
					if (watcher) client.onCompletion("watcher", () => {});
					await client.request({ op: "terminal_idle_prepare", name, id, lease });
					await expect(client.request({ op: "terminal_idle_cancel", name, id, lease })).rejects.toThrow();
					await withTimeout(retried.promise, 5000, "Retirement cancellation was not replayed autonomously");
					expect(cancellations).toEqual([1, 2]);
					expect(operationOrder(broker, 2)).toEqual(["terminal_idle_cancel"]);
				} finally {
					client.close();
				}
			},
		);
	});

	it("drains a queued cancellation before a later acquisition", async () => {
		const name = "owner";
		const id = crypto.randomUUID();
		const lease = crypto.randomUUID();
		await withScriptedBroker(
			(connection, request, reply, drop) => {
				switch (request.operation.op) {
					case "terminal_idle_prepare":
						reply({ op: "terminal_idle_prepare", name, id, lease: request.operation.lease ?? lease });
						return;
					case "terminal_idle_cancel":
						if (connection === 1) drop();
						else reply({ op: "terminal_idle_cancel", name, id, released: true });
						return;
				}
			},
			async broker => {
				const client = await createDaemonBrokerClient(broker.projectDir, { runtimeDir: broker.runtimeDir });
				try {
					await client.request({ op: "terminal_idle_prepare", name, id, lease });
					await expect(client.request({ op: "terminal_idle_cancel", name, id, lease })).rejects.toThrow();
					await client.request({ op: "terminal_idle_prepare", name, id, lease: crypto.randomUUID() });
					expect(operationOrder(broker, 2)).toEqual(["terminal_idle_cancel", "terminal_idle_prepare"]);
				} finally {
					client.close();
				}
			},
		);
	});

	it("supersedes a queued cancellation when the same lease is reacquired", async () => {
		const name = "owner";
		const id = crypto.randomUUID();
		const lease = crypto.randomUUID();
		await withScriptedBroker(
			(connection, request, reply, drop) => {
				switch (request.operation.op) {
					case "terminal_idle_prepare":
						reply({ op: "terminal_idle_prepare", name, id, lease: request.operation.lease ?? lease });
						return;
					case "terminal_idle_cancel":
						if (connection === 1) drop();
						else reply({ op: "terminal_idle_cancel", name, id, released: true });
						return;
				}
			},
			async broker => {
				const client = await createDaemonBrokerClient(broker.projectDir, { runtimeDir: broker.runtimeDir });
				try {
					await client.request({ op: "terminal_idle_prepare", name, id, lease });
					await expect(client.request({ op: "terminal_idle_cancel", name, id, lease })).rejects.toThrow();
					await client.request({ op: "terminal_idle_prepare", name, id, lease });
					expect(operationOrder(broker, 2)).toEqual(["terminal_idle_prepare"]);
				} finally {
					client.close();
				}
			},
		);
	});
});

function operationOrder(broker: ScriptedBroker, connection: number): string[] {
	return broker.requests.filter(entry => entry.connection === connection).map(entry => entry.request.operation.op);
}

function prepareLeases(broker: ScriptedBroker): Array<string | undefined> {
	return broker.requests
		.filter(entry => entry.request.operation.op === "terminal_idle_prepare")
		.map(entry => entry.request.operation.lease);
}
