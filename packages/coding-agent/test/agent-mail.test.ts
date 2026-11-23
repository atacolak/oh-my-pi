/**
 * Native agent mail contract tests: two real disposable owners (sdk-created
 * AgentSessions with real journals, each publishing its native RPC session
 * socket) exchanging mail over the real IPC transport. The provider is a MOCK
 * (agent-loop) model — these are mocked agent-loop tests, not live provider
 * acceptance. No transport is faked: sends, verification, discovery handshakes,
 * reads and events all cross real native sockets.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModelOptions } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { sessionAttachEndpoint } from "@oh-my-pi/pi-coding-agent/launch/session-attach";
import { RpcClient, type RpcCommandBody } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { runSockCommand } from "@oh-my-pi/pi-coding-agent/cli/sock-cli";
import type { RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { readRuntimeBootIdentity } from "@oh-my-pi/pi-coding-agent/launch/runtime-generation";
import { serveInteractiveSessionSocket } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-command-surface";
import { createAgentSessionSocket } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-socket";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { assignSessionIdentity, resolveSessionIdentity } from "@oh-my-pi/pi-coding-agent/session/session-identity";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import type { AgentMailSendResult } from "@oh-my-pi/pi-coding-agent/session/session-mail";
import { NativeSessionService } from "@oh-my-pi/pi-coding-agent/session/session-service";
import { AgentMailTool } from "@oh-my-pi/pi-coding-agent/tools/agent-mail";
import { AgentSessionsTool } from "@oh-my-pi/pi-coding-agent/tools/agent-sessions";
import { IpcServer } from "@oh-my-pi/pi-natives";
import { isRecord, Snowflake, withTimeout } from "@oh-my-pi/pi-utils";
import * as dirs from "@oh-my-pi/pi-utils/dirs";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const WAIT_MS = 15_000;

interface MailOwner {
	session: AgentSession;
	manager: SessionManager;
	dir: string;
	dispose(): Promise<void>;
}

interface MailHomes {
	root: string;
	runDir: string;
	sessionsRoot: string;
}

let homes: MailHomes;
let originalRunDir: string | undefined;
const owners: MailOwner[] = [];
const sockets: IpcServer[] = [];

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
	await withTimeout(
		(async () => {
			while (!predicate()) await Bun.sleep(20);
		})(),
		WAIT_MS,
		`timed out waiting for ${what}`,
	);
}

function userTexts(session: AgentSession): string[] {
	return session.messages
		.filter((message): message is Extract<AgentMessage, { role: "user" }> => message.role === "user")
		.map(message =>
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map(block => block.text)
						.join(""),
		);
}

async function createOwner(
	homes: MailHomes,
	options: {
		name: string;
		responses?: MockModelOptions["responses"];
		toolNames?: string[];
		restrictToolNames?: boolean;
	},
): Promise<MailOwner> {
	const dir = path.join(homes.root, options.name);
	fs.mkdirSync(dir, { recursive: true });
	// Real bundled model + real registry for session creation; turn responses
	// come from the MOCK agent-loop model by swapping the agent's streamFn.
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("fixture model unavailable");
	const mock = createMockModel({
		responses: options.responses ?? [],
		handler: () => ({ content: [{ type: "text", text: "ok" }] }),
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"async.enabled": false,
	});
	const manager = SessionManager.create(dir, homes.sessionsRoot);
	await manager.ensureOnDisk();
	const result = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		sessionManager: manager,
		authStorage,
		modelRegistry,
		settings,
		model,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		workspaceTree: {
			rootPath: dir,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		...(options.toolNames ? { toolNames: options.toolNames } : {}),
		restrictToolNames: options.restrictToolNames,
	});
	result.session.agent.streamFn = mock.stream;
	const socket = createAgentSessionSocket(result.session);
	await serveInteractiveSessionSocket({ session: result.session, socket });
	const owner: MailOwner = {
		session: result.session,
		manager,
		dir,
		dispose: async () => {
			await socket.close();
			await result.session.dispose();
			await manager.close();
		},
	};
	owners.push(owner);
	return owner;
}

function sendMail(
	from: MailOwner,
	params: { to: string; message: string; delivery?: "queue" | "steer"; threadId?: string; replyTo?: string },
	options: { responseTimeoutMs?: number } = {},
): Promise<AgentMailSendResult> {
	return from.session.sendAgentMail(
		{
			to: params.to,
			message: params.message,
			...(params.delivery === undefined ? {} : { delivery: params.delivery }),
			...(params.threadId === undefined ? {} : { threadId: params.threadId }),
			...(params.replyTo === undefined ? {} : { replyTo: params.replyTo }),
		},
		options,
	);
}

function toolOf<T>(owner: MailOwner, name: "agent_mail" | "agent_sessions"): T {
	const tool = owner.session.getToolByName(name);
	if (tool?.name !== name) throw new Error(`owner lacks the ${name} tool`);
	return tool as unknown as T;
}

async function socketClient(owner: MailOwner): Promise<RpcClient> {
	return RpcClient.connectSessionSocket({ endpoint: sessionAttachEndpoint(owner.session.sessionId) });
}

function wireTarget(owner: MailOwner) {
	const target = owner.session.agentMailIncarnation();
	return {
		recipientSessionId: target.sessionId,
		recipientSessionFile: target.sessionFile,
		recipientBootId: target.bootId,
		messageId: Snowflake.next(),
	};
}

function wireSource(owner: MailOwner) {
	const source = owner.session.agentMailIncarnation();
	return { senderSessionId: source.sessionId, senderSessionFile: source.sessionFile, senderBootId: source.bootId };
}

function writeSidecar(homes: MailHomes, sessionId: string, pid: number): void {
	fs.writeFileSync(
		path.join(homes.runDir, `${sessionId}.json`),
		JSON.stringify({ pid, sessionId, sessionFile: null, cwd: "/", agent: null, startedAt: Date.now() }),
	);
}

/** Negative protocol fixture: answers owner preflight, captures delivery, never acknowledges it. */
async function silentEndpoint(sessionId: string): Promise<{ server: IpcServer; captured: Record<string, unknown>[] }> {
	const captured: Record<string, unknown>[] = [];
	const server = await IpcServer.listen(sessionAttachEndpoint(sessionId), { framing: "lines" }, conn => {
		conn.start(
			line => {
				try {
					const frame = JSON.parse(line) as Record<string, unknown>;
					captured.push(frame);
					if (frame.type === "get_refresh_preflight")
						conn.send(
							JSON.stringify({
								type: "response",
								id: frame.id,
								command: frame.type,
								success: true,
								data: {
									restartReceipt: {
										sessionId,
										sessionFile: path.join(homes.root, `${sessionId}.jsonl`),
										bootId: readRuntimeBootIdentity().bootId,
									},
								},
							}),
						);
				} catch {
					// Not JSON; ignore.
				}
			},
			() => {},
		);
		conn.send(JSON.stringify({ type: "ready" }));
	});
	sockets.push(server);
	return { server, captured };
}

