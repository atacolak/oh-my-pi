import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { HOT_HANDOFF_CUSTOM_TYPE } from "../hot-handoff/types";

const ENABLED = process.env.HOT_HANDOFF_VALIDATE === "1";
const DUMP_DIR = process.env.HOT_HANDOFF_VALIDATE_DIR || "/tmp/hot-handoff-validate";

type Role = "system" | "user" | "assistant" | "developer" | "tool" | "unknown";

interface DumpRow {
	index: number;
	providerRole: Role;
	origin: string;
	approxChars: number;
	approxTokens: number;
	persisted: boolean | "unknown";
	excerpt: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
	return content
		.map(part => {
			const rec = asRecord(part);
			if (!rec) return "";
			if (typeof rec.text === "string") return rec.text;
			if (rec.type === "image") return "[image]";
			return JSON.stringify(part);
		})
		.join("\n");
}

function classify(role: Role, text: string, customType?: string): string {
	if (customType === HOT_HANDOFF_CUSTOM_TYPE || text.includes("<LIVE_STATE") || text.includes("This LIVE_STATE block was generated mechanically")) {
		return "RESUME STATE";
	}
	if (text.includes("<summary>") && text.includes("Prior model work/tool state available")) {
		return "HANDOFF DOCUMENT";
	}
	if (role === "system") return "system/project";
	if (text.includes("<additional-context>") || /hindsight|mental model|recall/i.test(text.slice(0, 400))) {
		return "memory/backend";
	}
	if (role === "developer" && /auto-continue|continue the work/i.test(text.slice(0, 400))) {
		return "other OMP runtime context";
	}
	if (role === "user" || role === "assistant" || role === "tool") return "RAW CONTINUATION";
	return "other OMP runtime context";
}

function excerpt(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length <= 280 ? collapsed : `${collapsed.slice(0, 277)}…`;
}

function dumpPath(sessionId: string | undefined): string {
	const id = sessionId && sessionId.length > 0 ? sessionId : "unknown-session";
	return path.join(DUMP_DIR, `${id}.json`);
}

function roleOf(value: unknown): Role {
	if (
		value === "system" ||
		value === "user" ||
		value === "assistant" ||
		value === "developer" ||
		value === "tool"
	) {
		return value;
	}
	return "unknown";
}

function hotHandoffVersion(preserveData: Record<string, unknown> | undefined): number | undefined {
	const hotHandoff = asRecord(preserveData?.hotHandoff);
	return optionalNumber(hotHandoff?.version);
}

export default function hotHandoffValidationRecorder(pi: ExtensionAPI): void {
	if (!ENABLED) return;
	pi.setLabel("Hot Handoff Validation Recorder");

	let armed = false;
	let dumped = false;
	let compactMeta: Record<string, unknown> | undefined;

	pi.on("session_compact", async (event, ctx) => {
		const preserveData = event.compactionEntry.preserveData;
		compactMeta = {
			capturedAt: new Date().toISOString(),
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			fromExtension: event.fromExtension,
			compactionId: event.compactionEntry.id,
			firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
			tokensBefore: event.compactionEntry.tokensBefore,
			tokensAfter: "tokensAfter" in event.compactionEntry ? optionalNumber(event.compactionEntry.tokensAfter) : undefined,
			method: "method" in event.compactionEntry ? optionalString(event.compactionEntry.method) : undefined,
			preserveData,
		};
		if (hotHandoffVersion(preserveData) === 1) {
			armed = true;
			dumped = false;
		}
	});

	pi.on("session_switch", async () => {
		armed = false;
		dumped = false;
	});
	pi.on("session_branch", async () => {
		armed = false;
		dumped = false;
	});
	pi.on("session_shutdown", async () => {
		armed = false;
		dumped = false;
	});

	pi.on("before_provider_request", async (event, ctx) => {
		if (!armed || dumped) return undefined;
		const payload = asRecord(event.payload);
		if (!payload) return undefined;
		dumped = true;
		armed = false;

		const systemPrompt = Array.isArray(payload.systemPrompt)
			? payload.systemPrompt.filter((line): line is string => typeof line === "string")
			: [];
		const messages = Array.isArray(payload.messages) ? payload.messages : [];
		const rows: DumpRow[] = [];

		for (const [i, line] of systemPrompt.entries()) {
			rows.push({
				index: i,
				providerRole: "system",
				origin: "system/project",
				approxChars: line.length,
				approxTokens: Math.ceil(line.length / 4),
				persisted: false,
				excerpt: excerpt(line),
			});
		}

		for (const [i, raw] of messages.entries()) {
			const msg = asRecord(raw);
			const role = roleOf(msg?.role);
			const customType = optionalString(msg?.customType);
			const text = textOf(msg?.content ?? msg?.summary ?? raw);
			const origin = classify(role, text, customType);
			rows.push({
				index: systemPrompt.length + i,
				providerRole: role,
				origin,
				approxChars: text.length,
				approxTokens: Math.ceil(text.length / 4),
				persisted: origin === "RESUME STATE" ? false : origin === "HANDOFF DOCUMENT" ? true : "unknown",
				excerpt: excerpt(text),
			});
		}

		const firstRaw = rows.findIndex(row => row.origin === "RAW CONTINUATION");
		const lastRaw = rows.findLastIndex(row => row.origin === "RAW CONTINUATION");
		const current = ctx.models.current();
		const out = {
			capturedAt: new Date().toISOString(),
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			workingModel: current ? `${current.provider}/${current.id}` : undefined,
			totals: {
				approxTokens: rows.reduce((sum, row) => sum + row.approxTokens, 0),
				handoffTokens: rows.filter(row => row.origin === "HANDOFF DOCUMENT").reduce((s, r) => s + r.approxTokens, 0),
				rawContinuationTokens: rows
					.filter(row => row.origin === "RAW CONTINUATION")
					.reduce((s, r) => s + r.approxTokens, 0),
				resumeStateTokens: rows.filter(row => row.origin === "RESUME STATE").reduce((s, r) => s + r.approxTokens, 0),
				systemProjectTokens: rows.filter(row => row.origin === "system/project").reduce((s, r) => s + r.approxTokens, 0),
				memoryTokens: rows.filter(row => row.origin === "memory/backend").reduce((s, r) => s + r.approxTokens, 0),
			},
			markers: {
				handoffDocument: rows.findIndex(row => row.origin === "HANDOFF DOCUMENT"),
				rawContinuationBegin: firstRaw,
				rawContinuationEnd: lastRaw,
				resumeState: rows.findIndex(row => row.origin === "RESUME STATE"),
			},
			rows,
		};

		const dest = dumpPath(ctx.sessionManager.getSessionId());
		await fs.mkdir(path.dirname(dest), { recursive: true });
		const recutCycle = asRecord(asRecord(compactMeta?.preserveData)?.recutCycle);
		const nativeCut = asRecord(recutCycle?.nativeCut);
		await Bun.write(
			dest,
			`${JSON.stringify({ compact: compactMeta, recutCycle, nativeCut, firstResume: out }, null, 2)}\n`,
		);
		ctx.ui.notify(`hot-handoff validation dump: ${dest}`, "info");
		return undefined;
	});
}
