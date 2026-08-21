/**
 * Durable, one-shot task continuity at a conversational pause boundary.
 *
 * This store deliberately does NOT decide whether a new message is an answer,
 * alter model input, or grant tool authority. It only persists the exact task
 * evidence a future accepted user source may consume. Bridge/capability
 * integration can therefore stay provider-neutral and separately reviewed.
 *
 * The packet lives in harness.db because its identity is an accepted harness
 * source `(sessionId, sourceUserSeq)`. Rows are exact-session scoped, survive a
 * daemon restart, expire, and may be consumed only by the next real accepted
 * user source in that same session.
 */
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openEventLog } from '../runtime/harness/eventlog.js';

export const TASK_CONTINUITY_PACKET_VERSION = 1 as const;
export const DEFAULT_TASK_CONTINUITY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_TASK_CONTINUITY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export type TaskContinuityPauseKind = 'clarification' | 'approval' | 'recovery';
export type TaskContinuityEffectClass = 'read' | 'write' | 'unknown';
/**
 * Evidence provenance only, never authority. In particular, `discovered`
 * means the capability was found/described, not proven safe or successful;
 * integration must not tighten the discovery governor from this tag alone.
 */
export type TaskContinuityEvidenceKind = 'resolved' | 'discovered' | 'settled';
export type TaskContinuityDismissReason =
  | 'topic_changed'
  | 'user_declined'
  | 'no_longer_needed'
  | 'invalidated';

/**
 * Capability identity plus the evidence needed to avoid reacquiring it.
 * This is intentionally capability-only: no invocation arguments or grants.
 */
export interface TaskContinuityCapabilityEvidence {
  kind: string;
  identifier: string;
  effectClass: TaskContinuityEffectClass;
  evidenceKind: TaskContinuityEvidenceKind;
  accountIdentity?: string;
  resourceRefs: string[];
  schemaFingerprint?: string;
}

export interface TaskContinuityPacket {
  version: typeof TASK_CONTINUITY_PACKET_VERSION;
  packetId: string;
  sessionId: string;
  originatingSourceUserSeq: number;
  originatingSourceEventId: string;
  pause: {
    kind: TaskContinuityPauseKind;
    question: string;
    options: string[];
    slot?: {
      goalId: string;
      revision: number;
      questionId: string;
      slotKey: string;
      predecessorRefs?: readonly string[];
    };
  };
  capabilities: TaskContinuityCapabilityEvidence[];
  createdAt: string;
  expiresAt: string;
}

export interface TaskContinuityPacketInput {
  sessionId: string;
  originatingSourceUserSeq: number;
  pause: {
    kind: TaskContinuityPauseKind;
    question: string;
    options?: readonly string[];
    slot?: {
      goalId: string;
      revision: number;
      questionId: string;
      slotKey: string;
      predecessorRefs?: readonly string[];
    };
  };
  capabilities?: ReadonlyArray<{
    kind: string;
    identifier: string;
    effectClass: TaskContinuityEffectClass;
    evidenceKind: TaskContinuityEvidenceKind;
    accountIdentity?: string;
    resourceRefs?: readonly string[];
    schemaFingerprint?: string;
  }>;
  /** Mutually exclusive with ttlMs. Must be a canonical future ISO timestamp. */
  expiresAt?: string;
  /** Defaults to seven days and is capped at thirty days. */
  ttlMs?: number;
}

/** Back-compatible verb-oriented name for callers that prefer it. */
export type CreateTaskContinuityPacketInput = TaskContinuityPacketInput;

export interface TaskContinuityClockOptions {
  /** Deterministic seam for tests; production callers omit it. */
  now?: string;
}

export type TaskContinuityLookupResult =
  | { status: 'available'; packet: TaskContinuityPacket }
  | { status: 'none' }
  | { status: 'ambiguous' }
  | { status: 'expired'; packetId: string }
  | { status: 'malformed'; packetId: string };

export interface ConsumeTaskContinuityPacketInput {
  sessionId: string;
  consumingSourceUserSeq: number;
  resolution?: TaskContinuityFrozenResolution;
}

export interface TaskContinuityFrozenResolution {
  resolverVersion: string;
  disposition: 'affirmed' | 'declined' | 'declined_with_new_task' | 'selected' | 'provided';
  selectedOption?: string;
  activeTaskInput?: string;
  semanticInputHash: string;
}

export interface DismissTaskContinuityPacketInput {
  sessionId: string;
  reason?: TaskContinuityDismissReason;
}

export type TaskContinuityDismissResult =
  | {
      status: 'dismissed';
      packetId: string;
      reason: TaskContinuityDismissReason;
      dismissedAt: string;
    }
  | { status: 'none' }
  | { status: 'ambiguous' }
  | { status: 'lost_race'; packetId: string };

export type TaskContinuityConsumeResult =
  | {
      status: 'consumed';
      packet: TaskContinuityPacket;
      consumingSourceUserSeq: number;
      consumingSourceEventId: string;
      consumedAt: string;
      resolution: TaskContinuityFrozenResolution;
      /** False for the one logical CAS; true when the exact same accepted
       * source rehydrates it after physical retry/restart. */
      replay: boolean;
    }
  | { status: 'none' }
  | { status: 'ambiguous' }
  | { status: 'expired'; packetId: string }
  | { status: 'malformed'; packetId: string }
  | { status: 'invalid_source'; packetId?: string }
  | { status: 'stale'; packetId: string }
  | { status: 'lost_race'; packetId: string };

/** Read-only projection of an already consumed packet. This is the durable
 * lineage verifier used after the answer resolver has closed the question;
 * unlike consume(), it can never claim or retire a packet. */
