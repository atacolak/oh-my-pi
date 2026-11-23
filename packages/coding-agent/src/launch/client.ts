import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { getGlobalDaemonRuntimeDir, isEexist, isEnoent, logger, postmortem, toError } from "@oh-my-pi/pi-utils";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";
import { canonicalProjectDir, daemonBrokerEndpoint, daemonRuntimeDir } from "./paths";
import {
	DAEMON_BROKER_WORKER_ARG,
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	DAEMON_TERMINAL_PROTOCOL_VERSION,
	type DaemonCompletionNotification,
	type DaemonOperation,
	type DaemonRpcResult,
	type DaemonTerminalNotification,
	type DaemonWireMessage,
	parseDaemonRpcResult,
	parseDaemonWireMessage,
} from "./protocol";

const CONNECT_TIMEOUT_MS = 10_000;
const CONNECT_RETRY_MS = 50;
const TOKEN_FILE = "broker.token";
/**
 * The broker must outlive whichever omp process happened to spawn it: other
 * clients (and persistent daemons) still hold its lease. Bun on Windows puts
 * every non-detached child in a kill-on-close job object owned by the parent,
 * so an undetached broker died with its spawner and took the scope's daemons
 * with it. Detached, it has no console; its daemons then spawn hidden.
 */
const BROKER_SPAWN_OPTIONS = { detached: true, windowsHide: true } as const;

interface PendingRequest {
	operation: DaemonOperation;
	resolve: (result: DaemonRpcResult) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	removeAbort?: () => void;
}

type IdleCancellation = Extract<DaemonOperation, { op: "terminal_idle_cancel" }>;

function idleLeaseKey(name: string, id: string, lease: string): string {
	return `${name}\u0000${id}\u0000${lease}`;
}

function idleCancellationKey(operation: IdleCancellation): string {
	return idleLeaseKey(operation.name, operation.id, operation.lease);
}

/** Broker location and lifecycle overrides used by smoke tests and isolated consumers. */
export interface DaemonBrokerClientOptions {
	/** Runtime directory override; defaults to the project-scoped config path. */
	runtimeDir?: string;
	/** Last-client shutdown grace override in milliseconds. */
	idleGraceMs?: number;
	existingOnly?: boolean;
}

export interface DaemonCompletionUnregisterOptions {
	/** Detach this process without deleting broker-persisted pending notifications. */
	preservePending?: boolean;
}

/** Persistent per-process connection to one project or global daemon broker. */
export interface DaemonBrokerClient {
	onCompletion(
		owner: string,
		sink: (notification: DaemonCompletionNotification) => Promise<void> | void,
	): (options?: DaemonCompletionUnregisterOptions) => void;
	/**
	 * Register the sink for one terminal subscription before asking the broker to start or attach it.
	 * Returns an unsubscribe; dropping a sink never sends a detach, so losing a mirror leaks nothing.
	 */
	subscribeTerminal(subscriptionId: string, sink: (notification: DaemonTerminalNotification) => void): () => void;
	/** Hear that the broker connection dropped, so a terminal mirror can stop waiting for frames. */
	onDisconnect?(listener: () => void): () => void;
	/** Canonical project directory or synthetic directory identifying a global scope. */
	readonly projectDir: string;
	request(operation: DaemonOperation, signal?: AbortSignal): Promise<DaemonRpcResult>;
	close(): void;
}

/** A request reached the broker and the broker rejected the operation. */
export class DaemonBrokerRejectedError extends Error {}

/** The reached broker predates terminal streams; it must be replaced, never worked around. */
export class DaemonTerminalUnsupportedError extends Error {}

/** Fail closed unless the reached broker implements terminal streams. */
export async function requireTerminalProtocol(client: DaemonBrokerClient): Promise<void> {
	const result = await client.request({ op: "ping" });
	const version = result.op === "ping" ? result.terminalProtocolVersion : undefined;
	if (version !== DAEMON_TERMINAL_PROTOCOL_VERSION) {
		throw new DaemonTerminalUnsupportedError(
			`Daemon broker ${client.projectDir} does not implement terminal streams (protocol ${version ?? "absent"}); ` +
				"restart it with a current omp",
		);
	}
}

