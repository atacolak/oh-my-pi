import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import {
	HOT_HANDOFF_VERSION,
	type HotHandoffLiveState,
	type HotHandoffTodo,
	MAX_ASYNC_JOBS,
	MAX_CHANGED_PATHS,
	MAX_PEERS,
	MAX_TODOS,
} from "./types";

function truncateList<T>(items: T[], max: number): { items: T[]; truncated: boolean } {
	if (items.length <= max) return { items, truncated: false };
	return { items: items.slice(0, max), truncated: true };
}

function openTodosFromContext(ctx: ExtensionContext): { items: HotHandoffTodo[]; truncated: boolean } {
	const phases = getLatestTodoPhasesFromEntries(ctx.sessionManager.getBranch());
	const open: HotHandoffTodo[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "blocked") continue;
			open.push({
				content: task.content,
				status: task.status,
				blocker: task.status === "blocked" ? task.blocker : undefined,
			});
		}
	}
	return truncateList(open, MAX_TODOS);
}

async function captureGit(cwd: string): Promise<HotHandoffLiveState["git"]> {
	try {
		const repo = vcs.repo(cwd);
		if (!repo) {
			return { dirty: false, changedPaths: [], error: "not a repository" };
		}
		const [label, headId, changedPaths] = await Promise.all([
			repo.label().catch(() => undefined),
			repo.headId().catch(() => undefined),
			repo.changedFiles({}).catch(() => undefined),
		]);
		const paths = changedPaths ?? [];
		const truncated = paths.length > MAX_CHANGED_PATHS;
		return {
			repoRoot: repo.root(),
			branch: label ?? undefined,
			head: headId ?? undefined,
			dirty: paths.length > 0,
			changedPaths: truncated ? paths.slice(0, MAX_CHANGED_PATHS) : paths,
			truncated: truncated || undefined,
		};
	} catch (err) {
		return {
			dirty: false,
			changedPaths: [],
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function captureLiveState(ctx: ExtensionContext): Promise<HotHandoffLiveState> {
	const errors: string[] = [];
	const git = await captureGit(ctx.cwd);
	if (git?.error) errors.push(`git: ${git.error}`);

	const { items: todos, truncated: todosTruncated } = openTodosFromContext(ctx);

	const jobSnapshot = ctx.getAsyncJobSnapshot();
	const runningJobs = (jobSnapshot?.running ?? []).map(job => ({
		id: job.id,
		type: job.type,
		status: job.status,
		label: job.label,
		agentId: job.agentId,
	}));
	const jobs = truncateList(runningJobs, MAX_ASYNC_JOBS);

	const peerSnapshot = ctx.getAgentSnapshot?.() ?? { agents: [] };
	const peers = truncateList(
		(peerSnapshot.agents ?? [])
			.filter(agent => agent.id !== peerSnapshot.selfId)
			.map(agent => ({
				id: agent.id,
				displayName: agent.displayName,
				parentId: agent.parentId,
				status: agent.status,
				activity: agent.activity,
			})),
		MAX_PEERS,
	);

	return {
		version: HOT_HANDOFF_VERSION,
		capturedAt: new Date().toISOString(),
		cwd: ctx.cwd,
		git,
		todos: todos,
		todosTruncated: todosTruncated || undefined,
		asyncJobs: jobs.items,
		asyncJobsTruncated: jobs.truncated || undefined,
		peers: peers.items,
		peersTruncated: peers.truncated || undefined,
		errors: errors.length > 0 ? errors : undefined,
	};
}

export function renderLiveState(state: HotHandoffLiveState): string {
	const lines: string[] = [];
	lines.push(`<LIVE_STATE version="${state.version}" captured_at="${state.capturedAt}">`);
	lines.push("workspace:");
	lines.push(`  cwd: ${state.cwd}`);
	if (state.git) {
		lines.push("git:");
		if (state.git.error) {
			lines.push(`  unavailable: ${state.git.error}`);
		} else {
			if (state.git.repoRoot) lines.push(`  repoRoot: ${state.git.repoRoot}`);
			if (state.git.branch) lines.push(`  branch: ${state.git.branch}`);
			if (state.git.head) lines.push(`  head: ${state.git.head}`);
			lines.push(`  dirty: ${state.git.dirty}`);
			lines.push("  changed:");
			const changed = state.git.changedPaths.map(path => path);
			if (changed.length === 0) {
				lines.push("    []");
			} else {
				for (const path of changed) lines.push(`    - ${path}`);
			}
			if (state.git.truncated) {
				lines.push(`  truncated: true`);
			}
		}
	}
	lines.push("todos:");
	if (state.todos.length === 0) {
		lines.push("  []");
	} else {
		for (const todo of state.todos) {
			const blocker = todo.blocker ? ` reason: ${todo.blocker}` : "";
			lines.push(`  - ${todo.status}: ${todo.content}${blocker}`);
		}
	}
	if (state.todosTruncated) lines.push("  truncated: true");
	lines.push("async_jobs:");
	if (state.asyncJobs.length === 0) {
		lines.push("  []");
	} else {
		for (const job of state.asyncJobs) {
			const label = job.label ? ` label: ${job.label}` : "";
			const agent = job.agentId ? ` agent: ${job.agentId}` : "";
			lines.push(`  - id: ${job.id} type: ${job.type} status: ${job.status}${label}${agent}`);
		}
	}
	if (state.asyncJobsTruncated) lines.push("  truncated: true");
	if (state.peers) {
		lines.push("peers:");
		if (state.peers.length === 0) {
			lines.push("  []");
		} else {
			for (const peer of state.peers) {
				const activity = peer.activity ? ` activity: ${peer.activity}` : "";
				const parent = peer.parentId ? ` parent: ${peer.parentId}` : "";
				lines.push(`  - id: ${peer.id} status: ${peer.status}${parent}${activity}`);
			}
		}
		if (state.peersTruncated) lines.push("  truncated: true");
	}
	if (state.errors && state.errors.length > 0) {
		lines.push("errors:");
		for (const error of state.errors) lines.push(`  - ${error}`);
	}
	lines.push("</LIVE_STATE>");
	return lines.join("\n");
}

export const LIVE_STATE_RESUME_PREFACE = `This LIVE_STATE block was generated mechanically immediately before
this request. It is authoritative for volatile runtime state.
If it conflicts with older handoff prose about jobs/todos/peers/git
state, prefer LIVE_STATE.`;