describe("native agent mail between two real socket owners (mocked agent-loop)", () => {
	beforeEach(() => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-agent-mail-"));
		homes = {
			root,
			runDir: path.join(root, "run"),
			sessionsRoot: path.join(root, "sessions"),
		};
		fs.mkdirSync(homes.runDir, { recursive: true });
		fs.mkdirSync(homes.sessionsRoot, { recursive: true });
		originalRunDir = process.env.OMP_RUN_DIR;
		process.env.OMP_RUN_DIR = homes.runDir;
		spyOn(dirs, "getSessionsDir").mockReturnValue(homes.sessionsRoot);
	});

	afterEach(async () => {
		for (const server of sockets.splice(0)) await server.close();
		for (const owner of owners.splice(0)) await owner.dispose();
		vi.restoreAllMocks();
		if (originalRunDir === undefined) delete process.env.OMP_RUN_DIR;
		else process.env.OMP_RUN_DIR = originalRunDir;
		AgentStorage.close();
		HistoryStorage.close();
		closeSessionIndex();
		fs.rmSync(homes.root, { recursive: true, force: true });
	});
	it("names and renames the same owner and reads its effective context without starting a turn", async () => {
		const owner = await createOwner(homes, { name: "native-cli-context" });
		const sessionId = owner.session.sessionId;
		const journal = owner.manager.getCanonicalSessionFile();
		const output: string[] = [];
		const write = spyOn(process.stdout, "write").mockImplementation(chunk => {
			output.push(String(chunk));
			return true;
		});
		try {
			await runSockCommand({ action: "name", target: sessionId, value: "first-name" });
			await runSockCommand({ action: "rename", target: "first-name", value: "renamed-owner" });
			output.length = 0;
			await runSockCommand({ action: "context", target: "renamed-owner", json: true });
		} finally {
			write.mockRestore();
		}
		const context: unknown = JSON.parse(output.join(""));
		expect(isRecord(context) && context.systemPrompt).toEqual(owner.session.systemPrompt);
		expect(await resolveSessionIdentity("renamed-owner")).toMatchObject({ sessionId, sessionFile: journal });
		await expect(resolveSessionIdentity("first-name")).rejects.toThrow("No session identity matches");
		expect(owner.session.sessionId).toBe(sessionId);
		expect(owner.session.messages).toEqual([]);
	}, 15_000);

	it("counts verified terminal sockets outside the displayed window and excludes unresponsive publishers", async () => {
		const visible = await createOwner(homes, { name: "visible-no-terminal" });
		const hidden = await createOwner(homes, { name: "hidden-terminal" });
		await assignSessionIdentity(visible.manager, { actorHandle: "visible" });
		const sidecar = Bun.file(path.join(homes.runDir, `${hidden.session.sessionId}.json`));
		const publication: unknown = await sidecar.json();
		if (!isRecord(publication)) throw new Error("fixture publication is not a record");
		await Bun.write(
			sidecar,
			JSON.stringify({
				...publication,
				terminal: { protocolVersion: 1, projectDir: hidden.dir, name: "fixture-owner", id: "fixture-generation" },
			}),
		);
		const silentId = "10000000-0000-7000-8000-000000000001";
		await silentEndpoint(silentId);
		writeSidecar(homes, silentId, process.pid);
		const result = await new NativeSessionService({
			sessionsRoot: homes.sessionsRoot,
			endpointDir: homes.runDir,
			timeoutMs: 200,
		}).list({ query: "visible", unnamedLimit: 0 });
		expect(result.sessions.map(row => row.sessionId)).toEqual([visible.session.sessionId]);
		expect(result.attachableSockets).toBe(1);
		expect(result.unverifiedSockets).toBe(1);
		expect(visible.session.messages).toEqual([]);
		expect(hidden.session.messages).toEqual([]);
	}, 15_000);

	it("uses the catalog's UUID prefix instead of another live session's matching suffix", async () => {
		const builtin: { randomUUIDv7(): string } = Bun;
		const mint = spyOn(builtin, "randomUUIDv7");
		const alice = await createOwner(homes, { name: "prefix-sender" });
		mint.mockReturnValueOnce("deadbeef-0000-7000-8000-000000000001");
		const expected = await createOwner(homes, { name: "prefix-recipient" });
		mint.mockReturnValueOnce("aaaaaaaa-0000-7000-8000-0000deadbeef");
		const wrong = await createOwner(homes, { name: "suffix-recipient" });
		mint.mockRestore();
		expect(expected.session.sessionId.startsWith("deadbeef")).toBe(true);
		expect(wrong.session.sessionId.endsWith("deadbeef")).toBe(true);
		const sent = await sendMail(alice, { to: "deadbeef", message: "prefix-selected mail" });
		expect(sent.status).toBe("accepted");
		await waitFor(() => expected.session.readAgentMail().total === 1, "canonical prefix recipient to receive mail");
		expect(wrong.session.readAgentMail().total).toBe(0);
	}, 60_000);

	it("settles the idle receipt before inference completes and keeps busy queue vs steering explicit", async () => {
		const gate = Promise.withResolvers<void>();
		const alice = await createOwner(homes, { name: "alice", toolNames: ["agent_mail", "agent_sessions"] });
		const bob = await createOwner(homes, {
			name: "bob",
			// The MOCK agent-loop model stalls its first response on the gate.
			responses: (async function* () {
				await gate.promise;
				yield { content: [{ type: "text", text: "working" }] };
				yield { content: [{ type: "text", text: "done" }] };
			})(),
			toolNames: ["agent_mail", "agent_sessions"],
		});

		// Idle delivery: the receipt must settle while the model is still
		// stalled — admission is observed, inference is never awaited.
		const idle = await sendMail(alice, { to: bob.session.sessionId, message: "idle receipt probe" });
		expect(idle.status).toBe("accepted");
		if (idle.status !== "accepted") throw new Error("unreachable");
		expect(idle.receipt.admission).toBe("admitted");
		expect(idle.receipt.busy).toBe(false);
		await waitFor(() => bob.session.isStreaming, "bob's stalled model turn to be running");

		// Busy delivery: queue vs steering are explicit, observable paths.
		const queued = await sendMail(alice, {
			to: bob.session.sessionId,
			message: "queued question",
			delivery: "queue",
		});
		expect(queued.status).toBe("accepted");
		if (queued.status !== "accepted") throw new Error("unreachable");
		expect(queued.receipt.admission).toBe("queued");
		expect(queued.receipt.busy).toBe(true);
		const steered = await sendMail(alice, {
			to: bob.session.sessionId,
			message: "steering update",
			delivery: "steer",
		});
		expect(steered.status).toBe("accepted");
		if (steered.status !== "accepted") throw new Error("unreachable");
		expect(steered.receipt.admission).toBe("steering");
		expect(steered.receipt.busy).toBe(true);
		const queues = bob.session.getQueuedMessages();
		expect([...queues.steering, ...queues.followUp].length + queues.liveSteered).toBeGreaterThanOrEqual(2);

		gate.resolve();
		await waitFor(
			() => userTexts(bob.session).some(text => text.includes("idle receipt probe")),
			"bob's stalled model turn to consume the admitted mail",
		);
	}, 60_000);

	it("refuses targeted mail held before prompt setup when the SAME AgentSession switches", async () => {
		const alice = await createOwner(homes, { name: "switch-alice" });
		const bob = await createOwner(homes, { name: "switch-bob" });
		const originalFile = bob.manager.getCanonicalSessionFile();
		if (!originalFile) throw new Error("missing original journal");
		const first = await sendMail(alice, { to: bob.session.sessionId, message: "original conversation mail" });
		expect(first.status).toBe("accepted");
		await waitFor(() => !bob.session.isStreaming, "the original mail turn to finish");
		const replacement = SessionManager.create(bob.dir, homes.sessionsRoot);
		await replacement.ensureOnDisk();
		const replacementFile = replacement.getCanonicalSessionFile();
		if (!replacementFile) throw new Error("missing replacement journal");
		await replacement.close();
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const cleanup = spyOn(SessionMaintenance.prototype, "waitForMaintenanceCleanup").mockImplementationOnce(
			async () => {
				entered.resolve();
				await released.promise;
				return undefined;
			},
		);
		const pending = sendMail(alice, { to: bob.session.sessionId, message: "must never enter replacement" });
		try {
			await withTimeout(entered.promise, WAIT_MS, "targeted prompt did not reach maintenance setup");
			expect(await bob.session.switchSession(replacementFile, { keepModel: true })).toBe(true);
			expect(bob.session.readAgentMail().total).toBe(0);
		} finally {
			released.resolve();
			cleanup.mockRestore();
		}
		const result = await pending;
		expect(result.status).toBe("refused");
		expect(userTexts(bob.session).some(text => text.includes("must never enter replacement"))).toBe(false);
		expect(bob.session.readAgentMail().total).toBe(0);
		expect(await bob.session.switchSession(originalFile, { keepModel: true })).toBe(true);
		expect(bob.session.readAgentMail().messages.map(record => record.body)).toEqual(["original conversation mail"]);
	}, 60_000);

	it("fences the source across awaited connection setup on the SAME AgentSession", async () => {
		const alice = await createOwner(homes, { name: "source-fence-alice" });
		const bob = await createOwner(homes, { name: "source-fence-bob" });
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const connect = RpcClient.connectSessionSocket;
		const connection = spyOn(RpcClient, "connectSessionSocket").mockImplementationOnce(async options => {
			entered.resolve();
			await released.promise;
			return connect(options);
		});
		const original = alice.session.agentMailIncarnation();
		const pending = sendMail(alice, { to: bob.session.sessionId, message: "old source must not send" });
		try {
			await withTimeout(entered.promise, WAIT_MS, "source send did not reach connection setup");
			const replacement = SessionManager.create(alice.dir, homes.sessionsRoot);
			await replacement.ensureOnDisk();
			const file = replacement.getCanonicalSessionFile();
			if (!file) throw new Error("missing source replacement journal");
			await replacement.close();
			expect(await alice.session.switchSession(file, { keepModel: true })).toBe(true);
			expect(alice.session.sessionId).not.toBe(original.sessionId);
		} finally {
			released.resolve();
			connection.mockRestore();
		}
		expect((await pending).status).toBe("refused");
		expect(bob.session.readAgentMail().total).toBe(0);
		expect(userTexts(bob.session).some(text => text.includes("old source must not send"))).toBe(false);
	}, 60_000);

	it("binds target UUID, canonical journal and native boot from the connected owner receipt", async () => {
		const alice = await createOwner(homes, { name: "incarnation-alice" });
		const bob = await createOwner(homes, { name: "incarnation-bob" });
		const client = await socketClient(bob);
		try {
			const response = await client.send({ type: "get_refresh_preflight" });
			const data: unknown = response.success && "data" in response ? response.data : undefined;
			if (!isRecord(data) || !isRecord(data.restartReceipt)) throw new Error("missing native receipt");
			expect(data.restartReceipt).toMatchObject(bob.session.agentMailIncarnation());
			expect(data.restartReceipt.bootId).toBe(readRuntimeBootIdentity().bootId);
		} finally {
			await client.stop();
		}
		for (const field of ["sessionId", "sessionFile", "bootId"] as const) {
			const send = RpcClient.prototype.send;
			const altered = spyOn(RpcClient.prototype, "send").mockImplementation(
				async function (this: RpcClient, command, timeout): Promise<RpcResponse> {
					const response = await send.call(this, command, timeout);
					if (
						command.type === "get_refresh_preflight" &&
						response.success &&
						response.command === "get_refresh_preflight" &&
						response.data.restartReceipt?.sessionId === bob.session.sessionId
					) {
						const receipt = response.data.restartReceipt;
						return {
							...response,
							data: {
								...response.data,
								restartReceipt: {
									...receipt,
									[field]: `${receipt[field]}-stale`,
								},
							},
						};
					}
					return response;
				},
			);
			try {
				const result = await sendMail(alice, { to: bob.session.sessionId, message: `stale ${field}` });
				expect(result.status).toBe("refused");
			} finally {
				altered.mockRestore();
			}
		}
		expect(bob.session.readAgentMail().total).toBe(0);
		expect(userTexts(bob.session)).toEqual([]);
	}, 60_000);

	it("refuses source journal or native boot changes during awaited connection setup", async () => {
		const alice = await createOwner(homes, { name: "source-incarnation-alice" });
		const bob = await createOwner(homes, { name: "source-incarnation-bob" });
		for (const field of ["sessionFile", "bootId"] as const) {
			const source = alice.session.agentMailIncarnation();
			const connect = RpcClient.connectSessionSocket;
			const restores: Array<() => void> = [];
			const opening = spyOn(RpcClient, "connectSessionSocket").mockImplementationOnce(async options => {
				const client = await connect(options);
				const changed = spyOn(alice.session, "agentMailIncarnation").mockReturnValue({
					...source,
					[field]: `${source[field]}-changed`,
				});
				restores.push(() => changed.mockRestore());
				return client;
			});
			try {
				expect(
					(
						await sendMail(alice, {
							to: bob.session.sessionId,
							message: `old source ${field}`,
						})
					).status,
				).toBe("refused");
			} finally {
				opening.mockRestore();
				for (const restore of restores) restore();
			}
		}
		expect(bob.session.readAgentMail().total).toBe(0);
	}, 60_000);

	it("does not acknowledge idle setup that fails before committing the normal input", async () => {
		const alice = await createOwner(homes, { name: "failed-setup-alice" });
		const bob = await createOwner(homes, { name: "failed-setup-bob" });
		const events: string[] = [];
		bob.session.subscribe(event => {
			if (event.type === "agent_mail") events.push(event.mail.messageId);
		});
		const reject = spyOn(bob.session.modelRegistry, "getApiKey").mockRejectedValue(
			new Error("fixture preflight denial"),
		);
		try {
			const result = await sendMail(alice, { to: bob.session.sessionId, message: "rejected during setup" });
			expect(result.status).toBe("refused");
			expect(bob.session.readAgentMail().total).toBe(0);
			expect(events).toEqual([]);
			expect(userTexts(bob.session)).toEqual([]);
		} finally {
			reject.mockRestore();
		}
	}, 60_000);

	it("automatically receives a real-socket reply and validates the thread, reference and participants", async () => {
		const alice = await createOwner(homes, { name: "reply-alice", toolNames: ["agent_mail", "agent_sessions"] });
		const bob = await createOwner(homes, { name: "reply-bob", toolNames: ["agent_mail", "agent_sessions"] });
		await assignSessionIdentity(alice.manager, { actorHandle: "reply.alice" });
		await assignSessionIdentity(bob.manager, { actorHandle: "reply.bob" });
		const original = await sendMail(alice, { to: "reply.bob", message: "please check this native thread" });
		if (original.status !== "accepted") throw new Error("original mail refused");
		await waitFor(
			() => userTexts(bob.session).some(text => text.includes("please check this native thread")),
			"automatic original receive",
		);
		const received = bob.session.readAgentMail().messages[0]!;
		expect(received.messageId).toBe(original.receipt.messageId);
		expect(received.sender).toMatchObject({ sessionId: alice.session.sessionId, handle: "reply.alice" });
		const replied = await sendMail(bob, {
			to: alice.session.sessionId,
			message: "the thread is checked",
			threadId: received.threadId,
			replyTo: received.messageId,
		});
		if (replied.status !== "accepted") throw new Error("reply refused");
		await waitFor(
			() => userTexts(alice.session).some(text => text.includes("the thread is checked")),
			"automatic reply receive",
		);
		const reply = alice.session.readAgentMail({ threadId: received.threadId }).messages[0]!;
		expect(reply).toMatchObject({
			messageId: replied.receipt.messageId,
			threadId: received.threadId,
			replyTo: received.messageId,
			sender: { sessionId: bob.session.sessionId, handle: "reply.bob" },
			recipient: { sessionId: alice.session.sessionId, handle: "reply.alice" },
			source: bob.session.agentMailIncarnation(),
			target: alice.session.agentMailIncarnation(),
		});
		for (const invalid of [
			{ threadId: "another-thread", replyTo: received.messageId },
			{ threadId: received.threadId, replyTo: "unknown-message" },
		]) {
			expect(
				(
					await sendMail(bob, {
						to: alice.session.sessionId,
						message: "invalid reply",
						...invalid,
					})
				).status,
			).toBe("refused");
		}
		expect(alice.session.readAgentMail().total).toBe(1);
		expect(bob.session.readAgentMail().total).toBe(1);
	}, 60_000);

	it("accepts a valid reply even when the original sender lost its native delivery receipt", async () => {
		const alice = await createOwner(homes, { name: "unknown-reply-alice" });
		const bob = await createOwner(homes, { name: "unknown-reply-bob" });
		const send = RpcClient.prototype.send;
		const lostAck = spyOn(RpcClient.prototype, "send").mockImplementation(
			async function (this: RpcClient, command, timeout): Promise<RpcResponse> {
				const response = await send.call(this, command, timeout);
				if (command.type === "agent_mail_deliver" && command.recipientSessionId === bob.session.sessionId)
					throw new Error("fixture: receipt lost after native admission");
				return response;
			},
		);
		try {
			expect(
				(
					await sendMail(alice, {
						to: bob.session.sessionId,
						message: "one offered message, never resend",
					})
				).status,
			).toBe("unknown");
		} finally {
			lostAck.mockRestore();
		}
		const original = bob.session.readAgentMail().messages[0]!;
		expect(bob.session.readAgentMail().total).toBe(1);
		expect(
			(
				await sendMail(bob, {
					to: alice.session.sessionId,
					message: "reply to the uncertain original",
					threadId: original.threadId,
					replyTo: original.messageId,
				})
			).status,
		).toBe("accepted");
		expect(alice.session.readAgentMail().messages[0]).toMatchObject({
			threadId: original.threadId,
			replyTo: original.messageId,
			sender: { sessionId: bob.session.sessionId },
			recipient: { sessionId: alice.session.sessionId },
		});
	}, 60_000);

	it("refuses pre-admission rejections without a record or event", async () => {
		const alice = await createOwner(homes, { name: "guard-alice", toolNames: ["agent_mail", "agent_sessions"] });
		const bob = await createOwner(homes, { name: "guard-bob", toolNames: ["agent_mail", "agent_sessions"] });
		const events: string[] = [];
		bob.session.subscribe(event => {
			if (event.type === "agent_mail") events.push(event.mail.messageId);
		});
		const client = await socketClient(bob);
		type DeliverCommand = Extract<RpcCommandBody, { type: "agent_mail_deliver" }>;
		const deliver = (patch: Partial<DeliverCommand>) =>
			client.send({
				type: "agent_mail_deliver",
				...wireTarget(bob),
				message: "should never be admitted",
				delivery: "queue",
				sentAt: Date.now(),
				...wireSource(alice),
				capabilityToken: "not-a-real-capability",
				...patch,
			} as DeliverCommand);
		try {
			const mismatch = await deliver({ recipientSessionId: "someone-else" });
			expect(mismatch.success).toBe(false);
			expect((mismatch as { code?: string }).code).toBe("mail_target_mismatch");
			const fractional = await deliver({ sentAt: 1.5 });
			expect(fractional.success).toBe(false);
			expect((fractional as { error?: string }).error).toContain("sentAt");
			const negative = await deliver({ sentAt: -5 });
			expect(negative.success).toBe(false);
			const replyWithoutThread = await deliver({ replyTo: "msg-1" });
			expect(replyWithoutThread.success).toBe(false);
			expect((replyWithoutThread as { error?: string }).error).toContain("replyTo");
			const forged = await deliver({});
			expect(forged.success).toBe(false);
			expect((forged as { code?: string }).code).toBe("mail_sender_unverified");
		} finally {
			await client.stop();
		}
		expect(events).toHaveLength(0);
		expect(bob.session.readAgentMail().total).toBe(0);
	}, 60_000);

	it("reports timeout as unknown, refuses mutated evidence, and never reuses a consumed proof", async () => {
		const alice = await createOwner(homes, { name: "forgery-alice" });
		const bob = await createOwner(homes, { name: "forgery-bob" });
		writeSidecar(homes, "silent-target", process.pid);
		const silent = await silentEndpoint("silent-target");
		const pending = sendMail(
			alice,
			{ to: "silent-target", message: "genuine body", threadId: "thread-1" },
			{ responseTimeoutMs: 2_000 },
		);
		await waitFor(() => silent.captured.some(frame => frame.type === "agent_mail_deliver"), "captured delivery");
		const captured = silent.captured.find(frame => frame.type === "agent_mail_deliver")! as Extract<
			RpcCommandBody,
			{ type: "agent_mail_deliver" }
		>;
		const sourceClient = await socketClient(alice);
		try {
			// Keep the issued incarnations but mutate the body before verification.
			const mutated = await sourceClient.send({
				...captured,
				type: "agent_mail_verify_send",
				message: "tampered body",
			});
			expect(mutated.success).toBe(true);
			const verdict: unknown = mutated.success && "data" in mutated ? mutated.data : undefined;
			expect(isRecord(verdict) && verdict.valid).toBe(false);
			expect(isRecord(verdict) && "capabilityToken" in verdict).toBe(false);
			const replay = await sourceClient.send({ ...captured, type: "agent_mail_verify_send" });
			const replayVerdict: unknown = replay.success && "data" in replay ? replay.data : undefined;
			expect(isRecord(replayVerdict) && replayVerdict.valid).toBe(false);
		} finally {
			await sourceClient.stop();
		}
		expect((await pending).status).toBe("unknown");
		const client = await socketClient(bob);
		try {
			const forged = await client.send({
				...captured,
				...wireTarget(bob),
				type: "agent_mail_deliver",
			});
			expect(forged.success).toBe(false);
			expect((forged as { code?: string }).code).toBe("mail_sender_unverified");
		} finally {
			await client.stop();
		}
		expect(bob.session.readAgentMail().total).toBe(0);
	}, 60_000);

	it("retains bounded history across a real journal reopen without leaking other sessions", async () => {
		const alice = await createOwner(homes, { name: "reopen-alice", toolNames: ["agent_mail", "agent_sessions"] });
		const bob = await createOwner(homes, { name: "reopen-bob", toolNames: ["agent_mail", "agent_sessions"] });
		const carol = await createOwner(homes, { name: "reopen-carol", toolNames: ["agent_mail", "agent_sessions"] });
		const first = await sendMail(alice, { to: bob.session.sessionId, message: "reopen probe" });
		expect(first.status).toBe("accepted");
		const second = await sendMail(alice, { to: bob.session.sessionId, message: "second probe" });
		expect(second.status).toBe("accepted");
		if (first.status !== "accepted") throw new Error("unreachable");

		// Another owner's journal never shows bob's mail.
		expect(carol.session.readAgentMail().total).toBe(0);

		// Bounded read before reopen.
		const bounded = bob.session.readAgentMail({ limit: 1 });
		expect(bounded.messages).toHaveLength(1);
		expect(bounded.total).toBe(2);
		expect(bounded.truncated).toBe(true);
		expect(bounded.messages[0]!.body).toBe("second probe");

		// Real reopen: dispose the owner, reopen the same journal, provenance survives.
		const sessionFile = bob.manager.getCanonicalSessionFile();
		if (!sessionFile) throw new Error("missing bob journal");
		const bobIndex = owners.indexOf(bob);
		if (bobIndex >= 0) owners.splice(bobIndex, 1);
		await bob.dispose();
		const reopenedManager = await SessionManager.open(sessionFile);
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("fixture model unavailable");
		const reopened = await createAgentSession({
			cwd: bob.dir,
			agentDir: bob.dir,
			sessionManager: reopenedManager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage),
			settings: Settings.isolated({ "compaction.enabled": false, "async.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: {
				rootPath: bob.dir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["agent_mail", "agent_sessions"],
		});
		const reopenedOwner: MailOwner = {
			session: reopened.session,
			manager: reopenedManager,
			dir: bob.dir,
			dispose: async () => {
				await reopened.session.dispose();
				await reopenedManager.close();
			},
		};
		owners.push(reopenedOwner);
		const history = reopened.session.readAgentMail();
		expect(history.total).toBe(2);
		expect(history.messages.map(record => record.body)).toEqual(["reopen probe", "second probe"]);
		const threadRead = reopened.session.readAgentMail({ threadId: first.receipt.threadId });
		expect(threadRead.total).toBeGreaterThan(0);
	}, 60_000);

	it("renames with a stable UUID, refuses collisions and the old handle", async () => {
		const alice = await createOwner(homes, { name: "rename-alice", toolNames: ["agent_mail", "agent_sessions"] });
		const bob = await createOwner(homes, { name: "rename-bob", toolNames: ["agent_mail", "agent_sessions"] });
		const mallory = await createOwner(homes, { name: "rename-mallory" });
		await assignSessionIdentity(bob.manager, { actorHandle: "postmaster" });
		await assignSessionIdentity(bob.manager, { actorHandle: "postmaster-two" });

		// Same canonical UUID under the new handle.
		const renamed = await resolveSessionIdentity("postmaster-two");
		expect(renamed.sessionId).toBe(bob.session.sessionId);

		// Send by the ACTUAL new handle.
		const byHandle = await sendMail(alice, {
			to: "postmaster-two",
			message: "renamed handle reaches the same owner",
		});
		expect(byHandle.status).toBe("accepted");
		if (byHandle.status !== "accepted") throw new Error("unreachable");
		expect(byHandle.receipt.recipient.sessionId).toBe(bob.session.sessionId);

		// The old handle no longer resolves: refused, nothing sent.
		await expect(sendMail(alice, { to: "postmaster", message: "stale handle" })).rejects.toThrow();
		expect(bob.session.readAgentMail().total).toBe(1);

		// Collision: another journal cannot claim the same handle.
		await expect(assignSessionIdentity(mallory.manager, { actorHandle: "postmaster-two" })).rejects.toThrow();
	}, 60_000);

	it("classifies stale publications and mismatched sockets as unavailable", async () => {
		const alice = await createOwner(homes, { name: "probe-alice", toolNames: ["agent_mail", "agent_sessions"] });
		const bob = await createOwner(homes, { name: "probe-bob" });
		void alice;

		// A sidecar whose PID is provably dead and whose socket does not exist.
		writeSidecar(homes, "dead-pid", 2_147_483_647);
		// A live PID with no listening socket at the published endpoint.
		writeSidecar(homes, "gone-socket", process.pid);
		// A live socket that answers as a DIFFERENT session: id mismatch.
		writeSidecar(homes, "imposter", process.pid);
		const imposter = await IpcServer.listen(sessionAttachEndpoint("imposter"), { framing: "lines" }, conn => {
			conn.start(
				line => {
					const frame = JSON.parse(line) as { type?: string; id?: string };
					if (frame.type === "get_refresh_preflight") {
						conn.send(
							JSON.stringify({
								type: "response",
								id: frame.id,
								command: "get_refresh_preflight",
								success: true,
								data: { restartReceipt: bob.session.agentMailIncarnation() },
							}),
						);
					}
				},
				() => {},
			);
			conn.send(JSON.stringify({ type: "ready" }));
		});
		sockets.push(imposter);

		const discovery = await alice.session.discoverAgentMailSessions();
		const byId = new Map(discovery.sessions.map(entry => [entry.sessionId, entry]));
		expect(byId.get("dead-pid")?.availability).toBe("unavailable");
		expect(byId.get("gone-socket")?.availability).toBe("unavailable");
		expect(byId.get("imposter")?.availability).toBe("unavailable");
		expect(byId.get(bob.session.sessionId)?.availability).toBe("live");

		// Bounded output with truncation information.
		const bounded = await alice.session.discoverAgentMailSessions({ limit: 1 });
		expect(bounded.sessions).toHaveLength(1);
		expect(bounded.total).toBeGreaterThan(1);
		expect(bounded.truncated).toBe(true);
	}, 60_000);

	it("streams the live agent_mail event and serves reads after reconnect", async () => {
		const alice = await createOwner(homes, { name: "event-alice", toolNames: ["agent_mail", "agent_sessions"] });
		const bob = await createOwner(homes, { name: "event-bob", toolNames: ["agent_mail", "agent_sessions"] });
		const viewer = await socketClient(bob);
		const seen: string[] = [];
		const unsubscribe = viewer.onSessionEvent(event => {
			if (event.type === "agent_mail") seen.push(event.mail.messageId);
		});
		const sent = await sendMail(alice, { to: bob.session.sessionId, message: "event probe" });
		expect(sent.status).toBe("accepted");
		await waitFor(() => seen.length > 0, "the live agent_mail event on the socket");
		unsubscribe();
		await viewer.stop();

		// Reconnect: the same owner method serves the read over the socket.
		const reconnected = await socketClient(bob);
		try {
			const read = await reconnected.send({ type: "agent_mail_read", limit: 10 });
			expect(read.success).toBe(true);
			const data = (read as { data?: { messages?: { body: string }[]; total?: number } }).data;
			expect(data?.total).toBe(1);
			expect(data?.messages?.[0]?.body).toBe("event probe");
		} finally {
			await reconnected.stop();
		}
	}, 60_000);

	it("rejects malformed numeric and thread input", async () => {
		const bob = await createOwner(homes, { name: "validate-bob", toolNames: ["agent_mail", "agent_sessions"] });
		const client = await socketClient(bob);
		try {
			const badRead = await client.send({ type: "agent_mail_read", limit: 2.5 });
			expect(badRead.success).toBe(false);
			const zeroRead = await client.send({ type: "agent_mail_read", limit: 0 });
			expect(zeroRead.success).toBe(false);
			const emptyThread = await client.send({ type: "agent_mail_read", threadId: "" });
			expect(emptyThread.success).toBe(false);
			const badThread = await client.send({
				type: "agent_mail_deliver",
				...wireTarget(bob),
				message: "x",
				threadId: "",
				delivery: "queue",
				sentAt: Date.now(),
				senderSessionId: "anyone",
				senderSessionFile: "/unavailable-sender.jsonl",
				senderBootId: "unavailable-boot",
				capabilityToken: "tok",
			});
			expect(badThread.success).toBe(false);
			expect((badThread as { error?: string }).error).toContain("threadId");
		} finally {
			await client.stop();
		}
		expect(() => bob.session.readAgentMail({ limit: Number.NaN })).toThrow();
	}, 60_000);

	it("keeps the tools opt-in only and dispatches through a real mocked agent-loop turn", async () => {
		const plain = await createOwner(homes, { name: "plain" });
		expect(plain.session.getToolByName("agent_mail")).toBeUndefined();
		expect(plain.session.getToolByName("agent_sessions")).toBeUndefined();
		const restricted = await createOwner(homes, {
			name: "restricted-mail",
			toolNames: ["agent_mail"],
			restrictToolNames: true,
		});
		expect(restricted.session.agent.state.tools.map(tool => tool.name)).toEqual(["agent_mail"]);
		expect(restricted.session.getToolByName("agent_sessions")).toBeUndefined();

		const bob = await createOwner(homes, { name: "dispatch-bob" });
		const alice = await createOwner(homes, {
			name: "dispatch-alice",
			// MOCK agent-loop model: emits a real agent_mail tool call.
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "agent_mail",
							arguments: {
								op: "send",
								to: bob.session.sessionId,
								message: "dispatched from a mocked agent-loop turn",
							},
						},
					],
				},
				{ content: [{ type: "text", text: "mailed" }] },
			],
			toolNames: ["agent_mail", "agent_sessions"],
		});
		void bob;
		void alice.session.prompt("mail bob the audit request");
		await waitFor(
			() => userTexts(bob.session).some(text => text.includes("dispatched from a mocked agent-loop turn")),
			"bob to receive mail dispatched from a mocked agent-loop turn",
		);
		const result = await toolOf<AgentMailTool>(alice, "agent_mail").execute(`t-${Snowflake.next()}`, {
			op: "read",
			limit: 5,
		});
		const details = result.details as { op: string; result?: { total: number } };
		expect(details.op).toBe("read");
		expect(details.result?.total).toBe(0);
		const sessions = await toolOf<AgentSessionsTool>(alice, "agent_sessions").execute(`t-${Snowflake.next()}`, {
			live_only: true,
		});
		const lines = (sessions.content[0] as { type: string; text?: string }).text ?? "";
		expect(lines).toContain("live");
	}, 60_000);
});
