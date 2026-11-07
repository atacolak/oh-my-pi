/**
 * Resolved Hindsight runtime configuration.
 *
 * Every field reads a `hindsight.*` setting handle. Handles declare their `HINDSIGHT_*`
 * environment variable, which wins over the settings layers because operators frequently
 * override per-shell (CI, prod) without touching the persisted settings file.
 */
import type { Settings } from "../config/settings";
import {
	cfgHindsightApiToken,
	cfgHindsightApiUrl,
	cfgHindsightAutoRecall,
	cfgHindsightAutoRetain,
	cfgHindsightBankId,
	cfgHindsightBankIdPrefix,
	cfgHindsightBankMission,
	cfgHindsightDebug,
	cfgHindsightDecisionModelApiKey,
	cfgHindsightDecisionModelThreshold,
	cfgHindsightDecisionModelUrl,
	cfgHindsightGlobalScope,
	cfgHindsightMentalModelAutoSeed,
	cfgHindsightMentalModelMaxRenderChars,
	cfgHindsightMentalModelsEnabled,
	cfgHindsightProvenanceTags,
	cfgHindsightRecallBudget,
	cfgHindsightRecallCadence,
	cfgHindsightRecallContextTurns,
	cfgHindsightRecallDedup,
	cfgHindsightRecallMaxQueryChars,
	cfgHindsightRecallMaxTokens,
	cfgHindsightRecallPreferObservations,
	cfgHindsightRecallPrune,
	cfgHindsightRecallTimeoutMs,
	cfgHindsightRecallTypes,
	cfgHindsightReflectTimeoutMs,
	cfgHindsightRequestTimeoutMs,
	cfgHindsightRetainContext,
	cfgHindsightRetainEveryNTurns,
	cfgHindsightRetainMission,
	cfgHindsightRetainMode,
	cfgHindsightRetainOverlapTurns,
	cfgHindsightRetainStrategy,
	cfgHindsightRetainTimeoutMs,
	cfgHindsightRetainUpdateMode,
	cfgHindsightScopeTags,
	cfgHindsightScoping,
} from "./settings";

export type HindsightScoping = "global" | "per-project" | "per-project-tagged";

/**
 * Root agent memory policy from a `memory:` frontmatter block. A field the agent omits
 * inherits the session setting; `HINDSIGHT_AUTO_*` remains the operator's override.
 */
export interface HindsightAgentMemoryPolicy {
	autoRetain?: boolean;
	autoRecall?: boolean;
}

export interface HindsightConfig {
	hindsightApiUrl: string | null;
	hindsightApiToken: string | null;

	bankId: string | null;
	bankIdPrefix: string;
	scoping: HindsightScoping;
	scopeTags: string[];
	/**
	 * Write-only provenance tags merged into every retain. They never reach recall
	 * filters or observation scopes, so stamping an actor or role cannot narrow
	 * what the session can recall.
	 */
	provenanceTags: string[];
	/** Whether `retain`/`learn` may store `scope: "global"` items untagged; opt-in through `hindsight.globalScope`. */
	globalScope: boolean;
	bankMission: string;
	retainMission: string | null;

	autoRecall: boolean;
	autoRetain: boolean;

	retainMode: "full-session" | "last-turn";
	retainEveryNTurns: number;
	retainOverlapTurns: number;
	retainContext: string;
	/** How full-session retains update the existing document. Default replace. */
	retainUpdateMode: "replace" | "append";
	/** Per-item Hindsight extraction strategy. Null/empty omits the request field. */
	retainStrategy: string | null;

	recallBudget: "low" | "mid" | "high";
	recallMaxTokens: number;
	recallTypes: string[];
	recallContextTurns: number;
	recallMaxQueryChars: number;
	recallPromptPreamble: string;
	/** Let observations supersede the raw facts they were consolidated from. */
	recallPreferObservations: boolean;
	/** Recall-stage pruning on the server; a no-op where no recall decision model runs. */
	recallPrune: boolean;
	/** Recall-stage dedup on the server; a no-op where no recall decision model runs. */
	recallDedup: boolean;
	/**
	 * `boundary` recalls once per context epoch; `per-turn` asks again every turn while
	 * deduping what the transcript already holds. The default stays `boundary`: per-turn
	 * without server-side pruning repeats near-miss memories every turn.
	 */
	recallCadence: "per-turn" | "boundary";
	/** Decision-model base URL; unset disables single-survivor abstention. */
	decisionModelUrl: string | null;
	/** Bearer token for the decision model; unset sends none. */
	decisionModelApiKey: string | null;
	/** Minimum `noul` score for a lone recall survivor to be delivered. */
	decisionModelThreshold: number;

	debug: boolean;

	/** Default per-request client deadline (ms) for ops without a specific override. */
	requestTimeoutMs: number;
	/** Client deadline (ms) for reflect (agentic synthesis; costlier than a metadata fetch). */
	reflectTimeoutMs: number;
	/** Client deadline (ms) for recall. */
	recallTimeoutMs: number;
	/** Client deadline (ms) for retain / retainBatch. */
	retainTimeoutMs: number;

