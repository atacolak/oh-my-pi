import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
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
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";

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
		return { parsed, options: await buildSessionOptions(parsed, [], undefined, registry, settings) };
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

	it("does not apply yaml when restoring a session", async () => {
		const cwd = await writeProjectAgent(FLAG_PROBE_MD);
		try {
			const { options } = await optionsFor(["--agent", "flag-probe", "--continue"], cwd);
			expect(options.toolNames).toBeUndefined();
			expect(options.customSystemPrompt).toBeUndefined();
			expect(options.agentDisplayName).toBeUndefined();
			expect(options.agentName).toBe("flag-probe");
			expect(options.rootAgentName).toBe("flag-probe");
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
			expect(options.agentDisplayName).toBeUndefined();
			expect(options.toolNames).toBeUndefined();
			expect(options.customSystemPrompt).toBeUndefined();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects a conflicting restore-time --agent", async () => {
		const cwd = await writeProjectAgent(FLAG_PROBE_MD);
		try {
			authStorage = await AuthStorage.create(":memory:");
			const registry = new ModelRegistry(authStorage);
			const settings = Settings.isolated({
				"async.enabled": false,
				"marketplace.autoUpdate": "off",
			});
			const parsed = parseArgs(["--agent", "hidden-probe", "--continue"]);
			parsed.cwd = cwd;
			const sessionManager = {
				getHeader: () => ({ rootAgent: "flag-probe" }),
				setRootAgent: async () => {},
			};
			await expect(buildSessionOptions(parsed, [], sessionManager as never, registry, settings)).rejects.toThrow(
				/refusing conflicting --agent/,
			);
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
});
