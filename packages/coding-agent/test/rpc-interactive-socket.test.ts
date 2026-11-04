import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	createAgentSessionSocket,
	type RpcSessionSocket,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-socket";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { getProjectDir, setProjectDir, Snowflake, withTimeout } from "@oh-my-pi/pi-utils";
import * as utils from "@oh-my-pi/pi-utils";

type Frame = Record<string, unknown> & { type?: string };

const FRAME_TIMEOUT_MS = 10_000;

class SocketPeer {
	readonly seen: Frame[] = [];
	#queue: Frame[] = [];
	#wake: (() => void) | undefined;
	readonly #closedSignal = Promise.withResolvers<void>();
	closed = false;

	private constructor(private readonly conn: IpcConnection) {}

	static async connect(endpoint: string): Promise<SocketPeer> {
		const conn = await IpcConnection.connect(endpoint, { framing: "lines", timeoutMs: 4000 });
		const peer = new SocketPeer(conn);
		conn.start(
			line => {
				let frame: Frame;
				try {
					frame = JSON.parse(line) as Frame;
				} catch {
					return;
				}
				peer.seen.push(frame);
				peer.#queue.push(frame);
				peer.#wake?.();
			},
			() => {
				peer.closed = true;
				peer.#closedSignal.resolve();
			},
		);
		return peer;
	}

	async next(predicate: (frame: Frame) => boolean, timeoutMs = FRAME_TIMEOUT_MS): Promise<Frame> {
		for (;;) {
			const index = this.#queue.findIndex(predicate);
			if (index >= 0) return this.#queue.splice(index, 1)[0]!;
			const arrived = Promise.withResolvers<void>();
			this.#wake = arrived.resolve;
			await withTimeout(
				arrived.promise,
				timeoutMs,
				`timed out waiting for frame; saw ${JSON.stringify(this.#queue)}`,
			);
			this.#wake = undefined;
		}
	}