export type ConsumedTaskContinuityLookupResult =
  | {
      status: 'consumed';
      packet: TaskContinuityPacket;
      consumingSourceUserSeq: number;
      consumingSourceEventId: string;
      consumedAt: string;
      resolution: TaskContinuityFrozenResolution;
    }
  | { status: 'none' }
  | { status: 'ambiguous' }
  | { status: 'malformed'; packetId: string }
  | { status: 'invalid_source'; packetId?: string };

interface RawPacketRow {
  packet_id: string;
  version: number;
  session_id: string;
  originating_source_user_seq: number;
  originating_source_event_id: string;
  pause_kind: string;
  pause_question: string;
  pause_options_json: string;
  capability_evidence_json: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_by_source_user_seq: number | null;
  consumed_by_source_event_id: string | null;
  superseded_at: string | null;
  expired_at: string | null;
  dismissed_at: string | null;
  dismissed_reason: string | null;
  origin_audience_hash: string | null;
  consumer_audience_hash: string | null;
  resolver_version: string | null;
  resolution_disposition: string | null;
  resolution_selected_option: string | null;
  resolution_active_task_input: string | null;
  resolution_semantic_input_hash: string | null;
  pause_slot_json: string | null;
}

interface RawSourceRow {
  seq: number;
  id: string;
  session_id: string;
  role: string;
  type: string;
  data_json: string;
  created_at: string;
}

interface AcceptedSource {
  seq: number;
  eventId: string;
  sessionId: string;
  createdAt: string;
  dataHash: string;
  providerUserId?: string;
  conversationKey?: string;
  sharedChannel: boolean;
}

type DatabaseProvider = () => Database.Database;

const initializedDatabases = new WeakSet<Database.Database>();
const PAUSE_KINDS = new Set<TaskContinuityPauseKind>(['clarification', 'approval', 'recovery']);
const EFFECT_CLASSES = new Set<TaskContinuityEffectClass>(['read', 'write', 'unknown']);
const EVIDENCE_KINDS = new Set<TaskContinuityEvidenceKind>(['resolved', 'discovered', 'settled']);
const CAPABILITY_EVIDENCE_KEYS = new Set([
  'kind', 'identifier', 'effectClass', 'evidenceKind',
  'accountIdentity', 'resourceRefs', 'schemaFingerprint',
]);
const MAX_SESSION_ID_CHARS = 512;
const MAX_QUESTION_CHARS = 4_000;
const MAX_PAUSE_OPTIONS = 8;
const MAX_PAUSE_OPTION_CHARS = 500;
const MAX_CAPABILITY_ROWS = 16;
const MAX_KIND_CHARS = 96;
const MAX_IDENTIFIER_CHARS = 512;
const MAX_ACCOUNT_CHARS = 512;
const MAX_RESOURCE_REFS = 24;
const MAX_RESOURCE_REF_CHARS = 1_024;
const MAX_SCHEMA_FINGERPRINT_CHARS = 512;
const MAX_RESOLVER_VERSION_CHARS = 96;
const FROZEN_DISPOSITIONS = new Set<TaskContinuityFrozenResolution['disposition']>([
  'affirmed', 'declined', 'declined_with_new_task', 'selected', 'provided',
]);

