import { describe, expect, it } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { captureLiveState, renderLiveState } from "../examples/extensions/hot-handoff/live-state";
import { MAX_CHANGED_PATHS, MAX_TODOS } from "../examples/extensions/hot-handoff/types";

function makeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		cwd: "/tmp/hot-handoff",
		sessionManager: {
			getBranch: () => [],
		},
		getAsyncJobSnapshot: () => null,
		getAgentSnapshot: () => ({ agents: [] }),
		...overrides,
	} as ExtensionContext;
}

describe("hot handoff live state", () => {
	it("records a field-local git error instead of failing", async () => {
		const state = await captureLiveState(makeCtx({ cwd: "/tmp/definitely-not-a-repo-hot-handoff" }));
		expect(state.git?.error).toBeDefined();
		expect(state.todos).toEqual([]);
		expect(state.asyncJobs).toEqual([]);
	});

	it("includes only open todos from the latest transcript phases", async () => {
		const ctx = makeCtx({
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						id: "t1",
						parentId: null,
						timestamp: "2026-08-28T00:00:00.000Z",
						message: {
							role: "toolResult",
							toolName: "todo",
							isError: false,
							details: {
								phases: [
									{
										name: "Work",
										tasks: [
											{ content: "open parser", status: "in_progress" },
											{ content: "blocked fixture", status: "blocked", blocker: "waiting on worker" },
											{ content: "done already", status: "completed" },
											{ content: "dropped", status: "abandoned" },
										],
									},
								],
							},
						},
					},
				],
			},
		} as never);
		const state = await captureLiveState(ctx);
		expect(state.todos).toEqual([
			{ content: "open parser", status: "in_progress" },
			{ content: "blocked fixture", status: "blocked", blocker: "waiting on worker" },
		]);
	});

	it("includes running async jobs and running/idle peers", async () => {
		const ctx = makeCtx({
			getAsyncJobSnapshot: () => ({
				running: [
					{ id: "job-1", type: "task", status: "running", label: "investigate", startTime: 1, agentId: "a3f7" },
				],
				recent: [{ id: "job-old", type: "bash", status: "completed", startTime: 0 }],
				delivery: { queued: 0, delivering: false, pendingJobIds: [] },
			}),
			getAgentSnapshot: () => ({
				selfId: "Main",
				agents: [
					{ id: "Main", displayName: "Main", kind: "main", status: "running" },
					{
						id: "a3f7",
						displayName: "parser",
						kind: "sub",
						parentId: "Main",
						status: "running",
						activity: "investigate",
					},
					{ id: "b821", displayName: "idle-peer", kind: "sub", parentId: "Main", status: "idle" },
				],
			}),
		} as never);
		const state = await captureLiveState(ctx);
		expect(state.asyncJobs).toEqual([
			{ id: "job-1", type: "task", status: "running", label: "investigate", agentId: "a3f7" },
		]);
		expect(state.peers?.map(peer => peer.id)).toEqual(["a3f7", "b821"]);
	});

	it("bounds arrays and marks truncation", () => {
		const rendered = renderLiveState({
			version: 1,
			capturedAt: "2026-08-28T00:00:00.000Z",
			cwd: "/tmp",
			git: {
				dirty: true,
				changedPaths: Array.from({ length: MAX_CHANGED_PATHS }, (_, i) => `file-${i}.ts`),
				truncated: true,
			},
			todos: Array.from({ length: MAX_TODOS }, (_, i) => ({ content: `todo-${i}`, status: "pending" })),
			todosTruncated: true,
			asyncJobs: [],
		});
		expect(rendered).toContain("truncated: true");
		expect(rendered).toContain("<LIVE_STATE");
		expect(rendered).not.toContain("diff --git");
	});
});
