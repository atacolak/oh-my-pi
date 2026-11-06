/**
 * Bank ID derivation, project-tag scoping, and first-use bank setup.
 *
 * Three scoping modes (`HindsightConfig.scoping`):
 *   - `global`              — one bank plus configured deterministic scope tags.
 *   - `per-project`         — one bank per cwd basename, hard isolation.
 *   - `per-project-tagged`  — one bank plus configured scope tags and `project:<name>`.
 *
 * Non-empty resolved tags are applied identically to retain, recall/reflect,
 * and observation consolidation. Retrieval uses `all_strict`: every requested
 * deterministic tag must match while memories may carry additional semantic or
 * provenance tags.
 *
 * Bank existence is idempotent at module level — a banksSet keeps track of
 * banks we've already PUT so each session boundary doesn't fire a fresh
 * `createBank` call. The PUT is idempotent server-side, so re-firing on a hot
 * path would only burn round-trips. Failures are swallowed: missing the
 * mission patch is an optimisation, but the bank ITSELF must exist before
 * mental-model bootstrap or the first retain, otherwise the very first POST
 * lands against a missing bank.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { HindsightClientApi } from "./client";
import type { HindsightConfig } from "./config";

const DEFAULT_BANK_NAME = "omp";
const PROJECT_TAG_PREFIX = "project:";
const UNKNOWN_PROJECT = "unknown";
const MISSION_SET_CAP = 10_000;
const PREFERRED_SCOPE_MANIFEST = path.join(".systemd-ops", "scope.toml");
const LEGACY_SCOPE_MANIFEST = ".systemd-ops.toml";

export type RecallTagsMatch = "any" | "all" | "any_strict" | "all_strict";

/** Banks already ensured on the server: a `Set<string>`, or a subagent worker's view of main's set. */
export interface HindsightBankSet extends Iterable<string> {
	readonly size: number;
	has(bankId: string): boolean;
	add(bankId: string): unknown;
	delete(bankId: string): boolean;
}

/** Resolved bank target and deterministic memory scope for a session. */
export interface BankScope {
	bankId: string;
	/** Fully resolved deterministic tags in stable order. */
	resolvedTags?: string[];
	/** Tags applied to project-scoped retains; global tool writes omit them. Undefined when scoping does not use tags. */
	retainTags?: string[];
	/** Tag filter applied to recall and reflect. */
	recallTags?: string[];
	recallTagsMatch?: RecallTagsMatch;
	/** Exact consolidation scopes derived only from deterministic tags. */
	observationScopes?: string[][];
}

/** Compose the prefixed base bank id (no project segment). */
function baseBankId(config: HindsightConfig): string {
	const base = config.bankId?.trim() || DEFAULT_BANK_NAME;
	const prefix = config.bankIdPrefix?.trim() || "";
	return prefix ? `${prefix}-${base}` : base;
}

/**
 * Best-effort project label from a working-directory path.
 *
 * The canonical project identity is the `[scope].id` of the nearest
 * `.systemd-ops/scope.toml` (or legacy `.systemd-ops.toml`) walking up from
 * the working directory, which is why `cpa-farm` labels as `cpa`. When the
 * working directory carries no manifest — a linked worktree checked out away
 * from the primary — the primary checkout root is checked for one, so every
 * worktree of one repo shares the primary's label. A directory holding both
 * manifest flavours is ambiguous and contributes nothing.
 *
 * Otherwise we fall back to the primary checkout root basename (or the cwd
 * basename), lowercased. The label becomes a tag, and Hindsight matches tags
 * literally, so a checkout at `.../General` would otherwise retain into a
 * `project:General` scope that never meets the `project:general` scope every
 * other client of the same bank reads and writes.
 *
 * Sync only: this runs on the hot path of `computeBankScope`, which is
 * exposed as a sync API to callers like `backend.ts` and must stay sync.
 * Native repository discovery and manifest reads never launch a subprocess.
 */
function projectLabel(directory: string): string {
	if (!directory) return UNKNOWN_PROJECT;
	const primary = vcs.repo(directory)?.primaryRoot() ?? null;
	const declared = scopeIdFromAncestors(directory) ?? (primary ? scopeIdAt(primary) : null);
	if (declared) return declared;
	return path.basename(primary ?? directory).toLowerCase() || UNKNOWN_PROJECT;
}

