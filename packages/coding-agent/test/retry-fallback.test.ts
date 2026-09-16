import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	expandDefaultRetryFallbackChains,
	findRetryFallbackCandidates,
	type RetryFallbackChains,
	type RetryFallbackResolutionContext,
	type RetryFallbackSelector,
	resolveRetryFallbackChainKey,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";

function createContext(
	chains: RetryFallbackResolutionContext["chains"],
	roles: Record<string, string> = {},
): RetryFallbackResolutionContext {
	const models = [
		getBundledModel("google", "gemini-2.5-flash"),
		getBundledModel("google-vertex", "gemini-2.5-flash"),
		getBundledModel("openrouter", "google/gemini-2.5-flash"),
		getBundledModel("openai", "gpt-4o-mini"),
	].filter(model => model !== undefined);
	return {
		chains,
		getModelRole: role => roles[role],
		modelLookup: {
			find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
			hasProvider: provider => models.some(model => model.provider === provider),
		},
	};
}

describe("retry fallback selector resolution", () => {
	it("resolves chain keys by exact model, longest wildcard, role, then default", () => {
		const selector = "openrouter/google/gemini-2.5-flash";
		const exactContext = createContext(
			{
				default: ["openai/gpt-4o-mini"],
				task: ["google/gemini-2.5-flash"],
				"openrouter/*": ["openai/gpt-4o-mini"],
				"openrouter/google/*": ["google-vertex/*"],
				[selector]: ["google/gemini-2.5-flash"],
			},
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(exactContext, selector, undefined, "task")).toBe(selector);

		const wildcardContext = createContext(
			{
				default: ["openai/gpt-4o-mini"],
				task: ["google/gemini-2.5-flash"],
				"openrouter/*": ["openai/gpt-4o-mini"],
				"openrouter/google/*": ["google-vertex/*"],
			},
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(wildcardContext, selector, undefined, "task")).toBe("openrouter/google/*");

		const roleContext = createContext(
			{ default: ["openai/gpt-4o-mini"], task: ["google/gemini-2.5-flash"] },
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(roleContext, selector, undefined, "task")).toBe("task");

		const defaultContext = createContext({ default: ["openai/gpt-4o-mini"] });
		expect(resolveRetryFallbackChainKey(defaultContext, selector)).toBe("default");
	});

	it("does not let a later shared-assignment role steal the default chain", () => {
		const selector = "openrouter/google/gemini-2.5-flash";
		const context = createContext(
			{
				vision: ["openai/gpt-4o-mini"],
				default: ["google/gemini-2.5-flash"],
			},
			{ default: selector, vision: selector },
		);
		expect(resolveRetryFallbackChainKey(context, selector)).toBe("default");
		expect(resolveRetryFallbackChainKey(context, selector, undefined, "default")).toBe("default");
		expect(resolveRetryFallbackChainKey(context, selector, undefined, "vision")).toBe("vision");
	});

	it("uses a hinted role chain when its unqualified primary cannot resolve", () => {
		const context = createContext({ task: ["openai/gpt-4o-mini"] });
		const chainKey = resolveRetryFallbackChainKey(context, "missing-model:high", undefined, "task");
		expect(chainKey).toBe("task");
		if (!chainKey) throw new Error("Expected hinted role fallback chain");
		expect(
			findRetryFallbackCandidates(context, chainKey, "missing-model:high", undefined, {
				allowMissingPrimary: true,
			}),
		).toEqual([
			{
				raw: "openai/gpt-4o-mini",
				provider: "openai",
				id: "gpt-4o-mini",
				thinkingLevel: undefined,
			},
		]);
	});

	it("stops a role chain when its primary assignment is removed at runtime", () => {
		const context = createContext({
			slow: ["google/gemini-2.5-flash", "openai/gpt-4o-mini"],
		});
		expect(findRetryFallbackCandidates(context, "slow", "google/gemini-2.5-flash")).toEqual([]);
	});

	it("expands wildcard candidates from the current selector", () => {
		const selector = "openrouter/google/gemini-2.5-flash";
		const context = createContext({ "openrouter/google/*": ["google-vertex/*"] });
		const candidates = findRetryFallbackCandidates(context, "openrouter/google/*", selector);
		expect(candidates).toEqual([
			{
				raw: "google-vertex/gemini-2.5-flash",
				provider: "google-vertex",
				id: "gemini-2.5-flash",
				thinkingLevel: undefined,
			},
		]);
	});

	it("carries per-entry thinking levels while bare entries inherit", () => {
		const context = createContext({ default: ["openai/gpt-4o-mini:low", "google/gemini-2.5-flash"] });
		const candidates = findRetryFallbackCandidates(context, "default", "openai/gpt-4o-mini");
		expect(candidates.map(candidate => candidate.raw)).toEqual(["openai/gpt-4o-mini:low", "google/gemini-2.5-flash"]);
		expect(candidates[0]?.thinkingLevel).toBe(ThinkingLevel.Low);
		// Bare entries carry no level so the failing turn's effort applies at switch time.
		expect(candidates[1]?.thinkingLevel).toBeUndefined();
	});

	it("inherits the default chain only for roles without an explicit chain", () => {
		const defaultChain = ["openai/gpt-4o-mini"];
		const expanded = expandDefaultRetryFallbackChains({ default: defaultChain, slow: ["google/gemini-2.5-flash"] }, [
			"default",
			"task",
			"slow",
		]);
		expect(expanded.task).toBe(defaultChain);
		expect(expanded.slow).toEqual(["google/gemini-2.5-flash"]);
	});

	it("prefers an exact model+effort key over a different-effort key regardless of object order", () => {
		const model = getBundledModel("google", "gemini-2.5-flash");
		const low = "google/gemini-2.5-flash:low";
		const max = "google/gemini-2.5-flash:max";

		const maxFirst = createContext({ [max]: ["openai/gpt-4o-mini:max"], [low]: ["openai/gpt-4o-mini:low"] });
		expect(resolveRetryFallbackChainKey(maxFirst, low, model)).toBe(low);
		expect(findRetryFallbackCandidates(maxFirst, low, low, model).map(candidate => candidate.raw)).toEqual([
			"openai/gpt-4o-mini:low",
		]);

		const lowFirst = createContext({ [low]: ["openai/gpt-4o-mini:low"], [max]: ["openai/gpt-4o-mini:max"] });
		expect(resolveRetryFallbackChainKey(lowFirst, low, model)).toBe(low);
	});

	it("lets a suffixless key match any effort but an exact effort key still wins", () => {
		const model = getBundledModel("google", "gemini-2.5-flash");
		const low = "google/gemini-2.5-flash:low";
		const suffixless = "google/gemini-2.5-flash";

		const baseOnly = createContext({ [suffixless]: ["openai/gpt-4o-mini"] });
		expect(resolveRetryFallbackChainKey(baseOnly, low, model)).toBe(suffixless);

		const suffixlessFirst = createContext({
			[suffixless]: ["openai/gpt-4o-mini"],
			[low]: ["openai/gpt-4o-mini:low"],
		});
		expect(resolveRetryFallbackChainKey(suffixlessFirst, low, model)).toBe(low);
	});

	it("never escalates to a different-effort chain when no matching effort is configured", () => {
		const model = getBundledModel("google", "gemini-2.5-flash");
		const low = "google/gemini-2.5-flash:low";
		const max = "google/gemini-2.5-flash:max";

		const maxOnly = createContext({ [max]: ["openai/gpt-4o-mini:max"] });
		expect(resolveRetryFallbackChainKey(maxOnly, low, model)).toBeUndefined();

		const maxWithDefault = createContext({ [max]: ["openai/gpt-4o-mini:max"], default: ["openai/gpt-4o-mini"] });
		expect(resolveRetryFallbackChainKey(maxWithDefault, low, model)).toBe("default");

		const maxWithHint = createContext({ [max]: ["openai/gpt-4o-mini:max"], smol: ["openai/gpt-4o-mini:medium"] });
		expect(resolveRetryFallbackChainKey(maxWithHint, low, model, "smol")).toBe("smol");
	});

	it("treats effort aliases as equivalent to their canonical form when matching keys", () => {
		const model = getBundledModel("google", "gemini-2.5-flash");
		const canonicalHigh = "google/gemini-2.5-flash:high";
		const aliasKey = "google/gemini-2.5-flash:hi";

		const context = createContext({ [aliasKey]: ["openai/gpt-4o-mini:high"] });
		expect(resolveRetryFallbackChainKey(context, canonicalHigh, model)).toBe(aliasKey);
		expect(
			findRetryFallbackCandidates(context, aliasKey, canonicalHigh, model).map(candidate => candidate.raw),
		).toEqual(["openai/gpt-4o-mini:high"]);
	});

	it("matches a requested effort key to the active model's clamped effort", () => {
		const model = getBundledModel("google", "gemini-2.5-flash");
		const high = "google/gemini-2.5-flash:high";
		const max = "google/gemini-2.5-flash:max";

		const maxOnly = createContext({ [max]: ["openai/gpt-4o-mini:max"] });
		expect(resolveRetryFallbackChainKey(maxOnly, high, model)).toBe(max);
		expect(findRetryFallbackCandidates(maxOnly, max, high, model).map(candidate => candidate.raw)).toEqual([
			"openai/gpt-4o-mini:max",
		]);

		const exactHigh = createContext({
			[max]: ["openai/gpt-4o-mini:max"],
			[high]: ["openai/gpt-4o-mini:high"],
		});
		expect(resolveRetryFallbackChainKey(exactHigh, high, model)).toBe(high);
	});
});

