import { describe, expect, it } from "bun:test";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { withTimeout } from "@oh-my-pi/pi-utils";
import type { DaemonBrokerClient } from "../../src/launch/client";
import type {
	DaemonOperation,
	DaemonRpcResult,
	DaemonTerminalExitNotification,
	DaemonTerminalNotification,
} from "../../src/launch/protocol";
import {
	runTerminalMirror,
	type TerminalMirrorInput,
	type TerminalMirrorOptions,
	type TerminalMirrorOutput,
	type TerminalMirrorResult,
	type TerminalMirrorSignal,
} from "../../src/launch/terminal-mirror";

const NAME = "mind-fixture";
const ID = "owner-generation";
const SUBSCRIPTION = "view-1";

function snapshot(): DaemonSnapshot {
	return {
		name: NAME,
		id: ID,
		state: "ready",
		createdAt: 1,
		startedAt: 2,
		restartCount: 0,
		outputBytes: 0,
		persist: true,
		detached: false,
	};
}

type Sink = (frame: DaemonTerminalNotification) => void;

interface FakeBroker {
	readonly client: DaemonBrokerClient;
	readonly operations: DaemonOperation[];
	readonly sinks: Map<string, Sink>;
	closed: boolean;
	emit(frame: DaemonTerminalNotification): void;
	waitForOperation(
		predicate: (operation: DaemonOperation) => boolean,
		message: string,
	): Promise<DaemonOperation>;
}

function fakeBroker(options: { rejectSend?: boolean } = {}): FakeBroker {
	const operations: DaemonOperation[] = [];
	const sinks = new Map<string, Sink>();
	const waiters: Array<{ predicate: (operation: DaemonOperation) => boolean; resolve: () => void }> = [];
	const notify = (operation: DaemonOperation): void => {
		operations.push(operation);
		for (let index = waiters.length - 1; index >= 0; index--) {
			if (!waiters[index]!.predicate(operation)) continue;
			waiters.splice(index, 1)[0]!.resolve();
		}
	};
	const state = { closed: false };
	const client = {
		subscribeTerminal(subscriptionId: string, sink: Sink) {
			sinks.set(subscriptionId, sink);
			return () => {
				sinks.delete(subscriptionId);
			};
		},
		async request(operation: DaemonOperation): Promise<DaemonRpcResult> {
			notify(operation);
			if (options.rejectSend && operation.op === "send") throw new Error("stale terminal generation");
			switch (operation.op) {
				case "terminal_attach":
					return { op: "terminal_attach", daemon: snapshot(), columns: operation.columns, rows: operation.rows };
				case "terminal_resize":
					return {
						op: "terminal_resize",
						subscriptionId: operation.subscriptionId,
						name: operation.name,
						id: operation.id,
						columns: operation.columns,
						rows: operation.rows,
					};
				case "terminal_detach":
					return {
						op: "terminal_detach",
						subscriptionId: operation.subscriptionId,
						name: operation.name,
						id: operation.id,
					};
				case "terminal_ack":
					return {
						op: "terminal_ack",
						subscriptionId: operation.subscriptionId,
						name: operation.name,
						id: operation.id,
						sequence: operation.sequence,
					};
				case "send":
					return { op: "send", daemon: snapshot() };
				default:
					throw new Error(`unexpected fake broker operation ${operation.op}`);
			}
		},
		close() {
			state.closed = true;
		},
	};
	return {
		client: client as unknown as DaemonBrokerClient,
		operations,
		sinks,
		emit(frame: DaemonTerminalNotification) {
			for (const sink of sinks.values()) sink(frame);
		},
		waitForOperation(predicate, message) {
			const observed = operations.find(predicate);
			if (observed) return Promise.resolve(observed);
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ predicate, resolve });
			return withTimeout(promise, 2_000, message).then(() => operations.find(predicate)!);
		},
		get closed() {
			return state.closed;
		},
	};
}

