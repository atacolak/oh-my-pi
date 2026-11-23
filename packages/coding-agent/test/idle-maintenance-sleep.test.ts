import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import {
	cfgSessionIdleSleepSeconds,
	getSessionIdleSleepSeconds,
} from "@oh-my-pi/pi-coding-agent/session/idle-sleep-policy";
import {
	IdleMaintenance,
	type IdleMaintenanceSession,
	type IdleSleepOptions,
} from "@oh-my-pi/pi-coding-agent/session/idle-maintenance";

const RETRY_MS = 60_000;
const OPERATOR_DEFAULT_SECONDS = 3600;
const TIMER_CEILING_MS = 2_147_483_647;
const CLOCK_START_MS = 1_000_000_000;

/** Fake timers do not flush the promise continuations a fired deadline starts, so drain them explicitly. */
async function flushMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

interface Policy {
	seconds: number;
	canExit: boolean;
}

interface Harness {
	maintenance: IdleMaintenance;
	policy: Policy;
	decisions: Array<PromiseWithResolvers<boolean>>;
	/** Guards captured from each `exit` invocation, in call order. */
	guards: Array<() => boolean>;
	get exitCalls(): number;
	get compactionCalls(): number;
	emit(event: AgentSessionEvent): void;
}

interface HarnessOptions {
	/** Fixed seconds, or a live probe such as the operator's configured default. */
	seconds?: number | (() => number);
	canExit?: boolean;
	settings?: Settings | Record<string, boolean | number>;
	contextTokens?: number;
	/** Leading `exit` invocations that reject instead of awaiting a decision. */
	exitFailures?: number;
}

