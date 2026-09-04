import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import type { InteractiveModeContext } from "../modes/types";
import { expandTilde } from "../tools/path-utils";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";
import { replaceFileAtomically } from "../utils/atomic-file";
import { CollabGuestLink } from "./guest";
import { CollabHost } from "./host";
import { DEFAULT_RELAY_URL } from "./protocol";

const hostStartAborts = new WeakMap<Promise<CollabHost>, AbortController>();

export const COLLAB_HOST_START_CANCELLED = "Collab host start cancelled";

export interface StartCollabOptions {
	relayUrl: string;
	webUrl?: string;
	writeLinkPath?: string;
}

/** Start a host and attach it to the interactive context. */
export async function startCollabHost(ctx: InteractiveModeContext, options: StartCollabOptions): Promise<CollabHost> {
	if (ctx.session.isDisposed) throw new Error(COLLAB_HOST_START_CANCELLED);
	if (ctx.collabGuest || ctx.collabGuestStart) throw new Error("Cannot host while joining as a guest");
	if (ctx.collabHost) return ctx.collabHost;
	if (ctx.collabHostStart) return ctx.collabHostStart;
	const abort = new AbortController();
	ctx.collabHostAbort = abort;
	const start = startCollabHostOnce(ctx, options, abort.signal);
	hostStartAborts.set(start, abort);
	ctx.collabHostStart = start;
	try {
		return await start;
	} finally {
		if (ctx.collabHostStart === start) ctx.collabHostStart = undefined;
		if (ctx.collabHostAbort === abort) ctx.collabHostAbort = undefined;
		hostStartAborts.delete(start);
	}
}

/** Join a guest session while reserving the collab role against host startup. */
export async function startCollabGuest(ctx: InteractiveModeContext, link: string): Promise<CollabGuestLink> {
	if (ctx.collabHost || ctx.collabHostStart) throw new Error("Stop hosting first (/collab stop)");
	if (ctx.collabGuest) return ctx.collabGuest;
	if (ctx.collabGuestStart) return ctx.collabGuestStart;
	const guest = new CollabGuestLink(ctx);
	const start = guest.join(link).then(() => guest);
	ctx.collabGuestStart = start;
	try {
		return await start;
	} finally {
		if (ctx.collabGuestStart === start) ctx.collabGuestStart = undefined;
	}
}

async function startCollabHostOnce(
	ctx: InteractiveModeContext,
	options: StartCollabOptions,
	signal: AbortSignal,
): Promise<CollabHost> {
	const host = new CollabHost(ctx);
	try {
		await host.start(options.relayUrl, options.webUrl ?? "", signal);
	} catch (error) {
		if (signal.aborted) throw new Error(COLLAB_HOST_START_CANCELLED);
		throw error;
	}
	if (signal.aborted || ctx.session.isDisposed || ctx.collabGuest || ctx.collabGuestStart) {
		await host.stop(
			signal.aborted || ctx.session.isDisposed ? "host start cancelled" : "guest joined while host was starting",
		);
		throw new Error(
			signal.aborted || ctx.session.isDisposed ? COLLAB_HOST_START_CANCELLED : "Cannot host while joined as a guest",
		);
	}
	ctx.collabHost = host;
	const writeLinkPath = options.writeLinkPath?.trim()
		? resolveCollabLinkPath(options.writeLinkPath, ctx.sessionManager.getCwd())
		: undefined;
	if (writeLinkPath && ctx.collabHost === host && !signal.aborted && !ctx.session.isDisposed) {
		try {
			await writeCollabLink(writeLinkPath, host.link, signal);
		} catch (error) {
			ctx.showError(`Failed to write collab link file: ${sanitizeCollabError(error)}`);
		}
	}
	if (ctx.collabHost !== host || signal.aborted || ctx.session.isDisposed) {
		await host.stop("host start cancelled");
		throw new Error(COLLAB_HOST_START_CANCELLED);
	}
	return host;
}

/** Cancel an in-flight host handshake or stop an attached host. */
export async function stopCollabHost(ctx: InteractiveModeContext, reason = "host stopped"): Promise<boolean> {
	const pending = ctx.collabHostStart;
	const abort = pending ? hostStartAborts.get(pending) : undefined;
	const settled = pending?.then(
		() => undefined,
		() => undefined,
	);
	abort?.abort();
	ctx.collabHostAbort?.abort();
	const host = ctx.collabHost;
	if (host) await host.stop(reason);
	if (settled) await settled;
	return host !== undefined || pending !== undefined;
}