/**
 * The operator's live `retry.fallbackChains` and `modelRoles`, reduced to what
 * {@link expandDefaultRetryFallbackChains} hands the resolver at startup.
 * `cpa`/`cursor` are proxy providers the bundled catalog does not ship, so the
 * lookup resolves any well-formed provider/id — as the real registry does for
 * these selectors.
 */
const LIVE_CONFIGURED_CHAINS: RetryFallbackChains = {
	plan: ["cpa/kimi-k3-fast", "cpa/kimi-k3-slow"],
	smol: ["cpa/gemini-3.7-flash-high"],
	default: ["cursor/cursor-grok-4.6", "cpa/deepseek-flash"],
};

const LIVE_MODEL_ROLES: Record<string, string> = {
	slow: "cpa/gpt-5.6-sol:high",
	tiny: "cpa/gemini-3.1-flash-lite",
	plan: "cursor/kimi-k3-high:high",
	vision: "cpa/deepseek-v4-flash-vision-exp:high",
	default: "cpa/grok-4.6:high",
	builder: "cpa/deepseek-flash:auto",
	smol: "cpa/gemini-3.8-flash-high:high",
};

const DEFAULT_CHAIN_CANDIDATES: RetryFallbackSelector[] = [
	{ raw: "cursor/cursor-grok-4.6", provider: "cursor", id: "cursor-grok-4.6", thinkingLevel: undefined },
	{ raw: "cpa/deepseek-flash", provider: "cpa", id: "deepseek-flash", thinkingLevel: undefined },
];

