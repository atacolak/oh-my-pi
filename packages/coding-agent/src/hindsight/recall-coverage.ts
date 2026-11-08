import { prompt } from "@oh-my-pi/pi-utils";
import coverageHeader from "../prompts/tools/recall-coverage-header.md" with { type: "text" };
import type { RecallResult } from "./client";
import { formatCurrentTime } from "./content";
import type { RecallGear } from "./sweep";

export interface RecallCoverage {
	mode: "swept" | "shortlisted";
	evaluatedCount: number;
	/** Distinct in-scope records; null when overlapping unread collections prevent an exact count. */
	totalAvailable: number | null;
	gear: RecallGear;
	evaluatedAt: string;
	tags: string[];
	scoredCandidates: { id: string | null; text: string; score: number | null; kept: boolean }[];
}

export interface RecallCoverageScope {
	mode: RecallCoverage["mode"];
	totalAvailable: number | null;
	gear: RecallGear;
	tags: string[] | undefined;
}

/** Kept records passed relevance filtering, before token packing or context deduplication. */
export function describeRecallCoverage(
	scope: RecallCoverageScope,
	candidates: readonly RecallResult[],
	scores: readonly (number | null)[] | undefined,
	kept: readonly RecallResult[],
): RecallCoverage {
	const survivors = new Set(kept);
	const scoredCandidates = candidates.map((candidate, index) => {
		const value = scores?.[index];
		const score = typeof value === "number" && Number.isFinite(value) ? value : null;
		return { id: candidate.id ?? null, text: candidate.text, score, kept: survivors.has(candidate) };
	});
	return {
		...scope,
		tags: [...(scope.tags ?? [])],
		evaluatedAt: formatCurrentTime(),
		evaluatedCount: scoredCandidates.filter(candidate => candidate.score !== null).length,
		scoredCandidates,
	};
}

/** Display facts retain the time and scope actually measured, not the next description render time. */
export function recallCoverageView(coverage: RecallCoverage) {
	return {
		...coverage,
		total: coverage.totalAvailable ?? "unknown",
		percentage:
			coverage.totalAvailable !== null && coverage.totalAvailable > 0
				? `${Math.round((100 * coverage.evaluatedCount) / coverage.totalAvailable)}%`
				: coverage.totalAvailable === 0
					? "100%"
					: "unknown",
		scope: coverage.tags.join(", "),
	};
}

export function recallCoverageHeader(count: number, coverage: RecallCoverage): string {
	return prompt
		.render(coverageHeader, {
			count,
			noun: count === 1 ? "memory" : "memories",
			swept: coverage.mode === "swept",
			coverage: recallCoverageView(coverage),
		})
		.trim();
}