async function readOrCreateToken(runtimeDir: string): Promise<string> {
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const tokenPath = path.join(runtimeDir, TOKEN_FILE);
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			// node:fs, not Bun.file().text(): on Windows (Bun 1.4.2) a Bun.file
			// read that rejects with ENOENT holds no event-loop ref, so the loop
			// drains mid-await — `omp --smoke-test` exited 1 via the unsettled-entry
			// guard, and a bare script silently stops at that await.
			const token = (await fs.readFile(tokenPath, "utf8")).trim();
			if (token.length > 0) return token;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}

		try {
			const handle = await fs.open(tokenPath, "wx", 0o600);
			try {
				const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
				await handle.writeFile(token, "utf8");
				return token;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (!isEexist(error)) throw error;
		}
		await Bun.sleep(10);
	}
	throw new Error(`Timed out initializing daemon broker token in ${runtimeDir}`);
}

function requestTimeoutMs(operation: DaemonOperation): number {
	switch (operation.op) {
		case "start":
			return (operation.spec.ready?.timeoutMs ?? CONNECT_TIMEOUT_MS) + 5_000;
		case "wait":
		case "logs":
		case "stop":
			return operation.timeoutMs + 5_000;
		default:
			return 30_000;
	}
}

class SocketDaemonClient implements DaemonBrokerClient {
	readonly projectDir: string;
	readonly #runtimeDir: string;
	readonly #endpoint: string;
	#token: string;
	readonly #seenCompletionIds = new Set<string>();
	readonly #idleGraceMs: number | undefined;
	readonly #existingOnly: boolean;
	readonly #pending = new Map<string, PendingRequest>();
	/**
	 * Retirement cancellations whose reply was lost with the connection. They are
	 * transport operations, never lease facts: retried on the next restored
	 * connection until the broker answers, and discarded as soon as it does.
	 */
	readonly #pendingIdleCancellations = new Map<string, IdleCancellation>();
	readonly #completionSinks = new Map<string, (notification: DaemonCompletionNotification) => Promise<void> | void>();
	readonly #terminalSinks = new Map<string, (notification: DaemonTerminalNotification) => void>();
	readonly #completionUnsubscribes = new Set<string>();
	readonly #preservedCompletionOwners = new Set<string>();
	readonly #completionReplays = new Set<string>();
	readonly #inFlightCompletionIds = new Set<string>();
	readonly #completionSubscriptionId = crypto.randomUUID();
	#socket: IpcConnection | undefined;
	#connectPromise: Promise<void> | undefined;
	#closed = false;
	#completionReconnectTimer: NodeJS.Timeout | undefined;
	readonly #disconnectListeners = new Set<() => void>();

	constructor(projectDir: string, runtimeDir: string, token: string, options: DaemonBrokerClientOptions) {
		this.projectDir = projectDir;
		this.#runtimeDir = runtimeDir;
		this.#endpoint = daemonBrokerEndpoint(runtimeDir);
		this.#token = token;
		this.#idleGraceMs = options.idleGraceMs;
		this.#existingOnly = options.existingOnly === true;
	}

