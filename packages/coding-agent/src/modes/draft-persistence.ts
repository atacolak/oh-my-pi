import { logger } from "@oh-my-pi/pi-utils";

/**
 * Long enough that a typing burst collapses into one write, short enough that a
 * crash loses at most a few keystrokes of an unsent draft.
 */
export const COMPOSER_DRAFT_DEBOUNCE_MS = 175;

/** Durable side of {@link ComposerDraftPersistence}; `saveDraft("")` archives, never erases. */
export interface ComposerDraftStore {
	saveDraft(text: string): Promise<void>;
	discardDraft(): Promise<void>;
}

/**
 * Continuous composer persistence: every editor change schedules one atomic
 * write of the full draft after {@link COMPOSER_DRAFT_DEBOUNCE_MS} of quiet.
 * Writes run in submission order, so an older body can never land after a
 * newer one.
 *
 * A clear (empty text) never cancels typed content: any unwritten draft is
 * handed to the store first, then the empty save runs, which parks the text in
 * the session's bounded recovery ring. {@link discard} is the only operation
 * that forgets a draft, and it is reserved for a submission that now owns the
 * text.
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

	/** Forget the persisted draft and its recovery ring: the submitted message owns the text. */
	async discard(): Promise<void> {
		this.#cancelTimer();
		this.#pending = undefined;
		this.#lastQueued = "";
		this.#tail = this.#tail.then(() => this.#store.discardDraft()).catch(this.#logFailure);
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
