/**
 * Native session addressability: a session's actor handle and responsibility
 * assignments live in its own journal as a versioned `custom` metadata entry.
 * Session files are the authority; {@link session-index}'s projection table is
 * a rebuildable lookup/uniqueness advertisement.
 *
 * Every catalog read and handle mutation serializes on one OS-backed lock at
 * catalog scope. The persistent projection is reused only when a fingerprint
 * matches both the current journal stat and the projected identity; changed
 * journals are revalidated before lookup or uniqueness decisions.
 * Cold reads never take a session's ownership lease, start an execution owner,
 * or trigger inference.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, isEnotdir, isRecord, normalizePathForComparison, withFileLock } from "@oh-my-pi/pi-utils";
import { getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import {
	listSessionIdentityProjection,
	replaceSessionIdentityProjection,
	type SessionIdentityProjection,
} from "./session-index";
import { visitEntriesFromFileStream } from "./session-loader";
import type { SessionHeader } from "./session-entries";
import {
	parseSessionIdentityMetadata,
	SESSION_IDENTITY_CUSTOM_TYPE,
	SESSION_IDENTITY_VERSION,
	type SessionIdentityAssignment,
	type SessionIdentityMetadata,
	SessionIdentityMetadataError,
	SessionManager,
} from "./session-manager";
import { computeDefaultSessionDir, resolveManagedSessionRoot } from "./session-paths";
import {
	FileSessionStorage,
	isSessionLeaseHeld,
	SessionReservationBusyError,
	SessionReservationUnavailableError,
	type SessionStorage,
} from "./session-storage";

const DEFAULT_CANDIDATE_LIMIT = 8;
const CATALOG_LOCK_BASENAME = ".session-identity";
const SESSION_SCAN_WORKERS = 8;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ACTOR_HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type SessionResponsibilityAssignment = SessionIdentityAssignment;

/** A session's native addressability, resolved from its journal header and identity entries. */
export interface SessionIdentityRecord {
	sessionId: string;
	/** Canonical (realpath) journal that holds this session. */
	sessionFile: string;
	cwd: string;
	rootAgent?: string;
	generation?: string;
	idleSleepSeconds?: number | null;
	actorHandle: string | null;
	assignments: SessionResponsibilityAssignment[];
	/** Last observed journal modification time, used only for discovery ordering. */
	modifiedAt?: number;
}

/** Fields a caller may change; omitted fields keep the newest journaled value. */
export interface SessionIdentityPatch {
	actorHandle?: string | null;
	assignments?: SessionResponsibilityAssignment[];
	generation?: string | null;
	idleSleepSeconds?: number | null;
}

/** Catalog scope plus a bound on how many candidates an ambiguity error reports. */
export interface SessionIdentityCatalogOptions {
	/** Root holding one directory per project; defaults to the sessions root. */
	sessionsRoot?: string;
	/** Maximum candidate ids an error lists (default 8). */
	candidateLimit?: number;
}

export interface SessionIdentityMutationOptions extends SessionIdentityCatalogOptions {
	/** Refuse if the owner has moved away from this exact canonical journal. */
	expected?: { sessionId: string; sessionFile: string };
}

/** Historical name claims held by more than one session; no claimant is the owner. */
export interface SessionIdentityNameConflict {
	code: "duplicate_handle";
	/** Lowercased, so case-only collisions report the same name. */
	handle: string;
	/** Sorted claimant session ids. */
	sessionIds: string[];
}

/** One locked catalog scan: every raw claim plus the names that cannot select a session. */
export interface SessionIdentityInventory {
	records: SessionIdentityRecord[];
	conflicts: SessionIdentityNameConflict[];
}

/** Create-or-open a real header and identity metadata without starting an inference turn. */
export interface CreateOrOpenSessionIdentityOptions {
	cwd: string;
	/** Full session id, unique id prefix, or actor handle. A missing reference never creates a session. */
	reference?: string;
	actorHandle?: string;
	rootAgent?: string;
	generation?: string;
	assignments?: SessionResponsibilityAssignment[];
	catalog?: SessionIdentityCatalogOptions;
}

/** Nothing in the catalog matches the reference. */
export class SessionIdentityNotFoundError extends Error {
	readonly reference: string;
	readonly candidates: readonly string[];

	constructor(reference: string, candidates: readonly string[] = []) {
		super(
			candidates.length > 0
				? `No session identity matches "${reference}". Did you mean: ${candidates.join(", ")}?`
				: `No session identity matches "${reference}".`,
		);
		this.name = "SessionIdentityNotFoundError";
		this.reference = reference;
		this.candidates = [...candidates];
	}
}

/** The reference matches several sessions, even after bounding the candidate list. */
export class SessionIdentityAmbiguousError extends Error {
	readonly reference: string;
	readonly candidates: readonly string[];

	constructor(reference: string, candidates: readonly string[]) {
		super(`Session reference "${reference}" is ambiguous between: ${candidates.join(", ")}`);
		this.name = "SessionIdentityAmbiguousError";
		this.reference = reference;
		this.candidates = [...candidates];
	}
}

/** Journals disagree about an identity claim; recovery refuses instead of picking a winner. */
export class SessionIdentityConflictError extends Error {
	readonly sessionIds: readonly string[];
	readonly actorHandle: string | undefined;

	constructor(message: string, options?: { sessionIds?: readonly string[]; actorHandle?: string }) {
		super(message);
		this.name = "SessionIdentityConflictError";
		this.sessionIds = [...(options?.sessionIds ?? [])];
		this.actorHandle = options?.actorHandle;
	}
}

