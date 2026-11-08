import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { Component } from "@oh-my-pi/pi-tui";
import { RecapNotice } from "@oh-my-pi/pi-tui/chat/recap-notice";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;
beforeEach(async () => {
	settingsState = beginSettingsTest();
	await initTheme();
	await Settings.init({ inMemory: true });
});
afterEach(() => {
	vi.restoreAllMocks();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

describe("EventController idle recap presentation", () => {
	it("sanitizes control characters and keeps the recap's own line structure", () => {
		const present = vi.fn<(content: Component | readonly Component[]) => void>();
		const controller = new EventController(createInteractiveModeContext({ present }));
		try {
			controller.presentIdleRecap("\n\x1b[31mWhere\tthings\nstand\x07;  next step\n\n");
			const notices = present.mock.calls
				.flatMap(([content]) => (Array.isArray(content) ? content : [content]))
				.filter((content): content is RecapNotice => content instanceof RecapNotice);
			expect(notices).toHaveLength(1);
			const rendered = Bun.stripANSI(notices[0].render(200).join("\n"));
			expect(rendered).toContain("Where");
			expect(rendered).toContain("stand;  next step");
			expect(rendered).not.toContain("\x07");
			expect(rendered).not.toContain("\x1b");
		} finally {
			controller.dispose();
		}
	});

	it("keeps a long recap intact instead of truncating it", () => {
		// The recap is a retrieval anchor: a cut mid-word loses the path/SHA the
		// reader needs. RecapNotice wraps to terminal width, so no chop is needed.
		const reply = `${"a word ".repeat(70)}next: ratify chapter-grouped episodes FINAL-ANCHOR`;
		const present = vi.fn<(content: Component | readonly Component[]) => void>();
		const controller = new EventController(createInteractiveModeContext({ present }));
		try {
			controller.presentIdleRecap(reply);
			const notices = present.mock.calls
				.flatMap(([content]) => (Array.isArray(content) ? content : [content]))
				.filter((content): content is RecapNotice => content instanceof RecapNotice);
			expect(notices).toHaveLength(1);
			const rendered = Bun.stripANSI(notices[0].render(200).join("\n"));
			expect(rendered).toContain("FINAL-ANCHOR");
			expect(rendered).not.toContain("…");
		} finally {
			controller.dispose();
		}
	});

	it("does not mount a blank recap notice", () => {
		const present = vi.fn();
		const controller = new EventController(createInteractiveModeContext({ present }));
		try {
			controller.presentIdleRecap("\n \t");
			expect(present).not.toHaveBeenCalled();
		} finally {
			controller.dispose();
		}
	});
});
