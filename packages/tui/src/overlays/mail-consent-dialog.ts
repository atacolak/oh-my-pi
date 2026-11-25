/**
 * The local, native review dialog for one outgoing agent-mail message.
 *
 * It is shown only by an armed local TUI submission (see
 * `mail-approval-context`), never by an ask tool, a collab guest, or a wire
 * payload. The operator sees the exact reviewed sender, recipient, reference,
 * message id and body, with every control and bidirectional character escaped,
 * and chooses Cancel (the default), Send once, or Always allow. Enter confirms
 * the highlighted row, Escape cancels, and an aborted call cancels.
 *
 * A review that cannot be shown completely — a terminal too narrow, or a body
 * that would need more rows than the screen has — is refused instead of being
 * truncated, so no approval is ever given against a partial message.
 */
import { divider, bottomBorder, row, topBorder } from "../chrome/overlay-box";
import { getKeybindings } from "../keybindings";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { theme } from "../theme/theme";
import type { Component, TUI } from "../tui";
import { padding, visibleWidth } from "../utils";

export type MailConsentDecision = "once" | "always" | "cancel";

export interface MailConsentReview {
	/** Exact reviewed sender, already labeled with handle and session UUID by the host. */
	readonly sender: string;
	/** Exact reviewed recipient, already labeled with handle and session UUID by the host. */
	readonly recipient: string;
	readonly reference: string;
	readonly messageId: string;
	readonly message: string;
}

export interface MailConsentDialogOptions {
	readonly tui?: TUI;
	readonly columns: number;
	readonly rows: number;
	readonly signal?: AbortSignal;
	/** Deny when this many milliseconds pass without a decision. */
	readonly timeoutMs?: number;
}

export interface MailConsentPreview {
	readonly displayable: boolean;
	readonly reason?: string;
	readonly lines: readonly string[];
}

export const MAIL_CONSENT_MIN_COLUMNS = 40;

const MAIL_CONSENT_CHROME_ROWS = 8;

