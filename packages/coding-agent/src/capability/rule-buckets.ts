/**
 * Rule bucketing
 *
 * Single funnel that every discovered rule passes through on its way into a
 * session. It applies the user's disable levers, registers TTSR rules with the
 * manager, and splits the rest into the always-apply and rulebook buckets.
 *
 * Precedence (matches docs/rulebook-matching-pipeline.md §5):
 *   1. disabledRules  — dropped before any bucket assignment
 *   2. builtin drop   — `builtinRules === false` drops `builtin-defaults` rules
 *   3. agents scope   — rules whose `agents` globs do not match `options.agentName` are dropped
 *   4. TTSR           — non-empty `condition`/`astCondition`/`question` the manager already tracks or newly accepts
 *   5. always         — `alwaysApply === true`
 *   6. rulebook       — has a `description`
 */
import type { TtsrManager } from "../export/ttsr";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleAppliesToAgent } from "./rule";

export interface RuleBuckets {
	rulebookRules: Rule[];
	alwaysApplyRules: Rule[];
}

export interface BucketRulesOptions {
	/** Rule names to drop entirely (bundled defaults and user rules alike). */
	disabledRules?: readonly string[];
	/** When false, drop every rule from the bundled `builtin-defaults` provider. */
	builtinRules?: boolean;
	/**
	 * Agent this session runs as: `"main"` for a top-level session, otherwise the
	 * agent definition name. Rules whose `agents` globs do not match are dropped
	 * from every bucket. Omit to disable agent scoping (CLI inventory listings).
	 */
	agentName?: string;
	/** Replace existing TTSR registrations before bucketing this complete rule snapshot. */
	replaceTtsrRules?: boolean;
	/**
	 * Rules the session's profile declares, in declared order. Present (even empty) means
	 * the profile owns its always-apply set: the bucket is exactly these rules, matched by
	 * `rule.name` or the rule file's stem, and the legacy `agents` globs are not consulted.
	 * Absent keeps the `agents`-scoped bucketing a bare `main` session relies on.
	 *
	 * `disabledRules` still wins — a disabled rule is not applied because a profile named
	 * it, and an unknown name is simply absent from the bucket rather than an error.
	 */
	declaredRules?: readonly string[];
}

/** Where a rule sits in the profile's declaration, by rule name or by file stem. */
function declaredRank(rule: Rule, order: ReadonlyMap<string, number>): number | undefined {
	const byName = order.get(rule.name.trim().toLowerCase());
	if (byName !== undefined) return byName;
	const file = rule.path.split("/").pop() ?? "";
	const stem = file.endsWith(".md") ? file.slice(0, -3) : file;
	return stem ? order.get(stem.toLowerCase()) : undefined;
}

/**
 * Filter and bucket rules, registering TTSR rules on `ttsrManager` as a side
 * effect. Disabled rules are dropped before any bucket assignment, so a
 * disabled rule is neither matched as TTSR nor surfaced via `rule://`.
 */
export function bucketRules(
	rules: readonly Rule[],
	ttsrManager: TtsrManager,
	options: BucketRulesOptions = {},
): RuleBuckets {
	const includeBuiltin = options.builtinRules !== false;
	const disabled = new Set<string>();
	for (const raw of options.disabledRules ?? []) {
		const name = raw.trim();
		if (name.length > 0) disabled.add(name);
	}

	const declared = options.declaredRules;
	const declaredOrder = new Map<string, number>();
	if (declared) {
		for (const raw of declared) {
			// A profile may name the rule or its file; both forms mean the same rule.
			const key = raw.trim().toLowerCase().replace(/\.md$/, "");
			if (key.length > 0 && !declaredOrder.has(key)) declaredOrder.set(key, declaredOrder.size);
		}
	}

	const includedRules: Rule[] = [];
	for (const rule of rules) {
		if (disabled.has(rule.name)) continue;
		if (!includeBuiltin && rule._source?.provider === BUILTIN_DEFAULTS_PROVIDER_ID) continue;
		// A declaring profile replaces the `agents` globs rather than adding to them.
		if (!declared && !ruleAppliesToAgent(rule, options.agentName)) continue;
		includedRules.push(rule);
	}

	const replacedTtsrNames = options.replaceTtsrRules ? ttsrManager.replaceRules(includedRules) : undefined;
	const rulebookRules: Rule[] = [];
	const alwaysApplyRules: Rule[] = [];
	const declaredPicked: Array<{ rank: number; rule: Rule }> = [];

	for (const rule of includedRules) {
		const hasTtsrCondition =
			(rule.condition && rule.condition.length > 0) ||
			(rule.astCondition && rule.astCondition.length > 0) ||
			rule.question !== undefined;
		const isTtsrRule = hasTtsrCondition ? (replacedTtsrNames?.has(rule.name) ?? ttsrManager.addRule(rule)) : false;
		if (isTtsrRule) continue;
		if (declared) {
			const rank = declaredRank(rule, declaredOrder);
			if (rank !== undefined) {
				declaredPicked.push({ rank, rule });
				continue;
			}
		} else if (rule.alwaysApply === true) {
			alwaysApplyRules.push(rule);
			continue;
		}
		if (rule.description) {
			rulebookRules.push(rule);
		}
	}

	// Declared order is the profile's own ranking, so the bucket is rebuilt from it rather
	// than from discovery order.
	declaredPicked.sort((a, b) => a.rank - b.rank);
	for (const picked of declaredPicked) alwaysApplyRules.push(picked.rule);

	return { rulebookRules, alwaysApplyRules };
}