/** An existing session's rootAgent/cwd/generation (or handle) contradicts the request. */
export class SessionIdentityPinConflictError extends Error {
	readonly sessionId: string;
	readonly pin: "cwd" | "rootAgent" | "generation" | "actorHandle";

	constructor(sessionId: string, pin: SessionIdentityPinConflictError["pin"], recorded: string, requested: string) {
		super(`Session "${sessionId}" is pinned to ${pin} "${recorded}", not "${requested}".`);
		this.name = "SessionIdentityPinConflictError";
		this.sessionId = sessionId;
		this.pin = pin;
	}
}

/** The identity append did not reach the durable journal. */
export class SessionIdentityPersistError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string, reason: string) {
		super(`Session "${sessionId}" identity was not persisted: ${reason}.`);
		this.name = "SessionIdentityPersistError";
		this.sessionId = sessionId;
	}
}

interface JournalIdentity {
	record: SessionIdentityRecord;
	entryId: string;
	/** Validated snapshot; a growing file must reverify its prefix before reuse. */
	fileFingerprint?: string;
}

interface JournalCheckpoint {
	stat: string[];
	contentHash: string;
	endsWithNewline: boolean;
	digest: string;
}

interface IdentityCatalog {
	root: string;
	journals: Map<string, JournalIdentity>;
	records: SessionIdentityRecord[];
	conflicts: SessionIdentityNameConflict[];
}

function normalizeReference(reference: string): string {
	if (typeof reference !== "string" || !reference.trim()) {
		throw new TypeError("Session reference must be a nonempty string");
	}
	return reference.trim();
}

function normalizeActorHandle(handle: string | null | undefined, allowNull: boolean): string | null {
	if (handle === null || handle === undefined) {
		if (allowNull) return null;
		throw new TypeError("Actor handle must be a nonempty string");
	}
	const trimmed = handle.trim();
	if (!ACTOR_HANDLE_PATTERN.test(trimmed)) {
		throw new TypeError(`Actor handle "${handle}" must be a token of letters, digits, ".", "_" or "-"`);
	}
	return trimmed;
}

function normalizePin(pin: "rootAgent" | "generation", value: string): string {
	const trimmed = typeof value === "string" ? value.trim() : "";
	if (!trimmed) throw new TypeError(`${pin === "rootAgent" ? "Root agent" : "Generation"} pin must be nonempty`);
	return trimmed;
}

function candidateLimit(options?: SessionIdentityCatalogOptions): number {
	const limit = options?.candidateLimit;
	if (limit === undefined) return DEFAULT_CANDIDATE_LIMIT;
	if (!Number.isInteger(limit) || limit < 1)
		throw new TypeError("Session catalog candidate limit must be a positive integer");
	return limit;
}

function resolveSessionsRoot(options?: SessionIdentityCatalogOptions): string {
	const root = options?.sessionsRoot ?? getSessionsDir();
	return path.resolve(root);
}

function readRootAgent(header: SessionHeader): string | undefined {
	const value = (header as SessionHeader & { rootAgent?: unknown }).rootAgent;
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) {
		throw new SessionIdentityConflictError("A session header holds an invalid root agent profile");
	}
	return value;
}

/** Canonical journal path, so comparisons survive symlinked parents (`/var` → `/private/var`). */
async function canonicalPath(file: string): Promise<string> {
	try {
		return await fs.promises.realpath(file);
	} catch {
		return path.resolve(file);
	}
}

async function isSameJournal(file: string | undefined, canonicalFile: string): Promise<boolean> {
	if (!file) return false;
	if (path.resolve(file) === canonicalFile) return true;
	return (await canonicalPath(file)) === canonicalFile;
}

function cloneRecord(record: SessionIdentityRecord): SessionIdentityRecord {
	return { ...record, assignments: record.assignments.map(assignment => ({ ...assignment })) };
}

function candidateLabel(record: Pick<SessionIdentityRecord, "sessionId" | "actorHandle">): string {
	return record.actorHandle ? `${record.sessionId} (${record.actorHandle})` : record.sessionId;
}

function bounded(values: readonly string[], limit: number): string[] {
	return [...values].sort().slice(0, limit);
}

function journalStat(stat: fs.BigIntStats): string[] {
	return [
		stat.dev.toString(),
		stat.ino.toString(),
		stat.size.toString(),
		stat.mtimeNs.toString(),
		stat.ctimeNs.toString(),
		stat.mode.toString(),
	];
}

/** Bind the cached identity and content checkpoint to its exact validated file snapshot. */
function journalFingerprint(
	stat: readonly string[],
	journal: JournalIdentity,
	contentHash: string,
	endsWithNewline: boolean,
): string {
	const record = journal.record;
	return new Bun.CryptoHasher("sha256")
		.update(
			JSON.stringify([
				2,
				stat,
				contentHash,
				endsWithNewline,
				record.sessionId,
				record.sessionFile,
				record.cwd,
				record.rootAgent ?? null,
				record.generation ?? null,
				record.idleSleepSeconds ?? null,
				record.actorHandle,
				record.assignments,
				journal.entryId,
			]),
		)
		.digest("hex");
}

