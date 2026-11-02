/**
 * Episode search index lifecycle.
 *
 * `session_episodes` rows carry the trigger and tool targets of their run, but
 * rows written before those fields existed are NULL. The one-time build derives
 * them from each row's own JSONL slice (anchored on `start_entry_id`), then
 * re-indexes every row into `session_episodes_fts`. Later writes update their
 * own search row, so the build never has to run again for this version.
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { deriveEpisodeFacts } from "./episode-facts";
import { loadEntriesFromFile, readSessionHeaderId } from "./session-loader";
import { findSessionFiles } from "./session-listing";
import type { SessionEntry } from "./session-entries";
import {
	isEpisodeSearchIndexReady,
	listAllSessionEpisodes,
	rebuildEpisodeSearchIndex,
	searchEpisodeRows,
	type SessionEpisode,
	updateSessionEpisodeFacts,
} from "./session-index";
import { sessionDirForCwd } from "./session-paths";

/** Session transcripts nest a bounded number of levels under their project bucket. */
const MAX_WALK_DEPTH = 3;

let building: Promise<void> | undefined;

/** Derive missing episode facts once, then index every row for search. */
export async function ensureEpisodeSearchIndex(): Promise<void> {
	if (isEpisodeSearchIndexReady()) return;
	building ??= buildSearchIndex().finally(() => {
		building = undefined;
	});
	return building;
}

async function buildSearchIndex(): Promise<void> {
	const rows = listAllSessionEpisodes();
	const buckets = new Map<string, Promise<Map<string, string>>>();
	for (const row of rows) {
		if (row.triggerSummary !== null && row.toolTargets !== null) continue;
		const loaded = await loadWithCache(row, buckets);
		if (!loaded) continue;
		updateSessionEpisodeFacts(
			row.episodeId,
			deriveEpisodeFacts(loaded.entries, row.startEntryId, row.endEntryId),
		);
	}
	rebuildEpisodeSearchIndex();
}

/** Entries behind one episode row, read from its session file. */
export async function loadEpisodeEntries(
	episode: SessionEpisode,
): Promise<{ entries: SessionEntry[]; file: string } | null> {
	return loadWithCache(episode, new Map());
}

async function loadWithCache(
	episode: SessionEpisode,
	buckets: Map<string, Promise<Map<string, string>>>,
): Promise<{ entries: SessionEntry[]; file: string } | null> {
	const file = await findSessionFile(episode, buckets);
	if (!file) return null;
	try {
		const loaded = await loadEntriesFromFile(file);
		return { entries: loaded.filter((entry): entry is SessionEntry => entry.type !== "session"), file };
	} catch {
		return null;
	}
}

async function findSessionFile(
	episode: SessionEpisode,
	buckets: Map<string, Promise<Map<string, string>>>,
): Promise<string | undefined> {
	const dir = sessionDirForCwd(episode.cwd);
	let bucket = buckets.get(dir);
	if (!bucket) {
		bucket = scanBucket(dir);
		buckets.set(dir, bucket);
	}
	const found = (await bucket).get(episode.sessionId);
	if (found) return found;
	// The row's cwd may have moved out of the bucket that held its transcript.
	const fallback = await findSessionFiles(episode.sessionId);
	return fallback[0];
}

/** Session files under one project bucket, keyed by the id in their header. */
async function scanBucket(dir: string): Promise<Map<string, string>> {
	const files: string[] = [];
	await collectJsonl(dir, 0, files);
	const byId = new Map<string, string>();
	for (const file of files) {
		const id = await readSessionHeaderId(file);
		if (id && !byId.has(id)) byId.set(id, file);
	}
	return byId;
}

async function collectJsonl(dir: string, depth: number, out: string[]): Promise<void> {
	if (depth > MAX_WALK_DEPTH) return;
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const target = path.join(dir, entry.name);
		if (entry.isDirectory()) await collectJsonl(target, depth + 1, out);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(target);
	}
}

/** Build the index if needed, then return FTS hits for `query`. */
export async function searchEpisodes(query: string, limit?: number): Promise<SessionEpisode[]> {
	await ensureEpisodeSearchIndex();
	return searchEpisodeRows(query, limit);
}
