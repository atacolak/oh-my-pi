// Integration test — real timers are required (ts-no-test-timers exception): every case crosses the
// broker's authenticated socket and drives a real PTY child. The awaited signals are RPC answers and
// process-exit state transitions, never fixed delays.
import { describe, expect, it } from "bun:test";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import type { DaemonBrokerClient } from "../../src/launch/client";
import type { DaemonRpcResult } from "../../src/launch/protocol";
import { terminalSpec, withTerminalBroker } from "./terminal-fixture";

const LIVE_VIEWER_SCRIPT =
	"process.stdin.setRawMode(true);" +
	'process.stdin.setEncoding("utf8");' +
	'process.stdout.write("READY\\n");' +
	'process.stdin.on("data", () => {});';

const EXIT_ON_INPUT_SCRIPT =
	"process.stdin.setRawMode(true);" +
	'process.stdin.setEncoding("utf8");' +
	'process.stdout.write("READY\\n");' +
	'process.stdin.once("data", () => process.exit(0));';

interface StartedTerminal {
	readonly subscriptionId: string;
	readonly name: string;
	readonly id: string;
}

async function startTerminal(
	client: DaemonBrokerClient,
	projectDir: string,
	name: string,
	script: string,
): Promise<StartedTerminal> {
	const subscriptionId = `view-${Snowflake.next()}`;
	const spec = terminalSpec(projectDir, script, { name, ready: { log: "READY", timeoutMs: 5_000 } });
	const started = await client.request({
		op: "terminal_start",
		subscriptionId,
		spec,
		columns: 80,
		rows: 24,
	});
	if (started.op !== "terminal_start") throw new Error(`unexpected terminal_start result ${started.op}`);
	return { subscriptionId, name, id: started.daemon.id };
}

function terminalName(): string {
	return `mind-${Snowflake.next()}`;
}

async function prepare(
	client: DaemonBrokerClient,
	name: string,
	id: string,
	lease?: string,
): Promise<Extract<DaemonRpcResult, { op: "terminal_idle_prepare" }>> {
	const result = await client.request({ op: "terminal_idle_prepare", name, id, lease });
	if (result.op !== "terminal_idle_prepare") throw new Error(`unexpected prepare result ${result.op}`);
	return result;
}

async function attach(client: DaemonBrokerClient, name: string, id: string): Promise<void> {
	const attached = await client.request({
		op: "terminal_attach",
		subscriptionId: `view-${Snowflake.next()}`,
		name,
		id,
		columns: 80,
		rows: 24,
	});
	if (attached.op !== "terminal_attach") throw new Error(`unexpected attach result ${attached.op}`);
	if (attached.daemon.id !== id) throw new Error(`attached generation ${attached.daemon.id}, expected ${id}`);
}

