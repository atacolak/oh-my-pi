import { describe, expect, it } from "bun:test";
import { resolveSpeculationLeadTokens, SPECULATION_LEAD_MIN_TOKENS } from "../src/session/speculation-lead";

describe("resolveSpeculationLeadTokens", () => {
	it("keeps the native 12.5%/8k–32k lead when min lead is unset", () => {
		expect(resolveSpeculationLeadTokens(50_000)).toBe(SPECULATION_LEAD_MIN_TOKENS);
		expect(resolveSpeculationLeadTokens(140_000)).toBe(17_500);
		expect(resolveSpeculationLeadTokens(1_000_000)).toBe(32_000);
	});

	it("does not change native lead when min lead is 0 or undefined", () => {
		expect(resolveSpeculationLeadTokens(140_000, undefined)).toBe(17_500);
		expect(resolveSpeculationLeadTokens(140_000, 0)).toBe(17_500);
	});

	it("raises the native lead to the configured minimum", () => {
		expect(resolveSpeculationLeadTokens(50_000, 15_000)).toBe(15_000);
		expect(resolveSpeculationLeadTokens(50_000, 18_000)).toBe(18_000);
		expect(resolveSpeculationLeadTokens(140_000, 15_000)).toBe(17_500);
	});
});
