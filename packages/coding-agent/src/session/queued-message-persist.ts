import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger, toError } from "@oh-my-pi/pi-utils";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import { writeFileAtomicallySync } from "../utils/atomic-file";

export const QUEUED_MESSAGES_VERSION = 1 as const;

export type QueuedMessagesSnapshot = {
	version: typeof QUEUED_MESSAGES_VERSION;
	steering: AgentMessage[];
	followUp: AgentMessage[];
};

/**
 * Snapshot path inside the session's artifact directory. The session id keeps
 * concurrent sessions apart when they share an artifacts directory, as a
 * subagent that adopted its parent's does.
 */
export function queuedMessagesPath(artifactsDir: string, sessionId: string): string {
	return path.join(artifactsDir, `queued-messages-${sessionId}.json`);
}

function isQueuedMessage(value: unknown): value is AgentMessage {
	if (typeof value !== "object" || value === null || !("role" in value)) return false;
	return typeof value.role === "string";
}

function isQueuedMessageList(value: unknown): value is AgentMessage[] {
	return Array.isArray(value) && value.every(isQueuedMessage);
}

function isQueuedMessagesSnapshot(value: unknown): value is QueuedMessagesSnapshot {
	if (typeof value !== "object" || value === null) return false;
	if (!("version" in value) || value.version !== QUEUED_MESSAGES_VERSION) return false;
	if (!("steering" in value) || !isQueuedMessageList(value.steering)) return false;
	if (!("followUp" in value) || !isQueuedMessageList(value.followUp)) return false;
	return true;
}

export function persistQueuedMessages(
	artifactsDir: string,
	sessionId: string,
	queues: { steering: readonly AgentMessage[]; followUp: readonly AgentMessage[] },
): void {
	const file = queuedMessagesPath(artifactsDir, sessionId);
	const empty = queues.steering.length === 0 && queues.followUp.length === 0;
	try {
		if (empty) {
			rmSync(file, { force: true });
			return;
		}
		const snapshot: QueuedMessagesSnapshot = {
			version: QUEUED_MESSAGES_VERSION,
			steering: queues.steering.slice(),
			followUp: queues.followUp.slice(),
		};
		mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
		writeFileAtomicallySync(file, `${JSON.stringify(snapshot)}\n`);
	} catch (error) {
		logger.warn("Failed to persist queued messages", { path: file, error: toError(error).message });
	}
}

export function loadQueuedMessages(
	artifactsDir: string,
	sessionId: string,
): {
	steering: AgentMessage[];
	followUp: AgentMessage[];
} | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(queuedMessagesPath(artifactsDir, sessionId), "utf8"));
		if (!isQueuedMessagesSnapshot(parsed)) return null;
		return { steering: parsed.steering, followUp: parsed.followUp };
	} catch {
		return null;
	}
}
