import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	cfgCompactionMethodOrder,
	cfgCompactionModelThresholdsEnabled,
	cfgCompactionThresholdPercent,
	cfgCompactionThresholdTokens,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import {
	agentCompactionSettings,
	agentCompactionThreshold,
	applyAgentCompactionPolicy,
} from "@oh-my-pi/pi-coding-agent/task/agent-compaction";

function agentMarkdown(compaction: string): string {
	return `---\nname: probe\ndescription: probe agent\ncompaction:\n${compaction}\n---\n\nDo the thing.\n`;
}

describe("agent compaction frontmatter", () => {
	it("reads enabled, thresholds, method order and episodeIndex from an agent file", () => {
		const agent = parseAgent(
			"probe.md",
			agentMarkdown(
				"  enabled: false\n  thresholdPercent: 85\n  thresholdTokens: 160000\n  methodOrder: [soft, remote]\n  episodeIndex: false",
			),
			"project",
		);
		expect(agent.compaction).toEqual({
			enabled: false,
			thresholdPercent: 85,
			thresholdTokens: 160_000,
			methodOrder: ["soft", "remote"],
			episodeIndex: false,
		});
	});

	it("lets a fixed token threshold override the percentage", () => {
		const policy = { thresholdPercent: 85, thresholdTokens: 160_000 };
		expect(agentCompactionThreshold(policy)).toEqual({ thresholdPercent: -1, thresholdTokens: 160_000 });
		expect(agentCompactionSettings(policy)).toMatchObject({
			"compaction.thresholdPercent": -1,
			"compaction.thresholdTokens": 160_000,
		});
	});

	it("uses the percentage when no token threshold is set", () => {
		expect(agentCompactionThreshold({ thresholdPercent: 60 })).toEqual({ thresholdPercent: 60, thresholdTokens: -1 });
		expect(agentCompactionSettings({ thresholdPercent: 60 })).toMatchObject({
			"compaction.thresholdPercent": 60,
			"compaction.thresholdTokens": -1,
		});
	});

	it("drops malformed fields instead of throwing", () => {
		const agent = parseAgent(
			"probe.md",
			agentMarkdown(
				"  thresholdPercent: 150\n  thresholdTokens: nope\n  methodOrder: [not-a-method]\n  enabled: yes",
			),
			"project",
		);
		expect(agent.compaction).toEqual({});
	});

	it("omits compaction entirely when the agent declares none", () => {
		const agent = parseAgent("probe.md", "---\nname: probe\ndescription: probe agent\n---\n\nDo it.\n", "project");
		expect(agent.compaction).toBeUndefined();
	});
});

/** Settings whose `compaction` block really comes from a `config.yml` file, not a runtime override. */
async function configFileSettings(
	compaction: Record<string, unknown>,
	overrides: Readonly<Record<string, unknown>> = {},
): Promise<{ settings: Settings; remove: () => Promise<void> }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-compaction-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ compaction }, null, 2));
	const settings = await Settings.loadIsolated({ cwd, agentDir, overrides });
	return { settings, remove: () => fs.rm(root, { recursive: true, force: true }) };
}

describe("agent compaction policy precedence", () => {
	it("overrides a config-file thresholdPercent", async () => {
		const { settings, remove } = await configFileSettings({ thresholdPercent: 80 });
		try {
			expect(cfgCompactionThresholdPercent.get(settings)).toBe(80);
			applyAgentCompactionPolicy(settings, { thresholdPercent: 55 });
			expect(cfgCompactionThresholdPercent.get(settings)).toBe(55);
			expect(cfgCompactionThresholdTokens.get(settings)).toBe(-1);
		} finally {
			await remove();
		}
	});

	it("overrides a config-file methodOrder", async () => {
		const { settings, remove } = await configFileSettings({ methodOrder: ["remote", "soft"] });
		try {
			expect(cfgCompactionMethodOrder.get(settings)).toEqual(["remote", "soft"]);
			applyAgentCompactionPolicy(settings, { methodOrder: ["snapcompact", "soft"] });
			expect(cfgCompactionMethodOrder.get(settings)).toEqual(["snapcompact", "soft"]);
		} finally {
			await remove();
		}
	});

	it("keeps an explicit operator threshold over the profile's whole threshold decision", async () => {
		const { settings, remove } = await configFileSettings(
			{ thresholdPercent: 80 },
			{ "compaction.thresholdPercent": 70 },
		);
		try {
			applyAgentCompactionPolicy(settings, { thresholdTokens: 400_000 });
			expect(cfgCompactionThresholdPercent.get(settings)).toBe(70);
			expect(cfgCompactionThresholdTokens.get(settings)).toBe(-1);
			expect(cfgCompactionModelThresholdsEnabled.get(settings)).toBe(true);
		} finally {
			await remove();
		}
	});
});