function readJournalCheckpoint(journal: JournalIdentity): JournalCheckpoint | undefined {
	if (!journal.fileFingerprint) return undefined;
	try {
		const value: unknown = JSON.parse(journal.fileFingerprint);
		if (
			!isRecord(value) ||
			!Array.isArray(value.stat) ||
			value.stat.length !== 6 ||
			typeof value.contentHash !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.contentHash) ||
			typeof value.endsWithNewline !== "boolean" ||
			typeof value.digest !== "string"
		)
			return undefined;
		const stat = value.stat.filter((part: unknown): part is string => typeof part === "string");
		if (stat.length !== 6 || !Number.isSafeInteger(Number(stat[2])) || Number(stat[2]) < 0) return undefined;
		const checkpoint: JournalCheckpoint = {
			stat,
			contentHash: value.contentHash,
			endsWithNewline: value.endsWithNewline,
			digest: value.digest,
		};
		return checkpoint.digest === journalFingerprint(stat, journal, checkpoint.contentHash, checkpoint.endsWithNewline)
			? checkpoint
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Read one journal's session identity. Unreadable or non-session files yield
 * `undefined` (they are not claims); a malformed identity claim refuses.
 */
async function readJournalIdentity(
	file: string,
	projected?: SessionIdentityProjection,
): Promise<JournalIdentity | undefined> {
	let canonicalFile: string;
	let before: fs.BigIntStats;
	try {
		canonicalFile = await fs.promises.realpath(file);
		before = await fs.promises.stat(canonicalFile, { bigint: true });
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	const stat = journalStat(before);
	let seed: JournalIdentity | undefined;
	let checkpoint: JournalCheckpoint | undefined;
	if (projected?.fileFingerprint && projected.sessionFile === canonicalFile) {
		const cached: JournalIdentity = {
			record: {
				sessionId: projected.sessionId,
				sessionFile: canonicalFile,
				cwd: projected.cwd,
				rootAgent: projected.rootAgent ?? undefined,
				generation: projected.generation ?? undefined,
				idleSleepSeconds: projected.idleSleepSeconds,
				actorHandle: projected.actorHandle,
				assignments: projected.assignments.map(assignment => ({ ...assignment })),
				modifiedAt: Number(before.mtimeMs),
			},
			entryId: projected.entryId,
			fileFingerprint: projected.fileFingerprint,
		};
		checkpoint = readJournalCheckpoint(cached);
		if (checkpoint) {
			if (checkpoint.stat.join(":") === stat.join(":")) return cached;
			if (checkpoint.endsWithNewline && Number(checkpoint.stat[2]) < Number(before.size)) seed = cached;
		}
	}
	const skipBytes = seed && checkpoint ? Number(checkpoint.stat[2]) : 0;
	const prefixHash = new Bun.CryptoHasher("sha256");
	const contentHash = new Bun.CryptoHasher("sha256");
	let prefixRemaining = skipBytes;
	let bytesRead = 0;
	let endsWithNewline = false;
	let header: SessionHeader | undefined;
	let metadata: SessionIdentityMetadata | undefined = seed
		? {
				version: SESSION_IDENTITY_VERSION,
				actorHandle: seed.record.actorHandle,
				assignments: seed.record.assignments,
				generation: seed.record.generation ?? null,
				idleSleepSeconds: seed.record.idleSleepSeconds,
			}
		: undefined;
	let entryId = seed?.entryId ?? "";
	let firstEntry = seed === undefined;
	try {
		await visitEntriesFromFileStream(
			canonicalFile,
			entry => {
				const leading = firstEntry;
				firstEntry = false;
				if (leading && entry.type === "session") {
					header = entry;
					return;
				}
				if (!header && !seed) {
					if (
						entry.type === "session" ||
						(entry.type === "custom" && entry.customType === SESSION_IDENTITY_CUSTOM_TYPE)
					) {
						throw new SessionIdentityMetadataError("Invalid leading session header");
					}
					return;
				}
				if (entry.type !== "custom" || entry.customType !== SESSION_IDENTITY_CUSTOM_TYPE) return;
				metadata = parseSessionIdentityMetadata(entry.data, entry.id);
				entryId = entry.id;
			},
			{
				throwIfMissing: true,
				maxBytes: Number(before.size),
				skipBytes,
				yieldEveryBytes: 8 * 1024 * 1024,
				onChunk: chunk => {
					contentHash.update(chunk);
					if (prefixRemaining > 0) {
						const count = Math.min(prefixRemaining, chunk.byteLength);
						prefixHash.update(chunk.subarray(0, count));
						prefixRemaining -= count;
					}
					bytesRead += chunk.byteLength;
					if (chunk.byteLength > 0) endsWithNewline = chunk[chunk.byteLength - 1] === 0x0a;
				},
				onMalformedRecord: () => {
					throw new SessionIdentityMetadataError("Cannot reconcile identity from a malformed journal");
				},
			},
		);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		if (seed) return readJournalIdentity(file);
		throw error;
	}
	// Size growth alone does not establish append-only history: verify every
	// previously validated byte cheaply before trusting the cached identity.
	if (seed && checkpoint && prefixHash.digest("hex") !== checkpoint.contentHash) return readJournalIdentity(file);
	const found = header;
	if (!found && !seed) return undefined;
	const sessionId = seed?.record.sessionId ?? found?.id;
	if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId))
		throw new SessionIdentityMetadataError("Cannot reconcile identity from an invalid session id");
	const record: SessionIdentityRecord = {
		sessionId,
		sessionFile: canonicalFile,
		cwd: seed ? seed.record.cwd : typeof found?.cwd === "string" ? found.cwd : "",
		rootAgent: seed ? seed.record.rootAgent : found ? readRootAgent(found) : undefined,
		generation: metadata?.generation ?? undefined,
		idleSleepSeconds: metadata?.idleSleepSeconds,
		actorHandle: metadata?.actorHandle ?? null,
		assignments: (metadata?.assignments ?? []).map(assignment => ({ ...assignment })),
		modifiedAt: Number(before.mtimeMs),
	};
	const journal: JournalIdentity = { record, entryId };
	try {
		const after = journalStat(await fs.promises.stat(canonicalFile, { bigint: true }));
		const stable = stat.join(":") === after.join(":");
		const growing =
			endsWithNewline && stat[0] === after[0] && stat[1] === after[1] && Number(after[2]) > Number(before.size);
		// An active writer may append beyond our bounded snapshot. Keep the
		// validated prefix, not the newer stat: its hash must match next time.
		if ((stable || growing) && bytesRead === Number(before.size)) {
			const digest = contentHash.digest("hex");
			journal.fileFingerprint = JSON.stringify({
				stat,
				contentHash: digest,
				endsWithNewline,
				digest: journalFingerprint(stat, journal, digest, endsWithNewline),
			} satisfies JournalCheckpoint);
		}
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	return journal;
}

/** Canonical session files under one catalog root: symlinked buckets are skipped and aliases collapse. */
async function discoverSessionFiles(sessionsRoot: string): Promise<string[]> {
	let buckets: fs.Dirent[];
	try {
		buckets = await fs.promises.readdir(sessionsRoot, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error) || isEnotdir(error)) return [];
		throw error;
	}
	const files: string[] = [];
	for (const entry of buckets) {
		if (entry.name.endsWith(".jsonl") && (entry.isFile() || entry.isSymbolicLink()))
			files.push(path.join(sessionsRoot, entry.name));
	}
	for (const bucket of buckets) {
		if (bucket.isSymbolicLink() || !bucket.isDirectory()) continue;
		const dir = path.join(sessionsRoot, bucket.name);
		for await (const name of new Bun.Glob("*.jsonl").scan({ cwd: dir, followSymlinks: true })) {
			files.push(path.join(dir, name));
		}
	}
	const seen = new Set<string>();
	const canonical: string[] = [];
	for (const file of files) {
		let real: string;
		try {
			real = await fs.promises.realpath(file);
		} catch {
			continue;
		}
		if (seen.has(real)) continue;
		seen.add(real);
		canonical.push(real);
	}
	return canonical;
}

