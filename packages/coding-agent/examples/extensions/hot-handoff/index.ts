import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionCompactingResult } from "@oh-my-pi/pi-coding-agent";
import { captureLiveState, LIVE_STATE_RESUME_PREFACE, renderLiveState } from "./live-state";
import { loadHotHandoffActivation, wrapHandoffPrompt } from "./prompt";
import { HOT_HANDOFF_CUSTOM_TYPE, HOT_HANDOFF_VERSION } from "./types";

const HANDOFF_ROLE = "@handoff";

function modelKey(model: { provider: string; id: string } | undefined): string | undefined {
	if (!model) return undefined;
	return `${model.provider}/${model.id}`;
}

function warnOnce(ctx: ExtensionContext, seen: { warned: boolean }, message: string): void {
	if (seen.warned) return;
	seen.warned = true;
	ctx.ui.notify(message, "warning");
}

function currentSessionId(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.getSessionId();
}

export default function hotHandoff(pi: ExtensionAPI): void {
	pi.setLabel("Hot Handoff");

	let pendingLiveStateInjection: { sessionId: string; version: typeof HOT_HANDOFF_VERSION } | undefined;
	const missingAuthorWarning = { warned: false };
	const sameAuthorWarning = { warned: false };
	const emptyContractWarning = { warned: false };

	const clearPending = (): void => {
		pendingLiveStateInjection = undefined;
	};

	pi.on("session.compacting", async (event, ctx): Promise<SessionCompactingResult | undefined> => {
		// Blocking auto-maintenance after a failed/in-flight speculation must
		// stay on stock compaction. Manual /compact and the speculative author
		// still use the independent @handoff model.
		if (event.source === "auto") return undefined;

		const activation = await loadHotHandoffActivation(ctx.cwd);
		if (!activation.contract) {
			if (activation.disabledReason === "empty") {
				warnOnce(
					ctx,
					emptyContractWarning,
					"Hot handoff is disabled: .omp/HANDOFF.md is empty. Using stock compaction.",
				);
			}
			return undefined;
		}

		const current = ctx.models.current();
		const author = ctx.models.resolve(HANDOFF_ROLE);
		if (!author) {
			warnOnce(
				ctx,
				missingAuthorWarning,
				"Hot handoff is disabled: @handoff is missing or unauthenticated. Using stock compaction.",
			);
			return undefined;
		}
		if (modelKey(author) === modelKey(current)) {
			warnOnce(
				ctx,
				sameAuthorWarning,
				"Hot handoff is disabled: @handoff is the active working model. Using stock compaction.",
			);
			return undefined;
		}

		const startedAt = new Date().toISOString();
		const snapshotA = await captureLiveState(ctx);
		const resolvedAuthor = `${author.provider}/${author.id}`;
		return {
			prompt: wrapHandoffPrompt(activation.contract.text),
			context: [renderLiveState(snapshotA)],
			model: resolvedAuthor,
			preserveData: {
				hotHandoff: {
					version: HOT_HANDOFF_VERSION,
					authorSelector: HANDOFF_ROLE,
					resolvedAuthor,
					promptPath: ".omp/HANDOFF.md",
					promptHash: activation.contract.hash,
					startedAt,
				},
			},
		};
	});

	pi.on("session_compact", async (event, ctx) => {
		const preserveData = event.compactionEntry.preserveData as { hotHandoff?: { version?: number } } | undefined;
		const sessionId = currentSessionId(ctx);
		if (preserveData?.hotHandoff?.version === HOT_HANDOFF_VERSION && sessionId) {
			pendingLiveStateInjection = { sessionId, version: HOT_HANDOFF_VERSION };
			return;
		}
		clearPending();
	});

	pi.on("session_switch", async () => {
		clearPending();
	});
	pi.on("session_branch", async () => {
		clearPending();
	});
	pi.on("session_shutdown", async () => {
		clearPending();
	});

	pi.on("context", async (event, ctx) => {
		const pending = pendingLiveStateInjection;
		if (!pending) return undefined;
		const sessionId = currentSessionId(ctx);
		if (!sessionId || pending.sessionId !== sessionId || pending.version !== HOT_HANDOFF_VERSION) {
			clearPending();
			return undefined;
		}
		pendingLiveStateInjection = undefined;
		const snapshotB = await captureLiveState(ctx);
		const capsule = `${LIVE_STATE_RESUME_PREFACE}\n\n${renderLiveState(snapshotB)}`;
		const liveStateMessage: AgentMessage = {
			role: "custom",
			customType: HOT_HANDOFF_CUSTOM_TYPE,
			content: capsule,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		return { messages: [...event.messages, liveStateMessage] };
	});
}