function ensureSchema(db: Database.Database): void {
  if (initializedDatabases.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_continuity_packets (
      packet_id                       TEXT PRIMARY KEY,
      version                         INTEGER NOT NULL CHECK (version = 1),
      session_id                      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      originating_source_user_seq     INTEGER NOT NULL CHECK (originating_source_user_seq > 0),
      originating_source_event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      pause_kind                      TEXT NOT NULL
                                      CHECK (pause_kind IN ('clarification', 'approval', 'recovery')),
      pause_question                  TEXT NOT NULL,
      pause_options_json              TEXT NOT NULL CHECK (json_valid(pause_options_json) = 1),
      capability_evidence_json        TEXT NOT NULL CHECK (json_valid(capability_evidence_json) = 1),
      created_at                      TEXT NOT NULL,
      expires_at                      TEXT NOT NULL,
      consumed_at                     TEXT,
      consumed_by_source_user_seq     INTEGER,
      consumed_by_source_event_id     TEXT REFERENCES events(id) ON DELETE CASCADE,
      superseded_at                   TEXT,
      expired_at                      TEXT,
      dismissed_at                    TEXT,
      dismissed_reason                TEXT
                                      CHECK (dismissed_reason IS NULL OR dismissed_reason IN (
                                        'topic_changed', 'user_declined', 'no_longer_needed', 'invalidated'
                                      )),
      origin_audience_hash            TEXT,
      pause_slot_json                 TEXT,
      consumer_audience_hash          TEXT,
      resolver_version                TEXT,
      resolution_disposition          TEXT,
      resolution_selected_option      TEXT,
      resolution_active_task_input    TEXT,
      resolution_semantic_input_hash  TEXT,
      CHECK (expires_at > created_at),
      CHECK (
        (consumed_at IS NULL AND consumed_by_source_user_seq IS NULL AND consumed_by_source_event_id IS NULL)
        OR
        (consumed_at IS NOT NULL AND consumed_by_source_user_seq > 0 AND consumed_by_source_event_id IS NOT NULL)
      ),
      CHECK (
        (consumed_at IS NULL AND consumer_audience_hash IS NULL
          AND resolver_version IS NULL AND resolution_disposition IS NULL
          AND resolution_selected_option IS NULL AND resolution_active_task_input IS NULL
          AND resolution_semantic_input_hash IS NULL)
        OR
        (consumed_at IS NOT NULL AND consumer_audience_hash IS NOT NULL
          AND resolver_version IS NOT NULL AND resolution_disposition IS NOT NULL
          AND resolution_semantic_input_hash IS NOT NULL)
      ),
      CHECK (
        (dismissed_at IS NULL AND dismissed_reason IS NULL)
        OR
        (dismissed_at IS NOT NULL AND dismissed_reason IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_continuity_one_open_per_session
      ON task_continuity_packets(session_id)
      WHERE consumed_at IS NULL AND superseded_at IS NULL AND expired_at IS NULL AND dismissed_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_task_continuity_origin
      ON task_continuity_packets(session_id, originating_source_user_seq);

    CREATE TRIGGER IF NOT EXISTS task_continuity_origin_exact_session
    BEFORE INSERT ON task_continuity_packets
    FOR EACH ROW
    WHEN NOT EXISTS (
      SELECT 1
        FROM events e
       WHERE e.id = NEW.originating_source_event_id
         AND e.seq = NEW.originating_source_user_seq
         AND e.session_id = NEW.session_id
         AND e.type = 'user_input_received'
         AND e.role = 'user'
         AND json_valid(e.data_json) = 1
         AND (
           json_type(e.data_json, '$.synthetic') IS NULL
           OR json_type(e.data_json, '$.synthetic') = 'false'
         )
    )
    BEGIN
      SELECT RAISE(ABORT, 'task continuity origin is not an exact accepted user source');
    END;

    CREATE TRIGGER IF NOT EXISTS task_continuity_consumer_exact_session
    BEFORE UPDATE OF consumed_at, consumed_by_source_user_seq, consumed_by_source_event_id
      ON task_continuity_packets
    FOR EACH ROW
    WHEN NEW.consumed_at IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM events e
       WHERE e.id = NEW.consumed_by_source_event_id
         AND e.seq = NEW.consumed_by_source_user_seq
         AND e.session_id = NEW.session_id
         AND e.type = 'user_input_received'
         AND e.role = 'user'
         AND json_valid(e.data_json) = 1
         AND (
           json_type(e.data_json, '$.synthetic') IS NULL
           OR json_type(e.data_json, '$.synthetic') = 'false'
         )
    )
    BEGIN
      SELECT RAISE(ABORT, 'task continuity consumer is not an exact accepted user source');
    END;

    CREATE TRIGGER IF NOT EXISTS task_continuity_origin_audience_immutable
    BEFORE UPDATE OF origin_audience_hash, consumer_audience_hash ON task_continuity_packets
    FOR EACH ROW
    WHEN OLD.consumer_audience_hash IS NOT NULL
      OR OLD.origin_audience_hash IS NOT NEW.origin_audience_hash
    BEGIN
      SELECT RAISE(ABORT, 'task continuity origin audience is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS task_continuity_resolution_immutable
    BEFORE UPDATE OF resolver_version, resolution_disposition,
                     resolution_selected_option, resolution_active_task_input,
                     resolution_semantic_input_hash
      ON task_continuity_packets
    FOR EACH ROW
    WHEN OLD.consumed_at IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'task continuity frozen resolution is immutable');
    END;
  `);
  const columns = new Set(
    (db.prepare('PRAGMA table_info(task_continuity_packets)').all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  if (!columns.has('pause_slot_json')) {
    db.exec('ALTER TABLE task_continuity_packets ADD COLUMN pause_slot_json TEXT');
  }
  initializedDatabases.add(db);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalIso(value: string, label: string): { iso: string; ms: number } {
  const trimmed = value.trim();
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== trimmed) {
    throw new Error(`Task continuity ${label} must be a canonical ISO timestamp.`);
  }
  return { iso: trimmed, ms };
}

function boundedString(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== 'string') throw new Error(`Task continuity ${label} must be a string.`);
  // Preserve internal text exactly. Question/option punctuation and resource
  // identifiers are evidence; whitespace normalization here could silently
  // change what the user was asked or which resource was bound.
  const normalized = value.trim();
  if (!normalized) throw new Error(`Task continuity ${label} is required.`);
  if (normalized.length > maxChars) {
    throw new Error(`Task continuity ${label} exceeds ${maxChars} characters.`);
  }
  return normalized;
}

function normalizedSessionId(value: unknown): string {
  return boundedString(value, 'sessionId', MAX_SESSION_ID_CHARS);
}

function positiveSeq(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Task continuity ${label} must be a positive safe integer.`);
  }
  return value as number;
}

function normalizeCapabilityEvidence(
  values: CreateTaskContinuityPacketInput['capabilities'],
): TaskContinuityCapabilityEvidence[] {
  const inputs = values ?? [];
  if (!Array.isArray(inputs) || inputs.length > MAX_CAPABILITY_ROWS) {
    throw new Error(`Task continuity capabilities must contain at most ${MAX_CAPABILITY_ROWS} rows.`);
  }
  const out: TaskContinuityCapabilityEvidence[] = [];
  const seen = new Set<string>();
  for (const value of inputs) {
    if (!isPlainObject(value)) throw new Error('Task continuity capability evidence must be an object.');
    if (Object.keys(value).some((key) => !CAPABILITY_EVIDENCE_KEYS.has(key))) {
      throw new Error('Task continuity capability evidence contains an unsupported field.');
    }
    const kind = boundedString(value.kind, 'capability kind', MAX_KIND_CHARS);
    const identifier = boundedString(value.identifier, 'capability identifier', MAX_IDENTIFIER_CHARS);
    if (!EFFECT_CLASSES.has(value.effectClass as TaskContinuityEffectClass)) {
      throw new Error('Task continuity capability effectClass is invalid.');
    }
    if (!EVIDENCE_KINDS.has(value.evidenceKind as TaskContinuityEvidenceKind)) {
      throw new Error('Task continuity capability evidenceKind is invalid.');
    }
    const accountIdentity = value.accountIdentity === undefined
      ? undefined
      : boundedString(value.accountIdentity, 'accountIdentity', MAX_ACCOUNT_CHARS);
    const schemaFingerprint = value.schemaFingerprint === undefined
      ? undefined
      : boundedString(value.schemaFingerprint, 'schemaFingerprint', MAX_SCHEMA_FINGERPRINT_CHARS);
    const rawRefs = value.resourceRefs ?? [];
    if (!Array.isArray(rawRefs) || rawRefs.length > MAX_RESOURCE_REFS) {
      throw new Error(`Task continuity resourceRefs must contain at most ${MAX_RESOURCE_REFS} rows.`);
    }
    const resourceRefs = [...new Set(rawRefs.map((ref) =>
      boundedString(ref, 'resourceRef', MAX_RESOURCE_REF_CHARS)))];
    const normalized: TaskContinuityCapabilityEvidence = {
      kind,
      identifier,
      effectClass: value.effectClass as TaskContinuityEffectClass,
      evidenceKind: value.evidenceKind as TaskContinuityEvidenceKind,
      ...(accountIdentity ? { accountIdentity } : {}),
      resourceRefs,
      ...(schemaFingerprint ? { schemaFingerprint } : {}),
    };
    const key = JSON.stringify(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function normalizePauseOptions(values: readonly string[] | undefined): string[] {
  const raw = values ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_PAUSE_OPTIONS) {
    throw new Error(`Task continuity pause options must contain at most ${MAX_PAUSE_OPTIONS} rows.`);
  }
  if (raw.length > 0) {
    throw new Error('Task continuity pause options require an exact public delivery binding.');
  }
  const normalized = raw.map((option) =>
    boundedString(option, 'pause option', MAX_PAUSE_OPTION_CHARS));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Task continuity pause options must be unique.');
  }
  return normalized;
}

function parsePauseOptionsJson(raw: string): string[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  try {
    return normalizePauseOptions(parsed as string[]);
  } catch {
    return null;
  }
}

function parseEvidenceJson(raw: string): TaskContinuityCapabilityEvidence[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed.version !== TASK_CONTINUITY_PACKET_VERSION || !Array.isArray(parsed.capabilities)) return null;
  if (Object.keys(parsed).some((key) => key !== 'version' && key !== 'capabilities')) return null;
  try {
    const capabilities = normalizeCapabilityEvidence(
      parsed.capabilities as CreateTaskContinuityPacketInput['capabilities'],
    );
    // A duplicated/tampered array must not be silently canonicalized on read.
    if (capabilities.length !== parsed.capabilities.length) return null;
    for (const value of parsed.capabilities) {
      if (!isPlainObject(value)) return null;
      if (Object.keys(value).some((key) => !CAPABILITY_EVIDENCE_KEYS.has(key))) return null;
      for (const required of ['kind', 'identifier', 'effectClass', 'evidenceKind', 'resourceRefs']) {
        if (!Object.prototype.hasOwnProperty.call(value, required)) return null;
      }
    }
    return capabilities;
  } catch {
    return null;
  }
}

function rawSource(db: Database.Database, sessionId: string, sourceUserSeq: number): RawSourceRow | null {
  return (db.prepare(`
    SELECT seq, id, session_id, role, type, data_json, created_at
      FROM events
     WHERE session_id = ? AND seq = ?
     LIMIT 1
  `).get(sessionId, sourceUserSeq) as RawSourceRow | undefined) ?? null;
}

function acceptedSourceFromRow(row: RawSourceRow | null): AcceptedSource | null {
  if (!row || row.type !== 'user_input_received' || row.role !== 'user') return null;
  let data: unknown;
  try {
    data = JSON.parse(row.data_json);
  } catch {
    return null;
  }
  if (!isPlainObject(data)) return null;
  if ('synthetic' in data && typeof data.synthetic !== 'boolean') return null;
  if (data.synthetic === true) return null;
  try {
    canonicalIso(row.created_at, 'accepted source createdAt');
  } catch {
    return null;
  }
  const providerUserId = typeof data.userId === 'string' && data.userId.trim()
    ? data.userId.trim()
    : undefined;
  const conversationKey = typeof data.conversationKey === 'string' && data.conversationKey.trim()
    ? data.conversationKey.trim()
    : undefined;
  const source = typeof data.source === 'string' ? data.source.trim().toLowerCase() : '';
  const originTarget = isPlainObject(data.originReplyTarget) ? data.originReplyTarget : null;
  const sharedChannel = source.startsWith('channel:')
    || source.startsWith('channel_')
    || /^[^:]+:/.test(conversationKey ?? '')
    || (typeof originTarget?.type === 'string' && /_channel$/.test(originTarget.type));
  return {
    seq: row.seq,
    eventId: row.id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    dataHash: createHash('sha256').update(row.data_json, 'utf8').digest('hex'),
    ...(providerUserId ? { providerUserId } : {}),
    ...(conversationKey ? { conversationKey } : {}),
    sharedChannel,
  };
}

function acceptedAudienceHash(source: AcceptedSource): string {
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    sessionId: source.sessionId,
    sourceUserSeq: source.seq,
    sourceEventId: source.eventId,
    sourceDataHash: source.dataHash,
    sharedChannel: source.sharedChannel,
    providerUserId: source.providerUserId ?? null,
    conversationKey: source.conversationKey ?? null,
  }), 'utf8').digest('hex');
}

