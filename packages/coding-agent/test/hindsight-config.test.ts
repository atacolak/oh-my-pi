import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadHindsightConfig, resolveProvenanceTags } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import {
	cfgHindsightProvenanceTags,
	cfgHindsightRetainStrategy,
	cfgHindsightRetainUpdateMode,
} from "@oh-my-pi/pi-coding-agent/hindsight/settings";

function withEnv<T>(env: NodeJS.ProcessEnv, run: () => T): T {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(env)) {
		previous.set(key, Bun.env[key]);
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = String(value);
	}
	try {
		return run();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	}
}

function load(overrides: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
	return withEnv(env, () => loadHindsightConfig(Settings.isolated(overrides as never)));
}

describe("loadHindsightConfig retainUpdateMode", () => {
	it("prefers HINDSIGHT_RETAIN_UPDATE_MODE over a persisted setting", () => {
		// A persisted layer (config file or `set`) yields to the env var; only a
		// runtime override — CLI flag, session write, SDK override — outranks it.
		const settings = Settings.isolated();
		cfgHindsightRetainUpdateMode.set(settings, "replace");
		expect(
			withEnv({ HINDSIGHT_RETAIN_UPDATE_MODE: "append" }, () => loadHindsightConfig(settings)).retainUpdateMode,
		).toBe("append");
	});

	it("lets a runtime override outrank HINDSIGHT_RETAIN_UPDATE_MODE", () => {
		expect(
			load({ "hindsight.retainUpdateMode": "replace" }, { HINDSIGHT_RETAIN_UPDATE_MODE: "append" }).retainUpdateMode,
		).toBe("replace");
	});

	it("falls back to replace when retainUpdateMode env is invalid", () => {
		expect(load({}, { HINDSIGHT_RETAIN_UPDATE_MODE: "upsert" }).retainUpdateMode).toBe("replace");
	});
});

describe("loadHindsightConfig retainStrategy", () => {
	it("treats empty and whitespace retainStrategy as unset", () => {
		expect(load({ "hindsight.retainStrategy": "" }).retainStrategy).toBeNull();
		expect(load({ "hindsight.retainStrategy": "   " }).retainStrategy).toBeNull();
		expect(load({}, { HINDSIGHT_RETAIN_STRATEGY: "  " }).retainStrategy).toBeNull();
	});

	it("prefers HINDSIGHT_RETAIN_STRATEGY over a persisted setting", () => {
		const settings = Settings.isolated();
		cfgHindsightRetainStrategy.set(settings, "coding");
		expect(
			withEnv({ HINDSIGHT_RETAIN_STRATEGY: "personal_chat" }, () => loadHindsightConfig(settings)).retainStrategy,
		).toBe("personal_chat");
	});
});

describe("loadHindsightConfig scopeTags", () => {
	it("defaults scopeTags to an empty array", () => {
		expect(load({}).scopeTags).toEqual([]);
	});

	it("loads and trims configured scopeTags", () => {
		expect(load({ "hindsight.scopeTags": [" scope:coding ", "", 12, "scope:coding"] }).scopeTags).toEqual([
			"scope:coding",
			"scope:coding",
		]);
	});
});

describe("loadHindsightConfig provenanceTags", () => {
	it("defaults provenanceTags to an empty array", () => {
		expect(load({}).provenanceTags).toEqual([]);
	});

	it("loads and trims configured provenanceTags", () => {
		expect(load({ "hindsight.provenanceTags": [" role:builder ", "", 12, "team:infra"] }).provenanceTags).toEqual([
			"role:builder",
			"team:infra",
		]);
	});

	it("parses HINDSIGHT_PROVENANCE_TAGS as a JSON array and prefers it over a persisted setting", () => {
		const settings = Settings.isolated();
		cfgHindsightProvenanceTags.set(settings, ["role:builder"]);
		expect(
			withEnv({ HINDSIGHT_PROVENANCE_TAGS: '["team:infra","role:navigator"]' }, () => loadHindsightConfig(settings))
				.provenanceTags,
		).toEqual(["team:infra", "role:navigator"]);
	});
});

describe("resolveProvenanceTags", () => {
	it("merges configured tags with a lowercased role tag for the mounted profile", () => {
		expect(
			withEnv({ HCOM_INSTANCE_NAME: undefined }, () =>
				resolveProvenanceTags({ provenanceTags: ["team:infra", "role:other"] }, " Builder "),
			),
		).toEqual(["team:infra", "role:other", "role:builder"]);
	});

	it("returns deduped configured tags when no profile is mounted", () => {
		withEnv({ HCOM_INSTANCE_NAME: " " }, () => {
			expect(resolveProvenanceTags({ provenanceTags: [" team:infra ", "team:infra"] })).toEqual(["team:infra"]);
			expect(resolveProvenanceTags({ provenanceTags: [] })).toEqual([]);
		});
	});

	it("normalizes and deduplicates the named actor alongside the mounted role", () => {
		expect(
			withEnv({ HCOM_INSTANCE_NAME: " Helper_One " }, () =>
				resolveProvenanceTags({ provenanceTags: ["actor:helper_one"] }, " Builder "),
			),
		).toEqual(["actor:helper_one", "role:builder"]);
	});
});
