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

export default function hotHandoff(pi: ExtensionAPI): void {
	pi.setLabel("Hot Handoff");

	let pendingLiveStateInjection = false;
	const missingAuthorWarning = { warned: false };
	const sameAuthorWarning = { warned: false };
	const emptyContractWarning = { warned: false };

	pi.on("session.compacting", async (_event, ctx): Promise<SessionCompactingResult | undefined> => {
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
					completedAt: new Date().toISOString(),
				},
			},
		};
	});

	pi.on("session_compact", async event => {
		const preserveData = event.compactionEntry.preserveData as { hotHandoff?: { version?: number } } | undefined;
		if (preserveData?.hotHandoff?.version === HOT_HANDOFF_VERSION) {
			pendingLiveStateInjection = true;
		}
	});

	pi.on("context", async (event, ctx) => {
		if (!pendingLiveStateInjection) return undefined;
		pendingLiveStateInjection = false;
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
