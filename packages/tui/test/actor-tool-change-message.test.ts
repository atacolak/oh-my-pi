import { beforeAll, describe, expect, it } from "bun:test";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { ACTOR_TOOL_CHANGE_MESSAGE_TYPE, type ActorToolChangeNoticeDetails } from "@oh-my-pi/pi-tui/chat/messages";
import type { CustomMessageEntryLike } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const SYSTEM_NOTICE_CONTENT =
	'<system-notice id="actor-tool-change" origin="system" scope="session">The operator changed this session\'s tool selection. Now available: agent_mail. No longer available: bash. This selection persists for this session.</system-notice>';

function noticeEntry(): CustomMessageEntryLike {
	const details: ActorToolChangeNoticeDetails = {
		sessionId: "session-1",
		added: ["agent_mail"],
		removed: ["bash"],
		override: { added: ["agent_mail"], removed: [] },
		origin: "system",
		scope: "session",
	};
	return {
		type: "custom_message",
		id: "entry-1",
		parentId: null,
		timestamp: new Date(1_700_000_000_000).toISOString(),
		customType: ACTOR_TOOL_CHANGE_MESSAGE_TYPE,
		content: SYSTEM_NOTICE_CONTENT,
		details,
		display: true,
		attribution: "agent",
	};
}

describe("actor tool change transcript row", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("draws the applied tool delta as one row instead of the raw system notice", () => {
		const builder = new ChatTranscriptBuilder({
			ui: { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} } as never,
			cwd: "/tmp",
			requestRender: () => {},
		});

		builder.append([noticeEntry()]);
		const rendered = Bun.stripANSI(builder.container.render(100).join("\n"));

		expect(rendered).toContain("Tool access updated");
		expect(rendered).toContain("+agent_mail");
		expect(rendered).toContain("-bash");
		expect(rendered).not.toContain("system-notice");
	});
});