function normalizeFrozenResolution(
  value: TaskContinuityFrozenResolution | undefined,
): TaskContinuityFrozenResolution | null {
  if (!value || typeof value !== 'object') return null;
  const resolverVersion = typeof value.resolverVersion === 'string'
    ? value.resolverVersion.trim()
    : '';
  const selectedOption = value.selectedOption === undefined
    ? undefined
    : typeof value.selectedOption === 'string'
      ? value.selectedOption.trim()
      : '';
  const activeTaskInput = value.activeTaskInput === undefined
    ? undefined
    : typeof value.activeTaskInput === 'string'
      ? value.activeTaskInput.trim()
      : '';
  if (
    !resolverVersion
    || resolverVersion.length > MAX_RESOLVER_VERSION_CHARS
    || !FROZEN_DISPOSITIONS.has(value.disposition)
    || !/^[a-f0-9]{64}$/.test(value.semanticInputHash)
    || (value.selectedOption !== undefined && !selectedOption)
    || (value.activeTaskInput !== undefined && !activeTaskInput)
    || (value.disposition === 'declined_with_new_task' && !activeTaskInput)
    || (value.disposition !== 'declined_with_new_task' && activeTaskInput !== undefined)
  ) return null;
  return {
    resolverVersion,
    disposition: value.disposition,
    ...(selectedOption ? { selectedOption } : {}),
    ...(activeTaskInput ? { activeTaskInput } : {}),
    semanticInputHash: value.semanticInputHash,
  };
}

