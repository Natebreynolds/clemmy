/**
 * Durable, bounded result handles.
 *
 * A handle is useful only when the host can redeem it after a restart. Raw
 * provider payloads and opaque pagination cursors therefore live in the
 * harness database, not process-local Maps. Authoritative handles are bound to
 * the exact accepted source, logical call, returned physical crossing and
 * canonical base-call arguments. Knowing a reference is not authority to use
 * it from another task or call.
 */
import { createHash, randomUUID } from 'node:crypto';
import { openEventLog } from './eventlog.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import {
  deriveResultHandleFactsFromRaw as derivePureResultHandleFactsFromRaw,
  RESULT_PROJECTION_MAX_BYTES,
  RESULT_PROJECTION_MAX_RECORDS,
  type RawResultHandleFacts,
  type ResultCompleteness,
} from './result-facts.js';

export {
  RESULT_PROJECTION_MAX_BYTES,
  RESULT_PROJECTION_MAX_RECORDS,
  type RawResultHandleFacts,
  type ResultCompleteness,
} from './result-facts.js';
export const RESULT_RAW_MAX_BYTES = 8_000_000;
export const RESULT_CURSOR_MAX_BYTES = 65_536;

export interface ResultHandle {
  /** Collision-resistant, scoped to the accepted task and physical dispatch. */
  handle: string;
  success: boolean;
  recordPath: string | null;
  recordCount: number;
  envelopeMeta: Record<string, unknown> | null;
  /** Server-side continuation reference. Never the provider's cursor bytes. */
  continuationRef: string | null;
  /** True when this exact cursor occurred earlier in the same base call. */
  continuationRepeated: boolean;
  completeness: ResultCompleteness;
  /** Byte-bounded projection for immediate reasoning. */
  projectedRecords: unknown[];
  /** Redeemable location for the full payload, null when storage was refused. */
  rawLocation: string | null;
  statusCode: number | null;
}

export interface ResultHandleAuthority {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  physicalDispatchId: string;
  /** Stable host-issued id for one pagination chain. Defaults to the logical call. */
  continuationChainId?: string;
  /** Exact tool and arguments recorded for this physical crossing. */
  toolName: string;
  args?: unknown;
  /** Stable initial arguments for the pagination chain. Defaults to `args`. */
  baseArgs?: unknown;
}

export interface ToResultHandleOptions {
  /** Required for any task-scoped, authoritative handle. */
  authority?: ResultHandleAuthority;
  /**
   * Projection-only compatibility for the host paginator before live wiring.
   * Authoritative calls may not skip their only raw copy.
   */
  skipRawStore?: boolean;
  /** Legacy identity salt; it does not confer task-scoped redemption. */
  acceptedTaskId?: string;
  /** Legacy identity salt; use authority.physicalDispatchId for real calls. */
  physicalAttemptId?: string;
}

export type ResultRedemption<T> =
  | { status: 'ok'; value: T }
  | { status: 'missing' | 'forbidden' | 'corrupt' | 'storage_error'; reason: string };

/**
 * Host-only view of the one durable result which closed a successful logical
 * settlement. Callers provide task identity, never the original arguments;
 * the store re-establishes the exact logical/physical/tool/argument binding.
 */
export interface SuccessfulSettlementResultEvidence {
  acceptedTaskId: string;
  logicalToolCallId: string;
  physicalDispatchId: string;
  resultHandleId: string;
  toolName: string;
  outcomeKind: 'succeeded' | 'empty_result';
  handle: ResultHandle;
  rawPayload: unknown;
  rawPayloadJson: string;
  rawPayloadSha256: string;
  rawByteCount: number;
}

export class ResultHandleAuthorityError extends Error {
  override readonly name = 'ResultHandleAuthorityError';

  constructor(
    readonly status: 'invalid_scope' | 'authority_mismatch' | 'conflict' | 'storage_error',
    readonly reason: string,
  ) {
    super(`Result handle authority failed (${status}): ${reason}`);
  }
}

type ScopeKind = 'authoritative' | 'legacy_unscoped';
type RejectionReason = 'unserializable' | 'oversized' | 'cursor_oversized' | 'raw_store_skipped';

