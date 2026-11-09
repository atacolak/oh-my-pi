/**
 * Typed MCP control for the shared RPC command surface: status, enable/disable
 * and OAuth reauthorization. Every transport (`runRpcMode` stdio, an attached
 * `<sessionId>.sock`) serves these through the same `RpcCommandSurface`, so
 * the behaviour is identical whether or not a TUI owns the session.
 *
 * The module mirrors `MCPCommandController` without rendering: config writes,
 * live manager mutations and session tool refreshes are the same, while the
 * client-facing presentation goes through the calling connection.
 */
import { getMCPConfigPath, logger } from "@oh-my-pi/pi-utils";
import { loadCapability } from "../../capability";
import { clearCache as clearFsCache } from "../../capability/fs";
import type { MCPServer } from "../../capability/mcp";
import type { SourceMeta } from "../../capability/types";
import { loadAllMCPConfigs } from "../../mcp/config";
import { readDisabledServers, setServerDisabled, updateMCPServer } from "../../mcp/config-writer";
import type { MCPManager } from "../../mcp/manager";
import { analyzeAuthError } from "../../mcp/oauth-discovery";
import {
	findMcpServerForAuth,
	MCPOAuthCancelledError,
	McpReauthRefusalError,
	type McpReauthOutcome,
	reauthorizeMcpServer,
	reconnectMcpManagerServer,
} from "../../mcp/oauth-reauth";
import { cfgMcpEnableProjectConfig } from "../../mcp/settings";
import type { MCPServerConfig } from "../../mcp/types";
import type { AgentSession } from "../../session/agent-session";

export type McpServerScope = "project" | "user" | "plugin";
export type McpServerTransport = "stdio" | "http" | "sse";
export type McpServerStatusState = "connected" | "connecting" | "disconnected" | "error" | "auth_required";
export type McpReauthStatus = "authorized" | "no_auth_needed";

/**
 * One server as the control surface reports it: the definition's provenance
 * and enablement plus the live manager's connection state.
 */
export interface McpServerStatusEntry {
	name: string;
	scope: McpServerScope;
	transport: McpServerTransport;
	enabled: boolean;
	status: McpServerStatusState;
	toolCount: number;
	authRequired: boolean;
	lastError?: string;
}

export type RpcMcpErrorCode = "mcp_server_not_found" | "mcp_reauth_refused" | "mcp_reauth_cancelled";

/** A failed MCP command with the wire error code the client maps on. */
export class RpcMcpCommandError extends Error {
	readonly code: RpcMcpErrorCode;

	constructor(code: RpcMcpErrorCode, message: string) {
		super(message);
		this.name = "RpcMcpCommandError";
		this.code = code;
	}
}

/**
 * Presentation bound to one RPC connection: the OAuth flow's URL, progress
 * notices and manual-code prompt all go to the client that issued the command.
 */
export interface RpcMcpUi {
	openUrl(info: { url: string; launchUrl?: string; instructions?: string }): void;
	notify(message: string, level?: "info" | "warning" | "error"): void;
	/** Resolves with the client's answer, or `undefined` when it cancels or the deadline passes. */
	input(
		title: string,
		placeholder: string,
		options: { timeoutMs: number; signal?: AbortSignal },
	): Promise<string | undefined>;
}

export interface RpcMcpControlOptions {
	session: AgentSession;
	manager: MCPManager | undefined;
}

const MCP_MANUAL_INPUT_TIMEOUT_MS = 120_000;
const NO_AUTH_REFUSAL_PREFIX = "Server connection succeeded without OAuth";
const BUILTIN_MCP_PROVIDERS: Record<string, true> = { "mcp-json": true, native: true, acp: true };

function scopeForSource(source: SourceMeta | undefined): McpServerScope | undefined {
	if (!source) return undefined;
	if (source.origin !== undefined || source.pluginName !== undefined) return "plugin";
	if (BUILTIN_MCP_PROVIDERS[source.provider] !== true) return "plugin";
	return source.level === "project" ? "project" : "user";
}

function transportFor(config: MCPServerConfig | undefined, server: MCPServer | undefined): McpServerTransport {
	if (config) return config.type ?? "stdio";
	if (server?.transport) return server.transport;
	return server?.url ? "http" : "stdio";
}

function toolServerName(tool: object): string | undefined {
	if ("mcpServerName" in tool && typeof tool.mcpServerName === "string") return tool.mcpServerName;
	return undefined;
}

/**
 * Read and mutate MCP server definitions + live connections for one command
 * surface. One instance per surface keeps the failure log continuous across
 * commands and clients while every call's UI stays scoped to its caller.
 */
export class RpcMcpControl {
	readonly #session: AgentSession;
	readonly #manager: MCPManager | undefined;
	readonly #failures = new Map<string, string>();
	readonly #unsubscribe: (() => void) | undefined;
	#seed: Promise<void> | undefined;

