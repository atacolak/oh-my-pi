import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { restartArgv, STRING_VALUE_FLAGS } from "@oh-my-pi/pi-coding-agent/cli/flag-tables";
import {
	resolveLaunchAgent,
	rootAgentModelSelector,
	rootAgentToolNames,
} from "@oh-my-pi/pi-coding-agent/cli/launch-agent";
import { CliUsageError } from "@oh-my-pi/pi-coding-agent/cli/usage-error";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgHindsightAutoRecall, cfgHindsightAutoRetain } from "@oh-my-pi/pi-coding-agent/hindsight/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { TempDir } from "@oh-my-pi/pi-utils";

const FLAG_PROBE_MD = [
	"---",
	"name: flag-probe",
	'description: "CLI --agent flag fixture."',
	"tools: cloak, read, grep, glob, bash, write",
	'model: "@default"',
	"thinking-level: medium",
	"read-summarize: false",
	"autoload-skills: proof-skill",
	"spawns: scout, reviewer",
	"advisor: true",
	"---",
	"you are flag-probe — a fixture for the root --agent flag.",
].join("\n");
const HIDDEN_PROBE_MD = FLAG_PROBE_MD.replace("name: flag-probe", "name: hidden-probe").replace(
	"thinking-level: medium",
	"thinking-level: medium\nhide: true",
);
const NO_FALLBACK_PROBE_MD = FLAG_PROBE_MD.replace(
	"name: flag-probe",
	"name: no-fallback-probe\nmodel-fallback: false",
);
const MEMORY_PROBE_MD = FLAG_PROBE_MD.replace(
	"name: flag-probe",
	"name: memory-probe\nmemory: {autoRetain: false, autoRecall: false}",
);
const AUTHOR_PROBE_MD = [
	"---",
	"name: runtime-maintainer",
	'description: "Root runtime maintainer fixture."',
	"tools: read, grep, glob, bash, automation_author",
	"hide: true",
	"spawns: scout",
	"automationAuthor:",
	"  allowedAgents:",
	"    - pr-maintainer",
	"    - capability-maintainer",
	"  jurisdiction: descendants",
	"---",
	"you are runtime-maintainer — a fixture for durable authoring policy.",
].join("\n");

const SCOUT_MD = [
	"---",
	"name: scout",
	"description: MUST be used for exploratory codebase research.",
	"tools: read, grep, glob, web_search",
	'model: "@smol"',
	"thinking-level: medium",
	"---",
	"Investigate the codebase rapidly.",
].join("\n");