function resolveCollabLinkPath(rawPath: string, ctxCwd: string): string {
	const expanded = expandTilde(rawPath.trim());
	return path.isAbsolute(expanded) ? expanded : path.resolve(ctxCwd, expanded);
}

async function withCollabLinkLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
	await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	return await withFileLock(target, fn);
}

async function writeCollabLink(target: string, link: string, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	const tempPath = path.join(
		path.dirname(target),
		`.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`,
	);
	await withCollabLinkLock(target, async () => {
		if (signal?.aborted) return;
		let removeTemp = false;
		try {
			const handle = await fs.open(tempPath, "wx", 0o600);
			removeTemp = true;
			try {
				await handle.writeFile(link, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			if (signal?.aborted) return;
			await replaceFileAtomically(tempPath, target);
			removeTemp = false;
		} finally {
			if (removeTemp) await fs.rm(tempPath, { force: true }).catch(() => {});
		}
	});
}

function sanitizeCollabError(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	const text = shortenEmbeddedPaths(
		replaceTabs(sanitizeText(detail))
			.replace(/[\r\n]+/g, " ")
			.trim(),
	);
	return truncateToWidth(text.length > 0 ? text : "Unknown error", TRUNCATE_LENGTHS.CONTENT);
}

function shortenEmbeddedPaths(text: string): string {
	return text
		.split(" ")
		.map(segment => {
			const leading = segment.match(/^[("'`[]*/)?.[0] ?? "";
			const trailing = segment.match(/[)"'`,.;:\]]*$/)?.[0] ?? "";
			const end = segment.length - trailing.length;
			if (leading.length >= end) return segment;
			return `${leading}${shortenPath(segment.slice(leading.length, end))}${trailing}`;
		})
		.join(" ");
}

export function resolveRelayUrl(input: string): string {
	const trimmed = input.trim();
	return trimmed.includes("://") ? trimmed : `wss://${trimmed}`;
}

/** Start the configured host once during interactive startup. */
export async function autoStartCollab(ctx: InteractiveModeContext): Promise<boolean> {
	if (ctx.collabGuest || ctx.collabHost || !ctx.settings.get("collab.autoStart")) return false;
	const autoStartProvenance = ctx.settings.getProvenance("collab.autoStart");
	if (autoStartProvenance === "project" || autoStartProvenance === "overlay") {
		ctx.showWarning("Collab auto-start skipped: configure collab.autoStart outside project settings.");
		return false;
	}
	const relayInput = ctx.settings.get("collab.relayUrl")?.trim() ?? "";
	if (!relayInput) {
		ctx.showWarning("Collab auto-start skipped: set collab.relayUrl to a relay endpoint.");
		return false;
	}
	const relayUrl = resolveRelayUrl(relayInput);
	if (relayUrl === DEFAULT_RELAY_URL && !ctx.settings.isConfigured("collab.relayUrl")) {
		ctx.showWarning("Collab auto-start skipped: configure collab.relayUrl explicitly before using the public relay.");
		return false;
	}
	const configuredLinkPath = ctx.settings.get("collab.writeLinkPath") ?? "";
	const writeLinkProvenance = ctx.settings.getProvenance("collab.writeLinkPath");
	const writeLinkPath =
		writeLinkProvenance === "project" || writeLinkProvenance === "overlay" ? "" : configuredLinkPath;
	if (configuredLinkPath.trim() && !writeLinkPath) {
		ctx.showWarning("Collab link file skipped: configure collab.writeLinkPath outside project settings.");
	}
	try {
		await startCollabHost(ctx, {
			relayUrl,
			webUrl: ctx.settings.get("collab.webUrl") ?? "",
			writeLinkPath,
		});
		ctx.showStatus("Collab auto-started", { dim: true });
		return true;
	} catch (error) {
		if (error instanceof Error && error.message === COLLAB_HOST_START_CANCELLED) return false;
		ctx.showError(`Failed to auto-start collab session: ${sanitizeCollabError(error)}`);
		return false;
	}
}
