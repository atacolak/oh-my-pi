import {
	assignSessionIdentity,
	createOrOpenSessionIdentity,
	SessionIdentityConflictError,
} from "@oh-my-pi/pi-coding-agent/session/session-identity";

const cwd = process.argv[2];
const actorHandle = process.argv[3];
if (!cwd || !actorHandle) throw new Error("Identity fixture needs cwd and handle");
const opened = await createOrOpenSessionIdentity({ cwd });
try {
	process.stdout.write(`${JSON.stringify({ stage: "ready", sessionId: opened.identity.sessionId })}\n`);
	if ((await Bun.stdin.text()).trim() !== "claim") throw new Error("Missing claim barrier");
	try {
		const identity = await assignSessionIdentity(opened.manager, { actorHandle });
		process.stdout.write(`${JSON.stringify({ stage: "done", status: "accepted", sessionId: identity.sessionId })}\n`);
	} catch (error) {
		if (!(error instanceof SessionIdentityConflictError)) throw error;
		process.stdout.write(
			`${JSON.stringify({ stage: "done", status: "conflict", sessionId: opened.identity.sessionId })}\n`,
		);
	}
} finally {
	await opened.manager.close();
}
