/** Root agent `memory` frontmatter policy applied to the Hindsight auto settings. */
import type { Settings } from "../config/settings";
import type { AgentMemoryPolicy } from "../task/types";
import {
	cfgHindsightAutoRecall,
	cfgHindsightAutoRetain,
	cfgHindsightRecallBudget,
	cfgHindsightRecallMaxTokens,
	cfgHindsightRetainEveryNTurns,
} from "./settings";

/**
 * Apply a root agent's `memory` policy to live settings.
 *
 * `HINDSIGHT_AUTO_RETAIN` / `HINDSIGHT_AUTO_RECALL` always win: registry resolution prefers the
 * environment over every settings layer, and an override is written only when the variable is
 * unset. The agent's value then wins over persisted settings.
 */
export function applyAgentMemoryPolicy(settings: Settings, policy: AgentMemoryPolicy | undefined): void {
	if (policy?.autoRetain !== undefined && cfgHindsightAutoRetain.envValue() === undefined) {
		cfgHindsightAutoRetain.override(settings, policy.autoRetain);
	}
	if (policy?.autoRecall !== undefined && cfgHindsightAutoRecall.envValue() === undefined) {
		cfgHindsightAutoRecall.override(settings, policy.autoRecall);
	}
	if (policy?.recallBudget !== undefined && cfgHindsightRecallBudget.envValue() === undefined) {
		cfgHindsightRecallBudget.override(settings, cfgHindsightRecallBudget.parse(policy.recallBudget));
	}
	if (policy?.recallMaxTokens !== undefined && cfgHindsightRecallMaxTokens.envValue() === undefined) {
		cfgHindsightRecallMaxTokens.override(settings, policy.recallMaxTokens);
	}
	if (policy?.retainEveryNTurns !== undefined && cfgHindsightRetainEveryNTurns.envValue() === undefined) {
		cfgHindsightRetainEveryNTurns.override(settings, policy.retainEveryNTurns);
	}
}
