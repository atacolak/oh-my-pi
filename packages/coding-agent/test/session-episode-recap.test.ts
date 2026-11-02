/**
 * A completed episode's recap must not depend on the session going idle.
 *
 * The idle path only arms once the run that produced `agent_end` has unwound and
 * nothing is admitted, queued or scheduled, so an actor that starts its next run
 * within a second never armed one at all: of 121 measured episodes whose next run
 * began inside five seconds, none had a recap. These tests pin the replacement
 * contract: the episode that just closed gets its recap at once, addressed by that
 * episode's id, and the next run neither cancels it nor receives it.
 */

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockModelOptions } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	closeSessionIndex,
	listSessionEpisodes,
	listSessionRecaps,
	type SessionEpisode,
} from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir, Snowflake } from "@oh-my-pi/pi-utils";

setDefaultTimeout(20_000);

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let root = "";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-episode-recap-"));
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	setAgentDir(path.join(root, "agent"));
	closeSessionIndex();
});

afterEach(() => {
	closeSessionIndex();
	removeSyncWithRetries(root);
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	setAgentDir(originalAgentDir ?? path.join(getConfigRootDir(), "agent"));
});

function recapOf(rows: readonly SessionEpisode[], episodeId: string): string | null {
	const row = rows.find(entry => entry.episodeId === episodeId);
	if (!row) throw new Error(`no episode row for ${episodeId}`);
	return row.recap;
}

/**
 * Await the real signal the contract owes, but fail the test quickly with the
 * broken promise named instead of leaning on the suite timeout. The timer only
 * bounds a stalled await; the wait itself ends on the event.
 */
