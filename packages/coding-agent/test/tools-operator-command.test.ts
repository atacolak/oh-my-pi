import { describe, expect, it } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { BUILTIN_SESSION_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-session";
import type { ParsedSlashCommand, SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

interface FakeToolState {
	active: string[];
	available: string[];
	added: string[];
	removed: string[];
	revision: string;
}

interface FakeToolChange {
	add: string[];
	remove: string[];
	expectedRevision: string;
}

const AVAILABLE = ["edit", "glob", "grep", "read"];

function copyState(state: FakeToolState): FakeToolState {
	return {
		active: [...state.active],
		available: [...state.available],
		added: [...state.added],
		removed: [...state.removed],
		revision: state.revision,
	};
}

function createToolSession() {
	const changes: FakeToolChange[] = [];
	let state: FakeToolState = {
		active: ["edit", "glob", "read"],
		available: [...AVAILABLE],
		added: [],
		removed: [],
		revision: "rev-1",
	};
	const session = {
		getActorToolState: () => copyState(state),
		applyActorToolChange: async (change: FakeToolChange) => {
			changes.push({ add: [...change.add], remove: [...change.remove], expectedRevision: change.expectedRevision });
			if (change.expectedRevision !== state.revision) throw new Error("Stale tool selection; inspect tools again");
			const requested = [...change.add, ...change.remove];
			if (requested.some(name => !state.available.includes(name))) {
				throw new Error("Invalid or unavailable tool selection");
			}
			if (change.add.some(name => change.remove.includes(name))) {
				throw new Error("Invalid or unavailable tool selection");
			}
			const granted = change.add.filter(name => !state.active.includes(name));
			const revoked = change.remove.filter(name => state.active.includes(name));
			if (granted.length === 0 && revoked.length === 0) return copyState(state);
			const active = new Set(state.active);
			const added = new Set(state.added);
			const removed = new Set(state.removed);
			for (const name of granted) {
				if (!removed.delete(name)) added.add(name);
				active.add(name);
			}
			for (const name of revoked) {
				if (!added.delete(name)) removed.add(name);
				active.delete(name);
			}
			state = {
				active: [...active].sort(),
				available: [...state.available],
				added: [...added].sort(),
				removed: [...removed].sort(),
				revision: "rev-2",
			};
			return copyState(state);
		},
	};
	return { session, changes, state: () => copyState(state) };
}

function createTuiRuntime(session: ReturnType<typeof createToolSession>["session"]) {
	const status: string[] = [];
	const warnings: string[] = [];
	let listed = 0;
	const ctx = {
		session: session as unknown as AgentSession,
		showStatus: (message: string) => {
			status.push(message);
		},
		showWarning: (message: string) => {
			warnings.push(message);
		},
		handleToolsCommand: () => {
			listed += 1;
		},
		editor: { setText: (_text: string) => {} },
	};
	return { runtime: { ctx: ctx as unknown as InteractiveModeContext }, status, warnings, listed: () => listed };
}

function toolsCommand() {
	const command = BUILTIN_SESSION_SLASH_COMMANDS.find(spec => spec.name === "tools");
	if (!command) throw new Error("/tools command is not registered");
	return command;
}

function runTui(args: string, runtime: ReturnType<typeof createTuiRuntime>["runtime"]): Promise<void> | void {
	const handleTui = toolsCommand().handleTui;
	if (!handleTui) throw new Error("/tools has no TUI handler");
	const call = handleTui as (command: ParsedSlashCommand, runtime: { ctx: InteractiveModeContext }) => Promise<void> | void;
	return call({ name: "tools", args, text: `/tools ${args}`.trim() }, runtime);
}

function runAcp(args: string, output: string[]): Promise<unknown> | unknown {
	const handle = toolsCommand().handle;
	if (!handle) throw new Error("/tools has no text-mode handler");
	const runtime = { output: (text: string) => void output.push(text) } as unknown as SlashCommandRuntime;
	const call = handle as (command: ParsedSlashCommand, runtime: SlashCommandRuntime) => Promise<unknown> | unknown;
	return call({ name: "tools", args, text: `/tools ${args}`.trim() }, runtime);
}

describe("/tools operator changes", () => {
	it("removes a tool from this conversation and reports the applied change", async () => {
		const { session, changes, state } = createToolSession();
		const tui = createTuiRuntime(session);

		await runTui("remove glob", tui.runtime);

		expect(changes).toEqual([{ add: [], remove: ["glob"], expectedRevision: "rev-1" }]);
		expect(tui.status).toEqual(["Removed glob from this conversation. Other sessions are unchanged."]);
		expect(tui.warnings).toEqual([]);
		expect(state().active).toEqual(["edit", "read"]);
		expect(state().removed).toEqual(["glob"]);
		expect(state().added).toEqual([]);
	});

	it("restores a removed tool without replacing other grants", async () => {
		const { session, changes, state } = createToolSession();
		const tui = createTuiRuntime(session);

		await runTui("remove glob", tui.runtime);
		await runTui("add glob", tui.runtime);

		expect(changes.map(change => change.expectedRevision)).toEqual(["rev-1", "rev-2"]);
		expect(tui.status).toEqual([
			"Removed glob from this conversation. Other sessions are unchanged.",
			"Added glob to this conversation. Other sessions are unchanged.",
		]);
		expect(state().active).toEqual(["edit", "glob", "read"]);
		expect(state().added).toEqual([]);
		expect(state().removed).toEqual([]);
	});

	it("reports a tool that is already in the requested state", async () => {
		const { session, changes } = createToolSession();
		const tui = createTuiRuntime(session);

		await runTui("add read", tui.runtime);

		expect(changes).toHaveLength(1);
		expect(tui.status).toEqual(["Already active in this conversation: read."]);
	});

	it("refuses unknown tools without claiming success", async () => {
		const { session, state } = createToolSession();
		const tui = createTuiRuntime(session);

		await runTui("add phantom", tui.runtime);

		expect(tui.status).toEqual([]);
		expect(tui.warnings).toEqual(["Tools unchanged: Invalid or unavailable tool selection"]);
		expect(state().active).toEqual(["edit", "glob", "read"]);
	});

	it("keeps the plain tool list when no subcommand is given", async () => {
		const { session, changes } = createToolSession();
		const tui = createTuiRuntime(session);

		await runTui("", tui.runtime);

		expect(tui.listed()).toBe(1);
		expect(changes).toEqual([]);
	});

	it("refuses programmatic slash execution instead of changing tools", async () => {
		const output: string[] = [];

		await runAcp("add glob", output);

		expect(output.join("\n")).toContain("local operator console");
		expect(output.join("\n")).not.toContain("Added");
	});
});