async function readJournals(
	files: readonly string[],
	projected: readonly SessionIdentityProjection[],
): Promise<JournalIdentity[]> {
	const byFile = new Map(projected.map(row => [row.sessionFile, row]));
	const journals: (JournalIdentity | undefined)[] = new Array(files.length);
	const stride = Math.min(SESSION_SCAN_WORKERS, Math.max(1, files.length));
	await Promise.all(
		Array.from({ length: stride }, async (_, worker) => {
			for (let index = worker; index < files.length; index += stride) {
				const file = files[index]!;
				const journal = await readJournalIdentity(file, byFile.get(file));
				if (journal) journals[index] = journal;
			}
		}),
	);
	return journals.filter((journal): journal is JournalIdentity => journal !== undefined);
}

function collectNameConflicts(records: readonly SessionIdentityRecord[]): SessionIdentityNameConflict[] {
	const owners = new Map<string, Set<string>>();
	for (const record of records) {
		if (!record.actorHandle) continue;
		const handle = record.actorHandle.toLowerCase();
		const ids = owners.get(handle) ?? new Set<string>();
		ids.add(record.sessionId);
		owners.set(handle, ids);
	}
	return [...owners.entries()]
		.filter(([, ids]) => ids.size > 1)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([handle, ids]) => ({
			code: "duplicate_handle" as const,
			handle,
			sessionIds: [...ids].sort(),
		}));
}

function conflictingHandleError(
	handle: string,
	sessionIds: readonly string[],
	limit: number,
): SessionIdentityConflictError {
	const ids = [...new Set(sessionIds)].sort();
	return new SessionIdentityConflictError(
		`Actor handle "${handle}" is claimed by more than one session: ${bounded(ids, limit).join(", ")}.`,
		{ sessionIds: ids, actorHandle: handle },
	);
}

function toProjection(root: string, journal: JournalIdentity): SessionIdentityProjection {
	return {
		sessionsRoot: root,
		sessionId: journal.record.sessionId,
		sessionFile: journal.record.sessionFile,
		cwd: journal.record.cwd,
		rootAgent: journal.record.rootAgent ?? null,
		generation: journal.record.generation ?? null,
		idleSleepSeconds: journal.record.idleSleepSeconds ?? null,
		actorHandle: journal.record.actorHandle,
		assignments: journal.record.assignments.map(assignment => ({ ...assignment })),
		entryId: journal.entryId,
		fileFingerprint: journal.fileFingerprint ?? null,
	};
}

function sameProjection(
	rows: readonly SessionIdentityProjection[],
	expected: Map<string, SessionIdentityProjection>,
): boolean {
	if (rows.length !== expected.size) return false;
	for (const row of rows) {
		const next = expected.get(row.sessionId);
		if (!next) return false;
		if (
			row.sessionsRoot !== next.sessionsRoot ||
			row.sessionFile !== next.sessionFile ||
			row.cwd !== next.cwd ||
			row.rootAgent !== next.rootAgent ||
			row.generation !== next.generation ||
			(row.idleSleepSeconds ?? null) !== (next.idleSleepSeconds ?? null) ||
			row.actorHandle !== next.actorHandle ||
			row.entryId !== next.entryId ||
			(row.fileFingerprint ?? null) !== (next.fileFingerprint ?? null) ||
			JSON.stringify(row.assignments) !== JSON.stringify(next.assignments)
		) {
			return false;
		}
	}
	return true;
}

