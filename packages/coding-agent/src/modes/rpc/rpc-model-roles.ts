import type { Model } from "@oh-my-pi/pi-ai";
import * as path from "node:path";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { formatModelRoleAlias, getKnownRoleIds, getRoleInfo } from "../../config/model-roles";
import {
	resolveConfiguredModelPatterns,
	resolveExplicitModelRole,
	resolveModelRoleValue,
} from "../../config/model-resolver";
import { readRuntimeBootIdentity } from "../../launch/runtime-generation";
import type { AgentSession } from "../../session/agent-session";
import { EPHEMERAL_MODEL_CHANGE_ROLE, PREWALK_MODEL_CHANGE_ROLE } from "../../session/session-entries";
import { isSessionSettled } from "../../session/session-settle";
import type { RpcModelControlTarget, RpcModelRole, RpcModelRolesState } from "./rpc-types";

const MAX_ROLES = 128;
const MAX_CHAIN = 32;
const MAX_SELECTOR_CHARS = 512;
const MAX_CONFIGURED_CHARS = 4096;

export class RpcModelControlError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

function modelRef(model: Model | undefined): { provider: string; id: string } | null {
	return model ? { provider: model.provider, id: model.id } : null;
}

/** The assigned role is durable intent; retry fallbacks and later config edits do not erase it. */
export function getRpcSelectedModelRole(session: AgentSession): string | null {
	const role = session.sessionManager.getLastModelChangeRole({ skipEphemeral: true });
	return role && role !== "temporary" ? role : null;
}

/** Read only the loaded owner's native role settings, resolver and journal. */
export function getRpcModelRoles(session: AgentSession): RpcModelRolesState {
	const ids = getKnownRoleIds(session.settings);
	const available = session.getAvailableModels();
	let truncated = ids.length > MAX_ROLES;
	const rows: RpcModelRole[] = ids.slice(0, MAX_ROLES).map(id => {
		const selector = formatModelRoleAlias(id);
		const configured = session.settings.getModelRole(id) ?? null;
		const chain = resolveConfiguredModelPatterns(selector, session.settings);
		const resolved = resolveModelRoleValue(selector, available, { settings: session.settings });
		const rowTruncated =
			chain.length > MAX_CHAIN ||
			chain.some(value => value.length > MAX_SELECTOR_CHARS) ||
			(configured?.length ?? 0) > MAX_CONFIGURED_CHARS;
		truncated ||= rowTruncated;
		return {
			id,
			name: getRoleInfo(id, session.settings).name,
			selector,
			configuredValue: configured?.slice(0, MAX_CONFIGURED_CHARS) ?? null,
			chain: chain.slice(0, MAX_CHAIN).map(value => value.slice(0, MAX_SELECTOR_CHARS)),
			source: session.settings.getModelRoleProvenance(id),
			model: modelRef(resolved.model),
			thinkingLevel: resolved.thinkingLevel ?? null,
			explicitThinkingLevel: resolved.explicitThinkingLevel,
			matchedPatternIndex: resolved.matchedPatternIndex ?? null,
			truncated: rowTruncated,
		};
	});
	const role = getRpcSelectedModelRole(session);
	const resolved = role
		? resolveModelRoleValue(formatModelRoleAlias(role), available, { settings: session.settings })
		: undefined;
	return {
		version: 1,
		capabilities: { roleSelection: true, sessionOnlyModel: true, preserveThinking: true },
		roles: rows,
		truncated,
		currentRole: role,
		lastSelectedRole: role,
		resolvedPrimary: modelRef(resolved?.model),
		roleMatchesCurrentModel: role !== null && modelsAreEqual(resolved?.model, session.model),
		current: modelRef(session.model),
		thinkingLevel: session.thinkingLevel ?? null,
		sessionId: session.sessionId,
		sessionFile: session.sessionFile ?? null,
		bootId: readRuntimeBootIdentity().bootId,
	};
}