describe("broker terminal idle retirement", () => {
	it("publishes the broker runtime directory in the owner launch context", async () => {
		await withTerminalBroker(async ({ client, projectDir, runtimeDir }) => {
			const name = terminalName();
			const subscriptionId = `view-${Snowflake.next()}`;
			const spec = terminalSpec(
				projectDir,
				'process.stdout.write("CTX:" + (process.env.OMP_SESSION_OWNER_CONTEXT ?? "") + "\\n");' +
					"process.stdin.resume();",
				{ name, ready: { log: "CTX:", timeoutMs: 5_000 } },
			);
			await client.request({ op: "terminal_start", subscriptionId, spec, columns: 80, rows: 24 });
			const logs = await client.request({
				op: "logs",
				name,
				lines: 20,
				head: true,
				follow: false,
				timeoutMs: 1_000,
			});
			if (logs.op !== "logs") throw new Error(`unexpected logs result ${logs.op}`);
			const match = /CTX:(\{.*\})/u.exec(logs.text.replaceAll("\r", ""));
			if (!match) throw new Error(`no owner context in terminal output: ${JSON.stringify(logs.text)}`);
			const context = JSON.parse(match[1]!) as { projectDir?: string; name?: string; runtimeDir?: string };
			expect(context.projectDir).toBe(projectDir);
			expect(context.name).toBe(name);
			expect(context.runtimeDir).toBe(runtimeDir);
		});
	}, 20_000);

	it("refuses to retire a terminal that still has an attached viewer", async () => {
		await withTerminalBroker(async ({ client, projectDir }) => {
			const terminal = await startTerminal(client, projectDir, terminalName(), LIVE_VIEWER_SCRIPT);
			await expect(
				client.request({ op: "terminal_idle_prepare", name: terminal.name, id: terminal.id }),
			).rejects.toThrow(/attached/u);

			await client.request({
				op: "terminal_detach",
				subscriptionId: terminal.subscriptionId,
				name: terminal.name,
				id: terminal.id,
			});
			const prepared = await prepare(client, terminal.name, terminal.id);
			expect(prepared.lease).toMatch(/^[0-9a-f-]{36}$/u);
		});
	}, 20_000);

	it("refuses unknown, non-terminal, and non-persistent owners without touching a terminal", async () => {
		await withTerminalBroker(async ({ client, projectDir }) => {
			await client.request({ op: "ping" });
			await expect(
				client.request({ op: "terminal_idle_prepare", name: terminalName(), id: crypto.randomUUID() }),
			).rejects.toThrow(/Unknown daemon/u);

			const name = terminalName();
			const started = await client.request({
				op: "start",
				spec: {
					name,
					application: process.execPath,
					args: ["-e", "setInterval(() => {}, 1000)"],
					env: {},
					cwd: projectDir,
					pty: false,
					persist: true,
					detached: false,
					restart: "no",
				},
			});
			if (started.op !== "start") throw new Error(`unexpected start result ${started.op}`);
			await expect(client.request({ op: "terminal_idle_prepare", name, id: started.daemon.id })).rejects.toThrow(
				/persistent terminal/u,
			);
		});
	}, 20_000);

	it("refuses to replace a pending lease from another caller", async () => {
		await withTerminalBroker(async ({ client, projectDir }) => {
			const terminal = await startTerminal(client, projectDir, terminalName(), LIVE_VIEWER_SCRIPT);
			await client.request({
				op: "terminal_detach",
				subscriptionId: terminal.subscriptionId,
				name: terminal.name,
				id: terminal.id,
			});
			const first = await prepare(client, terminal.name, terminal.id);
			await expect(prepare(client, terminal.name, terminal.id)).rejects.toThrow(/pending retirement lease/u);
			const cancelled = await client.request({
				op: "terminal_idle_cancel",
				name: terminal.name,
				id: terminal.id,
				lease: first.lease,
			});
			expect(cancelled).toEqual({
				op: "terminal_idle_cancel",
				name: terminal.name,
				id: terminal.id,
				released: true,
			});
		});
	}, 20_000);

	it("refuses new attaches while a retirement lease is pending", async () => {
		await withTerminalBroker(async ({ client, projectDir }) => {
			const terminal = await startTerminal(client, projectDir, terminalName(), LIVE_VIEWER_SCRIPT);
			await client.request({
				op: "terminal_detach",
				subscriptionId: terminal.subscriptionId,
				name: terminal.name,
				id: terminal.id,
			});
			await prepare(client, terminal.name, terminal.id);
			await expect(
				client.request({
					op: "terminal_attach",
					subscriptionId: `late-${Snowflake.next()}`,
					name: terminal.name,
					id: terminal.id,
					columns: 80,
					rows: 24,
				}),
			).rejects.toThrow(/retiring/u);
		});
	}, 20_000);

	it("reopens the same generation after its lease is cancelled", async () => {
		await withTerminalBroker(async ({ client, projectDir }) => {
			const terminal = await startTerminal(client, projectDir, terminalName(), LIVE_VIEWER_SCRIPT);
			await client.request({
				op: "terminal_detach",
				subscriptionId: terminal.subscriptionId,
				name: terminal.name,
				id: terminal.id,
			});
			const prepared = await prepare(client, terminal.name, terminal.id);
			const cancelled = await client.request({
				op: "terminal_idle_cancel",
				name: terminal.name,
				id: terminal.id,
				lease: prepared.lease,
			});
			expect(cancelled).toEqual({
				op: "terminal_idle_cancel",
				name: terminal.name,
				id: terminal.id,
				released: true,
			});

			const attached = await client.request({
				op: "terminal_attach",
				subscriptionId: `view-${Snowflake.next()}`,
				name: terminal.name,
				id: terminal.id,
				columns: 80,
				rows: 24,
			});
			if (attached.op !== "terminal_attach") throw new Error(`unexpected attach result ${attached.op}`);
			expect(attached.daemon.id).toBe(terminal.id);
		});
	}, 20_000);

	it("ignores a cancellation that does not match the pending lease", async () => {
		await withTerminalBroker(async ({ client, projectDir }) => {
			const terminal = await startTerminal(client, projectDir, terminalName(), LIVE_VIEWER_SCRIPT);
			await client.request({
				op: "terminal_detach",
				subscriptionId: terminal.subscriptionId,
				name: terminal.name,
				id: terminal.id,
			});
			const prepared = await prepare(client, terminal.name, terminal.id);
			const stale = await client.request({
				op: "terminal_idle_cancel",
				name: terminal.name,
				id: terminal.id,
				lease: crypto.randomUUID(),
			});
			expect(stale).toEqual({
				op: "terminal_idle_cancel",
				name: terminal.name,
				id: terminal.id,
				released: false,
			});
			await expect(
				client.request({
					op: "terminal_attach",
					subscriptionId: `view-${Snowflake.next()}`,
					name: terminal.name,
					id: terminal.id,
					columns: 80,
					rows: 24,
				}),
			).rejects.toThrow(/retiring/u);

			const released = await client.request({
				op: "terminal_idle_cancel",
				name: terminal.name,
				id: terminal.id,
				lease: prepared.lease,
			});
			expect(released).toEqual({
				op: "terminal_idle_cancel",
				name: terminal.name,
				id: terminal.id,
				released: true,
			});
		});
	}, 20_000);

	it("keeps the fence across a mode change until the owner releases it", async () => {
		await withTerminalBroker(async ({ client, projectDir }) => {
			const terminal = await startTerminal(client, projectDir, terminalName(), LIVE_VIEWER_SCRIPT);
			await client.request({
				op: "terminal_detach",
				subscriptionId: terminal.subscriptionId,
				name: terminal.name,
				id: terminal.id,
			});
			const prepared = await prepare(client, terminal.name, terminal.id);
			const mode = await client.request({ op: "mode", name: terminal.name, mode: "session" });
			if (mode.op !== "mode") throw new Error(`unexpected mode result ${mode.op}`);
			expect(mode.daemon.persist).toBe(false);

			const recovered = await prepare(client, terminal.name, terminal.id, prepared.lease);
			expect(recovered.lease).toBe(prepared.lease);

			await expect(
				client.request({
					op: "terminal_attach",
					subscriptionId: `view-${Snowflake.next()}`,
					name: terminal.name,
					id: terminal.id,
					columns: 80,
					rows: 24,
				}),
			).rejects.toThrow(/retiring/u);

			const cancelled = await client.request({
				op: "terminal_idle_cancel",
				name: terminal.name,
				id: terminal.id,
				lease: prepared.lease,
			});
			expect(cancelled).toEqual({
				op: "terminal_idle_cancel",
				name: terminal.name,
				id: terminal.id,
				released: true,
			});
			await attach(client, terminal.name, terminal.id);
		});
	}, 20_000);

	it("acknowledges a repeated prepare pinned to the caller's lease", async () => {
		await withTerminalBroker(async ({ client, projectDir }) => {
			const terminal = await startTerminal(client, projectDir, terminalName(), LIVE_VIEWER_SCRIPT);
			await client.request({
				op: "terminal_detach",
				subscriptionId: terminal.subscriptionId,
				name: terminal.name,
				id: terminal.id,
			});
			const lease = crypto.randomUUID();
			const first = await prepare(client, terminal.name, terminal.id, lease);
			expect(first.lease).toBe(lease);
			const repeated = await prepare(client, terminal.name, terminal.id, lease);
			expect(repeated.lease).toBe(lease);

			await expect(
				client.request({
					op: "terminal_attach",
					subscriptionId: `view-${Snowflake.next()}`,
					name: terminal.name,
					id: terminal.id,
					columns: 80,
					rows: 24,
				}),
			).rejects.toThrow(/retiring/u);

			const cancelled = await client.request({
				op: "terminal_idle_cancel",
				name: terminal.name,
				id: terminal.id,
				lease,
			});
			expect(cancelled).toEqual({
				op: "terminal_idle_cancel",
				name: terminal.name,
				id: terminal.id,
				released: true,
			});
			await attach(client, terminal.name, terminal.id);
		});
	}, 20_000);

	it("frees the fence when the owner generation is replaced", async () => {
		await withTerminalBroker(async ({ client, projectDir }) => {
			const name = terminalName();
			const first = await startTerminal(client, projectDir, name, LIVE_VIEWER_SCRIPT);
			await client.request({
				op: "terminal_detach",
				subscriptionId: first.subscriptionId,
				name,
				id: first.id,
			});
			const prepared = await prepare(client, name, first.id);

			const spec = terminalSpec(projectDir, LIVE_VIEWER_SCRIPT, {
				name,
				ready: { log: "READY", timeoutMs: 5_000 },
			});
			const replaced = await client.request({ op: "start", spec, replace: true, awaitReady: true });
			if (replaced.op !== "start") throw new Error(`unexpected start result ${replaced.op}`);
			const replacementId = replaced.daemon.id;
			expect(replacementId).not.toBe(first.id);

			const lease = crypto.randomUUID();
			const fenced = await prepare(client, name, replacementId, lease);
			expect(fenced.lease).toBe(lease);

			const stale = await client.request({
				op: "terminal_idle_cancel",
				name,
				id: first.id,
				lease: prepared.lease,
			});
			expect(stale).toEqual({
				op: "terminal_idle_cancel",
				name,
				id: first.id,
				released: false,
			});
			await expect(
				client.request({
					op: "terminal_attach",
					subscriptionId: `view-${Snowflake.next()}`,
					name,
					id: replacementId,
					columns: 80,
					rows: 24,
				}),
			).rejects.toThrow(/retiring/u);

			const cancelled = await client.request({
				op: "terminal_idle_cancel",
				name,
				id: replacementId,
				lease,
			});
			expect(cancelled).toEqual({
				op: "terminal_idle_cancel",
				name,
				id: replacementId,
				released: true,
			});
			await attach(client, name, replacementId);
		});
	}, 20_000);

	it("clears the lease when the owner process exits", async () => {
		await withTerminalBroker(async ({ client, projectDir }) => {
			const name = terminalName();
			const terminal = await startTerminal(client, projectDir, name, EXIT_ON_INPUT_SCRIPT);
			await client.request({
				op: "terminal_detach",
				subscriptionId: terminal.subscriptionId,
				name,
				id: terminal.id,
			});
			const prepared = await prepare(client, name, terminal.id);

			await client.request({ op: "send", name, id: terminal.id, data: "x" });
			const exited = await client.request({ op: "wait", name, for: "exit", timeoutMs: 5_000 });
			if (exited.op !== "wait") throw new Error(`unexpected wait result ${exited.op}`);
			expect(exited.daemon.state).toBe("exited");

			const cancelled = await client.request({
				op: "terminal_idle_cancel",
				name,
				id: terminal.id,
				lease: prepared.lease,
			});
			expect(cancelled).toEqual({ op: "terminal_idle_cancel", name, id: terminal.id, released: false });
			await expect(prepare(client, name, terminal.id)).rejects.toThrow(/exited/u);

			const replacement = await startTerminal(client, projectDir, name, LIVE_VIEWER_SCRIPT);
			expect(replacement.id).not.toBe(terminal.id);
			await client.request({
				op: "terminal_detach",
				subscriptionId: replacement.subscriptionId,
				name,
				id: replacement.id,
			});
			const preparedAgain = await prepare(client, name, replacement.id);
			expect(preparedAgain.id).toBe(replacement.id);
		});
	}, 20_000);
});
