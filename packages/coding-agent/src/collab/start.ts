import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { InteractiveModeContext } from "../modes/types";
import { expandTilde } from "../tools/path-utils";
import { replaceFileAtomically } from "../utils/atomic-file";
import { CollabGuestLink } from "./guest";
import { CollabHost } from "./host";
import { DEFAULT_RELAY_URL } from "./protocol";

export interface StartCollabOptions {
	relayUrl: string;
	webUrl?: string;
	writeLinkPath?: string;
}

/** Start a host and attach it to the interactive context. */
export async function startCollabHost(ctx: InteractiveModeContext, options: StartCollabOptions): Promise<CollabHost> {
	if (ctx.collabGuest || ctx.collabGuestStart) throw new Error("Cannot host while joining as a guest");
	if (ctx.collabHost) return ctx.collabHost;
	if (ctx.collabHostStart) return ctx.collabHostStart;
	const start = startCollabHostOnce(ctx, options);
	ctx.collabHostStart = start;
	try {
		return await start;
	} finally {
		if (ctx.collabHostStart === start) ctx.collabHostStart = undefined;
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

async function startCollabHostOnce(ctx: InteractiveModeContext, options: StartCollabOptions): Promise<CollabHost> {
	const host = new CollabHost(ctx);
	await host.start(options.relayUrl, options.webUrl ?? "");
	if (ctx.collabGuest || ctx.collabGuestStart) {
		await host.stop("guest joined while host was starting");
		throw new Error("Cannot host while joined as a guest");
	}
	ctx.collabHost = host;
	if (options.writeLinkPath?.trim()) {
		try {
			await writeCollabLink(options.writeLinkPath, host.link, ctx.sessionManager.getCwd());
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			ctx.showError(`Failed to write collab link file: ${detail}`);
		}
	}
	return host;
}

async function writeCollabLink(rawPath: string, link: string, ctxCwd: string): Promise<void> {
	const expanded = expandTilde(rawPath.trim());
	const target = path.isAbsolute(expanded) ? expanded : path.resolve(ctxCwd, expanded);
	const tempPath = path.join(
		path.dirname(target),
		`.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`,
	);
	await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
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
		await replaceFileAtomically(tempPath, target);
		removeTemp = false;
	} finally {
		if (removeTemp) await fs.rm(tempPath, { force: true }).catch(() => {});
	}
}

export function resolveRelayUrl(input: string): string {
	const trimmed = input.trim();
	return trimmed.includes("://") ? trimmed : `wss://${trimmed}`;
}

/** Start the configured host once during interactive startup. */
export async function autoStartCollab(ctx: InteractiveModeContext): Promise<boolean> {
	if (ctx.collabGuest || ctx.collabHost || !ctx.settings.get("collab.autoStart")) return false;
	if (ctx.settings.getProvenance("collab.autoStart") === "project") {
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
	const writeLinkPath = ctx.settings.getProvenance("collab.writeLinkPath") === "project" ? "" : configuredLinkPath;
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
		ctx.showError(`Failed to auto-start collab session: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}