interface DurableResultRow {
  handle_id: string;
  scope_kind: ScopeKind;
  session_id: string | null;
  source_user_seq: number | null;
  accepted_task_id: string | null;
  logical_tool_call_id: string | null;
  physical_dispatch_id: string | null;
  continuation_chain_id: string;
  tool_name: string;
  argument_digest: string;
  base_argument_digest: string;
  raw_location: string | null;
  raw_payload_json: string | null;
  raw_payload_sha256: string | null;
  raw_byte_count: number;
  rejection_reason: RejectionReason | null;
  success: number;
  record_path: string | null;
  record_count: number;
  envelope_meta_json: string | null;
  completeness: ResultCompleteness;
  projected_records_json: string;
  status_code: number | null;
  continuation_ref: string | null;
  cursor_bytes: Buffer | null;
  cursor_sha256: string | null;
  cursor_repeated: number;
  created_at: string;
}

interface PersistableResult {
  rawJson: string | null;
  rawDigest: string | null;
  rawBytes: number;
  rejection: RejectionReason | null;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedReason(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 240);
}

// ── Strict raw encoding ─────────────────────────────────────────────────────

function validateJsonValue(value: unknown, stack = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 256) return false;
  const object = value as object;
  if (stack.has(object)) return false;
  const prototype = Object.getPrototypeOf(object);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  if (Reflect.ownKeys(object).some((key) => typeof key === 'symbol')) return false;
  stack.add(object);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value) || !validateJsonValue(value[index], stack, depth + 1)) return false;
      }
    } else {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (!validateJsonValue((value as Record<string, unknown>)[key], stack, depth + 1)) return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    stack.delete(object);
  }
}

function encodeRaw(result: unknown, skipRawStore: boolean): PersistableResult {
  if (skipRawStore) {
    return { rawJson: null, rawDigest: null, rawBytes: 0, rejection: 'raw_store_skipped' };
  }
  try {
    if (!validateJsonValue(result)) {
      return { rawJson: null, rawDigest: null, rawBytes: 0, rejection: 'unserializable' };
    }
    const rawJson = JSON.stringify(result);
    if (rawJson === undefined) {
      return { rawJson: null, rawDigest: null, rawBytes: 0, rejection: 'unserializable' };
    }
    const rawBytes = Buffer.byteLength(rawJson, 'utf8');
    if (rawBytes > RESULT_RAW_MAX_BYTES) {
      return {
        rawJson: null,
        rawDigest: sha256(rawJson),
        rawBytes,
        rejection: 'oversized',
      };
    }
    return { rawJson, rawDigest: sha256(rawJson), rawBytes, rejection: null };
  } catch {
    return { rawJson: null, rawDigest: null, rawBytes: 0, rejection: 'unserializable' };
  }
}

/** Pure host interpretation used both when persisting and when redeeming. */
export function deriveResultHandleFactsFromRaw(result: unknown): RawResultHandleFacts {
  return derivePureResultHandleFactsFromRaw(result);
}

// ── Scope and persistence ───────────────────────────────────────────────────

interface DurableScope {
  kind: ScopeKind;
  sessionId: string | null;
  sourceUserSeq: number | null;
  acceptedTaskId: string | null;
  logicalToolCallId: string | null;
  physicalDispatchId: string | null;
  continuationChainId: string;
  toolName: string;
  argumentDigest: string;
  baseArgumentDigest: string;
  salt: string;
}

function authoritativeScope(authority: ResultHandleAuthority): DurableScope {
  if (
    !authority.sessionId.trim()
    || !Number.isSafeInteger(authority.sourceUserSeq)
    || authority.sourceUserSeq <= 0
    || !authority.acceptedTaskId.trim()
    || !authority.logicalToolCallId.trim()
    || !authority.physicalDispatchId.trim()
  ) {
    throw new ResultHandleAuthorityError('invalid_scope', 'exact accepted and dispatch identity is required');
  }
  const call = durableLogicalCallContract(authority.acceptedTaskId, authority.toolName, authority.args);
  const base = durableLogicalCallContract(
    authority.acceptedTaskId,
    authority.toolName,
    authority.baseArgs === undefined ? authority.args : authority.baseArgs,
  );
  if (!call || !base || call.toolName !== base.toolName) {
    throw new ResultHandleAuthorityError('invalid_scope', 'tool or base-call contract is not canonicalizable');
  }
  const continuationChainId = authority.continuationChainId?.trim()
    || authority.logicalToolCallId.trim();
  if (continuationChainId.length > 256) {
    throw new ResultHandleAuthorityError('invalid_scope', 'continuation chain identity is too long');
  }
  return {
    kind: 'authoritative',
    sessionId: authority.sessionId,
    sourceUserSeq: authority.sourceUserSeq,
    acceptedTaskId: authority.acceptedTaskId,
    logicalToolCallId: authority.logicalToolCallId,
    physicalDispatchId: authority.physicalDispatchId,
    continuationChainId,
    toolName: call.toolName,
    argumentDigest: call.argumentDigest,
    baseArgumentDigest: base.argumentDigest,
    salt: [
      authority.sessionId,
      authority.sourceUserSeq,
      authority.acceptedTaskId,
      authority.logicalToolCallId,
      authority.physicalDispatchId,
      continuationChainId,
    ].join('|'),
  };
}