function frozenResolutionFromRow(row: RawPacketRow): TaskContinuityFrozenResolution | null {
  if (!row.resolver_version || !row.resolution_disposition || !row.resolution_semantic_input_hash) {
    return null;
  }
  return normalizeFrozenResolution({
    resolverVersion: row.resolver_version,
    disposition: row.resolution_disposition as TaskContinuityFrozenResolution['disposition'],
    ...(row.resolution_selected_option
      ? { selectedOption: row.resolution_selected_option }
      : {}),
    ...(row.resolution_active_task_input
      ? { activeTaskInput: row.resolution_active_task_input }
      : {}),
    semanticInputHash: row.resolution_semantic_input_hash,
  });
}

function sameFrozenResolution(
  left: TaskContinuityFrozenResolution,
  right: TaskContinuityFrozenResolution,
): boolean {
  return left.resolverVersion === right.resolverVersion
    && left.disposition === right.disposition
    && left.selectedOption === right.selectedOption
    && left.activeTaskInput === right.activeTaskInput
    && left.semanticInputHash === right.semanticInputHash;
}

function sameAcceptedAudience(origin: AcceptedSource, consumer: AcceptedSource): boolean {
  if (origin.sharedChannel || consumer.sharedChannel) {
    return Boolean(
      origin.providerUserId
      && consumer.providerUserId
      && origin.providerUserId === consumer.providerUserId
      && origin.conversationKey
      && consumer.conversationKey
      && origin.conversationKey === consumer.conversationKey,
    );
  }
  if (origin.conversationKey !== undefined || consumer.conversationKey !== undefined) {
    if (!origin.conversationKey || origin.conversationKey !== consumer.conversationKey) return false;
  }
  if (origin.providerUserId !== undefined || consumer.providerUserId !== undefined) {
    return Boolean(
      origin.providerUserId
      && origin.providerUserId === consumer.providerUserId,
    );
  }
  return true;
}

function acceptedSource(db: Database.Database, sessionId: string, sourceUserSeq: number): AcceptedSource | null {
  return acceptedSourceFromRow(rawSource(db, sessionId, sourceUserSeq));
}

/** The next non-synthetic user source. A malformed candidate fails closed. */
function nextAcceptedSource(db: Database.Database, sessionId: string, afterSeq: number): AcceptedSource | null {
  const rows = db.prepare(`
    SELECT seq, id, session_id, role, type, data_json, created_at
      FROM events
     WHERE session_id = ?
       AND seq > ?
       AND type = 'user_input_received'
       AND role = 'user'
     ORDER BY seq ASC
  `).all(sessionId, afterSeq) as RawSourceRow[];
  for (const row of rows) {
    let data: unknown;
    try { data = JSON.parse(row.data_json); } catch { return null; }
    if (!isPlainObject(data)) return null;
    if ('synthetic' in data && typeof data.synthetic !== 'boolean') return null;
    if (data.synthetic === true) continue;
    return acceptedSourceFromRow(row);
  }
  return null;
}

function openPacketRows(db: Database.Database, sessionId: string): RawPacketRow[] {
  return db.prepare(`
    SELECT *
      FROM task_continuity_packets
     WHERE session_id = ?
       AND consumed_at IS NULL
       AND superseded_at IS NULL
       AND expired_at IS NULL
       AND dismissed_at IS NULL
     ORDER BY created_at DESC, rowid DESC
     LIMIT 2
  `).all(sessionId) as RawPacketRow[];
}

function consumedPacketRowsForSource(
  db: Database.Database,
  sessionId: string,
  sourceUserSeq: number,
): RawPacketRow[] {
  return db.prepare(`
    SELECT *
      FROM task_continuity_packets
     WHERE session_id = ?
       AND consumed_by_source_user_seq = ?
       AND consumed_at IS NOT NULL
     ORDER BY consumed_at DESC, rowid DESC
     LIMIT 2
  `).all(sessionId, sourceUserSeq) as RawPacketRow[];
}

