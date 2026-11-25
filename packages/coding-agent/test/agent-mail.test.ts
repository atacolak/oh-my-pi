/**
 * Pull-only native agent mail contract tests: two real disposable owners
 * (sdk-created AgentSessions with real journals, each publishing its native RPC
 * session socket) exchanging mail over the real IPC transport. The provider is
 * a MOCK (agent-loop) model — these are mocked agent-loop tests, not live
 * provider acceptance. No transport is faked: consent preflight, capability
 * handshakes, journal deposits, explicit reads and offline journal reservation
 * all cross real native sockets and journals.
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
import { withMailApprovalContext } from "@oh-my-pi/pi-coding-agent/session/mail-approval-context";
import { NativeSessionApi } from "@oh-my-pi/pi-coding-agent/session/native-session-api";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { assignSessionIdentity, resolveSessionIdentity } from "@oh-my-pi/pi-coding-agent/session/session-identity";
import {
	AGENT_MAIL_CUSTOM_TYPE,
	type AgentMailApproval,
	type AgentMailApprovalRequest,
	type AgentMailReadResult,
	type AgentMailSendResult,
} from "@oh-my-pi/pi-coding-agent/session/session-mail";
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

function userTexts(owner: MailOwner): string[] {
	return owner.session.messages
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

function sessionOptions(dir: string, toolNames?: string[]) {
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("fixture model unavailable");
	return {
		cwd: dir,
		agentDir: dir,
		authStorage,
		modelRegistry: new ModelRegistry(authStorage),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"async.enabled": false,
		}),
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
		...(toolNames ? { toolNames } : {}),
	};
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
	const mock = createMockModel({
		responses: options.responses ?? [],
		handler: () => ({ content: [{ type: "text", text: "ok" }] }),
	});
	const manager = SessionManager.create(dir, homes.sessionsRoot);
	await manager.ensureOnDisk();
	const result = await createAgentSession({
		...sessionOptions(dir, options.toolNames),
		sessionManager: manager,
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

/** Reopen a saved journal without publishing an owner process. */
async function reopenOwner(sessionFile: string, dir: string, toolNames?: string[]): Promise<MailOwner> {
	const manager = await SessionManager.open(sessionFile);
	const result = await createAgentSession({ ...sessionOptions(dir, toolNames), sessionManager: manager });
	const owner: MailOwner = {
		session: result.session,
		manager,
		dir,
		dispose: async () => {
			await result.session.dispose();
			await manager.close();
		},
	};
	owners.push(owner);
	return owner;
}

function sendMail(
	from: MailOwner,
	params: { to: string; message: string; threadId?: string; replyTo?: string },
	options: {
		responseTimeoutMs?: number;
		approve?: (request: AgentMailApprovalRequest) => Promise<AgentMailApproval>;
	} = {},
): Promise<AgentMailSendResult> {
	return from.session.sendAgentMail(
		{
			to: params.to,
			message: params.message,
			...(params.threadId === undefined ? {} : { threadId: params.threadId }),
			...(params.replyTo === undefined ? {} : { replyTo: params.replyTo }),
		},
		options,
	);
}

/** Trusted recipient-side fixture setup; raw RPC cannot grant consent. */
async function allowMailFrom(recipient: MailOwner, sender: MailOwner): Promise<void> {
	await recipient.session.setAgentMailContact({ peer: sender.session.sessionId, rule: "allow" });
}

function readRequests(owner: MailOwner): AgentMailReadResult {
	return owner.session.readAgentMail({ folder: "requests" });
}

