import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const prompt = readFileSync(new URL("../src/prompts/system/recap-user.md", import.meta.url), "utf8");
/** The instruction paragraph before the optional goal/task slots. */
const instruction = prompt
	.split("{{#if")[0]!
	.replace(/<\/?recap>/g, "")
	.trim();

describe("recap prompt", () => {
	it("anchors the recap in artifacts instead of telling the model to skip them", () => {
		expect(prompt).not.toMatch(/\bskip\b/i);
		expect(instruction).toMatch(/files|modules/i);
		expect(instruction).toMatch(/SHAs?/);
		expect(instruction).toMatch(/tests?/i);
		expect(instruction).toMatch(/next|in flight|remaining/i);
		expect(instruction).toMatch(/blocker|decision/i);
	});

	it("stays under 60 words, 1-3 plain sentences, with no markdown", () => {
		const words = instruction.split(/\s+/).filter(Boolean);
		expect(words.length).toBeLessThan(60);
		expect(instruction).not.toMatch(/\*\*|__|`|^\s*#|^\s*[-*]\s/m);
		const sentences = instruction.split(/[.!?](?:\s|$)/).filter(sentence => sentence.trim().length > 0);
		expect(sentences.length).toBeGreaterThanOrEqual(1);
		expect(sentences.length).toBeLessThanOrEqual(3);
	});
});