function rowToPacket(db: Database.Database, row: RawPacketRow): TaskContinuityPacket | null {
  if (row.version !== TASK_CONTINUITY_PACKET_VERSION) return null;
  let sessionId: string;
  let sourceSeq: number;
  let question: string;
  try {
    sessionId = normalizedSessionId(row.session_id);
    sourceSeq = positiveSeq(row.originating_source_user_seq, 'originatingSourceUserSeq');
    boundedString(row.packet_id, 'packetId', 128);
    boundedString(row.originating_source_event_id, 'originatingSourceEventId', 128);
    question = boundedString(row.pause_question, 'pause question', MAX_QUESTION_CHARS);
  } catch {
    return null;
  }
  if (!PAUSE_KINDS.has(row.pause_kind as TaskContinuityPauseKind)) return null;
  const capabilities = parseEvidenceJson(row.capability_evidence_json);
  if (!capabilities) return null;
  const options = parsePauseOptionsJson(row.pause_options_json);
  if (!options) return null;
  let createdAt: { iso: string; ms: number };
  let expiresAt: { iso: string; ms: number };
  try {
    createdAt = canonicalIso(row.created_at, 'createdAt');
    expiresAt = canonicalIso(row.expires_at, 'expiresAt');
  } catch {
    return null;
  }
  if (expiresAt.ms <= createdAt.ms || expiresAt.ms - createdAt.ms > MAX_TASK_CONTINUITY_TTL_MS) return null;
  const origin = acceptedSource(db, sessionId, sourceSeq);
  if (!origin || origin.eventId !== row.originating_source_event_id) return null;
  // v42 seals the audience as it existed when the packet was created. Legacy
  // rows and later mutation of event.data user/channel identity fail closed.
  if (!row.origin_audience_hash || row.origin_audience_hash !== acceptedAudienceHash(origin)) return null;
  if (createdAt.ms < Date.parse(origin.createdAt)) return null;
  const slot = parsePauseSlotJson(row.pause_slot_json);
  return {
    version: TASK_CONTINUITY_PACKET_VERSION,
    packetId: row.packet_id,
    sessionId,
    originatingSourceUserSeq: sourceSeq,
    originatingSourceEventId: row.originating_source_event_id,
    pause: {
      kind: row.pause_kind as TaskContinuityPauseKind,
      question,
      options,
      ...(slot ? { slot } : {}),
    },
    capabilities,
    createdAt: createdAt.iso,
    expiresAt: expiresAt.iso,
  };
}

function parsePauseSlotJson(raw: string | null): TaskContinuityPacket['pause']['slot'] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      goalId?: unknown;
      revision?: unknown;
      questionId?: unknown;
      slotKey?: unknown;
      predecessorRefs?: unknown;
    };
    if (
      typeof parsed.goalId !== 'string'
      || !parsed.goalId
      || !Number.isSafeInteger(parsed.revision)
      || typeof parsed.questionId !== 'string'
      || !parsed.questionId
      || typeof parsed.slotKey !== 'string'
      || !parsed.slotKey
    ) return undefined;
    const predecessorRefs = Array.isArray(parsed.predecessorRefs)
      ? parsed.predecessorRefs.filter((ref): ref is string => typeof ref === 'string')
      : undefined;
    return {
      goalId: parsed.goalId,
      revision: parsed.revision as number,
      questionId: parsed.questionId,
      slotKey: parsed.slotKey,
      ...(predecessorRefs && predecessorRefs.length > 0 ? { predecessorRefs } : {}),
    };
  } catch {
    return undefined;
  }
}

function lookupResult(
  db: Database.Database,
  sessionId: string,
  nowMs: number,
): TaskContinuityLookupResult {
  const rows = openPacketRows(db, sessionId);
  if (rows.length > 1) return { status: 'ambiguous' };
  const row = rows[0];
  if (!row) return { status: 'none' };
  const packet = rowToPacket(db, row);
  if (!packet) return { status: 'malformed', packetId: row.packet_id };
  if (Date.parse(packet.expiresAt) <= nowMs) return { status: 'expired', packetId: packet.packetId };
  return { status: 'available', packet };
}

function consumedLookupResult(
  db: Database.Database,
  sessionId: string,
  consumingSourceUserSeq: number,
): ConsumedTaskContinuityLookupResult {
  const consumer = acceptedSource(db, sessionId, consumingSourceUserSeq);
  if (!consumer) return { status: 'invalid_source' };
  const rows = consumedPacketRowsForSource(db, sessionId, consumer.seq);
  if (rows.length === 0) return { status: 'none' };
  if (rows.length > 1) return { status: 'ambiguous' };
  const row = rows[0]!;
  const packet = rowToPacket(db, row);
  if (!packet) return { status: 'malformed', packetId: row.packet_id };
  // Expiry limits how long an OPEN question may acquire a consumer. Once the
  // exact next accepted source consumed it, that lineage is durable audit
  // history and must remain rehydratable after a long restart.
  if (
    row.consumed_by_source_event_id !== consumer.eventId
    || row.consumed_by_source_user_seq !== consumer.seq
    || !row.consumed_at
    || !row.consumer_audience_hash
    || row.consumer_audience_hash !== acceptedAudienceHash(consumer)
  ) return { status: 'invalid_source', packetId: packet.packetId };
  const origin = acceptedSource(db, sessionId, packet.originatingSourceUserSeq);
  if (!origin || !sameAcceptedAudience(origin, consumer)) {
    return { status: 'invalid_source', packetId: packet.packetId };
  }
  const resolution = frozenResolutionFromRow(row);
  if (!resolution) return { status: 'malformed', packetId: packet.packetId };
  return {
    status: 'consumed',
    packet,
    consumingSourceUserSeq: consumer.seq,
    consumingSourceEventId: consumer.eventId,
    consumedAt: row.consumed_at,
    resolution,
  };
}

export class TaskContinuityStore {
  constructor(private readonly databaseProvider: DatabaseProvider = openEventLog) {}

