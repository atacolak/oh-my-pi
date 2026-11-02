import { describe, expect, it } from "bun:test";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import {
	agentCompactionSettings,
	agentCompactionThreshold,
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
			agentMarkdown("  thresholdPercent: 150\n  thresholdTokens: nope\n  methodOrder: [not-a-method]\n  enabled: yes"),
			"project",
		);
		expect(agent.compaction).toEqual({});
	});

	it("omits compaction entirely when the agent declares none", () => {
		const agent = parseAgent("probe.md", "---\nname: probe\ndescription: probe agent\n---\n\nDo it.\n", "project");
		expect(agent.compaction).toBeUndefined();
	});
});
