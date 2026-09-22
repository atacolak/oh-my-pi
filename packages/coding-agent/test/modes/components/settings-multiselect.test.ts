import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { COMPACTION_METHOD_CHOICES } from "@oh-my-pi/pi-coding-agent/session/compaction-methods";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry(120);
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
});

function stubStdoutGeometry(cols: number): { restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	const rows = 40;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
	};
	return {
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			settings: createSettingsHost(),
			plugins: createPluginSettingsHost(process.cwd()),
		},
		{
			onChange: () => {},
			onCancel: () => {},
		},
	);
}

function optionRow(component: SettingsSelectorComponent, label: string): number {
	const lines = Bun.stripANSI(component.render(120).join("\n")).split("\n");
	const row = lines.findIndex(line => line.includes(label));
	if (row === -1) throw new Error(`Missing settings option: ${label}`);
	return row + 1;
}

function sendMouse(component: SettingsSelectorComponent, button: number, row: number, suffix: "M" | "m"): void {
	component.handleInput(`\x1b[<${button};3;${row}${suffix}`);
}

function clickOption(component: SettingsSelectorComponent, label: string): void {
	const row = optionRow(component, label);
	sendMouse(component, 0, row, "M");
	sendMouse(component, 0, row, "m");
}

const [firstChoice, secondChoice] = COMPACTION_METHOD_CHOICES;

