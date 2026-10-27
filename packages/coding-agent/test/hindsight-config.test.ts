import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";

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
