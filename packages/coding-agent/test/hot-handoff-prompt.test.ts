import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	hashHandoffPrompt,
	loadHotHandoffActivation,
	projectHandoffPath,
	wrapHandoffPrompt,
} from "../examples/extensions/hot-handoff/prompt";

describe("hot handoff prompt loading", () => {
	const dirs: TempDir[] = [];

	afterEach(async () => {
		for (const dir of dirs.splice(0)) await dir.remove();
	});

	it("is inert when .omp/HANDOFF.md is missing", async () => {
		const dir = TempDir.createSync("@hot-handoff-missing-");
		dirs.push(dir);
		const activation = await loadHotHandoffActivation(dir.path());
		expect(activation.contract).toBeUndefined();
		expect(activation.disabledReason).toBe("missing");
	});

	it("loads the project contract when .omp/HANDOFF.md exists", async () => {
		const dir = TempDir.createSync("@hot-handoff-present-");
		dirs.push(dir);
		const contract = "# Objective\nfinish the parser";
		await fs.mkdir(path.join(dir.path(), ".omp"), { recursive: true });
		await Bun.write(projectHandoffPath(dir.path()), contract);
		const activation = await loadHotHandoffActivation(dir.path());
		expect(activation.disabledReason).toBeUndefined();
		expect(activation.contract?.text).toBe(contract);
		expect(activation.contract?.hash).toBe(hashHandoffPrompt(contract));
		expect(activation.contract?.path).toBe(projectHandoffPath(dir.path()));
	});

	it("treats an empty HANDOFF.md as disabled", async () => {
		const dir = TempDir.createSync("@hot-handoff-empty-");
		dirs.push(dir);
		await fs.mkdir(path.join(dir.path(), ".omp"), { recursive: true });
		await Bun.write(projectHandoffPath(dir.path()), "   \n\t\n");
		const activation = await loadHotHandoffActivation(dir.path());
		expect(activation.contract).toBeUndefined();
		expect(activation.disabledReason).toBe("empty");
	});

	it("wraps the project contract in the fixed protocol envelope", () => {
		const wrapped = wrapHandoffPrompt("## Objective\nship it");
		expect(wrapped).toContain("You are an independent handoff author.");
		expect(wrapped).toContain("This is NOT a conversation summary.");
		expect(wrapped).toContain("LIVE_STATE");
		expect(wrapped).toContain("## Objective\nship it");
		expect(wrapped).not.toContain("{{");
	});
});
