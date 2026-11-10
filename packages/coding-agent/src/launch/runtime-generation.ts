import * as fs from "node:fs";
import * as path from "node:path";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";

/** Generation layout of the entrypoint that is executing this process. */
export interface RuntimeGenerationInfo {
	/** Generation directory the process was born in. */
	readonly running: string;
	/** Generation directory `generations/current` points at, when readable. */
	readonly current?: string;
	/** The running generation is no longer the one `current` selects. */
	readonly behind: boolean;
}

/** A CLI re-entry command rewritten onto a newer generation when it is available. */
export interface UpgradedCliEntryCmd {
	readonly cmd: string[];
	readonly running?: string;
	readonly current?: string;
	/** The rewritten entry path, when `upgraded` is true. */
	readonly entry?: string;
	readonly upgraded: boolean;
}

interface GenerationEntryLayout {
	readonly root: string;
	readonly running: string;
	readonly relativePath?: string;
}

const GENERATION_PATH_PATTERN = /^(.*)[\\/]generations[\\/]([0-9a-f]{40})(?:[\\/](.*))?$/;
const GENERATION_ID_PATTERN = /[\\/]([0-9a-f]{40})(?:[\\/]|$)/;
const GENERATION_ID = /^[0-9a-f]{40}$/;

function parseGenerationEntry(entry: string): GenerationEntryLayout | undefined {
	const match = GENERATION_PATH_PATTERN.exec(entry);
	if (!match) return undefined;
	const parent = match[1];
	const running = match[2];
	if (parent === undefined || running === undefined) return undefined;
	return { root: path.join(parent, "generations"), running, relativePath: match[3] || undefined };
}

/** Import-time evidence, distinct from the mutable `generations/current` selection. */
export interface RuntimeBootIdentity {
	readonly bootId: string;
	readonly importedGeneration: string | null;
}

const runtimeBootIdentity: RuntimeBootIdentity = Object.freeze({
	bootId: crypto.randomUUID(),
	importedGeneration: parseGenerationEntry(import.meta.path)?.running ?? null,
});

export function readRuntimeBootIdentity(): RuntimeBootIdentity {
	return runtimeBootIdentity;
}

function generationIdFromPath(resolved: string): string | undefined {
	const nested = GENERATION_ID_PATTERN.exec(resolved);
	if (nested?.[1]) return nested[1];
	const leaf = path.basename(resolved);
	return GENERATION_ID.test(leaf) ? leaf : undefined;
}

function readGenerationTarget(linkPath: string): string | undefined {
	let resolved: string;
	try {
		resolved = fs.realpathSync(linkPath);
	} catch {
		return undefined;
	}
	return generationIdFromPath(resolved);
}

function resolveGenerationLink(root: string): string {
	const configured = process.env.OMP_GENERATION_LINK?.trim();
	return configured || path.join(root, "current");
}

function runningGenerationEntry(): string {
	const configured = process.env.OMP_RUNNING_GENERATION_ENTRY?.trim();
	return configured || workerHostEntry() || import.meta.path;
}

/**
 * Generation the current process runs from and the one `generations/current`
 * selects. Read fresh on every call: a symlink flip is visible on the next RPC
 * `get_state`, without a restart. Returns `undefined` outside a
 * `.../generations/<40-hex>/...` entrypoint layout.
 */
export function readRuntimeGeneration(): RuntimeGenerationInfo | undefined {
	const layout = parseGenerationEntry(runningGenerationEntry());
	if (!layout) return undefined;
	const current = readGenerationTarget(resolveGenerationLink(layout.root));
	return { running: layout.running, current, behind: current !== undefined && current !== layout.running };
}

/**
 * Rewrite a CLI re-entry command's entry path from its birth generation to the
 * one `generations/current` selects, so `/restart` and `upgrade_runtime` step
 * onto an upgrade in place. The rewritten entry must exist on disk; otherwise
 * the command is returned unchanged.
 *
 * The entry argument is normally generation-shaped itself. When it is not (a
 * re-entry that resolves through the real install path), the layout reported by
 * {@link readRuntimeGeneration} supplies the root, birth generation and
 * relative entry, and the command's matching entry argument is rewritten.
 */
export function resolveUpgradedCliEntryCmd(entryCmd: readonly string[]): UpgradedCliEntryCmd {
	const generation = readRuntimeGeneration();
	const shapedIndex = findGenerationEntryIndex(entryCmd);
	const layout =
		shapedIndex === -1
			? parseGenerationEntry(runningGenerationEntry())
			: parseGenerationEntry(entryCmd[shapedIndex] as string);
	if (!layout) {
		return { cmd: [...entryCmd], running: generation?.running, current: generation?.current, upgraded: false };
	}
	const shared = { cmd: [...entryCmd], running: layout.running, current: generation?.current, upgraded: false };
	const current = generation?.current ?? readGenerationTarget(resolveGenerationLink(layout.root));
	if (!layout.relativePath || !current || current === layout.running) {
		return { ...shared, current };
	}
	const candidate = path.join(layout.root, current, layout.relativePath);
	if (!fs.existsSync(candidate)) {
		return { ...shared, current };
	}
	const index = shapedIndex === -1 ? findRelativeEntryIndex(entryCmd, layout.relativePath) : shapedIndex;
	if (index === -1) {
		return { ...shared, current };
	}
	const cmd = [...entryCmd];
	cmd[index] = candidate;
	return { cmd, running: layout.running, current, entry: candidate, upgraded: true };
}

function findGenerationEntryIndex(entryCmd: readonly string[]): number {
	const limit = Math.min(entryCmd.length, 2);
	for (let index = 0; index < limit; index++) {
		if (parseGenerationEntry(entryCmd[index] as string)) return index;
	}
	return -1;
}

/** Locate the command argument that names a non-generation-shaped CLI entry. */
function findRelativeEntryIndex(entryCmd: readonly string[], relativePath: string): number {
	const entryName = path.basename(relativePath);
	for (let index = 1; index < Math.min(entryCmd.length, 4); index++) {
		const argument = entryCmd[index];
		if (!argument || !argument.includes(path.sep)) continue;
		if (path.basename(argument) === entryName) return index;
	}
	return -1;
}