function createLiveContext(configuredChains: RetryFallbackChains = LIVE_CONFIGURED_CHAINS): RetryFallbackResolutionContext {
	return {
		chains: expandDefaultRetryFallbackChains(configuredChains, Object.keys(LIVE_MODEL_ROLES)),
		getModelRole: role => LIVE_MODEL_ROLES[role],
		modelLookup: {
			find: (provider, id) => ({ provider, id }) as unknown as Model,
			hasProvider: () => true,
		},
	};
}

describe("retry fallback chain keys for a model no role owns", () => {
	it("falls back to the default chain", () => {
		const context = createLiveContext();
		const currentSelector = "cerebras/zai-glm-4.7";
		expect(resolveRetryFallbackChainKey(context, currentSelector)).toBe("default");
		expect(findRetryFallbackCandidates(context, "default", currentSelector)).toEqual(DEFAULT_CHAIN_CANDIDATES);
	});

	it("keeps every model-owned selector on its own chain", () => {
		const context = createLiveContext();
		const cases: [string, string, RetryFallbackSelector[]][] = [
			["cpa/grok-4.6:high", "default", DEFAULT_CHAIN_CANDIDATES],
			[
				"cpa/gemini-3.8-flash-high:high",
				"smol",
				[{ raw: "cpa/gemini-3.7-flash-high", provider: "cpa", id: "gemini-3.7-flash-high", thinkingLevel: undefined }],
			],
			["cpa/deepseek-flash:auto", "builder", DEFAULT_CHAIN_CANDIDATES],
		];
		for (const [currentSelector, chainKey, candidates] of cases) {
			expect(resolveRetryFallbackChainKey(context, currentSelector)).toBe(chainKey);
			expect(findRetryFallbackCandidates(context, chainKey, currentSelector)).toEqual(candidates);
		}
	});

	it("keeps an explicitly emptied role chain empty instead of borrowing the default chain", () => {
		const context = createLiveContext({ ...LIVE_CONFIGURED_CHAINS, plan: [] });
		const currentSelector = "cursor/kimi-k3-high:high";
		expect(resolveRetryFallbackChainKey(context, currentSelector)).toBe("plan");
		expect(findRetryFallbackCandidates(context, "plan", currentSelector)).toEqual([]);
		expect(resolveRetryFallbackChainKey(context, currentSelector, undefined, "plan")).toBe("plan");
		expect(
			findRetryFallbackCandidates(context, "plan", currentSelector, undefined, { allowMissingPrimary: true }),
		).toEqual([]);
	});

	it("does not attach a default chain that degenerates to the default role's own primary", () => {
		// `default`'s entries dedupe back to the primary `modelRoles.default`
		// already assigns, so the chain owns no model but the default role's own.
		const context = createLiveContext({ ...LIVE_CONFIGURED_CHAINS, default: [LIVE_MODEL_ROLES.default] });
		const currentSelector = "cerebras/zai-glm-4.7";
		expect(findRetryFallbackCandidates(context, "default", currentSelector)).toEqual([]);
		expect(resolveRetryFallbackChainKey(context, currentSelector)).toBeUndefined();
	});

	it("resolves no chain when no default chain is configured", () => {
		const context = createLiveContext({ plan: LIVE_CONFIGURED_CHAINS.plan, smol: LIVE_CONFIGURED_CHAINS.smol });
		expect(resolveRetryFallbackChainKey(context, "cerebras/zai-glm-4.7")).toBeUndefined();
	});
});