/**
 * Advertise the authoritative journals in the projection table. Only rows that
 * differ are written, and only this catalog scope's rows are rebuilt.
 */
function reconcileProjection(catalog: IdentityCatalog): void {
	const conflicted = new Set(catalog.conflicts.flatMap(conflict => conflict.sessionIds));
	const expected = new Map<string, SessionIdentityProjection>();
	for (const journal of catalog.journals.values()) {
		if (conflicted.has(journal.record.sessionId)) continue;
		expected.set(journal.record.sessionId, toProjection(catalog.root, journal));
	}
	const projected = listSessionIdentityProjection(catalog.root);
	if (sameProjection(projected, expected)) return;
	replaceSessionIdentityProjection(catalog.root, [...expected.values()]);
}

async function scanCatalog(root: string, limit: number): Promise<IdentityCatalog> {
	const files = await discoverSessionFiles(root);
	const journals = await readJournals(files, listSessionIdentityProjection(root));
	const byId = new Map<string, JournalIdentity>();
	for (const journal of journals) {
		const existing = byId.get(journal.record.sessionId);
		if (existing) {
			throw new SessionIdentityConflictError(
				`Session id "${journal.record.sessionId}" is claimed by more than one journal: ${bounded(
					[existing.record.sessionFile, journal.record.sessionFile],
					limit,
				).join(", ")}.`,
				{ sessionIds: [journal.record.sessionId] },
			);
		}
		byId.set(journal.record.sessionId, journal);
	}
	const records = [...byId.values()].map(journal => journal.record);
	return { root, journals: byId, records, conflicts: collectNameConflicts(records) };
}

async function loadCatalog(root: string, limit: number): Promise<IdentityCatalog> {
	const catalog = await scanCatalog(root, limit);
	reconcileProjection(catalog);
	return catalog;
}

/**
 * Serialize one catalog mutation or reconciliation on the OS-backed catalog
 * lock. The root directory is created first so the lock target is stable.
 */
async function withCatalogRoot<T>(
	options: SessionIdentityCatalogOptions | undefined,
	run: (root: string) => Promise<T>,
): Promise<T> {
	const requestedRoot = resolveSessionsRoot(options);
	await fs.promises.mkdir(requestedRoot, { recursive: true });
	const root = await fs.promises.realpath(requestedRoot);
	return withFileLock(path.join(root, CATALOG_LOCK_BASENAME), () => run(root));
}

/** Resolve a read-only view through the catalog's one name/prefix/ambiguity policy. */
export function resolveSessionIdentityReference(
	records: readonly Pick<SessionIdentityRecord, "sessionId" | "actorHandle">[],
	reference: string,
	limit = DEFAULT_CANDIDATE_LIMIT,
): string {
	const normalized = normalizeReference(reference);
	const lowered = normalized.toLowerCase();
	const handleClaimants = records.filter(record => record.actorHandle?.toLowerCase() === lowered);
	const claimantIds = [...new Set(handleClaimants.map(record => record.sessionId))].sort();
	if (claimantIds.length > 1) throw conflictingHandleError(lowered, claimantIds, limit);
	const matches = records.filter(
		record => record.actorHandle?.toLowerCase() === lowered || record.sessionId.toLowerCase().startsWith(lowered),
	);
	if (matches.length === 1) return matches[0]!.sessionId;
	if (matches.length > 1)
		throw new SessionIdentityAmbiguousError(normalized, bounded(matches.map(candidateLabel), limit));
	const suggestions = records.filter(record => record.actorHandle?.toLowerCase().startsWith(lowered));
	throw new SessionIdentityNotFoundError(normalized, bounded(suggestions.map(candidateLabel), limit));
}

function resolveInCatalog(catalog: IdentityCatalog, reference: string, limit: number): SessionIdentityRecord {
	const id = resolveSessionIdentityReference(catalog.records, reference, limit);
	return cloneRecord(catalog.records.find(record => record.sessionId === id)!);
}

function assertHandleAvailable(
	catalog: IdentityCatalog,
	excludeSessionId: string | undefined,
	actorHandle: string | null,
	limit: number,
): void {
	if (!actorHandle) return;
	const claimants = catalog.records
		.filter(
			record =>
				record.actorHandle?.toLowerCase() === actorHandle.toLowerCase() && record.sessionId !== excludeSessionId,
		)
		.map(record => record.sessionId);
	if (claimants.length === 0) return;
	throw new SessionIdentityConflictError(
		`Actor handle "${actorHandle}" is already claimed by: ${bounded(claimants, limit).join(", ")}.`,
		{ sessionIds: [...claimants].sort(), actorHandle },
	);
}

function mergeIdentityMetadata(current: SessionIdentityRecord, patch: SessionIdentityPatch): SessionIdentityMetadata {
	const actorHandle =
		patch.actorHandle === undefined ? current.actorHandle : normalizeActorHandle(patch.actorHandle, true);
	const assignments =
		patch.assignments === undefined
			? current.assignments.map(assignment => ({ ...assignment }))
			: patch.assignments.map(assignment => ({ kind: assignment.kind, target: assignment.target }));
	const generation =
		patch.generation === undefined
			? (current.generation ?? null)
			: patch.generation === null
				? null
				: normalizePin("generation", patch.generation);
	const idleSleepSeconds = patch.idleSleepSeconds === undefined ? current.idleSleepSeconds : patch.idleSleepSeconds;
	return parseSessionIdentityMetadata({
		version: SESSION_IDENTITY_VERSION,
		actorHandle,
		assignments,
		generation,
		idleSleepSeconds,
	});
}

