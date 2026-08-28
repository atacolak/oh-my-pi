export const HOT_HANDOFF_VERSION = 1 as const;
export const HOT_HANDOFF_CUSTOM_TYPE = "hot-handoff-live-state";
export const HANDOFF_CONTRACT_FILENAME = "HANDOFF.md";
export const MAX_CHANGED_PATHS = 40;
export const MAX_TODOS = 40;
export const MAX_ASYNC_JOBS = 20;
export const MAX_PEERS = 20;

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
}

export interface HotHandoffPreserveData {
	version: typeof HOT_HANDOFF_VERSION;
	authorSelector: string;
	resolvedAuthor: string;
	promptPath: string;
	promptHash: string;
	startedAt: string;
	completedAt?: string;
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
