/**
 * Persist the in-memory steering and follow-up queues next to the session file.
 *
 * `session.steer()` and `session.followUp()` keep mid-turn user messages only
 * in RAM, so a process restart would drop them. Write `${sessionFile}.queued.json`
 * on every queue mutation and restore it when AgentSession connects to that
 * session file.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export const QUEUED_MESSAGES_VERSION = 1 as const;

export type QueuedMessagesSnapshot = {
	version: typeof QUEUED_MESSAGES_VERSION;
	steering: AgentMessage[];
	followUp: AgentMessage[];
};

export function queuedMessagesPath(sessionFile: string): string {
	return `${sessionFile}.queued.json`;
}

export function persistQueuedMessages(
	sessionFile: string,
	queues: { steering: readonly AgentMessage[]; followUp: readonly AgentMessage[] },
): void {
	const path = queuedMessagesPath(sessionFile);
	const empty = queues.steering.length === 0 && queues.followUp.length === 0;
	try {
		if (empty) {
			if (existsSync(path)) unlinkSync(path);
			return;
		}
		const snapshot: QueuedMessagesSnapshot = {
			version: QUEUED_MESSAGES_VERSION,
			steering: queues.steering.slice(),
			followUp: queues.followUp.slice(),
		};
		writeFileSync(path, `${JSON.stringify(snapshot)}\n`);
	} catch {
		/* session dir unwritable: RAM queue still works */
	}
}

export function loadQueuedMessages(sessionFile: string): {
	steering: AgentMessage[];
	followUp: AgentMessage[];
} | null {
	try {
		const raw = readFileSync(queuedMessagesPath(sessionFile), "utf8");
		const parsed = JSON.parse(raw) as Partial<QueuedMessagesSnapshot>;
		if (parsed?.version !== QUEUED_MESSAGES_VERSION) return null;
		if (!Array.isArray(parsed.steering) || !Array.isArray(parsed.followUp)) return null;
		return { steering: parsed.steering, followUp: parsed.followUp };
	} catch {
		return null;
	}
}