/** Recheck identity immediately before the native model write, including after metadata awaits. */
export function rpcModelTargetGuard(
	session: AgentSession,
	expected: RpcModelControlTarget,
	scheduledTurn?: () => boolean,
): (checkIdle?: boolean) => void {
	const sessionId = session.sessionId;
	const sessionFile = session.sessionFile;
	const bootId = readRuntimeBootIdentity().bootId;
	const check = (checkIdle = true) => {
		if (
			session.sessionId !== sessionId ||
			session.sessionFile !== sessionFile ||
			readRuntimeBootIdentity().bootId !== bootId ||
			(expected.expectedSessionId !== undefined && expected.expectedSessionId !== sessionId) ||
			(expected.expectedSessionFile !== undefined &&
				(typeof expected.expectedSessionFile !== "string" ||
					!path.isAbsolute(expected.expectedSessionFile) ||
					expected.expectedSessionFile !== sessionFile)) ||
			(expected.expectedBootId !== undefined && expected.expectedBootId !== bootId)
		) {
			throw new RpcModelControlError(
				"session_target_mismatch",
				"The expected session, transcript or owner boot no longer matches.",
			);
		}
		if (
			checkIdle &&
			(session.isCompacting || session.isBusyForSnapshot || !isSessionSettled(session, scheduledTurn))
		) {
			throw new RpcModelControlError(
				"session_busy",
				"Wait until the native owner is idle before changing its model.",
			);
		}
	};
	check();
	return check;
}

function preservedThinking(session: AgentSession) {
	return session.isAutoThinking ? AUTO_THINKING : session.thinkingLevel;
}

/** Resolve and apply one native role without writing shared role settings. */
export async function setRpcModelRole(
	session: AgentSession,
	command: RpcModelControlTarget & { role: string; preserveThinking?: boolean },
	scheduledTurn?: () => boolean,
): Promise<RpcModelRolesState> {
	const guard = rpcModelTargetGuard(session, command, scheduledTurn);
	if (
		typeof command.role !== "string" ||
		command.role.length > MAX_SELECTOR_CHARS ||
		/[\u0000-\u001f\u007f]/.test(command.role) ||
		command.role === "temporary" ||
		command.role === EPHEMERAL_MODEL_CHANGE_ROLE ||
		command.role === PREWALK_MODEL_CHANGE_ROLE ||
		resolveExplicitModelRole(formatModelRoleAlias(command.role), session.settings) !== command.role
	) {
		throw new RpcModelControlError("unknown_model_role", "Choose a native model role reported by this owner.");
	}
	if (command.preserveThinking !== undefined && typeof command.preserveThinking !== "boolean") {
		throw new RpcModelControlError("invalid_model_options", "preserveThinking must be a boolean.");
	}
	const resolved = resolveModelRoleValue(formatModelRoleAlias(command.role), session.getAvailableModels(), {
		settings: session.settings,
	});
	if (!resolved.model)
		throw new RpcModelControlError(
			"model_role_unavailable",
			"No available model satisfies this owner's configured role.",
		);
	const thinking = resolved.explicitThinkingLevel
		? resolved.thinkingLevel
		: command.preserveThinking === false
			? undefined
			: preservedThinking(session);
	await session.setModel(resolved.model, command.role, {
		persist: false,
		beforeApply: guard,
		beforeRecord: () => guard(false),
	});
	guard(false);
	if (thinking !== undefined) session.setThinkingLevel(thinking);
	return getRpcModelRoles(session);
}

/** Optional session-only direct selection; the legacy command's defaults remain unchanged. */
export async function setRpcDirectModel(
	session: AgentSession,
	model: Model,
	command: RpcModelControlTarget & { sessionOnly?: boolean; preserveThinking?: boolean },
	scheduledTurn?: () => boolean,
): Promise<void> {
	for (const option of [command.sessionOnly, command.preserveThinking]) {
		if (option !== undefined && typeof option !== "boolean")
			throw new RpcModelControlError("invalid_model_options", "Model options must be booleans.");
	}
	const guard = rpcModelTargetGuard(session, command, scheduledTurn);
	const thinking = command.preserveThinking === true ? preservedThinking(session) : undefined;
	if (command.sessionOnly === true)
		await session.setModelTemporary(model, thinking, { beforeApply: guard, beforeRecord: () => guard(false) });
	else {
		await session.setModel(model, "default", {
			persist: false,
			beforeApply: guard,
			beforeRecord: () => guard(false),
		});
		guard(false);
		if (thinking !== undefined) session.setThinkingLevel(thinking);
	}
	guard(false);
}
