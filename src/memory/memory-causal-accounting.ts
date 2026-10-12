/** Optional v1 accounting extension. Main memory schema and intake authority
 * remain unchanged; older v37 readers/writers can ignore these tables. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { captureModelUsageProvenance, capturedModelUsageAttribution, createMemoryAccountingOrigin,
  memoryAccountingParent, type MemoryAccountingOrigin, type UsageParentTurn } from '../runtime/usage-log.js';
import { parseAutomaticMemoryEnvelope, automaticMemoryCandidateIdentity, type AutomaticMemoryEnvelope, type AutomaticMemoryOrigin } from './memory-destination.js';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const META = `CREATE TABLE memory_causal_accounting_meta (version INTEGER PRIMARY KEY CHECK (version = 1))`;
const ORIGINS = `CREATE TABLE memory_candidate_accounting_origins (
  candidate_id INTEGER PRIMARY KEY REFERENCES memory_reflection_candidates(id) ON DELETE CASCADE,
  identity_digest TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('owned','unowned')),
  session_id TEXT, source_event_id TEXT, source_user_seq INTEGER, attempt_id TEXT)`;
const normalized = (sql: string): string => sql.replace(/\s+/g, ' ').trim().toLowerCase();
function unsupportedExtensionNamespace(db: Database.Database): boolean {
  // SQLite names resolve without case sensitivity. Refuse TEMP shadows and
  // relevant triggers before even the first extension initialization write.
  if (db.prepare(`SELECT 1 FROM sqlite_temp_master WHERE
    lower(name) IN ('memory_causal_accounting_meta','memory_candidate_accounting_origins')
    OR (type = 'trigger' AND lower(tbl_name) IN ('memory_causal_accounting_meta','memory_candidate_accounting_origins')) LIMIT 1`).get()) return true;
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'trigger'
    AND lower(tbl_name) IN ('memory_causal_accounting_meta','memory_candidate_accounting_origins') LIMIT 1`).get();
}
function extension(db: Database.Database, create: boolean): boolean {
  if (unsupportedExtensionNamespace(db)) return false;
  const names = ['memory_causal_accounting_meta', 'memory_candidate_accounting_origins'];
  const rows = names.map(name => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE").get(name) as { sql: string } | undefined);
  if (!rows[0] && !rows[1] && create) {
    db.exec(META.replace('CREATE TABLE ', 'CREATE TABLE main.'));
    db.exec(ORIGINS.replace('CREATE TABLE ', 'CREATE TABLE main.'));
    db.prepare('INSERT INTO main.memory_causal_accounting_meta (version) VALUES (1)').run();
  } else if (!rows[0] || !rows[1] || normalized(rows[0].sql) !== normalized(META)
    || normalized(rows[1].sql) !== normalized(ORIGINS)) return false;
  const versions = db.prepare('SELECT version FROM main.memory_causal_accounting_meta').all() as { version: unknown }[];
  return versions.length === 1 && versions[0]!.version === 1;
}
function exactSource(origin: AutomaticMemoryOrigin): boolean {
  const source = origin.source;
  if (source.authority !== 'accepted_user_input' || source.eventType !== 'user_input_received'
    || source.eventSeq === null || source.eventId === null) return false;
  const row = openEventLog().prepare(`SELECT id, session_id, seq, role, type,
    CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.text') END AS text,
    CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.synthetic') END AS synthetic,
    CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.system') END AS system,
    CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.notification') END AS notification
    FROM main.events WHERE id = ? AND session_id = ? AND seq = ?`).get(source.eventId, source.sessionId, source.eventSeq) as Record<string, unknown> | undefined;
  return !!row && row.role === 'user' && row.type === 'user_input_received' && typeof row.text === 'string'
    && hash(row.text) === origin.ownerTextDigest
    && [row.synthetic, row.system, row.notification].every(value => value === null || value === 0);
}
function exactAttempt(parent: UsageParentTurn): boolean {
  if (!parent.attemptId) return false;
  const row = openEventLog().prepare('SELECT session_id, source_user_seq FROM main.run_attempts WHERE attempt_id = ?')
    .get(parent.attemptId) as { session_id: string; source_user_seq: number | null } | undefined;
  return row?.session_id === parent.sessionId && row.source_user_seq === parent.sourceUserSeq;
}
/** Capture the explicit first scheduling attempt, never a latest/admission guess. */
export function captureAutomaticMemoryAccountingOrigin(origin: AutomaticMemoryOrigin): MemoryAccountingOrigin {
  try {
    const current = capturedModelUsageAttribution(captureModelUsageProvenance());
    const parent = current?.memoryAccountingOrigin ? memoryAccountingParent(current.memoryAccountingOrigin)
      : current && current.sessionId && current.sourceUserSeq > 0 ? current : current?.usageParentTurn;
    if (exactSource(origin)) {
      if (parent?.sessionId === origin.source.sessionId && parent.sourceUserSeq === origin.source.eventSeq
        && exactAttempt(parent)) return createMemoryAccountingOrigin(parent);
      return createMemoryAccountingOrigin({ sessionId: origin.source.sessionId, sourceUserSeq: origin.source.eventSeq! });
    }
  } catch { /* accounting failure never changes intake */ }
  return createMemoryAccountingOrigin();
}
interface CandidateIdentity { id: number; session_id: string; call_id: string; episode_id: string | null; candidate_hash: string }
function identity(row: CandidateIdentity, envelope: AutomaticMemoryEnvelope, parent?: UsageParentTurn): string {
  return hash({ version: 1, id: row.id, sessionId: row.session_id, callId: row.call_id,
    episodeId: row.episode_id, candidateHash: row.candidate_hash, originDigest: envelope.originDigest, parent: parent ?? null });
}
/** Called only after the first candidate INSERT in its enclosing transaction.
 * Savepoint failure loses accounting only. Existing/legacy rows never upgrade. */
