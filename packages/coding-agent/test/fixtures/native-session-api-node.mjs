import assert from "node:assert/strict";
import { NativeSessionApi, NativeSessionApiError } from "../../src/session/native-session-api.ts";

assert.equal(typeof globalThis.Bun, "undefined");
const mailRequests = [];
const api = new NativeSessionApi({
	async request(command) {
		mailRequests.push(command);
		if (command.type === "agent_mail_post_consented") {
			return { type: "response", command: command.type, success: true, data: { status: "unknown",
				error: "recipient acknowledgement was lost" } };
		}
		if (command.type === "agent_mail_list") {
			return { type: "response", command: command.type, success: true, data: {
				messages: [], total: 101, truncated: true, nextBefore: "message-80",
			} };
		}
		if (command.type === "agent_mail_restrict") {
			return { type: "response", command: command.type, success: true,
				data: { peer: command.peer, rule: command.rule } };
		}
		return { type: "response", command: command.type, success: false,
			error: "operation is unavailable on this old owner", code: "unsupported_operation" };
	},
	observe() { return () => {}; },
});
const result = await api.sendMail({ to: "peer", message: "one request only" });
assert.equal(result.status, "unknown");
assert.deepEqual(mailRequests.pop(), { type: "agent_mail_post_consented", to: "peer", message: "one request only" });
await api.sendMail({
	to: "peer", message: "threaded", threadId: "thread-1", replyTo: "message-0",
	approval: "always", policyRevision: null,
	delivery: "steer", intent: "request", type: "prompt", prompt: "wake up", images: [{ data: "x" }],
});
assert.deepEqual(mailRequests.pop(), {
	type: "agent_mail_post_consented", to: "peer", message: "threaded", threadId: "thread-1", replyTo: "message-0",
});
assert.equal(mailRequests.length, 0);

const firstPage = await api.readMail();
assert.equal(firstPage.nextBefore, "message-80");
assert.deepEqual(mailRequests.pop(), { type: "agent_mail_list" });
await api.readMail({ threadId: "thread-1", limit: 5, folder: "requests", before: "message-9" });
assert.deepEqual(mailRequests.pop(), {
	type: "agent_mail_list", threadId: "thread-1", limit: 5, folder: "requests", before: "message-9",
});
await api.readMail({ folder: "inbox", type: "prompt", message: "wake up", limit: undefined });
assert.deepEqual(mailRequests.pop(), { type: "agent_mail_list", folder: "inbox" });

const contact = await api.setMailContact("11111111-1111-4111-8111-111111111111", "block");
assert.deepEqual(contact, { peer: "11111111-1111-4111-8111-111111111111", rule: "block" });
assert.deepEqual(mailRequests.pop(), {
	type: "agent_mail_restrict", peer: "11111111-1111-4111-8111-111111111111", rule: "block",
});
await assert.rejects(api.catalog(), error => error instanceof NativeSessionApiError && error.code === "unsupported_operation");

const legacyOnly = new NativeSessionApi({
	async request(command) {
		if (command.type === "agent_mail_send") {
			return { type: "response", command: command.type, success: true,
				data: { status: "accepted", receipt: { messageId: "old", threadId: "old" }, target: "peer" } };
		}
		// Old owners accept extra keys but ignore folder and cursor on their read opcode.
		if (command.type === "agent_mail_read") {
			return { type: "response", command: command.type, success: true,
				data: { messages: [], total: 0, truncated: false } };
		}
		return { type: "response", command: command.type, success: false,
			error: `Unknown command: ${command.type}` };
	},
	observe() { return () => {}; },
});
await assert.rejects(legacyOnly.sendMail({ to: "peer", message: "no downgrade" }), error =>
	error instanceof NativeSessionApiError && error.code === undefined &&
	error.message === "Unknown command: agent_mail_post_consented");
await assert.rejects(legacyOnly.readMail({ folder: "requests" }), error =>
	error instanceof NativeSessionApiError && error.code === undefined &&
	error.message === "Unknown command: agent_mail_list");
await assert.rejects(api.setMailContact("11111111-1111-4111-8111-111111111111", "allow"), error =>
	error instanceof NativeSessionApiError && error.code === "mail_operator_required");

const legacy = new NativeSessionApi({
	async request(command) {
		return { type: "response", command: command.type, success: false, error: "Unknown command: list_sessions" };
	},
	observe() { return () => {}; },
});
await assert.rejects(legacy.catalog(), error =>
	error instanceof NativeSessionApiError && error.code === undefined && error.message === "Unknown command: list_sessions");

for (const response of [
	null,
	{ type: "ready", command: "list_sessions", success: true, data: {} },
	{ type: "response", command: "other_command", success: false, error: "wrong response" },
	{ type: "response", command: "list_sessions", success: "true", data: {} },
	{ type: "response", command: "list_sessions", success: false },
	{ type: "response", command: "list_sessions", success: false, error: "refused", code: 42 },
	{ type: "response", command: "list_sessions", success: true },
]) {
	const malformed = new NativeSessionApi({
		async request() { return response; },
		observe() { return () => {}; },
	});
	await assert.rejects(malformed.catalog(), error =>
		error instanceof NativeSessionApiError && error.code === "invalid_native_response");
}

let receive = () => {};
let disposed = 0;
const observed = [];
const events = new NativeSessionApi({
	async request() { throw new Error("observe must not request or connect"); },
	observe(listener) {
		receive = listener;
		return () => { disposed += 1; receive = () => {}; };
	},
});
const unsubscribe = events.observe(event => observed.push(event));
receive({ type: "ready" });
receive({ type: "response", command: "list_sessions", success: true, data: {} });
receive({ type: "future_event", message: "not an owned session event" });
receive(null);
assert.deepEqual(observed, []);
const event = { type: "notice", level: "info", message: "owner diagnostic" };
receive(event);
assert.deepEqual(observed, [event]);
unsubscribe();
receive(event);
assert.equal(disposed, 1);
assert.deepEqual(observed, [event]);

const requests = [];
const controls = new NativeSessionApi({
	async request(command) {
		requests.push(command);
		return { type: "response", command: command.type, success: true, data: {} };
	},
	observe() { return () => {}; },
});
const owner = { sessionId: "journal-id", sessionFile: "/sessions/exact.jsonl", bootId: "boot-id" };
await controls.setIdentity(owner, { actorHandle: "renamed-owner" });
assert.deepEqual(requests.pop(), {
	type: "set_session_identity", expectedSessionId: owner.sessionId,
	expectedSessionFile: owner.sessionFile, patch: { actorHandle: "renamed-owner" },
});
await controls.state();
assert.deepEqual(requests.pop(), { type: "get_state" });
await controls.preflight();
assert.deepEqual(requests.pop(), { type: "get_refresh_preflight" });
await controls.control(owner, "restart");
const normalRestart = requests.pop();
assert.equal(normalRestart.type, "upgrade_runtime");
assert.equal(normalRestart.expectedBootId, owner.bootId);
assert.equal(normalRestart.whenIdle, true);
assert.equal(normalRestart.graceful, undefined);
await controls.control(owner, "restart", { graceful: true, compactBeforeRestart: true });
assert.deepEqual(requests.pop(), {
	...normalRestart, graceful: true, compactBeforeRestart: true,
});
await assert.rejects(
	controls.control(owner, "abort", { graceful: true }),
	error => error instanceof NativeSessionApiError && error.code === "invalid_native_request",
);
assert.equal(requests.length, 0);
process.stdout.write("NODE_NATIVE_SESSION_API_OK\n");
