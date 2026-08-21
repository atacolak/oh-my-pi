/**
 * Resolve `--agent` against the same discovery surface as `task`.
 */
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { isSessionInheritedAgentPattern } from "../config/model-resolver";
import { discoverAgents, getAgent } from "../task/discovery";
import type { AgentDefinition } from "../task/types";
import { CliUsageError } from "./usage-error";

/** Look up a launch agent by name, or `undefined` when `--agent` was omitted. */
export async function resolveLaunchAgent(
	name: string | undefined,
	cwd: string = getProjectDir(),
): Promise<AgentDefinition | undefined> {
	if (name === undefined) return undefined;
	const trimmed = name.trim();
	if (!trimmed) {
		throw new CliUsageError("--agent requires an agent name.");
	}
	const { agents } = await discoverAgents(cwd);
	const agent = getAgent(agents, trimmed);
	if (!agent) {
		const available = agents.map(entry => entry.name).sort();
		throw new CliUsageError(
			`Unknown agent "${trimmed}". Available: ${available.length > 0 ? available.join(", ") : "(none)"}.`,
		);
	}
	return agent;
}

/** Explicit tool list for a root session: keep custom names, drop subagent-only `yield`. */
export function rootAgentToolNames(agent: AgentDefinition): string[] | undefined {
	if (!agent.tools || agent.tools.length === 0) return undefined;
	const tools = agent.tools.filter(toolName => toolName !== "yield");
	return tools.length > 0 ? tools : undefined;
}

/** First agent model selector, or `undefined` when the yaml means "inherit session model". */
export function rootAgentModelSelector(agent: AgentDefinition): string | undefined {
	const first = agent.model?.[0]?.trim();
	if (!first || isSessionInheritedAgentPattern(first)) return undefined;
	return first;
}
