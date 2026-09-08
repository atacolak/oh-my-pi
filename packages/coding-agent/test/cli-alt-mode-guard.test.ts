import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("runRootCommand — --alt mode guard", () => {
	const previousBackend = Bun.env.PI_TUI_RENDER_BACKEND;

	afterEach(() => {
		if (previousBackend === undefined) {
			delete Bun.env.PI_TUI_RENDER_BACKEND;
		} else {
			Bun.env.PI_TUI_RENDER_BACKEND = previousBackend;
		}
	});

	it("rejects --alt combined with --print", async () => {
		using tempDir = TempDir.createSync("@omp-alt-print-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const previousExitCode = process.exitCode;
		const captured: string[] = [];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
			captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit:${code ?? 0}`);
		}) as never);

		const parsed = parseArgs(["--alt", "--print", "hello"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.path();

		try {
			await expect(
				runRootCommand(parsed, ["--alt", "--print", "hello"], {
					discoverAuthStorage: async () => authStorage,
					settings,
					createAgentSession: async () => {
						throw new Error("should not create session with --alt --print");
					},
				}),
			).rejects.toThrow(/process\.exit:2/);
		} finally {
			stderrSpy.mockRestore();
			exitSpy.mockRestore();
			process.exitCode = previousExitCode ?? 0;
		}

		const stderr = captured.join("");
		expect(stderr).toContain("Error: --alt is only supported in interactive mode");
		expect(Bun.env.PI_TUI_RENDER_BACKEND).not.toBe("app-viewport");
	});

	it("rejects --alt combined with --mode rpc", async () => {
		using tempDir = TempDir.createSync("@omp-alt-rpc-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const previousExitCode = process.exitCode;
		const captured: string[] = [];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
			captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit:${code ?? 0}`);
		}) as never);

		const parsed = parseArgs(["--alt", "--mode", "rpc"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.path();

		try {
			await expect(
				runRootCommand(parsed, ["--alt", "--mode", "rpc"], {
					discoverAuthStorage: async () => authStorage,
					settings,
					createAgentSession: async () => {
						throw new Error("should not create session with --alt --mode rpc");
					},
				}),
			).rejects.toThrow(/process\.exit:2/);
		} finally {
			stderrSpy.mockRestore();
			exitSpy.mockRestore();
			process.exitCode = previousExitCode ?? 0;
		}

		const stderr = captured.join("");
		expect(stderr).toContain("Error: --alt is only supported in interactive mode");
		expect(Bun.env.PI_TUI_RENDER_BACKEND).not.toBe("app-viewport");
	});

	it("sets PI_TUI_RENDER_BACKEND=app-viewport for interactive --alt", async () => {
		using tempDir = TempDir.createSync("@omp-alt-interactive-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const previousExitCode = process.exitCode;
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit:${code ?? 0}`);
		}) as never);

		const parsed = parseArgs(["--alt"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.path();

		try {
			await runRootCommand(parsed, ["--alt"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async () => {
					expect(Bun.env.PI_TUI_RENDER_BACKEND).toBe("app-viewport");
					throw new Error("stop after backend env is set");
				},
			});
			throw new Error("expected createAgentSession to abort");
		} catch (error) {
			expect(String(error)).toContain("stop after backend env is set");
		} finally {
			exitSpy.mockRestore();
			process.exitCode = previousExitCode ?? 0;
		}
	});
});
