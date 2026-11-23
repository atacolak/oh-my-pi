/**
 * Per-session index tables in history.db, keyed by session id:
 *
 * - `session_titles`: session id → display title, written whenever a title is
 *   created or renamed ({@link SessionManager.setSessionName}) and backfilled by
 *   the recent-session fallback scan and the resume picker's full scan. Lets the
 *   welcome "Recent sessions" list resolve names from a stat + lookup, and the
 *   resume picker show its rows before reading any session file, instead of
 *   content-scanning every session file in the project directory (seconds on
 *   dirs with thousands of sessions). A title has no life beyond its session;
 *   `omp gc` drops rows of archived sessions.
 * - `session_recaps`: append-only journal of idle recaps
 *   ({@link SessionManager.recordRecap}). Recaps are side-channel output that
 *   never enters the session JSONL or LLM context; this table is their only
 *   durable record. `omp gc` drops rows of archived sessions.
 * - `session_identities`: rebuildable projection of each session's native actor
 *   identity metadata (journal `custom` entries are the authority). Scoped by
 *   sessions root so a custom catalog never rewrites another root's rows. The
 *   unique handle constraint advertises at most one session per actor handle.
 *   Validated file fingerprints let the catalog reuse unchanged journals;
 *   missing, changed or inconsistent rows are rebuilt from journal contents.
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
CREATE TABLE IF NOT EXISTS session_identities (
	session_id TEXT NOT NULL,
	sessions_root TEXT NOT NULL,
	session_file TEXT NOT NULL,
	cwd TEXT NOT NULL,
	root_agent TEXT,
	generation TEXT,
	idle_sleep_seconds INTEGER,
	actor_handle TEXT,
	assignments TEXT NOT NULL,
	entry_id TEXT NOT NULL,
	file_fingerprint TEXT,
	updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
	PRIMARY KEY (sessions_root, session_id),
	UNIQUE (sessions_root, actor_handle)
);
CREATE INDEX IF NOT EXISTS idx_session_identities_root ON session_identities(sessions_root);
`;

interface SessionIndexHandle {
	dbPath: string;
	/** Identity of the file this handle is attached to; the path alone does not identify it after a quarantine. */
	identity: SqliteFileIdentity;
	db: Database;
	upsertTitle: Statement;
	selectTitle: Statement;
	insertRecap: Statement;
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
		// Index readers for different catalog roots and ordinary title/recap
		// writers share this database. Lock before inspecting the schema so
		// another process cannot complete the same ALTER between check and use.
		db.transaction(() => {
			const identityColumns = db
				.query<{ name: string; pk: number }, []>("PRAGMA table_info(session_identities)")
				.all();
			if (!identityColumns.some(column => column.name === "sessions_root" && column.pk === 1)) {
				// Only this rebuildable projection changed shape; preserve titles
				// and DB-only recaps while journals rebuild identity claims.
				db.run("DROP TABLE session_identities");
				db.run(SESSION_INDEX_DDL);
			} else {
				if (!identityColumns.some(column => column.name === "file_fingerprint"))
					db.run("ALTER TABLE session_identities ADD COLUMN file_fingerprint TEXT");
				if (!identityColumns.some(column => column.name === "idle_sleep_seconds"))
					db.run("ALTER TABLE session_identities ADD COLUMN idle_sleep_seconds INTEGER");
			}
		}).immediate();
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

/**
 * Record (or replace) many indexed titles in one transaction, so a picker
 * scan backfilling thousands of sessions pays one commit instead of one per
 * row. Best-effort like {@link recordSessionTitle}.
 */
export function recordSessionTitles(titles: ReadonlyMap<string, string>): void {
	if (titles.size === 0) return;
	const index = openSessionIndex();
	if (!index) return;
	try {
		index.db.transaction(() => {
			for (const [sessionId, title] of titles) index.upsertTitle.run(sessionId, title);
		})();
	} catch (error) {
		logger.debug("Session title index write failed", { count: titles.size, error: String(error) });
	}
}

/**
 * Every indexed title by session id, in one query: the resume picker
 * pre-populates its rows from it before any session file is read. Empty when
 * the index is unavailable or unreadable.
 */