async function writeProjectAgent(content: string): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-flag-"));
	await fs.mkdir(path.join(cwd, ".omp", "agents"), { recursive: true });
	const { frontmatter } = (() => {
		const match = /^---\nname:\s+(\S+)/.exec(content);
		return { frontmatter: match?.[1] ?? "agent" };
	})();
	const name = frontmatter.replace(/["']/g, "");
	await fs.writeFile(path.join(cwd, ".omp", "agents", `${name}.md`), content);
	return cwd;
}

describe("parseArgs — --agent flag", () => {
	it("parses --agent as a string flag", () => {
		const result = parseArgs(["--agent", "navigator"]);
		expect(result.agent).toBe("navigator");
		expect(result.messages).toEqual([]);
	});

	it("defaults agent to undefined when omitted", () => {
		expect(parseArgs([]).agent).toBeUndefined();
	});

	it("parses --agent=name", () => {
		expect(parseArgs(["--agent=scout", "hello"]).agent).toBe("scout");
	});

	it("parses --agent-cwd without changing --cwd", () => {
		const result = parseArgs(["--agent", "flag-probe", "--agent-cwd", "/roles", "--cwd", "/work"]);
		expect(result.agentCwd).toBe("/roles");
		expect(result.cwd).toBe("/work");
	});

	it("registers --agent-cwd as a string value flag", () => {
		expect(STRING_VALUE_FLAGS.has("--agent-cwd")).toBe(true);
	});

	it("does not leak the agent name into the prompt", () => {
		const result = parseArgs(["--agent", "navigator", "open ubereats"]);
		expect(result.agent).toBe("navigator");
		expect(result.messages).toEqual(["open ubereats"]);
	});

	it("is in STRING_VALUE_FLAGS so it consumes the next token", () => {
		expect(STRING_VALUE_FLAGS.has("--agent")).toBe(true);
		const result = parseArgs(["--agent", "--profile", "work"]);
		expect(result.agent).toBe("--profile");
		expect(result.profile).toBeUndefined();
	});
});

describe("restartArgv — --agent flags", () => {
	it("keeps --agent and --agent-cwd as configuration flags across /restart", () => {
		expect(
			restartArgv(
				["--agent", "runtime-maintainer", "--agent-cwd", "/roles", "--cwd", "/work", "open ubereats"],
				"sid",
			),
		).toEqual(["--agent", "runtime-maintainer", "--agent-cwd", "/roles", "--cwd", "/work", "--resume", "sid"]);
	});
});

describe("root agent yaml helpers", () => {
	it("drops yield from the root tool list and keeps custom names", () => {
		expect(
			rootAgentToolNames({
				name: "navigator",
				description: "browser",
				systemPrompt: "",
				source: "user",
				tools: ["cloak", "read", "yield"],
			}),
		).toEqual(["cloak", "read"]);
	});

	it("treats @default as inherit-session, not a model pin", () => {
		expect(
			rootAgentModelSelector({
				name: "navigator",
				description: "browser",
				systemPrompt: "",
				source: "user",
				model: ["@default"],
			}),
		).toBeUndefined();
		expect(
			rootAgentModelSelector({
				name: "scout",
				description: "scout",
				systemPrompt: "",
				source: "bundled",
				model: ["@smol"],
			}),
		).toBe("@smol");
	});

	it("parses bundled-style scout yaml without extra tools", () => {
		const agent = parseAgent("scout.md", SCOUT_MD, "bundled");
		expect(rootAgentToolNames(agent)).toEqual(["read", "grep", "glob", "web_search"]);
		expect(rootAgentModelSelector(agent)).toBe("@smol");
		expect(agent.thinkingLevel).toBe(ThinkingLevel.Medium);
	});
});

describe("resolveLaunchAgent", () => {
	it("returns undefined when the flag is omitted", async () => {
		expect(await resolveLaunchAgent(undefined)).toBeUndefined();
	});

	it("rejects an empty name", async () => {
		await expect(resolveLaunchAgent("  ")).rejects.toBeInstanceOf(CliUsageError);
	});

	it("resolves a project agent over bundled/user namesakes", async () => {
		const cwd = await writeProjectAgent(FLAG_PROBE_MD);
		try {
			const agent = await resolveLaunchAgent("flag-probe", cwd);
			expect(agent?.name).toBe("flag-probe");
			expect(rootAgentToolNames(agent!)).toEqual(["cloak", "read", "grep", "glob", "bash", "write"]);
			expect(rootAgentModelSelector(agent!)).toBeUndefined();
			expect(agent?.systemPrompt).toContain("you are flag-probe");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("resolves an explicitly named hidden project agent", async () => {
		const cwd = await writeProjectAgent(HIDDEN_PROBE_MD);
		try {
			const agent = await resolveLaunchAgent("hidden-probe", cwd);
			expect(agent?.hide).toBe(true);
			expect(rootAgentToolNames(agent!)).toEqual(["cloak", "read", "grep", "glob", "bash", "write"]);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects a missing agent discovery root", async () => {
		await expect(resolveLaunchAgent("flag-probe", path.join(os.tmpdir(), "missing-agent-root"))).rejects.toThrow(
			"Agent discovery root is not a directory",
		);
	});

	it("rejects an unknown name with the available list", async () => {
		try {
			await resolveLaunchAgent("definitely-not-an-agent", os.tmpdir());
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(CliUsageError);
			expect((error as Error).message).toContain('Unknown agent "definitely-not-an-agent"');
			expect((error as Error).message).toMatch(/Available:/);
		}
	});
});

describe("buildSessionOptions — --agent", () => {
	let authStorage: AuthStorage | undefined;

	afterEach(() => {
		authStorage?.close();
		authStorage = undefined;
		restoreHindsightEnv();
	});

	async function optionsFor(argv: string[], cwd?: string, agentCwd?: string) {
		authStorage = await AuthStorage.create(":memory:");
		const registry = new ModelRegistry(authStorage);
		const settings = Settings.isolated({
			"async.enabled": false,
			"marketplace.autoUpdate": "off",
		});
		const parsed = parseArgs(argv);
		if (cwd) parsed.cwd = cwd;
		if (agentCwd) parsed.agentCwd = agentCwd;
		return { parsed, settings, options: await buildSessionOptions(parsed, [], undefined, registry, settings) };
	}

	it("applies project agent tools, thinking, body, and inherit-session model", async () => {
		const cwd = await writeProjectAgent(FLAG_PROBE_MD);
		try {
			const { options } = await optionsFor(["--agent", "flag-probe"], cwd);
			expect(options.toolNames).toEqual(["cloak", "read", "grep", "glob", "bash", "write"]);
			expect(options.thinkingLevel).toBe(ThinkingLevel.Medium);
			expect(options.customSystemPrompt).toContain("you are flag-probe");
			expect(options.agentDisplayName).toBe("flag-probe");
			expect(options.agentName).toBe("flag-probe");
			expect(options.rootAgentName).toBe("flag-probe");
			expect(options.model).toBeUndefined();
			expect(options.modelPattern).toBeUndefined();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("resolves role metadata from --agent-cwd while keeping execution cwd", async () => {
		const roleRoot = await writeProjectAgent(HIDDEN_PROBE_MD);
		const executionCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-work-"));
		try {
			const { options } = await optionsFor(
				["--agent", "hidden-probe", "--agent-cwd", roleRoot, "--cwd", executionCwd],
				executionCwd,
				roleRoot,
			);
			expect(options.cwd).toBe(executionCwd);
			expect(options.toolNames).toEqual(["cloak", "read", "grep", "glob", "bash", "write"]);
			expect(options.customSystemPrompt).toContain("you are flag-probe");
			expect(options.agentDisplayName).toBe("hidden-probe");
			expect(options.thinkingLevel).toBe(ThinkingLevel.Medium);
			expect(options.autoloadSkills).toEqual(["proof-skill"]);
			expect(options.spawns).toBe("scout,reviewer");
			expect(options.agentName).toBe("hidden-probe");
			expect(options.rootAgentName).toBe("hidden-probe");
			expect(options.automationAuthor).toBeUndefined();
		} finally {
			await fs.rm(roleRoot, { recursive: true, force: true });
			await fs.rm(executionCwd, { recursive: true, force: true });
		}
	});

	it("mounts the agent persona, tools, skills and spawns when resuming", async () => {
		// A resume restores `model` and `thinkingLevel` from the transcript, so those stay
		// gated. The persona body, tools, skills and spawns are not persisted: gating them
		// too left a resumed `--agent` session running the default OMP prompt with the
		// default tool set under the agent's name.
		const cwd = await writeProjectAgent(FLAG_PROBE_MD);
		try {
			const { options } = await optionsFor(
				["--agent", "flag-probe", "--resume", "01a00000-0000-7000-8000-000000000000"],
				cwd,
			);
			expect(options.customSystemPrompt).toContain("you are flag-probe");
			expect(options.toolNames).toEqual(["cloak", "read", "grep", "glob", "bash", "write"]);
			expect(options.agentDisplayName).toBe("flag-probe");
			expect(options.agentName).toBe("flag-probe");
			expect(options.autoloadSkills).toEqual(["proof-skill"]);
			expect(options.spawns).toBe("scout,reviewer");
			// Restored from the transcript, so the launch agent must not overwrite them.
			expect(options.thinkingLevel).toBeUndefined();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("disables client and server fallback for an agent declaring model-fallback: false", async () => {
		const cwd = await writeProjectAgent(NO_FALLBACK_PROBE_MD);
		try {
			const { options } = await optionsFor(["--agent", "no-fallback-probe"], cwd);
			expect(options.disableModelFallback).toBe(true);
			expect(options.disableServerSideFallback).toBe(true);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("restores the pinned fallback policy from the persisted root agent", async () => {
		const cwd = await writeProjectAgent(NO_FALLBACK_PROBE_MD);
		try {
			authStorage = await AuthStorage.create(":memory:");
			const registry = new ModelRegistry(authStorage);
			const settings = Settings.isolated({
				"async.enabled": false,
				"marketplace.autoUpdate": "off",
			});
			const parsed = parseArgs(["--continue"]);
			parsed.cwd = cwd;
			const sessionManager = {
				getHeader: () => ({ rootAgent: "no-fallback-probe" }),
				setRootAgent: async () => {},
			};
			const options = await buildSessionOptions(parsed, [], sessionManager as never, registry, settings);
			expect(options.rootAgentName).toBe("no-fallback-probe");
			expect(options.disableModelFallback).toBe(true);
			expect(options.disableServerSideFallback).toBe(true);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("leaves the fallback flags unset when the agent omits model-fallback", async () => {
		const cwd = await writeProjectAgent(FLAG_PROBE_MD);
		try {
			const { options } = await optionsFor(["--agent", "flag-probe"], cwd);
			expect(options.disableModelFallback).toBeUndefined();
			expect(options.disableServerSideFallback).toBeUndefined();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("lets --tools --thinking --model --system-prompt win", async () => {
		const cwd = await writeProjectAgent(FLAG_PROBE_MD);
		try {
			const { parsed, options } = await optionsFor(
				[
					"--agent",
					"flag-probe",
					"--tools",
					"bash",
					"--thinking",
					"high",
					"--model",
					"opus",
					"--system-prompt",
					"you are a test double",
				],
				cwd,
			);
			expect(parsed.model).toBe("opus");
			expect(options.toolNames).toEqual(["bash"]);
			expect(options.thinkingLevel).toBe(ThinkingLevel.High);
			expect(options.customSystemPrompt).toBe("you are a test double");
			expect(options.agentDisplayName).toBe("flag-probe");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("applies the agent yaml when restoring a session", async () => {
		// `model` and `thinkingLevel` come back from the transcript; the persona body,
		// tools, skills and spawns do not. Skipping them on restore left a restarted
		// `--agent` session running the default OMP prompt with the default tool set.
		const cwd = await writeProjectAgent(FLAG_PROBE_MD);
		try {
			const { options } = await optionsFor(["--agent", "flag-probe", "--continue"], cwd);
			expect(options.toolNames).toEqual(["cloak", "read", "grep", "glob", "bash", "write"]);
			expect(options.customSystemPrompt).toContain("you are flag-probe");
			expect(options.agentDisplayName).toBe("flag-probe");
			expect(options.agentName).toBe("flag-probe");
			expect(options.rootAgentName).toBe("flag-probe");
			expect(options.thinkingLevel).toBeUndefined();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("restores agentName from the session header without a CLI --agent", async () => {
		const cwd = await writeProjectAgent(FLAG_PROBE_MD);
		try {
			authStorage = await AuthStorage.create(":memory:");
			const registry = new ModelRegistry(authStorage);
			const settings = Settings.isolated({
				"async.enabled": false,
				"marketplace.autoUpdate": "off",
			});
			const parsed = parseArgs(["--continue"]);
			parsed.cwd = cwd;
			const sessionManager = {
				getHeader: () => ({ rootAgent: "flag-probe" }),
				setRootAgent: async () => {},
			};
			const options = await buildSessionOptions(parsed, [], sessionManager as never, registry, settings);
			expect(options.agentName).toBe("flag-probe");
			expect(options.rootAgentName).toBe("flag-probe");
			// The header names the agent this session belonged to, so resuming without a
			// CLI `--agent` still has to mount that agent's persona rather than the default.
			expect(options.agentDisplayName).toBe("flag-probe");
			expect(options.toolNames).toEqual(["cloak", "read", "grep", "glob", "bash", "write"]);
			expect(options.customSystemPrompt).toContain("you are flag-probe");
			expect(options.thinkingLevel).toBeUndefined();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("switches the profile when a restore names a different --agent", async () => {
		// An explicit `--agent` on a resume is how an actor's `<agent>.md` is changed across
		// a recycle: the new profile mounts and is recorded, so the next resume keeps it.
		const cwd = await writeProjectAgent(HIDDEN_PROBE_MD);
		try {
			authStorage = await AuthStorage.create(":memory:");
			const registry = new ModelRegistry(authStorage);
			const settings = Settings.isolated({
				"async.enabled": false,
				"marketplace.autoUpdate": "off",
			});
			const parsed = parseArgs(["--agent", "hidden-probe", "--continue"]);
			parsed.cwd = cwd;
			const recorded: string[] = [];
			const sessionManager = {
				getHeader: () => ({ rootAgent: "flag-probe" }),
				setRootAgent: async (name: string) => {
					recorded.push(name);
				},
			};
			const options = await buildSessionOptions(parsed, [], sessionManager as never, registry, settings);
			expect(options.agentName).toBe("hidden-probe");
			expect(options.agentDisplayName).toBe("hidden-probe");
			expect(recorded).toEqual(["hidden-probe"]);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("fails closed when a persisted privileged root role is missing", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-flag-empty-"));
		try {
			authStorage = await AuthStorage.create(":memory:");
			const registry = new ModelRegistry(authStorage);
			const settings = Settings.isolated({
				"async.enabled": false,
				"marketplace.autoUpdate": "off",
			});
			const parsed = parseArgs(["--continue"]);
			parsed.cwd = cwd;
			const sessionManager = {
				getHeader: () => ({ rootAgent: "flag-probe" }),
				setRootAgent: async () => {},
			};
			await expect(buildSessionOptions(parsed, [], sessionManager as never, registry, settings)).rejects.toThrow(
				/Persisted root agent "flag-probe" is missing/,
			);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("binds automationAuthor from --agent-cwd independently of execution cwd and spawns", async () => {
		const roleRoot = await writeProjectAgent(AUTHOR_PROBE_MD);
		const executionCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-work-"));
		try {
			const { options } = await optionsFor(
				["--agent", "runtime-maintainer", "--agent-cwd", roleRoot, "--cwd", executionCwd],
				executionCwd,
				roleRoot,
			);
			expect(options.cwd).toBe(executionCwd);
			expect(options.agentName).toBe("runtime-maintainer");
			expect(options.rootAgentName).toBe("runtime-maintainer");
			expect(options.agentDisplayName).toBe("runtime-maintainer");
			expect(options.spawns).toBe("scout");
			expect(options.automationAuthor).toEqual({
				allowedAgents: ["pr-maintainer", "capability-maintainer"],
				jurisdiction: "descendants",
			});
		} finally {
			await fs.rm(roleRoot, { recursive: true, force: true });
			await fs.rm(executionCwd, { recursive: true, force: true });
		}
	});

	it("applies the root agent memory policy over the settings default", async () => {
		const cwd = await writeProjectAgent(MEMORY_PROBE_MD);
		try {
			setHindsightEnv({});
			const { options, settings } = await optionsFor(["--agent", "memory-probe"], cwd);
			expect(options.agentMemory).toEqual({ autoRetain: false, autoRecall: false });
			expect(cfgHindsightAutoRetain.get(settings)).toBe(false);
			expect(cfgHindsightAutoRecall.get(settings)).toBe(false);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("keeps HINDSIGHT_AUTO_RETAIN above the root agent memory policy", async () => {
		const cwd = await writeProjectAgent(MEMORY_PROBE_MD);
		try {
			setHindsightEnv({ HINDSIGHT_AUTO_RETAIN: "true" });
			const { options, settings } = await optionsFor(["--agent", "memory-probe"], cwd);
			expect(options.agentMemory).toEqual({ autoRetain: false, autoRecall: false });
			expect(cfgHindsightAutoRetain.get(settings)).toBe(true);
			expect(cfgHindsightAutoRecall.get(settings)).toBe(false);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("applies the memory policy resolved from --agent-cwd independently of execution cwd", async () => {
		const roleRoot = await writeProjectAgent(MEMORY_PROBE_MD);
		const executionCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-work-"));
		try {
			setHindsightEnv({});
			const { options, settings } = await optionsFor(
				["--agent", "memory-probe", "--agent-cwd", roleRoot, "--cwd", executionCwd],
				executionCwd,
				roleRoot,
			);
			expect(options.cwd).toBe(executionCwd);
			expect(options.agentMemory).toEqual({ autoRetain: false, autoRecall: false });
			expect(cfgHindsightAutoRetain.get(settings)).toBe(false);
			expect(cfgHindsightAutoRecall.get(settings)).toBe(false);
		} finally {
			await fs.rm(roleRoot, { recursive: true, force: true });
			await fs.rm(executionCwd, { recursive: true, force: true });
		}
	});

	it("leaves the memory settings untouched when the agent declares no policy", async () => {
		const cwd = await writeProjectAgent(FLAG_PROBE_MD);
		try {
			setHindsightEnv({});
			const { options, settings } = await optionsFor(["--agent", "flag-probe"], cwd);
			expect(options.agentMemory).toBeUndefined();
			expect(cfgHindsightAutoRetain.get(settings)).toBe(true);
			expect(cfgHindsightAutoRecall.get(settings)).toBe(true);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});

const HINDSIGHT_ENV_NAMES = ["HINDSIGHT_AUTO_RETAIN", "HINDSIGHT_AUTO_RECALL"] as const;
const savedHindsightEnv = new Map(HINDSIGHT_ENV_NAMES.map(name => [name, Bun.env[name]]));

function setHindsightEnv(env: Partial<Record<(typeof HINDSIGHT_ENV_NAMES)[number], string>>): void {
	for (const name of HINDSIGHT_ENV_NAMES) delete Bun.env[name];
	Object.assign(Bun.env, env);
}

function restoreHindsightEnv(): void {
	for (const [name, value] of savedHindsightEnv) {
		if (value === undefined) delete Bun.env[name];
		else Bun.env[name] = value;
	}
}

describe("createAgentSession — agentMemory", () => {
	const OPENAI_TEST_MODEL = getBundledModel("openai", "gpt-4o-mini");
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		restoreHindsightEnv();
	});

	async function createSession(
		tempDir: TempDir,
		agentMemory: { autoRetain?: boolean; autoRecall?: boolean },
		options: { taskDepth?: number; parentTaskPrefix?: string } = {},
	): Promise<Settings> {
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		const settings = Settings.isolated({
			"async.enabled": false,
			"marketplace.autoUpdate": "off",
		});
		const created = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			model: OPENAI_TEST_MODEL,
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
			agentMemory,
			...options,
		});
		session = created.session;
		return settings;
	}

	it("applies agentMemory to a root session over the settings default", async () => {
		using tempDir = TempDir.createSync("@omp-agent-memory-sdk-");
		setHindsightEnv({});
		const settings = await createSession(tempDir, { autoRetain: false, autoRecall: false });
		expect(cfgHindsightAutoRetain.get(settings)).toBe(false);
		expect(cfgHindsightAutoRecall.get(settings)).toBe(false);
	});

	it("lets HINDSIGHT_AUTO_RECALL win over agentMemory for a root session", async () => {
		using tempDir = TempDir.createSync("@omp-agent-memory-env-");
		setHindsightEnv({ HINDSIGHT_AUTO_RECALL: "true" });
		const settings = await createSession(tempDir, { autoRetain: false, autoRecall: false });
		expect(cfgHindsightAutoRetain.get(settings)).toBe(false);
		expect(cfgHindsightAutoRecall.get(settings)).toBe(true);
	});

	it("does not apply agentMemory to a subagent session", async () => {
		using tempDir = TempDir.createSync("@omp-agent-memory-sub-");
		setHindsightEnv({});
		const settings = await createSession(tempDir, { autoRetain: false, autoRecall: false }, { taskDepth: 1 });
		expect(cfgHindsightAutoRetain.get(settings)).toBe(true);
		expect(cfgHindsightAutoRecall.get(settings)).toBe(true);
	});

	it("exposes the effective memory policy on the session", async () => {
		using tempDir = TempDir.createSync("@omp-agent-memory-view-");
		setHindsightEnv({ HINDSIGHT_AUTO_RETAIN: "true" });
		await createSession(tempDir, { autoRetain: false, autoRecall: false });
		expect(session?.getAgentMemoryPolicy()).toEqual({ autoRetain: true, autoRecall: false });
	});
});
