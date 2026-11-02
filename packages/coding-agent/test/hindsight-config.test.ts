import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadHindsightConfig, resolveProvenanceTags } from "@oh-my-pi/pi-coding-agent/hindsight/config";

function load(overrides: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(env)) {
		previous.set(key, Bun.env[key]);
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = String(value);
	}
	try {
		return loadHindsightConfig(Settings.isolated(overrides as never));
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	}
}

describe("loadHindsightConfig retainUpdateMode", () => {
	it("prefers HINDSIGHT_RETAIN_UPDATE_MODE over settings", () => {
		expect(
			load({ "hindsight.retainUpdateMode": "replace" }, { HINDSIGHT_RETAIN_UPDATE_MODE: "append" }).retainUpdateMode,
		).toBe("append");
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

	it("prefers HINDSIGHT_RETAIN_STRATEGY over settings", () => {
		expect(
			load({ "hindsight.retainStrategy": "coding" }, { HINDSIGHT_RETAIN_STRATEGY: "personal_chat" }).retainStrategy,
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

	it("parses HINDSIGHT_PROVENANCE_TAGS as a JSON array and prefers it over settings", () => {
		expect(
			load(
				{ "hindsight.provenanceTags": ["role:builder"] },
				{ HINDSIGHT_PROVENANCE_TAGS: '["team:infra","role:navigator"]' },
			).provenanceTags,
		).toEqual(["team:infra", "role:navigator"]);
	});
});

describe("resolveProvenanceTags", () => {
	it("merges configured tags with a lowercased role tag for the mounted profile", () => {
		expect(resolveProvenanceTags({ provenanceTags: ["team:infra", "role:other"] }, " Builder ")).toEqual([
			"team:infra",
			"role:other",
			"role:builder",
		]);
	});

	it("returns deduped configured tags when no profile is mounted", () => {
		expect(resolveProvenanceTags({ provenanceTags: [" team:infra ", "team:infra"] })).toEqual(["team:infra"]);
		expect(resolveProvenanceTags({ provenanceTags: [] })).toEqual([]);
	});
});
