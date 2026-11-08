import { afterEach, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseAgentFields } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { applyAgentMemoryPolicy } from "@oh-my-pi/pi-coding-agent/hindsight/agent-memory-policy";
import {
	cfgHindsightAutoRecall,
	cfgHindsightAutoRetain,
	cfgHindsightRecallBudget,
	cfgHindsightRecallMaxTokens,
	cfgHindsightRetainEveryNTurns,
} from "@oh-my-pi/pi-coding-agent/hindsight/settings";

afterEach(() => vi.restoreAllMocks());

it("normalizes five memory policy fields, including kebab aliases and explicit false", () => {
	const fields = parseAgentFields({
		name: "memory-probe",
		description: "test memory policy",
		memory: {
			"auto-recall": "false",
			"auto-retain": "false",
			"recall-budget": "deep",
			"recall-max-tokens": 4096,
			"retain-every-n-turns": 3,
		},
	});
	expect(fields?.memory).toEqual({
		autoRecall: false,
		autoRetain: false,
		recallBudget: "deep",
		recallMaxTokens: 4096,
		retainEveryNTurns: 3,
	});
});

it("rejects invalid numeric policy values instead of enabling them", () => {
	expect(
		parseAgentFields({
			name: "memory-probe",
			description: "test memory policy",
			memory: {
				recallBudget: "invalid",
				recallMaxTokens: 0,
				retainEveryNTurns: 0,
			},
		})?.memory,
	).toBeUndefined();
	expect(
		parseAgentFields({
			name: "memory-probe",
			description: "test memory policy",
			memory: {
				autoRecall: false,
				recallMaxTokens: Number.POSITIVE_INFINITY,
				retainEveryNTurns: 1.5,
			},
		})?.memory,
	).toEqual({ autoRecall: false });
});

it("applies parsed numeric policy over persisted settings without dropping explicit false", () => {
	vi.spyOn(cfgHindsightAutoRecall, "envValue").mockReturnValue(undefined);
	vi.spyOn(cfgHindsightAutoRetain, "envValue").mockReturnValue(undefined);
	vi.spyOn(cfgHindsightRecallMaxTokens, "envValue").mockReturnValue(undefined);
	vi.spyOn(cfgHindsightRetainEveryNTurns, "envValue").mockReturnValue(undefined);
	const settings = Settings.isolated();
	cfgHindsightRecallMaxTokens.set(settings, 512);
	cfgHindsightRetainEveryNTurns.set(settings, 7);
	const policy = parseAgentFields({
		name: "memory-probe",
		description: "test memory policy",
		memory: {
			autoRecall: false,
			autoRetain: false,
			recallMaxTokens: 100000,
			retainEveryNTurns: 3,
		},
	})?.memory;
	applyAgentMemoryPolicy(settings, policy);
	expect(cfgHindsightAutoRecall.get(settings)).toBe(false);
	expect(cfgHindsightAutoRetain.get(settings)).toBe(false);
	expect(cfgHindsightRecallMaxTokens.get(settings)).toBe(16384);
	expect(cfgHindsightRetainEveryNTurns.get(settings)).toBe(3);
});

it("keeps the operator's numeric environment overrides above frontmatter policy", () => {
	vi.spyOn(cfgHindsightRecallMaxTokens, "envValue").mockReturnValue(8192);
	vi.spyOn(cfgHindsightRetainEveryNTurns, "envValue").mockReturnValue(5);
	const settings = Settings.isolated();
	applyAgentMemoryPolicy(settings, { recallMaxTokens: 4096, retainEveryNTurns: 3 });
	expect(cfgHindsightRecallMaxTokens.get(settings)).toBe(8192);
	expect(cfgHindsightRetainEveryNTurns.get(settings)).toBe(5);
});

it("migrates legacy frontmatter gears and clamps the small return window", () => {
	const parse = (recallBudget: string) =>
		parseAgentFields({
			name: "memory-probe",
			description: "policy migration",
			memory: { recallBudget, recallMaxTokens: 100 },
		})?.memory;
	expect(parse("mid")).toMatchObject({ recallBudget: "default", recallMaxTokens: 512 });
	expect(parse("xhigh")).toMatchObject({ recallBudget: "deep" });
});

it("applies recall gears on a legacy release without crashing root agent startup", () => {
	vi.spyOn(cfgHindsightRecallBudget, "envValue").mockReturnValue(undefined);
	const settings = Settings.isolated();
	const apply = (recallBudget: string) => {
		const policy = parseAgentFields({
			name: "memory-probe",
			description: "legacy release compatibility",
			memory: { recallBudget },
		})?.memory;
		applyAgentMemoryPolicy(settings, policy);
		return cfgHindsightRecallBudget.get(settings);
	};
	expect(apply("default")).toBe("mid");
	expect(apply("deep")).toBe("high");
	expect(apply("max")).toBe("high");
});

it("keeps the operator's recall budget above an agent's incompatible gear", () => {
	vi.spyOn(cfgHindsightRecallBudget, "envValue").mockReturnValue("low");
	const settings = Settings.isolated();
	applyAgentMemoryPolicy(settings, { recallBudget: "max" });
	expect(cfgHindsightRecallBudget.get(settings)).toBe("low");
});