	async closedByRemote(timeoutMs = FRAME_TIMEOUT_MS): Promise<void> {
		if (this.closed) return;
		await withTimeout(this.#closedSignal.promise, timeoutMs, "connection did not close");
	}

	send(frame: object): void {
		this.conn.send(JSON.stringify(frame));
	}

	close(): void {
		this.conn.destroy();
	}
}

interface InteractiveFixture {
	session: AgentSession;
	mock: MockModel;
	mode: InteractiveMode;
	socket: RpcSessionSocket;
	dir: string;
	endpoint: string;
	dispose(): Promise<void>;
}

async function createInteractiveFixture(
	responses: MockHandler[],
	subagentEventBus?: EventBus,
): Promise<InteractiveFixture> {
	const dir = path.join(os.tmpdir(), `omp-interactive-socket-${Snowflake.next()}`);
	fs.mkdirSync(dir, { recursive: true });
	const mock = createMockModel({ responses });
	const settings = Settings.isolated({ "compaction.enabled": false });
	const sessionManager = SessionManager.inMemory(dir);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: { getApiKey: () => "test-key" } as never,
		toolRegistry: new Map(),
	});
	session.subscribe(() => {});
	const socket = createAgentSessionSocket(session, { endpointDir: dir });
	const mode = new InteractiveMode(
		session,
		"test",
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		subagentEventBus,
	);
	await mode.attachSessionSocket(socket);
	return {
		session,
		mock,
		mode,
		socket,
		dir,
		endpoint: path.join(dir, `${session.sessionId}.sock`),
		dispose: async () => {
			await socket.close();
			mode.stop();
			await session.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

const frameOf = (peer: SocketPeer, id: string): Promise<Frame> => peer.next(frame => frame.id === id);

function subagentLifecycle(
	sessionFile: string,
	status: SubagentLifecyclePayload["status"] = "started",
	id = "SubagentA",
): SubagentLifecyclePayload {
	return { id, index: 0, agent: "task", agentSource: "bundled", status, sessionFile };
}

function subagentProgress(sessionFile: string, id = "SubagentA"): SubagentProgressPayload {
	return {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		task: "Do work",
		assignment: "Implement work",
		sessionFile,
		progress: {
			index: 0,
			id,
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "Do work",
			assignment: "Implement work",
			description: "Worker",
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		},
	};
}

describe("an interactive session's published endpoint", () => {
	let originalProject: string;
	let fixture: InteractiveFixture | undefined;

	beforeEach(async () => {
		const configRoot = path.join(os.tmpdir(), `omp-interactive-config-${Snowflake.next()}`);
		fs.mkdirSync(configRoot, { recursive: true });
		originalProject = getProjectDir();
		setProjectDir(configRoot);
		spyOn(utils, "getConfigRootDir").mockReturnValue(configRoot);
		resetSettingsForTest();
		await initTheme();
		await Settings.init({ inMemory: true, cwd: configRoot });
	});

	afterEach(async () => {
		await fixture?.dispose();
		fixture = undefined;
		vi.restoreAllMocks();
		resetSettingsForTest();
		setProjectDir(originalProject);
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		AgentStorage.close();
		HistoryStorage.close();
		closeSessionIndex();
		closeModelCache();
	});

	it("serves get_state, a prompt and the live event stream to an attached client", async () => {
		fixture = await createInteractiveFixture([{ content: ["interactive answer"] }]);
		const peer = await SocketPeer.connect(fixture.endpoint);
		try {
			await peer.next(frame => frame.type === "ready");

			peer.send({ id: "state", type: "get_state" });
			const state = await frameOf(peer, "state");
			expect(state.success).toBe(true);
			const data = state.data as Record<string, unknown>;
			expect(data.sessionId).toBe(fixture.session.sessionId);
			expect(data.isStreaming).toBe(false);
			expect(data.sessionFile).toBe(fixture.session.sessionFile);
			expect(data.todoPhases).toEqual([]);
			expect(data.queuedMessages).toEqual({ steering: [], followUp: [], liveSteered: 0 });

			peer.send({ id: "prompt", type: "prompt", message: "hello from the socket" });
			const result = await peer.next(frame => frame.type === "prompt_result" && frame.id === "prompt");
			expect(result).toMatchObject({ type: "prompt_result", status: "completed", agentInvoked: true });

			expect(peer.seen.some(frame => frame.type === "message_start")).toBe(true);
			expect(
				peer.seen.some(
					frame =>
						frame.type === "message_end" &&
						(frame.message as { role?: string } | undefined)?.role === "assistant",
				),
			).toBe(true);
			expect(peer.seen.some(frame => frame.type === "agent_end")).toBe(true);
			expect(fixture.session.agent.state.messages.some(message => message.role === "assistant")).toBe(true);
		} finally {
			peer.close();
		}
	}, 30_000);

	it("serves a second client after the first disconnects", async () => {
		fixture = await createInteractiveFixture([]);
		const first = await SocketPeer.connect(fixture.endpoint);
		await first.next(frame => frame.type === "ready");
		first.close();
		await first.closedByRemote();
		const second = await SocketPeer.connect(fixture.endpoint);
		try {
			await second.next(frame => frame.type === "ready");
			second.send({ id: "state", type: "get_state" });
			const state = await frameOf(second, "state");
			expect(state.success).toBe(true);
		} finally {
			second.close();
		}
	}, 20_000);

	it("keeps the session and its turn running when the client disconnects mid-turn", async () => {
		const turnStarted = Promise.withResolvers<void>();
		const releaseTurn = Promise.withResolvers<void>();
		fixture = await createInteractiveFixture([
			async () => {
				turnStarted.resolve();
				await releaseTurn.promise;
				return { content: ["late answer"] };
			},
		]);
		const peer = await SocketPeer.connect(fixture.endpoint);
		await peer.next(frame => frame.type === "ready");
		const session = fixture.session;
		const sessionId = session.sessionId;

		peer.send({ id: "prompt", type: "prompt", message: "work that outlives the client" });
		await withTimeout(turnStarted.promise, FRAME_TIMEOUT_MS, "turn never started");
		expect(session.isStreaming).toBe(true);

		peer.close();
		await peer.closedByRemote();

		expect(session.isStreaming).toBe(true);
		releaseTurn.resolve();
		await session.waitForIdle();
		fixture.mock.calls.length = 0;

		expect(session.sessionId).toBe(sessionId);
		expect(
			session.agent.state.messages.some(
				message => message.role === "assistant" && JSON.stringify(message.content).includes("late answer"),
			),
		).toBe(true);

		const reattached = await SocketPeer.connect(fixture.endpoint);
		try {
			reattached.send({ id: "state", type: "get_state" });
			const state = await frameOf(reattached, "state");
			expect(state.success).toBe(true);
			expect((state.data as Record<string, unknown>).sessionId).toBe(sessionId);
			expect((state.data as Record<string, unknown>).isStreaming).toBe(false);
		} finally {
			reattached.close();
		}
	}, 30_000);

	it("refreshes terminal I/O without ending its session or socket", async () => {
		fixture = await createInteractiveFixture([]);
		const peer = await SocketPeer.connect(fixture.endpoint);
		await peer.next(frame => frame.type === "ready");
		const dispose = spyOn(fixture.session, "dispose");
		const stopMode = spyOn(fixture.mode, "stop");
		const close = spyOn(fixture.socket, "close");
		const stop = spyOn(fixture.mode.ui, "stop").mockImplementation(() => {});
		const start = spyOn(fixture.mode.ui, "start").mockImplementation(() => {});
		const repaint = spyOn(fixture.mode.ui, "requestRender").mockImplementation(() => {});
		try {
			peer.send({ id: "before-refresh", type: "get_state" });
			fixture.mode.refreshTerminalAttachment();
			peer.send({ id: "during-refresh", type: "get_state" });
			expect((await frameOf(peer, "before-refresh")).success).toBe(true);
			expect((await frameOf(peer, "during-refresh")).success).toBe(true);

			expect(stop).toHaveBeenCalledTimes(1);
			expect(start).toHaveBeenCalledTimes(1);
			expect(repaint).toHaveBeenCalled();
			expect(dispose).not.toHaveBeenCalled();
			expect(close).not.toHaveBeenCalled();
			expect(stopMode).not.toHaveBeenCalled();

			peer.send({ id: "after-refresh", type: "get_state" });
			const state = await frameOf(peer, "after-refresh");
			expect(state.success).toBe(true);
			expect((state.data as Record<string, unknown>).sessionId).toBe(fixture.session.sessionId);
		} finally {
			peer.close();
		}
	}, 30_000);

	it("lists live subagents and serves one's transcript to an attached client", async () => {
		const subagentEventBus = new EventBus();
		fixture = await createInteractiveFixture([], subagentEventBus);
		const transcriptFile = path.join(fixture.dir, "SubagentA.jsonl");
		await Bun.write(
			transcriptFile,
			`${JSON.stringify({ type: "session", id: "sub", timestamp: "2026-06-09T00:00:00.000Z", cwd: fixture.dir })}\n${JSON.stringify(
				{
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2026-06-09T00:00:00.000Z",
					message: { role: "user", content: [{ type: "text", text: "subagent transcript line" }] },
				},
			)}\n`,
		);
		subagentEventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, subagentLifecycle(transcriptFile));

		const peer = await SocketPeer.connect(fixture.endpoint);
		try {
			await peer.next(frame => frame.type === "ready");

			peer.send({ id: "list", type: "get_subagents" });
			expect(await frameOf(peer, "list")).toMatchObject({
				success: true,
				data: { subagents: [{ id: "SubagentA", status: "running", sessionFile: transcriptFile }] },
			});

			peer.send({ id: "transcript", type: "get_subagent_messages", subagentId: "SubagentA" });
			expect(await frameOf(peer, "transcript")).toMatchObject({
				success: true,
				data: {
					messages: [{ role: "user", content: [{ type: "text", text: "subagent transcript line" }] }],
				},
			});
		} finally {
			peer.close();
		}
	}, 30_000);

	it("delivers a steer and a cancel to a live subagent from an attached client", async () => {
		const subagentEventBus = new EventBus();
		fixture = await createInteractiveFixture([], subagentEventBus);
		const transcriptFile = path.join(fixture.dir, "SubagentA.jsonl");
		const prompts: Array<{ text: unknown; streamingBehavior: unknown }> = [];
		const lifecycleCalls: string[] = [];
		subagentEventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, subagentLifecycle(transcriptFile));
		AgentRegistry.global().register({
			id: "SubagentA",
			displayName: "SubagentA",
			kind: "sub",
			session: {
				subscribe: () => () => {},
				prompt: async (text: unknown, options: { streamingBehavior?: unknown }) => {
					prompts.push({ text, streamingBehavior: options.streamingBehavior });
					return true;
				},
				abort: async () => {
					lifecycleCalls.push("abort");
				},
				dispose: async () => {
					lifecycleCalls.push("dispose");
				},
			} as never,
			sessionFile: transcriptFile,
			status: "running",
		});

		const peer = await SocketPeer.connect(fixture.endpoint);
		try {
			await peer.next(frame => frame.type === "ready");

			peer.send({ id: "steer", type: "steer_subagent", subagentId: "SubagentA", message: "  tighten the loop  " });
			expect(await frameOf(peer, "steer")).toMatchObject({ success: true, command: "steer_subagent" });
			expect(prompts).toEqual([{ text: "  tighten the loop  ", streamingBehavior: "steer" }]);

			peer.send({ id: "cancel", type: "cancel_subagent", subagentId: "SubagentA" });
			expect(await frameOf(peer, "cancel")).toMatchObject({ success: true, data: { cancelled: true } });
			expect(lifecycleCalls).toEqual(["abort", "dispose"]);
		} finally {
			peer.close();
		}
	}, 30_000);

	it("filters subagent stream frames per attached client", async () => {
		const subagentEventBus = new EventBus();
		fixture = await createInteractiveFixture([], subagentEventBus);
		const transcriptFile = path.join(fixture.dir, "SubagentA.jsonl");
		const subscriber = await SocketPeer.connect(fixture.endpoint);
		const observer = await SocketPeer.connect(fixture.endpoint);
		const listed = (seen: Frame[]) => seen.filter(frame => frame.type?.startsWith("subagent_")).length;
		try {
			await subscriber.next(frame => frame.type === "ready");
			await observer.next(frame => frame.type === "ready");

			subscriber.send({ id: "subscribe-events", type: "set_subagent_subscription", level: "events" });
			expect(await frameOf(subscriber, "subscribe-events")).toMatchObject({
				success: true,
				data: { level: "events" },
			});

			subagentEventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, subagentLifecycle(transcriptFile));
			subagentEventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, subagentProgress(transcriptFile));
			subagentEventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, { id: "SubagentA", event: { type: "agent_start" } });
			await subscriber.next(frame => frame.type === "subagent_event");
			expect(listed(subscriber.seen)).toBe(3);

			observer.send({ id: "observer-state", type: "get_state" });
			await frameOf(observer, "observer-state");
			expect(listed(observer.seen)).toBe(0);

			observer.send({ id: "subscribe-progress", type: "set_subagent_subscription", level: "progress" });
			expect(await frameOf(observer, "subscribe-progress")).toMatchObject({
				success: true,
				data: { level: "progress" },
			});

			subagentEventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, subagentProgress(transcriptFile));
			await observer.next(frame => frame.type === "subagent_progress");
			subscriber.send({ id: "subscriber-before-off", type: "get_state" });
			await frameOf(subscriber, "subscriber-before-off");
			const deliveredWhileSubscribed = listed(subscriber.seen);
			expect(deliveredWhileSubscribed).toBe(4);

			subscriber.send({ id: "subscribe-off", type: "set_subagent_subscription", level: "off" });
			expect(await frameOf(subscriber, "subscribe-off")).toMatchObject({ success: true, data: { level: "off" } });
			subagentEventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, subagentProgress(transcriptFile));
			await observer.next(frame => listed(observer.seen) === 2);
			subscriber.send({ id: "subscriber-state", type: "get_state" });
			await frameOf(subscriber, "subscriber-state");
			expect(listed(subscriber.seen)).toBe(deliveredWhileSubscribed);
		} finally {
			subscriber.close();
			observer.close();
		}
	}, 30_000);
});
