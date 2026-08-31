import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import {
	findServerRoot,
	getServersForFile,
	loadConfig,
	resolveServersForFile,
} from "@oh-my-pi/pi-coding-agent/lsp/config";
import { formatContent, getDiagnosticsForFile } from "@oh-my-pi/pi-coding-agent/lsp/diagnostics";
import { discoverStartupLspServers } from "@oh-my-pi/pi-coding-agent/lsp/servers";
import type { LinterClient, LspClient, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { createLspWritethrough } from "@oh-my-pi/pi-coding-agent/lsp/writethrough";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import * as piUtils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";

const settings = Settings.isolated();

function makeLspSession(cwd: string, additionalDirectories?: string[]): ToolSession {
	return { cwd, additionalDirectories, settings } as ToolSession;
}

function mockLspClient(config: ServerConfig, cwd: string): LspClient {
	return {
		name: config.command,
		cwd: config.resolvedRoot ?? cwd,
		config,
		proc: {} as LspClient["proc"],
		requestId: 0,
		diagnostics: new Map(),
		diagnosticsVersion: 0,
		openFiles: new Map(),
		pendingRequests: new Map(),
		messageBuffer: new Uint8Array(),
		isReading: false,
		status: "ready",
		lastActivity: Date.now(),
		writeQueue: Promise.resolve(),
		activeProgressTokens: new Set(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {},
		serverCapabilities: { hoverProvider: true },
	} as unknown as LspClient;
}

function writePythonProject(
	root: string,
	relativeDir: string,
	fileName: string,
): { projectRoot: string; filePath: string } {
	const projectRoot = path.join(root, relativeDir);
	const srcDir = path.join(projectRoot, "src");
	fs.mkdirSync(srcDir, { recursive: true });
	fs.writeFileSync(path.join(projectRoot, "pyproject.toml"), '[project]\nname = "nested"\n');
	const filePath = path.join(srcDir, fileName);
	fs.writeFileSync(filePath, "def example():\n    return 1\n");
	return { projectRoot, filePath };
}

function writeLocalPythonServer(projectRoot: string, command = "basedpyright-langserver"): string {
	const binDir = path.join(projectRoot, ".venv", process.platform === "win32" ? "Scripts" : "bin");
	fs.mkdirSync(binDir, { recursive: true });
	const resolved = process.platform === "win32" ? path.join(binDir, `${command}.exe`) : path.join(binDir, command);
	fs.writeFileSync(resolved, "");
	fs.chmodSync(resolved, 0o755);
	return resolved;
}

let homeOverride: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
	originalHome = process.env.HOME;
	homeOverride = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lsp-nested-home-"));
	process.env.HOME = homeOverride;
	vi.spyOn(os, "homedir").mockReturnValue(homeOverride);
});

afterEach(async () => {
	await lspClient.shutdownAll();
	vi.restoreAllMocks();
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (homeOverride) fs.rmSync(homeOverride, { recursive: true, force: true });
	homeOverride = undefined;
});

