import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, prompt, untilAborted, toError } from "@oh-my-pi/pi-utils";
import type { RecallResult } from "../hindsight/client";
import { RECALL_SCORE_FLOOR, RECALL_SCORE_FLOOR_RATIO } from "../hindsight/client";
import { isHindsightConfigured, loadHindsightConfig } from "../hindsight/config";
import { formatCurrentTime, formatMemories, mergeRecallTags } from "../hindsight/content";
import type { HindsightSessionState } from "../hindsight/state";
import { describeRecallCoverage, recallCoverageHeader } from "../hindsight/recall-coverage";
import {
	GEAR_SWEEP_CAPS,
	packByTokens,
	type RecallGear,
	resolveSweepCollections,
	sweepBankMemories,
} from "../hindsight/sweep";
import recallDescription from "../prompts/tools/recall.md" with { type: "text" };
import { sessionMemoryToolRefs } from "../memory-backend/tool-names";
import type { ToolSession } from ".";

import { cfgMemoryBackend } from "../memory-backend/settings";

const memoryRecallSchema = type({
	query: type("string").describe("natural language search query"),
	"budget?": type("'low' | 'mid' | 'high' | 'xhigh' | 'max'").describe(
		"recall depth: low = one known fact, mid = everyday context, high = connected history, xhigh = broad sweep, max = largest bounded sweep; oversized scopes use ranked shortlists (omitted = session setting)",
	),
	"maxTokens?": type("number").describe(
		"tokens of surviving memories to return, clamped to 512..16384 (omitted = session setting)",
	),
	"types?": type("('observation' | 'world' | 'experience')[]").describe(
		"restrict results to these memory types (omitted = session setting)",
	),
	"tags?": type("string[]").describe(
		"stay in the default project scope; use project:<id> only for a question explicitly about that repository; area and memory_shape add filters; the hard scope boundary remains",
	),
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
				const gear = params.budget ?? state.config.recallBudget;
				const maxTokens = clampRecallMaxTokens(params.maxTokens) ?? state.config.recallMaxTokens;
				const tags = mergeRecallTags(state.recallTags, params.tags);
				const collections = resolveSweepCollections(params.types, state.config);
				let totalAvailable: number | null = null;
				if (state.recallScorer || gear === "max") {
					const sweep = await sweepBankMemories(
						state.client,
						state.bankId,
						collections,
						tags,
						state.recallTagsMatch,
						{ ceiling: GEAR_SWEEP_CAPS[gear], bailOnOverflow: true },
						signal,
					);
					totalAvailable = sweep.totalAvailableExact ? sweep.totalAvailable : null;
					if (!sweep.truncated) {
						return this.#packCandidates(
							state,
							params.query,
							sweep.candidates,
							{ maxTokens, swept: true, gear, tags, totalAvailable },
							signal,
						);
					}
				}
				if (gear === "xhigh" || gear === "max") {
					const candidates = await this.#tracedCandidates(state, params, gear, tags, signal);
					return this.#packCandidates(
						state,
						params.query,
						candidates,
						{ maxTokens, swept: false, gear, tags, totalAvailable },
						signal,
					);
				}
				return await this.#rankedRecall(state, params, gear, maxTokens, tags, totalAvailable, signal);
			} catch (err) {
				logger.warn("recall failed", { bankId: state.bankId, error: String(err) });
				throw toError(err);
			}
		});
	}

	/** Server-ranked recall for a gear whose scope the sweep could not fit under its cap. */
	async #rankedRecall(
		state: HindsightSessionState,
		params: MemoryRecallParams,
		gear: "low" | "mid" | "high",
		maxTokens: number,
		tags: string[] | undefined,
		totalAvailable: number | null,
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		const config = state.config;
		const response = await state.client.recall(state.bankId, params.query, {
			budget: gear,
			maxTokens,
			types: params.types ?? (config.recallTypes.length > 0 ? config.recallTypes : undefined),
			tags,
			tagsMatch: state.recallTagsMatch,
			signal,
		});
		const candidates = response.results ?? [];
		let results = candidates;
		let scores: (number | null)[] | undefined;
		if (results.length === 1 && state.recallScorer) {
			const score = await state.recallScorer.score(params.query, results[0]!.text, signal);
			scores = [score];
			if (score !== null && score < state.config.decisionModelThreshold) results = [];
		}
		const details = describeRecallCoverage(
			{ mode: "shortlisted", gear, tags, totalAvailable },
			candidates,
			scores,
			results,
		);
		return {
			content: [
				{
					type: "text",
					text: `${recallCoverageHeader(results.length, details)}\n\n${results.length > 0 ? formatMemories(results) : "No relevant memories found."}`,
				},
			],
			details,
			...(results.length === 0 ? { useless: true } : {}),
		};
	}

	/** Server-ranked candidates for a scope `xhigh` cannot score directly. */
	async #tracedCandidates(
		state: HindsightSessionState,
		params: MemoryRecallParams,
		gear: "xhigh" | "max",
		tags: string[] | undefined,
		signal?: AbortSignal,
	): Promise<RecallResult[]> {
		const config = state.config;
		const response = await state.client.recall(state.bankId, params.query, {
			budget: "high",
			trace: true,
			maxTokens: RECALL_MAX_TOKENS_MAX,
			types: params.types ?? (config.recallTypes.length > 0 ? config.recallTypes : undefined),
			tags,
			tagsMatch: state.recallTagsMatch,
			signal,
		});
		return (response.trace?.rrf_merged ?? []).slice(0, GEAR_SWEEP_CAPS[gear]).map(candidate => ({
			id: candidate.node_id,
			text: candidate.text,
		}));
	}

	/** Score the candidates, drop what falls under the deep floor, then pack into the token budget. */
	async #packCandidates(
		state: HindsightSessionState,
		query: string,
		candidates: RecallResult[],
		options: {
			maxTokens: number;
			swept: boolean;
			gear: RecallGear;
			tags: string[] | undefined;
			totalAvailable: number | null;
		},
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		const notes: string[] = [];
		const scorer = state.recallScorer;
		let scores: (number | null)[] | undefined;
		if (scorer && candidates.length > 0) {
			try {
				scores = await scorer.scoreBatch(
					query,
					candidates.map(candidate => candidate.text),
					signal,
				);
			} catch (err) {
				logger.warn("deep recall scoring failed", { bankId: state.bankId, error: String(err) });
			}
		}
		const answered = scores?.filter((score): score is number => score !== null) ?? [];
		if (scores && answered.length === 0) scores = undefined;
		let ordered = candidates;
		if (!scores) {
			notes.push(
				`Scoring unavailable: ${candidates.length} candidates below are unscored, in ${options.swept ? "bank" : "recall"} order.`,
			);
		} else {
			const unscored = scores.filter(score => score === null).length;
			const best = Math.max(...answered);
			if (best < state.config.decisionModelThreshold) {
				const details = describeRecallCoverage(
					{
						mode: options.swept ? "swept" : "shortlisted",
						gear: options.gear,
						tags: options.tags,
						totalAvailable: options.totalAvailable,
					},
					candidates,
					scores,
					[],
				);
				const note = unscored > 0 ? ` ${unscored} candidates could not be scored.` : "";
				return {
					content: [
						{ type: "text", text: `${recallCoverageHeader(0, details)}\n\nNo relevant memories found.${note}` },
					],
					details,
					useless: true,
				};
			}
			if (unscored > 0) notes.push(`${unscored} candidates could not be scored.`);
			const floor = Math.max(RECALL_SCORE_FLOOR, RECALL_SCORE_FLOOR_RATIO * best);
			ordered = candidates
				.map((candidate, index) => ({ candidate, score: scores[index] ?? null }))
				.filter(
					(entry): entry is { candidate: RecallResult; score: number } =>
						entry.score !== null && entry.score >= floor,
				)
				.sort((left, right) => right.score - left.score)
				.map(({ candidate }) => candidate);
		}
		const details = describeRecallCoverage(
			{
				mode: options.swept ? "swept" : "shortlisted",
				gear: options.gear,
				tags: options.tags,
				totalAvailable: options.totalAvailable,
			},
			candidates,
			scores,
			ordered,
		);
		const packed = packByTokens(ordered, options.maxTokens);
		return {
			content: [
				{
					type: "text",
					text: [
						recallCoverageHeader(packed.length, details),
						...notes,
						packed.length > 0 ? formatMemories(packed) : "No relevant memories found.",
					].join("\n\n"),
				},
			],
			details: { ...details, truncated: !options.swept },
			...(packed.length === 0 ? { useless: true } : {}),
		};
	}
}
