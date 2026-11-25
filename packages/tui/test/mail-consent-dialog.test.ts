import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import {
	escapeMailConsentText,
	type MailConsentDecision,
	type MailConsentReview,
	MailConsentDialogComponent,
	mailConsentPreview,
} from "@oh-my-pi/pi-tui/overlays/mail-consent-dialog";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { setKeybindings } from "@oh-my-pi/pi-tui";

const DOWN = "\x1b[B";
const ENTER = "\n";
const ESCAPE = "\x1b";

const review: MailConsentReview = {
	sender: "research (11111111-1111-4111-8111-111111111111)",
	recipient: "games (69e0e9fe-cf8a-42b2-a800-05dd0172e8f7)",
	reference: "games",
	messageId: "1930000000000000001",
	message: "Release note: the demo fixture is ready for review.",
};

function render(component: MailConsentDialogComponent, width = 80): string {
	return component.render(width).map(line => stripVTControlCharacters(line)).join("\n");
}

function harness(
	overrides: Partial<MailConsentReview> = {},
	options: { columns?: number; rows?: number; signal?: AbortSignal } = {},
) {
	const decisions: MailConsentDecision[] = [];
	const component = new MailConsentDialogComponent(
		{ ...review, ...overrides },
		{ columns: options.columns ?? 80, rows: options.rows ?? 40, ...(options.signal ? { signal: options.signal } : {}) },
		decision => decisions.push(decision),
	);
	return { component, decisions };
}

describe("MailConsentDialogComponent", () => {
	beforeAll(async () => {
		const darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Failed to load dark theme");
		setThemeInstance(darkTheme);
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	it("shows the complete exact sender, recipient, reference and message", () => {
		const { component } = harness();
		const text = render(component);
		expect(component.displayable).toBe(true);
		expect(text).toContain(review.sender);
		expect(text).toContain(review.recipient);
		expect(text).toContain(review.reference);
		expect(text).toContain(review.messageId);
		expect(text).toContain("Release note: the demo fixture is ready for review.");
	});

	it("lists Cancel first, then Send once, then Always allow", () => {
		const { component } = harness();
		const text = render(component);
		const cancel = text.indexOf("Cancel");
		const once = text.indexOf("Send once");
		const always = text.indexOf("Always allow");
		expect(cancel).toBeGreaterThanOrEqual(0);
		expect(once).toBeGreaterThan(cancel);
		expect(always).toBeGreaterThan(once);
		expect(text).toContain("Esc cancel");
	});

	it("denies on Enter, because Cancel is the default choice", () => {
		const { component, decisions } = harness();
		component.handleInput(ENTER);
		expect(decisions).toEqual(["cancel"]);
	});

	it("denies on Escape", () => {
		const { component, decisions } = harness();
		component.handleInput(ESCAPE);
		expect(decisions).toEqual(["cancel"]);
	});

	it("approves once when the operator moves down and confirms", () => {
		const { component, decisions } = harness();
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(decisions).toEqual(["once"]);
	});

	it("approves always only on the third choice", () => {
		const { component, decisions } = harness();
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(decisions).toEqual(["always"]);
	});

	it("does not move past the last choice or before the first", () => {
		const { component, decisions } = harness();
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(decisions).toEqual(["always"]);
		const up = "\x1b[A";
		const second = harness();
		second.component.handleInput(up);
		second.component.handleInput(ENTER);
		expect(second.decisions).toEqual(["cancel"]);
	});

	it("denies exactly once when the call is aborted", () => {
		const controller = new AbortController();
		const { component, decisions } = harness({}, { signal: controller.signal });
		controller.abort();
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(decisions).toEqual(["cancel"]);
	});

	it("denies when no decision arrives before the timeout", async () => {
		const decisions: MailConsentDecision[] = [];
		const component = new MailConsentDialogComponent(
			review,
			{ columns: 80, rows: 40, timeoutMs: 1 },
			decision => decisions.push(decision),
		);
		await Bun.sleep(25);
		expect(decisions).toEqual(["cancel"]);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(decisions).toEqual(["cancel"]);
	});

	it("escapes bidi controls so the reviewed name cannot reorder the screen", () => {
		const injected = "e\u202Evil";
		const { component } = harness({ sender: injected });
		const text = render(component);
		expect(text).not.toContain("\u202E");
		expect(text).toContain(escapeMailConsentText(injected));
		expect(escapeMailConsentText(injected)).toContain("\\u202E");
	});

	it("escapes newlines in a name so it cannot forge a field row", () => {
		const { component } = harness({ recipient: "games\nTo: attacker" });
		const text = render(component);
		const forged = text
			.split("\n")
			.filter(line => line.includes("To: attacker"));
		expect(forged.length).toBeGreaterThan(0);
		for (const line of forged) expect(line.trimStart().startsWith("To: attacker")).toBe(false);
	});

	it("shows message lines behind a gutter so body text cannot forge a field row", () => {
		const { component } = harness({ message: "note\nFrom: attacker" });
		const text = render(component);
		const forged = text.split("\n").filter(line => line.includes("From: attacker"));
		expect(forged.length).toBeGreaterThan(0);
		for (const line of forged) expect(line.trimStart().startsWith("From: attacker")).toBe(false);
	});

	it("refuses when the terminal is too narrow for a complete review", () => {
		const { component } = harness({}, { columns: 24, rows: 40 });
		expect(component.displayable).toBe(false);
		expect(component.refusalReason).toBeTruthy();
	});

	it("refuses when the complete message cannot fit on the screen", () => {
		const longMessage = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");
		const { component } = harness({ message: longMessage }, { columns: 80, rows: 24 });
		expect(component.displayable).toBe(false);
		expect(component.refusalReason).toBeTruthy();
	});

	it("wraps a long line without dropping characters", () => {
		const message = Array.from({ length: 30 }, (_, index) => `word${index}`).join(" ");
		const { component } = harness({ message }, { columns: 44, rows: 60 });
		const preview = mailConsentPreview(
			{ ...review, message },
			{ columns: 44, rows: 60 },
		);
		expect(preview.displayable).toBe(true);
		const text = render(component, 44).replace(/\s+/g, " ");
		for (let index = 0; index < 30; index++) expect(text).toContain(`word${index}`);
	});
});