function sameIdentityMetadata(left: SessionIdentityMetadata, right: SessionIdentityMetadata): boolean {
	return (
		(left.actorHandle ?? null) === (right.actorHandle ?? null) &&
		(left.generation ?? null) === (right.generation ?? null) &&
		(left.idleSleepSeconds ?? null) === (right.idleSleepSeconds ?? null) &&
		JSON.stringify(left.assignments ?? []) === JSON.stringify(right.assignments ?? [])
	);
}

async function assertMutationOwner(manager: SessionManager, sessionId: string): Promise<string> {
	const sessionFile = manager.getCanonicalSessionFile();
	if (!sessionFile || manager.getSessionId() !== sessionId)
		throw new SessionIdentityPersistError(sessionId, "the manager has no matching canonical journal");
	const held = isSessionLeaseHeld(sessionId);
	if (held === null) {
		throw new SessionReservationUnavailableError(sessionId, "the ownership lease could not be probed");
	}
	if (!manager.hasSessionOwnership()) {
		if (held) throw new SessionReservationBusyError(sessionId);
		throw new SessionReservationUnavailableError(sessionId, "the manager does not hold the ownership lease");
	}
	return sessionFile;
}

function assertDurableIdentity(
	sessionId: string,
	canonicalFile: string,
	expectedMetadata: SessionIdentityMetadata,
	entryId: string,
	durable: JournalIdentity | undefined,
): JournalIdentity {
	if (!durable || durable.record.sessionId !== sessionId || durable.record.sessionFile !== canonicalFile) {
		throw new SessionIdentityPersistError(sessionId, "the journal no longer resolves to this session");
	}
	if (durable.entryId !== entryId) {
		throw new SessionIdentityPersistError(sessionId, "the identity entry is not the newest durable entry");
	}
	const durableMetadata: SessionIdentityMetadata = {
		version: SESSION_IDENTITY_VERSION,
		actorHandle: durable.record.actorHandle,
		assignments: durable.record.assignments,
		generation: durable.record.generation ?? null,
		idleSleepSeconds: durable.record.idleSleepSeconds,
	};
	if (!sameIdentityMetadata(durableMetadata, expectedMetadata)) {
		throw new SessionIdentityPersistError(sessionId, "the durable identity differs from the requested snapshot");
	}
	return durable;
}

function validateExistingPins(
	record: SessionIdentityRecord,
	cwd: string,
	pins: { rootAgent?: string; generation?: string; actorHandle?: string },
): void {
	if (record.cwd && normalizePathForComparison(record.cwd) !== normalizePathForComparison(cwd)) {
		throw new SessionIdentityPinConflictError(record.sessionId, "cwd", record.cwd, cwd);
	}
	if (pins.rootAgent !== undefined && record.rootAgent !== undefined && record.rootAgent !== pins.rootAgent) {
		throw new SessionIdentityPinConflictError(record.sessionId, "rootAgent", record.rootAgent, pins.rootAgent);
	}
	if (pins.generation !== undefined && record.generation !== undefined && record.generation !== pins.generation) {
		throw new SessionIdentityPinConflictError(record.sessionId, "generation", record.generation, pins.generation);
	}
	if (pins.actorHandle !== undefined && record.actorHandle?.toLowerCase() !== pins.actorHandle.toLowerCase()) {
		throw new SessionIdentityPinConflictError(
			record.sessionId,
			"actorHandle",
			record.actorHandle ?? "(unassigned)",
			pins.actorHandle,
		);
	}
}

/**
 * Every raw identity claim in the catalog plus the names that several sessions
 * claim, from one locked scan. Duplicate names are reported, not resolved;
 * duplicate session ids and malformed claims still refuse.
 */
export async function listSessionIdentityInventory(
	options: SessionIdentityCatalogOptions = {},
): Promise<SessionIdentityInventory> {
	const limit = candidateLimit(options);
	return withCatalogRoot(options, async root => {
		const catalog = await loadCatalog(root, limit);
		return {
			records: catalog.records.map(cloneRecord),
			conflicts: catalog.conflicts.map(conflict => ({ ...conflict, sessionIds: [...conflict.sessionIds] })),
		};
	});
}

/**
 * Every session identity in the catalog, discovered cold from journals.
 * Historical duplicate names stay visible; addressing one of them refuses.
 */
export async function listSessionIdentities(
	options: SessionIdentityCatalogOptions = {},
): Promise<SessionIdentityRecord[]> {
	return (await listSessionIdentityInventory(options)).records;
}

/**
 * Resolve one session by full id, unique id prefix, or actor handle. Ambiguous
 * and missing references fail closed with bounded candidates, and a historical
 * name claimed by several sessions refuses instead of selecting one.
 */
export async function resolveSessionIdentity(
	reference: string,
	options: SessionIdentityCatalogOptions = {},
): Promise<SessionIdentityRecord> {
	const normalized = normalizeReference(reference);
	const limit = candidateLimit(options);
	return withCatalogRoot(options, async root => {
		const catalog = await loadCatalog(root, limit);
		return resolveInCatalog(catalog, normalized, limit);
	});
}

/**
 * Mutate one live session's identity through its own manager. The journal is
 * flushed before the projection is advertised, and the returned record is read
 * back from the durable journal rather than from in-memory entries.
 */
