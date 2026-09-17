import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager, setKeyHintPlatform } from "@oh-my-pi/pi-tui/app-keybindings";
import { getThemeByName, initTheme, type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import {
	dedupeParseErrors,
	expandKeyHint,
	formatCodeFrameLine,
	formatDiagnostics,
	formatErrorMessage,
	formatExpandHint,
	formatParseErrors,
	formatFeedModelBadge,
	PREVIEW_LIMITS,
	resolveImageOptions,
	setInlineImageMaxColumns,
	setInlineImageMaxRows,
	sanitizeDisplayLines,
	sanitizeStatusText,
	sanitizeDisplayWarning,
	sanitizeDisplayWarnings,
	shortenEmbeddedPaths,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateDiffByHunk,
} from "@oh-my-pi/pi-tui/render/render-utils";
import {
	DEFAULT_TAB_WIDTH,
	getKeybindings,
	setKeybindings,
	type KeybindingsManager as TuiKeybindingsManager,
} from "@oh-my-pi/pi-tui";

describe("resolveImageOptions", () => {
	const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");

	afterEach(() => {
		setInlineImageMaxColumns(100);
		setInlineImageMaxRows(20);
		if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
		else Reflect.deleteProperty(process.stdout, "rows");
	});

	it("applies pushed limits while bounding height to the current viewport", () => {
		Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
		setInlineImageMaxColumns(72);
		setInlineImageMaxRows(25);
		expect(resolveImageOptions()).toEqual({ maxWidthCells: 72, maxHeightCells: 18 });
		setInlineImageMaxRows(10);
		expect(resolveImageOptions()).toEqual({ maxWidthCells: 72, maxHeightCells: 10 });
	});

	it("uses only the viewport cap when rows are unlimited and preserves unknown viewport behavior", () => {
		setInlineImageMaxColumns(0);
		setInlineImageMaxRows(0);
		Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
		expect(resolveImageOptions()).toEqual({ maxWidthCells: 0, maxHeightCells: 24 });
		Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true });
		expect(resolveImageOptions()).toEqual({ maxWidthCells: 0, maxHeightCells: undefined });
		setInlineImageMaxRows(12);
		expect(resolveImageOptions()).toEqual({ maxWidthCells: 0, maxHeightCells: 12 });
	});
});

describe("feed model badges", () => {
	let uiTheme: Theme;

	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("Dark theme is unavailable");
		uiTheme = loaded;
	});

	it("preserves literal effort-like model suffixes and uses only explicit thinking metadata", () => {
		const glyph = uiTheme.thinking.high.split(" ")[0];
		expect(Bun.stripANSI(formatFeedModelBadge("custom:model:max", undefined, false, uiTheme))).toBe(
			"custom:model:max",
		);
		expect(Bun.stripANSI(formatFeedModelBadge("custom:model:max", ThinkingLevel.High, true, uiTheme))).toBe(
			`${glyph} custom:model:max ${uiTheme.icon.advisor}`,
		);
		expect(formatFeedModelBadge("custom:model:max", ThinkingLevel.High, true, uiTheme)).toBe(
			uiTheme.fg("accent", `${glyph} `) + uiTheme.fg("dim", `custom:model:max ${uiTheme.icon.advisor}`),
		);
		expect(uiTheme.fg("accent", glyph)).not.toBe(uiTheme.fg("dim", glyph));
		expect(Bun.stripANSI(formatFeedModelBadge("custom:model:auto", ThinkingLevel.Inherit, false, uiTheme))).toBe(
			"custom:model:auto",
		);
	});

	it("ignores unknown runtime thinking levels without changing the model identity", () => {
		for (const level of ["future-level", "toString"]) {
			expect(Bun.stripANSI(formatFeedModelBadge("custom:model:max", level as ThinkingLevel, true, uiTheme))).toBe(
				`custom:model:max ${uiTheme.icon.advisor}`,
			);
		}
	});

	it("removes terminal controls and collapses whitespace into a single model row", () => {
		const badge = formatFeedModelBadge("\x1b[31mcustom\tmodel\nname\x1b[0m", undefined, false, uiTheme);
		expect(badge).not.toContain("\x1b[31m");
		expect(Bun.stripANSI(badge)).toBe("custom model name");
		expect(formatFeedModelBadge("\t\n\x1b[31m", undefined, true, uiTheme)).toBe("");
	});

	it("preserves disambiguating model tails and reserves advisor space when truncating wide names", () => {
		const badge = Bun.stripANSI(
			formatFeedModelBadge(`provider/${"界".repeat(20)}-variant-b`, ThinkingLevel.High, true, uiTheme, 24),
		);
		expect(badge).toContain("…");
		expect(badge.endsWith(`variant-b ${uiTheme.icon.advisor}`)).toBe(true);
		expect(Bun.stringWidth(badge)).toBeLessThanOrEqual(24);
	});

	it("never overflows tiny budgets even when glyphs leave no room for a model", () => {
		for (let width = 0; width <= 8; width++) {
			const badge = formatFeedModelBadge("provider/界界界-version", ThinkingLevel.Off, true, uiTheme, width);
			expect(Bun.stringWidth(badge)).toBeLessThanOrEqual(width);
		}
		const glyph = uiTheme.thinking.high.split(" ")[0];
		const advisor = uiTheme.icon.advisor;
		const advisorWidth = Bun.stringWidth(advisor);
		const iconsWidth = Bun.stringWidth(`${glyph} ${advisor}`);
		expect(Bun.stripANSI(formatFeedModelBadge("model", ThinkingLevel.High, true, uiTheme, advisorWidth))).toBe(
			advisor,
		);
		expect(Bun.stripANSI(formatFeedModelBadge("model", ThinkingLevel.High, true, uiTheme, iconsWidth))).toBe(
			`${glyph} ${advisor}`,
		);
		expect(
			Bun.stripANSI(formatFeedModelBadge("model", ThinkingLevel.High, false, uiTheme, Bun.stringWidth(glyph))),
		).toBe(glyph);
		expect(formatFeedModelBadge("model", ThinkingLevel.High, true, uiTheme, 0)).toBe("");
		expect(formatFeedModelBadge(undefined, ThinkingLevel.High, true, uiTheme)).toBe("");
	});
});