  create(
    input: CreateTaskContinuityPacketInput,
    options: TaskContinuityClockOptions = {},
  ): TaskContinuityPacket {
    const sessionId = normalizedSessionId(input.sessionId);
    const sourceUserSeq = positiveSeq(input.originatingSourceUserSeq, 'originatingSourceUserSeq');
    if (!PAUSE_KINDS.has(input.pause?.kind)) throw new Error('Task continuity pause kind is invalid.');
    const question = boundedString(input.pause?.question, 'pause question', MAX_QUESTION_CHARS);
    const pauseOptions = normalizePauseOptions(input.pause?.options);
    const capabilities = normalizeCapabilityEvidence(input.capabilities);
    if (input.expiresAt !== undefined && input.ttlMs !== undefined) {
      throw new Error('Task continuity expiresAt and ttlMs are mutually exclusive.');
    }
    const now = canonicalIso(options.now ?? new Date().toISOString(), 'now');
    let expiresAt: { iso: string; ms: number };
    if (input.expiresAt !== undefined) {
      expiresAt = canonicalIso(input.expiresAt, 'expiresAt');
    } else {
      const ttlMs = input.ttlMs ?? DEFAULT_TASK_CONTINUITY_TTL_MS;
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TASK_CONTINUITY_TTL_MS) {
        throw new Error(`Task continuity ttlMs must be 1-${MAX_TASK_CONTINUITY_TTL_MS}.`);
      }
      expiresAt = canonicalIso(new Date(now.ms + ttlMs).toISOString(), 'expiresAt');
    }
    if (expiresAt.ms <= now.ms || expiresAt.ms - now.ms > MAX_TASK_CONTINUITY_TTL_MS) {
      throw new Error('Task continuity expiry must be in the future and within thirty days.');
    }

