import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { BashRunner } from "@oh-my-pi/pi-coding-agent/session/bash-runner";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

let temp: TempDir;
let manager: SessionManager;
beforeEach(async () => {
	temp = TempDir.createSync("@omp-bash-disposal-");
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: temp.path() });
	manager = SessionManager.inMemory(temp.path());
});
afterEach(async () => {
	vi.restoreAllMocks();
	await manager.close();
	temp.removeSync();
	resetSettingsForTest();
});

const result = {
	output: "hook result",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	totalLines: 1,
	totalBytes: 11,
	outputLines: 1,
	outputBytes: 11,
};

function runner(
	hook: () => Promise<{ result: typeof result } | undefined>,
	isDisposed: () => boolean,
	shellEnv?: () => Record<string, string>,
) {
	const extension = {
		hasHandlers: (event: string) => event === "user_bash",
		emitUserBash: hook,
		getRegisteredTool: () => ({ definition: { shellEnv } }),
	} as unknown as ExtensionRunner;
	return new BashRunner({
		agent: new Agent({ initialState: { systemPrompt: ["Test"], messages: [], tools: [] } }),
		sessionManager: manager,
		settings: Settings.isolated(),
		extensionRunner: () => extension,
		isStreaming: () => false,
		isDisposed,
	});
}

describe("bash disposal admission", () => {
	it("keeps an awaiting user_bash hook active until its result is recorded", async () => {
		const completion = Promise.withResolvers<{ result: typeof result }>();
		const bash = runner(
			() => completion.promise,
			() => false,
		);
		const pending = bash.executeBash("pending hook");
		try {
			expect(bash.isRunning).toBe(true);
		} finally {
			completion.resolve({ result });
		}
		await pending;
		expect(bash.isRunning).toBe(false);
	});

	it("refuses shell spawn when disposal begins while a user_bash hook awaits", async () => {
		const completion = Promise.withResolvers<undefined>();
		let disposed = false;
		const bash = runner(
			() => completion.promise,
			() => disposed,
		);
		const spawn = vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(result);
		const pending = bash.executeBash("must-not-spawn");
		disposed = true;
		completion.resolve(undefined);
		await expect(pending).rejects.toThrow("disposed");
		expect(spawn).not.toHaveBeenCalled();
		expect(bash.isRunning).toBe(false);
	});

	it("refuses shell spawn if the environment callback closes owner admission", async () => {
		let disposed = false;
		const bash = runner(
			async () => undefined,
			() => disposed,
			() => {
				disposed = true;
				return {};
			},
		);
		const spawn = vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(result);
		await expect(bash.executeBash("must-not-spawn", undefined, { useUserShell: true })).rejects.toThrow("disposed");
		expect(spawn).not.toHaveBeenCalled();
	});
});
