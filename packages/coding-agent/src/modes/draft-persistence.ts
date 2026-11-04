import { logger } from "@oh-my-pi/pi-utils";
import type { DraftSource } from "../session/session-manager";

/**
 * Long enough that a typing burst collapses into one write, short enough that a
 * crash loses at most a few keystrokes of an unsent draft.
 */
export const COMPOSER_DRAFT_DEBOUNCE_MS = 175;

/** Durable side of {@link ComposerDraftPersistence}; `saveDraft("")` archives, never erases. */
export interface ComposerDraftStore {
	saveDraft(text: string, source?: DraftSource): Promise<void>;
	discardDraft(text: string, source?: DraftSource): Promise<void>;
}

/**
 * Continuous composer persistence: every editor change schedules one atomic
 * write of the full draft after {@link COMPOSER_DRAFT_DEBOUNCE_MS} of quiet.
 * Writes run in submission order, so an older body can never land after a
 * newer one.
 *
 * A clear (empty text) never cancels typed content: any unwritten draft is
 * handed to the store first, then the empty save runs, which parks the text in
 * the session's bounded recovery ring while keeping it in the live sidecar.
 * That includes a deliberate select-all-and-delete: an empty overwrite never
 * destroys the last non-empty draft. {@link discard} is the only operation that
 * clears the sidecar for a submission, and it archives the submitted body first.
 */
export class ComposerDraftPersistence {
	readonly #store: ComposerDraftStore;
	readonly #debounceMs: number;
	#timer: NodeJS.Timeout | undefined;
	#pending: string | undefined;
	#lastQueued: string | undefined;
	#tail: Promise<void> = Promise.resolve();

	constructor(store: ComposerDraftStore, debounceMs = COMPOSER_DRAFT_DEBOUNCE_MS) {
		this.#store = store;
		this.#debounceMs = debounceMs;
	}

	/** Record an editor change. Empty text commits the clear; it never erases typed content. */
	schedule(text: string): void {
		if (text === this.#pending) return;
		if (text.length > 0) {
			this.#pending = text;
			this.#restartTimer();
			return;
		}
		const pending = this.#pending;
		this.#pending = undefined;
		this.#cancelTimer();
		if (pending !== undefined) this.#enqueue(pending);
		if (this.#lastQueued !== "") this.#enqueue("");
	}

	/** Write any pending draft now and wait for every queued write to land. */
	async flush(): Promise<void> {
		const pending = this.#pending;
		this.#pending = undefined;
		this.#cancelTimer();
		if (pending !== undefined) this.#enqueue(pending);
		await this.#tail;
	}

	/**
	 * A submitted message owns `text`: archive it in the recovery ring and clear
	 * the live draft. This is the only operation that clears a draft.
	 */
	async discard(text: string): Promise<void> {
		this.#cancelTimer();
		this.#pending = undefined;
		this.#lastQueued = "";
		this.#tail = this.#tail.then(() => this.#store.discardDraft(text)).catch(this.#logFailure);
		await this.#tail;
	}

	/** Drop the pending debounce without writing (UI teardown that already snapshotted the editor). */
	cancel(): void {
		this.#cancelTimer();
	}

	#restartTimer(): void {
		this.#cancelTimer();
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			const pending = this.#pending;
			this.#pending = undefined;
			if (pending !== undefined) this.#enqueue(pending);
		}, this.#debounceMs);
		this.#timer.unref?.();
	}

	#cancelTimer(): void {
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#enqueue(text: string): void {
		if (text === this.#lastQueued) return;
		this.#lastQueued = text;
		this.#tail = this.#tail
			.then(() => this.#store.saveDraft(text))
			.catch(err => {
				this.#lastQueued = undefined;
				this.#logFailure(err);
			});
	}

	#logFailure(err: unknown): void {
		logger.warn("Failed to persist composer draft", { error: err instanceof Error ? err.message : String(err) });
	}
}
