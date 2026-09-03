import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, DEFAULT_RELAY_URL, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import {
	autoStartCollab,
	startCollabGuest,
	startCollabHost,
	stopCollabHost,
} from "@oh-my-pi/pi-coding-agent/collab/start";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

function context(
	overrides: Record<string, unknown> = {},
	sessionSettings = Settings.isolated(overrides as Partial<Record<SettingPath, unknown>>),
): InteractiveModeContext {
	const settings = sessionSettings;
	return {
		settings,
		collabHost: undefined,
		collabHostAbort: undefined,
		collabGuest: undefined,
		sessionManager: {
			getSessionId: () => "auto-start-test",
			getCwd: () => os.tmpdir(),
			snapshotForReplication: () => ({
				header: {
					type: "session",
					id: "auto-start-test",
					timestamp: new Date().toISOString(),
					cwd: os.tmpdir(),
				},
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			subscribe: () => () => {},
			emitNotice: () => {},
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "test",
			model: undefined,
			thinkingLevel: undefined,
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		showWarning: () => {},
		showError: () => {},
		...overrides,
	} as unknown as InteractiveModeContext;
}

afterEach(async () => {
	uninstallInMemoryRelay();
});

describe("collab auto-start", () => {
	it("is off by default", async () => {
		const ctx = context();
		await expect(autoStartCollab(ctx)).resolves.toBe(false);
		expect(ctx.collabHost).toBeUndefined();
	});

	it("starts on an explicit local relay, writes the full link, and avoids QR/link output", async () => {
		installInMemoryRelay();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const file = path.join(dir, "nested", "collab.link");
		const status: string[] = [];
		const errors: string[] = [];
		const ctx = context({
			"collab.autoStart": true,
			"collab.relayUrl": "ws://localhost:8787",
			"collab.writeLinkPath": file,
			showStatus: (text: string) => status.push(text),
			showError: (text: string) => errors.push(text),
		});
		try {
			await expect(autoStartCollab(ctx)).resolves.toBe(true);
			expect(ctx.collabHost).toBeInstanceOf(CollabHost);
			expect(errors).toEqual([]);
			expect(status).toEqual(["Collab auto-started"]);
			expect(await fs.readFile(file, "utf8")).toBe(ctx.collabHost?.link ?? "");
			expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		} finally {
			await ctx.collabHost?.stop("test done");
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("atomically replaces a permissive existing link file with mode 0600", async () => {
		installInMemoryRelay();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const file = path.join(dir, "collab.link");
		await fs.writeFile(file, "stale", { mode: 0o644 });
		const ctx = context({
			"collab.autoStart": true,
			"collab.relayUrl": "ws://localhost:8787",
			"collab.writeLinkPath": file,
		});
		try {
			await expect(autoStartCollab(ctx)).resolves.toBe(true);
			expect(await fs.readFile(file, "utf8")).toBe(ctx.collabHost?.link ?? "");
			expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		} finally {
			await ctx.collabHost?.stop("test done");
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("serializes concurrent host starts into one relay connection", async () => {
		const ctx = context();
		const gate = Promise.withResolvers<void>();
		const start = spyOn(CollabHost.prototype, "start").mockImplementation(async () => gate.promise);
		try {
			const first = startCollabHost(ctx, { relayUrl: "ws://localhost:8787" });
			const second = startCollabHost(ctx, { relayUrl: "ws://localhost:8787" });
			expect(start).toHaveBeenCalledTimes(1);
			gate.resolve();
			const [firstHost, secondHost] = await Promise.all([first, second]);
			expect(secondHost).toBe(firstHost);
			expect(ctx.collabHost).toBe(firstHost);
			expect(ctx.collabHostStart).toBeUndefined();
		} finally {
			start.mockRestore();
		}
	});

	it("blocks guest joins while host startup owns the collab role", async () => {
		const ctx = context();
		const gate = Promise.withResolvers<void>();
		const start = spyOn(CollabHost.prototype, "start").mockImplementation(async () => gate.promise);
		try {
			const pending = startCollabHost(ctx, { relayUrl: "ws://localhost:8787" });
			await expect(startCollabGuest(ctx, "invalid link")).rejects.toThrow("Stop hosting first");
			expect(ctx.collabGuest).toBeUndefined();
			gate.resolve();
			await pending;
		} finally {
			await ctx.collabHost?.stop("test done");
			start.mockRestore();
		}
	});

	it("tears down a completed host if a guest appears during startup", async () => {
		const ctx = context();
		const gate = Promise.withResolvers<void>();
		const start = spyOn(CollabHost.prototype, "start").mockImplementation(async () => gate.promise);
		const stop = spyOn(CollabHost.prototype, "stop").mockResolvedValue();
		try {
			const pending = startCollabHost(ctx, { relayUrl: "ws://localhost:8787" });
			ctx.collabGuest = {} as InteractiveModeContext["collabGuest"];
			gate.resolve();
			await expect(pending).rejects.toThrow("Cannot host while joined as a guest");
			expect(stop).toHaveBeenCalledWith("guest joined while host was starting");
			expect(ctx.collabHost).toBeUndefined();
			expect(ctx.collabHostStart).toBeUndefined();
		} finally {
			start.mockRestore();
			stop.mockRestore();
		}
	});

	it("cancels a pending host handshake from stop before the host attaches", async () => {
		const ctx = context();
		const connect = spyOn(CollabSocket.prototype, "connect").mockImplementation(() => {});
		try {
			const pending = startCollabHost(ctx, { relayUrl: "ws://localhost:8787" });
			pending.catch(() => {});
			await Promise.resolve();
			expect(ctx.collabHostAbort).toBeDefined();
			expect(ctx.collabHostStart).toBeDefined();
			await expect(stopCollabHost(ctx)).resolves.toBe(true);
			await expect(pending).rejects.toThrow("Collab host start cancelled");
			expect(ctx.collabHost).toBeUndefined();
			expect(ctx.collabHostStart).toBeUndefined();
		} finally {
			connect.mockRestore();
		}
	});

	it("does not attach or write a link after a cancelled pending start", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const file = path.join(dir, "collab.link");
		const connect = spyOn(CollabSocket.prototype, "connect").mockImplementation(() => {});
		try {
			const ctx = context({
				"collab.autoStart": true,
				"collab.relayUrl": "ws://localhost:8787",
				"collab.writeLinkPath": file,
			});
			const pending = autoStartCollab(ctx);
			pending.catch(() => {});
			await Promise.resolve();
			await expect(stopCollabHost(ctx)).resolves.toBe(true);
			await expect(pending).resolves.toBe(false);
			expect(ctx.collabHost).toBeUndefined();
			expect(await Bun.file(file).exists()).toBe(false);
		} finally {
			connect.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses project-configured auto-start before connecting or writing", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const agentDir = path.join(dir, "agent");
		const projectDir = path.join(dir, "project");
		const target = path.join(dir, "sensitive");
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await Bun.write(
			path.join(projectDir, ".omp", "config.yml"),
			`collab:\n  autoStart: true\n  relayUrl: ws://localhost:8787\n  writeLinkPath: ${target}\n`,
		);
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir, inMemory: true });
		const warnings: string[] = [];
		const ctx = context({ showWarning: (text: string) => warnings.push(text) }, settings);
		const start = spyOn(CollabHost.prototype, "start");
		try {
			await expect(autoStartCollab(ctx)).resolves.toBe(false);
			expect(start).not.toHaveBeenCalled();
			expect(await Bun.file(target).exists()).toBe(false);
			expect(warnings.join(" ")).toContain("outside project settings");
		} finally {
			start.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("ignores a project-configured link path when auto-start is user-configured", async () => {
		installInMemoryRelay();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const agentDir = path.join(dir, "agent");
		const projectDir = path.join(dir, "project");
		const target = path.join(dir, "sensitive");
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"collab:\n  autoStart: true\n  relayUrl: ws://localhost:8787\n",
		);
		await Bun.write(path.join(projectDir, ".omp", "config.yml"), `collab:\n  writeLinkPath: ${target}\n`);
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const warnings: string[] = [];
		const ctx = context({ showWarning: (text: string) => warnings.push(text) }, settings);
		try {
			await expect(autoStartCollab(ctx)).resolves.toBe(true);
			expect(await Bun.file(target).exists()).toBe(false);
			expect(warnings.join(" ")).toContain("link file skipped");
		} finally {
			await ctx.collabHost?.stop("test done");
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses the implicit public relay", async () => {
		const warnings: string[] = [];
		const ctx = context({ "collab.autoStart": true, showWarning: (text: string) => warnings.push(text) });
		await expect(autoStartCollab(ctx)).resolves.toBe(false);
		expect(ctx.collabHost).toBeUndefined();
		expect(warnings.join(" ")).toContain("collab.relayUrl");
	});

	it("allows an explicitly configured public relay", async () => {
		installInMemoryRelay();
		const ctx = context({ "collab.autoStart": true, "collab.relayUrl": DEFAULT_RELAY_URL });
		const start = spyOn(CollabHost.prototype, "start").mockImplementation(async function (this: CollabHost) {
			Object.defineProperties(this, { link: { value: "full-link", configurable: true } });
		});
		try {
			await expect(autoStartCollab(ctx)).resolves.toBe(true);
			expect(start.mock.calls[0]?.[0]).toBe(DEFAULT_RELAY_URL);
		} finally {
			start.mockRestore();
		}
	});

	it("keeps the host when the write-link file cannot be written", async () => {
		installInMemoryRelay();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const blocker = path.join(dir, "not-a-dir");
		await fs.writeFile(blocker, "file");
		const errors: string[] = [];
		const ctx = context({
			"collab.autoStart": true,
			"collab.relayUrl": "ws://localhost:8787",
			"collab.writeLinkPath": path.join(blocker, "collab.link"),
			showError: (text: string) => errors.push(text),
		});
		try {
			await expect(autoStartCollab(ctx)).resolves.toBe(true);
			expect(ctx.collabHost).toBeInstanceOf(CollabHost);
			expect(errors.join(" ")).toContain("write collab link file");
		} finally {
			await ctx.collabHost?.stop("test done");
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("lets a guest join from the written link without /collab", async () => {
		installInMemoryRelay();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-auto-"));
		const file = path.join(dir, "collab.link");
		const ctx = context({
			"collab.autoStart": true,
			"collab.relayUrl": "ws://localhost:8787",
			"collab.writeLinkPath": file,
		});
		let socket: CollabSocket | undefined;
		try {
			await expect(autoStartCollab(ctx)).resolves.toBe(true);
			const link = (await fs.readFile(file, "utf8")).trim();
			const hostLink = ctx.collabHost?.link;
			if (!hostLink) throw new Error("auto-start did not attach a host link");
			expect(link).toBe(hostLink);
			const parsed = parseCollabLink(link);
			if ("error" in parsed) throw new Error(parsed.error);
			expect(parsed.writeToken).toBeDefined();
			const key = await importRoomKey(parsed.key);
			socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
			const { promise, resolve } = Promise.withResolvers<{ t: string; proto?: number }>();
			socket.onFrame = frame => {
				if (frame.t === "welcome" || frame.t === "error") resolve(frame);
			};
			const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
			socket.onOpen = () => socket?.send({ t: "hello", proto: COLLAB_PROTO, name: "desk", writeToken });
			socket.connect();
			const reply = await promise;
			expect(reply.t).toBe("welcome");
			expect(reply.proto).toBe(COLLAB_PROTO);
			expect(ctx.collabHost?.participants.some(p => p.name === "desk" && p.role === "guest")).toBe(true);
		} finally {
			socket?.close();
			await ctx.collabHost?.stop("test done");
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("skips guests and an existing host", async () => {
		const guest = context({ "collab.autoStart": true, collabGuest: {} });
		expect(await autoStartCollab(guest)).toBe(false);
		const host = context({ "collab.autoStart": true, collabHost: {} });
		expect(await autoStartCollab(host)).toBe(false);
	});
});
