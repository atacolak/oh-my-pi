import * as os from "node:os";
import * as path from "node:path";
import { normalizePathForComparison, pathIsWithin, resolveEquivalentPath } from "@oh-my-pi/pi-utils";

/**
 * Filesystem workspace of a session: one current/default directory plus a
 * non-empty ordered list of workspace directories.
 *
 * `cwd` remains the default directory for relative-path resolution and
 * backward compatibility. `directories` always contains `cwd` first, followed
 * by any additional directories in their supplied order (deduplicated).
 * Directory order is stable but carries no semantic hierarchy.
 *
 * Workspace directories come from the platform (ACP/editor), CLI, or config —
 * never from filesystem walk-up discovery.
 */
export interface SessionWorkspace {
	/** Current/default directory for compatibility and relative path resolution. */
	cwd: string;
	/** Non-empty ordered list of absolute normalized directories; `cwd` is always first. */
	directories: string[];
}

/** Expand a leading `~`/`~/` and resolve to an absolute path (relative input resolves against `base`). */
export function normalizeWorkspaceDirectory(directory: string, base?: string): string {
	let expanded = directory;
	if (expanded === "~") {
		expanded = os.homedir();
	} else if (expanded.startsWith("~/") || expanded.startsWith(`~${path.sep}`)) {
		expanded = path.join(os.homedir(), expanded.slice(2));
	}
	return base ? path.resolve(base, expanded) : path.resolve(expanded);
}

/**
 * Build a normalized {@link SessionWorkspace} from a cwd and optional
 * additional directories. Additional entries are normalized (relative entries
 * resolve against the normalized cwd), deduplicated, and appended after `cwd`
 * preserving their supplied order.
 */
export function normalizeSessionWorkspace(args: { cwd: string; directories?: string[] }): SessionWorkspace {
	const cwd = normalizeWorkspaceDirectory(args.cwd);
	const directories = [cwd];
	for (const directory of args.directories ?? []) {
		const normalized = normalizeWorkspaceDirectory(directory, cwd);
		if (!directories.includes(normalized)) directories.push(normalized);
	}
	return { cwd, directories };
}

/** The workspace directories beyond `cwd`, in order (ACP `additionalDirectories` shape). */
export function additionalWorkspaceDirectories(workspace: SessionWorkspace): string[] {
	return workspace.directories.filter(directory => directory !== workspace.cwd);
}

/**
 * Canonicalize ancestor directories but keep the final path component.
 * A leaf symlink inside the workspace (`src/foo.ts` → `/shared/foo.ts`)
 * therefore stays a workspace entry instead of jumping to the target.
 */
export function workspaceEntryPath(filePath: string): string {
	const resolved = path.resolve(filePath);
	return path.join(resolveEquivalentPath(path.dirname(resolved)), path.basename(resolved));
}

/**
 * Longest matching workspace directory that contains `filePath`.
 * Additional roots are not a hierarchy; the most specific prefix wins.
 * Specificity is actual containment of equivalent paths, not raw string length,
 * so a long symlink cwd cannot outrank a nested additional workspace.
 *
 * Containment uses {@link workspaceEntryPath} so a leaf symlink inside the
 * workspace is still routed here even when its target sits outside.
 */
export function workspaceRootForPath(filePath: string, workspace: SessionWorkspace): string | null {
	let best: string | null = null;
	for (const directory of workspace.directories) {
		if (!workspaceContainsPath(directory, filePath)) continue;
		if (best === null || isMoreSpecificWorkspaceRoot(directory, best)) best = directory;
	}
	return best;
}

/**
 * Whether `filePath` is contained by `directory` without following a leaf symlink.
 * Workspace-root aliases still compare through equivalent paths.
 */
export function workspaceContainsPath(directory: string, filePath: string): boolean {
	const normalizedRoot = normalizePathForComparison(directory);
	const entry = workspaceEntryPath(filePath);
	const normalizedEntry = process.platform === "win32" ? entry.toLowerCase() : entry;
	const relative = path.relative(normalizedRoot, normalizedEntry);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMoreSpecificWorkspaceRoot(candidate: string, current: string): boolean {
	if (pathIsWithin(current, candidate) && !pathIsWithin(candidate, current)) return true;
	if (pathIsWithin(candidate, current) && !pathIsWithin(current, candidate)) return false;
	return resolveEquivalentPath(candidate).length > resolveEquivalentPath(current).length;
}

/** Ordered workspace directories for a cwd plus optional additional roots. */
export function sessionWorkspaceDirectories(cwd: string, additionalDirectories?: readonly string[]): string[] {
	return normalizeSessionWorkspace({
		cwd,
		directories: additionalDirectories ? [...additionalDirectories] : [],
	}).directories;
}