describe("parse error formatting", () => {
	it("deduplicates parse errors while preserving order", () => {
		const errors = [
			"foo.ts: parse error (syntax tree contains error nodes)",
			"foo.ts: parse error (syntax tree contains error nodes)",
			"bar.ts: parse error (syntax tree contains error nodes)",
			"foo.ts: parse error (syntax tree contains error nodes)",
		];

		expect(dedupeParseErrors(errors)).toEqual([
			"foo.ts: parse error (syntax tree contains error nodes)",
			"bar.ts: parse error (syntax tree contains error nodes)",
		]);
	});

	it("formats deduplicated parse errors", () => {
		const formatted = formatParseErrors([
			"foo.ts: parse error (syntax tree contains error nodes)",
			"foo.ts: parse error (syntax tree contains error nodes)",
			"bar.ts: parse error (syntax tree contains error nodes)",
		]);

		expect(formatted).toEqual([
			"Parse issues:",
			"- foo.ts: parse error (syntax tree contains error nodes)",
			"- bar.ts: parse error (syntax tree contains error nodes)",
		]);
	});
});

describe("shortenPath", () => {
	it("uses forward slashes after a shortened Windows home", () => {
		const home = String.raw`C:\Users\me`;
		expect(shortenPath(String.raw`C:\Users\me\projects\demo`, home)).toBe("~/projects/demo");
	});

	it("shortens Windows home paths case-insensitively", () => {
		const home = String.raw`C:\Users\Alice`;
		expect(shortenPath(String.raw`c:\users\alice\projects\demo`, home)).toBe("~/projects/demo");
	});

	it("does not shorten paths outside the home boundary", () => {
		const home = String.raw`C:\Users\me`;
		const sibling = String.raw`C:\Users\me2\projects\demo`;
		expect(shortenPath(sibling, home)).toBe(sibling);
	});

	it("collapses layout characters, shortens home paths, and truncates status text", () => {
		const homePath = `${os.homedir()}/.omp/mcp.log`;
		const message = sanitizeStatusText(`failed at\t${homePath}\n${"x".repeat(120)}`, 80);

		expect(message).not.toContain(os.homedir());
		expect(message).not.toContain("\n");
		expect(message).not.toContain("\t");
		expect(message).toContain("~/.omp/mcp.log");
		expect(message.length).toBeLessThanOrEqual(80);
	});

	it("shortens embedded home paths that contain spaces", () => {
		const posixHome = spyOn(os, "homedir").mockReturnValue("/home/Alice Smith");
		try {
			const leaked = "/home/Alice Smith/.omp/mcp.log";
			const message = sanitizeStatusText(`failed at ${leaked}`, 80);
			expect(message).not.toContain("/home/Alice Smith");
			expect(message).toContain("~/.omp/mcp.log");
		} finally {
			posixHome.mockRestore();
		}

		const windowsHome = spyOn(os, "homedir").mockReturnValue(String.raw`C:\Users\Alice Smith`);
		try {
			const leaked = String.raw`C:\Users\Alice Smith\secret`;
			const message = sanitizeStatusText(`failed at ${leaked}`, 80);
			expect(message).not.toContain("Alice Smith");
			expect(message).toContain("~/secret");
		} finally {
			windowsHome.mockRestore();
		}
	});
});