function createHarness(options: HarnessOptions = {}): Harness {
	const settings = options.settings instanceof Settings ? options.settings : Settings.isolated(options.settings ?? {});
	const policy: Policy = {
		seconds: typeof options.seconds === "number" ? options.seconds : 0,
		canExit: options.canExit ?? true,
	};
	const readSeconds = typeof options.seconds === "function" ? options.seconds : () => policy.seconds;
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const decisions: Array<PromiseWithResolvers<boolean>> = [];
	const guards: Array<() => boolean> = [];
	const exitFailures = options.exitFailures ?? 0;
	let compactionCalls = 0;
	const session = {
		settings,
		isStreaming: false,
		hasAdmittedSubmission: false,
		queuedMessageCount: 0,
		hasPendingAsyncWork: () => false,
		settleAsyncWork: async () => {},
		waitForIdle: async () => {},
		waitForAdmittedSubmissions: async () => {},
		messages: [],
		model: undefined,
		getContextUsage: () => {
			if (options.contextTokens === undefined) return undefined;
			return { tokens: options.contextTokens };
		},
		runIdleCompaction: async () => {
			compactionCalls++;
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as IdleMaintenanceSession;
	const sleep: IdleSleepOptions = {
		seconds: () => readSeconds(),
		canExit: () => policy.canExit,
		exit: canExit => {
			guards.push(canExit);
			if (guards.length <= exitFailures) return Promise.reject(new Error("retirement failed"));
			const decision = Promise.withResolvers<boolean>();
			decisions.push(decision);
			return decision.promise;
		},
	};
	const maintenance = new IdleMaintenance(session, { sleep });
	return {
		maintenance,
		policy,
		decisions,
		guards,
		get exitCalls() {
			return guards.length;
		},
		get compactionCalls() {
			return compactionCalls;
		},
		emit: event => {
			for (const listener of listeners) listener(event);
		},
	};
}

describe("IdleMaintenance idle sleep", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setSystemTime(CLOCK_START_MS);
	});

	afterEach(() => {
		vi.useRealTimers();
		setSystemTime();
	});

	it("never retires when the configured timeout is disabled", () => {
		const harness = createHarness({ seconds: 0 });
		vi.advanceTimersByTime(4 * 60 * 60 * 1000);
		expect(harness.exitCalls).toBe(0);
		harness.maintenance.dispose();
	});

	it("observes an owner Settings change without a renderer refresh and keeps the existing idle age", async () => {
		const settings = Settings.isolated({ "session.idleSleepSeconds": 0 });
		const harness = createHarness({ settings, seconds: () => getSessionIdleSleepSeconds(settings) });
		try {
			vi.advanceTimersByTime(60_000);
			cfgSessionIdleSleepSeconds.override(settings, 90);
			await flushMicrotasks();
			vi.advanceTimersByTime(29_000);
			expect(harness.exitCalls).toBe(0);
			vi.advanceTimersByTime(1_000);
			expect(harness.exitCalls).toBe(1);
		} finally {
			harness.maintenance.dispose();
		}
	});

	it("retires once the idle deadline elapses", () => {
		const harness = createHarness({ seconds: 60 });
		vi.advanceTimersByTime(59_000);
		expect(harness.exitCalls).toBe(0);
		vi.advanceTimersByTime(1_000);
		expect(harness.exitCalls).toBe(1);
		vi.advanceTimersByTime(4 * 60 * 60 * 1000);
		expect(harness.exitCalls).toBe(1);
	});

	it("retires at the operator default idle timeout", () => {
		const settings = Settings.isolated({});
		const harness = createHarness({ seconds: () => getSessionIdleSleepSeconds(settings) });
		vi.advanceTimersByTime(OPERATOR_DEFAULT_SECONDS * 1000 - 1_000);
		expect(harness.exitCalls).toBe(0);
		vi.advanceTimersByTime(1_000);
		expect(harness.exitCalls).toBe(1);
	});

	it("resets the deadline on terminal activity", () => {
		const harness = createHarness({ seconds: 60 });
		vi.advanceTimersByTime(40_000);
		harness.maintenance.recordActivity();
		vi.advanceTimersByTime(59_000);
		expect(harness.exitCalls).toBe(0);
		vi.advanceTimersByTime(1_000);
		expect(harness.exitCalls).toBe(1);
	});

	it("resets the deadline on session activity", () => {
		const harness = createHarness({ seconds: 60 });
		vi.advanceTimersByTime(40_000);
		harness.emit({ type: "agent_start" });
		vi.advanceTimersByTime(59_000);
		expect(harness.exitCalls).toBe(0);
		vi.advanceTimersByTime(1_000);
		expect(harness.exitCalls).toBe(1);
	});

	it("does not extend the deadline when the owner refreshes", async () => {
		const harness = createHarness({ seconds: 60 });
		harness.emit({ type: "agent_end", messages: [] });
		await flushMicrotasks();
		vi.advanceTimersByTime(10_000);
		harness.maintenance.refresh();
		vi.advanceTimersByTime(10_000);
		harness.maintenance.refresh();
		vi.advanceTimersByTime(39_000);
		expect(harness.exitCalls).toBe(0);
		vi.advanceTimersByTime(1_000);
		expect(harness.exitCalls).toBe(1);
	});

	it("observes a longer timeout without restarting the idle window", () => {
		const harness = createHarness({ seconds: 60 });
		vi.advanceTimersByTime(30_000);
		harness.policy.seconds = 120;
		harness.maintenance.refresh();
		vi.advanceTimersByTime(89_000);
		expect(harness.exitCalls).toBe(0);
		vi.advanceTimersByTime(1_000);
		expect(harness.exitCalls).toBe(1);
	});

	it("enables a disabled timeout without restarting the idle window", () => {
		const harness = createHarness({ seconds: 0 });
		vi.advanceTimersByTime(20_000);
		harness.policy.seconds = 60;
		harness.maintenance.refresh();
		vi.advanceTimersByTime(39_000);
		expect(harness.exitCalls).toBe(0);
		vi.advanceTimersByTime(1_000);
		expect(harness.exitCalls).toBe(1);
	});

	it("disables an awaited retirement decision", async () => {
		const harness = createHarness({ seconds: 60 });
		vi.advanceTimersByTime(60_000);
		expect(harness.exitCalls).toBe(1);
		const guard = harness.guards[0];
		expect(guard()).toBe(true);

		harness.policy.seconds = 0;
		harness.maintenance.refresh();
		expect(guard()).toBe(false);
		harness.decisions[0].resolve(false);
		await flushMicrotasks();

		vi.advanceTimersByTime(4 * 60 * 60 * 1000);
		expect(harness.exitCalls).toBe(1);
	});

	it("invalidates an awaited close when the timeout grows", async () => {
		const harness = createHarness({ seconds: 60 });
		vi.advanceTimersByTime(60_000);
		expect(harness.exitCalls).toBe(1);
		const guard = harness.guards[0];
		expect(guard()).toBe(true);

		harness.policy.seconds = 120;
		harness.maintenance.refresh();
		expect(guard()).toBe(false);
		harness.decisions[0].resolve(false);
		await flushMicrotasks();

		vi.advanceTimersByTime(59_000);
		expect(harness.exitCalls).toBe(1);
		vi.advanceTimersByTime(1_000);
		expect(harness.exitCalls).toBe(2);
	});

	it("treats a veto at the deadline as activity", () => {
		const harness = createHarness({ seconds: 300, canExit: false });
		vi.advanceTimersByTime(300_000);
		expect(harness.exitCalls).toBe(0);
		harness.policy.canExit = true;
		vi.advanceTimersByTime(299_000);
		expect(harness.exitCalls).toBe(0);
		vi.advanceTimersByTime(1_000);
		expect(harness.exitCalls).toBe(1);
	});

	it("yields an awaitable retirement decision to new activity", async () => {
		const harness = createHarness({ seconds: 60 });
		vi.advanceTimersByTime(60_000);
		expect(harness.exitCalls).toBe(1);
		const terminalGuard = harness.guards[0];
		expect(terminalGuard()).toBe(true);

		harness.maintenance.recordActivity();
		expect(terminalGuard()).toBe(false);
		harness.decisions[0].resolve(false);
		await flushMicrotasks();

		vi.advanceTimersByTime(60_000);
		expect(harness.exitCalls).toBe(2);
		const sessionActivityGuard = harness.guards[1];
		expect(sessionActivityGuard()).toBe(true);

		harness.emit({ type: "agent_start" });
		expect(sessionActivityGuard()).toBe(false);
		harness.decisions[1].resolve(false);
		await flushMicrotasks();

		vi.advanceTimersByTime(60_000);
		expect(harness.exitCalls).toBe(3);
		harness.decisions[2].resolve(true);
		await flushMicrotasks();
	});

	it("runs one retirement attempt at a time", () => {
		const harness = createHarness({ seconds: 60 });
		vi.advanceTimersByTime(60_000);
		expect(harness.exitCalls).toBe(1);
		harness.maintenance.recordActivity();
		vi.advanceTimersByTime(10 * 60_000);
		expect(harness.exitCalls).toBe(1);
	});

	it("clamps a long timeout to the native timer ceiling", () => {
		const seconds = 3_000_000;
		const harness = createHarness({ seconds });
		vi.advanceTimersByTime(TIMER_CEILING_MS);
		expect(harness.exitCalls).toBe(0);
		vi.advanceTimersByTime(seconds * 1000 - TIMER_CEILING_MS);
		expect(harness.exitCalls).toBe(1);
	});

	it("retries a failing retirement instead of disarming it", async () => {
		const harness = createHarness({ seconds: 60, exitFailures: 1 });
		vi.advanceTimersByTime(60_000);
		expect(harness.exitCalls).toBe(1);
		await flushMicrotasks();
		vi.advanceTimersByTime(RETRY_MS);
		expect(harness.exitCalls).toBe(2);
	});

	it("keeps the retirement deadline when idle maintenance completes", async () => {
		const harness = createHarness({
			seconds: 180,
			contextTokens: 500,
			settings: {
				"compaction.idleEnabled": true,
				"compaction.idleThresholdTokens": 100,
				"compaction.idleTimeoutSeconds": 60,
			},
		});
		harness.emit({ type: "agent_end", messages: [] });
		await flushMicrotasks();
		vi.advanceTimersByTime(60_000);
		expect(harness.compactionCalls).toBe(1);
		expect(harness.exitCalls).toBe(0);
		vi.advanceTimersByTime(120_000);
		expect(harness.exitCalls).toBe(1);
	});

	it("cancels the armed retirement on disposal", () => {
		const harness = createHarness({ seconds: 60 });
		vi.advanceTimersByTime(30_000);
		harness.maintenance.dispose();
		vi.advanceTimersByTime(4 * 60 * 60 * 1000);
		expect(harness.exitCalls).toBe(0);
	});

	it("closes the pending retirement decision on disposal and never re-arms", async () => {
		const harness = createHarness({ seconds: 60 });
		vi.advanceTimersByTime(60_000);
		expect(harness.exitCalls).toBe(1);
		const guard = harness.guards[0];
		expect(guard()).toBe(true);

		harness.maintenance.dispose();
		expect(guard()).toBe(false);
		harness.decisions[0].resolve(false);
		await flushMicrotasks();

		vi.advanceTimersByTime(4 * 60 * 60 * 1000);
		expect(harness.exitCalls).toBe(1);
	});
});