function legacyScope(options: ToResultHandleOptions): DurableScope {
  const accepted = options.acceptedTaskId?.trim() || 'legacy-unscoped';
  const physical = options.physicalAttemptId?.trim() || 'legacy-unattributed';
  const argumentDigest = sha256(`legacy-current\0${accepted}\0${physical}`);
  return {
    kind: 'legacy_unscoped',
    sessionId: null,
    sourceUserSeq: null,
    acceptedTaskId: null,
    logicalToolCallId: null,
    physicalDispatchId: null,
    continuationChainId: `legacy:${accepted}`,
    toolName: 'legacy_unscoped',
    argumentDigest,
    baseArgumentDigest: sha256(`legacy-base\0${accepted}`),
    salt: `${accepted}|${physical}`,
  };
}

function rowToHandle(row: DurableResultRow): ResultHandle {
  let envelopeMeta: Record<string, unknown> | null = null;
  let projectedRecords: unknown[] = [];
  try {
    envelopeMeta = row.envelope_meta_json
      ? JSON.parse(row.envelope_meta_json) as Record<string, unknown>
      : null;
    const projection = JSON.parse(row.projected_records_json) as unknown;
    projectedRecords = Array.isArray(projection) ? projection : [];
  } catch {
    // A corrupt projection cannot be exposed as evidence. Raw redemption also
    // checks its own digest and reports corruption explicitly.
    envelopeMeta = null;
    projectedRecords = [];
  }
  return {
    handle: row.handle_id,
    success: row.success === 1,
    recordPath: row.record_path,
    recordCount: row.record_count,
    envelopeMeta,
    continuationRef: row.continuation_ref,
    continuationRepeated: row.cursor_repeated === 1,
    completeness: row.completeness,
    projectedRecords,
    rawLocation: row.raw_location,
    statusCode: row.status_code,
  };
}

type EventLogDatabase = ReturnType<typeof openEventLog>;

function persistedHandleForPhysical(
  db: EventLogDatabase,
  scope: DurableScope,
): DurableResultRow | undefined {
  if (scope.kind !== 'authoritative') return undefined;
  return db.prepare(`
    SELECT * FROM durable_result_handles
     WHERE scope_kind = 'authoritative'
       AND session_id = ? AND source_user_seq = ?
       AND logical_tool_call_id = ? AND physical_dispatch_id = ?
  `).get(
    scope.sessionId,
    scope.sourceUserSeq,
    scope.logicalToolCallId,
    scope.physicalDispatchId,
  ) as DurableResultRow | undefined;
}

