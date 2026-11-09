/**
 * MCP connections are governed by the session's resolved `mcps:` policy BEFORE
 * any server is dialed.
 *
 * Regression: `session-tools` filtered mounted MCP tool names only after
 * `discoverAndConnect` had opened every configured server, so `--agent lead`
 * with `mcps: []` still printed "Connecting to MCP servers: youtube, whatsapp,
 * mail, …" and stalled startup for seconds while isolating nothing.
 *
 * Assertions are on `MCPManager.connectServers` — the single dial seam — so the
 * contract is "no transport is opened", not "no tool is mounted". The fixture
 * additionally records its own spawn, proving an allowed server really dialed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { NamedLoadSet } from "@oh-my-pi/pi-coding-agent/task/tool-load-spec";
import { isMCPToolName } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { getAgentDir, removeSyncWithRetries, setAgentDir, Snowflake } from "@oh-my-pi/pi-utils";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "dial-marker-mcp.ts");

/** Reads the tags the fixture servers recorded on spawn, in order. */
function recordedSpawns(markerPath: string): string[] {
	if (!fs.existsSync(markerPath)) return [];
	return fs
		.readFileSync(markerPath, "utf8")
		.split("\n")
		.filter(line => line.length > 0);
}

/** Waits for `count` spawned fixture children; the child writes its tag at process start. */
async function spawnedServers(markerPath: string, count: number): Promise<string[]> {
	const deadline = Date.now() + 12_000;
	let tags = recordedSpawns(markerPath);
	while (tags.length < count && Date.now() < deadline) {
		await Bun.sleep(10);
		tags = recordedSpawns(markerPath);
	}
	return tags;
}

function declaredMcps(names: string[]): NamedLoadSet {
	return { declared: true, names, eager: [], discoverable: [] };
}

describe("MCP dial policy follows the session's mcps: allowlist", () => {
	let originalAgentDir: string;
	let isolatedHome: string;
	let isolatedAgentDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let markerPath: string;
	let homedirSpy: Mock<typeof os.homedir>;
	let connectSpy: Mock<MCPManager["connectServers"]>;

	/** Server names the session attempted to dial, in its first connect batch. */
	const dialedServers = (): string[] => Object.keys(connectSpy.mock.calls[0]?.[0] ?? {}).sort();

	const createSession = async (mcpLoad: NamedLoadSet | undefined) => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.startupTimeoutMs": 0 }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			...(mcpLoad ? { mcpLoad } : {}),
		});
		return session;
	};

	beforeAll(async () => {
		isolatedHome = path.join(os.tmpdir(), `pi-mcp-dial-home-${Snowflake.next()}`);
		fs.mkdirSync(isolatedHome, { recursive: true });
		isolatedAgentDir = path.join(isolatedHome, ".omp", "agent");
		fs.mkdirSync(isolatedAgentDir, { recursive: true });
		originalAgentDir = getAgentDir();
		setAgentDir(isolatedAgentDir);
		homedirSpy = spyOn(os, "homedir").mockReturnValue(isolatedHome);
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		closeModelCache();
		homedirSpy.mockRestore();
		setAgentDir(originalAgentDir);
		if (fs.existsSync(isolatedHome)) removeSyncWithRetries(isolatedHome);
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-mcp-dial-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		markerPath = path.join(tempDir, "spawned.log");
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					alpha: { type: "stdio", command: process.execPath, args: [FIXTURE_PATH, markerPath, "alpha"] },
					beta: { type: "stdio", command: process.execPath, args: [FIXTURE_PATH, markerPath, "beta"] },
				},
			}),
		);
		connectSpy = spyOn(MCPManager.prototype, "connectServers");
	});

	afterEach(() => {
		connectSpy.mockRestore();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	it("spawns no server when the policy names none", async () => {
		const session = await createSession(declaredMcps([]));
		try {
			expect(connectSpy).not.toHaveBeenCalled();
			expect(recordedSpawns(markerPath)).toEqual([]);
			expect(session.getAllToolNames().filter(isMCPToolName)).toEqual([]);
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("spawns only the named server", async () => {
		const session = await createSession(declaredMcps(["alpha"]));
		try {
			expect(dialedServers()).toEqual(["alpha"]);
			expect(await spawnedServers(markerPath, 1)).toEqual(["alpha"]);
			expect(session.getAllToolNames().filter(isMCPToolName)).toEqual(["mcp__alpha_ping"]);
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("spawns every configured server for a bare session", async () => {
		const session = await createSession(undefined);
		try {
			expect(dialedServers()).toEqual(["alpha", "beta"]);
			expect((await spawnedServers(markerPath, 2)).sort()).toEqual(["alpha", "beta"]);
			const mcpTools = session.getAllToolNames().filter(isMCPToolName).sort();
			expect(mcpTools).toEqual(["mcp__alpha_ping", "mcp__beta_ping"]);
		} finally {
			await session.dispose();
		}
	}, 30_000);
});
