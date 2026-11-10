import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { VALUELESS_FLAGS } from "@oh-my-pi/pi-coding-agent/cli/flag-tables";
import { launchHelp } from "../src/commands/launch-help";

describe("parseArgs — --alt flag", () => {
	it("parses --alt as a boolean flag", () => {
		const result = parseArgs(["--alt"]);
		expect(result.alt).toBe(true);
	});

	it("defaults alt to undefined when flag is not provided", () => {
		const result = parseArgs([]);
		expect(result.alt).toBeUndefined();
	});

	it("parses --alt with other flags", () => {
		const result = parseArgs(["--alt", "--model", "opus", "hello"]);
		expect(result.alt).toBe(true);
		expect(result.model).toBe("opus");
		expect(result.messages).toContain("hello");
	});

	it("parses --alt in any position", () => {
		const result1 = parseArgs(["--alt", "prompt"]);
		const result2 = parseArgs(["prompt", "--alt"]);
		const result3 = parseArgs(["--model", "opus", "--alt", "prompt"]);

		expect(result1.alt).toBe(true);
		expect(result2.alt).toBe(true);
		expect(result3.alt).toBe(true);
	});

	it("does not consume a value after --alt", () => {
		const result = parseArgs(["--alt", "--model", "opus"]);
		expect(result.alt).toBe(true);
		expect(result.model).toBe("opus");
		expect(result.messages).toEqual([]);
	});

	it("is classified as valueless so bootstrap does not steal the next token", () => {
		expect(VALUELESS_FLAGS.has("--alt")).toBe(true);
		const result = parseArgs(["--alt", "--profile", "work"]);
		expect(result.alt).toBe(true);
		expect(result.profile).toBe("work");
	});
});

describe("launch-help — --alt metadata", () => {
	it("exposes --alt as a boolean flag in help metadata", () => {
		expect(launchHelp.flags.alt).toBeDefined();
		expect(launchHelp.flags.alt.kind).toBe("boolean");
		expect(launchHelp.flags.alt.description).toMatch(/app-viewport/i);
	});
});