class FakeTerminal implements TerminalMirrorInput, TerminalMirrorOutput {
	readonly writes: string[] = [];
	readonly rawModes: boolean[] = [];
	restores = 0;
	pauses = 0;
	acceptWrites = true;
	#data: ((data: string) => void) | undefined;
	#resize: (() => void) | undefined;
	#signal: ((signal: TerminalMirrorSignal) => void) | undefined;
	#drain: (() => void) | undefined;

	onData = (listener: (data: string) => void): (() => void) => {
		this.#data = listener;
		return () => {
			this.#data = undefined;
		};
	};
	setRawMode(raw: boolean): void {
		this.rawModes.push(raw);
	}
	resume(): void {}
	pause(): void {
		this.pauses++;
	}
	write(data: string): boolean {
		this.writes.push(data);
		return this.acceptWrites;
	}
	onDrain = (listener: () => void): (() => void) => {
		this.#drain = listener;
		return () => {
			this.#drain = undefined;
		};
	};
	onResize = (listener: () => void): (() => void) => {
		this.#resize = listener;
		return () => {
			this.#resize = undefined;
		};
	};
	onSignal = (listener: (signal: TerminalMirrorSignal) => void): (() => void) => {
		this.#signal = listener;
		return () => {
			this.#signal = undefined;
		};
	};
	restore = (): void => {
		this.restores++;
	};
	type(data: string): void {
		this.#data?.(data);
	}
	resize(): void {
		this.#resize?.();
	}
	signal(signal: TerminalMirrorSignal): void {
		this.#signal?.(signal);
	}
	drain(): void {
		this.#drain?.();
	}
}

function startMirror(
	terminal: FakeTerminal,
	client: DaemonBrokerClient,
	overrides: Partial<TerminalMirrorOptions> = {},
): Promise<TerminalMirrorResult> {
	return runTerminalMirror({
		client,
		name: NAME,
		id: ID,
		subscriptionId: SUBSCRIPTION,
		input: terminal,
		output: terminal,
		size: () => ({ columns: 120, rows: 40 }),
		onResize: terminal.onResize,
		onSignal: terminal.onSignal,
		restore: terminal.restore,
		...overrides,
	});
}

function outputFrame(sequence: number, data: string): DaemonTerminalNotification {
	return { event: "terminal_output", subscriptionId: SUBSCRIPTION, name: NAME, id: ID, sequence, data };
}

function exitFrame(exitCode: number): DaemonTerminalExitNotification {
	return {
		event: "terminal_exit",
		subscriptionId: SUBSCRIPTION,
		name: NAME,
		id: ID,
		exitCode,
		reason: "exit",
	};
}