export async function assignSessionIdentity(
	manager: SessionManager,
	patch: SessionIdentityPatch,
	options: SessionIdentityMutationOptions = {},
): Promise<SessionIdentityRecord> {
	if (!(manager instanceof SessionManager)) throw new TypeError("assignSessionIdentity needs a SessionManager");
	if (
		!isRecord(patch) ||
		Object.keys(patch).some(key => !["actorHandle", "assignments", "generation", "idleSleepSeconds"].includes(key))
	) {
		throw new TypeError("Identity patch accepts only actorHandle, assignments, generation and idleSleepSeconds");
	}
	const expected = options.expected && { ...options.expected };
	const limit = candidateLimit(options);
	const sessionId = manager.getSessionId();
	using _identityMutation = manager.beginIdentityMutation();
	const sessionsRoot =
		options.sessionsRoot ??
		resolveManagedSessionRoot(manager.getSessionDir(), manager.getCwd()) ??
		manager.getSessionDir();
	return await withCatalogRoot({ ...options, sessionsRoot }, async root => {
		await manager.prepareIdentityJournal();
		const sessionFile = await assertMutationOwner(manager, sessionId);
		const catalog = await loadCatalog(root, limit);
		const current = catalog.journals.get(sessionId);
		if (!current || current.record.sessionFile !== sessionFile) {
			throw new SessionIdentityConflictError(
				`Journal "${sessionFile}" no longer identifies session "${sessionId}".`,
				{ sessionIds: [sessionId] },
			);
		}
		const assertCurrentOwner = (): void => {
			if (expected && (expected.sessionId !== sessionId || expected.sessionFile !== sessionFile)) {
				throw new SessionIdentityPersistError(sessionId, "the requested session target no longer matches");
			}
			if (
				manager.getSessionId() !== sessionId ||
				!manager.hasSessionOwnership() ||
				manager.getCanonicalSessionFile() !== sessionFile
			)
				throw new SessionIdentityPersistError(sessionId, "the manager changed identity or lost its lease");
		};
		assertCurrentOwner();
		const metadata = mergeIdentityMetadata(current.record, patch);
		assertHandleAvailable(catalog, sessionId, metadata.actorHandle ?? null, limit);
		const currentSnapshot: SessionIdentityMetadata = {
			version: SESSION_IDENTITY_VERSION,
			actorHandle: current.record.actorHandle,
			assignments: current.record.assignments,
			generation: current.record.generation ?? null,
			idleSleepSeconds: current.record.idleSleepSeconds,
		};
		if (sameIdentityMetadata(metadata, currentSnapshot)) {
			reconcileProjection(catalog);
			return cloneRecord(current.record);
		}
		const entryId = await manager.appendEntriesAtomically(() => {
			assertCurrentOwner();
			return manager.appendSessionIdentityMetadata(metadata);
		});
		const publishedFile = manager.getSessionFile();
		if (!(await isSameJournal(publishedFile, sessionFile)) || !manager.hasSessionOwnership()) {
			throw new SessionIdentityPersistError(
				sessionId,
				"the manager changed journal or lost its lease while appending",
			);
		}
		const durable = assertDurableIdentity(
			sessionId,
			sessionFile,
			metadata,
			entryId,
			await readJournalIdentity(sessionFile, toProjection(root, current)),
		);
		catalog.journals.set(sessionId, durable);
		catalog.records = [...catalog.journals.values()].map(journal => journal.record);
		catalog.conflicts = collectNameConflicts(catalog.records);
		reconcileProjection(catalog);
		return cloneRecord(durable.record);
	});
}

/**
 * Converge one session at `cwd`: open the session named by `reference` (or the
 * one already claiming `actorHandle`) or materialize a new header with identity
 * metadata. No inference turn runs. A missing reference never creates a session,
 * and a live or unobservable owner refuses the cold open. A reference or handle
 * pin naming a claim that several sessions hold refuses instead of choosing one.
 */
export async function createOrOpenSessionIdentity(
	options: CreateOrOpenSessionIdentityOptions,
): Promise<{ manager: SessionManager; identity: SessionIdentityRecord; created: boolean }> {
	if (typeof options !== "object" || options === null)
		throw new TypeError("createOrOpenSessionIdentity needs options");
	const requestedCwd = options.cwd;
	if (typeof requestedCwd !== "string" || !path.isAbsolute(requestedCwd)) {
		throw new TypeError("Session working directory must be an absolute path");
	}
	const cwd = path.resolve(requestedCwd);
	const reference = options.reference === undefined ? undefined : normalizeReference(options.reference);
	const actorHandle =
		options.actorHandle === undefined ? undefined : (normalizeActorHandle(options.actorHandle, false) ?? undefined);
	const pins = {
		rootAgent: options.rootAgent === undefined ? undefined : normalizePin("rootAgent", options.rootAgent),
		generation: options.generation === undefined ? undefined : normalizePin("generation", options.generation),
		actorHandle,
	};
	const limit = candidateLimit(options.catalog);
	return withCatalogRoot(options.catalog, async root => {
		const catalog = await loadCatalog(root, limit);
		const nameConflict =
			actorHandle === undefined
				? undefined
				: catalog.conflicts.find(conflict => conflict.handle === actorHandle.toLowerCase());
		if (nameConflict) throw conflictingHandleError(nameConflict.handle, nameConflict.sessionIds, limit);
		let target: SessionIdentityRecord | undefined;
		if (reference !== undefined) {
			target = resolveInCatalog(catalog, reference, limit);
		} else if (actorHandle !== undefined) {
			target = catalog.records.find(record => record.actorHandle?.toLowerCase() === actorHandle.toLowerCase());
		}
		if (target) {
			validateExistingPins(target, cwd, pins);
			return openExistingIdentity(target, cwd, pins);
		}
		return createFreshIdentity(options, cwd, root, catalog, limit);
	});
}

