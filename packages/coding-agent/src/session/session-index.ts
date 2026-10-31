/**
 * Per-session index tables in history.db, keyed by session id:
 *
 * - `session_titles`: session id → display title, written whenever a title is
 *   created or renamed ({@link SessionManager.setSessionName}) and backfilled by
 *   the recent-session fallback scan. Lets the welcome "Recent sessions" list
 *   resolve names from a stat + lookup instead of content-scanning every session
 *   file in the project directory (multi-hundred-ms on dirs with thousands of
 *   sessions). A title has no life beyond its session; `omp gc` drops rows of
 *   archived sessions.
 * - `session_episodes`: one row per agent run — opened when the agent starts, closed
 *   when it ends, and given the idle recap that settled it. A reader asking "what
 *   happened in this run" gets an indexed row instead of reconstructing it from the
 *   JSONL and guessing which recap belonged to which turn.
 * - `session_recaps`: append-only journal of idle recaps
 *   ({@link SessionManager.recordRecap}). Recaps are side-channel output that
 *   never enters the session JSONL or LLM context; this table is their only
 *   durable record. `omp gc` drops rows of archived sessions.
 *
 * Holds its own lazily-opened connection instead of {@link HistoryStorage}'s
 * path-pinned singleton: the db path is re-resolved on every call so
 * `setAgentDir`/profile switches (and test isolation) transparently reopen
 * against the right file. Never versions the db — `PRAGMA user_version` is
 * owned by HistoryStorage's rebuild pass, which drops only its own tables.
 */
