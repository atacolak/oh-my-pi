import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type CreateAgentSessionOptions,
	type CustomTool,
	type ExtensionFactory,
	createAgentSession,
	discoverAuthStorage,
} from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function mcpTool(serverName: string, toolName: string): CustomTool {
	return {
		name: `mcp__${serverName}_${toolName}`,
		label: `${serverName} ${toolName}`,
		description: `${serverName} ${toolName}`,
		parameters: type({}),
		mcpServerName: serverName,
		mcpToolName: toolName,
		async execute() {
			return { content: [{ type: "text", text: toolName }] };
		},
	};
}

describe("createAgentSession agent load policy", () => {
	const tempDirs: string[] = [];
	let modelRegistry!: ModelRegistry;
	let registryAuthDir: string;

	const makeTempDir = (): string => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-agent-load-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		return tempDir;
	};

	const baseOptions = (tempDir: string): CreateAgentSessionOptions => ({
		cwd: tempDir,
		agentDir: tempDir,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		rules: [],
		workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});

	beforeAll(async () => {
		registryAuthDir = path.join(os.tmpdir(), `pi-sdk-agent-load-auth-${Snowflake.next()}`);
		fs.mkdirSync(registryAuthDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(registryAuthDir));
	});

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	afterAll(() => {
		modelRegistry.authStorage.close();
		removeSyncWithRetries(registryAuthDir);
	});

	it("applies toolLoad maps on create and filters MCP tools on late refresh", async () => {
		const tempDir = makeTempDir();
		const probe: ExtensionFactory = pi => {
			pi.registerTool({
				name: "probe",
				label: "Probe",
				description: "Discoverable unless the agent map promotes it.",
				parameters: type({}),
				loadMode: "discoverable",
				async execute() {
					return { content: [{ type: "text", text: "probe" }] };
				},
			});
		};
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [probe],
			toolNames: ["read", "write", "probe"],
			restrictToolNames: false,
			toolLoad: {
				declared: true,
				names: ["read", "probe"],
				eager: ["read", "probe"],
				discoverable: [],
			},
			mcpLoad: {
				declared: true,
				names: ["youtube"],
				eager: [],
				discoverable: ["youtube"],
			},
		});
		try {
			expect(session.getActiveToolNames()).toContain("read");
			expect(session.getActiveToolNames()).toContain("probe");
			expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain("probe");

			await session.refreshMCPTools([mcpTool("mail", "search"), mcpTool("youtube", "list")]);
			const enabled = session.getEnabledToolNames();
			expect(enabled.some(name => name.includes("youtube"))).toBe(true);
			expect(enabled.some(name => name.includes("mail"))).toBe(false);
			expect(session.getAllToolNames().some(name => name.includes("mail"))).toBe(false);
		} finally {
			await session.dispose();
		}
	});
});