const CHOICES: readonly { readonly label: string; readonly decision: MailConsentDecision }[] = [
	{ label: "Cancel", decision: "cancel" },
	{ label: "Send once", decision: "once" },
	{ label: "Always allow", decision: "always" },
];

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff\\]/u;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function escapeChar(char: string): string {
	switch (char) {
		case "\\":
			return "\\\\";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			break;
	}
	const code = char.codePointAt(0) ?? 0;
	return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0").toUpperCase()}` : `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** One review value on a single unambiguous row: controls and bidi marks become visible escapes. */
export function escapeMailConsentText(value: string): string {
	if (!value) return "";
	let escaped = "";
	let run = "";
	for (const char of value) {
		if (UNSAFE.test(char)) {
			escaped += run;
			run = "";
			escaped += escapeChar(char);
		} else {
			run += char;
		}
	}
	return escaped + run;
}

function hardWrap(line: string, width: number): string[] {
	if (width <= 0 || visibleWidth(line) <= width) return [line];
	const rows: string[] = [];
	let current = "";
	const flush = (): void => {
		if (current.length > 0) rows.push(current);
		current = "";
	};
	for (const token of line.split(/(\s+)/)) {
		if (!token) continue;
		if (visibleWidth(current + token) <= width) {
			current += token;
			continue;
		}
		if (/^\s+$/u.test(token)) {
			flush();
			continue;
		}
		flush();
		if (visibleWidth(token) <= width) {
			current = token;
			continue;
		}
		let piece = "";
		let pieceWidth = 0;
		for (const { segment } of segmenter.segment(token)) {
			const segmentWidth = visibleWidth(segment);
			if (pieceWidth + segmentWidth > width && piece.length > 0) {
				rows.push(piece);
				piece = "";
				pieceWidth = 0;
			}
			piece += segment;
			pieceWidth += segmentWidth;
		}
		current = piece;
	}
	flush();
	return rows.length > 0 ? rows : [""];
}

function messageRows(message: string, width: number): string[] {
	const rows: string[] = [];
	for (const line of message.split("\n")) {
		for (const wrapped of hardWrap(escapeMailConsentText(line), width)) rows.push(wrapped);
	}
	return rows;
}

function fieldRows(label: string, value: string, width: number): string[] {
	const prefixWidth = visibleWidth(label);
	const rows = hardWrap(value, Math.max(1, width - prefixWidth));
	const pad = padding(prefixWidth);
	return rows.map((row, index) => (index === 0 ? `${label}${row}` : `${pad}${row}`));
}

/** Content rows for the given terminal size, or a refusal when the review would have to be cut. */
export function mailConsentPreview(
	review: MailConsentReview,
	size: { readonly columns: number; readonly rows: number },
): MailConsentPreview {
	const width = Math.max(1, size.columns);
	if (width < MAIL_CONSENT_MIN_COLUMNS)
		return {
			displayable: false,
			reason: "Mail approval was not shown: this terminal is too narrow to review the complete message.",
			lines: [],
		};
	const innerWidth = Math.max(1, width - 4);
	const body = messageRows(review.message, Math.max(1, innerWidth - 2));
	const lines = [
		...fieldRows("Sender:    ", escapeMailConsentText(review.sender), innerWidth),
		...fieldRows("Recipient: ", escapeMailConsentText(review.recipient), innerWidth),
		...fieldRows("Reference: ", escapeMailConsentText(review.reference), innerWidth),
		...fieldRows("Message id: ", escapeMailConsentText(review.messageId), innerWidth),
		"",
		"Message:",
		...body.map(line => `│ ${line}`),
	];
	const budget = Math.max(1, size.rows - MAIL_CONSENT_CHROME_ROWS);
	if (lines.length > budget)
		return {
			displayable: false,
			reason: "Mail approval was not shown: the complete message does not fit on this screen.",
			lines: [],
		};
	return { displayable: true, lines };
}

function paint(content: string, width: number, selected: boolean): string {
	const filled = `${content}${padding(Math.max(0, width - visibleWidth(content)))}`;
	return selected ? theme.bg("selectedBg", theme.bold(filled)) : filled;
}

export class MailConsentDialogComponent implements Component {
	readonly displayable: boolean;
	readonly refusalReason: string | undefined;
	readonly #review: MailConsentReview;
	readonly #options: MailConsentDialogOptions;
	readonly #onDecision: (decision: MailConsentDecision) => void;
	readonly #preview: MailConsentPreview;
	#selected = 0;
	#closed = false;
	#memo: { readonly width: number; readonly lines: readonly string[] } | undefined;
	#abortListener: (() => void) | undefined;
	#timeout: ReturnType<typeof setTimeout> | undefined;

	constructor(
		review: MailConsentReview,
		options: MailConsentDialogOptions,
		onDecision: (decision: MailConsentDecision) => void,
	) {
		this.#review = review;
		this.#options = options;
		this.#onDecision = onDecision;
		this.#preview = mailConsentPreview(review, options);
		this.displayable = this.#preview.displayable;
		this.refusalReason = this.#preview.reason;
		const signal = options.signal;
		if (signal) {
			const listener = () => this.#decide("cancel");
			this.#abortListener = listener;
			if (signal.aborted) queueMicrotask(listener);
			else signal.addEventListener("abort", listener, { once: true });
		}
		if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
			this.#timeout = setTimeout(() => this.#decide("cancel"), options.timeoutMs);
		}
	}

	handleInput(keyData: string): void {
		if (this.#closed) return;
		if (matchesSelectCancel(keyData)) {
			this.#decide("cancel");
			return;
		}
		if (matchesSelectUp(keyData)) {
			this.#select(this.#selected - 1);
			return;
		}
		if (matchesSelectDown(keyData)) {
			this.#select(this.#selected + 1);
			return;
		}
		if (getKeybindings().matches(keyData, "tui.select.confirm")) this.#decide(CHOICES[this.#selected]!.decision);
	}

	render(width: number): readonly string[] {
		const content = this.#lines(Math.max(1, width));
		const rows: string[] = [topBorder(width, "Agent mail approval")];
		for (const line of content) rows.push(row(line, width));
		rows.push(divider(width));
		for (let index = 0; index < CHOICES.length; index++) {
			const choice = CHOICES[index]!;
			const selected = index === this.#selected;
			const marker = selected ? theme.fg("accent", "›") : " ";
			rows.push(row(paint(`${marker} ${choice.label}`, Math.max(1, width - 4), selected), width));
		}
		rows.push(row(theme.fg("muted", "Enter select · Esc cancel · ↑/↓ choose"), width));
		rows.push(bottomBorder(width));
		return rows;
	}

	dispose(): void {
		this.#closed = true;
		this.#detachAbort();
		this.#clearTimeout();
	}

	#clearTimeout(): void {
		if (this.#timeout === undefined) return;
		clearTimeout(this.#timeout);
		this.#timeout = undefined;
	}

	#detachAbort(): void {
		if (!this.#options.signal || !this.#abortListener) return;
		this.#options.signal.removeEventListener("abort", this.#abortListener);
		this.#abortListener = undefined;
	}

	#lines(width: number): readonly string[] {
		const memo = this.#memo;
		if (memo?.width === width) return memo.lines;
		const computed = mailConsentPreview(this.#review, {
			columns: width,
			rows: Math.max(this.#options.rows, this.#preview.lines.length + MAIL_CONSENT_CHROME_ROWS),
		});
		const lines = computed.displayable
			? computed.lines
			: [theme.fg("error", computed.reason ?? "Mail approval cannot be displayed completely.")];
		this.#memo = { width, lines };
		return lines;
	}

	#select(index: number): void {
		const next = Math.max(0, Math.min(CHOICES.length - 1, index));
		if (next === this.#selected) return;
		this.#selected = next;
		this.#options.tui?.requestRender();
	}

	#decide(decision: MailConsentDecision): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#detachAbort();
		this.#clearTimeout();
		this.#options.tui?.requestRender();
		this.#onDecision(decision);
	}
}
