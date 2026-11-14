/**
 * Contract tests for the shared direct-sweep helpers.
 *
 * The gear ladder and the collection filter are the two decisions every recall surface
 * (`recallForContext` and the `recall` tool) must make identically: a gear's ceiling bounds how
 * much of the bank is read, and the filter decides which collections are read at all.
 */

import { describe, expect, it } from "bun:test";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { MAX_SWEEP_COLLECTIONS, resolveSweepCollections } from "@oh-my-pi/pi-coding-agent/hindsight/sweep";

type ScopeConfig = Pick<HindsightConfig, "recallTypes" | "recallPreferObservations">;

function scope(overrides: Partial<ScopeConfig> = {}): ScopeConfig {
	return { recallTypes: ["world", "experience"], recallPreferObservations: true, ...overrides };
}

describe("resolveSweepCollections", () => {
	it("sweeps the collections the caller named explicitly", () => {
		expect(resolveSweepCollections(["world"], scope())).toEqual([{ type: "world" }]);
		expect(resolveSweepCollections(["world", "experience"], scope())).toEqual([
			{ type: "world" },
			{ type: "experience" },
		]);
	});

	it("sweeps consolidated observations and unmerged facts for the default observation-preferring scope", () => {
		expect(resolveSweepCollections(undefined, scope())).toEqual(MAX_SWEEP_COLLECTIONS);
		expect(resolveSweepCollections([], scope({ recallTypes: [] }))).toEqual(MAX_SWEEP_COLLECTIONS);
	});

	it("sweeps the caller's own types when observations are not preferred", () => {
		expect(resolveSweepCollections(undefined, scope({ recallPreferObservations: false }))).toEqual([
			{ type: "world" },
			{ type: "experience" },
		]);
		expect(
			resolveSweepCollections(undefined, scope({ recallTypes: ["world"], recallPreferObservations: false })),
		).toEqual([{ type: "world" }]);
	});

	it("includes unconsolidated retains for observation-only configuration but preserves an explicit caller type restriction", () => {
		expect(resolveSweepCollections(undefined, scope({ recallTypes: ["observation"] }))).toEqual(
			MAX_SWEEP_COLLECTIONS,
		);
		expect(resolveSweepCollections(["observation"], scope())).toEqual([{ type: "observation" }]);
		expect(
			resolveSweepCollections(undefined, scope({ recallTypes: ["observation"], recallPreferObservations: false })),
		).toEqual([{ type: "observation" }]);
	});

	it("falls back to the consolidated set when a non-preferring scope names no types", () => {
		expect(resolveSweepCollections(undefined, scope({ recallTypes: [], recallPreferObservations: false }))).toEqual(
			MAX_SWEEP_COLLECTIONS,
		);
	});
});
