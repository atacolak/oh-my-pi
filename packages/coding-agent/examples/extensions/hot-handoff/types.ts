export const HOT_HANDOFF_VERSION = 1 as const;
export const HOT_HANDOFF_CUSTOM_TYPE = "hot-handoff-live-state";
export const HANDOFF_CONTRACT_FILENAME = "HANDOFF.md";
export const MAX_CHANGED_PATHS = 40;
export const MAX_TODOS = 40;
export const MAX_ASYNC_JOBS = 20;
export const MAX_PEERS = 20;

/** Conservative per-field caps so one hostile string cannot bloat Snapshot A/B. */
export const LIVE_STATE_FIELD_LIMITS = {
	cwd: 512,
	repoRoot: 512,
	branch: 128,
	head: 64,
	path: 256,
	todoContent: 240,
	todoBlocker: 240,
	jobId: 64,
	jobType: 64,
	jobStatus: 32,
	jobLabel: 120,
	jobAgentId: 64,
	peerId: 64,
	peerDisplayName: 80,
	peerParentId: 64,
	peerActivity: 160,
	error: 240,
} as const;

/** Hard serialized-text budget for a rendered LIVE_STATE capsule (~8–12 KiB). */
export const LIVE_STATE_HARD_BUDGET_BYTES = 10 * 1024;

export const LIVE_STATE_TRUNCATION_MARK = "…[truncated]";

export type HotHandoffTodoStatus = "pending" | "in_progress" | "blocked";

export interface HotHandoffGitState {
	repoRoot?: string;
	branch?: string;
	head?: string;
	dirty: boolean;
	changedPaths: string[];
	truncated?: boolean;
	error?: string;
}

export interface HotHandoffTodo {
	content: string;
	status: HotHandoffTodoStatus;
	blocker?: string;
}

export interface HotHandoffAsyncJob {
	id: string;
	type: string;
	status: string;
	label?: string;
	agentId?: string;
}

export interface HotHandoffPeer {
	id: string;
	displayName?: string;
	parentId?: string;
	status: "running" | "idle";
	activity?: string;
}

export interface HotHandoffLiveState {
	version: typeof HOT_HANDOFF_VERSION;
	capturedAt: string;
	cwd: string;
	git?: HotHandoffGitState;
	todos: HotHandoffTodo[];
	todosTruncated?: boolean;
	asyncJobs: HotHandoffAsyncJob[];
	asyncJobsTruncated?: boolean;
	peers?: HotHandoffPeer[];
	peersTruncated?: boolean;
	errors?: string[];
	budgetTruncated?: boolean;
}

export interface HotHandoffPreserveData {
	version: typeof HOT_HANDOFF_VERSION;
	authorSelector: string;
	resolvedAuthor: string;
	promptPath: string;
	promptHash: string;
	startedAt: string;
}

export interface HotHandoffContract {
	path: string;
	text: string;
	hash: string;
}

export interface HotHandoffActivation {
	cwd: string;
	contract: HotHandoffContract | undefined;
	disabledReason?: "missing" | "empty";
}
