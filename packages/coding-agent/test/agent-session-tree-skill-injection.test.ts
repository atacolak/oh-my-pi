/**
 * Regression: `/tree` navigation onto a `/skill:` injection node (issue #5374).
 *
 * A user-invoked skill injection is persisted as a `custom_message` entry
 * (customType `skill-prompt`). Selecting it in the tree must leave the leaf ON
 * the injection node so the skill stays on the active branch — not on its
 * parent with the expanded skill body dumped into the editor.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { hindsightBackend } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { assistantMsg, createTestSession, userMsg } from "./utilities";

describe("AgentSession tree navigation onto skill injection", () => {
	it("lands the leaf on the skill injection node and keeps it on the active branch", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const { session, sessionManager } = ctx;

			// u1 -> skill injection -> a1 -> a2
			sessionManager.appendMessage(userMsg("hello"));
			const skillId = sessionManager.appendCustomMessageEntry(
				SKILL_PROMPT_MESSAGE_TYPE,
				"<skill>huge expanded skill body</skill>",
				true,
				{ name: "some-skill", path: "/skills/some-skill/SKILL.md", lineCount: 1 },
				"user",
			);
			sessionManager.appendMessage(assistantMsg("first reply"));
			sessionManager.appendMessage(assistantMsg("second reply"));

			const result = await session.navigateTree(skillId);

			expect(result.cancelled).toBe(false);
			// Leaf must be the skill node itself, not its parent.
			expect(sessionManager.getLeafId()).toBe(skillId);
			// The skill injection must remain on the active branch.
			expect(sessionManager.getBranch().some(e => e.id === skillId)).toBe(true);
			// The expanded skill body must NOT be dumped into the editor.
			expect(result.editorText).toBeUndefined();
		} finally {
			await ctx.cleanup();
		}
	});
});

describe("AgentSession delayed Hindsight baseline after tree navigation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rebases delayed startup after /tree before installation", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const retain = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		const ctx = await createTestSession({
			inMemory: true,
			settingsOverrides: {
				"memory.backend": "hindsight",
				"hindsight.apiUrl": "http://localhost:8888",
				"hindsight.retainEveryNTurns": 5,
				"hindsight.retainOverlapTurns": 0,
			},
		});
		try {
			const { session, sessionManager } = ctx;
			sessionManager.appendMessage(userMsg("turn one has enough text"));
			const firstAssistantId = sessionManager.appendMessage(assistantMsg("reply one has enough text"));
			sessionManager.appendMessage(userMsg("turn two has enough text"));
			sessionManager.appendMessage(assistantMsg("reply two has enough text"));
			sessionManager.appendMessage(userMsg("turn three has enough text"));
			sessionManager.appendMessage(assistantMsg("reply three has enough text"));
			session.hindsightCloseRetainBaselineTurns = 3;

			const result = await session.navigateTree(firstAssistantId, { summarize: false });
			expect(result.cancelled).toBe(false);

			sessionManager.appendMessage(userMsg("post-tree turn has enough text"));
			sessionManager.appendMessage(assistantMsg("post-tree reply has enough text"));

			await hindsightBackend.start({
				session,
				settings: session.settings,
				modelRegistry: {} as never,
				agentDir: ctx.tempDir,
				taskDepth: 0,
				hindsightCloseRetainBaselineTurns: 3,
			});
			await session.getHindsightSessionState()!.drainOnClose();

			expect(retain).toHaveBeenCalledTimes(1);
			const retained = String(retain.mock.calls[0]?.[1]);
			expect(retained).toContain("post-tree turn has enough text");
			expect(retained).not.toContain("turn two has enough text");
			expect(retained).not.toContain("turn three has enough text");
		} finally {
			await ctx.cleanup();
		}
	});
});