export function listSessionTitles(): Map<string, string> {
	const titles = new Map<string, string>();
	const index = openSessionIndex();
	if (!index) return titles;
	try {
		// A damaged page can decode foreign bytes into these columns; never hand them to callers.
		using statement = index.db.prepare<{ session_id: string; title: string }, []>(
			"SELECT session_id, title FROM session_titles WHERE typeof(session_id) = 'text' AND typeof(title) = 'text'",
		);
		for (const row of statement.iterate()) titles.set(row.session_id, row.title);
	} catch (error) {
		logger.debug("Session title index read failed", { error: String(error) });
	}
	return titles;
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

/** One projected actor identity, rebuildable from a session journal. */
export interface SessionIdentityProjection {
	/** Catalog scope this row belongs to; reconciliation only rewrites its own scope. */
	sessionsRoot: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	rootAgent: string | null;
	generation: string | null;
	idleSleepSeconds?: number | null;
	actorHandle: string | null;
	assignments: readonly { kind: string; target: string }[];
	/** Journal entry the row was derived from; a newer entry supersedes it. */
	entryId: string;
	/** Digest binding this row to its validated journal contents and exact file stat. */
	fileFingerprint?: string | null;
}

interface SessionIdentityRow {
	session_id: string;
	sessions_root: string;
	session_file: string;
	cwd: string;
	root_agent: string | null;
	generation: string | null;
	idle_sleep_seconds: number | null;
	actor_handle: string | null;
	assignments: string;
	entry_id: string;
	file_fingerprint: string | null;
}

function parseProjectedAssignments(value: unknown): { kind: string; target: string }[] {
	if (typeof value !== "string") return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const assignments: { kind: string; target: string }[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;
		const { kind, target } = item as Record<string, unknown>;
		if (typeof kind !== "string" || typeof target !== "string") continue;
		assignments.push({ kind, target });
	}
	return assignments;
}

/**
 * Identity projection rows of one catalog scope. Best-effort like the other
 * readers: an unavailable or damaged index yields nothing, and callers rebuild
 * their decisions from journals.
 */
export function listSessionIdentityProjection(sessionsRoot: string): SessionIdentityProjection[] {
	const index = openSessionIndex();
	if (!index) return [];
	try {
		using statement = index.db.prepare<SessionIdentityRow, [string]>(
			"SELECT session_id, sessions_root, session_file, cwd, root_agent, generation, idle_sleep_seconds, actor_handle, assignments, entry_id, file_fingerprint FROM session_identities WHERE sessions_root = ? AND typeof(session_id) = 'text' AND typeof(session_file) = 'text'",
		);
		const rows: SessionIdentityProjection[] = [];
		for (const row of statement.iterate(sessionsRoot)) {
			rows.push({
				sessionsRoot: row.sessions_root,
				sessionId: row.session_id,
				sessionFile: row.session_file,
				cwd: typeof row.cwd === "string" ? row.cwd : "",
				rootAgent: typeof row.root_agent === "string" ? row.root_agent : null,
				generation: typeof row.generation === "string" ? row.generation : null,
				idleSleepSeconds: typeof row.idle_sleep_seconds === "number" ? row.idle_sleep_seconds : null,
				actorHandle: typeof row.actor_handle === "string" ? row.actor_handle : null,
				assignments: parseProjectedAssignments(row.assignments),
				entryId: typeof row.entry_id === "string" ? row.entry_id : "",
				fileFingerprint: typeof row.file_fingerprint === "string" ? row.file_fingerprint : null,
			});
		}
		return rows;
	} catch (error) {
		logger.debug("Session identity projection read failed", { sessionsRoot, error: String(error) });
		return [];
	}
}

/** Reject rows that would advertise one actor handle for two sessions in a scope. */
function assertUniqueProjectedHandles(sessionsRoot: string, rows: readonly SessionIdentityProjection[]): void {
	const owners = new Map<string, string>();
	for (const row of rows) {
		const handle = row.actorHandle;
		if (!handle) continue;
		const existing = owners.get(handle);
		if (existing !== undefined && existing !== row.sessionId) {
			throw new Error(
				`Actor handle "${handle}" cannot be projected for both "${existing}" and "${row.sessionId}" in ${sessionsRoot}.`,
			);
		}
		owners.set(handle, row.sessionId);
	}
}

/**
 * Rewrite one catalog scope's projection to exactly `rows`. Journal identity
 * metadata is the authority, so callers derive these rows from journals and
 * this function only advertises them; rows of other scopes are never touched.
 * Best-effort: projection failures never decide an identity.
 */
export function replaceSessionIdentityProjection(
	sessionsRoot: string,
	rows: readonly SessionIdentityProjection[],
): void {
	const index = openSessionIndex();
	if (!index) return;
	try {
		assertUniqueProjectedHandles(sessionsRoot, rows);
		index.db.transaction(() => {
			const keep = new Set(rows.map(row => row.sessionId));
			const existing = index.db
				.prepare<{ session_id: string }, [string]>(
					"SELECT session_id FROM session_identities WHERE sessions_root = ?",
				)
				.all(sessionsRoot);
			using dropRow = index.db.prepare("DELETE FROM session_identities WHERE sessions_root = ? AND session_id = ?");
			for (const row of existing) if (!keep.has(row.session_id)) dropRow.run(sessionsRoot, row.session_id);
			// Release this scope's handles before re-advertising them: a handle
			// that moved between two rows of the same scope must not collide with
			// its own previous owner mid-rebuild.
			index.db.run("UPDATE session_identities SET actor_handle = NULL WHERE sessions_root = ?", [sessionsRoot]);
			using upsert = index.db.prepare(`
INSERT INTO session_identities (
	session_id, sessions_root, session_file, cwd, root_agent, generation, idle_sleep_seconds, actor_handle, assignments, entry_id, file_fingerprint, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(strftime('%s','now') AS INTEGER))
ON CONFLICT(sessions_root, session_id) DO UPDATE SET
	session_file = excluded.session_file,
	cwd = excluded.cwd,
	root_agent = excluded.root_agent,
	generation = excluded.generation,
	idle_sleep_seconds = excluded.idle_sleep_seconds,
	actor_handle = excluded.actor_handle,
	assignments = excluded.assignments,
	entry_id = excluded.entry_id,
	file_fingerprint = excluded.file_fingerprint,
	updated_at = excluded.updated_at
			`);
			for (const row of rows) {
				upsert.run(
					row.sessionId,
					row.sessionsRoot,
					row.sessionFile,
					row.cwd,
					row.rootAgent,
					row.generation,
					row.idleSleepSeconds ?? null,
					row.actorHandle,
					JSON.stringify(row.assignments),
					row.entryId,
					row.fileFingerprint ?? null,
				);
			}
		})();
	} catch (error) {
		logger.debug("Session identity projection write failed", { sessionsRoot, error: String(error) });
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
