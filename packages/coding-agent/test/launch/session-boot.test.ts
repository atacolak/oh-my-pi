import { describe, expect, test } from "bun:test";
import {
	type BrokeredLaunchSelection,
	ownerArgvForSession,
	shouldBootBrokeredSession,
	stripBareResumeArgs,
	stripRpcModeArgs,
} from "../../src/launch/session-boot";
import { consumeSessionOwnerContext, SESSION_OWNER_CONTEXT_ENV } from "../../src/launch/session-owner";

function selection(overrides: Partial<BrokeredLaunchSelection> = {}): BrokeredLaunchSelection {
	return {
		mode: "text",
		print: false,
		noSession: false,
		noUi: false,
		resume: undefined,
		continue: false,
		fork: false,
		fromClaude: false,
		fromCodex: false,
		...overrides,
	};
}

function outsideOwner<T>(run: () => T): T {
	const previous = process.env[SESSION_OWNER_CONTEXT_ENV];
	delete process.env[SESSION_OWNER_CONTEXT_ENV];
	try {
		return run();
	} finally {
		if (previous !== undefined) process.env[SESSION_OWNER_CONTEXT_ENV] = previous;
	}
}

describe("shouldBootBrokeredSession", () => {
	test("every persistent interactive launch delegates to one owner", () => {
		outsideOwner(() => {
			expect(shouldBootBrokeredSession(selection(), true)).toBe(true);
			expect(shouldBootBrokeredSession(selection({ continue: true }), true)).toBe(true);
			expect(shouldBootBrokeredSession(selection({ resume: "019f-session" }), true)).toBe(true);
		});
	});

	test("ephemeral, headless and non-hosting launches stay in-process", () => {
		outsideOwner(() => {
			expect(shouldBootBrokeredSession(selection({ noSession: true }), true)).toBe(false);
			expect(shouldBootBrokeredSession(selection({ noUi: true }), true)).toBe(false);
			expect(shouldBootBrokeredSession(selection({ print: true }), true)).toBe(false);
			expect(shouldBootBrokeredSession(selection({ mode: "acp" }), false)).toBe(false);
			expect(shouldBootBrokeredSession(selection({ mode: "text" }), false)).toBe(false);
			expect(shouldBootBrokeredSession(selection({ fork: true }), true)).toBe(false);
			expect(shouldBootBrokeredSession(selection({ fromClaude: true }), true)).toBe(false);
			expect(shouldBootBrokeredSession(selection({ fromCodex: true }), true)).toBe(false);
			expect(shouldBootBrokeredSession(selection({ resume: true }), true)).toBe(false);
		});
	});

	test("persistent rpc and rpc-ui launches are brokered", () => {
		outsideOwner(() => {
			expect(shouldBootBrokeredSession(selection({ mode: "rpc" }), false)).toBe(true);
			expect(shouldBootBrokeredSession(selection({ mode: "rpc-ui" }), false)).toBe(true);
			expect(shouldBootBrokeredSession(selection({ mode: "rpc", noUi: true }), false)).toBe(false);
			expect(shouldBootBrokeredSession(selection({ mode: "rpc", noSession: true }), false)).toBe(false);
			expect(shouldBootBrokeredSession(selection({ mode: "rpc", fork: true }), false)).toBe(false);
			expect(shouldBootBrokeredSession(selection({ mode: "rpc", fromClaude: true }), false)).toBe(false);
			expect(shouldBootBrokeredSession(selection({ mode: "rpc", fromCodex: true }), false)).toBe(false);
			expect(shouldBootBrokeredSession(selection({ mode: "rpc", resume: true }), false)).toBe(false);
		});
	});

	test("an owner child never boots a second owner", () => {
		process.env[SESSION_OWNER_CONTEXT_ENV] = JSON.stringify({
			projectDir: "/tmp/project",
			name: "owner-test",
			id: "owner-generation",
		});
		expect(consumeSessionOwnerContext(process.env)).toBeDefined();
		expect(shouldBootBrokeredSession(selection(), true)).toBe(false);
		expect(shouldBootBrokeredSession(selection({ mode: "rpc" }), false)).toBe(false);
	});
});

describe("stripRpcModeArgs", () => {
	test("removes both mode spellings and their value tokens", () => {
		expect(stripRpcModeArgs(["--mode", "rpc", "--model", "fake/model"])).toEqual(["--model", "fake/model"]);
		expect(stripRpcModeArgs(["--mode=rpc-ui", "--model", "fake/model"])).toEqual(["--model", "fake/model"]);
		expect(stripRpcModeArgs(["--mode", "rpc-ui", "--mode", "rpc"])).toEqual([]);
	});

	test("keeps configuration and positionals", () => {
		expect(stripRpcModeArgs(["--resume", "abc", "hello"])).toEqual(["--resume", "abc", "hello"]);
	});
});

describe("stripBareResumeArgs", () => {
	test("drops bare selectors while keeping explicit ids and paths", () => {
		expect(stripBareResumeArgs(["--resume", "--model", "fake/model"])).toEqual(["--model", "fake/model"]);
		expect(stripBareResumeArgs(["-r", "--model", "fake/model"])).toEqual(["--model", "fake/model"]);
		expect(stripBareResumeArgs(["--resume", "019f-session", "hello"])).toEqual(["--resume", "019f-session", "hello"]);
		expect(stripBareResumeArgs(["--resume=019f-session"])).toEqual(["--resume=019f-session"]);
		expect(stripBareResumeArgs(["-r", "019f-session"])).toEqual(["-r", "019f-session"]);
	});

	test("keeps end-of-options prompt text untouched", () => {
		expect(stripBareResumeArgs(["--", "--resume"])).toEqual(["--", "--resume"]);
	});
});

describe("ownerArgvForSession", () => {
	test("replaces every one-shot selector with the resolved session", () => {
		expect(
			ownerArgvForSession(
				["--model", "fake/model", "--continue", "--fork", "019f", "--from-claude"],
				"/sessions/019f.jsonl",
			),
		).toEqual(["--model", "fake/model", "--resume", "/sessions/019f.jsonl"]);
	});

	test("handles inline and short resume spellings", () => {
		expect(ownerArgvForSession(["--resume=019f", "-c", "-r", "019e"], "/sessions/019f.jsonl")).toEqual([
			"--resume",
			"/sessions/019f.jsonl",
		]);
	});

	test("keeps positionals and end-of-options prompt text", () => {
		expect(ownerArgvForSession(["hello", "--", "--not-a-flag"], "/sessions/019f.jsonl")).toEqual([
			"hello",
			"--",
			"--not-a-flag",
			"--resume",
			"/sessions/019f.jsonl",
		]);
	});

	test("keeps flags whose value follows them", () => {
		expect(ownerArgvForSession(["--model", "fake/model", "--thinking", "high"], "019f")).toEqual([
			"--model",
			"fake/model",
			"--thinking",
			"high",
			"--resume",
			"019f",
		]);
	});
});