function mailEntries(owner: MailOwner) {
	return owner.manager
		.getEntries()
		.filter(entry => entry.type === "custom" && entry.customType === AGENT_MAIL_CUSTOM_TYPE);
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

/** Pre-upgrade journal record: historical delivery/admission, optional historical folder. */
async function appendLegacyMail(
	recipient: MailOwner,
	sender: MailOwner,
	body: string,
	folder?: "requests",
): Promise<void> {
	const source = sender.session.agentMailIncarnation();
	const target = recipient.session.agentMailIncarnation();
	const messageId = `legacy-${Snowflake.next()}`;
	recipient.manager.appendCustomEntry(AGENT_MAIL_CUSTOM_TYPE, {
		version: 1,
		state: "admitted",
		mail: {
			messageId,
			threadId: messageId,
			sender: { sessionId: source.sessionId, handle: null, model: null },
			recipient: { sessionId: target.sessionId, handle: null, model: null },
			source,
			target,
			body,
			sentAt: Date.now(),
			receivedAt: Date.now(),
			delivery: "steer",
			admission: "steering",
			...(folder === undefined ? {} : { folder }),
		},
	});
	await recipient.manager.flush();
}

/** Negative protocol fixture: answers consent preflight, captures delivery, never acknowledges it. */
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
					if (frame.type === "agent_mail_policy")
						conn.send(
							JSON.stringify({
								type: "response",
								id: frame.id,
								command: frame.type,
								success: true,
								data: { rule: "allow", revision: "fixture" },
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
		const alice = await createOwner(homes, { name: "prefix-sender", toolNames: ["agent_mail"] });
		mint.mockReturnValueOnce("deadbeef-0000-7000-8000-000000000001");
		const expected = await createOwner(homes, { name: "prefix-recipient" });
		mint.mockReturnValueOnce("aaaaaaaa-0000-7000-8000-0000deadbeef");
		const wrong = await createOwner(homes, { name: "suffix-recipient" });
		mint.mockRestore();
		expect(expected.session.sessionId.startsWith("deadbeef")).toBe(true);
		expect(wrong.session.sessionId.endsWith("deadbeef")).toBe(true);
		await allowMailFrom(expected, alice);
		const sent = await sendMail(alice, { to: "deadbeef", message: "prefix-selected mail" });
		expect(sent.status).toBe("accepted");
		if (sent.status !== "accepted") throw new Error("unreachable");
		expect(sent.receipt.admission).toBe("stored");
		expect(sent.receipt.target).toMatchObject({
			sessionId: expected.session.sessionId,
			sessionFile: expected.manager.getCanonicalSessionFile(),
			bootId: readRuntimeBootIdentity().bootId,
		});
		await waitFor(
			() => expected.session.readAgentMail().total === 1,
			"canonical prefix recipient to store mail",
		);
		expect(expected.session.readAgentMail().messages[0]!.folder).toBe("inbox");
		expect(wrong.session.readAgentMail().total).toBe(0);
		expect(readRequests(expected).total).toBe(0);
	}, 60_000);

	it("stores idle and busy mail without starting a turn, touching input or queueing it", async () => {
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
		await allowMailFrom(bob, alice);

		// Idle owner: the deposit is stored immediately and starts nothing.
		const idle = await sendMail(alice, { to: bob.session.sessionId, message: "idle receipt probe" });
		expect(idle.status).toBe("accepted");
		if (idle.status !== "accepted") throw new Error("unreachable");
		expect(idle.receipt).toMatchObject({ admission: "stored" });
		expect("busy" in idle.receipt).toBe(false);
		expect(idle.receipt.target.bootId).toBe(readRuntimeBootIdentity().bootId);
		expect(bob.session.isStreaming).toBe(false);
		expect(bob.session.messages).toEqual([]);
		expect(userTexts(bob)).toEqual([]);
		expect(bob.session.getQueuedMessages()).toEqual({ steering: [], followUp: [], liveSteered: 0 });
		expect(mailEntries(bob)).toHaveLength(1);
		expect(bob.session.readAgentMail().total).toBe(1);
		expect(readRequests(bob).total).toBe(0);

		// Busy owner: the receipt settles as stored and never joins the run.
		void bob.session.prompt("start the run");
		await waitFor(() => bob.session.isStreaming, "bob's gated run to start");
		const busy = await sendMail(alice, { to: bob.session.sessionId, message: "busy receipt probe" });
		expect(busy.status).toBe("accepted");
		if (busy.status !== "accepted") throw new Error("unreachable");
		expect(busy.receipt.admission).toBe("stored");
		expect("busy" in busy.receipt).toBe(false);
		expect(bob.session.getQueuedMessages()).toEqual({ steering: [], followUp: [], liveSteered: 0 });
		expect(userTexts(bob)).toEqual(["start the run"]);

		gate.resolve();
		await waitFor(() => !bob.session.isStreaming, "bob's turn to finish");
		expect(bob.session.readAgentMail().total).toBe(2);
		expect(readRequests(bob).total).toBe(0);
		expect(userTexts(bob)).toEqual(["start the run"]);
	}, 60_000);

	it("refuses a target whose owner changed during the awaited handshake before any write", async () => {
		const alice = await createOwner(homes, { name: "switch-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "switch-bob" });
		await allowMailFrom(bob, alice);
		const originalFile = bob.manager.getCanonicalSessionFile();
		if (!originalFile) throw new Error("missing original journal");
		const replacement = SessionManager.create(bob.dir, homes.sessionsRoot);
		await replacement.ensureOnDisk();
		const replacementFile = replacement.getCanonicalSessionFile();
		if (!replacementFile) throw new Error("missing replacement journal");
		await replacement.close();
		const connect = RpcClient.connectSessionSocket;
		const switched = spyOn(RpcClient, "connectSessionSocket").mockImplementationOnce(async options => {
			const client = await connect(options);
			expect(await bob.session.switchSession(replacementFile, { keepModel: true })).toBe(true);
			return client;
		});
		let result: AgentMailSendResult;
		try {
			result = await sendMail(alice, { to: bob.session.sessionId, message: "must never enter replacement" });
		} finally {
			switched.mockRestore();
		}
		expect(result.status).toBe("refused");
		expect(bob.session.readAgentMail().total).toBe(0);
		expect(readRequests(bob).total).toBe(0);
		expect(userTexts(bob)).toEqual([]);
		expect(mailEntries(alice)).toHaveLength(0);
		expect(await bob.session.switchSession(originalFile, { keepModel: true })).toBe(true);
		expect(bob.session.readAgentMail().total).toBe(0);
		expect(readRequests(bob).total).toBe(0);
	}, 60_000);

	it("refuses stale mailbox attachments after the owner switches conversation", async () => {
		const bob = await createOwner(homes, { name: "stale-attachment-bob" });
		const client = await socketClient(bob);
		const replacement = SessionManager.create(bob.dir, homes.sessionsRoot);
		await replacement.ensureOnDisk();
		const file = replacement.getCanonicalSessionFile();
		if (!file) throw new Error("missing replacement journal");
		await replacement.close();
		try {
			const attached = await client.send({ type: "agent_mail_list" });
			expect(attached.success).toBe(true);
			expect(await bob.session.switchSession(file, { keepModel: true })).toBe(true);
			const staleRead = await client.send({ type: "agent_mail_list" });
			expect(staleRead.success).toBe(false);
			expect((staleRead as { code?: string }).code).toBe("mail_target_mismatch");
			const staleRestrict = await client.send({
				type: "agent_mail_restrict",
				peer: "11111111-1111-7111-8111-111111111111",
				rule: "block",
			});
			expect(staleRestrict.success).toBe(false);
			expect((staleRestrict as { code?: string }).code).toBe("mail_target_mismatch");
			const retiredContact = await client.send({
				type: "agent_mail_contact",
				peer: "11111111-1111-7111-8111-111111111111",
				rule: "allow",
			} as unknown as RpcCommandBody);
			expect(retiredContact.success).toBe(false);
			expect((retiredContact as { error?: string }).error).toContain("Unknown command");
		} finally {
			await client.stop();
		}
		expect(bob.session.readAgentMail().total).toBe(0);
	}, 60_000);

	it("fences the source across awaited connection setup on the SAME AgentSession", async () => {
		const alice = await createOwner(homes, { name: "source-fence-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "source-fence-bob" });
		await allowMailFrom(bob, alice);
		const replacement = SessionManager.create(alice.dir, homes.sessionsRoot);
		await replacement.ensureOnDisk();
		const file = replacement.getCanonicalSessionFile();
		if (!file) throw new Error("missing source replacement journal");
		await replacement.close();
		const connect = RpcClient.connectSessionSocket;
		const connection = spyOn(RpcClient, "connectSessionSocket").mockImplementationOnce(async options => {
			const client = await connect(options);
			expect(await alice.session.switchSession(file, { keepModel: true })).toBe(true);
			return client;
		});
		let result: AgentMailSendResult;
		try {
			result = await sendMail(alice, { to: bob.session.sessionId, message: "old source must not send" });
		} finally {
			connection.mockRestore();
		}
		expect(result.status).toBe("refused");
		expect(readRequests(bob).total).toBe(0);
		expect(userTexts(bob)).toEqual([]);
	}, 60_000);

	it("binds target UUID, canonical journal and native boot from the connected owner receipt", async () => {
		const alice = await createOwner(homes, { name: "incarnation-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "incarnation-bob" });
		await allowMailFrom(bob, alice);
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
		expect(readRequests(bob).total).toBe(0);
		expect(userTexts(bob)).toEqual([]);
	}, 60_000);

	it("refuses source journal or native boot changes during awaited connection setup", async () => {
		const alice = await createOwner(homes, { name: "source-incarnation-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "source-incarnation-bob" });
		await allowMailFrom(bob, alice);
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
		expect(readRequests(bob).total).toBe(0);
	}, 60_000);

	it("reports an unconfirmed recipient store as unknown and writes no inbox record", async () => {
		const alice = await createOwner(homes, { name: "failed-store-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "failed-store-bob" });
		await allowMailFrom(bob, alice);
		const events: string[] = [];
		bob.session.subscribe(event => {
			if (event.type === "agent_mail") events.push(event.mail.messageId);
		});
		const append = spyOn(bob.manager, "appendCustomEntry").mockImplementationOnce(() => {
			throw new Error("fixture journal failure");
		});
		let result: AgentMailSendResult;
		try {
			result = await sendMail(alice, { to: bob.session.sessionId, message: "rejected during store" });
		} finally {
			append.mockRestore();
		}
		expect(result.status).toBe("unknown");
		expect(bob.session.readAgentMail().total).toBe(0);
		expect(readRequests(bob).total).toBe(0);
		expect(events).toEqual([]);
		expect(userTexts(bob)).toEqual([]);
		expect(bob.session.isStreaming).toBe(false);
	}, 60_000);

	it("refuses an unknown contact with no review host and journals no offer", async () => {
		const alice = await createOwner(homes, { name: "no-host-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "no-host-bob" });
		const refused = await sendMail(alice, { to: bob.session.sessionId, message: "no review host" });
		expect(refused.status).toBe("refused");
		expect((refused as { code?: string }).code).toBe("mail_approval_required");
		expect(mailEntries(alice)).toHaveLength(0);
		expect(bob.session.readAgentMail().total).toBe(0);
		expect(readRequests(bob).total).toBe(0);
		expect(userTexts(bob)).toEqual([]);
		expect(bob.session.isStreaming).toBe(false);
		expect(bob.session.getQueuedMessages()).toEqual({ steering: [], followUp: [], liveSteered: 0 });
	}, 60_000);

	it("treats a cancelled review as no send and stores nothing", async () => {
		const alice = await createOwner(homes, { name: "cancel-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "cancel-bob" });
		const reviews: AgentMailApprovalRequest[] = [];
		const declined = await sendMail(
			alice,
			{ to: bob.session.sessionId, message: "cancelled review" },
			{
				approve: async request => {
					reviews.push(request);
					return "cancel";
				},
			},
		);
		expect(declined.status).toBe("refused");
		expect((declined as { code?: string }).code ?? "").toMatch(/approval/);
		expect(reviews).toHaveLength(1);
		expect(reviews[0]).toMatchObject({
			sender: { sessionId: alice.session.sessionId },
			recipient: { sessionId: bob.session.sessionId },
			message: "cancelled review",
		});
		expect(reviews[0]!.reference.length).toBeGreaterThan(0);
		expect(reviews[0]!.messageId.length).toBeGreaterThan(0);
		expect(mailEntries(alice)).toHaveLength(0);
		expect(bob.session.readAgentMail().total).toBe(0);
		expect(readRequests(bob).total).toBe(0);
		expect(userTexts(bob)).toEqual([]);
	}, 60_000);

	it("stores exactly one live mail for a one-time approval and keeps no grant", async () => {
		const alice = await createOwner(homes, { name: "once-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "once-bob" });
		const reviews: AgentMailApprovalRequest[] = [];
		const first = await sendMail(
			alice,
			{ to: bob.session.sessionId, message: "approved once" },
			{
				approve: async request => {
					reviews.push(request);
					return "once";
				},
			},
		);
		expect(first.status).toBe("accepted");
		expect(reviews).toHaveLength(1);
		expect(bob.session.readAgentMail().total).toBe(1);
		expect(bob.session.readAgentMail().messages.map(record => record.body)).toEqual(["approved once"]);
		expect(reviews[0]).toMatchObject({
			reference: bob.session.sessionId,
			recipient: { sessionId: bob.session.sessionId },
			message: "approved once",
			messageId: bob.session.readAgentMail().messages[0]!.messageId,
		});
		expect(readRequests(bob).total).toBe(0);
		const second = await sendMail(alice, { to: bob.session.sessionId, message: "second needs review" });
		expect(second.status).toBe("refused");
		expect((second as { code?: string }).code).toBe("mail_approval_required");
		expect(bob.session.readAgentMail().total).toBe(1);
		expect(readRequests(bob).total).toBe(0);
		expect(mailEntries(bob)).toHaveLength(1);
	}, 60_000);

	it("persists an always-allow grant after reopen and only in that direction", async () => {
		const alice = await createOwner(homes, { name: "always-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "always-bob", toolNames: ["agent_mail"] });
		const reviews: AgentMailApprovalRequest[] = [];
		const first = await sendMail(
			alice,
			{ to: bob.session.sessionId, message: "always first" },
			{
				approve: async request => {
					reviews.push(request);
					return "always";
				},
			},
		);
		expect(first.status).toBe("accepted");
		expect(reviews).toHaveLength(1);
		expect(bob.session.readAgentMail().total).toBe(1);
		const bobId = bob.session.sessionId;
		const sessionFile = bob.manager.getCanonicalSessionFile();
		if (!sessionFile) throw new Error("missing bob journal");
		const bobIndex = owners.indexOf(bob);
		if (bobIndex >= 0) owners.splice(bobIndex, 1);
		await bob.dispose();

		const inspected = await reopenOwner(sessionFile, bob.dir);
		expect(inspected.session.readAgentMail().total).toBe(1);
		expect(inspected.session.getAgentMailPolicy(alice.session.sessionId).rule).toBe("allow");
		const inspectedIndex = owners.indexOf(inspected);
		if (inspectedIndex >= 0) owners.splice(inspectedIndex, 1);
		await inspected.dispose();

		const second = await sendMail(alice, { to: bobId, message: "after reopen" });
		expect(second.status).toBe("accepted");
		expect(reviews).toHaveLength(1);

		const reopened = await reopenOwner(sessionFile, bob.dir);
		const inbox = reopened.session.readAgentMail();
		expect(inbox.messages.map(record => record.body)).toEqual(["always first", "after reopen"]);
		expect(inbox.messages[1]!.target.bootId).toBeNull();
		expect(reopened.session.getAgentMailPolicy(alice.session.sessionId).rule).toBe("allow");
		expect(alice.session.getAgentMailPolicy(bobId).rule).toBe("unknown");
		expect(readRequests(reopened).total).toBe(0);
	}, 60_000);

	it("skips the review for an existing grant and refuses a blocked contact without a dialog", async () => {
		const alice = await createOwner(homes, { name: "granted-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "granted-bob" });
		await allowMailFrom(bob, alice);
		let dialogs = 0;
		const approve = async (): Promise<AgentMailApproval> => {
			dialogs += 1;
			return "once";
		};
		const approved = await sendMail(
			alice,
			{ to: bob.session.sessionId, message: "existing grant" },
			{ approve },
		);
		expect(approved.status).toBe("accepted");
		expect(dialogs).toBe(0);
		expect(bob.session.readAgentMail().total).toBe(1);
		await bob.session.setAgentMailContact({ peer: alice.session.sessionId, rule: "block" });
		const blocked = await sendMail(
			alice,
			{ to: bob.session.sessionId, message: "blocked needs no dialog" },
			{ approve },
		);
		expect(blocked.status).toBe("refused");
		expect((blocked as { code?: string }).code).toBe("mail_contact_blocked");
		expect(dialogs).toBe(0);
		expect(bob.session.readAgentMail().total).toBe(1);
		expect(readRequests(bob).total).toBe(0);
	}, 60_000);

	it("does not store mail or a lasting grant when the recipient resets consent during review", async () => {
		const alice = await createOwner(homes, { name: "review-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "review-bob" });
		const peer = alice.session.sessionId;
		const result = await sendMail(alice, { to: bob.session.sessionId, message: "outdated review" }, {
			approve: async () => {
				// A reset still displays as unknown, but invalidates the decision being reviewed.
				await bob.session.setAgentMailContact({ peer, rule: "reset" });
				return "always";
			},
		});
		expect(result).toMatchObject({ status: "refused", code: "mail_policy_changed" });
		expect(bob.session.getAgentMailPolicy(peer).rule).toBe("unknown");
		expect(bob.session.readAgentMail().total).toBe(0);
		expect(readRequests(bob).total).toBe(0);
	}, 60_000);

	it("accepts a real-socket reply and validates the thread, reference and participants", async () => {
		const alice = await createOwner(homes, { name: "reply-alice", toolNames: ["agent_mail", "agent_sessions"] });
		const bob = await createOwner(homes, { name: "reply-bob", toolNames: ["agent_mail", "agent_sessions"] });
		await allowMailFrom(bob, alice);
		await allowMailFrom(alice, bob);
		await assignSessionIdentity(alice.manager, { actorHandle: "reply.alice" });
		await assignSessionIdentity(bob.manager, { actorHandle: "reply.bob" });
		const original = await sendMail(alice, { to: "reply.bob", message: "please check this native thread" });
		if (original.status !== "accepted") throw new Error("original mail refused");
		await waitFor(() => bob.session.readAgentMail().total === 1, "original mail to be stored");
		const received = bob.session.readAgentMail().messages[0]!;
		expect(received.messageId).toBe(original.receipt.messageId);
		expect(received.folder).toBe("inbox");
		expect(received.sender).toMatchObject({ sessionId: alice.session.sessionId, handle: "reply.alice" });
		const replied = await sendMail(bob, {
			to: alice.session.sessionId,
			message: "the thread is checked",
			threadId: received.threadId,
			replyTo: received.messageId,
		});
		if (replied.status !== "accepted") throw new Error("reply refused");
		await waitFor(() => alice.session.readAgentMail().total === 1, "reply to be stored");
		const reply = alice.session.readAgentMail().messages[0]!;
		expect(reply).toMatchObject({
			messageId: replied.receipt.messageId,
			threadId: received.threadId,
			replyTo: received.messageId,
			sender: { sessionId: bob.session.sessionId, handle: "reply.bob" },
			recipient: { sessionId: alice.session.sessionId, handle: "reply.alice" },
			source: bob.session.agentMailIncarnation(),
			target: alice.session.agentMailIncarnation(),
		});
		const wrongThread = await sendMail(bob, {
			to: alice.session.sessionId,
			message: "invalid reply",
			threadId: "another-thread",
			replyTo: received.messageId,
		});
		expect(wrongThread.status).toBe("refused");
		const unknownReply = await sendMail(bob, {
			to: alice.session.sessionId,
			message: "invalid reply",
			threadId: received.threadId,
			replyTo: "unknown-message",
		});
		expect(unknownReply.status).toBe("refused");
		expect(alice.session.readAgentMail().total).toBe(1);
		expect(bob.session.readAgentMail().total).toBe(1);
		expect(readRequests(alice).total).toBe(0);
		expect(readRequests(bob).total).toBe(0);
	}, 60_000);

	it("accepts a valid reply even when the original sender lost its native delivery receipt", async () => {
		const alice = await createOwner(homes, { name: "unknown-reply-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "unknown-reply-bob", toolNames: ["agent_mail"] });
		await allowMailFrom(bob, alice);
		await allowMailFrom(alice, bob);
		const send = RpcClient.prototype.send;
		const lostAck = spyOn(RpcClient.prototype, "send").mockImplementation(
			async function (this: RpcClient, command, timeout): Promise<RpcResponse> {
				const response = await send.call(this, command, timeout);
				if (command.type === "agent_mail_deliver_consented" && command.recipientSessionId === bob.session.sessionId)
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
		type DeliverCommand = Extract<RpcCommandBody, { type: "agent_mail_deliver_consented" }>;
		const deliver = (patch: Partial<DeliverCommand>) =>
			client.send({
				type: "agent_mail_deliver_consented",
				...wireTarget(bob),
				message: "should never be admitted",
				delivery: "inbox",
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
			const legacyLane = await client.send({
				type: "agent_mail_deliver_consented",
				...wireTarget(bob),
				message: "old lane",
				delivery: "queue",
				sentAt: Date.now(),
				...wireSource(alice),
				capabilityToken: "not-a-real-capability",
			} as unknown as RpcCommandBody);
			expect(legacyLane.success).toBe(false);
			expect((legacyLane as { error?: string }).error).toContain("inbox");
			const retiredDeliver = await client.send({
				type: "agent_mail_deliver",
				...wireTarget(bob),
				message: "retired opcode",
				delivery: "inbox",
				sentAt: Date.now(),
				...wireSource(alice),
				capabilityToken: "not-a-real-capability",
			} as unknown as RpcCommandBody);
			expect(retiredDeliver.success).toBe(false);
			expect((retiredDeliver as { error?: string }).error).toContain("Unknown command");
		} finally {
			await client.stop();
		}
		expect(events).toHaveLength(0);
		expect(bob.session.readAgentMail().total).toBe(0);
		expect(readRequests(bob).total).toBe(0);
	}, 60_000);

	it("reports timeout as unknown, refuses mutated evidence, and never reuses a consumed proof", async () => {
		const alice = await createOwner(homes, { name: "forgery-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "forgery-bob" });
		writeSidecar(homes, "silent-target", process.pid);
		const silent = await silentEndpoint("silent-target");
		const pending = sendMail(
			alice,
			{ to: "silent-target", message: "genuine body", threadId: "thread-1" },
			{ responseTimeoutMs: 2_000 },
		);
		await waitFor(
			() => silent.captured.some(frame => frame.type === "agent_mail_deliver_consented"),
			"captured delivery",
		);
		const captured = silent.captured.find(frame => frame.type === "agent_mail_deliver_consented")! as Extract<
			RpcCommandBody,
			{ type: "agent_mail_deliver_consented" }
		>;
		const preflight = silent.captured.find(frame => frame.type === "agent_mail_policy");
		expect(preflight).toMatchObject({
			peer: alice.session.sessionId,
			recipientSessionId: "silent-target",
			recipientSessionFile: path.join(homes.root, "silent-target.jsonl"),
			recipientBootId: readRuntimeBootIdentity().bootId,
		});
		expect(preflight && "message" in preflight).toBe(false);
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
		const deliveries = () =>
			silent.captured.filter(frame => frame.type === "agent_mail_deliver_consented").length;
		expect(deliveries()).toBe(1);
		await Bun.sleep(100);
		expect(deliveries()).toBe(1);
		const client = await socketClient(bob);
		try {
			const forged = await client.send({
				...captured,
				...wireTarget(bob),
				type: "agent_mail_deliver_consented",
			});
			expect(forged.success).toBe(false);
			expect((forged as { code?: string }).code).toBe("mail_sender_unverified");
		} finally {
			await client.stop();
		}
		expect(bob.session.readAgentMail().total).toBe(0);
		expect(readRequests(bob).total).toBe(0);
	}, 60_000);

	it("retains bounded history across a real journal reopen without leaking other sessions", async () => {
		const alice = await createOwner(homes, { name: "reopen-alice", toolNames: ["agent_mail", "agent_sessions"] });
		const bob = await createOwner(homes, { name: "reopen-bob" });
		const carol = await createOwner(homes, { name: "reopen-carol" });
		await allowMailFrom(bob, alice);
		const first = await sendMail(alice, { to: bob.session.sessionId, message: "reopen probe" });
		expect(first.status).toBe("accepted");
		const second = await sendMail(alice, { to: bob.session.sessionId, message: "second probe" });
		expect(second.status).toBe("accepted");
		if (first.status !== "accepted") throw new Error("unreachable");

		// Another owner's journal never shows bob's mail.
		expect(carol.session.readAgentMail().total).toBe(0);

		// Bounded read before reopen, then the older page via its cursor.
		const bounded = bob.session.readAgentMail({ limit: 1 });
		expect(bounded.messages).toHaveLength(1);
		expect(bounded.total).toBe(2);
		expect(bounded.truncated).toBe(true);
		expect(bounded.messages[0]!.body).toBe("second probe");
		const cursor = bounded.nextBefore;
		if (cursor === undefined) throw new Error("missing paging cursor");
		expect(cursor).toBe(bounded.messages[0]!.messageId);
		const older = bob.session.readAgentMail({ limit: 1, before: cursor });
		expect(older.messages.map(record => record.body)).toEqual(["reopen probe"]);
		expect(older.truncated).toBe(false);
		expect(older.nextBefore).toBeUndefined();

		// Real reopen: dispose the owner, reopen the same journal, provenance survives.
		const sessionFile = bob.manager.getCanonicalSessionFile();
		if (!sessionFile) throw new Error("missing bob journal");
		const bobIndex = owners.indexOf(bob);
		if (bobIndex >= 0) owners.splice(bobIndex, 1);
		await bob.dispose();
		const reopened = await reopenOwner(sessionFile, bob.dir);
		const history = reopened.session.readAgentMail();
		expect(history.total).toBe(2);
		expect(history.messages.map(record => record.body)).toEqual(["reopen probe", "second probe"]);
		const threadRead = reopened.session.readAgentMail({
			threadId: first.receipt.threadId,
		});
		expect(threadRead.total).toBeGreaterThan(0);
		expect(readRequests(reopened).total).toBe(0);
	}, 60_000);

	it("renames with a stable UUID, refuses collisions and the old handle", async () => {
		const alice = await createOwner(homes, { name: "rename-alice", toolNames: ["agent_mail", "agent_sessions"] });
		const bob = await createOwner(homes, { name: "rename-bob" });
		const mallory = await createOwner(homes, { name: "rename-mallory" });
		await allowMailFrom(bob, alice);
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
		expect(readRequests(bob).total).toBe(0);

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

	it("refuses a dead or changed target before writing its journal", async () => {
		const alice = await createOwner(homes, { name: "dead-target-alice", toolNames: ["agent_mail"] });
		writeSidecar(homes, "dead-target", 2_147_483_647);
		const result = await sendMail(alice, { to: "dead-target", message: "must not be stored" });
		expect(result.status).toBe("refused");
		expect(fs.existsSync(path.join(homes.runDir, "dead-target.json"))).toBe(true);
		expect(fs.readdirSync(homes.sessionsRoot).filter(name => name.includes("dead-target"))).toEqual([]);
		const discovery = await alice.session.discoverAgentMailSessions();
		expect(discovery.sessions.find(entry => entry.sessionId === "dead-target")?.availability).toBe("unavailable");
		expect(mailEntries(alice)).toHaveLength(0);
	}, 60_000);

	it("keeps pre-upgrade mail in its historical folder and folderless mail in the inbox", async () => {
		const alice = await createOwner(homes, { name: "legacy-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "legacy-bob" });
		await appendLegacyMail(bob, alice, "legacy steering record");
		await appendLegacyMail(bob, alice, "legacy request record", "requests");
		const inbox = bob.session.readAgentMail();
		expect(inbox.total).toBe(1);
		expect(inbox.messages[0]).toMatchObject({
			body: "legacy steering record",
			delivery: "steer",
			admission: "steering",
		});
		expect(inbox.messages[0]!.folder).toBeUndefined();
		expect(bob.session.readAgentMail({ folder: "inbox" }).total).toBe(1);
		const historical = readRequests(bob);
		expect(historical.total).toBe(1);
		expect(historical.messages[0]!.body).toBe("legacy request record");
		expect(historical.messages[0]!.folder).toBe("requests");
		expect(userTexts(bob)).toEqual([]);
	}, 60_000);

	it("emits no unsolicited mail event and serves explicit reads after reconnect", async () => {
		const alice = await createOwner(homes, { name: "event-alice", toolNames: ["agent_mail", "agent_sessions"] });
		const bob = await createOwner(homes, { name: "event-bob" });
		await allowMailFrom(bob, alice);
		const viewer = await socketClient(bob);
		const seen: string[] = [];
		const unsubscribe = viewer.onSessionEvent(event => {
			if (event.type === "agent_mail") seen.push(event.mail.messageId);
		});
		const sent = await sendMail(alice, { to: bob.session.sessionId, message: "event probe" });
		expect(sent.status).toBe("accepted");
		expect(seen).toEqual([]);
		expect(bob.session.messages).toEqual([]);
		expect(bob.session.isStreaming).toBe(false);
		const read = await viewer.send({ type: "agent_mail_list", limit: 10 });
		expect(read.success).toBe(true);
		const data = (read as { data?: { messages?: { body: string }[]; total?: number } }).data;
		expect(data?.total).toBe(1);
		expect(data?.messages?.[0]?.body).toBe("event probe");
		unsubscribe();
		await viewer.stop();

		// Reconnect: the same owner method serves the explicit read over the socket.
		const reconnected = await socketClient(bob);
		try {
			const again = await reconnected.send({ type: "agent_mail_list" });
			expect(again.success).toBe(true);
			const againData = (again as { data?: { total?: number } }).data;
			expect(againData?.total).toBe(1);
		} finally {
			await reconnected.stop();
		}
		expect(readRequests(bob).total).toBe(0);
	}, 60_000);

	it("rejects malformed numeric, thread and folder input", async () => {
		const bob = await createOwner(homes, { name: "validate-bob" });
		const client = await socketClient(bob);
		try {
			const badRead = await client.send({ type: "agent_mail_list", limit: 2.5 });
			expect(badRead.success).toBe(false);
			const zeroRead = await client.send({ type: "agent_mail_list", limit: 0 });
			expect(zeroRead.success).toBe(false);
			const emptyThread = await client.send({ type: "agent_mail_list", threadId: "" });
			expect(emptyThread.success).toBe(false);
			const badFolder = await client.send({
				type: "agent_mail_list",
				folder: "archive",
			} as unknown as RpcCommandBody);
			expect(badFolder.success).toBe(false);
			const badThread = await client.send({
				type: "agent_mail_deliver_consented",
				...wireTarget(bob),
				message: "x",
				threadId: "",
				delivery: "inbox",
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
		expect(() => bob.session.readAgentMail({ folder: "archive" as never })).toThrow();
	}, 60_000);

	it("keeps the tools opt-in only and dispatches through a real mocked agent-loop turn", async () => {
		const plain = await createOwner(homes, { name: "plain" });
		expect(plain.session.getToolByName("agent_mail")).toBeUndefined();
		expect(plain.session.getToolByName("agent_sessions")).toBeUndefined();
		const mailOnly = await createOwner(homes, { name: "mail-only", toolNames: ["agent_mail"] });
		expect(mailOnly.session.getToolByName("agent_mail")).toBeDefined();
		expect(mailOnly.session.getToolByName("agent_sessions")).toBeUndefined();
		const restricted = await createOwner(homes, {
			name: "restricted-mail",
			toolNames: ["agent_mail"],
			restrictToolNames: true,
		});
		expect(restricted.session.agent.state.tools.map(tool => tool.name)).toEqual(["agent_mail"]);
		expect(restricted.session.getToolByName("agent_sessions")).toBeUndefined();

		// Contact rules stay on the recipient owner's RPC; no tool parameter grants them.
		const mailTool = toolOf<AgentMailTool>(restricted, "agent_mail");
		const parameters: unknown = mailTool.parameters;
		expect(isRecord(parameters) && isRecord(parameters.properties) && "rule" in parameters.properties).toBe(false);

		const bob = await createOwner(homes, { name: "dispatch-bob" });
		await assignSessionIdentity(bob.manager, { actorHandle: "auditbob" });
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
								to: "auditbob",
								message: "dispatched from a mocked agent-loop turn",
							},
						},
					],
				},
				{ content: [{ type: "text", text: "mailed" }] },
			],
			toolNames: ["agent_mail", "agent_sessions"],
		});
		const reviews: AgentMailApprovalRequest[] = [];
		await withMailApprovalContext(
			"mail auditbob the audit request",
			async request => {
				reviews.push(request);
				return "once";
			},
			() => alice.session.prompt("mail auditbob the audit request"),
		);
		await waitFor(
			() => bob.session.readAgentMail().total === 1,
			"bob to store mail dispatched from a mocked agent-loop turn",
		);
		const stored = bob.session.readAgentMail().messages[0]!;
		expect(stored.body).toBe("dispatched from a mocked agent-loop turn");
		expect(reviews).toHaveLength(1);
		expect(reviews[0]).toMatchObject({
			reference: "auditbob",
			sender: { sessionId: alice.session.sessionId },
			recipient: { sessionId: bob.session.sessionId, handle: "auditbob" },
			message: "dispatched from a mocked agent-loop turn",
			messageId: stored.messageId,
		});
		expect(readRequests(bob).total).toBe(0);

		const unreviewed = await toolOf<AgentMailTool>(alice, "agent_mail").execute(`t-${Snowflake.next()}`, {
			op: "send",
			to: bob.session.sessionId,
			message: "outside the operator turn",
		});
		expect(unreviewed.isError).toBe(true);
		const refusedDetails = unreviewed.details as {
			op: string;
			result?: { status?: string; code?: string };
		};
		expect(refusedDetails).toMatchObject({
			op: "send",
			result: { status: "refused", code: "mail_approval_required" },
		});
		expect(bob.session.readAgentMail().total).toBe(1);
		expect(mailEntries(bob)).toHaveLength(1);

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

	it("respects sender mail enablement for direct owner API and RPC posts", async () => {
		const alice = await createOwner(homes, { name: "disabled-alice" });
		const bob = await createOwner(homes, { name: "disabled-bob" });
		const direct = await sendMail(alice, { to: bob.session.sessionId, message: "direct disabled" });
		expect(direct.status).toBe("refused");
		expect((direct as { code?: string }).code).toBe("mail_send_disabled");
		const client = await socketClient(alice);
		try {
			const post = await client.send({
				type: "agent_mail_post_consented",
				to: bob.session.sessionId,
				message: "rpc disabled",
			});
			expect(post.success).toBe(true);
			const data: unknown = post.success && "data" in post ? post.data : undefined;
			expect(data).toMatchObject({ status: "refused", code: "mail_send_disabled" });
			const retired = await client.send({
				type: "agent_mail_post",
				to: bob.session.sessionId,
				message: "retired post",
			} as unknown as RpcCommandBody);
			expect(retired.success).toBe(false);
			expect((retired as { error?: string }).error).toContain("Unknown command");
		} finally {
			await client.stop();
		}
		expect(bob.session.readAgentMail().total).toBe(0);
		expect(readRequests(bob).total).toBe(0);
	}, 60_000);

	it("posts through agent_mail_post_consented only with an existing grant", async () => {
		const alice = await createOwner(homes, { name: "api-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "api-bob" });
		await allowMailFrom(bob, alice);
		const types: string[] = [];
		const send = RpcClient.prototype.send;
		const observed = spyOn(RpcClient.prototype, "send").mockImplementation(
			async function (this: RpcClient, command, timeout): Promise<RpcResponse> {
				types.push(command.type);
				return send.call(this, command, timeout);
			},
		);
		const client = await socketClient(alice);
		try {
			const api = new NativeSessionApi({
				request: command => client.send(command),
				observe: () => () => {},
			});
			const result = await api.sendMail({ to: bob.session.sessionId, message: "api post" });
			expect(result.status).toBe("accepted");
			const legacyLane = await client.send({
				type: "agent_mail_post_consented",
				to: bob.session.sessionId,
				message: "legacy lane",
				delivery: "queue",
			} as unknown as RpcCommandBody);
			expect(legacyLane.success).toBe(false);
			expect((legacyLane as { error?: string }).error).toContain("delivery");
			const intent = await client.send({
				type: "agent_mail_post_consented",
				to: bob.session.sessionId,
				message: "legacy intent",
				intent: "request",
			} as unknown as RpcCommandBody);
			expect(intent.success).toBe(false);
			expect((intent as { error?: string }).error).toContain("intent");
		} finally {
			await client.stop();
			observed.mockRestore();
		}
		expect(types).toContain("agent_mail_post_consented");
		expect(types).not.toContain("agent_mail_post");
		expect(types).not.toContain("agent_mail_send");
		await waitFor(() => bob.session.readAgentMail().total === 1, "api mail to be stored");
		expect(bob.session.readAgentMail().messages[0]!.body).toBe("api post");
		expect(readRequests(bob).total).toBe(0);
	}, 60_000);

	it("never lets a raw post supply approval or open a review on the sender", async () => {
		const alice = await createOwner(homes, { name: "raw-approval-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "raw-approval-bob" });
		await assignSessionIdentity(bob.manager, { actorHandle: "rawbob" });
		const original = alice.session.sendAgentMail.bind(alice.session);
		const calls: Array<{ options?: unknown }> = [];
		const observed = spyOn(alice.session, "sendAgentMail").mockImplementation((params, options) => {
			calls.push({ options });
			return original(params, options);
		});
		let dialogs = 0;
		const client = await socketClient(alice);
		try {
			await withMailApprovalContext(
				"post to rawbob",
				async () => {
					dialogs += 1;
					return "always";
				},
				async () => {
					const guarded = await client.send({
						type: "agent_mail_post_consented",
						to: "rawbob",
						message: "model-supplied approval",
						approval: "always",
						approve: true,
					} as unknown as RpcCommandBody);
					expect(guarded.success).toBe(false);
					expect((guarded as { code?: string }).code).toBe("mail_operator_required");
					expect((guarded as { error?: string }).error).toContain("wire argument");
					const plain = await client.send({
						type: "agent_mail_post_consented",
						to: "rawbob",
						message: "no approval fields",
					});
					expect(plain.success).toBe(true);
					const data: unknown = plain.success && "data" in plain ? plain.data : undefined;
					expect(data).toMatchObject({ status: "refused", code: "mail_approval_required" });
				},
			);
			expect(dialogs).toBe(0);
			expect(calls).toHaveLength(1);
			expect(calls[0]!.options).toBeUndefined();
			expect(bob.session.readAgentMail().total).toBe(0);
			expect(readRequests(bob).total).toBe(0);
			expect(mailEntries(alice)).toHaveLength(0);

			await allowMailFrom(bob, alice);
			const accepted = await client.send({
				type: "agent_mail_post_consented",
				to: "rawbob",
				message: "existing grant only",
			});
			expect(accepted.success).toBe(true);
			const sent: unknown = accepted.success && "data" in accepted ? accepted.data : undefined;
			expect(sent).toMatchObject({ status: "accepted" });
			expect(dialogs).toBe(0);
			expect(calls).toHaveLength(2);
			expect(calls.every(call => call.options === undefined)).toBe(true);
			expect(bob.session.readAgentMail().total).toBe(1);
			expect(readRequests(bob).total).toBe(0);
		} finally {
			await client.stop();
			observed.mockRestore();
		}
	}, 60_000);

	it("owns contact rules on the recipient and keeps unknown senders out", async () => {
		const alice = await createOwner(homes, { name: "contact-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "contact-bob" });
		const client = await socketClient(bob);
		try {
			const unknown = await sendMail(alice, { to: bob.session.sessionId, message: "unknown sender" });
			expect(unknown.status).toBe("refused");
			expect((unknown as { code?: string }).code).toBe("mail_approval_required");
			expect(mailEntries(alice)).toHaveLength(0);
			expect(bob.session.readAgentMail().total).toBe(0);
			expect(readRequests(bob).total).toBe(0);
			expect(userTexts(bob)).toEqual([]);
			expect(bob.session.isStreaming).toBe(false);
			expect(bob.session.getQueuedMessages()).toEqual({ steering: [], followUp: [], liveSteered: 0 });

			const retired = await client.send({
				type: "agent_mail_contact",
				peer: alice.session.sessionId,
				rule: "allow",
			} as unknown as RpcCommandBody);
			expect(retired.success).toBe(false);
			expect((retired as { error?: string }).error).toContain("Unknown command");

			for (const invalid of [
				{ peer: alice.session.sessionId, rule: "allow" },
				{ peer: "contact-alice", rule: "block" },
				{ peer: bob.session.sessionId, rule: "block" },
				{ peer: alice.session.sessionId, rule: "queue" },
			]) {
				const refused = await client.send({
					type: "agent_mail_restrict",
					...invalid,
				} as unknown as RpcCommandBody);
				expect(refused.success).toBe(false);
			}
			expect(bob.session.readAgentMail().total).toBe(0);
			expect(readRequests(bob).total).toBe(0);

			await allowMailFrom(bob, alice);
			const approved = await sendMail(alice, { to: bob.session.sessionId, message: "approved sender" });
			expect(approved.status).toBe("accepted");
			expect(bob.session.readAgentMail().messages.map(record => record.body)).toEqual(["approved sender"]);
			expect(readRequests(bob).total).toBe(0);
			expect(userTexts(bob)).toEqual([]);
			expect(bob.session.isStreaming).toBe(false);

			let dialogs = 0;
			const blocked = await client.send({
				type: "agent_mail_restrict",
				peer: alice.session.sessionId,
				rule: "block",
			});
			expect(blocked.success).toBe(true);
			const refused = await sendMail(
				alice,
				{ to: bob.session.sessionId, message: "blocked sender" },
				{
					approve: async () => {
						dialogs += 1;
						return "once";
					},
				},
			);
			expect(refused.status).toBe("refused");
			expect((refused as { code?: string }).code).toBe("mail_contact_blocked");
			expect(dialogs).toBe(0);
			expect(bob.session.readAgentMail().total).toBe(1);
			expect(readRequests(bob).total).toBe(0);

			const reset = await client.send({
				type: "agent_mail_restrict",
				peer: alice.session.sessionId,
				rule: "reset",
			});
			expect(reset.success).toBe(true);
			const again = await sendMail(alice, { to: bob.session.sessionId, message: "reset sender" });
			expect(again.status).toBe("refused");
			expect((again as { code?: string }).code).toBe("mail_approval_required");
			expect(bob.session.readAgentMail().total).toBe(1);
			expect(readRequests(bob).total).toBe(0);
		} finally {
			await client.stop();
		}
	}, 60_000);

	it("deposits one approved mail into a sleeping owner's journal without a lasting grant", async () => {
		const alice = await createOwner(homes, { name: "offline-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "offline-bob" });
		const bobId = bob.session.sessionId;
		const sessionFile = bob.manager.getCanonicalSessionFile();
		if (!sessionFile) throw new Error("missing bob journal");
		const index = owners.indexOf(bob);
		if (index >= 0) owners.splice(index, 1);
		await bob.dispose();
		await waitFor(() => !fs.existsSync(sessionAttachEndpoint(bobId)), "bob's endpoint to be withdrawn");
		await waitFor(() => !fs.existsSync(path.join(homes.runDir, `${bobId}.json`)), "bob's sidecar to be withdrawn");

		const reviews: AgentMailApprovalRequest[] = [];
		const result = await sendMail(
			alice,
			{ to: bobId, message: "offline deposit" },
			{
				approve: async request => {
					reviews.push(request);
					return "once";
				},
			},
		);
		expect(result.status).toBe("accepted");
		if (result.status !== "accepted") throw new Error("unreachable");
		expect(reviews).toHaveLength(1);
		expect(reviews[0]).toMatchObject({
			sender: { sessionId: alice.session.sessionId },
			recipient: { sessionId: bobId },
			message: "offline deposit",
		});
		expect(result.receipt.admission).toBe("stored");
		expect(result.receipt.target).toMatchObject({ sessionId: bobId, sessionFile, bootId: null });
		expect(fs.existsSync(sessionAttachEndpoint(bobId))).toBe(false);
		expect(fs.existsSync(path.join(homes.runDir, `${bobId}.json`))).toBe(false);
		const inspected = await new NativeSessionService({
			sessionsRoot: homes.sessionsRoot,
			endpointDir: homes.runDir,
			timeoutMs: 200,
		}).inspect(bobId);
		expect(inspected.availability).toBe("offline");

		const again = await sendMail(alice, { to: bobId, message: "second offline mail" });
		expect(again.status).toBe("refused");
		expect((again as { code?: string }).code).toBe("mail_approval_required");
		expect(reviews).toHaveLength(1);

		const reopened = await reopenOwner(sessionFile, bob.dir);
		const inbox = reopened.session.readAgentMail();
		expect(inbox.messages.map(record => record.body)).toEqual(["offline deposit"]);
		expect(reviews[0]).toMatchObject({ messageId: inbox.messages[0]!.messageId });
		expect(inbox.messages[0]!.target.bootId).toBeNull();
		expect(inbox.messages[0]!.folder).toBe("inbox");
		expect(readRequests(reopened).total).toBe(0);
		expect(userTexts(reopened)).toEqual([]);
	}, 60_000);

	it("persists an offline always-allow grant with the first accepted mail", async () => {
		const alice = await createOwner(homes, { name: "offline-always-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "offline-always-bob" });
		const bobId = bob.session.sessionId;
		const sessionFile = bob.manager.getCanonicalSessionFile();
		if (!sessionFile) throw new Error("missing bob journal");
		const index = owners.indexOf(bob);
		if (index >= 0) owners.splice(index, 1);
		await bob.dispose();
		await waitFor(() => !fs.existsSync(sessionAttachEndpoint(bobId)), "bob's endpoint to be withdrawn");
		await waitFor(() => !fs.existsSync(path.join(homes.runDir, `${bobId}.json`)), "bob's sidecar to be withdrawn");

		let reviews = 0;
		const first = await sendMail(
			alice,
			{ to: bobId, message: "offline always first" },
			{
				approve: async () => {
					reviews += 1;
					return "always";
				},
			},
		);
		expect(first.status).toBe("accepted");
		expect(reviews).toBe(1);
		const second = await sendMail(alice, { to: bobId, message: "offline always second" });
		expect(second.status).toBe("accepted");
		expect(reviews).toBe(1);

		const reopened = await reopenOwner(sessionFile, bob.dir);
		const inbox = reopened.session.readAgentMail();
		expect(inbox.messages.map(record => record.body)).toEqual([
			"offline always first",
			"offline always second",
		]);
		expect(inbox.messages[0]!.target.bootId).toBeNull();
		expect(readRequests(reopened).total).toBe(0);
		expect(userTexts(reopened)).toEqual([]);
	}, 60_000);

	it("keeps recipient contact policy across a sleeping handoff", async () => {
		const alice = await createOwner(homes, { name: "handoff-alice", toolNames: ["agent_mail"] });
		const bob = await createOwner(homes, { name: "handoff-bob" });
		const bobId = bob.session.sessionId;
		const sessionFile = bob.manager.getCanonicalSessionFile();
		if (!sessionFile) throw new Error("missing bob journal");
		await allowMailFrom(bob, alice);
		const index = owners.indexOf(bob);
		if (index >= 0) owners.splice(index, 1);
		await bob.dispose();
		await waitFor(() => !fs.existsSync(sessionAttachEndpoint(bobId)), "bob's endpoint to be withdrawn");

		let dialogs = 0;
		const result = await sendMail(
			alice,
			{ to: bobId, message: "allowed while asleep" },
			{
				approve: async () => {
					dialogs += 1;
					return "once";
				},
			},
		);
		expect(result.status).toBe("accepted");
		expect(dialogs).toBe(0);
		const reopened = await reopenOwner(sessionFile, bob.dir);
		const inbox = reopened.session.readAgentMail();
		expect(inbox.messages.map(record => record.body)).toEqual(["allowed while asleep"]);
		expect(inbox.messages[0]!.folder).toBe("inbox");
		expect(readRequests(reopened).total).toBe(0);
		expect(userTexts(reopened)).toEqual([]);
	}, 60_000);

	it("refuses the retired actor_mail prompt envelope and leaves normal human input alone", async () => {
		const bob = await createOwner(homes, {
			name: "ingress-bob",
			responses: [{ content: [{ type: "text", text: "ack" }] }],
		});
		const client = await socketClient(bob);
		try {
			for (const type of ["prompt", "steer", "follow_up"] as const) {
				const refused = await client.send({
					type,
					message: '<actor_mail from="someone">peer mail</actor_mail>',
				} as unknown as RpcCommandBody);
				expect(refused.success).toBe(false);
				expect((refused as { code?: string }).code).toBe("mail_requires_mailbox");
			}
			expect(bob.session.messages).toEqual([]);
			expect(bob.session.readAgentMail().total).toBe(0);
			const normal = await client.send({ type: "prompt", message: "plain human input" });
			expect(normal.success).toBe(true);
			await waitFor(
				() => userTexts(bob).some(text => text.includes("plain human input")),
				"normal human input to be admitted",
			);
		} finally {
			await client.stop();
		}
		expect(bob.session.readAgentMail().total).toBe(0);
	}, 60_000);

	it("rejects the retired send command instead of waking the target", async () => {
		const bob = await createOwner(homes, { name: "legacy-command-bob" });
		const client = await socketClient(bob);
		try {
			const legacy = await client.send({
				type: "agent_mail_send",
				to: bob.session.sessionId,
				message: "legacy command",
			} as unknown as RpcCommandBody);
			expect(legacy.success).toBe(false);
			expect((legacy as { error?: string }).error).toContain("Unknown command");
		} finally {
			await client.stop();
		}
		expect(bob.session.messages).toEqual([]);
		expect(bob.session.isStreaming).toBe(false);
		expect(bob.session.readAgentMail({ folder: "requests" }).total).toBe(0);
	}, 60_000);
});