describe("nested LSP project roots", () => {
	it("does not auto-detect a nested language project at session cwd", () => {
		const tempDir = TempDir.createSync("@omp-lsp-nested-startup-");
		try {
			writePythonProject(tempDir.path(), "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);

			const config = loadConfig(tempDir.path());
			expect(config.servers.basedpyright).toBeUndefined();
			expect(config.definitions?.basedpyright).toBeDefined();
			expect(discoverStartupLspServers(tempDir.path()).map(server => server.name)).not.toContain("basedpyright");
		} finally {
			tempDir.removeSync();
		}
	});

	it("resolves a nested python project from a concrete file", () => {
		const tempDir = TempDir.createSync("@omp-lsp-nested-python-");
		try {
			const { projectRoot, filePath } = writePythonProject(tempDir.path(), "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);

			const config = loadConfig(tempDir.path());
			const resolved = resolveServersForFile(config, filePath, [tempDir.path()]);
			const basedpyright = resolved.find(server => server.name === "basedpyright");
			expect(basedpyright?.root).toBe(projectRoot);
			expect(basedpyright?.config.resolvedRoot).toBe(projectRoot);
			expect(basedpyright?.config.resolvedCommand).toBe("/usr/bin/basedpyright-langserver");
		} finally {
			tempDir.removeSync();
		}
	});

	it("prefers a nested project-local executable over PATH", () => {
		const tempDir = TempDir.createSync("@omp-lsp-nested-venv-");
		try {
			const { projectRoot, filePath } = writePythonProject(tempDir.path(), "python", "example.py");
			const localBin = writeLocalPythonServer(projectRoot);
			vi.spyOn(piUtils, "$which").mockReturnValue("/usr/bin/basedpyright-langserver");

			const config = loadConfig(tempDir.path());
			const resolved = resolveServersForFile(config, filePath, [tempDir.path()]);
			expect(resolved.find(server => server.name === "basedpyright")?.config.resolvedCommand).toBe(localBin);
			expect(piUtils.$which).not.toHaveBeenCalledWith("basedpyright-langserver");
		} finally {
			tempDir.removeSync();
		}
	});

	it("uses a hoisted workspace executable for a nested project", () => {
		const tempDir = TempDir.createSync("@omp-lsp-hoisted-bin-");
		try {
			fs.writeFileSync(path.join(tempDir.path(), "package.json"), "{}\n");
			const nested = path.join(tempDir.path(), "packages", "app");
			fs.mkdirSync(path.join(nested, "src"), { recursive: true });
			fs.writeFileSync(path.join(nested, "package.json"), "{}\n");
			const filePath = path.join(nested, "src", "index.ts");
			fs.writeFileSync(filePath, "export const value = 1;\n");
			const binDir = path.join(tempDir.path(), "node_modules", ".bin");
			fs.mkdirSync(binDir, { recursive: true });
			const hoistedBin = path.join(binDir, "typescript-language-server");
			fs.writeFileSync(hoistedBin, "");
			fs.chmodSync(hoistedBin, 0o755);
			vi.spyOn(piUtils, "$which").mockReturnValue(null);

			const config = loadConfig(tempDir.path());
			expect(config.servers["typescript-language-server"]?.resolvedCommand).toBe(hoistedBin);
			const resolved = resolveServersForFile(config, filePath, [tempDir.path()]);
			const typescript = resolved.find(server => server.name === "typescript-language-server");
			expect(typescript?.root).toBe(nested);
			expect(typescript?.config.resolvedCommand).toBe(hoistedBin);
		} finally {
			tempDir.removeSync();
		}
	});

	it("does not reuse the primary workspace executable for an additional workspace", () => {
		const primary = TempDir.createSync("@omp-lsp-primary-bin-");
		const additional = TempDir.createSync("@omp-lsp-additional-bin-");
		try {
			fs.writeFileSync(path.join(primary.path(), "package.json"), "{}\n");
			const binDir = path.join(primary.path(), "node_modules", ".bin");
			fs.mkdirSync(binDir, { recursive: true });
			const primaryBin = path.join(binDir, "typescript-language-server");
			fs.writeFileSync(primaryBin, "");
			fs.chmodSync(primaryBin, 0o755);

			const nested = path.join(additional.path(), "packages", "app");
			fs.mkdirSync(path.join(nested, "src"), { recursive: true });
			fs.writeFileSync(path.join(nested, "package.json"), "{}\n");
			const filePath = path.join(nested, "src", "index.ts");
			fs.writeFileSync(filePath, "export const value = 1;\n");
			vi.spyOn(piUtils, "$which").mockReturnValue(null);

			const config = loadConfig(primary.path());
			expect(config.servers["typescript-language-server"]?.resolvedCommand).toBe(primaryBin);
			const resolved = resolveServersForFile(config, filePath, [primary.path(), additional.path()]);
			expect(resolved.find(server => server.name === "typescript-language-server")).toBeUndefined();
		} finally {
			primary.removeSync();
			additional.removeSync();
		}
	});

	it("roots dot-marker server definitions at the containing workspace", () => {
		const tempDir = TempDir.createSync("@omp-lsp-dot-marker-");
		try {
			const fileA = path.join(tempDir.path(), "src", "a.ts");
			const fileB = path.join(tempDir.path(), "test", "b.ts");
			fs.mkdirSync(path.dirname(fileA), { recursive: true });
			fs.mkdirSync(path.dirname(fileB), { recursive: true });
			fs.writeFileSync(fileA, "export const a = 1;\n");
			fs.writeFileSync(fileB, "export const b = 1;\n");
			const server: ServerConfig = {
				command: "plugin-lsp",
				fileTypes: ["ts"],
				rootMarkers: ["."],
			};
			const config = { servers: {}, definitions: { plugin: server } };
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "plugin-lsp" ? "/usr/bin/plugin-lsp" : null,
			);

			const resolvedA = resolveServersForFile(config, fileA, [tempDir.path()]);
			const resolvedB = resolveServersForFile(config, fileB, [tempDir.path()]);
			expect(resolvedA[0]?.root).toBe(tempDir.path());
			expect(resolvedB[0]?.root).toBe(tempDir.path());
		} finally {
			tempDir.removeSync();
		}
	});

	it("selects the nearest nested root over a parent project", () => {
		const tempDir = TempDir.createSync("@omp-lsp-nearest-root-");
		try {
			fs.writeFileSync(path.join(tempDir.path(), "pyproject.toml"), '[project]\nname = "root"\n');
			const nested = writePythonProject(tempDir.path(), "nested", "foo.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);

			const config = loadConfig(tempDir.path());
			expect(config.servers.basedpyright).toBeDefined();
			const resolved = resolveServersForFile(config, nested.filePath, [tempDir.path()]);
			expect(resolved.find(server => server.name === "basedpyright")?.root).toBe(nested.projectRoot);
		} finally {
			tempDir.removeSync();
		}
	});

	it("roots the same language server separately for sibling projects", () => {
		const tempDir = TempDir.createSync("@omp-lsp-multi-root-");
		try {
			const a = writePythonProject(tempDir.path(), "a", "a.py");
			const b = writePythonProject(tempDir.path(), "b", "b.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);

			const config = loadConfig(tempDir.path());
			const resolvedA = resolveServersForFile(config, a.filePath, [tempDir.path()]);
			const resolvedB = resolveServersForFile(config, b.filePath, [tempDir.path()]);
			expect(resolvedA.find(server => server.name === "basedpyright")?.root).toBe(a.projectRoot);
			expect(resolvedB.find(server => server.name === "basedpyright")?.root).toBe(b.projectRoot);
		} finally {
			tempDir.removeSync();
		}
	});

	it("keeps root-level auto-detect unchanged", () => {
		const tempDir = TempDir.createSync("@omp-lsp-root-level-");
		try {
			fs.writeFileSync(path.join(tempDir.path(), "pyproject.toml"), '[project]\nname = "root"\n');
			const filePath = path.join(tempDir.path(), "src", "foo.py");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "x = 1\n");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);

			const config = loadConfig(tempDir.path());
			expect(config.servers.basedpyright?.resolvedCommand).toBe("/usr/bin/basedpyright-langserver");
			const resolved = resolveServersForFile(config, filePath, [tempDir.path()]);
			expect(resolved.find(server => server.name === "basedpyright")?.root).toBe(tempDir.path());
		} finally {
			tempDir.removeSync();
		}
	});

	it("does not walk ancestors above the session workspace", () => {
		const tempDir = TempDir.createSync("@omp-lsp-boundary-");
		try {
			fs.writeFileSync(path.join(tempDir.path(), "pyproject.toml"), '[project]\nname = "outside"\n');
			const workspace = path.join(tempDir.path(), "workspace");
			const filePath = path.join(workspace, "src", "foo.py");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "x = 1\n");

			expect(findServerRoot(filePath, ["pyproject.toml"], [workspace])).toBeNull();
			const config = loadConfig(workspace);
			expect(
				resolveServersForFile(config, filePath, [workspace]).find(server => server.name === "basedpyright"),
			).toBeUndefined();
		} finally {
			tempDir.removeSync();
		}
	});

	it("starts a nested server from a concrete lsp tool call", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-nested-tool-");
		try {
			const { projectRoot, filePath } = writePythonProject(tempDir.path(), "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			const roots: string[] = [];
			vi.spyOn(lspClient, "getOrCreateClient").mockImplementation(async (config, cwd) => {
				roots.push(config.resolvedRoot ?? cwd);
				return mockLspClient(config, cwd);
			});
			vi.spyOn(lspClient, "ensureFileOpen").mockResolvedValue();
			vi.spyOn(lspClient, "sendRequest").mockResolvedValue({
				contents: { kind: "markdown", value: "nested-root-hover" },
			});

			const tool = new LspTool(makeLspSession(tempDir.path()));
			const result = await tool.execute("nested-hover", {
				action: "hover",
				file: filePath,
				line: 1,
				symbol: "example",
			});
			const text = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");

			expect(text).toContain("nested-root-hover");
			expect(roots).toContain(projectRoot);
			expect(discoverStartupLspServers(tempDir.path()).map(s => s.name)).not.toContain("basedpyright");
		} finally {
			tempDir.removeSync();
		}
	});

	it("routes nested edit/write diagnostics through the nested project root", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-nested-write-");
		try {
			const { projectRoot, filePath } = writePythonProject(tempDir.path(), "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);

			const roots: string[] = [];
			vi.spyOn(lspClient, "getOrCreateClient").mockImplementation(async (config, cwd) => {
				roots.push(config.resolvedRoot ?? cwd);
				return mockLspClient(config, cwd);
			});

			const writethrough = createLspWritethrough(tempDir.path(), { enableDiagnostics: true, enableFormat: false });
			await writethrough(filePath, "def example():\n    return 2\n");
			expect(roots).toContain(projectRoot);
		} finally {
			tempDir.removeSync();
		}
	});

	it("routes writes through directories added after write-tool construction", async () => {
		const primary = TempDir.createSync("@omp-lsp-add-dir-primary-");
		const additional = TempDir.createSync("@omp-lsp-add-dir-extra-");
		try {
			const nested = writePythonProject(additional.path(), "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			vi.spyOn(lspClient, "getOrCreateClient").mockImplementation(async (config, cwd) => mockLspClient(config, cwd));
			vi.spyOn(lspClient, "syncContent").mockResolvedValue();
			vi.spyOn(lspClient, "notifySaved").mockResolvedValue();
			vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();
			let extraDirs: string[] | undefined;
			const session = {
				cwd: primary.path(),
				get additionalDirectories() {
					return extraDirs;
				},
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated({
					"lsp.formatOnWrite": false,
					"lsp.diagnosticsOnWrite": true,
				}),
				enableLsp: true,
			} as ToolSession;
			const tool = new WriteTool(session);
			extraDirs = [additional.path()];
			const getServers = vi.spyOn(lspConfig, "getServersForFile");

			await tool.execute("add-dir-write", {
				path: nested.filePath,
				content: "def example():\n    return 2\n",
			});

			expect(getServers.mock.calls.some(call => call[2]?.includes(additional.path()))).toBe(true);
		} finally {
			primary.removeSync();
			additional.removeSync();
		}
	});

	it("registers a lazy session owner on write-through client creation", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-lazy-owner-write-");
		try {
			const { filePath } = writePythonProject(tempDir.path(), "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			const owner = lspClient.createLspClientOwner();
			const createdOwners: unknown[] = [];
			vi.spyOn(lspClient, "getOrCreateClient").mockImplementation(
				async (config, cwd, _timeout, _signal, clientOwner) => {
					createdOwners.push(clientOwner);
					return mockLspClient(config, cwd);
				},
			);
			vi.spyOn(lspClient, "syncContent").mockResolvedValue();
			vi.spyOn(lspClient, "notifySaved").mockResolvedValue();
			vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();
			const session = {
				cwd: tempDir.path(),
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				getLspClientOwner: () => owner,
				settings: Settings.isolated({
					"lsp.formatOnWrite": false,
					"lsp.diagnosticsOnWrite": true,
				}),
				enableLsp: true,
			} as ToolSession;

			await new WriteTool(session).execute("lazy-owner-write", {
				path: filePath,
				content: "def example():\n    return 2\n",
			});

			expect(createdOwners).toContain(owner);
		} finally {
			tempDir.removeSync();
		}
	});

	it("roots custom linter diagnostics and formatting at each nested project", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-nested-linter-");
		try {
			const projectA = path.join(tempDir.path(), "a");
			const projectB = path.join(tempDir.path(), "b");
			fs.mkdirSync(projectA);
			fs.mkdirSync(projectB);
			const fileA = path.join(projectA, "a.ts");
			const fileB = path.join(projectB, "b.ts");
			fs.writeFileSync(fileA, "const a = 1;\n");
			fs.writeFileSync(fileB, "const b = 1;\n");
			const createdRoots: string[] = [];
			const createClient = (_config: ServerConfig, cwd: string): LinterClient => {
				createdRoots.push(cwd);
				return {
					format: async (_filePath, content) => `${content}// ${path.basename(cwd)}\n`,
					lint: async () => [],
				};
			};
			const server: ServerConfig = {
				command: "nested-linter",
				fileTypes: ["ts"],
				rootMarkers: [],
				createClient,
			};
			const serverA: ServerConfig = { ...server, resolvedRoot: projectA };
			const serverB: ServerConfig = { ...server, resolvedRoot: projectB };

			await getDiagnosticsForFile(fileA, tempDir.path(), [["nested-linter", serverA]]);
			const formattedA = await formatContent(fileA, "const a = 1;\n", tempDir.path(), [["nested-linter", serverA]]);
			const formattedB = await formatContent(fileB, "const b = 1;\n", tempDir.path(), [["nested-linter", serverB]]);

			expect(createdRoots).toEqual([projectA, projectB]);
			expect(formattedA.content).toContain("// a");
			expect(formattedB.content).toContain("// b");
		} finally {
			tempDir.removeSync();
		}
	});

	it("clears a nested initialization failure using the resolved root identity", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-nested-reload-failure-");
		try {
			const nestedRoot = path.join(tempDir.path(), "python");
			fs.mkdirSync(nestedRoot);
			const config: ServerConfig = {
				command: "broken-nested-lsp",
				fileTypes: ["py"],
				rootMarkers: [],
				resolvedRoot: nestedRoot,
			};
			let spawnCount = 0;
			vi.spyOn(piUtils.ptree, "spawn").mockImplementation((() => {
				spawnCount++;
				const { promise: exited, resolve } = Promise.withResolvers<number>();
				return {
					stdin: {
						write: () => Promise.reject(new Error("nested init failed")),
						flush: () => Promise.resolve(),
					},
					stdout: new ReadableStream<Uint8Array>(),
					stderr: new ReadableStream<Uint8Array>(),
					exited,
					exitCode: null,
					kill: () => resolve(1),
					peekStderr: () => "",
				};
			}) as unknown as typeof piUtils.ptree.spawn);
			await expect(lspClient.getOrCreateClient(config, tempDir.path())).rejects.toThrow("nested init failed");
			await expect(lspClient.getOrCreateClient(config, tempDir.path())).rejects.toThrow(
				"failed to initialize recently",
			);
			expect(spawnCount).toBe(1);

			lspClient.clearInitializationFailure(config, tempDir.path());
			await expect(lspClient.getOrCreateClient(config, tempDir.path())).rejects.toThrow("nested init failed");
			expect(spawnCount).toBe(2);
		} finally {
			tempDir.removeSync();
		}
	});

	it("workspace reload clears nested initialization failures owned by that session", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-nested-workspace-reload-failure-");
		try {
			const nested = writePythonProject(tempDir.path(), "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			let spawnCount = 0;
			vi.spyOn(piUtils.ptree, "spawn").mockImplementation((() => {
				spawnCount++;
				const { promise: exited, resolve } = Promise.withResolvers<number>();
				return {
					stdin: {
						write: () => Promise.reject(new Error("nested init failed")),
						flush: () => Promise.resolve(),
					},
					stdout: new ReadableStream<Uint8Array>(),
					stderr: new ReadableStream<Uint8Array>(),
					exited,
					exitCode: null,
					kill: () => resolve(1),
					peekStderr: () => "",
				};
			}) as unknown as typeof piUtils.ptree.spawn);

			const owner = lspClient.createLspClientOwner();
			const tool = new LspTool(makeLspSession(tempDir.path()), owner);
			const firstFailure = await tool.execute("nested-failure", {
				action: "hover",
				file: nested.filePath,
				line: 1,
				symbol: "example",
			});
			expect(firstFailure.content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("nested init failed"),
			});
			expect(spawnCount).toBe(1);
			await tool.execute("nested-workspace-reload", { action: "reload", file: "*" });
			const retryFailure = await tool.execute("nested-retry", {
				action: "hover",
				file: nested.filePath,
				line: 1,
				symbol: "example",
			});
			expect(retryFailure.content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("nested init failed"),
			});
			expect(spawnCount).toBe(2);
		} finally {
			tempDir.removeSync();
		}
	});

	it("does not change cwd-only getServersForFile matching", () => {
		const tempDir = TempDir.createSync("@omp-lsp-cwd-api-");
		try {
			writePythonProject(tempDir.path(), "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			const config = loadConfig(tempDir.path());
			expect(getServersForFile(config, path.join(tempDir.path(), "python", "src", "example.py"))).toEqual([]);
		} finally {
			tempDir.removeSync();
		}
	});
});
