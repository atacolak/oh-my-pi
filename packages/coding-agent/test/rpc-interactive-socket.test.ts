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
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

async function createInteractiveFixture(responses: MockHandler[]): Promise<InteractiveFixture> {
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
	const mode = new InteractiveMode(session, "test");
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
});
