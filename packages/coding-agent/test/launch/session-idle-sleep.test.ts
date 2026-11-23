// Real owner/PTY/socket integration: real timers exercise the native lifecycle timeout.
import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { isRecord, withTimeout } from "@oh-my-pi/pi-utils";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";
import { terminalSpec, withTerminalBroker, type TerminalBrokerFixture } from "./terminal-fixture";

const OWNER = path.join(import.meta.dir, "../fixtures/idle-sleep-owner.ts");

async function publication(
	fixture: TerminalBrokerFixture,
	name: string,
): Promise<{ sessionId: string; sessionFile: string; socketPath: string }> {
	const deadline = Date.now() + 15_000;
	for (;;) {
		try {
			const value: unknown = await Bun.file(path.join(fixture.projectDir, "idle-publication.json")).json();
			if (
				isRecord(value) &&
				typeof value.sessionId === "string" &&
				typeof value.sessionFile === "string" &&
				typeof value.socketPath === "string"
			)
				return { sessionId: value.sessionId, sessionFile: value.sessionFile, socketPath: value.socketPath };
		} catch {}
		if (Date.now() >= deadline) {
			const logs = await fixture.client.request({
				op: "logs",
				name,
				lines: 40,
				head: false,
				follow: false,
				timeoutMs: 1000,
			});
			throw new Error(`Idle owner did not publish readiness: ${logs.op === "logs" ? logs.text : logs.op}`);
		}
		await Bun.sleep(10);
	}
}

async function start(fixture: TerminalBrokerFixture, subscriptionId: string) {
	const result = await fixture.client.request({
		op: "terminal_start",
		subscriptionId,
		columns: 100,
		rows: 30,
		spec: terminalSpec(fixture.projectDir, "", {
			args: [OWNER],
			env: {
				HOME: path.join(fixture.projectDir, "home"),
				PI_CODING_AGENT_DIR: path.join(fixture.projectDir, "agent"),
			},
		}),
	});
	if (result.op !== "terminal_start") throw new Error("Native terminal owner was not started");
	return result.daemon;
}

it("automatically retires a detached native owner and preserves its actor identity, journal and unsent draft", async () => {
	await withTerminalBroker(async fixture => {
		const subscriptionId = crypto.randomUUID();
		const owner = await start(fixture, subscriptionId);
		await fixture.client.request({ op: "terminal_detach", subscriptionId, name: owner.name, id: owner.id });
		const ready = await publication(fixture, owner.name);
		const result = await withTimeout(
			fixture.client.request({ op: "wait", name: owner.name, for: "exit", timeoutMs: 15_000 }),
			20_000,
			"Automatic idle retirement did not settle",
		);
		expect(result.op).toBe("wait");
		if (result.op !== "wait") throw new Error("Unexpected owner wait result");
		expect(result.timedOut).toBe(false);
		expect(result.daemon.exitCode).toBe(0);
		expect(await fs.stat(ready.socketPath).catch(() => undefined)).toBeUndefined();
		const resumed = await SessionManager.open(ready.sessionFile, undefined, new FileSessionStorage(), {
			ownershipPolicy: "require-owner",
		});
		try {
			expect(resumed.getSessionId()).toBe(ready.sessionId);
			expect(resumed.getSessionIdentityMetadata()).toMatchObject({
				actorHandle: "idle-fixture",
				idleSleepSeconds: 1,
			});
			expect(await resumed.consumeDraft()).toBe("retain this unsent draft");
			expect(await Bun.file(ready.sessionFile).text()).toContain("retain this conversation");
			expect((await fs.readdir(path.dirname(ready.sessionFile))).filter(name => name.endsWith(".jsonl"))).toEqual([
				path.basename(ready.sessionFile),
			]);
		} finally {
			await resumed.close();
		}
		fixture.client.close();
		await withTimeout(
			fixture.stopped,
			10_000,
			"Empty native broker did not retire after its owner and last viewer left",
		);
	});
}, 35_000);

it("keeps a native owner alive past its configured deadline while a terminal viewer remains attached", async () => {
	await withTerminalBroker(async fixture => {
		const owner = await start(fixture, crypto.randomUUID());
		const ready = await publication(fixture, owner.name);
		const result = await fixture.client.request({ op: "wait", name: owner.name, for: "exit", timeoutMs: 1500 });
		if (result.op !== "wait") throw new Error("Unexpected owner wait result");
		expect(result.timedOut).toBe(true);
		expect(await Bun.file(ready.sessionFile).exists()).toBe(true);
		expect(await fs.stat(ready.socketPath).catch(() => undefined)).toBeDefined();
	});
}, 25_000);

it("keeps a detached terminal owner alive for an RPC viewer, then retires after that viewer leaves", async () => {
	await withTerminalBroker(async fixture => {
		const subscriptionId = crypto.randomUUID();
		const owner = await start(fixture, subscriptionId);
		await fixture.client.request({ op: "terminal_detach", subscriptionId, name: owner.name, id: owner.id });
		const ready = await publication(fixture, owner.name);
		const viewer = await IpcConnection.connect(ready.socketPath, { framing: "lines", timeoutMs: 2000 });
		const accepted = Promise.withResolvers<void>();
		viewer.start(
			line => {
				const frame: unknown = JSON.parse(line);
				if (isRecord(frame) && frame.type === "ready") accepted.resolve();
			},
			() => {},
		);
		try {
			await withTimeout(accepted.promise, 2000, "RPC viewer was not admitted");
			const held = await fixture.client.request({ op: "wait", name: owner.name, for: "exit", timeoutMs: 1500 });
			if (held.op !== "wait") throw new Error("Unexpected owner wait result");
			expect(held.timedOut).toBe(true);
		} finally {
			viewer.destroy();
		}
		const retired = await fixture.client.request({ op: "wait", name: owner.name, for: "exit", timeoutMs: 15_000 });
		if (retired.op !== "wait") throw new Error("Unexpected owner wait result");
		expect(retired.timedOut).toBe(false);
		expect(retired.daemon.exitCode).toBe(0);
	});
}, 35_000);
