import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, prompt, untilAborted, toError } from "@oh-my-pi/pi-utils";
import { isHindsightConfigured, loadHindsightConfig } from "../hindsight/config";
import { formatCurrentTime, formatMemories, mergeRecallTags } from "../hindsight/content";
import recallDescription from "../prompts/tools/recall.md" with { type: "text" };
import { sessionMemoryToolRefs } from "../memory-backend/tool-names";
import type { ToolSession } from ".";

import { cfgMemoryBackend } from "../memory-backend/settings";

const memoryRecallSchema = type({
	query: type("string").describe("natural language search query"),
	"budget?": type("'low' | 'mid' | 'high'").describe(
		"search depth: low = quick lookup, mid = everyday default, high = multi-hop history (omitted = session setting)",
	),
	"maxTokens?": type("number").describe(
		"tokens of surviving memories to return, clamped to 512..16384 (omitted = session setting)",
	),
	"types?": type("('observation' | 'world' | 'experience')[]").describe(
		"restrict results to these memory types (omitted = session setting)",
	),
	"tags?": type("string[]").describe("additional tag filters merged with the session's recall scope"),
});

const RECALL_MAX_TOKENS_MIN = 512;
const RECALL_MAX_TOKENS_MAX = 16384;

/** Per-call return size, clamped into the documented window instead of rejected. */
function clampRecallMaxTokens(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	return Math.min(RECALL_MAX_TOKENS_MAX, Math.max(RECALL_MAX_TOKENS_MIN, Math.round(value)));
}

export type MemoryRecallParams = typeof memoryRecallSchema.infer;

export class MemoryRecallTool implements AgentTool<typeof memoryRecallSchema> {
	readonly name = "recall";
	readonly approval = "read" as const;
	readonly label = "Recall";
	get description(): string {
		return prompt.render(recallDescription, {
			toolRefs: sessionMemoryToolRefs(this.session),
		});
	}
	readonly parameters = memoryRecallSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search memory for relevant prior context";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRecallTool | null {
		const backend = cfgMemoryBackend.get(session.settings);
		if (backend !== "hindsight" && backend !== "mnemopi") return null;
		if (backend === "hindsight" && !isHindsightConfigured(loadHindsightConfig(session.settings))) return null;
		return new MemoryRecallTool(session);
	}

	async execute(_id: string, params: MemoryRecallParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const backend = cfgMemoryBackend.get(this.session.settings);
			if (backend === "mnemopi") {
				const state = this.session.getMnemopiSessionState?.();
				if (!state) {
					throw new Error("Mnemopi backend is not initialised for this session.");
				}
				try {
					const results = await state.recallResultsScoped(params.query);
					if (results.length === 0) {
						return {
							content: [{ type: "text", text: "No relevant memories found." }],
							details: {},
							useless: true,
						};
					}
					const formatted = state.formatScopedRecallWithIds(results);
					return {
						content: [
							{
								type: "text",
								text: `Found ${results.length} relevant ${results.length === 1 ? "memory" : "memories"} (as of ${formatCurrentTime()} UTC):\n\n${formatted}`,
							},
						],
						details: {},
					};
				} catch (err) {
					logger.warn("recall failed", { backend: "mnemopi", bank: state.config.bank, error: String(err) });
					throw toError(err);
				}
			}

			const state = this.session.getHindsightSessionState?.();
			if (!state) {
				throw new Error("Hindsight backend is not initialised for this session.");
			}

			try {
				const response = await state.client.recall(state.bankId, params.query, {
					budget: params.budget ?? state.config.recallBudget,
					maxTokens: clampRecallMaxTokens(params.maxTokens) ?? state.config.recallMaxTokens,
					types: params.types ?? (state.config.recallTypes.length > 0 ? state.config.recallTypes : undefined),
					tags: mergeRecallTags(state.recallTags, params.tags),
					tagsMatch: state.recallTagsMatch,
				});
				let results = response.results ?? [];
				if (results.length === 1 && !(await state.keepLoneRecallSurvivor(params.query, results[0]!.text, signal))) {
					results = [];
				}
				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No relevant memories found." }],
						details: {},
						useless: true,
					};
				}
				const formatted = formatMemories(results);
				return {
					content: [
						{
							type: "text",
							text: `Found ${results.length} relevant ${results.length === 1 ? "memory" : "memories"} (as of ${formatCurrentTime()} UTC):\n\n${formatted}`,
						},
					],
					details: {},
				};
			} catch (err) {
				logger.warn("recall failed", { bankId: state.bankId, error: String(err) });
				throw toError(err);
			}
		});
	}
}
