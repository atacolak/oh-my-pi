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
	createAgentSession,
	discoverAuthStorage,
	type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const probeExtension: ExtensionFactory = pi => {
	pi.registerTool({
		name: "probe_tool",
		label: "Probe Tool",
		description: "Discoverable extension tool used to observe the xd:// partition.",
		parameters: type({}),
		loadMode: "discoverable",
		async execute() {
			return { content: [{ type: "text", text: "probe" }] };
		},
	});
};

const lateUndeclaredExtension: ExtensionFactory = pi => {
	pi.on("session_start", async () => {
		await Promise.resolve();
		pi.registerTool({
			name: "late_undeclared_tool",
			label: "Late Undeclared Tool",
			description: "Registered after session start and absent from the declared tool load set.",
			parameters: type({}),
			async execute() {
				return { content: [{ type: "text", text: "late" }] };
			},
		});
	});
};

const lateDeclaredExtension: ExtensionFactory = pi => {
	pi.on("session_start", async () => {
		await Promise.resolve();
		pi.registerTool({
			name: "late_declared_tool",
			label: "Late Declared Tool",
			description: "Registered after session start and declared discoverable by the profile.",
			parameters: type({}),
			loadMode: "discoverable",
			async execute() {
				return { content: [{ type: "text", text: "late declared" }] };
			},
		});
	});
};

const preconstructionExtension: ExtensionFactory = pi => {
	pi.registerTool({
		name: "become_actor",
		label: "Become Actor",
		description: "Extension tool registered before session construction.",
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: "preconstruction" }] };
		},
	});
};

const mcpOriginExtension: ExtensionFactory = pi => {
	pi.registerTool({
		name: "mcp__demo__lookup",
		label: "MCP Origin Lookup",
		description: "Tool minted from an MCP server, governed by the separate mcps: declaration.",
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: "mcp" }] };
		},
	});
};

const callerInjectedTool = {
	name: "caller_injected_tool",
	label: "Caller Injected Tool",
	description: "Caller-supplied SDK custom tool, not part of any profile declaration.",
	parameters: type({}),
	async execute() {
		return { content: [{ type: "text", text: "caller injected" }] };
	},
} satisfies CustomTool;

