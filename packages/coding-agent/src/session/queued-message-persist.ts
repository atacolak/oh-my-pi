import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { readFileSync, rmSync } from "node:fs";
import { writeFileAtomicallySync } from "../utils/atomic-file";

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
			rmSync(path, { force: true });
			return;
		}
		const snapshot: QueuedMessagesSnapshot = {
			version: QUEUED_MESSAGES_VERSION,
			steering: queues.steering.slice(),
			followUp: queues.followUp.slice(),
		};
		writeFileAtomicallySync(path, `${JSON.stringify(snapshot)}\n`);
	} catch {
		return;
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
