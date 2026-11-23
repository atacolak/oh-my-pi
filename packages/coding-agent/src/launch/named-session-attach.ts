import * as path from "node:path";
import { resolveSessionIdentity } from "../session/session-identity";
import { runAttachOnly, runLiveSessionAttach } from "./session-attach-run";
import { ensureSessionOwner, verifyResolvedSessionOwner } from "./session-boot";

/** Attach the session selected by its native handle, full UUID, or unambiguous UUID prefix. */
export async function runNamedSessionAttach(target: string): Promise<void> {
	if (path.isAbsolute(target)) return runAttachOnly(target);
	try {
		const actor = await resolveSessionIdentity(target);
		const owner = await ensureSessionOwner(actor);
		if (!owner.terminal) throw new Error("Live session has no attachable terminal.");
		process.exitCode = await runLiveSessionAttach(actor.sessionId, owner.terminal, {
			sessionPath: actor.sessionFile,
			validateOwner: observed => verifyResolvedSessionOwner(actor, observed),
		});
	} catch (error) {
		process.stderr.write(`Error: --attach failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	}
}