export function recordFirstMemoryCandidateAccounting(db: Database.Database, id: number,
  envelope: AutomaticMemoryEnvelope, token: MemoryAccountingOrigin): void {
  try {
    db.transaction(() => {
      if (!extension(db, true)) return;
      const row = db.prepare('SELECT id, session_id, call_id, episode_id, candidate_hash, kind, text, authority, destination_json FROM main.memory_reflection_candidates WHERE id = ?')
        .get(id) as CandidateIdentity & { kind: string; text: string; authority: string; destination_json: string | null } | undefined;
      if (!row || row.session_id !== envelope.origin.source.sessionId
        || row.candidate_hash !== automaticMemoryCandidateIdentity(envelope.origin)
        || row.kind !== envelope.origin.candidate.kind || row.text !== envelope.origin.candidate.text
        || row.authority !== 'user' || row.destination_json !== JSON.stringify(envelope)) return;
      const parent = memoryAccountingParent(token);
      const sourceOnly = exactSource(envelope.origin) ? {
        sessionId: envelope.origin.source.sessionId, sourceUserSeq: envelope.origin.source.eventSeq!,
      } : undefined;
      const owned = parent && parent.sessionId === sourceOnly?.sessionId
        && parent.sourceUserSeq === sourceOnly?.sourceUserSeq && exactAttempt(parent);
      const retained = owned ? parent : sourceOnly;
      db.prepare(`INSERT INTO main.memory_candidate_accounting_origins
        (candidate_id, identity_digest, mode, session_id, source_event_id, source_user_seq, attempt_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, identity(row, envelope, retained), owned ? 'owned' : 'unowned',
        retained?.sessionId ?? null, retained ? envelope.origin.source.eventId : null,
        retained?.sourceUserSeq ?? null, owned ? parent.attemptId! : null);
    })();
  } catch { /* independent optional extension cannot break candidate intake */ }
}
/** Replay always supplies a marker, even when old writers had no extension.
 * A legacy exact source may remain source-only; no current attempt is adopted. */
export function readMemoryCandidateAccountingOrigin(id: number, db: Database.Database): MemoryAccountingOrigin {
  try {
    if (unsupportedExtensionNamespace(db)) return createMemoryAccountingOrigin();
    const row = db.prepare('SELECT id, session_id, call_id, episode_id, candidate_hash, kind, text, authority, destination_json FROM main.memory_reflection_candidates WHERE id = ?')
      .get(id) as CandidateIdentity & { kind: string; text: string; authority: string; destination_json: string | null } | undefined;
    if (!row?.destination_json) return createMemoryAccountingOrigin();
    const envelope = parseAutomaticMemoryEnvelope(row.destination_json);
    const source = envelope.origin.source;
    if (row.session_id !== source.sessionId || row.call_id !== `auto-capture:user-source:${source.eventSeq}`
      || row.candidate_hash !== automaticMemoryCandidateIdentity(envelope.origin) || row.kind !== envelope.origin.candidate.kind
      || row.text !== envelope.origin.candidate.text || row.authority !== 'user' || !exactSource(envelope.origin)) return createMemoryAccountingOrigin();
    const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE lower(name) IN ('memory_causal_accounting_meta','memory_candidate_accounting_origins') LIMIT 1").get();
    if (!hasTables) return createMemoryAccountingOrigin({ sessionId: source.sessionId, sourceUserSeq: source.eventSeq! });
    if (!extension(db, false)) return createMemoryAccountingOrigin();
    const stored = db.prepare('SELECT * FROM main.memory_candidate_accounting_origins WHERE candidate_id = ?').get(id) as Record<string, unknown> | undefined;
    if (!stored) return createMemoryAccountingOrigin({ sessionId: source.sessionId, sourceUserSeq: source.eventSeq! });
    if (stored.session_id !== source.sessionId || stored.source_event_id !== source.eventId
      || stored.source_user_seq !== source.eventSeq) return createMemoryAccountingOrigin();
    const sourceOnly = { sessionId: source.sessionId, sourceUserSeq: source.eventSeq! };
    if (stored.mode === 'unowned') return stored.attempt_id === null && stored.identity_digest === identity(row, envelope, sourceOnly)
      ? createMemoryAccountingOrigin(sourceOnly) : createMemoryAccountingOrigin();
    if (stored.mode !== 'owned' || typeof stored.attempt_id !== 'string') return createMemoryAccountingOrigin();
    const parent = { ...sourceOnly, attemptId: stored.attempt_id };
    return stored.identity_digest === identity(row, envelope, parent) && exactAttempt(parent)
      ? createMemoryAccountingOrigin(parent) : createMemoryAccountingOrigin();
  } catch { return createMemoryAccountingOrigin(); }
}
