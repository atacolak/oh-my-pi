import assert from "node:assert/strict";
import { NativeSessionApi, NativeSessionApiError } from "../../src/session/native-session-api.ts";

assert.equal(typeof globalThis.Bun, "undefined");
let sends = 0;
const api = new NativeSessionApi({
	async request(command) {
		if (command.type === "agent_mail_send") {
			sends += 1;
			return { type: "response", command: command.type, success: true,
				data: { status: "unknown", error: "recipient acknowledgement was lost" } };
		}
		return { type: "response", command: command.type, success: false,
			error: "operation is unavailable on this old owner", code: "unsupported_operation" };
	},
	observe() { return () => {}; },
});
const result = await api.sendMail({ to: "peer", message: "one request only" });
assert.equal(result.status, "unknown");
assert.equal(sends, 1);
await assert.rejects(api.catalog(), error => error instanceof NativeSessionApiError && error.code === "unsupported_operation");

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
