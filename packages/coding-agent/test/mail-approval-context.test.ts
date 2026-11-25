import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMailApproval, AgentMailApprovalRequest } from "@oh-my-pi/pi-coding-agent/session/session-mail";
import {
	currentMailApproval,
	MAIL_APPROVAL_CONTEXT_TTL_MS,
	mailApprovalNamesTarget,
	withMailApprovalContext,
} from "@oh-my-pi/pi-coding-agent/session/mail-approval-context";

const GAMES_UUID = "69e0e9fe-cf8a-42b2-a800-05dd0172e8f7";
const MOVIES_UUID = "b352aad2-d91a-4774-a4e3-165a83240bed";

function request(overrides: Partial<AgentMailApprovalRequest> = {}): AgentMailApprovalRequest {
	return {
		reference: "games",
		sender: { sessionId: "11111111-1111-4111-8111-111111111111", handle: "research", model: "mock" },
		recipient: { sessionId: GAMES_UUID, handle: "games", model: "mock" },
		message: "Release note: the demo fixture is ready for review.",
		messageId: "1930000000000000001",
		...overrides,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("mail approval context", () => {
	it("is absent outside a local submission", () => {
		expect(currentMailApproval()).toBeUndefined();
	});

	it("is absent after the submission scope ends", async () => {
		await withMailApprovalContext(
			"send the release note to games",
			async () => "once",
			async () => {
				expect(currentMailApproval()).toBeDefined();
			},
		);
		expect(currentMailApproval()).toBeUndefined();
	});

	it("is absent for an empty submission", async () => {
		await withMailApprovalContext(
			"   ",
			async () => "once",
			async () => {
				expect(currentMailApproval()).toBeUndefined();
			},
		);
	});

	it("asks the trusted approver when the operator typed the exact full handle", async () => {
		const approve = vi.fn(async (_request: AgentMailApprovalRequest): Promise<AgentMailApproval> => "once");
		const decision = await withMailApprovalContext("send the release note to games", approve, async () => {
			const current = currentMailApproval();
			if (!current) throw new Error("context missing");
			return current(request());
		});
		expect(decision).toBe("once");
		expect(approve).toHaveBeenCalledTimes(1);
		expect(approve.mock.calls[0]![0]).toEqual(request());
	});

	it("matches a full UUID token even when the recipient has no handle", async () => {
		const approve = vi.fn(async (): Promise<AgentMailApproval> => "always");
		const decision = await withMailApprovalContext(`mail it to ${GAMES_UUID} please`, approve, async () => {
			const current = currentMailApproval();
			if (!current) throw new Error("context missing");
			return current(request({ recipient: { sessionId: GAMES_UUID, handle: null, model: null } }));
		});
		expect(decision).toBe("always");
		expect(approve).toHaveBeenCalledTimes(1);
	});

	it("never opens a dialog for a handle only mentioned as a prefix", async () => {
		const approve = vi.fn(async (): Promise<AgentMailApproval> => "once");
		const decision = await withMailApprovalContext("send the note to game", approve, async () => {
			const current = currentMailApproval();
			if (!current) throw new Error("context missing");
			return current(request());
		});
		expect(decision).toBe("cancel");
		expect(approve).not.toHaveBeenCalled();
	});

	it("never opens a dialog for a handle embedded in a longer token", async () => {
		const approve = vi.fn(async (): Promise<AgentMailApproval> => "once");
		const decision = await withMailApprovalContext("send the note to games2", approve, async () => {
			const current = currentMailApproval();
			if (!current) throw new Error("context missing");
			return current(request());
		});
		expect(decision).toBe("cancel");
		expect(approve).not.toHaveBeenCalled();
	});

	it("never opens a dialog for a target the operator did not name", async () => {
		const approve = vi.fn(async (): Promise<AgentMailApproval> => "once");
		const decision = await withMailApprovalContext("send the release note to games", approve, async () => {
			const current = currentMailApproval();
			if (!current) throw new Error("context missing");
			return current(request({ recipient: { sessionId: MOVIES_UUID, handle: "movies", model: null } }));
		});
		expect(decision).toBe("cancel");
		expect(approve).not.toHaveBeenCalled();
	});

	it("shows at most one dialog per named target per submission", async () => {
		const approve = vi.fn(async (): Promise<AgentMailApproval> => "once");
		const decisions = await withMailApprovalContext("send the release note to games", approve, async () => {
			const current = currentMailApproval();
			if (!current) throw new Error("context missing");
			return [await current(request()), await current(request({ messageId: "1930000000000000002" }))];
		});
		expect(decisions).toEqual(["once", "cancel"]);
		expect(approve).toHaveBeenCalledTimes(1);
	});

	it("matches names without regard to case and surrounding punctuation", () => {
		expect(mailApprovalNamesTarget("Please send it to (Games).", request().recipient)).toBe(true);
		expect(mailApprovalNamesTarget("send it to Games", request().recipient)).toBe(true);
		expect(mailApprovalNamesTarget("send it to games.", request().recipient)).toBe(true);
	});

	it("fails closed once the submission is stale", async () => {
		const started = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(started);
		try {
			await withMailApprovalContext(
				"send the release note to games",
				async () => "once",
				async () => {
					clock.mockReturnValue(started + MAIL_APPROVAL_CONTEXT_TTL_MS);
					expect(currentMailApproval()).toBeUndefined();
				},
			);
		} finally {
			clock.mockRestore();
		}
	});

	it("fails closed when the call signal is already aborted", async () => {
		const approve = vi.fn(async (): Promise<AgentMailApproval> => "once");
		const controller = new AbortController();
		controller.abort();
		const decision = await withMailApprovalContext("send the release note to games", approve, async () => {
			const current = currentMailApproval(controller.signal);
			if (!current) throw new Error("context missing");
			return current(request());
		});
		expect(decision).toBe("cancel");
		expect(approve).not.toHaveBeenCalled();
	});

	it("never trusts a decision outside the closed set", async () => {
		const decision = await withMailApprovalContext(
			"send the release note to games",
			async () => "yes" as unknown as AgentMailApproval,
			async () => {
				const current = currentMailApproval();
				if (!current) throw new Error("context missing");
				return current(request());
			},
		);
		expect(decision).toBe("cancel");
	});

	it("fails closed when the approver throws", async () => {
		const decision = await withMailApprovalContext(
			"send the release note to games",
			async () => {
				throw new Error("dialog unavailable");
			},
			async () => {
				const current = currentMailApproval();
				if (!current) throw new Error("context missing");
				return current(request());
			},
		);
		expect(decision).toBe("cancel");
	});

	it("rejects a malformed approval request without asking the approver", async () => {
		const approve = vi.fn(async (): Promise<AgentMailApproval> => "once");
		const decision = await withMailApprovalContext("send the release note to games", approve, async () => {
			const current = currentMailApproval();
			if (!current) throw new Error("context missing");
			return current(request({ recipient: { sessionId: "", handle: "games", model: null } }));
		});
		expect(decision).toBe("cancel");
		expect(approve).not.toHaveBeenCalled();
	});

	it("denies a callback a detached task kept past the submission", async () => {
		const approve = vi.fn(async (_request: AgentMailApprovalRequest): Promise<AgentMailApproval> => "once");
		const captured = await withMailApprovalContext("send the release note to games", approve, async () => {
			const current = currentMailApproval();
			if (!current) throw new Error("context missing");
			return current;
		});
		expect(await captured(request())).toBe("cancel");
		expect(approve).not.toHaveBeenCalled();
	});

	it("denies when the sending session is not the one that submitted the prompt", async () => {
		const approve = vi.fn(async (): Promise<AgentMailApproval> => "once");
		const decision = await withMailApprovalContext(
			"send the release note to games",
			approve,
			async () => {
				const current = currentMailApproval();
				if (!current) throw new Error("context missing");
				return current(
					request({
						sender: { sessionId: MOVIES_UUID, handle: "research", model: null },
					}),
				);
			},
			{ sourceSessionId: "11111111-1111-4111-8111-111111111111" },
		);
		expect(decision).toBe("cancel");
		expect(approve).not.toHaveBeenCalled();
	});

	it("closes an open dialog and denies when the call is aborted", async () => {
		const controller = new AbortController();
		const { promise, resolve } = Promise.withResolvers<AgentMailApproval>();
		let dialogSignal: AbortSignal | undefined;
		const approve = vi.fn(
			async (_request: AgentMailApprovalRequest, signal: AbortSignal): Promise<AgentMailApproval> => {
				dialogSignal = signal;
				return promise;
			},
		);
		const scoped = withMailApprovalContext("send the release note to games", approve, async () => {
			const current = currentMailApproval(controller.signal);
			if (!current) throw new Error("context missing");
			return current(request());
		});
		while (dialogSignal === undefined) await Promise.resolve();
		controller.abort();
		expect(dialogSignal?.aborted).toBe(true);
		resolve("once");
		expect(await scoped).toBe("cancel");
	});
});