describe("a terminal mirror", () => {
	it("writes streamed output in order and acknowledges after each local write", async () => {
		const broker = fakeBroker();
		const terminal = new FakeTerminal();
		const running = startMirror(terminal, broker.client);
		await broker.waitForOperation(operation => operation.op === "terminal_attach", "mirror never attached");

		broker.emit(outputFrame(7, "first"));
		broker.emit(outputFrame(8, "second"));
		const acked = await broker.waitForOperation(
			operation => operation.op === "terminal_ack" && operation.sequence === 8,
			"second frame was never acknowledged",
		);
		expect(acked.op).toBe("terminal_ack");
		expect(terminal.writes.join("")).toBe("firstsecond");
		expect(
			broker.operations.flatMap(operation => (operation.op === "terminal_ack" ? [operation.sequence] : [])),
		).toEqual([7, 8]);
		expect(broker.operations.some(operation => operation.op === "stop")).toBe(false);

		broker.emit(exitFrame(0));
		expect(await running).toEqual({ detached: false, exitCode: 0, reason: "exit" });
		expect(terminal.rawModes.at(-1)).toBe(false);
		expect(broker.closed).toBe(true);
		expect(broker.operations.some(operation => operation.op === "terminal_detach")).toBe(false);
	});

	it("waits for a local drain before acknowledging a backpressured write", async () => {
		const broker = fakeBroker();
		const terminal = new FakeTerminal();
		terminal.acceptWrites = false;
		const running = startMirror(terminal, broker.client);
		await broker.waitForOperation(operation => operation.op === "terminal_attach", "mirror never attached");

		broker.emit(outputFrame(9, "blocked"));
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(terminal.writes).toEqual(["blocked"]);
		expect(broker.operations.some(operation => operation.op === "terminal_ack")).toBe(false);

		terminal.acceptWrites = true;
		terminal.drain();
		await broker.waitForOperation(
			operation => operation.op === "terminal_ack" && operation.sequence === 9,
			"drained frame was never acknowledged",
		);

		broker.emit(exitFrame(0));
		expect(await running).toEqual({ detached: false, exitCode: 0, reason: "exit" });
	});

	it("forwards raw input unchanged, resizes the owner, and detaches on a local hangup", async () => {
		const broker = fakeBroker();
		const terminal = new FakeTerminal();
		const running = startMirror(terminal, broker.client);
		await broker.waitForOperation(operation => operation.op === "terminal_attach", "mirror never attached");

		terminal.type("\u0003λ");
		const sent = await broker.waitForOperation(operation => operation.op === "send", "input was never forwarded");
		expect(sent).toEqual({ op: "send", name: NAME, id: ID, data: "\u0003λ" });

		terminal.resize();
		const resized = await broker.waitForOperation(
			operation => operation.op === "terminal_resize",
			"resize was never forwarded",
		);
		expect(resized).toEqual({
			op: "terminal_resize",
			subscriptionId: SUBSCRIPTION,
			name: NAME,
			id: ID,
			columns: 120,
			rows: 40,
		});

		terminal.signal("SIGHUP");
		expect(await running).toEqual({ detached: true });
		expect(broker.operations.find(operation => operation.op === "terminal_detach")).toEqual({
			op: "terminal_detach",
			subscriptionId: SUBSCRIPTION,
			name: NAME,
			id: ID,
		});
		expect(terminal.rawModes).toEqual([true, false]);
		expect(terminal.restores).toBe(1);
		expect(terminal.pauses).toBe(1);
		expect(broker.closed).toBe(true);
		expect(broker.operations.some(operation => operation.op === "stop")).toBe(false);
	});

	it("detaches only itself when its renderer refresh fails", async () => {
		const broker = fakeBroker();
		const terminal = new FakeTerminal();
		const order: string[] = [];
		const running = startMirror(terminal, broker.client, {
			refresh: async () => {
				order.push("refresh");
				throw new Error("refresh refused");
			},
		});
		await expect(running).rejects.toThrow("refresh refused");
		expect(order).toEqual(["refresh"]);
		expect(broker.operations[0]?.op).toBe("terminal_attach");
		expect(broker.operations.filter(operation => operation.op === "terminal_detach")).toHaveLength(1);
		expect(broker.operations.some(operation => operation.op === "stop")).toBe(false);
		expect(broker.closed).toBe(true);
	});

	it("detaches once when repeated local signals arrive together", async () => {
		const broker = fakeBroker();
		const terminal = new FakeTerminal();
		const running = startMirror(terminal, broker.client);
		await broker.waitForOperation(operation => operation.op === "terminal_attach", "mirror never attached");

		terminal.signal("SIGTERM");
		terminal.signal("SIGHUP");
		expect(await running).toEqual({ detached: true });
		expect(broker.operations.filter(operation => operation.op === "terminal_detach")).toHaveLength(1);
		expect(terminal.rawModes).toEqual([true, false]);
		expect(terminal.restores).toBe(1);
		expect(terminal.pauses).toBe(1);
	});

	it("detaches this mirror when the owner rejects forwarded input", async () => {
		const broker = fakeBroker({ rejectSend: true });
		const terminal = new FakeTerminal();
		const running = startMirror(terminal, broker.client);
		await broker.waitForOperation(operation => operation.op === "terminal_attach", "mirror never attached");

		terminal.type("x");
		expect(await running).toEqual({ detached: true });
		expect(broker.operations.filter(operation => operation.op === "terminal_detach")).toHaveLength(1);
		expect(terminal.rawModes.at(-1)).toBe(false);
		expect(broker.closed).toBe(true);
	});
});