describe("multiselect settings (array-of-enum)", () => {
	it("edits compaction.methodOrder via the ordered toggle list", () => {
		settings.set("compaction.methodOrder", []);
		const comp = createSelector();
		for (const ch of "compaction method order") comp.handleInput(ch);
		const row = comp.render(120).join("\n");
		expect(row).toContain("Compaction Method Order");
		expect(row).toContain("default");

		// Open the editor; Space toggles the first provider, Enter the second.
		comp.handleInput("\n");
		comp.handleInput(" ");
		comp.handleInput("\x1b[B");
		comp.handleInput("\n");
		expect(settings.get("compaction.methodOrder")).toEqual([firstChoice!.value, secondChoice!.value]);

		// ← promotes the highlighted member one slot earlier in priority.
		comp.handleInput("\x1b[D");
		expect(settings.get("compaction.methodOrder")).toEqual([secondChoice!.value, firstChoice!.value]);

		// Toggling a member off removes it and renumbers the rest.
		comp.handleInput(" ");
		expect(settings.get("compaction.methodOrder")).toEqual([firstChoice!.value]);

		// Esc returns to the list; the row summary reflects the saved order.
		comp.handleInput("\x1b");
		expect(comp.render(120).join("\n")).toContain(firstChoice!.label);
	});

	it("splices the hovered option into the pressed digit's position", () => {
		const [a, b, c] = COMPACTION_METHOD_CHOICES;
		settings.set("compaction.methodOrder", []);
		const comp = createSelector();
		for (const ch of "compaction method order") comp.handleInput(ch);
		comp.handleInput("\n");

		// Select rows 1 and 3 → [a, c].
		comp.handleInput(" ");
		comp.handleInput("\x1b[B");
		comp.handleInput("\x1b[B");
		comp.handleInput(" ");
		expect(settings.get("compaction.methodOrder")).toEqual([a!.value, c!.value]);

		// Hover row 2 (unselected) and press "2" → spliced between them.
		comp.handleInput("\x1b[A");
		comp.handleInput("2");
		expect(settings.get("compaction.methodOrder")).toEqual([a!.value, b!.value, c!.value]);

		// Press "9" (past the end) → clamps to the tail.
		comp.handleInput("9");
		expect(settings.get("compaction.methodOrder")).toEqual([a!.value, c!.value, b!.value]);

		// Press "1" → promotes to the head.
		comp.handleInput("1");
		expect(settings.get("compaction.methodOrder")).toEqual([b!.value, a!.value, c!.value]);
	});

	it("toggles list members on mouse click", () => {
		settings.set("compaction.methodOrder", []);
		const comp = createSelector();
		for (const ch of "compaction method order") comp.handleInput(ch);
		comp.handleInput("\n");

		clickOption(comp, firstChoice!.label);
		expect(settings.get("compaction.methodOrder")).toEqual([firstChoice!.value]);

		clickOption(comp, firstChoice!.label);
		expect(settings.get("compaction.methodOrder")).toEqual([]);
	});

	it("reorders selected list members by drag and drop", () => {
		settings.set("compaction.methodOrder", []);
		const comp = createSelector();
		for (const ch of "compaction method order") comp.handleInput(ch);
		comp.handleInput("\n");
		clickOption(comp, firstChoice!.label);
		clickOption(comp, secondChoice!.label);
		expect(settings.get("compaction.methodOrder")).toEqual([firstChoice!.value, secondChoice!.value]);

		const sourceRow = optionRow(comp, secondChoice!.label);
		const targetRow = optionRow(comp, firstChoice!.label);
		sendMouse(comp, 0, sourceRow, "M");
		sendMouse(comp, 32, targetRow, "M");
		sendMouse(comp, 0, targetRow, "m");

		expect(settings.get("compaction.methodOrder")).toEqual([secondChoice!.value, firstChoice!.value]);
	});

	it("rebuilds an open multi-select after a skipped same-key project save", async () => {
		resetSettingsForTest();
		const tempDir = TempDir.createSync("@pi-settings-multiselect-resync-");
		try {
			const projectDir = tempDir.join("project");
			const agentDir = tempDir.join("agent");
			const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
			await Bun.write(
				projectConfigPath,
				YAML.stringify({ compaction: { methodOrder: [firstChoice!.value] } }, null, 2),
			);
			await Settings.init({ cwd: projectDir, agentDir });

			const comp = new SettingsSelectorComponent(
				{
					availableThinkingLevels: [],
					thinkingLevel: undefined,
					availableThemes: ["dark"],
					providers: [],
					settings: createSettingsHost(projectDir),
					plugins: createPluginSettingsHost(projectDir),
				},
				{
					onChange: () => {},
					onCancel: () => {},
				},
			);

			for (const ch of "compaction method order") comp.handleInput(ch);
			comp.handleInput("\n");
			comp.handleInput(" ");
			expect(settings.get("compaction.methodOrder")).toEqual([]);

			await Bun.write(
				projectConfigPath,
				YAML.stringify({ compaction: { methodOrder: [secondChoice!.value] } }, null, 2),
			);
			await settings.flush();

			expect(settings.get("compaction.methodOrder")).toEqual([secondChoice!.value]);
			const menu = Bun.stripANSI(comp.render(120).join("\n"));
			expect(menu).toContain(secondChoice!.label);
			expect(menu).not.toMatch(new RegExp(`●\\s+${firstChoice!.label}`));

			comp.handleInput(" ");
			expect(settings.get("compaction.methodOrder")).toEqual([secondChoice!.value, firstChoice!.value]);
		} finally {
			resetSettingsForTest();
			await tempDir.remove();
		}
	});

	it("keeps the open multi-select cursor after an ordinary project save", async () => {
		resetSettingsForTest();
		const tempDir = TempDir.createSync("@pi-settings-multiselect-cursor-");
		try {
			const projectDir = tempDir.join("project");
			const agentDir = tempDir.join("agent");
			const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
			await Bun.write(
				projectConfigPath,
				YAML.stringify({ compaction: { methodOrder: [firstChoice!.value] } }, null, 2),
			);
			await Settings.init({ cwd: projectDir, agentDir });

			const comp = new SettingsSelectorComponent(
				{
					availableThinkingLevels: [],
					thinkingLevel: undefined,
					availableThemes: ["dark"],
					providers: [],
					settings: createSettingsHost(projectDir),
					plugins: createPluginSettingsHost(projectDir),
				},
				{
					onChange: () => {},
					onCancel: () => {},
				},
			);

			for (const ch of "compaction method order") comp.handleInput(ch);
			comp.handleInput("\n");
			comp.handleInput("\x1b[B");
			comp.handleInput(" ");
			expect(settings.get("compaction.methodOrder")).toEqual([firstChoice!.value, secondChoice!.value]);

			await settings.flush();
			expect(settings.get("compaction.methodOrder")).toEqual([firstChoice!.value, secondChoice!.value]);

			comp.handleInput(" ");
			expect(settings.get("compaction.methodOrder")).toEqual([firstChoice!.value]);
		} finally {
			resetSettingsForTest();
			await tempDir.remove();
		}
	});

	it("keeps in-progress text after adopting an unrelated project setting", async () => {
		resetSettingsForTest();
		const tempDir = TempDir.createSync("@pi-settings-text-sibling-");
		try {
			const projectDir = tempDir.join("project");
			const agentDir = tempDir.join("agent");
			const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
			await Bun.write(
				projectConfigPath,
				YAML.stringify({ compaction: { methodOrder: [firstChoice!.value] } }, null, 2),
			);
			await Settings.init({ cwd: projectDir, agentDir });

			const comp = new SettingsSelectorComponent(
				{
					availableThinkingLevels: [],
					thinkingLevel: undefined,
					availableThemes: ["dark"],
					providers: [],
					settings: createSettingsHost(projectDir),
					plugins: createPluginSettingsHost(projectDir),
				},
				{
					onChange: () => {},
					onCancel: () => {},
				},
			);

			for (const ch of "image upload command") comp.handleInput(ch);
			comp.handleInput("\n");
			for (const ch of "/tmp/upload") comp.handleInput(ch);
			expect(Bun.stripANSI(comp.render(120).join("\n"))).toContain("/tmp/upload");

			await Bun.write(
				projectConfigPath,
				YAML.stringify({ compaction: { methodOrder: [secondChoice!.value] } }, null, 2),
			);
			settings.set("git.enabled", false, "project");
			await settings.flush();

			expect(settings.get("compaction.methodOrder")).toEqual([secondChoice!.value]);
			expect(Bun.stripANSI(comp.render(120).join("\n"))).toContain("/tmp/upload");

			comp.handleInput("\n");
			expect(settings.get("images.urls.command")).toBe("/tmp/upload");
		} finally {
			resetSettingsForTest();
			await tempDir.remove();
		}
	});

	it("keeps in-progress global text after adopting a project same-key edit", async () => {
		resetSettingsForTest();
		const tempDir = TempDir.createSync("@pi-settings-text-global-adopt-");
		try {
			const projectDir = tempDir.join("project");
			const agentDir = tempDir.join("agent");
			const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
			await Bun.write(projectConfigPath, YAML.stringify({ images: { urls: { command: "/tmp/project" } } }, null, 2));
			await Settings.init({ cwd: projectDir, agentDir });

			const comp = new SettingsSelectorComponent(
				{
					availableThinkingLevels: [],
					thinkingLevel: undefined,
					availableThemes: ["dark"],
					providers: [],
					settings: createSettingsHost(projectDir),
					plugins: createPluginSettingsHost(projectDir),
				},
				{
					onChange: () => {},
					onCancel: () => {},
				},
			);

			settings.set("images.urls.command", "/tmp/queued", "project");
			for (const ch of "image upload command") comp.handleInput(ch);
			comp.handleInput("\x1bs");
			expect(Bun.stripANSI(comp.render(120).join("\n"))).toContain("Settings · global");
			comp.handleInput("\n");
			for (const ch of "/tmp/global-draft") comp.handleInput(ch);
			expect(Bun.stripANSI(comp.render(120).join("\n"))).toContain("/tmp/global-draft");

			await Bun.write(projectConfigPath, YAML.stringify({ images: { urls: { command: "/tmp/disk" } } }, null, 2));
			await settings.flush();

			expect(settings.get("images.urls.command")).toBe("/tmp/disk");
			expect(Bun.stripANSI(comp.render(120).join("\n"))).toContain("/tmp/global-draft");

			comp.handleInput("\n");
			expect(settings.getGlobalValue("images.urls.command")).toBe("/tmp/global-draft");
			expect(settings.get("images.urls.command")).toBe("/tmp/disk");
		} finally {
			resetSettingsForTest();
			await tempDir.remove();
		}
	});

	it("releases text-input mode when an adopted sibling hides the open editor", async () => {
		resetSettingsForTest();
		const tempDir = TempDir.createSync("@pi-settings-text-hidden-row-");
		try {
			const projectDir = tempDir.join("project");
			const agentDir = tempDir.join("agent");
			const projectConfigPath = path.join(projectDir, ".omp", "config.yml");
			await Bun.write(
				projectConfigPath,
				YAML.stringify(
					{
						memory: { backend: "hindsight" },
						hindsight: { apiUrl: "http://localhost:8888" },
						ask: { enabled: true },
					},
					null,
					2,
				),
			);
			await Settings.init({ cwd: projectDir, agentDir });

			const comp = new SettingsSelectorComponent(
				{
					availableThinkingLevels: [],
					thinkingLevel: undefined,
					availableThemes: ["dark"],
					providers: [],
					settings: createSettingsHost(projectDir),
					plugins: createPluginSettingsHost(projectDir),
				},
				{
					onChange: () => {},
					onCancel: () => {},
				},
			);

			for (const ch of "hindsight api url") comp.handleInput(ch);
			comp.handleInput("\n");
			for (const ch of "/tmp/hindsight-draft") comp.handleInput(ch);
			expect(Bun.stripANSI(comp.render(120).join("\n"))).toContain("/tmp/hindsight-draft");

			settings.set("ask.enabled", false, "project");
			await Bun.write(
				projectConfigPath,
				YAML.stringify({ memory: { backend: "off" }, ask: { enabled: true } }, null, 2),
			);
			await settings.flush();

			expect(settings.get("memory.backend")).toBe("off");
			expect(Bun.stripANSI(comp.render(120).join("\n"))).not.toContain("Hindsight API URL");

			comp.handleInput("\x1bs");
			expect(Bun.stripANSI(comp.render(120).join("\n"))).toContain("Settings · global");
		} finally {
			resetSettingsForTest();
			await tempDir.remove();
		}
	});
});
describe("settings section sidebar", () => {
	it("does not toggle the selected section's first setting", () => {
		const comp = createSelector();
		for (let i = 0; i < 7; i++) comp.handleInput("\x1b[C");
		expect(settings.get("dev.autoqa")).toBe(true);

		clickOption(comp, "Developer");
		expect(settings.get("dev.autoqa")).toBe(true);

		clickOption(comp, "Developer");
		expect(settings.get("dev.autoqa")).toBe(true);
	});
});
