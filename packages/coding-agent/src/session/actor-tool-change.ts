import {
	ACTOR_TOOL_CHANGE_MESSAGE_TYPE,
	type ActorToolChangeNoticeDetails,
	type CustomMessage,
} from "@oh-my-pi/pi-tui/chat/messages";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import actorToolChangeNoticePrompt from "../prompts/system/actor-tool-change-notice.md" with { type: "text" };

export { ACTOR_TOOL_CHANGE_MESSAGE_TYPE, type ActorToolChangeNoticeDetails };

/** Persistent tool selection applied to this session. */
export interface ActorToolOverrideSnapshot {
	readonly added: readonly string[];
	readonly removed: readonly string[];
}

export interface ActorToolNoticeEntry {
	readonly type: string;
	readonly customType?: string;
	readonly details?: unknown;
}

/**
 * Latest typed tool-selection change recorded for one conversation UUID. Reads
 * every entry of the journal, so a change made on another branch of the same
 * conversation still counts; entries written for another UUID never do.
 */
export function latestActorToolOverride(
	entries: readonly ActorToolNoticeEntry[],
	sessionId: string,
): ActorToolOverrideSnapshot | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry || entry.type !== "custom_message" || entry.customType !== ACTOR_TOOL_CHANGE_MESSAGE_TYPE) continue;
		if (!isRecord(entry.details)) continue;
		const details = entry.details;
		if (details.sessionId !== sessionId || details.origin !== "system" || details.scope !== "session") continue;
		const override = details.override;
		if (
			!isRecord(override) ||
			!Array.isArray(override.added) ||
			!Array.isArray(override.removed) ||
			!override.added.every(name => typeof name === "string") ||
			!override.removed.every(name => typeof name === "string")
		) {
			throw new Error("Invalid saved actor tool override");
		}
		return { added: override.added, removed: override.removed };
	}
	return undefined;
}

export interface ActorToolChangeNoticeInput {
	readonly sessionId: string;
	readonly added: readonly string[];
	readonly removed: readonly string[];
	readonly override: ActorToolOverrideSnapshot;
	readonly timestamp: number;
}

/**
 * Builds the single visible message that records an operator tool-selection
 * change: the XML body is what the model reads, `details` is what resume reads
 * to restore the override, and the caller's timestamp keeps the journal entry
 * and its live events matchable on replay.
 */
export function buildActorToolChangeNotice(
	input: ActorToolChangeNoticeInput,
): CustomMessage<ActorToolChangeNoticeDetails> {
	const added = [...input.added].sort();
	const removed = [...input.removed].sort();
	return {
		role: "custom",
		customType: ACTOR_TOOL_CHANGE_MESSAGE_TYPE,
		content: prompt.render(actorToolChangeNoticePrompt, {
			added: added.length > 0 ? added.join(", ") : undefined,
			removed: removed.length > 0 ? removed.join(", ") : undefined,
		}),
		details: {
			sessionId: input.sessionId,
			added,
			removed,
			override: {
				added: [...input.override.added].sort(),
				removed: [...input.override.removed].sort(),
			},
			origin: "system",
			scope: "session",
		},
		attribution: "agent",
		display: true,
		timestamp: input.timestamp,
	};
}
