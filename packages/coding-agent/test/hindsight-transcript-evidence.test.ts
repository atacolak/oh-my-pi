import { describe, expect, it } from "bun:test";
import { extractMessages } from "@oh-my-pi/pi-coding-agent/hindsight/transcript";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const USER_TS = "2026-09-04T10:00:00.000Z";
const ASSISTANT_TS = "2026-09-04T10:00:05.000Z";

function mixedEvidenceEntries(): SessionEntry[] {
	return [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: USER_TS,
			message: {
				role: "user",
				content: "real user",
				timestamp: Date.parse(USER_TS),
			},
		},
		{
			type: "compaction",
			id: "c1",
			parentId: "u1",
			timestamp: "2026-09-04T10:00:01.000Z",
			summary: "SYNTHETIC HOT STATE",
			firstKeptEntryId: "u1",
			tokensBefore: 12_000,
		},
		{
			type: "branch_summary",
			id: "b1",
			parentId: "c1",
			timestamp: "2026-09-04T10:00:02.000Z",
			fromId: "u1",
			summary: "SYNTHETIC BRANCH",
		},
		{
			type: "custom_message",
			id: "cm1",
			parentId: "b1",
			timestamp: "2026-09-04T10:00:03.000Z",
			customType: "extension-note",
			content: "custom message must never become evidence",
			display: true,
		},
		{
			type: "custom",
			id: "cu1",
			parentId: "cm1",
			timestamp: "2026-09-04T10:00:04.000Z",
			customType: "extension-state",
			data: { note: "custom entry must never become evidence" },
		},
		{
			type: "message",
			id: "a1",
			parentId: "cu1",
			timestamp: ASSISTANT_TS,
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "PRIVATE THINKING" },
					{
						type: "toolCall",
						id: "call-1",
						name: "bash",
						arguments: { command: "echo tool-noise" },
					},
					{ type: "text", text: "real assistant" },
				],
				timestamp: Date.parse(ASSISTANT_TS),
			},
		},
		{
			type: "message",
			id: "tool-noise",
			parentId: "a1",
			timestamp: "2026-09-04T10:00:06.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "tool entry must never become evidence" }],
				isError: false,
				timestamp: Date.parse("2026-09-04T10:00:06.000Z"),
			},
		},
	] as SessionEntry[];
}

describe("hindsight transcript evidence boundary", () => {
	it("keeps only genuine user/assistant text from mixed synthetic session entries", () => {
		const extracted = extractMessages({ getEntries: () => mixedEvidenceEntries() });
		expect(extracted).toEqual([
			{ role: "user", content: "real user", timestamp: USER_TS },
			{ role: "assistant", content: "real assistant", timestamp: ASSISTANT_TS },
		]);

		const serialized = JSON.stringify(extracted);
		expect(serialized).not.toContain("SYNTHETIC HOT STATE");
		expect(serialized).not.toContain("SYNTHETIC BRANCH");
		expect(serialized).not.toContain("PRIVATE THINKING");
		expect(serialized).not.toContain("custom message must never become evidence");
		expect(serialized).not.toContain("custom entry must never become evidence");
		expect(serialized).not.toContain("tool entry must never become evidence");
	});

	it("never treats a compaction entry as assistant evidence even when it contains user-like text", () => {
		const entries = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: USER_TS,
				message: {
					role: "user",
					content: "what did we decide about routing?",
					timestamp: Date.parse(USER_TS),
				},
			},
			{
				type: "compaction",
				id: "hot-compact",
				parentId: "u1",
				timestamp: "2026-09-04T10:00:01.000Z",
				summary:
					"Decision: keep Hindsight demand-driven. Prefer per-project banks. Operator said ship the boundary tonight.",
				firstKeptEntryId: "u1",
				tokensBefore: 18_000,
			},
			{
				type: "message",
				id: "a1",
				parentId: "hot-compact",
				timestamp: ASSISTANT_TS,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "still waiting on explicit recall" }],
					timestamp: Date.parse(ASSISTANT_TS),
				},
			},
		] as SessionEntry[];

		const extracted = extractMessages({ getEntries: () => entries });
		expect(extracted).toEqual([
			{ role: "user", content: "what did we decide about routing?", timestamp: USER_TS },
			{ role: "assistant", content: "still waiting on explicit recall", timestamp: ASSISTANT_TS },
		]);
		expect(JSON.stringify(extracted)).not.toContain("keep Hindsight demand-driven");
		expect(JSON.stringify(extracted)).not.toContain("ship the boundary tonight");
	});
});