async function within<T>(promise: Promise<T>, owed: string, timeoutMs = 2_000): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`timed out waiting for ${owed}`)), timeoutMs);
	try {
		return await Promise.race([promise, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	sideMock: MockModel;
	episodeIds: () => string[];
	recaps: string[];
	nextRecaps: (count: number) => Promise<void>;
	dispose: () => Promise<void>;
}

/**
 * One episode per prompt. The primary mock answers the run; the side mock answers
 * the recap side turns, one per call, and can hold an individual reply open so a
 * test can prove the next run does not cancel work already in flight.
 */
async function createHarness(options?: {
	persist?: boolean;
	settings?: Record<string, unknown>;
	sideHandler?: MockModelOptions["handler"];
}): Promise<Harness> {
	const cwd = path.join(root, "cwd");
	fs.mkdirSync(cwd, { recursive: true });
	const authStorage = await AuthStorage.create(path.join(root, `auth-${Snowflake.next()}.db`));
	authStorage.keys.setRuntime("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	const primaryMock = createMockModel({ provider: "anthropic", handler: () => ({ content: ["acknowledged"] }) });
	let sideCalls = 0;
	const sideMock = createMockModel({
		provider: "anthropic",
		handler: options?.sideHandler ?? (() => ({ content: [`recap ${++sideCalls}`] })),
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: primaryMock, systemPrompt: ["Test"], tools: [] },
		streamFn: primaryMock.stream,
	});
	const sessionManager =
		options?.persist === false
			? SessionManager.inMemory(cwd)
			: SessionManager.create(cwd, path.join(root, "sessions"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"contextPromotion.enabled": false,
		"goal.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"recap.enabled": true,
		...options?.settings,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		sideStreamFn: sideMock.stream,
	});
	const recaps: string[] = [];
	const waiters = new Set<{ count: number; resolve: () => void }>();
	session.enableIdleMaintenance({
		onRecap: recap => {
			recaps.push(recap);
			for (const waiter of waiters) {
				if (recaps.length < waiter.count) continue;
				waiters.delete(waiter);
				waiter.resolve();
			}
		},
	});
	return {
		session,
		sessionManager,
		sideMock,
		episodeIds: () => listSessionEpisodes(sessionManager.getSessionId()).map(episode => episode.episodeId),
		recaps,
		nextRecaps: count => {
			if (recaps.length >= count) return Promise.resolve();
			const waiter = Promise.withResolvers<void>();
			const entry = { count, resolve: waiter.resolve };
			waiters.add(entry);
			return waiter.promise;
		},
		dispose: async () => {
			await session.dispose();
			authStorage.close();
			await sessionManager.close().catch(() => undefined);
		},
	};
}

describe("episode recaps", () => {
	it("records the recap of an episode whose next run starts immediately", async () => {
		let sideCalls = 0;
		const firstReply = Promise.withResolvers<void>();
		const firstRequest = Promise.withResolvers<void>();
		const secondRequest = Promise.withResolvers<void>();
		const harness = await createHarness({
			// Hold the first recap open: the second run starts, runs to completion and
			// settles before the first recap's reply lands. A recap that respected the
			// idle gate or the next turn's start would never be recorded here.
			sideHandler: async () => {
				const call = ++sideCalls;
				if (call === 1) firstRequest.resolve();
				if (call === 2) secondRequest.resolve();
				if (call === 1) await firstReply.promise;
				return { content: [`recap ${call}`] };
			},
		});
		try {
			await harness.session.prompt("first episode");
			const [firstEpisodeId] = harness.episodeIds();
			expect(firstEpisodeId).toBeDefined();
			await within(firstRequest.promise, "the first episode's recap request");

			await harness.session.prompt("second episode");
			const [secondEpisodeId] = harness.episodeIds().filter(id => id !== firstEpisodeId);
			expect(secondEpisodeId).toBeDefined();
			await within(secondRequest.promise, "the second episode's recap request");

			firstReply.resolve();
			await within(harness.nextRecaps(2), "both recaps to land");

			const rows = listSessionEpisodes(harness.sessionManager.getSessionId());
			expect(recapOf(rows, firstEpisodeId!)).toBe("recap 1");
			expect(recapOf(rows, secondEpisodeId!)).toBe("recap 2");
		} finally {
			firstReply.resolve();
			await harness.dispose();
		}
	});

	it("lands two back-to-back recaps on their own episodes", async () => {
		const harness = await createHarness();
		try {
			await harness.session.prompt("first episode");
			const [firstEpisodeId] = harness.episodeIds();
			await harness.session.prompt("second episode");
			const [secondEpisodeId] = harness.episodeIds().filter(id => id !== firstEpisodeId);
			expect(secondEpisodeId).toBeDefined();

			await within(harness.nextRecaps(2), "both recaps to land");

			const rows = listSessionEpisodes(harness.sessionManager.getSessionId());
			expect(recapOf(rows, firstEpisodeId!)).toBe("recap 1");
			expect(recapOf(rows, secondEpisodeId!)).toBe("recap 2");
		} finally {
			await harness.dispose();
		}
	});

	it("fires once for an episode that then leaves the session idle", async () => {
		const harness = await createHarness({ settings: { "recap.idleSeconds": 1 } });
		try {
			await harness.session.prompt("only episode");
			const [episodeId] = harness.episodeIds();
			await harness.nextRecaps(1);

			// The production delay is a real `setTimeout` armed by the session's own
			// settlement chain, so crossing it needs the platform clock: wait past the
			// configured second and prove the delayed path did not repeat answered work.
			await Bun.sleep(1_500);

			expect(harness.sideMock.calls).toHaveLength(1);
			expect(harness.recaps).toHaveLength(1);
			const journal = listSessionRecaps({ sessionIds: [harness.sessionManager.getSessionId()] });
			expect(journal).toHaveLength(1);
			const rows = listSessionEpisodes(harness.sessionManager.getSessionId());
			expect(recapOf(rows, episodeId!)).toBe("recap 1");
		} finally {
			await harness.dispose();
		}
	});

	it("keeps one recap per episode across a duplicate report and a reload", async () => {
		const harness = await createHarness();
		let reloaded: SessionManager | undefined;
		try {
			await harness.session.prompt("only episode");
			const [episodeId] = harness.episodeIds();
			await within(harness.nextRecaps(1), "the episode recap");
			const sessionId = harness.sessionManager.getSessionId();
			const sessionFile = harness.sessionManager.getSessionFile();
			expect(sessionFile).toBeDefined();

			// A replayed report for the same episode is a no-op: the first reply wins.
			harness.sessionManager.recordEpisodeRecap(episodeId!, "replayed reply");

			// A reloaded manager holds no live episode, so a late reporter cannot
			// address that row a second time.
			reloaded = await SessionManager.open(sessionFile!, undefined, undefined, {
				suppressBreadcrumb: true,
			});
			expect(reloaded.episodeId).toBeNull();
			reloaded.recordEpisodeRecap(episodeId!, "reloaded reply");

			const rows = listSessionEpisodes(sessionId);
			expect(recapOf(rows, episodeId!)).toBe("recap 1");
			expect(listSessionRecaps({ sessionIds: [sessionId] })).toHaveLength(1);
		} finally {
			await reloaded?.close().catch(() => undefined);
			await harness.dispose();
		}
	});

	it("keeps the delayed idle recap for a session that never opens episodes", async () => {
		// In-memory sessions have no episode rows; their recap remains the delayed
		// idle one, so the older behaviour must still reach `onRecap`.
		const harness = await createHarness({ persist: false, settings: { "recap.idleSeconds": 1 } });
		try {
			await harness.session.prompt("only episode");
			expect(harness.episodeIds()).toHaveLength(0);

			await harness.nextRecaps(1);
			expect(harness.sideMock.calls).toHaveLength(1);
		} finally {
			await harness.dispose();
		}
	});
});
