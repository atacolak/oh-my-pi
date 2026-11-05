import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseAgentFields } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { resolveBuiltinToolPlan, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";

describe("parseAgentFields", () => {
	test("rejects the reserved `main` and `sub` agent definition names", () => {
		expect(parseAgentFields({ name: "main", description: "desc" })).toBeNull();
		expect(parseAgentFields({ name: " Main ", description: "desc" })).toBeNull();
		expect(parseAgentFields({ name: "sub", description: "desc" })).toBeNull();
		expect(parseAgentFields({ name: " Sub ", description: "desc" })).toBeNull();
	});

	test("parses blocking from boolean frontmatter", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			blocking: true,
		});

		expect(fields).toBeDefined();
		expect(fields?.blocking).toBe(true);
	});

	test("parses blocking from string frontmatter", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			blocking: "false",
		});

		expect(fields).toBeDefined();
		expect(fields?.blocking).toBe(false);
	});

	test("ignores invalid blocking values", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			blocking: "sometimes",
		});

		expect(fields).toBeDefined();
		expect(fields?.blocking).toBeUndefined();
	});
	test("parses hide from boolean frontmatter", () => {
		expect(parseAgentFields({ name: "runtime-integrator", description: "desc", hide: true })?.hide).toBe(true);
		expect(parseAgentFields({ name: "runtime-integrator", description: "desc", hide: false })?.hide).toBe(false);
	});
	test("parses legacy thinking key", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			thinking: "medium",
		});

		expect(fields).toBeDefined();
		expect(fields?.thinkingLevel).toBe(Effort.Medium);
	});

	test("prefers thinking-level over legacy thinking", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			thinking: "minimal",
			thinkingLevel: Effort.High,
		});

		expect(fields?.thinkingLevel).toBe(Effort.High);
	});
	test("accepts the auto thinking selector", () => {
		const fields = parseAgentFields({
			name: "worker",
			description: "desc",
			thinkingLevel: "auto",
		});

		expect(fields?.thinkingLevel).toBe(AUTO_THINKING);
	});

	test("rejects unknown thinking selectors", () => {
		const fields = parseAgentFields({
			name: "worker",
			description: "desc",
			thinkingLevel: "turbo",
		});

		expect(fields?.thinkingLevel).toBeUndefined();
	});

	test("keeps an explicitly empty tools list distinct from an absent one", () => {
		expect(parseAgentFields({ name: "quiet", description: "desc", tools: [] })?.tools).toEqual([]);
		expect(parseAgentFields({ name: "quiet", description: "desc" })?.tools).toBeUndefined();
		expect(parseAgentFields({ name: "quiet", description: "desc", tools: null })?.tools).toBeUndefined();
	});

	test.each([
		["empty string", ""],
		["non-string scalar", 42],
		["non-string array", [1, 2]],
	])("treats %s tools as an empty built-in allowlist", (_label, tools) => {
		expect(parseAgentFields({ name: "quiet", description: "desc", tools })?.tools).toEqual([]);
	});

	test("keeps string entries in mixed tools arrays and normalizes aliases", () => {
		expect(
			parseAgentFields({ name: "reader", description: "desc", tools: [1, "Read", true, "Search"] })?.tools,
		).toEqual(["read", "grep"]);
	});

	test("gives a malformed tools declaration only the required child yield tool, not default built-ins", async () => {
		const fields = parseAgentFields({ name: "quiet", description: "desc", tools: 42 });
		if (!fields) throw new Error("agent fields did not parse");
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "",
			settings: Settings.isolated(),
			taskDepth: 1,
			requireYieldTool: true,
			enableLsp: false,
			skipPythonPreflight: true,
		};

		const plan = await resolveBuiltinToolPlan(session, fields.tools);
		expect(plan.names).toEqual(["yield"]);
	});

	test("maps legacy search alias to grep and keeps find canonical", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			tools: ["Find", "Glob", "Search", "Grep"],
		});

		expect(fields?.tools).toEqual(["find", "glob", "grep"]);
	});

	test("parses autoloadSkills from array frontmatter", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
			autoloadSkills: ["user-created-skill-a", "user-created-skill-b"],
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toEqual(["user-created-skill-a", "user-created-skill-b"]);
	});

	test("parses autoloadSkills from CSV string", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
			autoloadSkills: "user-created-skill-a, user-created-skill-b",
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toEqual(["user-created-skill-a", "user-created-skill-b"]);
	});

	test("returns undefined autoloadSkills when field absent", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toBeUndefined();
	});

	test("returns undefined autoloadSkills for empty array", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
			autoloadSkills: [],
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toBeUndefined();
	});

	test("parses readSummarize from boolean frontmatter", () => {
		expect(parseAgentFields({ name: "scout", description: "desc", readSummarize: false })?.readSummarize).toBe(false);
		expect(parseAgentFields({ name: "scout", description: "desc", readSummarize: true })?.readSummarize).toBe(true);
	});

	test("parses readSummarize from string frontmatter", () => {
		expect(parseAgentFields({ name: "scout", description: "desc", readSummarize: "false" })?.readSummarize).toBe(
			false,
		);
	});

	test("ignores invalid readSummarize values", () => {
		expect(
			parseAgentFields({ name: "scout", description: "desc", readSummarize: "nope" })?.readSummarize,
		).toBeUndefined();
	});

	test("returns undefined readSummarize when field absent", () => {
		expect(parseAgentFields({ name: "scout", description: "desc" })?.readSummarize).toBeUndefined();
	});
	test("parses modelFallback from boolean and boolean-string frontmatter", () => {
		expect(parseAgentFields({ name: "pinned", description: "desc", modelFallback: false })?.modelFallback).toBe(
			false,
		);
		expect(parseAgentFields({ name: "pinned", description: "desc", modelFallback: "false" })?.modelFallback).toBe(
			false,
		);
		expect(
			parseAgentFields({ name: "pinned", description: "desc", modelFallback: "sometimes" })?.modelFallback,
		).toBeUndefined();
		expect(parseAgentFields({ name: "pinned", description: "desc" })?.modelFallback).toBeUndefined();
	});

	test("reads model-fallback from markdown frontmatter", () => {
		const agent = parseAgent(
			"pinned.md",
			["---", "name: pinned", 'description: "desc"', "model-fallback: false", "---", "body"].join("\n"),
			"project",
		);
		expect(agent.modelFallback).toBe(false);
	});

	test("parses prewalk from boolean frontmatter", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: true })?.prewalk).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: false })?.prewalk).toBe(false);
	});

	test("parses prewalk boolean strings as booleans", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "true" })?.prewalk).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "false" })?.prewalk).toBe(false);
	});

	test("parses prewalk model pattern strings", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: " @smol " })?.prewalk).toBe("@smol");
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "openai/gpt-5-mini" })?.prewalk).toBe(
			"openai/gpt-5-mini",
		);
	});

	test("ignores empty and absent prewalk values", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "  " })?.prewalk).toBeUndefined();
		expect(parseAgentFields({ name: "worker", description: "desc" })?.prewalk).toBeUndefined();
	});
	test("parses advisor from boolean frontmatter and boolean strings", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: true })?.advisor).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: false })?.advisor).toBe(false);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "true" })?.advisor).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "false" })?.advisor).toBe(false);
	});

	test("parses advisor model pattern strings and ignores empty/absent values", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: " moonshot/k3 " })?.advisor).toBe(
			"moonshot/k3",
		);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "@smol:high" })?.advisor).toBe(
			"@smol:high",
		);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "  " })?.advisor).toBeUndefined();
		expect(parseAgentFields({ name: "worker", description: "desc" })?.advisor).toBeUndefined();
	});
	test("parses descendant and scope automationAuthor policies", () => {
		expect(
			parseAgentFields({
				name: "runtime-maintainer",
				description: "desc",
				spawns: "scout",
				automationAuthor: {
					allowedAgents: ["pr-maintainer", "capability-maintainer"],
					jurisdiction: "descendants",
				},
			})?.automationAuthor,
		).toEqual({
			allowedAgents: ["pr-maintainer", "capability-maintainer"],
			jurisdiction: "descendants",
		});
		expect(
			parseAgentFields({
				name: "automation-builder",
				description: "desc",
				automationAuthor: { allowedAgents: "*", jurisdiction: "scope" },
			})?.automationAuthor,
		).toEqual({ allowedAgents: "*", jurisdiction: "scope" });
	});

	test("keeps automationAuthor independent from spawns and drops invalid grants", () => {
		const fields = parseAgentFields({
			name: "runtime-maintainer",
			description: "desc",
			spawns: ["scout"],
			automationAuthor: { allowedAgents: [], jurisdiction: "descendants" },
		});
		expect(fields?.spawns).toEqual(["scout"]);
		expect(fields?.automationAuthor).toBeUndefined();
		expect(
			parseAgentFields({
				name: "runtime-maintainer",
				description: "desc",
				automationAuthor: { allowedAgents: "*", jurisdiction: "universe" },
			})?.automationAuthor,
		).toBeUndefined();
	});

	test("parses kebab-case multi-word fields from raw frontmatter", () => {
		const fields = parseAgentFields({
			name: "pinned",
			description: "desc",
			"model-fallback": false,
			"read-summarize": false,
			"thinking-level": "high",
			"autoload-skills": ["user-created-skill-a", "user-created-skill-b"],
			"automation-author": {
				jurisdiction: "descendants",
				"allowed-agents": ["scout"],
			},
		});

		expect(fields?.modelFallback).toBe(false);
		expect(fields?.readSummarize).toBe(false);
		expect(fields?.thinkingLevel).toBe(Effort.High);
		expect(fields?.autoloadSkills).toEqual(["user-created-skill-a", "user-created-skill-b"]);
		expect(fields?.automationAuthor).toEqual({ allowedAgents: ["scout"], jurisdiction: "descendants" });
	});

	test("prefers camelCase over a kebab-case spelling supplied on the same record", () => {
		const fields = parseAgentFields({
			name: "pinned",
			description: "desc",
			modelFallback: true,
			"model-fallback": false,
			readSummarize: true,
			"read-summarize": false,
			thinkingLevel: "low",
			"thinking-level": "high",
			autoloadSkills: ["camel"],
			"autoload-skills": ["kebab"],
			automationAuthor: { jurisdiction: "scope", allowedAgents: "*" },
			"automation-author": { jurisdiction: "descendants", "allowed-agents": ["kebab"] },
		});

		expect(fields?.modelFallback).toBe(true);
		expect(fields?.readSummarize).toBe(true);
		expect(fields?.thinkingLevel).toBe(Effort.Low);
		expect(fields?.autoloadSkills).toEqual(["camel"]);
		expect(fields?.automationAuthor).toEqual({ allowedAgents: "*", jurisdiction: "scope" });
	});

	test("parses kebab-case fields from strict rawKeys frontmatter", () => {
		const { frontmatter } = parseFrontmatter(
			[
				"---",
				"name: pinned",
				'description: "desc"',
				"model-fallback: false",
				"read-summarize: false",
				"thinking-level: high",
				"autoload-skills:",
				"  - user-created-skill-a",
				"automation-author:",
				"  jurisdiction: descendants",
				"  allowed-agents:",
				"    - scout",
				"---",
				"body",
			].join("\n"),
			{ rawKeys: true },
		);

		expect(frontmatter["model-fallback"]).toBe(false);
		const fields = parseAgentFields(frontmatter);
		expect(fields?.modelFallback).toBe(false);
		expect(fields?.readSummarize).toBe(false);
		expect(fields?.thinkingLevel).toBe(Effort.High);
		expect(fields?.autoloadSkills).toEqual(["user-created-skill-a"]);
		expect(fields?.automationAuthor).toEqual({ allowedAgents: ["scout"], jurisdiction: "descendants" });
	});

	test("keeps an opaque output schema verbatim while reading kebab-case keys", () => {
		const output = {
			properties: { "foo-bar": { type: "string" } },
			optionalProperties: { "cache-key": { type: "string" } },
		};
		const fields = parseAgentFields({
			name: "schema-agent",
			description: "desc",
			"model-fallback": false,
			output,
		});

		expect(fields?.modelFallback).toBe(false);
		expect(fields?.output).toBe(output);
		const schema = fields?.output as typeof output;
		expect(Object.keys(schema.properties)).toEqual(["foo-bar"]);
		expect(Object.keys(schema.optionalProperties)).toEqual(["cache-key"]);
	});

	test("parses a camelCase memory policy and keeps it on the agent definition", () => {
		const fields = parseAgentFields({
			name: "pr-maintainer",
			description: "desc",
			memory: { autoRetain: false, autoRecall: true },
		});
		expect(fields?.memory).toEqual({ autoRetain: false, autoRecall: true });

		const agent = parseAgent(
			"pr-maintainer.md",
			["---", "name: pr-maintainer", 'description: "desc"', "memory: {autoRetain: false}", "---", "body"].join("\n"),
			"project",
		);
		expect(agent.memory).toEqual({ autoRetain: false });
	});

	test("parses kebab-case memory keys whether normalizing or raw", () => {
		const direct = parseAgentFields({
			name: "pr-maintainer",
			description: "desc",
			memory: { "auto-retain": false, "auto-recall": false },
		});
		expect(direct?.memory).toEqual({ autoRetain: false, autoRecall: false });

		const { frontmatter } = parseFrontmatter(
			[
				"---",
				"name: pr-maintainer",
				'description: "desc"',
				"memory:",
				"  auto-retain: false",
				"  auto-recall: false",
				"---",
				"body",
			].join("\n"),
			{ rawKeys: true },
		);
		expect(frontmatter.memory).toEqual({ "auto-retain": false, "auto-recall": false });
		expect(parseAgentFields(frontmatter)?.memory).toEqual({ autoRetain: false, autoRecall: false });
	});

	test("ignores malformed memory declarations and keeps only valid booleans", () => {
		expect(
			parseAgentFields({ name: "pr-maintainer", description: "desc", memory: "invalid" })?.memory,
		).toBeUndefined();
		expect(parseAgentFields({ name: "pr-maintainer", description: "desc", memory: {} })?.memory).toBeUndefined();
		expect(parseAgentFields({ name: "pr-maintainer", description: "desc", memory: [] })?.memory).toBeUndefined();
		expect(parseAgentFields({ name: "pr-maintainer", description: "desc" })?.memory).toBeUndefined();
		expect(
			parseAgentFields({
				name: "pr-maintainer",
				description: "desc",
				memory: { autoRetain: "sometimes", autoRecall: false },
			})?.memory,
		).toEqual({ autoRecall: false });
	});
});