async function openExistingIdentity(
	record: SessionIdentityRecord,
	cwd: string,
	pins: { rootAgent?: string; generation?: string; actorHandle?: string },
): Promise<{ manager: SessionManager; identity: SessionIdentityRecord; created: boolean }> {
	const { sessionId, sessionFile } = record;
	const storage = new FileSessionStorage();
	if (!storage.existsSync(sessionFile)) {
		throw new SessionIdentityNotFoundError(sessionId, [sessionFile]);
	}
	const held = isSessionLeaseHeld(sessionId);
	if (held === null) {
		throw new SessionReservationUnavailableError(sessionId, "the ownership lease could not be probed");
	}
	if (held) throw new SessionReservationBusyError(sessionId);
	const reservation = storage.reserveSession(sessionId, sessionFile);
	if (reservation.active !== true || isSessionLeaseHeld(sessionId) !== true) {
		reservation.release();
		throw new SessionReservationUnavailableError(sessionId, "the ownership lease is not observable");
	}
	let manager: SessionManager | undefined;
	try {
		manager = await SessionManager.open(sessionFile, path.dirname(sessionFile), storage, {
			initialCwd: record.cwd || cwd,
			throwIfMissing: true,
			suppressBreadcrumb: true,
			ownershipPolicy: "require-owner",
			ownershipReservation: reservation,
			validateHeader: header => {
				if (!header) throw new SessionIdentityConflictError(`Journal "${sessionFile}" has no session header`);
				if (header.id !== sessionId) {
					throw new SessionIdentityConflictError(
						`Journal "${sessionFile}" identifies session "${header.id}", not "${sessionId}".`,
						{ sessionIds: [sessionId] },
					);
				}
				const recordedCwd = typeof header.cwd === "string" ? header.cwd : "";
				if (recordedCwd && normalizePathForComparison(recordedCwd) !== normalizePathForComparison(cwd)) {
					throw new SessionIdentityPinConflictError(sessionId, "cwd", recordedCwd, cwd);
				}
				const rootAgent = readRootAgent(header);
				if (pins.rootAgent !== undefined && rootAgent !== undefined && rootAgent !== pins.rootAgent) {
					throw new SessionIdentityPinConflictError(sessionId, "rootAgent", rootAgent, pins.rootAgent);
				}
			},
		});
		if (
			manager.getSessionId() !== sessionId ||
			!(await isSameJournal(manager.getSessionFile(), sessionFile)) ||
			!manager.hasSessionOwnership()
		) {
			throw new SessionIdentityPersistError(sessionId, "the opened manager left the exact journal or lease");
		}
		const durable = await readJournalIdentity(sessionFile);
		if (!durable || durable.record.sessionId !== sessionId) {
			throw new SessionIdentityPersistError(sessionId, "the opened journal no longer resolves to this session");
		}
		validateExistingPins(durable.record, cwd, pins);
		return { manager, identity: cloneRecord(durable.record), created: false };
	} catch (error) {
		try {
			await manager?.close();
		} finally {
			reservation.release();
		}
		throw error;
	}
}

async function createFreshIdentity(
	options: CreateOrOpenSessionIdentityOptions,
	cwd: string,
	root: string,
	catalog: IdentityCatalog,
	limit: number,
): Promise<{ manager: SessionManager; identity: SessionIdentityRecord; created: boolean }> {
	const actorHandle = options.actorHandle === undefined ? null : normalizeActorHandle(options.actorHandle, false);
	assertHandleAvailable(catalog, undefined, actorHandle, limit);
	const storage: SessionStorage = new FileSessionStorage();
	const sessionDir = computeDefaultSessionDir(cwd, storage, root);
	const manager = SessionManager.create(cwd, sessionDir, storage);
	try {
		if (options.rootAgent !== undefined) await manager.setRootAgent(options.rootAgent);
		const metadata = parseSessionIdentityMetadata({
			version: SESSION_IDENTITY_VERSION,
			actorHandle,
			assignments: (options.assignments ?? []).map(assignment => ({ ...assignment })),
			generation: options.generation === undefined ? null : normalizePin("generation", options.generation),
		});
		const entryId = await manager.appendEntriesAtomically(() => manager.appendSessionIdentityMetadata(metadata));
		const sessionId = manager.getSessionId();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new SessionIdentityPersistError(sessionId, "the new session has no journal");
		const canonicalFile = await canonicalPath(sessionFile);
		const durable = assertDurableIdentity(
			sessionId,
			canonicalFile,
			metadata,
			entryId,
			await readJournalIdentity(sessionFile),
		);
		catalog.journals.set(sessionId, durable);
		catalog.records = [...catalog.journals.values()].map(journal => journal.record);
		catalog.conflicts = collectNameConflicts(catalog.records);
		reconcileProjection(catalog);
		return { manager, identity: cloneRecord(durable.record), created: true };
	} catch (error) {
		const unadvertised = manager.getSessionFile();
		try {
			await manager.close();
		} finally {
			if (unadvertised) await manager.dropSession(unadvertised).catch(() => undefined);
		}
		throw error;
	}
}