function persistResultHandleInTransaction(
  db: EventLogDatabase,
  result: unknown,
  scope: DurableScope,
  options: { skipRawStore: boolean; requireRaw: boolean },
): DurableResultRow {
  const inspected = deriveResultHandleFactsFromRaw(result);
  let encoded = encodeRaw(result, options.skipRawStore);
  const cursorBytes = inspected.cursor === null ? null : Buffer.from(inspected.cursor, 'utf8');
  if (cursorBytes && cursorBytes.byteLength > RESULT_CURSOR_MAX_BYTES) {
    encoded = {
      rawJson: null,
      rawDigest: encoded.rawDigest,
      rawBytes: encoded.rawBytes,
      rejection: 'cursor_oversized',
    };
  }
  const rejected = encoded.rejection !== null && encoded.rejection !== 'raw_store_skipped';
  if (options.requireRaw && (rejected || encoded.rawJson === null || encoded.rawDigest === null)) {
    throw new ResultHandleAuthorityError(
      'storage_error',
      `successful provider result is not durably storable (${encoded.rejection ?? 'missing raw bytes'})`,
    );
  }
  const effectiveCompleteness: ResultCompleteness = rejected ? 'unknown' : inspected.completeness;
  const effectiveCursor = rejected ? null : cursorBytes;
  const fingerprint = encoded.rawDigest ?? `rejected:${encoded.rejection ?? 'unknown'}:${randomUUID()}`;
  const handleId = `rh_${sha256(`${scope.salt}|${scope.argumentDigest}|${fingerprint}`).slice(0, 32)}`;
  const rawLocation = encoded.rawJson === null ? null : `tool_output:${handleId}`;
  const cursorDigest = effectiveCursor ? sha256(effectiveCursor) : null;
  const continuationRef = effectiveCursor
    ? `cont_${sha256(`${handleId}|${scope.baseArgumentDigest}|${cursorDigest}`).slice(0, 24)}`
    : null;
  const now = new Date().toISOString();

  const existingPhysical = persistedHandleForPhysical(db, scope);
      if (existingPhysical) {
        if (
          existingPhysical.tool_name !== scope.toolName
          || existingPhysical.argument_digest !== scope.argumentDigest
          || existingPhysical.continuation_chain_id !== scope.continuationChainId
          || existingPhysical.base_argument_digest !== scope.baseArgumentDigest
          || (encoded.rawDigest !== null && existingPhysical.raw_payload_sha256 !== encoded.rawDigest)
        ) {
          throw new ResultHandleAuthorityError(
            'conflict',
            'physical dispatch already owns a different result handle',
          );
        }
        return existingPhysical;
      }
      const existing = db.prepare('SELECT * FROM durable_result_handles WHERE handle_id = ?')
        .get(handleId) as DurableResultRow | undefined;
      if (existing) {
        if (
          existing.scope_kind !== scope.kind
          || existing.tool_name !== scope.toolName
          || existing.argument_digest !== scope.argumentDigest
          || existing.continuation_chain_id !== scope.continuationChainId
          || existing.raw_payload_sha256 !== encoded.rawDigest
        ) {
          throw new ResultHandleAuthorityError('conflict', 'result handle id collided with another result');
        }
        return existing;
      }
      const repeated = cursorDigest !== null && Boolean(db.prepare(`
        SELECT 1 FROM durable_result_handles
         WHERE scope_kind = ?
           AND session_id IS ? AND source_user_seq IS ?
           AND continuation_chain_id = ?
           AND base_argument_digest = ? AND cursor_sha256 = ?
         LIMIT 1
      `).get(
        scope.kind,
        scope.sessionId,
        scope.sourceUserSeq,
        scope.continuationChainId,
        scope.baseArgumentDigest,
        cursorDigest,
      ));
      db.prepare(`
        INSERT INTO durable_result_handles (
          handle_id, scope_kind, session_id, source_user_seq, accepted_task_id,
          logical_tool_call_id, physical_dispatch_id, continuation_chain_id,
          tool_name, argument_digest,
          base_argument_digest, raw_location, raw_payload_json, raw_payload_sha256,
          raw_byte_count, rejection_reason, success, record_path, record_count,
          envelope_meta_json, completeness, projected_records_json, status_code,
          continuation_ref, cursor_bytes, cursor_sha256, cursor_repeated, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        handleId,
        scope.kind,
        scope.sessionId,
        scope.sourceUserSeq,
        scope.acceptedTaskId,
        scope.logicalToolCallId,
        scope.physicalDispatchId,
        scope.continuationChainId,
        scope.toolName,
        scope.argumentDigest,
        scope.baseArgumentDigest,
        rawLocation,
        encoded.rawJson,
        encoded.rawJson === null ? null : encoded.rawDigest,
        encoded.rawBytes,
        encoded.rejection,
        inspected.success ? 1 : 0,
        inspected.recordPath,
        inspected.recordCount,
        inspected.envelopeMeta ? JSON.stringify(inspected.envelopeMeta) : null,
        effectiveCompleteness,
        JSON.stringify(inspected.projectedRecords),
        inspected.statusCode,
        continuationRef,
        effectiveCursor,
        cursorDigest,
        repeated ? 1 : 0,
        now,
      );
      return db.prepare('SELECT * FROM durable_result_handles WHERE handle_id = ?')
        .get(handleId) as DurableResultRow;
}

/**
 * Persist a successful provider result inside the caller's authority
 * transaction. Any failure throws, so logical settlement and its mirror roll
 * back with the handle instead of closing around an irredeemable result.
 */
export function persistAuthoritativeResultHandleInTransaction(
  db: EventLogDatabase,
  result: unknown,
  authority: ResultHandleAuthority,
): ResultHandle {
  return rowToHandle(persistResultHandleInTransaction(
    db,
    result,
    authoritativeScope(authority),
    { skipRawStore: false, requireRaw: true },
  ));
}

export function toResultHandle(
  result: unknown,
  options: ToResultHandleOptions = {},
): ResultHandle {
  if (options.authority && options.skipRawStore) {
    throw new ResultHandleAuthorityError(
      'invalid_scope',
      'authoritative result handles must retain their one raw payload copy',
    );
  }
  const scope = options.authority ? authoritativeScope(options.authority) : legacyScope(options);
  try {
    const db = openEventLog();
    const transaction = db.transaction(() => persistResultHandleInTransaction(
      db,
      result,
      scope,
      {
        skipRawStore: options.skipRawStore === true,
        // Direct projection may represent a rejected/malformed payload with
        // completeness unknown. The settlement seam uses the stricter
        // in-transaction API above and refuses to close without raw bytes.
        requireRaw: false,
      },
    ));
    return rowToHandle(transaction.immediate());
  } catch (error) {
    if (error instanceof ResultHandleAuthorityError) throw error;
    const reason = boundedReason(error);
    const status = /exact returned physical crossing|FOREIGN KEY|base call/i.test(reason)
      ? 'authority_mismatch' as const
      : 'storage_error' as const;
    throw new ResultHandleAuthorityError(status, reason);
  }
}

// ── Redemption ──────────────────────────────────────────────────────────────

function authorityMatches(row: DurableResultRow, authority: ResultHandleAuthority): boolean {
  let scope: DurableScope;
  try {
    scope = authoritativeScope(authority);
  } catch {
    return false;
  }
  return row.scope_kind === 'authoritative'
    && row.session_id === scope.sessionId
    && row.source_user_seq === scope.sourceUserSeq
    && row.accepted_task_id === scope.acceptedTaskId
    && row.logical_tool_call_id === scope.logicalToolCallId
    && row.physical_dispatch_id === scope.physicalDispatchId
    && row.continuation_chain_id === scope.continuationChainId
    && row.tool_name === scope.toolName
    && row.argument_digest === scope.argumentDigest
    && row.base_argument_digest === scope.baseArgumentDigest;
}

function mayRedeem(row: DurableResultRow, authority?: ResultHandleAuthority): boolean {
  if (row.scope_kind === 'legacy_unscoped') return authority === undefined;
  return authority !== undefined && authorityMatches(row, authority);
}

interface SettledResultRow extends DurableResultRow {
  handle_rowid: number;
  settlement_execution_kind: string;
  settlement_outcome_kind: string;
  settlement_result_handle_id: string | null;
  settlement_crossing_count: number;
  settlement_crossings_digest: string;
  settlement_event_id: string;
  frozen_crossing_count: number;
  frozen_handle_crossing_count: number;
  logical_accepted_task_id: string;
  logical_tool_name: string;
  logical_argument_digest: string;
  logical_state: string;
  dispatch_state: string;
  dispatch_tool_name: string;
  dispatch_argument_digest: string;
  dispatch_ordinal: number;
  final_dispatch_ordinal: number;
}

interface RedemptionCrossingRow {
  physical_dispatch_id: string;
  ordinal: number;
  relation: 'primary' | 'retry' | 'poll' | 'probe' | 'child';
  retry_of: string | null;
  tool_name: string;
  argument_digest: string;
  state?: 'started' | 'returned' | 'threw' | 'timed_out' | 'cancelled' | 'unknown';
}

function crossingSetJson(rows: readonly RedemptionCrossingRow[]): string {
  return JSON.stringify(rows.map((row) => ({
    physicalDispatchId: row.physical_dispatch_id,
    ordinal: row.ordinal,
    relation: row.relation,
    retryOf: row.retry_of,
    toolName: row.tool_name,
    argumentDigest: row.argument_digest,
  })));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function storedJsonMatches(stored: string | null, expected: unknown): boolean {
  if (stored === null) return expected === null;
  try {
    return canonicalJson(JSON.parse(stored) as unknown) === canonicalJson(expected);
  } catch {
    return false;
  }
}

function bufferMatches(stored: Buffer | null, expected: Buffer | null): boolean {
  if (stored === null || expected === null) return stored === null && expected === null;
  const bytes = Buffer.isBuffer(stored) ? stored : Buffer.from(stored as unknown as Uint8Array);
  return bytes.equals(expected);
}

/** Re-derive every persisted projection and pagination fact from raw bytes. */
function rawFactsMatch(
  db: EventLogDatabase,
  row: SettledResultRow,
  rawPayload: unknown,
): boolean {
  const facts = derivePureResultHandleFactsFromRaw(rawPayload);
  const cursorBytes = facts.cursor === null ? null : Buffer.from(facts.cursor, 'utf8');
  if (cursorBytes && cursorBytes.byteLength > RESULT_CURSOR_MAX_BYTES) return false;
  const cursorDigest = cursorBytes ? sha256(cursorBytes) : null;
  const continuationRef = cursorDigest
    ? `cont_${sha256(`${row.handle_id}|${row.base_argument_digest}|${cursorDigest}`).slice(0, 24)}`
    : null;
  const priorCursor = cursorDigest !== null && Boolean(db.prepare(`
    SELECT 1 FROM durable_result_handles
     WHERE rowid < ?
       AND scope_kind = ?
       AND session_id IS ? AND source_user_seq IS ?
       AND continuation_chain_id = ?
       AND base_argument_digest = ? AND cursor_sha256 = ?
     LIMIT 1
  `).get(
    row.handle_rowid,
    row.scope_kind,
    row.session_id,
    row.source_user_seq,
    row.continuation_chain_id,
    row.base_argument_digest,
    cursorDigest,
  ));
  const scopeSalt = [
    row.session_id,
    row.source_user_seq,
    row.accepted_task_id,
    row.logical_tool_call_id,
    row.physical_dispatch_id,
    row.continuation_chain_id,
  ].join('|');
  const expectedHandleId = `rh_${sha256(
    `${scopeSalt}|${row.argument_digest}|${row.raw_payload_sha256}`,
  ).slice(0, 32)}`;

  return row.rejection_reason === null
    && row.handle_id === expectedHandleId
    && row.raw_location === `tool_output:${row.handle_id}`
    && row.success === (facts.success ? 1 : 0)
    && row.record_path === facts.recordPath
    && row.record_count === facts.recordCount
    && storedJsonMatches(row.envelope_meta_json, facts.envelopeMeta)
    && row.completeness === facts.completeness
    && storedJsonMatches(row.projected_records_json, facts.projectedRecords)
    && row.status_code === facts.statusCode
    && bufferMatches(row.cursor_bytes, cursorBytes)
    && row.cursor_sha256 === cursorDigest
    && row.continuation_ref === continuationRef
    && row.cursor_repeated === (priorCursor ? 1 : 0);
}

function crossingAuthorityMatches(
  db: EventLogDatabase,
  row: SettledResultRow,
): boolean {
  const parameters = [row.session_id, row.source_user_seq, row.logical_tool_call_id] as const;
  const frozen = db.prepare(`
    SELECT physical_dispatch_id, ordinal, relation, retry_of, tool_name, argument_digest
      FROM logical_call_settlement_crossings
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
     ORDER BY ordinal
  `).all(...parameters) as RedemptionCrossingRow[];
  const live = db.prepare(`
    SELECT physical_dispatch_id, ordinal, relation, retry_of, tool_name, argument_digest, state
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
     ORDER BY ordinal
  `).all(...parameters) as RedemptionCrossingRow[];
  const frozenJson = crossingSetJson(frozen);
  const liveJson = crossingSetJson(live);
  const frozenDigest = sha256(frozenJson);
  if (
    frozen.length !== row.settlement_crossing_count
    || live.length !== row.settlement_crossing_count
    || frozenJson !== liveJson
    || frozenDigest !== row.settlement_crossings_digest
    || sha256(liveJson) !== row.settlement_crossings_digest
    || live.some((crossing) => crossing.state === 'started')
    || frozen.at(-1)?.physical_dispatch_id !== row.physical_dispatch_id
  ) return false;

  const mirror = db.prepare(`
    SELECT session_id, type, data_json FROM events WHERE id = ?
  `).get(row.settlement_event_id) as {
    session_id: string;
    type: string;
    data_json: string;
  } | undefined;
  if (!mirror || mirror.session_id !== row.session_id || mirror.type !== 'tool_attempt_settled') return false;
  try {
    const data = JSON.parse(mirror.data_json) as Record<string, unknown>;
    return data.sourceUserSeq === row.source_user_seq
      && data.logicalToolCallId === row.logical_tool_call_id
      && data.resultHandleId === row.handle_id
      && data.physicalDispatchCount === row.settlement_crossing_count
      && data.physicalCrossingsDigest === row.settlement_crossings_digest
      && canonicalJson(data.physicalDispatchIds) === canonicalJson(
        frozen.map((crossing) => crossing.physical_dispatch_id),
      );
  } catch {
    return false;
  }
}

/**
 * Redeem the result named by the immutable logical settlement row.
 *
 * This deliberately does not search for a plausible/latest handle. A handle
 * inserted after settlement has no `result_handle_id` binding and can never be
 * promoted into evidence. Raw byte count and SHA-256 are recomputed on every
 * read, including after restart.
 */
export function redeemSuccessfulSettlementResultForHost(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
}): ResultRedemption<SuccessfulSettlementResultEvidence> {
  if (
    !input.sessionId.trim()
    || !Number.isSafeInteger(input.sourceUserSeq)
    || input.sourceUserSeq <= 0
    || !input.acceptedTaskId.trim()
    || !input.logicalToolCallId.trim()
  ) {
    return { status: 'forbidden', reason: 'exact accepted logical-call identity is required' };
  }
  try {
    const db = openEventLog();
    const row = db.prepare(`
      SELECT h.*, h.rowid AS handle_rowid,
             s.execution_kind AS settlement_execution_kind,
             s.outcome_kind AS settlement_outcome_kind,
             s.result_handle_id AS settlement_result_handle_id,
             s.physical_crossing_count AS settlement_crossing_count,
             s.physical_crossings_digest AS settlement_crossings_digest,
             s.settlement_event_id AS settlement_event_id,
             l.accepted_task_id AS logical_accepted_task_id,
             l.tool_name AS logical_tool_name,
             l.argument_digest AS logical_argument_digest,
             l.state AS logical_state,
             p.state AS dispatch_state,
             p.tool_name AS dispatch_tool_name,
             p.argument_digest AS dispatch_argument_digest,
             p.ordinal AS dispatch_ordinal,
             (SELECT MAX(p2.ordinal)
                FROM physical_dispatches p2
               WHERE p2.session_id = s.session_id
                 AND p2.source_user_seq = s.source_user_seq
                 AND p2.logical_tool_call_id = s.logical_tool_call_id
             ) AS final_dispatch_ordinal,
             (SELECT COUNT(*)
                FROM logical_call_settlement_crossings sc
               WHERE sc.session_id = s.session_id
                 AND sc.source_user_seq = s.source_user_seq
                 AND sc.logical_tool_call_id = s.logical_tool_call_id
             ) AS frozen_crossing_count,
             (SELECT COUNT(*)
                FROM logical_call_settlement_crossings sc
               WHERE sc.session_id = s.session_id
                 AND sc.source_user_seq = s.source_user_seq
                 AND sc.logical_tool_call_id = s.logical_tool_call_id
                 AND sc.physical_dispatch_id = h.physical_dispatch_id
             ) AS frozen_handle_crossing_count
        FROM logical_call_settlements s
        JOIN logical_tool_calls l
          ON l.session_id = s.session_id
         AND l.source_user_seq = s.source_user_seq
         AND l.logical_tool_call_id = s.logical_tool_call_id
        JOIN durable_result_handles h
          ON h.handle_id = s.result_handle_id
        JOIN physical_dispatches p
          ON p.session_id = h.session_id
         AND p.source_user_seq = h.source_user_seq
         AND p.logical_tool_call_id = h.logical_tool_call_id
         AND p.physical_dispatch_id = h.physical_dispatch_id
       WHERE s.session_id = ? AND s.source_user_seq = ?
         AND s.logical_tool_call_id = ?
    `).get(
      input.sessionId,
      input.sourceUserSeq,
      input.logicalToolCallId,
    ) as SettledResultRow | undefined;
    if (!row) {
      return { status: 'missing', reason: 'logical settlement has no bound durable result' };
    }
    if (
      row.logical_accepted_task_id !== input.acceptedTaskId
      || row.accepted_task_id !== input.acceptedTaskId
      || row.scope_kind !== 'authoritative'
      || row.session_id !== input.sessionId
      || row.source_user_seq !== input.sourceUserSeq
      || row.logical_tool_call_id !== input.logicalToolCallId
    ) {
      return { status: 'forbidden', reason: 'settlement result belongs to another accepted task' };
    }
    if (
      row.logical_state !== 'settled'
      || row.settlement_execution_kind !== 'provider_execution'
      || !['succeeded', 'empty_result'].includes(row.settlement_outcome_kind)
      || row.settlement_result_handle_id !== row.handle_id
      || row.success !== 1
      || row.dispatch_state !== 'returned'
      || row.physical_dispatch_id === null
      || row.logical_tool_name !== row.tool_name
      || row.dispatch_tool_name !== row.tool_name
      || row.logical_argument_digest !== row.argument_digest
      || row.dispatch_argument_digest !== row.argument_digest
      || row.dispatch_ordinal !== row.final_dispatch_ordinal
      || row.frozen_handle_crossing_count !== 1
      || row.frozen_crossing_count !== row.settlement_crossing_count
    ) {
      return { status: 'corrupt', reason: 'settlement, crossing, and result-handle authority disagree' };
    }
    if (row.raw_payload_json === null || row.raw_payload_sha256 === null || row.raw_location === null) {
      return { status: 'missing', reason: 'settlement result has no retained raw payload' };
    }
    if (
      Buffer.byteLength(row.raw_payload_json, 'utf8') !== row.raw_byte_count
      || sha256(row.raw_payload_json) !== row.raw_payload_sha256
    ) {
      return { status: 'corrupt', reason: 'settlement result bytes do not match their durable digest' };
    }
    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(row.raw_payload_json) as unknown;
    } catch {
      return { status: 'corrupt', reason: 'settlement result raw payload is not valid JSON' };
    }
    if (!rawFactsMatch(db, row, rawPayload)) {
      return { status: 'corrupt', reason: 'settlement result projections disagree with raw bytes' };
    }
    if (!crossingAuthorityMatches(db, row)) {
      return { status: 'corrupt', reason: 'settlement crossing set or digest disagrees with authority' };
    }
    return {
      status: 'ok',
      value: {
        acceptedTaskId: input.acceptedTaskId,
        logicalToolCallId: input.logicalToolCallId,
        physicalDispatchId: row.physical_dispatch_id,
        resultHandleId: row.handle_id,
        toolName: row.tool_name,
        outcomeKind: row.settlement_outcome_kind as 'succeeded' | 'empty_result',
        handle: rowToHandle(row),
        rawPayload,
        rawPayloadJson: row.raw_payload_json,
        rawPayloadSha256: row.raw_payload_sha256,
        rawByteCount: row.raw_byte_count,
      },
    };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export function redeemRawResult(
  location: string,
  authority?: ResultHandleAuthority,
): ResultRedemption<unknown> {
  try {
    const row = openEventLog().prepare(
      'SELECT * FROM durable_result_handles WHERE raw_location = ?',
    ).get(location) as DurableResultRow | undefined;
    if (!row) return { status: 'missing', reason: 'raw result location is missing' };
    if (!mayRedeem(row, authority)) {
      return { status: 'forbidden', reason: 'raw result belongs to another accepted call' };
    }
    if (row.raw_payload_json === null || row.raw_payload_sha256 === null) {
      return { status: 'missing', reason: `raw payload was not stored (${row.rejection_reason ?? 'unknown'})` };
    }
    if (
      Buffer.byteLength(row.raw_payload_json, 'utf8') !== row.raw_byte_count
      || sha256(row.raw_payload_json) !== row.raw_payload_sha256
    ) {
      return { status: 'corrupt', reason: 'raw payload bytes do not match their durable digest' };
    }
    try {
      return { status: 'ok', value: JSON.parse(row.raw_payload_json) as unknown };
    } catch {
      return { status: 'corrupt', reason: 'raw payload is not valid JSON' };
    }
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export function redeemContinuation(
  ref: string,
  authority?: ResultHandleAuthority,
): ResultRedemption<string> {
  try {
    const row = openEventLog().prepare(
      'SELECT * FROM durable_result_handles WHERE continuation_ref = ?',
    ).get(ref) as DurableResultRow | undefined;
    if (!row) return { status: 'missing', reason: 'continuation reference is missing' };
    if (!mayRedeem(row, authority)) {
      return { status: 'forbidden', reason: 'continuation belongs to another accepted call' };
    }
    if (!row.cursor_bytes || !row.cursor_sha256) {
      return { status: 'missing', reason: 'continuation cursor was not stored' };
    }
    const bytes = Buffer.isBuffer(row.cursor_bytes)
      ? row.cursor_bytes
      : Buffer.from(row.cursor_bytes as unknown as Uint8Array);
    if (sha256(bytes) !== row.cursor_sha256 || bytes.byteLength > RESULT_CURSOR_MAX_BYTES) {
      return { status: 'corrupt', reason: 'cursor bytes do not match their durable digest' };
    }
    return { status: 'ok', value: bytes.toString('utf8') };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

/** Compatibility wrapper. Scoped rows still require exact authority. */
export function readRawResult(
  location: string,
  authority?: ResultHandleAuthority,
): unknown {
  const result = redeemRawResult(location, authority);
  return result.status === 'ok' ? result.value : undefined;
}

/** Compatibility wrapper. Scoped rows still require exact authority. */
export function resolveContinuation(
  ref: string,
  authority?: ResultHandleAuthority,
): string | undefined {
  const result = redeemContinuation(ref, authority);
  return result.status === 'ok' ? result.value : undefined;
}

/** Test-only compatibility seam; durable authority is deleted, never cached. */
export function _resetResultHandleStoreForTests(): void {
  try {
    openEventLog().prepare('DELETE FROM durable_result_handles').run();
  } catch {
    // Tests that have not initialized the event log have nothing to reset.
  }
}
