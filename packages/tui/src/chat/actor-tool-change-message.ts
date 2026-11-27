import { TranscriptStatusBlock, type TranscriptStatusPart } from "../chrome/transcript-status";
import { span } from "../native/describe";
import { theme } from "../theme";
import type { ActorToolChangeNoticeDetails, CustomMessage } from "./messages";

const TOOL_PREVIEW_LIMIT = 4;

function previewTools(names: readonly string[]): string {
	const shown = names.slice(0, TOOL_PREVIEW_LIMIT).join(", ");
	const hidden = names.length - TOOL_PREVIEW_LIMIT;
	return hidden > 0 ? `${shown}, +${hidden} more` : shown;
}

/**
 * One compact transcript row for a committed operator tool-selection change.
 * The persisted `<system-notice>` body is for the model only; the reader sees
 * the delta that was actually applied.
 */
export function createActorToolChangeBlock(message: CustomMessage<unknown>): TranscriptStatusBlock {
	const details = (message as CustomMessage<Partial<ActorToolChangeNoticeDetails>>).details;
	const added = details?.added ?? [];
	const removed = details?.removed ?? [];
	const parts: TranscriptStatusPart[] = [{ text: `${theme.icon.extensionTool} Tool access updated`, color: "muted" }];
	const native = [span("Tool access updated", "muted")];
	if (added.length > 0) {
		const text = `+${previewTools(added)}`;
		parts.push({ text, color: "success" });
		native.push(span(" · ", "dim"), span(text, "success"));
	}
	if (removed.length > 0) {
		const text = `-${previewTools(removed)}`;
		parts.push({ text, color: "warning" });
		native.push(span(" · ", "dim"), span(text, "warning"));
	}
	return new TranscriptStatusBlock([{ parts, native: { tone: "info", message: native } }]);
}