describe("formatDiagnostics", () => {
	it("replaces tabs in rendered diagnostic text", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const formatted = formatDiagnostics(
			{
				errored: true,
				summary: "1\terror(s)",
				messages: [
					"src/example.go:183:41 [error] [compiler] too many\targuments in call (WrongArgCount)",
					"\tunparsed diagnostic\tmessage",
				],
			},
			true,
			theme!,
			() => "go",
		);

		expect(formatted).not.toContain("\t");
		expect(formatted.replace(/\s+/g, " ")).toContain("too many arguments in call");
		expect(formatted.replace(/\s+/g, " ")).toContain("unparsed diagnostic message");
		expect(formatted.replace(/\s+/g, " ")).toContain("1 error(s)");
	});
});

describe("formatCodeFrameLine", () => {
	it("pads markers as part of the gutter", () => {
		expect(formatCodeFrameLine(" ", 447, "context", 3)).toBe(" 447│context");
		expect(formatCodeFrameLine("*", 448, "match", 3)).toBe("*448│match");
		expect(formatCodeFrameLine("+", 11, "added", 3)).toBe(" +11│added");
		expect(formatCodeFrameLine("+", 235, "added", 3)).toBe("+235│added");
	});
});

describe("truncateDiffByHunk", () => {
	function makeHunk(prefix: "-" | "+", line: number, count: number): string[] {
		return Array.from({ length: count }, (_, i) => `${prefix} ${prefix === "-" ? "old" : "new"} ${line + i}`);
	}

	function buildDiff(hunkCount: number, linesPerHunk: number): string {
		const lines: string[] = [];
		for (let h = 0; h < hunkCount; h++) {
			lines.push(`@@ hunk ${h} @@`);
			lines.push(...makeHunk("-", h * 100, linesPerHunk));
			lines.push(...makeHunk("+", h * 100, linesPerHunk));
			lines.push(" ctx");
		}
		return lines.join("\n");
	}

	it("keeps trailing hunks when fromTail is set", () => {
		// 6 hunks total, 2 +/- lines per hunk → 4 change lines per hunk plus
		// header/context. Cap budget tight enough to force truncation.
		const diff = buildDiff(6, 2);
		const head = truncateDiffByHunk(diff, 2, 8);
		const tail = truncateDiffByHunk(diff, 2, 8, { fromTail: true });

		// Both modes drop the same number of hunks/lines.
		expect(tail.hiddenHunks).toBe(head.hiddenHunks);
		expect(tail.hiddenLines).toBe(head.hiddenLines);

		// Head shows the first hunk markers; tail shows the last hunk markers.
		expect(head.text).toContain("- old 0");
		expect(head.text).not.toContain("- old 500");
		expect(tail.text).toContain("- old 500");
		expect(tail.text).not.toContain("- old 0");
	});

	it("returns the full diff unchanged when within budget regardless of fromTail", () => {
		const diff = buildDiff(1, 1);
		const head = truncateDiffByHunk(diff, 4, 32);
		const tail = truncateDiffByHunk(diff, 4, 32, { fromTail: true });
		expect(head.text).toBe(diff);
		expect(tail.text).toBe(diff);
		expect(tail.hiddenHunks).toBe(0);
		expect(tail.hiddenLines).toBe(0);
	});


[Showing lines 1-300 of 532. Use :301 to continue]