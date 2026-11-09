/**
 * The episode recap is fired from the `agent_end` snapshot itself, so it must not
 * wait for the session to go quiet and it must not be re-requested when the same
 * completed episode settles again. These cases drive the maintenance unit with a
 * host that never becomes idle, which is exactly the shape of the starvation: a
 * busy actor whose next run is admitted before the previous one unwinds.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	AgentSessionEvent,
	AgentSessionEventListener,
} from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { IdleMaintenance, type IdleMaintenanceSession } from "@oh-my-pi/pi-coding-agent/session/idle-maintenance";

const model = createMockModel({ provider: "anthropic" }) as Model<string>;

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "work done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface Host {
	host: IdleMaintenanceSession;
	emit: (event: AgentSessionEvent) => void;
	setEpisode: (episodeId: string | null) => void;
	ephemeralCalls: string[];
	records: Array<{ episodeId: string; recap: string }>;
	nextRecord: (count: number) => Promise<void>;
}

/**
 * A session that is busy for the whole test: idle never arrives, so only work
 * dispatched straight from `agent_end` can run.
 */
function createHost(initialEpisodeId: string | null): Host {
	const listeners = new Set<AgentSessionEventListener>();
	let episodeId = initialEpisodeId;
	const idleNeverArrives = Promise.withResolvers<void>();
	const ephemeralCalls: string[] = [];
	const records: Array<{ episodeId: string; recap: string }> = [];
	const recordWaiters = new Set<{ count: number; resolve: () => void }>();
	const nextRecord = (count: number) => {
		if (records.length >= count) return Promise.resolve();
		const waiter = Promise.withResolvers<void>();
		recordWaiters.add({ count, resolve: waiter.resolve });
		return waiter.promise;
	};
	const host = {
		settings: Settings.isolated({ "recap.enabled": true }),
		sessionManager: {
			get episodeId() {
				return episodeId;
			},
			getSessionName: () => "test session",
			recordEpisodeRecap: (episode: string, recap: string) => {
				records.push({ episodeId: episode, recap });
				for (const waiter of recordWaiters) {
					if (records.length < waiter.count) continue;
					recordWaiters.delete(waiter);
					waiter.resolve();
				}
				return true;
			},
		},
		isStreaming: true,
		hasAdmittedSubmission: true,
		queuedMessageCount: 0,
		hasPendingAsyncWork: () => false,
		settleAsyncWork: async () => {},
		isCompacting: false,
		isSessionTransitioning: false,
		model,
		messages: [] as AgentMessage[],
		subscribe: (listener: AgentSessionEventListener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		waitForIdle: () => idleNeverArrives.promise,
		waitForAdmittedSubmissions: () => idleNeverArrives.promise,
		getContextUsage: () => undefined,
		getGoalModeState: () => undefined,
		getTodoPhases: () => [],
		runIdleCompaction: async () => {},
		promptCacheEntry: undefined,
		runEphemeralTurn: async (options: { promptText: string }) => {
			ephemeralCalls.push(options.promptText);
			return { replyText: "recap text", assistantMessage: assistantMessage() };
		},
	};
	return {
		host: host as unknown as IdleMaintenanceSession,
		emit: event => {
			for (const listener of listeners) listener(event);
		},
		setEpisode: id => {
			episodeId = id;
		},
		ephemeralCalls,
		records,
		nextRecord,
	};
}

let maintenance: IdleMaintenance | undefined;

afterEach(() => {
	maintenance?.dispose();
	maintenance = undefined;
});

describe("idle maintenance episode recap", () => {
	it("records the completed episode without waiting for the session to go idle", async () => {
		const host = createHost("episode:one");
		maintenance = new IdleMaintenance(host.host, {});

		host.emit({ type: "agent_end", messages: [assistantMessage()], isTerminal: true });
		await host.nextRecord(1);

		expect(host.ephemeralCalls).toHaveLength(1);
		expect(host.records).toEqual([{ episodeId: "episode:one", recap: "recap text" }]);
	});

	it("requests the recap once when the same episode settles twice", async () => {
		const host = createHost("episode:one");
		maintenance = new IdleMaintenance(host.host, {});

		const event: AgentSessionEvent = { type: "agent_end", messages: [assistantMessage()], isTerminal: true };
		host.emit(event);
		host.emit(event);
		await host.nextRecord(1);

		expect(host.ephemeralCalls).toHaveLength(1);
		expect(host.records).toHaveLength(1);
	});

	it("recaps the episode a retry reopens, not the attempt it replaced", async () => {
		const host = createHost("episode:failed-attempt");
		maintenance = new IdleMaintenance(host.host, {});

		// A failed attempt settles without closing its row; the retry reopens a new
		// episode and only that one is a completed run.
		host.emit({ type: "agent_end", messages: [assistantMessage()], isTerminal: false });
		host.setEpisode("episode:retry");
		host.emit({ type: "agent_start" });
		host.emit({ type: "agent_end", messages: [assistantMessage()], isTerminal: true });
		await host.nextRecord(1);

		expect(host.records).toEqual([{ episodeId: "episode:retry", recap: "recap text" }]);
	});

	it("leaves a settling run that continues to the idle path", async () => {
		const host = createHost("episode:one");
		maintenance = new IdleMaintenance(host.host, {});

		host.emit({ type: "agent_end", messages: [assistantMessage()], isTerminal: false });

		expect(host.ephemeralCalls).toHaveLength(0);
		expect(host.records).toHaveLength(0);
	});
});
