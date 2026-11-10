import * as fs from "node:fs/promises";
import { type AsyncJob, AsyncJobManager } from "../../async/job-manager";
import { readRuntimeBootIdentity } from "../../launch/runtime-generation";
import { systemPromptDigest } from "../../session/session-tools";
import type { AgentSession } from "../../session/agent-session";
import type { RpcRefreshPreflight, RpcRuntimeRestartReceipt } from "./rpc-types";

const MAX_PREFLIGHT_TOOL_NAMES = 200;

/** Only explicit observations qualify; detached broker services are outside this boundary. */
export function isGracefulRestartSettled(preflight: RpcRefreshPreflight): boolean {
	const work = preflight.ephemeralWork;
	return (
		work.streaming === false &&
		work.admittedSubmission === false &&
		work.compacting === false &&
		work.inFlightTools === 0 &&
		work.taskSubagents === 0 &&
		work.backgroundJobs === 0
	);
}

/** Outstanding results of one restart request survive retention and job-id reuse. */
export class GracefulRestartResults {
	readonly #pending = new Set<AsyncJob>();
	readonly #session: AgentSession;
	readonly #manager: AsyncJobManager | undefined;
	readonly #unsubscribe: (() => void) | undefined;
	#known = false;

	constructor(session: AgentSession) {
		this.#session = session;
		this.#manager = session.asyncJobManager instanceof AsyncJobManager ? session.asyncJobManager : undefined;
		this.#unsubscribe = this.#manager?.onJobSettled(() => this.#capture());
		this.#capture();
	}

	#capture(): void {
		const tree = this.#session.getAsyncJobTree({ recentLimit: Number.POSITIVE_INFINITY });
		this.#known = this.#manager !== undefined && tree !== null;
		if (!this.#manager || !tree) return;
		for (const item of [...tree.running, ...tree.recent]) {
			const job = this.#manager.getJob(item.id);
			if (!job) {
				this.#known = false;
			} else if (!this.#manager.isJobResultConsumed(job.id, job)) {
				this.#pending.add(job);
			}
		}
	}

	areConsumed(): boolean {
		this.#capture();
		if (!this.#known || !this.#manager) return false;
		for (const job of this.#pending) {
			if (this.#manager.isJobResultConsumed(job.id, job)) this.#pending.delete(job);
		}
		return this.#pending.size === 0;
	}

	dispose(): void {
		this.#unsubscribe?.();
		this.#pending.clear();
	}
}

/** Observation only: never schedules an upgrade, starts a broker, or sends agent input. */
export function getRpcRefreshPreflight(session: AgentSession): RpcRefreshPreflight {
	const jobs = session.getAsyncJobTree({ recentLimit: 0 });
	const inFlightTools = session.agent.state.pendingToolCalls?.size ?? null;
	const taskSubagents = jobs ? jobs.running.filter(job => job.type === "task").length : null;
	const backgroundJobs = jobs ? jobs.running.filter(job => job.type !== "task").length : null;
	const counts = [inFlightTools, taskSubagents, backgroundJobs];
	const streaming = session.isStreaming;
	const admittedSubmission = session.hasAdmittedSubmission;
	const compacting = session.isCompacting;
	const knownActive =
		streaming || admittedSubmission || compacting || counts.some(count => count !== null && count > 0);
	const tools = session.agent.state.tools;
	return {
		sessionId: session.sessionId,
		sessionFile: session.sessionFile ?? null,
		ephemeralWork: {
			streaming,
			admittedSubmission,
			compacting,
			inFlightTools,
			taskSubagents,
			backgroundJobs,
			// Broker list can settle/restart services. Until a passive seam exists, do not query it.
			services: null,
			servicesUninspected: true,
			// Partial sources can prove work, but cannot establish tree-wide idle.
			hasEphemeralWork: knownActive ? true : null,
		},
		primaryPromptTools: {
			names: tools.slice(0, MAX_PREFLIGHT_TOOL_NAMES).map(tool => tool.name),
			total: tools.length,
			truncated: tools.length > MAX_PREFLIGHT_TOOL_NAMES,
		},
		refreshModes: { graceful: false, force: false },
	};
}

/** Read the loaded owner's identity, not the generation selected for a future restart. */
export async function getRpcRuntimeRestartReceipt(session: AgentSession): Promise<RpcRuntimeRestartReceipt | null> {
	const sessionId = session.sessionId;
	const file = session.sessionFile;
	if (!file || !session.sessionManager.hasSessionOwnership() || !Array.isArray(session.baseSystemPrompt)) return null;
	let sessionFile: string;
	try {
		sessionFile = await fs.realpath(file);
	} catch {
		return null;
	}
	if (session.sessionId !== sessionId || session.sessionFile !== file || !session.sessionManager.hasSessionOwnership())
		return null;
	return {
		sessionId,
		sessionFile,
		...readRuntimeBootIdentity(),
		basePromptDigest: systemPromptDigest(session.baseSystemPrompt),
	};
}
