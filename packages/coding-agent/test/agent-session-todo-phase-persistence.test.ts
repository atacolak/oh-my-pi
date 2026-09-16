import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	committedTodoPhases,
	TodoTool,
	USER_TODO_EDIT_CUSTOM_TYPE,
	type TodoPhase,
	type ToolSession,
} from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * The brief's durability claim: a passive phase survives compaction, resume,
 * and recycle. Tasks 1-3 prove the pieces (the kind is persisted, replayed from
 * the branch, and restored by the clone). This file proves the whole trip
 * through a real session file: a real TodoTool commits a passive phase, the
 * committed snapshot is written into a real session directory, and a fresh
 * AgentSession reopened on that file — the headless resume path, whose
 * constructor rehydrates todo state from the branch — still sees the kind and
 * the statuses the tool committed.
 */

const PASSIVE_PHASE = "Context";

const PERSISTED_PHASES: TodoPhase[] = [
	{ name: PASSIVE_PHASE, kind: "passive", tasks: [{ content: "Keep visible", status: "pending" }] },
	{ name: "Work", tasks: [{ content: "Do next", status: "in_progress" }] },
];

const authStorage = createInMemoryAuthStorage();
authStorage.setRuntimeApiKey("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage);

describe("passive todo phase durability across a session restart", () => {
	let tempDir: TempDir;
	let sessionDir: string;
	let sessionFile: string;
	let sessionManager: SessionManager;
	let session: AgentSession;
	const openSessions: AgentSession[] = [];
	const openManagers: SessionManager[] = [];

	function buildSession(manager: SessionManager): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const created = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": true, "todo.reminders": false }),
			modelRegistry,
		});
		openSessions.push(created);
		return created;
	}

	/** The branch write every producer of a todo snapshot shares. */
	function persistCommitted(phases: TodoPhase[]): void {
		sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
	}

	/** The real bridge a headless todo call runs behind: live session state plus branch persistence. */
	function todoBridge(): ToolSession {
		return {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			settings: session.settings,
			getTodoPhases: () => session.getTodoPhases(),
			setTodoPhases: phases => session.setTodoPhases(phases),
			persistTodoPhases: persistCommitted,
		};
	}

	/** Close the writing session and reopen the file the way a restarted process would. */
	async function restart(): Promise<AgentSession> {
		// A fresh session file is written lazily: nothing reaches disk until the
		// journal is materialized, so a pending entry alone would reopen as empty.
		await sessionManager.ensureOnDisk();
		sessionManager.flushSync();
		await session.dispose();
		const manager = await SessionManager.open(sessionFile, sessionDir);
		openManagers.push(manager);
		return buildSession(manager);
	}

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-todo-phase-restart-");
		sessionDir = path.join(tempDir.path(), "sessions");
		sessionManager = SessionManager.create(tempDir.path(), sessionDir);
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("Expected a persisted session file path");
		sessionFile = file;
		session = buildSession(sessionManager);
	});

	afterEach(async () => {
		for (const manager of openManagers.splice(0)) {
			try {
				await manager.close();
			} catch {}
		}
		for (const created of openSessions.splice(0)) {
			try {
				await created.dispose();
			} catch {}
		}
		try {
			await tempDir.remove();
		} catch {}
	});

	it("keeps a passive phase kind and its task statuses after reopening the session file", async () => {
		const tool = new TodoTool(todoBridge());
		const result = await tool.execute("init", {
			op: "init",
			list: [
				{ phase: PASSIVE_PHASE, kind: "passive", items: ["Keep visible"] },
				{ phase: "Work", items: ["Do next"] },
			],
		});
		expect(session.getTodoPhases()).toEqual(PERSISTED_PHASES);

		// Exactly what the eval bridge does for a call that emits no toolResult:
		// take the committed snapshot off the result and put it on the branch.
		const committed = committedTodoPhases(result);
		expect(committed).toEqual(PERSISTED_PHASES);
		if (!committed) throw new Error("Expected the tool to commit phases");
		persistCommitted(committed);

		const resumed = await restart();

		const reloaded = resumed.getTodoPhases();
		expect(reloaded).toEqual(PERSISTED_PHASES);
		expect(reloaded[0]).toMatchObject({ name: PASSIVE_PHASE, kind: "passive" });
		expect(reloaded[0]?.tasks[0]?.status).toBe("pending");
		expect(reloaded[1]?.kind).toBeUndefined();
		expect(reloaded[1]?.tasks[0]?.status).toBe("in_progress");
	});

	it("reloads the file rather than leftover in-memory state", async () => {
		// No branch entry at all: the list lives only in this process, so a
		// restarted session must not resurrect it.
		session.setTodoPhases(PERSISTED_PHASES);

		const resumed = await restart();

		expect(resumed.getTodoPhases()).toEqual([]);
	});

	it("does not invent a kind for a persisted phase that has none", async () => {
		// Absent kind means "continuing". Nothing about a phase name may imply passive.
		persistCommitted([{ name: PASSIVE_PHASE, tasks: [{ content: "Keep visible", status: "pending" }] }]);

		const resumed = await restart();

		const reloaded = resumed.getTodoPhases();
		expect(reloaded).toEqual([{ name: PASSIVE_PHASE, tasks: [{ content: "Keep visible", status: "pending" }] }]);
		expect(reloaded[0]?.kind).toBeUndefined();
	});
});

afterAll(() => {
	authStorage.close();
});
