// Integration test — real timers are required (ts-no-test-timers exception): every case drives the
// actual cross-process daemon broker supervising real child processes, and the contract under test is
// which native process reference receives a signal after real launches, exits, and restarts.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type DaemonBrokerStartOptions, startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, DaemonBrokerRejectedError, type DaemonBrokerClient } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROCESS_CONTROL_VERSION,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonRpcResult,
	parseDaemonRpcResult,
	parseDaemonWireRequest,
} from "../../src/launch/protocol";

const LONG_LIVED = 'Bun.serve({ port: 0, fetch() { return new Response("ok"); } })';

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string, options: DaemonBrokerStartOptions = {}): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment(options);
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

function processRunning(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	return Process.fromPid(pid)?.status() === "running";
}

async function terminatePid(pid: number | undefined): Promise<void> {
	if (pid === undefined) return;
	const processRef = Process.fromPid(pid);
	if (processRef?.status() !== "running") return;
	await processRef.terminate({ group: true, gracefulMs: 0, timeoutMs: 2_000 });
}

async function snapshotOf(client: DaemonBrokerClient, name: string): Promise<DaemonSnapshot> {
	const listed = await client.request({ op: "list" });
	if (listed.op !== "list") throw new Error(`unexpected result: ${listed.op}`);
	const daemon = listed.daemons.find(entry => entry.name === name);
	if (!daemon) throw new Error(`daemon ${name} not listed`);
	return daemon;
}

async function startDaemon(
	client: DaemonBrokerClient,
	spec: {
		name: string;
		projectDir: string;
		args?: string[];
		detached?: boolean;
		restart?: "no" | "always";
	},
): Promise<DaemonSnapshot> {
	const started = await client.request({
		op: "start",
		spec: {
			name: spec.name,
			application: process.execPath,
			args: spec.args ?? ["-e", LONG_LIVED],
			env: {},
			cwd: spec.projectDir,
			pty: false,
			restart: spec.restart ?? "no",
			persist: spec.detached ?? false,
			detached: spec.detached ?? false,
		},
	});
	if (started.op !== "start") throw new Error(`unexpected result: ${started.op}`);
	return started.daemon;
}

async function expectRefusal(request: Promise<DaemonRpcResult>, expected: RegExp): Promise<void> {
	const error = await request.then(
		() => undefined,
		(rejection: unknown) => rejection,
	);
	expect(error).toBeInstanceOf(DaemonBrokerRejectedError);
	expect((error as Error).message).toMatch(expected);
}

async function waitForReplacement(
	client: DaemonBrokerClient,
	name: string,
	previousPid: number,
	deadlineMs = 10_000,
): Promise<DaemonSnapshot> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const daemon = await snapshotOf(client, name);
		const launched = daemon.pid !== undefined && daemon.pid !== previousPid;
		if (launched && (daemon.state === "running" || daemon.state === "starting")) return daemon;
		await Bun.sleep(25);
	}
	throw new Error(`daemon ${name} never launched a replacement for ${previousPid}`);
}

