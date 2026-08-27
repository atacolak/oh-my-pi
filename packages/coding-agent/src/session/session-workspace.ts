import * as os from "node:os";
import * as path from "node:path";

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
 * Longest matching workspace directory that contains `filePath`.
 * Additional roots are not a hierarchy; the most specific prefix wins.
 */
export function workspaceRootForPath(filePath: string, workspace: SessionWorkspace): string | null {
	const resolved = path.resolve(filePath);
	let best: string | null = null;
	for (const directory of workspace.directories) {
		if (!isPathInsideDirectory(directory, resolved)) continue;
		if (best === null || directory.length > best.length) best = directory;
	}
	return best;
}

/** Ordered workspace directories for a cwd plus optional additional roots. */
export function sessionWorkspaceDirectories(cwd: string, additionalDirectories?: readonly string[]): string[] {
	return normalizeSessionWorkspace({
		cwd,
		directories: additionalDirectories ? [...additionalDirectories] : [],
	}).directories;
}

function isPathInsideDirectory(directory: string, candidate: string): boolean {
	const relative = path.relative(directory, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
