import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { sanitizeText, truncate } from "@oh-my-pi/pi-utils";
import { readRuntimeGeneration } from "../../launch/runtime-generation";
import { redactMemorySecrets } from "../../memory-backend/redact";
import type { AgentSession } from "../../session/agent-session";
import { isSessionSettled } from "../../session/session-settle";
import { calculateTokensPerSecond } from "../../utils/token-rate";
import type { RpcSessionDiagnostics, RpcSessionExecution, RpcSessionState } from "./rpc-types";

const MAX_DIAGNOSTIC_WARNINGS = 20;
const MAX_DIAGNOSTIC_WARNING_CHARS = 1024;

/** Report live owner scope, never infer it from an actor name or a caller's settings. */
export function getRpcSessionExecution(session: AgentSession): RpcSessionExecution {
	const owner: AgentSession & { getAgentProfileName?: () => string | undefined } = session;
	const profile = owner.getAgentProfileName?.();
	const memory = session.getHindsightSessionState();
	const resolvedTags = memory && "resolvedTags" in memory ? memory.resolvedTags : undefined;
	return {
		profile: profile ?? null,
		cwd: session.sessionManager.getCwd(),
		memory: memory
			? {
					backend: "hindsight",
					scoping: memory.config.scoping,
					scopeTags:
						Array.isArray(resolvedTags) && resolvedTags.every((tag: unknown) => typeof tag === "string")
							? [...resolvedTags]
							: null,
				}
			: null,
	};
}

/** Read the owner's effective configuration, never a launch selector or global default. */
export function getRpcSessionDiagnostics(session: AgentSession): RpcSessionDiagnostics {
	const warnings = session.configWarnings;
	return {
		version: 1,
		observedAt: Date.now(),
		model: session.model ? { provider: session.model.provider, id: session.model.id } : null,
		thinkingLevel: session.thinkingLevel ?? null,
		configWarnings: warnings
			.slice(0, MAX_DIAGNOSTIC_WARNINGS)
			.map(warning => truncate(redactMemorySecrets(sanitizeText(warning)), MAX_DIAGNOSTIC_WARNING_CHARS)),
		warningsTruncated:
			warnings.length > MAX_DIAGNOSTIC_WARNINGS ||
			warnings.some(warning => warning.length > MAX_DIAGNOSTIC_WARNING_CHARS),
		execution: getRpcSessionExecution(session),
	};
}

/**
 * Snapshot one RPC `get_state` payload. Shared by every transport so a second
 * client sees exactly the state the stdio transport reports.
 */
export function getRpcSessionState(session: AgentSession, scheduledTurn?: () => boolean): RpcSessionState {
	const queuedMessages = session.getQueuedMessages();
	return {
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		sessionDiagnostics: getRpcSessionDiagnostics(session),
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		interruptMode: session.interruptMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		autoCompactionEnabled: session.autoCompactionEnabled,
		queuedMessageCount: session.queuedMessageCount,
		hasPendingAsyncWork: session.hasPendingAsyncWork(),
		// A scheduled goal continuation will start a turn: not settled.
		isSettled: isSessionSettled(session, scheduledTurn),
		queuedMessages: {
			steering: [...queuedMessages.steering],
			followUp: [...queuedMessages.followUp],
			liveSteered: queuedMessages.liveSteered,
		},
		todoPhases: session.getTodoPhases(),
		fastModeEnabled: session.isFastModeEnabled(),
		tokensPerSecond: calculateTokensPerSecond(session.messages, session.isStreaming),
		fastModeActive: session.isFastModeActive(),
		slowModeSupported: session.isSlowModeSupported(),
		slowModeEnabled: session.isSlowModeEnabled(),
		slowModeScope: session.getSlowModeScope(),
		usageLimit: session.getUsageLimitState(),
		messageCount: session.messages.length,
		systemPrompt: session.systemPrompt,
		dumpTools: session.agent.state.tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			parameters: toolWireSchema(tool),
			examples: tool.examples,
		})),
		contextUsage: session.getContextUsage(),
		generation: readRuntimeGeneration(),
		goal: session.getGoalModeState() ?? null,
	};
}
