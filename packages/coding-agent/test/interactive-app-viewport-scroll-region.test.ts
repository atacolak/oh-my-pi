/**
 * Contract: the `--alt` app viewport keeps only the compact reply/composer band
 * pinned. The HUD roots below the transcript (todos, subagents, deferred shell
 * runs, reports) are the tail of the scrollable transcript, so a todo block
 * cannot shrink the transcript window and scrolling up carries it off screen
 * while the composer band stays put.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const ROWS = 26;
const COLUMNS = 100;
const WHEEL_UP = "\x1b[<64;1;1M";
const TRANSCRIPT_ROWS = Array.from({ length: 40 }, (_value, index) => `msg-${index}`);
const TODO_ITEMS = Array.from({ length: 6 }, (_value, index) => `todo-${index}`);
const DRAFT_FIRST = Array.from({ length: 4 }, (_value, index) => `draft-${index}`);
const DRAFT_TYPED = Array.from({ length: 6 }, (_value, index) => `draft-${index}`);

interface Projection {
	transcript: number;
	todos: number;
	drafts: number;
}

function project(term: VirtualTerminal): Projection {
	const rows = term.getViewport().map(row => Bun.stripANSI(row).trim());
	return {
		transcript: rows.filter(row => row.includes("msg-")).length,
		todos: rows.filter(row => row.includes("todo-")).length,
		drafts: rows.filter(row => row.includes("draft-")).length,
	};
}

describe("app viewport scroll region", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;
	let previousBackend: string | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		previousBackend = Bun.env.PI_TUI_RENDER_BACKEND;
		Bun.env.PI_TUI_RENDER_BACKEND = "app-viewport";
		tempDir = TempDir.createSync("@pi-app-viewport-region-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		term = new VirtualTerminal(COLUMNS, ROWS);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, composer);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
		if (previousBackend === undefined) delete Bun.env.PI_TUI_RENDER_BACKEND;
		else Bun.env.PI_TUI_RENDER_BACKEND = previousBackend;
	});

	it("scrolls the todo block off screen instead of pinning it over the transcript", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		mode.chatContainer.addChild({ render: () => TRANSCRIPT_ROWS });
		mode.setTodos([{ name: "Plan", tasks: TODO_ITEMS.map(content => ({ content, status: "pending" as const })) }]);
		mode.editor.setText(DRAFT_FIRST.join("\n"));
		mode.ui.requestRender();
		await term.waitForRender(() => project(term).todos === TODO_ITEMS.length);

		const bottom = project(term);
		expect(bottom.todos).toBe(TODO_ITEMS.length);
		expect(bottom.drafts).toBe(DRAFT_FIRST.length);

		let scrolled = bottom;
		for (let step = 0; step < 8 && scrolled.todos > 0; step++) {
			term.sendInput(WHEEL_UP);
			await term.waitForRender();
			scrolled = project(term);
		}
		expect(scrolled.todos).toBe(0);
		expect(scrolled.transcript).toBeGreaterThanOrEqual(12);
		expect(scrolled.drafts).toBe(DRAFT_FIRST.length);

		mode.editor.setText(DRAFT_TYPED.join("\n"));
		mode.ui.requestRender();
		await term.waitForRender(() => project(term).drafts === DRAFT_TYPED.length);
		const typed = project(term);
		expect(typed.todos).toBe(0);
		expect(typed.transcript).toBeGreaterThanOrEqual(10);
		expect(typed.drafts).toBe(DRAFT_TYPED.length);
	});
});
