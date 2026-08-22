/**
 * Bank ID derivation, project-tag scoping, and first-use bank setup.
 *
 * Three scoping modes (`HindsightConfig.scoping`):
 *   - `global`              — single shared bank, no per-project filter.
 *   - `per-project`         — one bank per cwd basename, hard isolation.
 *   - `per-project-tagged`  — single shared bank, retains carry a `project:<name>`
 *                              tag and recall filters on it but still surfaces
 *                              untagged ("global") memories alongside.
 *
 * The base bank id is `bankIdPrefix-bankId` (default `omp`). Per-project mode
 * appends `-<project>`; tagged mode leaves the bank untouched and uses tags.
 *
 * Bank existence is idempotent at module level — a banksSet keeps track of
 * banks we've already PUT so each session boundary doesn't fire a fresh
 * `createBank` call. The PUT is idempotent server-side, so re-firing on a hot
 * path would only burn round-trips. Failures are swallowed: missing the
 * mission patch is an optimisation, but the bank ITSELF must exist before
 * mental-model bootstrap or the first retain, otherwise the very first POST
 * lands against a missing bank.
 */

import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";
import type { HindsightApi } from "./client";
import type { HindsightConfig } from "./config";

const DEFAULT_BANK_NAME = "omp";
const PROJECT_TAG_PREFIX = "project:";
const MISSION_SET_CAP = 10_000;

export type RecallTagsMatch = "any" | "all" | "any_strict" | "all_strict";

/**
 * Resolved bank target for a session: which bank to talk to, plus optional
 * tags to attach to retains and to filter recalls by.
 */
export interface BankScope {
	bankId: string;
	/** Tags applied to every retain. Undefined when scoping does not use tags. */
	retainTags?: string[];
	/** Tags filter for recall/reflect. Undefined when scoping does not use tags. */
	recallTags?: string[];
	/** Match mode for `recallTags`. Defaults to `any` so untagged ("global") memories surface too. */
	recallTagsMatch?: RecallTagsMatch;
	/** Observation consolidation scopes. Tagged mode uses only the derived project tag. */
	observationScopes?: string[][];
}

/** Compose the prefixed base bank id (no project segment). */
function baseBankId(config: HindsightConfig): string {
	const base = config.bankId?.trim() || DEFAULT_BANK_NAME;
	const prefix = config.bankIdPrefix?.trim() || "";
	return prefix ? `${prefix}-${base}` : base;
}

/**
 * Normalize an explicit routing project (`browser-ops`, `global`, `project:X`).
 * Empty / whitespace-only values are ignored.
 */
export function normalizeHindsightProject(raw: string | null | undefined): string | null {
	if (!raw) return null;
	let label = raw.trim().toLowerCase().replace(/\s+/g, "-");
	if (label.startsWith(PROJECT_TAG_PREFIX)) label = label.slice(PROJECT_TAG_PREFIX.length);
	return label || null;
}

/**
 * Project label for tagged / per-project scope.
 *
 * Precedence:
 *   1. explicit `config.project` (session override)
 *   2. git primary-root basename (worktrees collapse to the same repo)
 *   3. none — do not invent `project:<cwd-folder>` for umbrella dirs
 *
 * Sync only: this runs on the hot path of `computeBankScope`.
 */
function projectLabel(config: HindsightConfig, directory: string): string | null {
	const override = normalizeHindsightProject(config.project);
	if (override) return override;
	if (!directory) return null;
	const primary = git.repo.primaryRootSync(directory);
	if (!primary) return null;
	return path.basename(primary).toLowerCase() || null;
}

export function projectRouting(label: string): { tag: string; observationScopes: string[][] } {
	const tag = `${PROJECT_TAG_PREFIX}${label}`;
	return { tag, observationScopes: [[tag]] };
}

function uniquePreserveOrder(tags: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const tag of tags) {
		if (!tag || seen.has(tag)) continue;
		seen.add(tag);
		out.push(tag);
	}
	return out;
}

/**
 * Resolve the active bank target plus optional tag scoping.
 *
 * Always returns a non-empty `bankId`. Tag fields are populated only for
 * `per-project-tagged`.
 */
export function computeBankScope(config: HindsightConfig, directory: string): BankScope {
	const base = baseBankId(config);
	switch (config.scoping) {
		case "global":
			return { bankId: base };
		case "per-project": {
			const label = projectLabel(config, directory);
			return { bankId: label ? `${base}-${label}` : base };
		}
		case "per-project-tagged": {
			const label = projectLabel(config, directory);
			if (!label) {
				const extras = uniquePreserveOrder(config.recallTags);
				return {
					bankId: base,
					recallTags: extras.length > 0 ? extras : undefined,
					recallTagsMatch: extras.length > 0 ? config.recallTagsMatch : undefined,
				};
			}
			const { tag, observationScopes } = projectRouting(label);
			return {
				bankId: base,
				retainTags: [tag],
				recallTags: uniquePreserveOrder([tag, ...config.recallTags]),
				// `any` keeps untagged / `project:global` memories visible
				// alongside the cwd project tag unless the operator hardens it.
				recallTagsMatch: config.recallTagsMatch,
				observationScopes,
			};
		}
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
	client: HindsightApi,
	bankId: string,
	config: HindsightConfig,
	banksSet: Set<string>,
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
