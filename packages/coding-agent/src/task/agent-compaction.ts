/**
 * The `compaction:` block of an agent definition's frontmatter.
 *
 * Per-agent policy exists because the right compaction moment is a property of
 * the agent's job, not of the model alone: a 1M-token window cannot express
 * "compact at 160k" as a percentage. A fixed `thresholdTokens` therefore wins
 * over `thresholdPercent` whenever both are declared.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import type { CompactionThresholdPair } from "../config/compaction-threshold";
import { lookup } from "../config/registry";
import type { Settings } from "../config/settings";
import { type CompactionMethod, isCompactionMethod } from "../session/compaction-methods";

export interface AgentCompactionPolicy {
	/** `false` disables automatic context maintenance for this agent's sessions. */
	enabled?: boolean;
	/** Percent of the model's window; ignored when `thresholdTokens` is set. */
	thresholdPercent?: number;
	/** Fixed token trigger; overrides `thresholdPercent`. */
	thresholdTokens?: number;
	/** Automatic maintenance preference order. */
	methodOrder?: CompactionMethod[];
	/** Include the session's EPISODES index in snapcompact summaries. */
	episodeIndex?: boolean;
}

function positiveInteger(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		const parsed = Number(value);
		if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
	}
	return undefined;
}

function percent(value: unknown): number | undefined {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
				? Number(value)
				: undefined;
	return parsed !== undefined && Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : undefined;
}

/** Parse the `compaction:` frontmatter block; malformed fields are dropped, never thrown. */
export function parseAgentCompaction(value: unknown): AgentCompactionPolicy | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) return {};
	const policy: AgentCompactionPolicy = {};
	if (typeof value.enabled === "boolean") policy.enabled = value.enabled;
	const thresholdPercent = percent(value.thresholdPercent);
	if (thresholdPercent !== undefined) policy.thresholdPercent = thresholdPercent;
	const thresholdTokens = positiveInteger(value.thresholdTokens);
	if (thresholdTokens !== undefined) policy.thresholdTokens = thresholdTokens;
	if (Array.isArray(value.methodOrder)) {
		const methods: CompactionMethod[] = [];
		for (const method of value.methodOrder) {
			if (isCompactionMethod(method) && !methods.includes(method)) methods.push(method);
		}
		if (methods.length > 0) policy.methodOrder = methods;
	}
	if (typeof value.episodeIndex === "boolean") policy.episodeIndex = value.episodeIndex;
	return policy;
}

/** The policy's threshold pair for `compaction.thresholdPercent`/`compaction.thresholdTokens`. */
export function agentCompactionThreshold(policy: AgentCompactionPolicy): CompactionThresholdPair | undefined {
	if (policy.thresholdTokens !== undefined && policy.thresholdTokens > 0) {
		return { thresholdPercent: -1, thresholdTokens: policy.thresholdTokens };
	}
	if (policy.thresholdPercent !== undefined && policy.thresholdPercent > 0) {
		return { thresholdPercent: policy.thresholdPercent, thresholdTokens: -1 };
	}
	return undefined;
}

/** Settings overrides applying one agent definition's compaction policy to its session. */
export function agentCompactionSettings(
	policy: AgentCompactionPolicy | undefined,
): Readonly<Record<string, unknown>> | undefined {
	if (!policy) return undefined;
	const settings: Record<string, unknown> = {};
	if (policy.enabled !== undefined) settings["compaction.enabled"] = policy.enabled;
	if (policy.methodOrder !== undefined) settings["compaction.methodOrder"] = policy.methodOrder;
	if (policy.episodeIndex !== undefined) settings["compaction.episodeIndex"] = policy.episodeIndex;
	const threshold = agentCompactionThreshold(policy);
	if (threshold) {
		settings["compaction.thresholdPercent"] = threshold.thresholdPercent;
		settings["compaction.thresholdTokens"] = threshold.thresholdTokens;
		settings["compaction.modelThresholdsEnabled"] = false;
	}
	return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * Applies {@link agentCompactionSettings} to a session's settings. A key already configured by an
 * environment variable or any settings layer keeps its value, so an explicit compaction setting
 * beats the profile's frontmatter.
 */
export function applyAgentCompactionPolicy(settings: Settings, policy: AgentCompactionPolicy | undefined): void {
	const overrides = agentCompactionSettings(policy);
	if (!overrides) return;
	for (const [key, value] of Object.entries(overrides)) {
		const setting = lookup(key);
		if (setting && !setting.isConfigured(settings)) setting.override(settings, value);
	}
}