	async request(operation: DaemonOperation, signal?: AbortSignal): Promise<DaemonRpcResult> {
		if (this.#closed) throw new Error("Daemon broker client is closed");
		if (signal?.aborted) throw new Error("Daemon broker request aborted");
		if (operation.op === "terminal_idle_cancel") {
			// Queue before connecting: a cancellation whose reply is lost, or that
			// cannot even reach the broker yet, must stay retryable.
			this.#pendingIdleCancellations.set(idleCancellationKey(operation), operation);
		} else if (operation.op === "terminal_idle_prepare" && operation.lease !== undefined) {
			// An acknowledged acquisition supersedes a queued cancellation for the
			// same identity; resending it later would withdraw the renewed fence.
			this.#pendingIdleCancellations.delete(idleLeaseKey(operation.name, operation.id, operation.lease));
		}
		try {
			// Retirement addresses an already running generation; it must never bootstrap a replacement broker.
			await this.#connect(operation.op === "terminal_idle_prepare" || operation.op === "terminal_idle_cancel");
			// Drain old cancellations before the current frame on this same transport.
			this.#retryPendingIdleCancellations(
				operation.op === "terminal_idle_cancel" ? idleCancellationKey(operation) : undefined,
			);
			return await this.#dispatch(operation, signal);
		} catch (error) {
			if (this.#pendingIdleCancellations.size > 0) this.#scheduleCompletionReconnect();
			throw error;
		}
	}

	/** Ride the connection this request just established to settle cancellations left unresolved. */
	#retryPendingIdleCancellations(skipped: string | undefined): void {
		if (this.#pendingIdleCancellations.size === 0) return;
		const inFlight = new Set<string>();
		for (const pending of this.#pending.values()) {
			if (pending.operation.op === "terminal_idle_cancel") {
				inFlight.add(idleCancellationKey(pending.operation));
			}
		}
		for (const [key, operation] of this.#pendingIdleCancellations) {
			if (key === skipped || inFlight.has(key)) continue;
			void this.#dispatch(operation).catch(() => this.#scheduleCompletionReconnect());
		}
	}

	async #dispatch(operation: DaemonOperation, signal?: AbortSignal): Promise<DaemonRpcResult> {
		const socket = this.#socket;
		if (!socket || socket.closed) throw new Error("Daemon broker socket is unavailable");
		if (operation.op === "terminal_idle_cancel") {
			this.#pendingIdleCancellations.set(idleCancellationKey(operation), operation);
		}

		const completionUnsubscribes = [...this.#completionUnsubscribes];
		const completionReplays = [...this.#completionReplays];
		const id = crypto.randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<DaemonRpcResult>();
		const timer = setTimeout(() => {
			const pending = this.#pending.get(id);
			if (!pending) return;
			this.#pending.delete(id);
			pending.removeAbort?.();
			reject(new Error(`Daemon ${operation.op} request timed out`));
		}, requestTimeoutMs(operation));
		const pending: PendingRequest = { operation, resolve, reject, timer };
		if (signal) {
			const abort = (): void => {
				if (!this.#pending.delete(id)) return;
				clearTimeout(timer);
				reject(new Error("Daemon broker request aborted"));
				// Dropping the local entry alone leaves the broker polling a wait or
				// follow until its own timeout; ask it to stop. The answer is unread.
				if ((operation.op === "wait" || operation.op === "logs") && !socket.closed) {
					socket.send(
						JSON.stringify({
							id: crypto.randomUUID(),
							token: this.#token,
							operation: { op: "cancel", requestId: id } satisfies DaemonOperation,
						}),
					);
				}
			};
			signal.addEventListener("abort", abort, { once: true });
			pending.removeAbort = () => signal.removeEventListener("abort", abort);
		}
		this.#pending.set(id, pending);
		socket.send(
			JSON.stringify({
				id,
				token: this.#token,
				owners: [...this.#completionSinks.keys()],
				detachedOwners: [...this.#preservedCompletionOwners],
				completionEvents: true,
				completionUnsubscribes,
				completionReplays,
				completionSubscriptionId: this.#completionSubscriptionId,
				operation,
			}),
		);
		const result = await promise;
		for (const owner of completionUnsubscribes) {
			if (!this.#completionSinks.has(owner)) this.#completionUnsubscribes.delete(owner);
		}
		for (const owner of completionReplays) {
			if (this.#completionSinks.has(owner)) this.#completionReplays.delete(owner);
		}
		return result;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		clearTimeout(this.#completionReconnectTimer);
		this.#completionReconnectTimer = undefined;
		this.#socket?.destroy();
		this.#completionSinks.clear();
		this.#terminalSinks.clear();
		this.#preservedCompletionOwners.clear();
		this.#completionReplays.clear();
		this.#pendingIdleCancellations.clear();
		this.#socket = undefined;
		this.#rejectPending(new Error("Daemon broker client closed"));
	}

	onDisconnect(listener: () => void): () => void {
		this.#disconnectListeners.add(listener);
		return () => {
			this.#disconnectListeners.delete(listener);
		};
	}

	subscribeTerminal(subscriptionId: string, sink: (notification: DaemonTerminalNotification) => void): () => void {
		if (this.#closed) throw new Error("Daemon broker client is closed");
		this.#terminalSinks.set(subscriptionId, sink);
		return () => {
			if (this.#terminalSinks.get(subscriptionId) !== sink) return;
			this.#terminalSinks.delete(subscriptionId);
		};
	}

	onCompletion(
		owner: string,
		sink: (notification: DaemonCompletionNotification) => Promise<void> | void,
	): (options?: DaemonCompletionUnregisterOptions) => void {
		this.#completionUnsubscribes.delete(owner);
		if (this.#preservedCompletionOwners.delete(owner)) this.#completionReplays.add(owner);
		this.#completionSinks.set(owner, sink);
		this.#publishCompletionOwners();
		return options => {
			if (this.#completionSinks.get(owner) !== sink) return;
			this.#completionSinks.delete(owner);
			if (options?.preservePending) {
				this.#preservedCompletionOwners.add(owner);
			} else {
				this.#preservedCompletionOwners.delete(owner);
				this.#completionUnsubscribes.add(owner);
			}
			if (
				this.#completionSinks.size === 0 &&
				this.#pendingIdleCancellations.size === 0 &&
				this.#completionReconnectTimer
			) {
				clearTimeout(this.#completionReconnectTimer);
				this.#completionReconnectTimer = undefined;
			}
			this.#publishCompletionOwners();
		};
	}

	#publishCompletionOwners(): void {
		if (this.#closed) return;
		const cancellation = this.#pendingIdleCancellations.values().next().value;
		const operation: DaemonOperation = cancellation ?? { op: "ping" };
		void this.request(operation).catch(() => this.#scheduleCompletionReconnect());
	}

	#scheduleCompletionReconnect(): void {
		if (
			this.#closed ||
			(this.#completionSinks.size === 0 && this.#pendingIdleCancellations.size === 0) ||
			this.#completionReconnectTimer !== undefined ||
			(this.#socket !== undefined && !this.#socket.closed && this.#pendingIdleCancellations.size === 0)
		) {
			return;
		}
		this.#completionReconnectTimer = setTimeout(
			() => {
				this.#completionReconnectTimer = undefined;
				if (this.#completionSinks.size === 0 && this.#pendingIdleCancellations.size === 0) return;
				this.#publishCompletionOwners();
			},
			this.#pendingIdleCancellations.size > 0 ? 1000 : CONNECT_RETRY_MS,
		);
		this.#completionReconnectTimer.unref();
	}

	async #connect(existingOnly = false): Promise<void> {
		if (this.#socket && !this.#socket.closed) return;
		if (this.#connectPromise) return this.#connectPromise;
		this.#connectPromise = this.#connectOnce(existingOnly);
		try {
			await this.#connectPromise;
		} finally {
			this.#connectPromise = undefined;
		}
	}

	async #connectOnce(existingOnly: boolean): Promise<void> {
		if (this.#existingOnly || existingOnly) {
			this.#bindSocket(await IpcConnection.connect(this.#endpoint, { framing: "lines", timeoutMs: 250 }));
			return;
		}
		// The broker authenticates against the token file it read at startup. A
		// replacement broker may have started from a different file, or a deleted
		// runtime dir may need a fresh one before any broker can start.
		this.#token = await readOrCreateToken(this.#runtimeDir);
		try {
			this.#bindSocket(await IpcConnection.connect(this.#endpoint, { framing: "lines", timeoutMs: 250 }));
			return;
		} catch {
			// No live broker. Multiple clients may race to spawn; the broker's
			// process-owned lease selects one winner before any candidate touches
			// the socket.
		}
		this.#spawnBroker();
		const deadline = Date.now() + CONNECT_TIMEOUT_MS;
		let lastError: Error | undefined;
		while (Date.now() < deadline) {
			try {
				this.#bindSocket(await IpcConnection.connect(this.#endpoint, { framing: "lines", timeoutMs: 250 }));
				return;
			} catch (error) {
				lastError = toError(error);
				await Bun.sleep(CONNECT_RETRY_MS);
			}
		}
		throw new Error(
			`Failed to start daemon broker at ${this.#endpoint} after ${CONNECT_TIMEOUT_MS / 1000}s: ` +
				`${lastError?.message ?? "socket unavailable"}. Scope: ${this.#runtimeDir}. ` +
				"Run `omp --smoke-test` to verify broker startup, or `omp ps` to inspect supervised processes.",
		);
	}

	#spawnBroker(): void {
		const spawn = resolveWorkerSpawnCmd(DAEMON_BROKER_WORKER_ARG);
		const overlay: Record<string, string> = {
			[DAEMON_PROJECT_DIR_ENV]: this.projectDir,
			[DAEMON_RUNTIME_DIR_ENV]: this.#runtimeDir,
		};
		if (this.#idleGraceMs !== undefined) overlay[DAEMON_IDLE_GRACE_ENV] = String(this.#idleGraceMs);
		const child = Bun.spawn(spawn.cmd, {
			cwd: spawn.cwd,
			env: workerEnvFromParent(overlay),
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			...BROKER_SPAWN_OPTIONS,
		});
		child.unref();
	}

	#bindSocket(socket: IpcConnection): void {
		this.#socket = socket;
		socket.start(
			line => this.#onLine(line),
			() => {
				// One stable error regardless of the close reason.
				if (this.#socket === socket) this.#socket = undefined;
				for (const listener of [...this.#disconnectListeners]) {
					try {
						listener();
					} catch (error) {
						logger.warn("Daemon broker disconnect listener failed", {
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
				this.#rejectPending(new Error("Daemon broker connection closed"));
				this.#scheduleCompletionReconnect();
			},
		);
	}

	#onLine(line: string): void {
		let decoded: unknown;
		try {
			decoded = JSON.parse(line);
		} catch (error) {
			this.#rejectPending(toError(error));
			return;
		}
		let message: DaemonWireMessage;
		try {
			message = parseDaemonWireMessage(decoded);
		} catch (error) {
			const parseError = toError(error);
			if (
				typeof decoded === "object" &&
				decoded !== null &&
				"event" in decoded &&
				typeof decoded.event === "string"
			) {
				logger.warn("Ignoring malformed daemon notification", {
					event: decoded.event,
					error: parseError.message,
				});
				return;
			}
			this.#rejectPending(parseError);
			return;
		}
		if ("event" in message) {
			if (message.event === "daemon-completed") {
				void this.#deliverCompletion(message);
			} else {
				this.#terminalSinks.get(message.subscriptionId)?.(message);
			}
			return;
		}
		const response = message;
		const pending = this.#pending.get(response.id);
		if (!pending) return;
		this.#pending.delete(response.id);
		clearTimeout(pending.timer);
		pending.removeAbort?.();
		// Any authoritative answer settles the cancellation; retrying a rejected
		// cancel forever would outlive the operation it belongs to.
		if (pending.operation.op === "terminal_idle_cancel") {
			this.#pendingIdleCancellations.delete(idleCancellationKey(pending.operation));
		}
		if (!response.ok) {
			pending.reject(new DaemonBrokerRejectedError(response.error));
			return;
		}
		try {
			pending.resolve(parseDaemonRpcResult(pending.operation, response.result));
		} catch (error) {
			pending.reject(toError(error));
		}
	}

	async #deliverCompletion(message: DaemonCompletionNotification): Promise<void> {
		if (this.#seenCompletionIds.has(message.completionId)) {
			this.#ackCompletion(message.completionId);
			return;
		}
		if (this.#inFlightCompletionIds.has(message.completionId)) return;
		const sink = this.#completionSinks.get(message.owner);
		if (!sink) return;
		this.#inFlightCompletionIds.add(message.completionId);
		try {
			await sink(message);
			if (this.#seenCompletionIds.size >= 512) {
				const oldest = this.#seenCompletionIds.values().next().value;
				if (oldest !== undefined) this.#seenCompletionIds.delete(oldest);
			}
			this.#seenCompletionIds.add(message.completionId);
			this.#ackCompletion(message.completionId);
		} catch (error) {
			logger.warn("Daemon completion sink failed", {
				owner: message.owner,
				completionId: message.completionId,
				error: error instanceof Error ? error.message : String(error),
			});
			this.#socket?.destroy();
		} finally {
			this.#inFlightCompletionIds.delete(message.completionId);
		}
	}

	#ackCompletion(completionId: string): void {
		const socket = this.#socket;
		if (!socket || socket.closed) return;
		socket.send(
			JSON.stringify({
				id: crypto.randomUUID(),
				token: this.#token,
				owners: [...this.#completionSinks.keys()],
				detachedOwners: [...this.#preservedCompletionOwners],
				completionEvents: true,
				completionAcks: [completionId],
				completionUnsubscribes: [...this.#completionUnsubscribes],
				completionSubscriptionId: this.#completionSubscriptionId,
				operation: { op: "ping" },
			}),
		);
	}

	#rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.removeAbort?.();
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

const sharedClients = new Map<string, Promise<DaemonBrokerClient>>();
let cancelExitCleanup: (() => void) | undefined;

function sharedDaemonClient(key: string, create: () => Promise<DaemonBrokerClient>): Promise<DaemonBrokerClient> {
	let pending = sharedClients.get(key);
	if (!pending) {
		pending = create();
		sharedClients.set(key, pending);
		if (!cancelExitCleanup) {
			cancelExitCleanup = postmortem.register("daemon-broker-clients", () => closeDaemonClients());
		}
	}
	return pending;
}

/** Create an independent socket connection to one daemon broker scope. */
export async function createDaemonBrokerClient(
	projectDir: string,
	options: DaemonBrokerClientOptions = {},
): Promise<DaemonBrokerClient> {
	const canonical = await canonicalProjectDir(projectDir);
	const runtimeDir = options.runtimeDir ?? daemonRuntimeDir(canonical);
	const token = options.existingOnly
		? (await fs.readFile(path.join(runtimeDir, TOKEN_FILE), "utf8")).trim()
		: await readOrCreateToken(runtimeDir);
	return new SocketDaemonClient(canonical, runtimeDir, token, options);
}

/** Get the process-shared daemon broker client for one canonical project directory. */
export async function daemonClientForProject(projectDir: string): Promise<DaemonBrokerClient> {
	const canonical = await canonicalProjectDir(projectDir);
	return sharedClientForRuntimeDir(canonical, daemonRuntimeDir(canonical));
}

/** Owner coordinates whose terminal generation a cooperative close wants to fence. */
export interface SessionOwnerIdleRetirementTarget {
	readonly projectDir: string;
	readonly name: string;
	readonly id: string;
	/** Broker scope the owner was launched under; defaults to the project's canonical scope. */
	readonly runtimeDir?: string;
	/**
	 * Caller-owned nonce naming this acquisition attempt. Retrying a prepare with
	 * the same nonce after an ambiguous reply returns the same fence instead of
	 * being refused as another caller's pending lease; keeping it also lets
	 * {@link cancelSessionOwnerIdleRetirement} clear a fence whose handle was lost.
	 */
	readonly lease?: string;
}

/** One acquisition attempt by generation plus nonce, sufficient to withdraw its fence. */
export interface SessionOwnerIdleRetirementFence extends SessionOwnerIdleRetirementTarget {
	readonly lease: string;
}

/** Held fence over one owner generation; releasing it lets viewers attach again. */
export interface SessionOwnerIdleRetirement extends AsyncDisposable {
	readonly name: string;
	readonly id: string;
	readonly lease: string;
	/**
	 * Withdraw the fence. Resolves once the broker answered, whether it held the
	 * fence or had already settled it; a failed attempt rejects and is not
	 * remembered, so calling it again retries over a fresh connection.
	 */
	release(): Promise<void>;
}

async function sharedClientForRuntimeDir(projectDir: string, runtimeDir: string): Promise<DaemonBrokerClient> {
	const canonical = await canonicalProjectDir(projectDir);
	const scope = await fs.realpath(runtimeDir).catch(() => path.resolve(runtimeDir));
	return sharedDaemonClient(`runtime:${scope}`, () => createDaemonBrokerClient(canonical, { runtimeDir: scope }));
}

function ownerBrokerClient(projectDir: string, runtimeDir: string | undefined): Promise<DaemonBrokerClient> {
	return runtimeDir === undefined
		? daemonClientForProject(projectDir)
		: sharedClientForRuntimeDir(projectDir, runtimeDir);
}

function cancelIdleRetirement(
	client: DaemonBrokerClient,
	name: string,
	id: string,
	lease: string,
): Promise<DaemonRpcResult> {
	return client.request({ op: "terminal_idle_cancel", name, id, lease });
}

/**
 * Withdraw a fence without a live retirement handle, for example after an
 * acquisition whose reply was lost. Cancellation is pinned to the exact
 * generation and nonce, so it can never reopen a newer generation.
 */
export async function cancelSessionOwnerIdleRetirement(fence: SessionOwnerIdleRetirementFence): Promise<void> {
	const client = await ownerBrokerClient(fence.projectDir, fence.runtimeDir);
	await cancelIdleRetirement(client, fence.name, fence.id, fence.lease);
}

/**
 * Ask the owner's broker to refuse new terminal viewers for this exact persistent
 * terminal generation while the owner closes cooperatively. `undefined` means the
 * broker refused (a viewer is still attached, the generation is stale, or the
 * terminal is not a running persistent owner) or stayed unreachable; a refusal
 * never entitles the owner to exit. The returned fence is released by `release()`
 * or by `await using`; a lost prepare reply is retried under the same nonce, and
 * a failed release rejects instead of being remembered.
 */
export async function prepareSessionOwnerIdleRetirement(
	owner: SessionOwnerIdleRetirementTarget,
): Promise<SessionOwnerIdleRetirement | undefined> {
	const lease = owner.lease ?? crypto.randomUUID();
	let client: DaemonBrokerClient;
	try {
		client = await ownerBrokerClient(owner.projectDir, owner.runtimeDir);
	} catch {
		return undefined;
	}
	const prepare = (): Promise<DaemonRpcResult> =>
		client.request({ op: "terminal_idle_prepare", name: owner.name, id: owner.id, lease });
	const acquire = async (): Promise<Extract<DaemonRpcResult, { op: "terminal_idle_prepare" }> | undefined> => {
		try {
			const first = await prepare();
			return first.op === "terminal_idle_prepare" ? first : undefined;
		} catch (error) {
			if (error instanceof DaemonBrokerRejectedError) return undefined;
		}
		try {
			// The reply was lost, not necessarily the acquisition: the nonce makes
			// this retry an acknowledgement of whichever attempt reached the broker.
			const retried = await prepare();
			return retried.op === "terminal_idle_prepare" ? retried : undefined;
		} catch {
			// The first reply is ambiguous, so the broker may already hold this nonce's
			// fence even though the retry failed. Queue the withdrawal under the same
			// nonce; it is retried over later connections instead of stranding the
			// generation behind a fence nobody can release.
			await cancelIdleRetirement(client, owner.name, owner.id, lease).catch(() => undefined);
			return undefined;
		}
	};
	const prepared = await acquire();
	if (!prepared) return undefined;
	let released = false;
	let releasing: Promise<void> | undefined;
	const release = (): Promise<void> => {
		if (released) return Promise.resolve();
		releasing ??= (async () => {
			try {
				await cancelIdleRetirement(client, prepared.name, prepared.id, prepared.lease);
				released = true;
			} finally {
				releasing = undefined;
			}
		})();
		return releasing;
	};
	return {
		name: prepared.name,
		id: prepared.id,
		lease: prepared.lease,
		release,
		[Symbol.asyncDispose]: release,
	};
}

/** Get the process-shared client that leases one profile-independent, machine-global daemon broker. */
export async function daemonClientForGlobal(service: string): Promise<DaemonBrokerClient> {
	const runtimeDir = getGlobalDaemonRuntimeDir(service);
	// Canonicalize only after creation so the first caller and later callers
	// derive the same Windows pipe key even when an ancestor is a symlink.
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const canonical = await fs.realpath(runtimeDir);
	return sharedDaemonClient(`global:${canonical}`, () =>
		createDaemonBrokerClient(canonical, {
			runtimeDir: canonical,
		}),
	);
}

/** Close every project and machine-global broker connection held by this omp process. */
export async function closeDaemonClients(): Promise<void> {
	const pending = [...sharedClients.values()];
	sharedClients.clear();
	for (const client of await Promise.all(pending)) client.close();
	cancelExitCleanup?.();
	cancelExitCleanup = undefined;
}

/** Exercise worker-host broker startup and authenticated RPC for distribution smoke tests. */
export async function smokeTestDaemonBroker(): Promise<void> {
	// Keep the broker's runtime dir under a private parent this process owns, so
	// the broker's dead-scope sweep (pruneDeadDaemonRuntimeDirs, fired on startup)
	// can only ever reclaim siblings inside it — never unrelated neighbours in
	// os.tmpdir() such as tmux/ssh sockets or build trees (issue #8721).
	const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-smoke-"));
	const projectDir = path.join(smokeRoot, "project");
	const runtimeDir = path.join(smokeRoot, "run");
	await fs.mkdir(projectDir, { recursive: true });
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	try {
		const ping = await client.request({ op: "ping" });
		if (ping.op !== "ping" || ping.projectDir !== client.projectDir) throw new Error("daemon broker ping mismatch");
		await client.request({ op: "shutdown" });
	} finally {
		client.close();
		await fs.rm(smokeRoot, { recursive: true, force: true });
	}
}