    const db = this.databaseProvider();
    ensureSchema(db);
    const create = db.transaction((): TaskContinuityPacket => {
      const source = acceptedSource(db, sessionId, sourceUserSeq);
      if (!source) {
        throw new Error(
          `Task continuity source ${sourceUserSeq} is not an accepted user source for ${sessionId}.`,
        );
      }
      if (source.sharedChannel && (!source.providerUserId || !source.conversationKey)) {
        throw new Error('Task continuity shared-channel source has no exact provider audience identity.');
      }
      if (now.ms < Date.parse(source.createdAt)) {
        throw new Error('Task continuity cannot be created before its originating source.');
      }
      if (nextAcceptedSource(db, sessionId, sourceUserSeq)) {
        throw new Error('Task continuity cannot be created after a later accepted user source exists.');
      }
      if (openPacketRows(db, sessionId).length > 1) {
        throw new Error('Task continuity has multiple open questions for one session.');
      }

      // Latest pause wins. Supersession is reversible audit history, not deletion.
      db.prepare(`
        UPDATE task_continuity_packets
           SET superseded_at = ?
         WHERE session_id = ?
           AND consumed_at IS NULL
           AND superseded_at IS NULL
           AND expired_at IS NULL
           AND dismissed_at IS NULL
      `).run(now.iso, sessionId);

      const packetId = randomUUID();
      db.prepare(`
        INSERT INTO task_continuity_packets (
          packet_id, version, session_id,
          originating_source_user_seq, originating_source_event_id,
          pause_kind, pause_question, pause_options_json, capability_evidence_json,
          created_at, expires_at, origin_audience_hash, pause_slot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        packetId,
        TASK_CONTINUITY_PACKET_VERSION,
        sessionId,
        sourceUserSeq,
        source.eventId,
        input.pause.kind,
        question,
        JSON.stringify(pauseOptions),
        JSON.stringify({ version: TASK_CONTINUITY_PACKET_VERSION, capabilities }),
        now.iso,
        expiresAt.iso,
        acceptedAudienceHash(source),
        input.pause.slot ? JSON.stringify(input.pause.slot) : null,
      );
      const row = db.prepare('SELECT * FROM task_continuity_packets WHERE packet_id = ?')
        .get(packetId) as RawPacketRow;
      const packet = rowToPacket(db, row);
      if (!packet) throw new Error('Task continuity packet failed its own persisted validation.');
      return packet;
    });
    return create.immediate();
  }

  peek(
    input: { sessionId: string },
    options: TaskContinuityClockOptions = {},
  ): TaskContinuityLookupResult {
    const sessionId = normalizedSessionId(input.sessionId);
    const now = canonicalIso(options.now ?? new Date().toISOString(), 'now');
    const db = this.databaseProvider();
    ensureSchema(db);
    return lookupResult(db, sessionId, now.ms);
  }

  readConsumed(
    input: ConsumeTaskContinuityPacketInput,
    options: TaskContinuityClockOptions = {},
  ): ConsumedTaskContinuityLookupResult {
    const sessionId = normalizedSessionId(input.sessionId);
    const consumingSourceUserSeq = positiveSeq(input.consumingSourceUserSeq, 'consumingSourceUserSeq');
    if (options.now !== undefined) canonicalIso(options.now, 'now');
    const db = this.databaseProvider();
    ensureSchema(db);
    return consumedLookupResult(db, sessionId, consumingSourceUserSeq);
  }

  consume(
    input: ConsumeTaskContinuityPacketInput,
    options: TaskContinuityClockOptions = {},
  ): TaskContinuityConsumeResult {
    const sessionId = normalizedSessionId(input.sessionId);
    const consumingSourceUserSeq = positiveSeq(input.consumingSourceUserSeq, 'consumingSourceUserSeq');
    const now = canonicalIso(options.now ?? new Date().toISOString(), 'now');
    const db = this.databaseProvider();
    ensureSchema(db);
    const consume = db.transaction((): TaskContinuityConsumeResult => {
      const openRows = openPacketRows(db, sessionId);
      if (openRows.length > 1) return { status: 'ambiguous' };
      const row = openRows[0];
      if (!row) {
        const requestedResolution = normalizeFrozenResolution(input.resolution);
        if (!requestedResolution) return { status: 'invalid_source' };
        const replay = consumedLookupResult(
          db,
          sessionId,
          consumingSourceUserSeq,
        );
        return replay.status === 'consumed'
          ? sameFrozenResolution(replay.resolution, requestedResolution)
            ? { ...replay, replay: true }
            : { status: 'invalid_source', packetId: replay.packet.packetId }
          : replay;
      }
      const packet = rowToPacket(db, row);
      if (!packet) return { status: 'malformed', packetId: row.packet_id };
      if (Date.parse(packet.expiresAt) <= now.ms) {
        db.prepare(`
          UPDATE task_continuity_packets
             SET expired_at = ?
           WHERE packet_id = ?
             AND consumed_at IS NULL
             AND superseded_at IS NULL
             AND expired_at IS NULL
             AND dismissed_at IS NULL
        `).run(now.iso, packet.packetId);
        return { status: 'expired', packetId: packet.packetId };
      }

      const consumer = acceptedSource(db, sessionId, consumingSourceUserSeq);
      if (!consumer) return { status: 'invalid_source', packetId: packet.packetId };
      const origin = acceptedSource(db, sessionId, packet.originatingSourceUserSeq);
      if (!origin || !sameAcceptedAudience(origin, consumer)) {
        return { status: 'invalid_source', packetId: packet.packetId };
      }
      const resolution = normalizeFrozenResolution(input.resolution);
      if (!resolution) return { status: 'invalid_source', packetId: packet.packetId };
      const next = nextAcceptedSource(db, sessionId, packet.originatingSourceUserSeq);
      if (!next || next.seq !== consumer.seq || consumer.seq <= packet.originatingSourceUserSeq) {
        // Once another real user source intervenes, this packet can never safely
        // explain a later turn. Retire it instead of repeatedly offering stale
        // capability evidence.
        db.prepare(`
          UPDATE task_continuity_packets
             SET superseded_at = ?
           WHERE packet_id = ?
             AND consumed_at IS NULL
             AND superseded_at IS NULL
             AND expired_at IS NULL
             AND dismissed_at IS NULL
        `).run(now.iso, packet.packetId);
        return { status: 'stale', packetId: packet.packetId };
      }

      const changed = db.prepare(`
        UPDATE task_continuity_packets
           SET consumed_at = ?,
               consumed_by_source_user_seq = ?,
               consumed_by_source_event_id = ?,
               consumer_audience_hash = ?,
               resolver_version = ?,
               resolution_disposition = ?,
               resolution_selected_option = ?,
               resolution_active_task_input = ?,
               resolution_semantic_input_hash = ?
         WHERE packet_id = ?
           AND consumed_at IS NULL
           AND superseded_at IS NULL
           AND expired_at IS NULL
           AND dismissed_at IS NULL
           AND expires_at > ?
      `).run(
        now.iso,
        consumer.seq,
        consumer.eventId,
        acceptedAudienceHash(consumer),
        resolution.resolverVersion,
        resolution.disposition,
        resolution.selectedOption ?? null,
        resolution.activeTaskInput ?? null,
        resolution.semanticInputHash,
        packet.packetId,
        now.iso,
      );
      if (Number(changed.changes ?? 0) !== 1) {
        return { status: 'lost_race', packetId: packet.packetId };
      }
      return {
        status: 'consumed',
        packet,
        consumingSourceUserSeq: consumer.seq,
        consumingSourceEventId: consumer.eventId,
        consumedAt: now.iso,
        resolution,
        replay: false,
      };
    });
    return consume.immediate();
  }

  dismiss(
    input: DismissTaskContinuityPacketInput,
    options: TaskContinuityClockOptions = {},
  ): TaskContinuityDismissResult {
    const sessionId = normalizedSessionId(input.sessionId);
    const reason = input.reason ?? 'no_longer_needed';
    const allowedReasons = new Set<TaskContinuityDismissReason>([
      'topic_changed', 'user_declined', 'no_longer_needed', 'invalidated',
    ]);
    if (!allowedReasons.has(reason)) throw new Error('Task continuity dismiss reason is invalid.');
    const now = canonicalIso(options.now ?? new Date().toISOString(), 'now');
    const db = this.databaseProvider();
    ensureSchema(db);
    const dismiss = db.transaction((): TaskContinuityDismissResult => {
      const rows = openPacketRows(db, sessionId);
      if (rows.length > 1) return { status: 'ambiguous' };
      const row = rows[0];
      if (!row) return { status: 'none' };
      // Dismissal never interprets or exposes packet evidence. This remains a
      // safe recovery path even when a row's JSON is malformed and unreadable.
      const changed = db.prepare(`
        UPDATE task_continuity_packets
           SET dismissed_at = ?, dismissed_reason = ?
         WHERE packet_id = ?
           AND consumed_at IS NULL
           AND superseded_at IS NULL
           AND expired_at IS NULL
           AND dismissed_at IS NULL
      `).run(now.iso, reason, row.packet_id);
      if (Number(changed.changes ?? 0) !== 1) {
        return { status: 'lost_race', packetId: row.packet_id };
      }
      return {
        status: 'dismissed',
        packetId: row.packet_id,
        reason,
        dismissedAt: now.iso,
      };
    });
    return dismiss.immediate();
  }
}

export const taskContinuityStore = new TaskContinuityStore();

export function createTaskContinuityPacket(
  input: CreateTaskContinuityPacketInput,
  options: TaskContinuityClockOptions = {},
): TaskContinuityPacket {
  return taskContinuityStore.create(input, options);
}

export function peekTaskContinuityPacket(
  input: { sessionId: string },
  options: TaskContinuityClockOptions = {},
): TaskContinuityLookupResult {
  return taskContinuityStore.peek(input, options);
}

export function consumeTaskContinuityPacket(
  input: ConsumeTaskContinuityPacketInput,
  options: TaskContinuityClockOptions = {},
): TaskContinuityConsumeResult {
  return taskContinuityStore.consume(input, options);
}

export function readConsumedTaskContinuityPacket(
  input: ConsumeTaskContinuityPacketInput,
  options: TaskContinuityClockOptions = {},
): ConsumedTaskContinuityLookupResult {
  return taskContinuityStore.readConsumed(input, options);
}

export function dismissTaskContinuityPacket(
  input: DismissTaskContinuityPacketInput,
  options: TaskContinuityClockOptions = {},
): TaskContinuityDismissResult {
  return taskContinuityStore.dismiss(input, options);
}