function isFile(target: string): boolean {
	try {
		return fs.statSync(target).isFile();
	} catch {
		return false;
	}
}

function normalizeScopeId(id: string): string {
	return id
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function scopeIdFromManifest(manifest: string): string | null {
	try {
		const parsed = Bun.TOML.parse(fs.readFileSync(manifest, "utf8"));
		if (!isRecord(parsed) || !isRecord(parsed.scope)) return null;
		const id = parsed.scope.id;
		return typeof id === "string" ? normalizeScopeId(id) || null : null;
	} catch {
		return null;
	}
}

/** Declared scope id for exactly this directory, or null when absent/ambiguous/unusable. */
function scopeIdAt(root: string): string | null {
	const preferred = path.join(root, PREFERRED_SCOPE_MANIFEST);
	const legacy = path.join(root, LEGACY_SCOPE_MANIFEST);
	const preferredExists = isFile(preferred);
	const legacyExists = isFile(legacy);
	if (preferredExists === legacyExists) return null;
	return scopeIdFromManifest(preferredExists ? preferred : legacy);
}

function scopeIdFromAncestors(directory: string): string | null {
	let current = path.resolve(directory);
	for (;;) {
		const id = scopeIdAt(current);
		if (id) return id;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function uniqueTags(tags: readonly string[]): string[] {
	return [...new Set(tags.map(tag => tag.trim()).filter(Boolean))];
}

function scopedBank(base: string, tags: readonly string[]): BankScope {
	const resolvedTags = uniqueTags(tags);
	if (resolvedTags.length === 0) return { bankId: base };
	return {
		bankId: base,
		resolvedTags,
		retainTags: resolvedTags,
		recallTags: resolvedTags,
		recallTagsMatch: "all_strict",
		observationScopes: [resolvedTags],
	};
}

/** Resolve the active bank and deterministic memory scope. */
export function computeBankScope(config: HindsightConfig, directory: string): BankScope {
	const base = baseBankId(config);
	switch (config.scoping) {
		case "global":
			return scopedBank(base, config.scopeTags);
		case "per-project":
			return { bankId: `${base}-${projectLabel(directory)}` };
		case "per-project-tagged":
			return scopedBank(base, [...config.scopeTags, `${PROJECT_TAG_PREFIX}${projectLabel(directory)}`]);
	}
}

/**
 * Backwards-compatible thin wrapper: just return the bank id portion of the
 * scope. New code should prefer `computeBankScope` directly so it can also
 * apply the tag fields.
 */
export function deriveBankId(config: HindsightConfig, directory: string): string {
	return computeBankScope(config, directory).bankId;
}

/**
 * Ensure a bank exists, and patch its reflect/retain mission on first use.
 *
 * Idempotent: skips the PUT when the bank id is already in the supplied set.
 * The mission body is optional — when `bankMission` is blank we still PUT to
 * make sure the bank itself is created, so mental-model bootstrap and the
 * first retain don't land against a non-existent bank.
 *
 * The set is capped; on overflow we drop the oldest half so it cannot grow
 * unboundedly across long-lived processes.
 */
export async function ensureBankExists(
	client: HindsightClientApi,
	bankId: string,
	config: HindsightConfig,
	banksSet: HindsightBankSet,
): Promise<void> {
	if (banksSet.has(bankId)) return;

	const mission = config.bankMission?.trim();
	const retainMission = config.retainMission?.trim();

	try {
		await client.createBank(bankId, {
			reflectMission: mission || undefined,
			retainMission: retainMission || undefined,
		});
		banksSet.add(bankId);
		if (banksSet.size > MISSION_SET_CAP) {
			const keys = [...banksSet].sort();
			for (const key of keys.slice(0, keys.length >> 1)) {
				banksSet.delete(key);
			}
		}
		if (config.debug) {
			logger.debug("Hindsight: ensured bank", { bankId, mission: Boolean(mission) });
		}
	} catch (err) {
		// Bank creation is best-effort; the server may already have it, or the
		// API may reject the call. Either way, downstream retain/recall calls
		// will surface a clearer error if the bank really is missing.
		logger.debug("Hindsight: ensureBankExists failed", { bankId, error: String(err) });
	}
}
