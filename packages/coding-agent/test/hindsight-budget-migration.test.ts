import { afterEach, beforeEach, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { cfgHindsightRecallBudget } from "@oh-my-pi/pi-coding-agent/hindsight/settings";
import { isolateHindsightEnv, type RestoreHindsightEnv } from "./helpers/hindsight-env";

let restore: RestoreHindsightEnv = () => {};
beforeEach(() => {
	restore = isolateHindsightEnv();
});
afterEach(() => restore());

it("loads a saved low budget as the universal default without rewriting the source file", async () => {
	using temp = TempDir.createSync("@recall-budget-migration-");
	const file = path.join(temp.path(), "agent", "config.yml");
	const text = "hindsight:\n  recallBudget: low\n";
	await Bun.write(file, text);
	const settings = await Settings.loadReadOnly({ agentDir: path.join(temp.path(), "agent"), cwd: temp.path() });
	expect(loadHindsightConfig(settings).recallBudget).toBe("default");
	expect(cfgHindsightRecallBudget.get(settings)).toBe("default");
	expect(await Bun.file(file).text()).toBe(text);
});

it("migrates a saved dotted xhigh budget to deep rather than losing its larger scan", async () => {
	using temp = TempDir.createSync("@recall-budget-dotted-");
	await Bun.write(path.join(temp.path(), "agent", "config.yml"), "hindsight.recallBudget: xhigh\n");
	const settings = await Settings.loadReadOnly({ agentDir: path.join(temp.path(), "agent"), cwd: temp.path() });
	expect(loadHindsightConfig(settings).recallBudget).toBe("deep");
	expect(() => cfgHindsightRecallBudget.parse("xhigh")).toThrow(/valid values/i);
});

it("preserves an explicit nested budget when a stale dotted legacy value also exists", async () => {
	using temp = TempDir.createSync("@recall-budget-precedence-");
	await Bun.write(
		path.join(temp.path(), "agent", "config.yml"),
		"hindsight:\n  recallBudget: max\nhindsight.recallBudget: xhigh\n",
	);
	const settings = await Settings.loadReadOnly({ agentDir: path.join(temp.path(), "agent"), cwd: temp.path() });
	expect(loadHindsightConfig(settings).recallBudget).toBe("max");
});

it("accepts a legacy environment budget while keeping explicit runtime choices above it", () => {
	process.env.HINDSIGHT_RECALL_BUDGET = "xhigh";
	expect(loadHindsightConfig(Settings.isolated()).recallBudget).toBe("deep");
	expect(loadHindsightConfig(Settings.isolated({ "hindsight.recallBudget": "max" })).recallBudget).toBe("max");
});