describe("daemon broker guarded process control", () => {
	it("stops the owned process through the broker's spawn-held handle and advertises the capability", async () => {
		using tempDir = TempDir.createSync("@omp-broker-process-control-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const previousTitle = process.title;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		let pid: number | undefined;
		try {
			const ping = await client.request({ op: "ping" });
			if (ping.op !== "ping") throw new Error(`unexpected result: ${ping.op}`);
			expect(DAEMON_PROCESS_CONTROL_VERSION).toBe(1);
			expect(ping.processControlVersion).toBe(1);

			const started = await startDaemon(client, { name: "owned", projectDir });
			pid = started.pid;
			expect(pid).toBeNumber();
			expect(processRunning(pid)).toBe(true);

			const stopped = await client.request({
				op: "stop",
				name: "owned",
				timeoutMs: 2_000,
				id: started.id,
				expectedPid: pid!,
				requireProcessHandle: true,
			});
			if (stopped.op !== "stop") throw new Error(`unexpected result: ${stopped.op}`);
			expect(stopped.daemon.state).toBe("exited");
			expect(stopped.daemon.pid).toBeUndefined();

			const after = await snapshotOf(client, "owned");
			expect(after.state).toBe("exited");
			expect(processRunning(pid)).toBe(false);
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			await terminatePid(pid);
			process.title = previousTitle;
		}
	}, 20_000);

	it("refuses a stale id or a mismatched pid and leaves the original and an unrelated process running", async () => {
		using tempDir = TempDir.createSync("@omp-broker-process-fence-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const previousTitle = process.title;
		const outsider = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		let firstPid: number | undefined;
		let secondPid: number | undefined;
		try {
			const first = await startDaemon(client, { name: "first", projectDir });
			const second = await startDaemon(client, { name: "second", projectDir });
			firstPid = first.pid;
			secondPid = second.pid;
			expect(processRunning(firstPid)).toBe(true);
			expect(processRunning(secondPid)).toBe(true);
			expect(processRunning(outsider.pid)).toBe(true);

			await expectRefusal(
				client.request({
					op: "stop",
					name: "first",
					timeoutMs: 2_000,
					id: crypto.randomUUID(),
					expectedPid: firstPid!,
					requireProcessHandle: true,
				}),
				/is generation/,
			);
			await expectRefusal(
				client.request({
					op: "stop",
					name: "first",
					timeoutMs: 2_000,
					id: first.id,
					expectedPid: secondPid!,
					requireProcessHandle: true,
				}),
				/does not match expected pid/,
			);
			await expectRefusal(
				client.request({
					op: "stop",
					name: "first",
					timeoutMs: 2_000,
					id: first.id,
					expectedPid: outsider.pid,
					requireProcessHandle: true,
				}),
				/does not match expected pid/,
			);

			const untouched = await snapshotOf(client, "first");
			expect(untouched.id).toBe(first.id);
			expect(untouched.state).toBe("running");
			expect(untouched.pid).toBe(firstPid);
			expect(processRunning(firstPid)).toBe(true);
			expect(processRunning(secondPid)).toBe(true);
			expect(processRunning(outsider.pid)).toBe(true);

			const stopped = await client.request({
				op: "stop",
				name: "first",
				timeoutMs: 2_000,
				id: first.id,
				expectedPid: firstPid!,
				requireProcessHandle: true,
			});
			if (stopped.op !== "stop") throw new Error(`unexpected result: ${stopped.op}`);
			expect(stopped.daemon.state).toBe("exited");
			expect(processRunning(secondPid)).toBe(true);
			expect(processRunning(outsider.pid)).toBe(true);
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			outsider.kill();
			await outsider.exited.catch(() => undefined);
			await terminatePid(firstPid);
			await terminatePid(secondPid);
			process.title = previousTitle;
		}
	}, 25_000);

	it("leaves a replacement generation running when an old guarded request arrives", async () => {
		using tempDir = TempDir.createSync("@omp-broker-process-replacement-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const marker = path.join(projectDir, "generation-marker");
		const script = [
			`const marker = ${JSON.stringify(marker)};`,
			'if (!(await Bun.file(marker).exists())) {',
			'\tawait Bun.write(marker, "1");',
			"\tsetTimeout(() => process.exit(0), 300);",
			"} else {",
			`\t${LONG_LIVED}`,
			"}",
		].join("\n");

		const previousTitle = process.title;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir, { restartBackoffBaseMs: 100 });
		let replacementPid: number | undefined;
		let firstPid: number | undefined;
		try {
			const first = await startDaemon(client, {
				name: "replaced",
				projectDir,
				args: ["-e", script],
				restart: "always",
			});
			firstPid = first.pid;
			expect(firstPid).toBeNumber();

			const replacement = await waitForReplacement(client, "replaced", firstPid!);
			replacementPid = replacement.pid;
			expect(replacement.id).toBe(first.id);
			expect(processRunning(replacementPid)).toBe(true);
			expect(processRunning(firstPid)).toBe(false);

			await expectRefusal(
				client.request({
					op: "stop",
					name: "replaced",
					timeoutMs: 2_000,
					id: first.id,
					expectedPid: firstPid!,
					requireProcessHandle: true,
				}),
				/does not match expected pid/,
			);
			await Bun.sleep(150);
			expect(processRunning(replacementPid)).toBe(true);
			const running = await snapshotOf(client, "replaced");
			expect(running.pid).toBe(replacementPid);
			expect(running.state).toBe("running");

			const stopped = await client.request({ op: "stop", name: "replaced", timeoutMs: 2_000 });
			if (stopped.op !== "stop") throw new Error(`unexpected result: ${stopped.op}`);
			expect(stopped.daemon.state).toBe("exited");
			expect(processRunning(replacementPid)).toBe(false);
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			await terminatePid(firstPid);
			await terminatePid(replacementPid);
			process.title = previousTitle;
		}
	}, 25_000);

	it("refuses guarded stop for a recovered snapshot that only has pid metadata", async () => {
		using tempDir = TempDir.createSync("@omp-broker-process-recovered-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const previousTitle = process.title;
		const name = "recovered";
		let pid: number | undefined;
		let daemonId: string | undefined;

		const firstClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const firstBroker = startBroker(projectDir, runtimeDir);
		try {
			const started = await startDaemon(firstClient, { name, projectDir, detached: true });
			pid = started.pid;
			daemonId = started.id;
			expect(pid).toBeNumber();
		} finally {
			await firstClient.request({ op: "shutdown" }).catch(() => undefined);
			firstClient.close();
			await firstBroker;
		}

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const recovered = await snapshotOf(client, name);
			expect(recovered.state).toBe("running");
			expect(recovered.pid).toBe(pid);
			expect(recovered.id).toBe(daemonId);

			const ping = await client.request({ op: "ping" });
			if (ping.op !== "ping") throw new Error(`unexpected result: ${ping.op}`);
			expect(ping.processControlVersion).toBe(DAEMON_PROCESS_CONTROL_VERSION);

			await expectRefusal(
				client.request({
					op: "stop",
					name,
					timeoutMs: 2_000,
					id: daemonId,
					expectedPid: pid!,
					requireProcessHandle: true,
				}),
				/no stable process handle/,
			);
			expect(processRunning(pid)).toBe(true);
			expect((await snapshotOf(client, name)).state).toBe("running");

			const stopped = await client.request({ op: "stop", name, timeoutMs: 2_000 });
			if (stopped.op !== "stop") throw new Error(`unexpected result: ${stopped.op}`);
			expect(stopped.daemon.state).toBe("exited");
			expect(processRunning(pid)).toBe(false);

			await expectRefusal(
				client.request({
					op: "stop",
					name,
					timeoutMs: 2_000,
					id: daemonId,
					expectedPid: pid!,
					requireProcessHandle: true,
				}),
				/no stable process handle/,
			);
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			await terminatePid(pid);
			process.title = previousTitle;
		}
	}, 25_000);
});

describe("daemon guarded stop protocol", () => {
	function wire(operation: Record<string, unknown>): unknown {
		return { id: "request-1", token: "fixture-only", operation };
	}

	it("accepts a guarded stop carrying the exact generation and pid", () => {
		const request = parseDaemonWireRequest(
			wire({
				op: "stop",
				name: "owner",
				timeoutMs: 1_500,
				id: "generation-uuid",
				expectedPid: 4_242,
				requireProcessHandle: true,
			}),
		);
		expect(request.operation).toEqual({
			op: "stop",
			name: "owner",
			timeoutMs: 1_500,
			id: "generation-uuid",
			expectedPid: 4_242,
			requireProcessHandle: true,
		});
	});

	it("keeps a legacy stop request field for field", () => {
		expect(JSON.stringify(parseDaemonWireRequest(wire({ op: "stop", name: "owner", timeoutMs: 1_500 })).operation)).toBe(
			'{"op":"stop","name":"owner","timeoutMs":1500}',
		);
	});

	it("rejects guarded stop without an exact generation", () => {
		expect(() =>
			parseDaemonWireRequest(
				wire({
					op: "stop",
					name: "owner",
					timeoutMs: 1_500,
					expectedPid: 4_242,
					requireProcessHandle: true,
				}),
			),
		).toThrow("operation.id must be a non-empty string");
	});

	it("rejects guarded stop without an expected pid", () => {
		expect(() =>
			parseDaemonWireRequest(
				wire({
					op: "stop",
					name: "owner",
					timeoutMs: 1_500,
					id: "generation-uuid",
					requireProcessHandle: true,
				}),
			),
		).toThrow("operation.expectedPid is required");
	});

	it("rejects a guarded stop with a non-positive expected pid", () => {
		expect(() =>
			parseDaemonWireRequest(
				wire({
					op: "stop",
					name: "owner",
					timeoutMs: 1_500,
					id: "generation-uuid",
					expectedPid: 0,
					requireProcessHandle: true,
				}),
			),
		).toThrow("operation.expectedPid must be a positive integer");
	});

	it("rejects a non-boolean process handle requirement", () => {
		expect(() =>
			parseDaemonWireRequest(
				wire({
					op: "stop",
					name: "owner",
					timeoutMs: 1_500,
					id: "generation-uuid",
					expectedPid: 4_242,
					requireProcessHandle: "yes",
				}),
			),
		).toThrow("operation.requireProcessHandle must be a boolean");
	});

	it("negotiates process control through ping without breaking legacy brokers", () => {
		expect(
			JSON.stringify(parseDaemonRpcResult({ op: "ping" }, { projectDir: "/work", processControlVersion: 1 })),
		).toBe('{"op":"ping","projectDir":"/work","processControlVersion":1}');
		expect(JSON.stringify(parseDaemonRpcResult({ op: "ping" }, { projectDir: "/work" }))).toBe(
			'{"op":"ping","projectDir":"/work"}',
		);
		expect(() => parseDaemonRpcResult({ op: "ping" }, { projectDir: "/work", processControlVersion: 0 })).toThrow(
			"result.processControlVersion must be a positive integer",
		);
	});
});
