/**
 * `get_mcp_status` / `set_mcp_enabled` / `mcp_reauth` over both transports.
 *
 * The command surface is one implementation for stdio (`runRpcMode`) and an
 * attached session socket, so every case is driven through real transports:
 * the stdio half uses a real `MCPManager` and a real stdio fixture server, the
 * socket half publishes the same surface on a `RpcSessionSocket` so the
 * `extension_ui_response` side channel is exercised while `mcp_reauth` is in
 * flight — the deadlock that serialised command dispatch would cause.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import * as oauthFlow from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import * as oauthReauth from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import { createAgentSessionSocket, type RpcSessionSocket } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-socket";
import {
	type ServedSessionSocket,
	serveInteractiveSessionSocket,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-command-surface";
import {
	getMCPConfigPath,
	getProjectDir,
	removeSyncWithRetries,
	setAgentDir,
	setProjectDir,
	withTimeout,
} from "@oh-my-pi/pi-utils";
import { clearCache as clearFsCache } from "../src/capability/fs";
import { loadAllMCPConfigs } from "../src/mcp/config";
import { readMCPConfigFile, writeMCPConfigFile } from "../src/mcp/config-writer";
import { MCPManager } from "../src/mcp/manager";
import type { MCPServerConfig, MCPStdioServerConfig } from "../src/mcp/types";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { createRpcSurfaceHarness } from "./helpers/rpc-command-surface";
import { createMcpManagerStub, createSessionStub } from "./helpers/interactive-mode-context";

const STDIO_SERVER = "stub-tools";
const DISABLED_SERVER = "disabled-tools";
const HTTP_SERVER = "vault";
const FIXTURE = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");
const AUTH_URL = "https://auth.example.com/authorize?client_id=vault";
const LAUNCH_URL = "http://127.0.0.1:53192/launch";
const AUTH_ERROR = new Error(
	'HTTP 401: {"authorization_url":"https://auth.example.com/authorize","token_url":"https://auth.example.com/token"}',
);

type Frame = Record<string, unknown> & { type?: string };

let workDir: string;
let agentDir: string;
let previousAgentDir: string | undefined;
const originalProjectDir = getProjectDir();

function stdioConfig(): MCPStdioServerConfig {
	return {
		type: "stdio",
		command: process.execPath,
		args: ["run", FIXTURE],
	};
}

async function seedProjectConfig(servers: Record<string, MCPServerConfig>): Promise<string> {
	const configPath = getMCPConfigPath("project", workDir);
	await writeMCPConfigFile(configPath, { mcpServers: servers });
	clearFsCache();
	return configPath;
}

async function readProjectServers(): Promise<Record<string, MCPServerConfig>> {
	const config = await readMCPConfigFile(getMCPConfigPath("project", workDir));
	return config.mcpServers ?? {};
}

type ServerEntry = { name: string } & Record<string, unknown>;

function responseData(response: object): Record<string, unknown> {
	const data = "data" in response ? response.data : undefined;
	return data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

function responseCode(response: object): string | undefined {
	const code = "code" in response ? response.code : undefined;
	return typeof code === "string" ? code : undefined;
}

function freshAuthStorage(): AuthStorage {
	return new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
}

class SocketPeer {
	readonly seen: Frame[] = [];
	readonly #queue: Frame[] = [];
	#wake: (() => void) | undefined;
	#closed = false;

	private constructor(private readonly conn: IpcConnection) {}

	static async connect(endpoint: string): Promise<SocketPeer> {
		const peer = new SocketPeer(await IpcConnection.connect(endpoint, { framing: "lines", timeoutMs: 4000 }));
		peer.conn.start(
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
				peer.#closed = true;
				peer.#wake?.();
			},
		);
		return peer;
	}

	send(frame: object): void {
		this.conn.send(JSON.stringify(frame));
	}

	async next(predicate: (frame: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const index = this.#queue.findIndex(predicate);
			if (index >= 0) return this.#queue.splice(index, 1)[0]!;
			if (this.#closed) throw new Error(`socket closed; saw ${JSON.stringify(this.seen)}`);
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`timed out waiting for frame; saw ${JSON.stringify(this.seen)}`);
			const arrived = Promise.withResolvers<void>();
			this.#wake = arrived.resolve;
			await withTimeout(arrived.promise, remaining, `timed out waiting for frame; saw ${JSON.stringify(this.seen)}`);
			this.#wake = undefined;
		}
	}

	destroy(): void {
		this.conn.destroy();
	}
}

beforeEach(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-mcp-"));
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-mcp-agent-"));
	setProjectDir(workDir);
	setAgentDir(agentDir);
	clearFsCache();
});

afterEach(() => {
	vi.restoreAllMocks();
	clearFsCache();
	setProjectDir(originalProjectDir);
	if (previousAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
		delete Bun.env.PI_CODING_AGENT_DIR;
	} else {
		setAgentDir(previousAgentDir);
	}
	removeSyncWithRetries(workDir);
	removeSyncWithRetries(agentDir);
});

describe("MCP control over the stdio command surface", () => {
	let manager: MCPManager | undefined;

	afterEach(async () => {
		await manager?.disconnectAll();
		manager = undefined;
	});

	test("get_mcp_status reports a connected stdio server and a configured-disabled one", async () => {
		const configPath = await seedProjectConfig({
			[STDIO_SERVER]: stdioConfig(),
			[DISABLED_SERVER]: { ...stdioConfig(), enabled: false },
		});
		const authStorage = freshAuthStorage();
		manager = new MCPManager(workDir);
		const loaded = await loadAllMCPConfigs(workDir, { enableProjectConfig: true });
		await manager.connectServers(
			{ [STDIO_SERVER]: loaded.configs[STDIO_SERVER]! },
			{ [STDIO_SERVER]: loaded.sources[STDIO_SERVER]! },
		);
		const harness = createRpcSurfaceHarness({
			mcpManager: manager,
			session: { modelRegistry: { authStorage } },
		});

		try {
			const response = await harness.handle({ id: "status", type: "get_mcp_status" });
			expect(response.success).toBe(true);
			const servers = responseData(response).servers as ServerEntry[];
			const connected = servers.find(server => server.name === STDIO_SERVER);
			expect(connected).toMatchObject({
				scope: "project",
				transport: "stdio",
				enabled: true,
				status: "connected",
				authRequired: false,
			});
			expect(connected?.toolCount as number).toBeGreaterThan(0);
			const disabled = servers.find(server => server.name === DISABLED_SERVER);
			expect(disabled).toMatchObject({
				enabled: false,
				status: "disconnected",
				toolCount: 0,
				authRequired: false,
			});
			const names = servers.map(server => server.name);
			expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)));
			expect(await Bun.file(configPath).exists()).toBe(true);
		} finally {
			harness.dispose();
		}
	});

	test("set_mcp_enabled disables and re-enables a server, persisting the choice and refreshing session tools", async () => {
		await seedProjectConfig({ [STDIO_SERVER]: stdioConfig() });
		const authStorage = freshAuthStorage();
		manager = new MCPManager(workDir);
		const loaded = await loadAllMCPConfigs(workDir, { enableProjectConfig: true });
		await manager.connectServers(
			{ [STDIO_SERVER]: loaded.configs[STDIO_SERVER]! },
			{ [STDIO_SERVER]: loaded.sources[STDIO_SERVER]! },
		);
		const refresh = vi.fn(async (_tools: unknown[]) => {});
		const harness = createRpcSurfaceHarness({
			mcpManager: manager,
			session: { modelRegistry: { authStorage }, refreshMCPTools: refresh },
		});

		try {
			const disabled = await harness.handle({
				id: "off",
				type: "set_mcp_enabled",
				name: STDIO_SERVER,
				enabled: false,
			});
			expect(disabled).toMatchObject({ success: true });
			expect(responseData(disabled).server).toMatchObject({
				name: STDIO_SERVER,
				enabled: false,
				status: "disconnected",
				toolCount: 0,
			});
			expect(manager.getConnectionStatus(STDIO_SERVER)).toBe("disconnected");
			expect((await readProjectServers())[STDIO_SERVER]?.enabled).toBe(false);
			expect(refresh.mock.calls.at(-1)?.[0]).toEqual([]);

			const enabled = await harness.handle({ id: "on", type: "set_mcp_enabled", name: STDIO_SERVER, enabled: true });
			expect(enabled).toMatchObject({ success: true });
			const server = responseData(enabled).server as Record<string, unknown>;
			expect(server).toMatchObject({ name: STDIO_SERVER, enabled: true, status: "connected" });
			expect(server.toolCount as number).toBeGreaterThan(0);
			expect((await readProjectServers())[STDIO_SERVER]?.enabled).toBeUndefined();
			expect(refresh.mock.calls.at(-1)?.[0]?.length ?? 0).toBeGreaterThan(0);
		} finally {
			harness.dispose();
		}
	});

	test("set_mcp_enabled rejects an unknown server with mcp_server_not_found", async () => {
		await seedProjectConfig({ [STDIO_SERVER]: stdioConfig() });
		manager = new MCPManager(workDir);
		const harness = createRpcSurfaceHarness({
			mcpManager: manager,
			session: { modelRegistry: { authStorage: freshAuthStorage() } },
		});
		try {
			const response = await harness.handle({
				id: "missing",
				type: "set_mcp_enabled",
				name: "never-configured",
				enabled: true,
			});
			expect(response.success).toBe(false);
			expect(responseCode(response)).toBe("mcp_server_not_found");
		} finally {
			harness.dispose();
		}
	});

	test("mcp_reauth refuses a stdio server with mcp_reauth_refused", async () => {
		await seedProjectConfig({ [STDIO_SERVER]: stdioConfig() });
		manager = new MCPManager(workDir);
		const harness = createRpcSurfaceHarness({
			mcpManager: manager,
			session: { modelRegistry: { authStorage: freshAuthStorage() } },
		});
		try {
			const response = await harness.handle({ id: "reauth", type: "mcp_reauth", name: STDIO_SERVER });
			expect(response.success).toBe(false);
			expect(responseCode(response)).toBe("mcp_reauth_refused");
			expect(JSON.stringify(harness.framesOfType("extension_ui_request"))).not.toContain("open_url");
		} finally {
			harness.dispose();
		}
	});

	test("a startup 401 failure reports auth_required on the first status call", async () => {
		const challenge = Bun.serve({
			port: 0,
			fetch: () =>
				new Response(
					JSON.stringify({
						authorization_url: "https://auth.example.com/authorize",
						token_url: "https://auth.example.com/token",
					}),
					{ status: 401 },
				),
		});
		try {
			await seedProjectConfig({
				[HTTP_SERVER]: { type: "http", url: `http://127.0.0.1:${challenge.port}/mcp` },
			});
			manager = new MCPManager(workDir);
			const loaded = await loadAllMCPConfigs(workDir, { enableProjectConfig: true });
			const startup = await manager.connectServers(
				{ [HTTP_SERVER]: loaded.configs[HTTP_SERVER]! },
				{ [HTTP_SERVER]: loaded.sources[HTTP_SERVER]! },
			);
			expect(startup.errors.size).toBeGreaterThan(0);
			const harness = createRpcSurfaceHarness({
				mcpManager: manager,
				session: { modelRegistry: { authStorage: freshAuthStorage() } },
			});
			try {
				const response = await harness.handle({ id: "status", type: "get_mcp_status" });
				expect(response.success).toBe(true);
				const entry = (responseData(response).servers as ServerEntry[]).find(server => server.name === HTTP_SERVER);
				expect(entry).toMatchObject({ enabled: true, status: "auth_required", authRequired: true });
				expect(String(entry?.lastError)).toContain("401");
			} finally {
				harness.dispose();
			}
		} finally {
			challenge.stop(true);
		}
	});

	test("enabledServers force-enables a config-disabled server", async () => {
		await seedProjectConfig({
			[HTTP_SERVER]: { type: "http", url: "https://vault.example.com/mcp", enabled: false },
		});
		await writeMCPConfigFile(getMCPConfigPath("user", workDir), {
			mcpServers: {},
			enabledServers: [HTTP_SERVER],
		});
		clearFsCache();
		const harness = createRpcSurfaceHarness({
			mcpManager: createMcpManagerStub({ getConnectionStatus: vi.fn(() => "disconnected" as const) }),
			session: { modelRegistry: { authStorage: freshAuthStorage() } },
		});
		try {
			const response = await harness.handle({ id: "status", type: "get_mcp_status" });
			expect(response.success).toBe(true);
			const entry = (responseData(response).servers as ServerEntry[]).find(server => server.name === HTTP_SERVER);
			expect(entry).toMatchObject({ name: HTTP_SERVER, transport: "http", enabled: true });
		} finally {
			harness.dispose();
		}
	});
});

describe("MCP control over a published session socket", () => {
	let socket: RpcSessionSocket | undefined;
	let served: ServedSessionSocket | undefined;
	let peer: SocketPeer | undefined;
	let manager: MCPManager | undefined;

	afterEach(async () => {
		peer?.destroy();
		peer = undefined;
		await served?.close();
		served = undefined;
		await socket?.close();
		socket = undefined;
		manager = undefined;
	});

	async function publish(): Promise<{ peer: SocketPeer; session: AgentSession }> {
		const authStorage = freshAuthStorage();
		manager = createMcpManagerStub({
			addConnectionStatusListener: vi.fn(() => () => {}),
			getConnectionStatus: vi.fn(() => "disconnected" as const),
		});
		const session = createSessionStub(SessionManager.inMemory(workDir), Settings.isolated(), {
			sessionId: "rpc-mcp-socket-test",
			modelRegistry: { authStorage },
			refreshMCPTools: vi.fn(async (_tools: unknown[]) => {}),
			subscribeCommandMetadataChanged: vi.fn(() => () => {}),
		});
		const endpointDir = path.join(workDir, "sockets");
		fs.mkdirSync(endpointDir, { recursive: true });
		socket = createAgentSessionSocket(session, { endpointDir });
		served = await serveInteractiveSessionSocket({ session, socket, mcpManager: manager });
		const connected = await SocketPeer.connect(socket.endpoint!);
		peer = connected;
		return { peer: connected, session };
	}

	test("get_mcp_status and set_mcp_enabled are served over the socket", async () => {
		await seedProjectConfig({ [HTTP_SERVER]: { type: "http", url: "https://vault.example.com/mcp" } });
		const { peer: client } = await publish();

		client.send({ id: "status", type: "get_mcp_status" });
		const status = await client.next(frame => frame.type === "response" && frame.id === "status");
		expect(status.success).toBe(true);
		const servers = responseData(status).servers as ServerEntry[];
		expect(servers.find(server => server.name === HTTP_SERVER)).toMatchObject({
			scope: "project",
			transport: "http",
			enabled: true,
		});

		client.send({ id: "off", type: "set_mcp_enabled", name: HTTP_SERVER, enabled: false });
		const disabled = await client.next(frame => frame.type === "response" && frame.id === "off");
		expect(disabled.success).toBe(true);
		expect(responseData(disabled).server).toMatchObject({
			name: HTTP_SERVER,
			transport: "http",
			enabled: false,
			status: "disconnected",
		});
		expect(manager?.disconnectServer).toHaveBeenCalledWith(HTTP_SERVER);
		expect((await readProjectServers())[HTTP_SERVER]?.enabled).toBe(false);
	});

	test("mcp_reauth emits open_url on the calling socket and answers a manual-code input mid-command", async () => {
		await seedProjectConfig({ [HTTP_SERVER]: { type: "http", url: "https://vault.example.com/mcp" } });
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				this.ctrl.onAuth?.({ url: AUTH_URL, launchUrl: LAUNCH_URL, instructions: "Approve access" });
				const answer = await this.ctrl.onManualCodeInput?.(new AbortController().signal);
				expect(answer).toBe("the-code");
				return { access: "fresh-access", refresh: "fresh-refresh", expires: Date.now() + 3_600_000 };
			},
		);
		const { peer: client } = await publish();

		client.send({ id: "reauth", type: "mcp_reauth", name: HTTP_SERVER });
		const openUrl = await client.next(frame => frame.type === "extension_ui_request" && frame.method === "open_url");
		expect(openUrl).toMatchObject({ url: AUTH_URL, launchUrl: LAUNCH_URL, instructions: "Approve access" });

		const input = await client.next(frame => frame.type === "extension_ui_request" && frame.method === "input");
		client.send({ type: "extension_ui_response", id: input.id, value: "the-code" });

		const response = await client.next(frame => frame.type === "response" && frame.id === "reauth");
		expect(response.success).toBe(true);
		expect(responseData(response)).toMatchObject({
			status: "authorized",
			server: { name: HTTP_SERVER, enabled: true },
		});
		expect(client.seen.some(frame => frame.method === "notify")).toBe(true);
	});

	test("a client disconnecting mid-reauth aborts the flow and the surface keeps serving", async () => {
		await seedProjectConfig({ [HTTP_SERVER]: { type: "http", url: "https://vault.example.com/mcp" } });
		let aborted = false;
		vi.spyOn(oauthReauth, "reauthorizeMcpServer").mockImplementation(
			async (_name, _found, options): Promise<never> => {
				options.onReauthorizing?.();
				options.onAuth?.({ url: AUTH_URL, launchUrl: LAUNCH_URL, instructions: "Approve access" });
				await new Promise<void>((resolve, reject) => {
					const { signal } = options;
					if (!signal) {
						reject(new Error("reauth does not propagate the calling connection's signal"));
						return;
					}
					if (signal.aborted) {
						aborted = true;
						resolve();
						return;
					}
					signal.addEventListener(
						"abort",
						() => {
							aborted = true;
							resolve();
						},
						{ once: true },
					);
				});
				throw new oauthReauth.MCPOAuthCancelledError();
			},
		);
		const { peer: client } = await publish();
		client.send({ id: "reauth", type: "mcp_reauth", name: HTTP_SERVER });
		await client.next(frame => frame.type === "extension_ui_request" && frame.method === "open_url");

		client.destroy();
		await withTimeout(
			(async () => {
				while (!aborted) await new Promise(resolve => setTimeout(resolve, 10));
			})(),
			5_000,
			"reauth did not observe the client disconnect",
		);
		expect(aborted).toBe(true);

		const reconnected = await SocketPeer.connect(socket!.endpoint!);
		try {
			reconnected.send({ id: "after", type: "get_mcp_status" });
			const response = await reconnected.next(frame => frame.type === "response" && frame.id === "after");
			expect(response.success).toBe(true);
		} finally {
			reconnected.destroy();
		}
	});
});