describe("xd:// mount pinning for declared discoverable tools", () => {
	const tempDirs: string[] = [];
	let modelRegistry!: ModelRegistry;
	let registryAuthDir: string;

	const makeTempDir = (): string => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-xdev-mount-${Snowflake.next()}`);
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
		registryAuthDir = path.join(os.tmpdir(), `pi-sdk-xdev-mount-auth-${Snowflake.next()}`);
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

	it("mounts a requested tool the profile declares discoverable", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [probeExtension],
			toolNames: ["read", "write", "probe_tool"],
			restrictToolNames: false,
			toolLoad: {
				declared: true,
				names: ["read", "write", "probe_tool"],
				eager: ["read", "write"],
				discoverable: ["probe_tool"],
			},
		});
		try {
			expect(session.getMountedXdevToolNames()).toContain("probe_tool");
			expect(session.getXdevToolEntries().map(entry => entry.name)).toContain("probe_tool");
			expect(session.getActiveToolNames()).not.toContain("probe_tool");
		} finally {
			await session.dispose();
		}
	}, 60_000);

	it("keeps a requested tool top-level when the profile does not declare it discoverable", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [probeExtension],
			toolNames: ["read", "write", "probe_tool"],
			restrictToolNames: false,
		});
		try {
			expect(session.getActiveToolNames()).toContain("probe_tool");
			expect(session.getMountedXdevToolNames()).not.toContain("probe_tool");
		} finally {
			await session.dispose();
		}
	}, 60_000);

	it("mounts a keep-list builtin the profile explicitly declares discoverable", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "write", "todo"],
			restrictToolNames: false,
			toolLoad: {
				declared: true,
				names: ["read", "write", "todo"],
				eager: ["read", "write"],
				discoverable: ["todo"],
			},
		});
		try {
			expect(session.getMountedXdevToolNames()).toContain("todo");
			expect(session.getActiveToolNames()).not.toContain("todo");
		} finally {
			await session.dispose();
		}
	}, 60_000);

	it("keeps a keep-list builtin top-level when the profile does not declare it discoverable", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "write", "todo"],
			restrictToolNames: false,
			toolLoad: {
				declared: true,
				names: ["read", "write", "todo"],
				eager: ["read", "write", "todo"],
				discoverable: [],
			},
		});
		try {
			expect(session.getActiveToolNames()).toContain("todo");
			expect(session.getMountedXdevToolNames()).not.toContain("todo");
		} finally {
			await session.dispose();
		}
	}, 60_000);

	it("never mounts yield even when the profile declares it discoverable", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "write", "yield"],
			restrictToolNames: false,
			requireYieldTool: true,
			toolLoad: {
				declared: true,
				names: ["read", "write", "yield"],
				eager: ["read", "write"],
				discoverable: ["yield"],
			},
		});
		try {
			expect(session.getMountedXdevToolNames()).not.toContain("yield");
			expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain("yield");
			expect(session.getActiveToolNames()).toContain("yield");
		} finally {
			await session.dispose();
		}
	}, 60_000);

	it("keeps write as a device-only transport when the profile declares it discoverable", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "write"],
			restrictToolNames: false,
			toolLoad: {
				declared: true,
				names: ["read", "write"],
				eager: ["read"],
				discoverable: ["write"],
			},
		});
		try {
			expect(session.getActiveToolNames()).toContain("write");
			const write = session.getToolByName("write");
			if (!write) throw new Error("expected a write transport");
			await expect(
				write.execute("declared-write", { path: path.join(tempDir, "not-device.txt"), content: "x" }),
			).rejects.toThrow("Other filesystem paths are refused");
			// A profile policy re-apply (as the subagent executor performs after
			// createAgentSession) must not turn the transport into a filesystem grant.
			await session.setActiveToolsByName(session.getEnabledToolNames());
			const reapplied = session.getToolByName("write");
			if (!reapplied) throw new Error("expected the write transport after re-apply");
			await expect(
				reapplied.execute("declared-write-reapply", {
					path: path.join(tempDir, "not-device-after-reapply.txt"),
					content: "x",
				}),
			).rejects.toThrow("Other filesystem paths are refused");
		} finally {
			await session.dispose();
		}
	}, 60_000);

	it("mounts a late extension tool that the profile declares discoverable", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [lateDeclaredExtension],
			toolNames: ["read", "write", "late_declared_tool"],
			restrictToolNames: false,
			toolLoad: {
				declared: true,
				names: ["read", "write", "late_declared_tool"],
				eager: ["read", "write"],
				discoverable: ["late_declared_tool"],
			},
		});
		try {
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected an extension runner");
			await runner.emit({ type: "session_start" });
			expect(session.getMountedXdevToolNames()).toContain("late_declared_tool");
			expect(session.getActiveToolNames()).not.toContain("late_declared_tool");
		} finally {
			await session.dispose();
		}
	}, 60_000);

	it("does not activate a late extension tool outside a declared tool load set", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [lateUndeclaredExtension],
			toolNames: ["read", "write"],
			restrictToolNames: false,
			toolLoad: {
				declared: true,
				names: ["read", "write"],
				eager: ["read", "write"],
				discoverable: [],
			},
		});
		try {
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected an extension runner");
			await runner.emit({ type: "session_start" });
			expect(session.getEnabledToolNames()).not.toContain("late_undeclared_tool");
			expect(session.getActiveToolNames()).not.toContain("late_undeclared_tool");
			expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain("late_undeclared_tool");
		} finally {
			await session.dispose();
		}
	}, 60_000);

	it("does not activate a pre-construction extension tool outside a declared tool load set", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings: Settings.isolated({ "tools.xdev": false }),
			extensions: [preconstructionExtension],
			toolNames: ["read", "write"],
			restrictToolNames: false,
			toolLoad: {
				declared: true,
				names: ["read", "write"],
				eager: ["read", "write"],
				discoverable: [],
			},
		});
		try {
			expect(session.getEnabledToolNames()).not.toContain("become_actor");
			expect(session.getActiveToolNames()).not.toContain("become_actor");
			expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain("become_actor");
		} finally {
			await session.dispose();
		}
	}, 60_000);

	it("activates a pre-construction extension tool when the profile declares no tool load", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings: Settings.isolated({ "tools.xdev": false }),
			extensions: [preconstructionExtension],
			toolNames: ["read", "write"],
			restrictToolNames: false,
		});
		try {
			expect(session.getActiveToolNames()).toContain("become_actor");
		} finally {
			await session.dispose();
		}
	}, 60_000);

	it("keeps an MCP-origin tool active under a declared tool load set", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings: Settings.isolated({ "tools.xdev": false }),
			extensions: [mcpOriginExtension],
			toolNames: ["read", "write"],
			restrictToolNames: false,
			toolLoad: {
				declared: true,
				names: ["read", "write"],
				eager: ["read", "write"],
				discoverable: [],
			},
		});
		try {
			expect(session.getEnabledToolNames()).toContain("mcp__demo__lookup");
		} finally {
			await session.dispose();
		}
	}, 60_000);

	it("keeps a caller-injected SDK custom tool active under a declared tool load set", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings: Settings.isolated({ "tools.xdev": false }),
			customTools: [callerInjectedTool],
			toolNames: ["read", "write"],
			restrictToolNames: false,
			toolLoad: {
				declared: true,
				names: ["read", "write"],
				eager: ["read", "write"],
				discoverable: [],
			},
		});
		try {
			expect(session.getActiveToolNames()).toContain("caller_injected_tool");
		} finally {
			await session.dispose();
		}
	}, 60_000);
});
