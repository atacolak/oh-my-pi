import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseAgentFields } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	cfgSessionIdleSleepSeconds,
	getSessionIdleSleepSeconds,
	validateIdleSleepSeconds,
} from "@oh-my-pi/pi-coding-agent/session/idle-sleep-policy";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("session idle sleep policy", () => {
	it("retains an explicit zero-second disable from settings and actor metadata", () => {
		const settings = Settings.isolated();
		cfgSessionIdleSleepSeconds.override(settings, 0);
		expect(getSessionIdleSleepSeconds(settings)).toBe(0);
		expect(getSessionIdleSleepSeconds(settings, { idleSleepSeconds: 0 })).toBe(0);
	});

	it("prefers actor metadata over profile settings, and inherits settings when metadata is null or absent", () => {
		const settings = Settings.isolated();
		cfgSessionIdleSleepSeconds.override(settings, 7200);
		expect(getSessionIdleSleepSeconds(settings)).toBe(7200);
		expect(getSessionIdleSleepSeconds(settings, { idleSleepSeconds: null })).toBe(7200);
		expect(getSessionIdleSleepSeconds(settings, {})).toBe(7200);
		expect(getSessionIdleSleepSeconds(settings, { idleSleepSeconds: 90 })).toBe(90);
	});

	it("rejects invalid durations and leaves an existing effective policy unchanged after a refused edit", () => {
		for (const value of [-1, 1.5, Number.NaN, "3600"]) {
			expect(() => validateIdleSleepSeconds(value)).toThrow();
		}

		const settings = Settings.isolated();
		cfgSessionIdleSleepSeconds.override(settings, 1800);
		expect(() => cfgSessionIdleSleepSeconds.override(settings, -1)).toThrow();
		expect(cfgSessionIdleSleepSeconds.get(settings)).toBe(1800);
	});
});

describe("agent idle sleep frontmatter", () => {
	const frontmatter = { name: "idle-probe", description: "Idle sleep fixture." };

	it("reads the kebab-case key and retains an explicit zero", () => {
		expect(parseAgentFields({ ...frontmatter, "idle-sleep-seconds": 0 })?.idleSleepSeconds).toBe(0);
		expect(parseAgentFields({ ...frontmatter, "idle-sleep-seconds": 5400 })?.idleSleepSeconds).toBe(5400);
	});

	it("reads the camelCase key and leaves the field absent when it is not declared", () => {
		expect(parseAgentFields({ ...frontmatter, idleSleepSeconds: 1800 })?.idleSleepSeconds).toBe(1800);
		expect(parseAgentFields(frontmatter)?.idleSleepSeconds).toBeUndefined();
		expect(parseAgentFields({ ...frontmatter, "idle-sleep-seconds": null })?.idleSleepSeconds).toBeUndefined();
	});

	it("refuses malformed, negative, nonfinite, and fractional values instead of inheriting the default", () => {
		for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3600", true]) {
			expect(() => parseAgentFields({ ...frontmatter, "idle-sleep-seconds": value })).toThrow(
				/session\.idleSleepSeconds/,
			);
		}
	});

	it("carries the parsed value through native markdown frontmatter", () => {
		const agent = parseAgent(
			"idle-probe.md",
			["---", "name: idle-probe", 'description: "Idle sleep fixture."', "idle-sleep-seconds: 0", "---", "body"].join(
				"\n",
			),
			"bundled",
		);
		expect(agent.idleSleepSeconds).toBe(0);
	});
});

describe("createAgentSession — agentIdleSleepSeconds", () => {
	const model = getBundledModel("openai", "gpt-4o-mini");
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
	});

	async function createSession(
		tempDir: TempDir,
		agentIdleSleepSeconds: number,
		options: { taskDepth?: number } = {},
	): Promise<Settings> {
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		const settings = Settings.isolated({ "async.enabled": false, "marketplace.autoUpdate": "off" });
		const created = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			model,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			workspaceTree: {
				rootPath: tempDir.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			enableMCP: false,
			enableLsp: false,
			agentIdleSleepSeconds,
			...options,
		});
		session = created.session;
		return settings;
	}

	it("applies the profile override to a root session over the settings default", async () => {
		using tempDir = TempDir.createSync("@omp-agent-idle-sleep-sdk-");
		const settings = await createSession(tempDir, 0);
		expect(getSessionIdleSleepSeconds(settings)).toBe(0);
	});

	it("does not apply the profile override to a subagent session", async () => {
		using tempDir = TempDir.createSync("@omp-agent-idle-sleep-sub-");
		const settings = await createSession(tempDir, 0, { taskDepth: 1 });
		expect(getSessionIdleSleepSeconds(settings)).toBe(3600);
	});
});

describe("buildSessionOptions — agent idle sleep", () => {
	async function writeProjectAgent(name: string, idleKey: string | undefined): Promise<string> {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-idle-"));
		await fs.mkdir(path.join(cwd, ".omp", "agents"), { recursive: true });
		const lines = ["---", `name: ${name}`, `description: "Idle sleep fixture."`, 'model: "@default"'];
		if (idleKey !== undefined) lines.push(idleKey);
		lines.push("---", "idle sleep fixture body");
		await fs.writeFile(path.join(cwd, ".omp", "agents", `${name}.md`), lines.join("\n"));
		return cwd;
	}

	async function optionsFor(name: string, idleKey: string | undefined) {
		const cwd = await writeProjectAgent(name, idleKey);
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const parsed = parseArgs(["--agent", name]);
			parsed.cwd = cwd;
			const settings = Settings.isolated({ "async.enabled": false, "marketplace.autoUpdate": "off" });
			const options = await buildSessionOptions(parsed, [], undefined, new ModelRegistry(authStorage), settings);
			return { cwd, options };
		} finally {
			authStorage.close();
		}
	}

	it("forwards an explicit zero from the launch agent definition", async () => {
		const { cwd, options } = await optionsFor("idle-probe", "idle-sleep-seconds: 0");
		try {
			expect(options.agentIdleSleepSeconds).toBe(0);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("leaves the option unset when the launch agent declares no idle sleep", async () => {
		const { cwd, options } = await optionsFor("idle-inherit", undefined);
		try {
			expect(options.agentIdleSleepSeconds).toBeUndefined();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