	mentalModelsEnabled: boolean;
	mentalModelAutoSeed: boolean;
	mentalModelMaxRenderChars: number;
}

const DEFAULT_PREAMBLE =
	"Relevant memories from past conversations (prioritize recent when conflicting). " +
	"Only use memories that are directly useful to continue this conversation; ignore the rest:";

/**
 * Load the resolved Hindsight config. `HINDSIGHT_*` environment variables override settings
 * through the setting definitions (`hindsight/settings.ts`); invalid values fall back to defaults.
 */
export function loadHindsightConfig(settings: Settings): HindsightConfig {
	const config: HindsightConfig = {
		hindsightApiUrl: cfgHindsightApiUrl.get(settings),
		hindsightApiToken: cfgHindsightApiToken.get(settings) ?? null,

		bankId: cfgHindsightBankId.get(settings) ?? null,
		bankIdPrefix: cfgHindsightBankIdPrefix.get(settings) ?? "",
		scoping: cfgHindsightScoping.get(settings),
		scopeTags: [...cfgHindsightScopeTags.get(settings)]
			.filter((item): item is string => typeof item === "string")
			.map(item => item.trim())
			.filter(Boolean),
		provenanceTags: [...cfgHindsightProvenanceTags.get(settings)]
			.filter((item): item is string => typeof item === "string")
			.map(item => item.trim())
			.filter(Boolean),
		globalScope: cfgHindsightGlobalScope.get(settings),
		bankMission: cfgHindsightBankMission.get(settings) ?? "",
		retainMission: cfgHindsightRetainMission.get(settings) ?? null,

		autoRecall: cfgHindsightAutoRecall.get(settings),
		autoRetain: cfgHindsightAutoRetain.get(settings),

		retainMode: cfgHindsightRetainMode.get(settings),
		retainEveryNTurns: cfgHindsightRetainEveryNTurns.get(settings),
		retainOverlapTurns: cfgHindsightRetainOverlapTurns.get(settings),
		retainContext: cfgHindsightRetainContext.get(settings),
		retainUpdateMode: cfgHindsightRetainUpdateMode.get(settings),
		retainStrategy: cfgHindsightRetainStrategy.get(settings)?.trim() || null,

		recallBudget: cfgHindsightRecallBudget.get(settings),
		recallMaxTokens: cfgHindsightRecallMaxTokens.get(settings),
		recallTypes: [...cfgHindsightRecallTypes.get(settings)],
		recallContextTurns: cfgHindsightRecallContextTurns.get(settings),
		recallMaxQueryChars: cfgHindsightRecallMaxQueryChars.get(settings),
		recallPromptPreamble: DEFAULT_PREAMBLE,
		recallPreferObservations: cfgHindsightRecallPreferObservations.get(settings),
		recallPrune: cfgHindsightRecallPrune.get(settings),
		recallDedup: cfgHindsightRecallDedup.get(settings),
		recallCadence: cfgHindsightRecallCadence.get(settings),
		decisionModelUrl: cfgHindsightDecisionModelUrl.get(settings)?.trim() || null,
		decisionModelApiKey: cfgHindsightDecisionModelApiKey.get(settings) ?? null,
		decisionModelThreshold: cfgHindsightDecisionModelThreshold.get(settings),

		debug: cfgHindsightDebug.get(settings),

		requestTimeoutMs: cfgHindsightRequestTimeoutMs.get(settings),
		reflectTimeoutMs: cfgHindsightReflectTimeoutMs.get(settings),
		recallTimeoutMs: cfgHindsightRecallTimeoutMs.get(settings),
		retainTimeoutMs: cfgHindsightRetainTimeoutMs.get(settings),

		mentalModelsEnabled: cfgHindsightMentalModelsEnabled.get(settings),
		mentalModelAutoSeed: cfgHindsightMentalModelAutoSeed.get(settings),
		mentalModelMaxRenderChars: cfgHindsightMentalModelMaxRenderChars.get(settings),
	};

	return config;
}

/**
 * Write-only provenance tags for one session's retains: operator-configured
 * tags plus `role:<profile>` for the mounted agent profile.
 *
 * The profile is lowercased like rule scoping, so two spellings of one agent
 * cannot split provenance into two literal tag values. Provenance is merged
 * into retains only — never into recall filters or observation scopes.
 */
export function resolveProvenanceTags(
	config: Pick<HindsightConfig, "provenanceTags">,
	agentProfile?: string | null,
): string[] {
	const profile = agentProfile?.trim().toLowerCase();
	const tags = profile ? [...config.provenanceTags, `role:${profile}`] : [...config.provenanceTags];
	return [...new Set(tags.map(tag => tag.trim()).filter(Boolean))];
}

/** Whether the caller has enough config to talk to a Hindsight server. */
export function isHindsightConfigured(
	config: HindsightConfig,
): config is HindsightConfig & { hindsightApiUrl: string } {
	return typeof config.hindsightApiUrl === "string" && config.hindsightApiUrl.length > 0;
}