import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	isSqliteBusyError,
	readSalvageableRows,
	sqliteFileIdentity,
	type SqliteFileIdentity,
} from "@oh-my-pi/pi-utils";
import { getHistoryDbPath } from "@oh-my-pi/pi-utils/dirs";
import { getDbBusyTimeoutMs, isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import * as logger from "@oh-my-pi/pi-utils/logger";

const SESSION_INDEX_DDL = `
CREATE TABLE IF NOT EXISTS session_titles (
	session_id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
CREATE TABLE IF NOT EXISTS session_recaps (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL,
	cwd TEXT NOT NULL,
	recap TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
CREATE INDEX IF NOT EXISTS idx_session_recaps_session ON session_recaps(session_id, created_at);
CREATE TABLE IF NOT EXISTS session_episodes (
	episode_id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	cwd TEXT NOT NULL,
	started_at_ms INTEGER NOT NULL,
	ended_at_ms INTEGER,
	focus_title TEXT,
	trigger_kind TEXT,
	trigger_summary TEXT,
	step_count INTEGER NOT NULL DEFAULT 0,
	start_entry_id TEXT,
	end_entry_id TEXT,
	outcome TEXT NOT NULL DEFAULT 'running',
	recap TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_episodes_session ON session_episodes(session_id, started_at_ms);
`;

interface SessionIndexHandle {
	dbPath: string;
	/** Identity of the file this handle is attached to; the path alone does not identify it after a quarantine. */
	identity: SqliteFileIdentity;
	db: Database;
	upsertTitle: Statement;
	selectTitle: Statement;
	insertRecap: Statement;
	insertEpisode: Statement;
	finishEpisode: Statement;
	attachEpisodeRecap: Statement;
	reapEpisodes: Statement;
}

let handle: SessionIndexHandle | undefined;
/** Db path whose open failed; skip retries (and log spam) until the path changes. */
let failedPath: string | undefined;

function closeHandle(): void {
	if (!handle) return;
	try {
		handle.upsertTitle.finalize();
		handle.selectTitle.finalize();
		handle.insertRecap.finalize();
		handle.insertEpisode.finalize();
		handle.finishEpisode.finalize();
		handle.attachEpisodeRecap.finalize();
		handle.reapEpisodes.finalize();
		handle.db.close();
	} catch {}
	handle = undefined;
}

function openSessionIndex(): SessionIndexHandle | undefined {
	// A test run never writes the user's history.db: under the test runner the
	// index opens only an agent dir the test chose (`setAgentDir` exports
	// PI_CODING_AGENT_DIR). Otherwise every test naming a file-backed session
	// leaves a title row behind in the real index.
	if (isBunTestRuntime() && !process.env.PI_CODING_AGENT_DIR) return undefined;
	const dbPath = getHistoryDbPath();
	// A quarantined history.db is unlinked and recreated at the same path, so
	// the path alone still matches a handle pinned to the dead inode. Reopen
	// unless the file behind the path is still the one this handle was opened
	// on. An `undefined` identity means the stat itself failed: no conclusion
	// is safe there, so treat the handle as stale.
	if (handle?.dbPath === dbPath) {
		const identity = sqliteFileIdentity(dbPath);
		if (identity !== undefined && identity === handle.identity) return handle;
	}

	if (failedPath === dbPath) return undefined;
	closeHandle();
	try {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		// Install the busy handler BEFORE any lock-taking statement (see #2421).
		db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
		db.run(`PRAGMA journal_mode=WAL;\nPRAGMA synchronous=NORMAL;\n${SESSION_INDEX_DDL}`);
		handle = {
			dbPath,
			identity: sqliteFileIdentity(dbPath),
			db,
			upsertTitle: db.prepare(`
INSERT INTO session_titles (session_id, title, updated_at)
VALUES (?, ?, CAST(strftime('%s','now') AS INTEGER))
ON CONFLICT(session_id) DO UPDATE SET
	title = excluded.title,
	updated_at = excluded.updated_at
			`),
			selectTitle: db.prepare("SELECT title FROM session_titles WHERE session_id = ? AND typeof(title) = 'text'"),
			insertRecap: db.prepare("INSERT INTO session_recaps (session_id, cwd, recap) VALUES (?, ?, ?)"),
			insertEpisode: db.prepare(`
INSERT INTO session_episodes (
	episode_id, session_id, cwd, started_at_ms, focus_title, trigger_kind, trigger_summary, start_entry_id, outcome
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')
			`),
			finishEpisode: db.prepare(`
UPDATE session_episodes SET ended_at_ms = ?, step_count = ?, end_entry_id = ?, outcome = ?
WHERE episode_id = ?
			`),
			attachEpisodeRecap: db.prepare("UPDATE session_episodes SET recap = ? WHERE episode_id = ?"),
			// A row still `running` when the next run starts never saw its `agent_end`:
			// the process was killed or crashed. Closing it as `interrupted` with no end
			// keeps the reader honest — it must not invent one.
			reapEpisodes: db.prepare(`
UPDATE session_episodes SET outcome = 'interrupted'
WHERE session_id = ? AND outcome = 'running'
			`),
		};
		failedPath = undefined;
		return handle;
	} catch (error) {
		// A busy store is transient (a peer process holds the lock), so it must
		// not latch the path as unusable for the rest of the session.
		if (isSqliteBusyError(error)) return undefined;
		failedPath = dbPath;
		logger.warn("Session index unavailable", { dbPath, error: String(error) });
		return undefined;
	}
}

/**
 * Record (or replace) the indexed title for a session id. Best-effort: index
 * failures must never break a rename, so errors are logged and swallowed.
 */
export function recordSessionTitle(sessionId: string, title: string): void {
	const index = openSessionIndex();
	if (!index) return;
	try {
		index.upsertTitle.run(sessionId, title);
	} catch (error) {
		logger.debug("Session title index write failed", { sessionId, error: String(error) });
	}
}

/** Indexed title for a session id, or undefined when unindexed/unavailable. */
export function lookupSessionTitle(sessionId: string): string | undefined {
	const index = openSessionIndex();
	if (!index) return undefined;
	try {
		const row = index.selectTitle.get(sessionId) as { title: string } | null;
		return row?.title ?? undefined;
	} catch (error) {
		logger.debug("Session title index read failed", { sessionId, error: String(error) });
		return undefined;
	}
}

/**
 * Append an idle recap to the session's recap journal. Best-effort: a journal
 * failure must never disturb the recap display, so errors are logged and swallowed.
 */
export function recordSessionRecap(sessionId: string, cwd: string, recap: string): void {
	const index = openSessionIndex();
	if (!index) return;
	try {
		index.insertRecap.run(sessionId, cwd, recap);
	} catch (error) {
		logger.debug("Session recap journal write failed", { sessionId, error: String(error) });
	}
}

/** What started an episode. */
export type EpisodeTriggerKind = "user" | "actor_mail" | "async_job" | "system";

/**
 * How an episode ended. `running` means the row is open; `interrupted` means it never
 * closed — the process died before `agent_end`, and there is no end time to invent.
 */
export type EpisodeOutcome = "running" | "ok" | "error" | "aborted" | "interrupted";

export interface SessionEpisodeStart {
	/** Caller-minted id; the same id closes the row at `agent_end`. */
	episodeId: string;
	sessionId: string;
	cwd: string;
	/** Unix milliseconds. */
	startedAtMs: number;
	focusTitle?: string | null;
	triggerKind?: EpisodeTriggerKind | null;
	/** One line: what started this run. */
	triggerSummary?: string | null;
	/** Entry id the run began at, so a reader can anchor back to the transcript. */
	startEntryId?: string | null;
}

/**
 * Open an episode, reaping any row this session left open.
 *
 * The reap is what makes `running` truthful: a previous row still `running` when a new
 * run starts belongs to a process that died, so it is closed as `interrupted` — with no
 * `ended_at_ms` — before the new row is written.
 */
export function startSessionEpisode(input: SessionEpisodeStart): void {
	const index = openSessionIndex();
	if (!index) return;
	try {
		index.reapEpisodes.run(input.sessionId);
		index.insertEpisode.run(
			input.episodeId,
			input.sessionId,
			input.cwd,
			input.startedAtMs,
			input.focusTitle ?? null,
			input.triggerKind ?? null,
			input.triggerSummary ?? null,
			input.startEntryId ?? null,
		);
	} catch (error) {
		logger.debug("Session episode start failed", { sessionId: input.sessionId, error: String(error) });
	}
}

/** Close an open episode with the facts only its end knows. */
export function finishSessionEpisode(input: {
	episodeId: string;
	endedAtMs: number;
	stepCount: number;
	endEntryId?: string | null;
	outcome: Exclude<EpisodeOutcome, "running" | "interrupted">;
}): void {
	const index = openSessionIndex();
	if (!index) return;
	try {
		index.finishEpisode.run(input.endedAtMs, input.stepCount, input.endEntryId ?? null, input.outcome, input.episodeId);
	} catch (error) {
		logger.debug("Session episode finish failed", { episodeId: input.episodeId, error: String(error) });
	}
}

/** Attach the idle recap that settled this exact episode. */
export function recordSessionEpisodeRecap(episodeId: string, recap: string): void {
	const index = openSessionIndex();
	if (!index) return;
	try {
		index.attachEpisodeRecap.run(recap, episodeId);
	} catch (error) {
		logger.debug("Session episode recap failed", { episodeId, error: String(error) });
	}
}

/** One indexed episode row. */
export interface SessionEpisode {
	episodeId: string;
	sessionId: string;
	cwd: string;
	startedAtMs: number;
	endedAtMs: number | null;
	focusTitle: string | null;
	triggerKind: string | null;
	triggerSummary: string | null;
	stepCount: number;
	startEntryId: string | null;
	endEntryId: string | null;
	outcome: EpisodeOutcome;
	recap: string | null;
}

/** Episodes of one session, oldest first. Best-effort like the writers. */
export function listSessionEpisodes(sessionId: string): SessionEpisode[] {
	const index = openSessionIndex();
	if (!index) return [];
	try {
		using statement = index.db.prepare(
			`SELECT episode_id, session_id, cwd, started_at_ms, ended_at_ms, focus_title, trigger_kind,
				trigger_summary, step_count, start_entry_id, end_entry_id, outcome, recap
			 FROM session_episodes WHERE session_id = ? ORDER BY started_at_ms ASC`,
		);
		return (statement.all(sessionId) as Array<Record<string, unknown>>).map(row => ({
			episodeId: String(row.episode_id),
			sessionId: String(row.session_id),
			cwd: String(row.cwd),
			startedAtMs: Number(row.started_at_ms),
			endedAtMs: typeof row.ended_at_ms === "number" ? row.ended_at_ms : null,
			focusTitle: typeof row.focus_title === "string" ? row.focus_title : null,
			triggerKind: typeof row.trigger_kind === "string" ? row.trigger_kind : null,
			triggerSummary: typeof row.trigger_summary === "string" ? row.trigger_summary : null,
			stepCount: Number(row.step_count ?? 0),
			startEntryId: typeof row.start_entry_id === "string" ? row.start_entry_id : null,
			endEntryId: typeof row.end_entry_id === "string" ? row.end_entry_id : null,
			outcome: String(row.outcome ?? "running") as EpisodeOutcome,
			recap: typeof row.recap === "string" ? row.recap : null,
		}));
	} catch (error) {
		logger.debug("Session episode read failed", { sessionId, error: String(error) });
		return [];
	}
}

/** One journaled idle recap. */
export interface SessionRecap {
	sessionId: string;
	/** Working directory of the session that produced the recap. */
	cwd: string;
	recap: string;
	/** Unix seconds. */
	createdAt: number;
}

/** Narrows {@link listSessionRecaps}; omitted fields match everything. */
export interface SessionRecapQuery {
	/** Recaps of these sessions only; empty matches nothing. */
	sessionIds?: readonly string[];
	/** Recaps produced in this exact working directory. */
	cwd?: string;
	/** Maximum rows returned. */
	limit?: number;
}

interface SessionRecapRow {
	session_id: string;
	cwd: string;
	recap: string;
	created_at: number;
}

/**
 * Journaled recaps matching `query`, newest first. Best-effort like the
 * writers: an unavailable index or failed read yields an empty list.
 */
export function listSessionRecaps(query: SessionRecapQuery = {}): SessionRecap[] {
	if (query.sessionIds?.length === 0) return [];
	const index = openSessionIndex();
	if (!index) return [];
	// A damaged page can decode foreign bytes into these columns; never hand them to callers.
	const where = ["typeof(recap) = 'text'", "typeof(cwd) = 'text'", "typeof(created_at) = 'integer'"];
	const params: SQLQueryBindings[] = [];
	if (query.sessionIds) {
		where.push(`session_id IN (${query.sessionIds.map(() => "?").join(", ")})`);
		params.push(...query.sessionIds);
	}
	if (query.cwd !== undefined) {
		where.push("cwd = ?");
		params.push(query.cwd);
	}
	let sql = "SELECT session_id, cwd, recap, created_at FROM session_recaps";
	if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
	sql += " ORDER BY created_at DESC, id DESC";
	if (query.limit !== undefined) {
		sql += " LIMIT ?";
		params.push(query.limit);
	}
	try {
		// Ad-hoc SQL (the IN list varies), so prepare and finalize per call
		// instead of growing the connection's statement cache.
		using statement = index.db.prepare(sql);
		return (statement.all(...params) as SessionRecapRow[]).map(row => ({
			sessionId: row.session_id,
			cwd: row.cwd,
			recap: row.recap,
			createdAt: row.created_at,
		}));
	} catch (error) {
		logger.debug("Session recap journal read failed", { error: String(error) });
		return [];
	}
}

/** Closes the cached connection; the next call reopens it. History recovery closes it so Windows can replace history.db. */
export function closeSessionIndex(): void {
	closeHandle();
	failedPath = undefined;
}

interface SalvagedTitle {
	session_id: unknown;
	title: unknown;
	updated_at: unknown;
}

interface SalvagedRecap {
	session_id: unknown;
	cwd: unknown;
	recap: unknown;
	created_at: unknown;
}

function readSalvageable<T extends object>(source: Database, table: string, columns: string): T[] {
	try {
		return readSalvageableRows<T>(source, table, columns);
	} catch (error) {
		logger.warn("Session index salvage could not read table", { table, error: String(error) });
		return [];
	}
}

/**
 * Copies the readable titles and recaps of a quarantined history.db into the
 * replacement `target`. Runs once per quarantined store, so recaps append
 * as-is; a title already rewritten in the replacement keeps the newer value.
 */
export function salvageSessionIndex(source: Database, target: Database): { titles: number; recaps: number } {
	target.run(SESSION_INDEX_DDL);
	const titles = readSalvageable<SalvagedTitle>(source, "session_titles", "session_id, title, updated_at").filter(
		row =>
			typeof row.session_id === "string" && typeof row.title === "string" && Number.isSafeInteger(row.updated_at),
	);
	const recaps = readSalvageable<SalvagedRecap>(source, "session_recaps", "session_id, cwd, recap, created_at").filter(
		row =>
			typeof row.session_id === "string" &&
			typeof row.cwd === "string" &&
			typeof row.recap === "string" &&
			Number.isSafeInteger(row.created_at),
	);
	using upsertTitle = target.prepare(`
INSERT INTO session_titles (session_id, title, updated_at) VALUES (?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
WHERE excluded.updated_at > session_titles.updated_at
	`);
	for (const row of titles) upsertTitle.run(row.session_id as string, row.title as string, row.updated_at as number);
	using insertRecap = target.prepare(
		"INSERT INTO session_recaps (session_id, cwd, recap, created_at) VALUES (?, ?, ?, ?)",
	);
	for (const row of recaps) {
		insertRecap.run(row.session_id as string, row.cwd as string, row.recap as string, row.created_at as number);
	}
	return { titles: titles.length, recaps: recaps.length };
}