	constructor(options: RpcMcpControlOptions) {
		this.#session = options.session;
		this.#manager = options.manager;
		this.#unsubscribe = options.manager?.addConnectionStatusListener(event => {
			if (event.type === "failed") this.#failures.set(event.serverName, event.error);
			else if (event.type === "connected") this.#failures.delete(event.serverName);
		});
	}

	dispose(): void {
		this.#unsubscribe?.();
	}

	/**
	 * Fold failures the manager already recorded during session startup into
	 * the failure log. Called eagerly by the surface and by the first command,
	 * so a 401 that happened before any RPC client connected still reports as
	 * `auth_required` rather than looking like a clean disconnect.
	 */
	async seed(): Promise<void> {
		this.#seed ??= this.#seedStartupFailures();
		await this.#seed;
	}

	async #seedStartupFailures(): Promise<void> {
		const manager = this.#manager;
		if (!manager) return;
		try {
			const status = await manager.waitForStartup(0);
			for (const failure of status.failed) {
				if (!this.#failures.has(failure.name)) this.#failures.set(failure.name, failure.error);
			}
		} catch (error) {
			logger.debug("Could not seed MCP startup failures", { error });
		}
	}

	async listServers(): Promise<McpServerStatusEntry[]> {
		await this.seed();
		const cwd = this.#cwd();
		const loaded = await loadAllMCPConfigs(cwd, this.#loadOptions());
		const disabled = new Set(await readDisabledServers(getMCPConfigPath("user", cwd)));
		const capability = await loadCapability<MCPServer>("mcps", {
			cwd,
			includeDisabled: true,
			extensionRoots: this.#session.effectiveExtensionRoots,
		});
		const toolCounts = this.#toolCounts();
		const entries: McpServerStatusEntry[] = [];
		const seen = new Set<string>();
		for (const server of capability.all) {
			seen.add(server.name);
			const enabled =
				!disabled.has(server.name) && (loaded.configs[server.name] !== undefined || this.#isLive(server.name));
			entries.push(
				this.#entry({
					name: server.name,
					config: loaded.configs[server.name],
					capabilityServer: server,
					source: loaded.sources[server.name] ?? server._source,
					enabled,
					toolCounts,
				}),
			);
		}
		for (const name of this.#manager?.getAllServerNames() ?? []) {
			if (seen.has(name)) continue;
			seen.add(name);
			const config = this.#manager?.getServerConfig(name);
			entries.push(
				this.#entry({
					name,
					config,
					source: this.#manager?.getSource(name),
					enabled: this.#isLive(name) || !disabled.has(name),
					toolCounts,
				}),
			);
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		return entries;
	}

	async setEnabled(name: string, enabled: boolean): Promise<McpServerStatusEntry> {
		await this.seed();
		const cwd = this.#cwd();
		const manager = this.#manager;
		const userPath = getMCPConfigPath("user", cwd);
		const found = await findMcpServerForAuth(name, cwd, manager, {
			enableProjectConfig: this.#loadOptions().enableProjectConfig,
		});
		const disabled = await readDisabledServers(userPath);
		if (!found && !disabled.includes(name) && !this.#managerKnows(name)) {
			throw new RpcMcpCommandError("mcp_server_not_found", `MCP server "${name}" not found`);
		}
		if (found && !found.discovered) {
			const nextConfig: MCPServerConfig = { ...found.config };
			if (enabled) delete nextConfig.enabled;
			else nextConfig.enabled = false;
			await updateMCPServer(found.filePath, name, nextConfig);
		} else {
			await setServerDisabled(userPath, name, !enabled);
		}
		clearFsCache();
		if (!enabled) this.#failures.delete(name);
		if (manager) {
			if (enabled) await this.#connectLive(name, cwd);
			else await manager.disconnectServer(name);
			await this.#session.refreshMCPTools(manager.getTools());
		}
		const servers = await this.listServers();
		const entry = servers.find(candidate => candidate.name === name);
		if (entry) return entry;
		return this.#entry({
			name,
			config: found?.config,
			source: undefined,
			scope: found?.scope,
			enabled,
			toolCounts: this.#toolCounts(),
		});
	}

	async reauthorize(
		name: string,
		ui: RpcMcpUi,
		signal?: AbortSignal,
	): Promise<{ server: McpServerStatusEntry; status: McpReauthStatus }> {
		await this.seed();
		const cwd = this.#cwd();
		const manager = this.#manager;
		const found = await findMcpServerForAuth(name, cwd, manager, {
			enableProjectConfig: this.#loadOptions().enableProjectConfig,
		});
		if (!found) throw new RpcMcpCommandError("mcp_server_not_found", `MCP server "${name}" not found`);
		let outcome: McpReauthOutcome;
		try {
			outcome = await reauthorizeMcpServer(name, found, {
				authStorage: this.#session.modelRegistry.authStorage,
				signal,
				mcpManager: manager,
				cwd,
				onReauthorizing: () => ui.notify(`Reauthorizing "${name}"…`, "info"),
				onAuth: info => ui.openUrl({ url: info.url, launchUrl: info.launchUrl, instructions: info.instructions }),
				onProgress: message => ui.notify(message, "info"),
				onFlowComplete: () => ui.notify(`Authorization completed for "${name}".`, "info"),
				onManualCodeInput: async manualSignal => {
					const answer = await ui.input(
						`Paste the authorization code for "${name}"`,
						"authorization code or redirect URL",
						{ timeoutMs: MCP_MANUAL_INPUT_TIMEOUT_MS, signal: manualSignal },
					);
					if (answer === undefined) throw new MCPOAuthCancelledError();
					return answer.trim();
				},
			});
		} catch (error) {
			if (error instanceof McpReauthRefusalError) {
				if (error.message.startsWith(NO_AUTH_REFUSAL_PREFIX)) {
					return { server: await this.#requireEntry(name), status: "no_auth_needed" };
				}
				throw new RpcMcpCommandError("mcp_reauth_refused", error.message);
			}
			if (error instanceof MCPOAuthCancelledError) {
				throw new RpcMcpCommandError("mcp_reauth_cancelled", `Reauthorization cancelled for "${name}".`);
			}
			throw error;
		}
		if (manager) {
			await reconnectMcpManagerServer(manager, name, outcome.config);
			await this.#session.refreshMCPTools(manager.getTools());
		}
		return { server: await this.#requireEntry(name), status: "authorized" };
	}

	#cwd(): string {
		return this.#session.sessionManager.getCwd();
	}

	#loadOptions(): { enableProjectConfig: boolean; filterBrowser: boolean } {
		return {
			enableProjectConfig: cfgMcpEnableProjectConfig.get(this.#session.settings),
			filterBrowser: this.#session.getEvalPreludes().some(definition => definition.name === "browser"),
		};
	}

	#isLive(name: string): boolean {
		const status = this.#manager?.getConnectionStatus(name);
		return status === "connected" || status === "connecting";
	}

	#managerKnows(name: string): boolean {
		return this.#manager?.getServerConfig(name) !== undefined || this.#manager?.getSource(name) !== undefined;
	}

	#toolCounts(): Map<string, number> {
		const counts = new Map<string, number>();
		for (const tool of this.#manager?.getTools() ?? []) {
			const serverName = toolServerName(tool);
			if (serverName === undefined) continue;
			counts.set(serverName, (counts.get(serverName) ?? 0) + 1);
		}
		return counts;
	}

	#entry(input: {
		name: string;
		config: MCPServerConfig | undefined;
		capabilityServer?: MCPServer | undefined;
		source: SourceMeta | undefined;
		scope?: McpServerScope | undefined;
		enabled: boolean;
		toolCounts: Map<string, number>;
	}): McpServerStatusEntry {
		const connectionStatus = this.#manager?.getConnectionStatus(input.name) ?? "disconnected";
		const recorded = this.#failures.get(input.name);
		const serverUrl = input.config && "url" in input.config ? input.config.url : input.capabilityServer?.url;
		const detection = recorded === undefined ? undefined : analyzeAuthError(new Error(recorded), serverUrl);
		const authRequired = detection?.requiresAuth === true;
		const entry: McpServerStatusEntry = {
			name: input.name,
			scope: input.scope ?? scopeForSource(input.source) ?? "user",
			transport: transportFor(input.config, input.capabilityServer),
			enabled: input.enabled,
			status: "disconnected",
			toolCount: 0,
			authRequired,
		};
		if (connectionStatus === "connected") {
			entry.status = "connected";
		} else if (connectionStatus === "connecting") {
			entry.status = "connecting";
		} else if (!input.enabled) {
			entry.status = "disconnected";
		} else if (authRequired) {
			entry.status = "auth_required";
		} else if (recorded !== undefined) {
			entry.status = "error";
		}
		if (entry.status === "connected") entry.toolCount = input.toolCounts.get(input.name) ?? 0;
		if (recorded !== undefined) entry.lastError = recorded;
		return entry;
	}

	async #connectLive(name: string, cwd: string): Promise<void> {
		const manager = this.#manager;
		if (!manager) return;
		const loaded = await loadAllMCPConfigs(cwd, this.#loadOptions());
		const config = loaded.configs[name];
		const source = loaded.sources[name] ?? manager.getSource(name);
		if (!config || !source) return;
		try {
			const { errors } = await manager.connectServers({ [name]: config }, { [name]: source });
			const failure = errors.get(name);
			if (failure === undefined) this.#failures.delete(name);
			else this.#failures.set(name, failure);
		} catch (error) {
			this.#failures.set(name, error instanceof Error ? error.message : String(error));
		}
	}

	async #requireEntry(name: string): Promise<McpServerStatusEntry> {
		const servers = await this.listServers();
		const entry = servers.find(candidate => candidate.name === name);
		if (!entry) throw new RpcMcpCommandError("mcp_server_not_found", `MCP server "${name}" not found`);
		return entry;
	}
}
