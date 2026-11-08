export const RECALL_GEARS = ["default", "deep", "max"] as const;
export type RecallGear = (typeof RECALL_GEARS)[number];

export const SWEEP_CROSSOVER = 1200;
export const GEAR_SWEEP_CAPS: Readonly<Record<RecallGear, number>> = {
	default: SWEEP_CROSSOVER,
	deep: 2400,
	max: 4800,
};

/** Preserve saved choices while removing the old names from the public schema. */
export function migrateRecallBudget(value: unknown): unknown {
	if (value === "low" || value === "mid" || value === "high") return "default";
	if (value === "xhigh") return "deep";
	return value;
}

export function parseRecallBudget(value: unknown): RecallGear | undefined {
	const migrated = migrateRecallBudget(value);
	return migrated === "default" || migrated === "deep" || migrated === "max" ? migrated : undefined;
}

export function isNamedProjectScope(tags: readonly string[] | undefined): boolean {
	return tags?.some(tag => /^project:[a-z0-9][a-z0-9._-]*$/i.test(tag.trim())) ?? false;
}

/** Shared return-window boundary for manual recall and root agent policy. */
export function clampRecallMaxTokens(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	return Math.min(16384, Math.max(512, Math.round(value)));
}

/** A dedicated project bank or conjunctive named-project filter makes max exhaustive. */
export function recallSweepCeiling(
	gear: RecallGear,
	scoping: string,
	tags: readonly string[] | undefined,
	tagsMatch?: string,
): number {
	const project =
		scoping === "per-project" ||
		((tagsMatch === undefined || tagsMatch === "all" || tagsMatch === "all_strict") && isNamedProjectScope(tags));
	return gear === "max" && project ? Number.POSITIVE_INFINITY : GEAR_SWEEP_CAPS[gear];
}
