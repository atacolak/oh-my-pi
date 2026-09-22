import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
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
 * and recycle. `agent-session-todo-phase-persistence.test.ts` proves resume
 * end-to-end. This file proves compaction: a real mid-run threshold compaction
 * rewrites the conversation, and the pass that follows it —
 * `session-maintenance.ts` -> `syncTodoPhasesFromBranch` ->
 * `getLatestTodoPhasesFromEntries` -> `clonePhases` — must re-derive the live
 * tracker from the branch, keeping each phase's optional `kind`.
 *
 * The tracker is left deliberately one snapshot behind the branch (the seam has
 * more than one producer and the branch is the durable source), and the
 * mocked `compact()` records the tracker state it saw on entry. Together those
 * pin the reload below as compaction's own work rather than leftover memory:
 * dropping the post-compaction `syncTodoPhasesFromBranch()` call, or the
 * kind-carrying clone clause it runs through, fails this test.
 */

const PASSIVE_PHASE = "Reference";

/** What the real todo tool commits, and what the branch holds when the run starts. */
const TOOL_COMMITTED: TodoPhase[] = [
	{ name: PASSIVE_PHASE, kind: "passive", tasks: [{ content: "Retain report", status: "pending" }] },
	{ name: "Execution", tasks: [{ content: "Ship change", status: "in_progress" }] },
];

/** A newer snapshot a second producer commits through the same seam. */
const BRANCH_LATEST: TodoPhase[] = [
	{ name: PASSIVE_PHASE, kind: "passive", tasks: [{ content: "Retain report", status: "in_progress" }] },
	{ name: "Execution", tasks: [{ content: "Ship change", status: "completed" }] },
];

const authStorage = createInMemoryAuthStorage();
authStorage.setRuntimeApiKey("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage);

afterAll(() => {
	authStorage.close();
});

describe("passive todo phase durability across mid-run compaction", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let observedContexts: string[][];
	let phasesAtCompaction: TodoPhase[] | undefined;
	const cleanups: Array<() => Promise<void>> = [];

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

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-todo-phase-compaction-");
		observedContexts = [];
		phasesAtCompaction = undefined;
		cleanups.length = 0;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.methodOrder": ["soft"],
			"compaction.autoContinue": true,
			"compaction.midTurnEnabled": true,
			"compaction.thresholdTokens": 1000,
			"compaction.thresholdPercent": -1,
			// History-rewriting prune passes share the post-rewrite todo resync;
			// keep them off so the state sampled inside `compact()` is unambiguous.
			"compaction.supersedeReads": false,
			"compaction.dropUseless": false,
			"contextPromotion.enabled": false,
			"todo.enabled": true,
			"todo.reminders": false,
		});
		sessionManager = SessionManager.inMemory(tempDir.path());

		const mockBashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "tool output" }] }),
		};

		let call = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [mockBashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				const index = call++;
				observedContexts.push(context.messages.map(message => JSON.stringify(message)));
				const stream = new AssistantMessageEventStream();
				const message =
					index === 0
						? {
								role: "assistant" as const,
								content: [
									{ type: "toolCall" as const, id: `tc-${index}`, name: "bash", arguments: { cmd: "pwd" } },
								],
								api: "anthropic-messages" as const,
								provider: "anthropic" as const,
								model: "claude-sonnet-4-5",
								usage: highUsage(50_000),
								stopReason: "toolUse" as const,
								timestamp: Date.now(),
							}
						: {
								role: "assistant" as const,
								content: [{ type: "text" as const, text: "All done." }],
								api: "anthropic-messages" as const,
								provider: "anthropic" as const,
								model: "claude-sonnet-4-5",
								usage: highUsage(200),
								stopReason: "stop" as const,
								timestamp: Date.now(),
							};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason, message });
				});
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[mockBashTool.name, mockBashTool]]),
		});
		cleanups.push(() => session.dispose());
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) await cleanup();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function highUsage(input: number) {
		return {
			input,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	/** Spy on `compact()` so the pass runs without an LLM call, and record the tracker state it saw. */
	function mockCompaction(summary: string) {
		return vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			phasesAtCompaction = session.getTodoPhases();
			return {
				summary,
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});
	}

	it("re-derives a passive phase's kind and task statuses from the branch after compacting mid-run", async () => {
		const tool = new TodoTool(todoBridge());
		const result = await tool.execute("init", {
			op: "init",
			list: [
				{ phase: PASSIVE_PHASE, kind: "passive", items: ["Retain report"] },
				{ phase: "Execution", items: ["Ship change"] },
			],
		});
		const committed = committedTodoPhases(result);
		expect(committed).toEqual(TOOL_COMMITTED);
		if (!committed) throw new Error("Expected the tool to commit phases");
		persistCommitted(committed);

		// A second producer advances the snapshot on the branch. The live tracker
		// is now behind it, which is exactly the state compaction must repair.
		persistCommitted(BRANCH_LATEST);
		expect(session.getTodoPhases()).toEqual(TOOL_COMMITTED);

		const compactSpy = mockCompaction("MID-RUN-COMPACTED");
		await session.prompt("work on the release");

		// The run really compacted mid-turn...
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts.length).toBeGreaterThanOrEqual(2);
		expect(observedContexts[1].join("\n")).toContain("MID-RUN-COMPACTED");

		// ...and the tracker was still behind the branch when compaction started,
		// so what follows is the post-compaction reload, not leftover memory.
		expect(phasesAtCompaction).toEqual(TOOL_COMMITTED);

		const reloaded = session.getTodoPhases();
		expect(reloaded).toEqual(BRANCH_LATEST);
		expect(reloaded[0]).toMatchObject({ name: PASSIVE_PHASE, kind: "passive" });
		expect(reloaded[0]?.tasks[0]?.status).toBe("in_progress");
		expect(reloaded[1]?.kind).toBeUndefined();
		expect(reloaded[1]?.tasks[0]?.status).toBe("completed");
	});
});
