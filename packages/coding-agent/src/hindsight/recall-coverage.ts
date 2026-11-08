import type { RecallResult } from "./client";
import { formatCurrentTime } from "./content";
import type { RecallGear } from "./sweep";

export interface RecallCoverage {
	mode: "swept" | "shortlisted";
	evaluatedCount: number;
	/** Collection-total sum, or null when no bank sweep established it. */
	totalAvailable: number | null;
	gear: RecallGear;
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
		evaluatedCount: scoredCandidates.filter(candidate => candidate.score !== null).length,
		scoredCandidates,
	};
}

export function recallCoverageHeader(count: number, coverage: RecallCoverage): string {
	const total = coverage.totalAvailable ?? "unknown";
	const path =
		coverage.mode === "swept"
			? `swept ${coverage.evaluatedCount}/${total}`
			: `evaluated ${coverage.evaluatedCount} shortlisted of ${total}`;
	return `Found ${count} relevant ${count === 1 ? "memory" : "memories"} (decision model ${path} available records in [${coverage.tags.join(", ")}] at gear=${coverage.gear}, as of ${formatCurrentTime()} UTC):`;
}
