import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { HARNESS_SCHEMA_VERSION } from './schema-version.js';
import {
  PLAN_TASK_ACTIVATION_RECEIPTS_TABLE,
  PLAN_TASK_BINDING_SEAL_RECOVERY_CURSOR_TABLE,
  PLAN_TASK_BINDING_SEAL_INTENTS_TABLE,
  PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE,
  createPlanTaskPreparationCheckpointSchema,
  createHostPlannedResolutionCoexistenceSchema,
  hostPlannedResolutionProofSql,
  refreshPlanTaskActivationReceiptInsertTrigger,
} from './host-planned-resolution-coexistence.js';
import {
  ASYNC_READ_REFINEMENT_COMPLETION_RECEIPTS_TABLE,
  ASYNC_READ_REFINEMENT_INTENTS_TABLE,
  ASYNC_READ_REFINEMENT_RECOVERY_CURSOR_TABLE,
  ASYNC_READ_REFINEMENT_START_RECEIPTS_TABLE,
  ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE,
  createAsyncReadRefinementSchema,
  createAsyncReadRefinementTerminalRecoverySchema,
  createAsyncReadRefinementTerminalRecoverySchemaV72,
} from './async-read-refinement-schema.js';

/**
 * Schema-only harness migration authority. Keep this module free of model,
 * tool, delivery, queue, channel, and daemon runtime imports: the cutover hold
 * loads it in a short-lived child before authenticated attestation is exposed.
 */

interface EventLogMigration {
  version: number;
  sql: string;
  backfill?: (db: Database.Database) => void;
  /** SQLite cannot retarget a parent table while child foreign keys are live.
   *  A migration opting into this mode must run its own foreign-key and
   *  integrity checks before the schema version is committed. */
  foreignKeysOff?: true;
}

type LogicalModelResultProjectionClassForMigration =
  | 'text'
  | 'structured'
  | 'media'
  | 'refused_pre_dispatch'
  | 'not_started'
  | 'user_rejected'
  | 'effect_unknown';

interface LogicalModelResultProjectionMaterialForMigration {
  callId: string;
  toolName: string;
  callNamespace: string | null;
  resultClass: LogicalModelResultProjectionClassForMigration;
  resultItemBytes: number;
  resultItemSha256: string;
}

const HOST_RESULT_PROTOCOL_FOR_MIGRATION = 'host_tool_disposition_v1';
const USER_REJECTED_RESULT_FOR_MIGRATION =
  'The user rejected this action. Do not retry it; continue without it or explain what changes.';
const LOWER_HEX_SHA256 = /^[a-f0-9]{64}$/;

/** Schema migrations cannot import the runtime receipt writer without making
 * the cutover process load the event log recursively. Keep this small
 * canonical whole-result serializer byte-identical to the runtime helper and
 * pin that equality through the v69 backfill test. */
function canonicalProjectionJsonForMigration(
  value: unknown,
  ancestors = new Set<object>(),
): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('logical model result contains a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined') return 'null';
  if (typeof value !== 'object') throw new Error('logical model result is not JSON-serializable');
  if (ancestors.has(value)) throw new Error('logical model result is cyclic');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalProjectionJsonForMigration(entry, ancestors)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalProjectionJsonForMigration(record[key], ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function hostDispositionMessageForMigration(
  disposition: 'refused_pre_dispatch' | 'not_started' | 'effect_unknown',
  retry: 'replan' | 'do_not_retry',
): string {
  if (disposition === 'effect_unknown') {
    return 'Execution may have started. Do not retry this call; reconciliation is required.';
  }
  if (retry === 'do_not_retry') {
    return 'This exact call is unavailable for this request. Do not retry it; use another capability or explain the limitation.';
  }
  return disposition === 'not_started'
    ? 'This call was not started because another call in the same frame could not safely proceed. No effect occurred; replan from the paired results.'
    : 'This call was refused before execution. No effect occurred; correct the call or choose another capability.';
}

function exactHostProjectionClassForMigration(
  item: Record<string, unknown>,
  callId: string,
  toolName: string,
): Exclude<LogicalModelResultProjectionClassForMigration, 'text' | 'structured' | 'media'> | null {
  const rejected = {
    type: 'function_call_result',
    callId,
    name: toolName,
    status: 'completed',
    output: { type: 'text', text: USER_REJECTED_RESULT_FOR_MIGRATION },
  };
  if (canonicalProjectionJsonForMigration(item) === canonicalProjectionJsonForMigration(rejected)) {
    return 'user_rejected';
  }
  const output = item.output && typeof item.output === 'object' && !Array.isArray(item.output)
    ? item.output as Record<string, unknown>
    : null;
  if (output?.type !== 'text' || typeof output.text !== 'string') return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(output.text) as unknown;
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
  const marker = decoded as Record<string, unknown>;
  const disposition = marker.disposition;
  if (
    marker.protocol !== HOST_RESULT_PROTOCOL_FOR_MIGRATION
    || (disposition !== 'refused_pre_dispatch'
      && disposition !== 'not_started'
      && disposition !== 'effect_unknown')
    || typeof marker.frameDigest !== 'string'
    || !LOWER_HEX_SHA256.test(marker.frameDigest)
    || !Number.isSafeInteger(marker.frameIndex)
    || Number(marker.frameIndex) < 0
    || !Number.isSafeInteger(marker.frameSize)
    || Number(marker.frameSize) <= 0
    || Number(marker.frameIndex) >= Number(marker.frameSize)
    || (marker.retry !== 'replan' && marker.retry !== 'do_not_retry')
  ) return null;
  const unknown = disposition === 'effect_unknown';
  if (
    (unknown && (
      marker.countsRefusal !== undefined
      || marker.effect !== 'may_have_started'
      || marker.retry !== 'do_not_retry'
      || marker.requiresReconciliation !== true
      || marker.diagnostic !== undefined
    ))
    || (!unknown && (
      marker.effect !== 'none'
      || marker.requiresReconciliation !== false
      || (marker.countsRefusal !== undefined && marker.countsRefusal !== true)
      || (marker.diagnostic !== undefined
        && (typeof marker.diagnostic !== 'string' || !marker.diagnostic))
      || (disposition === 'not_started'
        && (marker.retry !== 'replan' || marker.countsRefusal !== undefined))
    ))
  ) return null;
  const rebuiltMarker = {
    protocol: HOST_RESULT_PROTOCOL_FOR_MIGRATION,
    disposition,
    frameDigest: marker.frameDigest,
    frameIndex: Number(marker.frameIndex),
    frameSize: Number(marker.frameSize),
    ...(marker.countsRefusal === true ? { countsRefusal: true } : {}),
    effect: unknown ? 'may_have_started' : 'none',
    retry: marker.retry,
    requiresReconciliation: unknown,
    message: hostDispositionMessageForMigration(disposition, marker.retry),
    ...(typeof marker.diagnostic === 'string' ? { diagnostic: marker.diagnostic } : {}),
  };
  const rebuilt = {
    type: 'function_call_result',
    callId,
    name: toolName,
    status: 'completed',
    output: { type: 'text', text: JSON.stringify(rebuiltMarker) },
  };
  return canonicalProjectionJsonForMigration(item) === canonicalProjectionJsonForMigration(rebuilt)
    ? disposition
    : null;
}

function projectionClassForMigration(
  item: Record<string, unknown>,
  callId: string,
  toolName: string,
): LogicalModelResultProjectionClassForMigration {
  const reserved = exactHostProjectionClassForMigration(item, callId, toolName);
  if (reserved) return reserved;
  const output = item.output;
  const entries = Array.isArray(output) ? output : [output];
  if (entries.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const type = (entry as Record<string, unknown>).type;
    return type === 'image' || type === 'file' || type === 'input_image' || type === 'input_file';
  })) return 'media';
  if (
    typeof output === 'string'
    || (
      output !== null && typeof output === 'object' && !Array.isArray(output)
      && (output as Record<string, unknown>).type === 'text'
      && typeof (output as Record<string, unknown>).text === 'string'
      && Object.keys(output as Record<string, unknown>).every((key) => key === 'type' || key === 'text')
    )
  ) return 'text';
  return 'structured';
}

function projectionMaterialForMigration(item: unknown): LogicalModelResultProjectionMaterialForMigration | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const row = item as Record<string, unknown>;
  const callId = typeof row.callId === 'string' ? row.callId.trim() : '';
  const toolName = typeof row.name === 'string' ? row.name.trim() : '';
  if (row.namespace !== undefined && typeof row.namespace !== 'string') return null;
  const callNamespace = typeof row.namespace === 'string' ? row.namespace : null;
  if (
    row.type !== 'function_call_result'
    || row.status !== 'completed'
    || !callId
    || !toolName
    || row.output === undefined
  ) return null;
  const canonicalBytes = canonicalProjectionJsonForMigration(row);
  return {
    callId,
    toolName,
    callNamespace,
    resultClass: projectionClassForMigration(row, callId, toolName),
    resultItemBytes: Buffer.byteLength(canonicalBytes, 'utf8'),
    resultItemSha256: createHash('sha256').update(canonicalBytes, 'utf8').digest('hex'),
  };
}

type MigrationProtocolOpenCall = { name: string; namespace: string | null };

function inspectProtocolForMigration(history: unknown[], requireBalanced: boolean): {
  valid: boolean;
  open: Map<string, MigrationProtocolOpenCall>;
} {
  const calls = new Map<string, MigrationProtocolOpenCall>();
  const open = new Map<string, MigrationProtocolOpenCall>();
  const results = new Set<string>();
  let valid = true;
  for (const candidate of history) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    if (item.type === 'function_call') {
      const callId = typeof item.callId === 'string' && item.callId ? item.callId : '';
      const name = typeof item.name === 'string' && item.name ? item.name : '';
      if (
        !callId || !name || calls.has(callId)
        || (item.namespace !== undefined && typeof item.namespace !== 'string')
      ) {
        valid = false;
        continue;
      }
      const call = {
        name,
        namespace: typeof item.namespace === 'string' ? item.namespace : null,
      };
      calls.set(callId, call);
      open.set(callId, call);
      continue;
    }
    if (item.type === 'function_call_result') {
      const callId = typeof item.callId === 'string' && item.callId ? item.callId : '';
      const call = calls.get(callId);
      if (!call || results.has(callId)) {
        valid = false;
        continue;
      }
      if (
        (item.name !== undefined && item.name !== call.name)
        || (item.namespace !== undefined && item.namespace !== call.namespace)
      ) valid = false;
      results.add(callId);
      open.delete(callId);
      continue;
    }
    if (
      (item.role === 'user' || item.role === 'assistant' || item.role === 'system')
      && open.size > 0
    ) valid = false;
  }
  if (requireBalanced && open.size > 0) valid = false;
  return { valid, open };
}

function exactOpenAdmissionFrameForMigration(preHistory: unknown[], frameHistory: unknown[]): boolean {
  const pre = inspectProtocolForMigration(preHistory, true);
  if (!pre.valid) return false;
  if (frameHistory.some((candidate) => (
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    && (candidate as Record<string, unknown>).type === 'function_call_result'
  ))) return false;
  const frameCalls = frameHistory.filter((candidate) => (
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    && (candidate as Record<string, unknown>).type === 'function_call'
  ));
  if (frameCalls.length === 0) return false;
  const combined = inspectProtocolForMigration([...preHistory, ...frameHistory], false);
  if (!combined.valid || combined.open.size !== frameCalls.length) return false;
  const ids = frameCalls.map((candidate) => (candidate as Record<string, unknown>).callId);
  return ids.every((callId) => typeof callId === 'string' && combined.open.has(callId))
    && new Set(ids).size === ids.length;
}
export interface AcceptedTurnSourceEventDigestInput {
  id: string;
  sessionId: string;
  seq: number;
  turn: number;
  role: string;
  type: string;
  parentEventId: string | null;
  dataJson: string;
  createdAt: string;
}

/** Value-opaque identity for the exact accepted source event. The raw prompt
 * stays in events.data_json; call authority persists only this digest. */
export function acceptedTurnSourceEventDigest(
  input: AcceptedTurnSourceEventDigestInput,
): string {
  return createHash('sha256').update(JSON.stringify({
    id: input.id,
    sessionId: input.sessionId,
    seq: input.seq,
    turn: input.turn,
    role: input.role,
    type: input.type,
    parentEventId: input.parentEventId,
    dataJson: input.dataJson,
    createdAt: input.createdAt,
  })).digest('hex');
}

export interface AcceptedTurnCallAuthorityDigestInput {
  authorityKind:
    | 'turn_graph'
    | 'host_v1'
    | 'host_v1_read_only'
    | 'workflow_v1_read_only'
    | 'workflow_v2_paginated_read'
    | 'workflow_v3_call';
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  sourceEventId: string;
  sourceEventDigest: string;
  sourceTurn: number;
  engineVersion: string;
  surfaceVersion: string;
  surfaceDigest: string;
  effectCeiling: string;
  effectBoundsJson: string;
  maxLogicalCalls: number | null;
  maxParallelCalls: number | null;
  catalogRevisionDigest: string | null;
  bindingRevisionDigest: string | null;
  graphEventId: string | null;
  graphHash: string | null;
  workflowActivationId?: string | null;
  workflowActivationDigest?: string | null;
  workflowId?: string | null;
  workflowRevision?: number | null;
  workflowDigest?: string | null;
  runId?: string | null;
  runOccurrenceId?: string | null;
  workflowNodeId?: string | null;
  workflowNodeAttempt?: number | null;
  invocationPlanDigest?: string | null;
  bindingSnapshotDigest?: string | null;
  controlDigest?: string | null;
  workflowLogicalCallId?: string | null;
}

/** Immutable root digest shared by migration backfill and runtime arming. */
export function acceptedTurnCallAuthorityDigest(
  input: AcceptedTurnCallAuthorityDigestInput,
): string {
  return createHash('sha256').update(JSON.stringify({
    protocolVersion: 1,
    ...input,
  })).digest('hex');
}

export function acceptedTurnCallSurfaceDigest(input: {
  authorityKind: AcceptedTurnCallAuthorityDigestInput['authorityKind'];
  engineVersion: string;
  surfaceVersion: string;
  effectCeiling: string;
  effectBoundsJson: string;
  maxLogicalCalls: number | null;
  maxParallelCalls: number | null;
  catalogRevisionDigest: string | null;
  bindingRevisionDigest: string | null;
  graphEventId: string | null;
  graphHash: string | null;
  workflowActivationId?: string | null;
  workflowActivationDigest?: string | null;
  workflowId?: string | null;
  workflowRevision?: number | null;
  workflowDigest?: string | null;
  runId?: string | null;
  runOccurrenceId?: string | null;
  workflowNodeId?: string | null;
  workflowNodeAttempt?: number | null;
  invocationPlanDigest?: string | null;
  bindingSnapshotDigest?: string | null;
  controlDigest?: string | null;
  workflowLogicalCallId?: string | null;
}): string {
  return createHash('sha256').update(JSON.stringify({
    protocolVersion: 1,
    ...input,
  })).digest('hex');
}

function quotedSchemaIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Return every table whose foreign-key ancestry reaches one of the roots.
 * Migration rehearsals may deliberately retain unrelated legacy orphans; an
 * authority rebuild must fail on damage in its own FK closure without
 * misattributing those unrelated rows to the rebuilt protocol. */
function foreignKeyClosure(
  db: Database.Database,
  roots: Iterable<string>,
): Set<string> {
  const relevant = new Set(roots);
  const tables = (db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  ).all() as Array<{ name: string }>).map((row) => row.name);
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of tables) {
      if (relevant.has(name)) continue;
      const reachesRelevantParent = (db.prepare(
        `PRAGMA foreign_key_list(${quotedSchemaIdentifier(name)})`,
      ).all() as Array<{ table: string }>).some((fk) => relevant.has(fk.table));
      if (reachesRelevantParent) {
        relevant.add(name);
        changed = true;
      }
    }
  }
  return relevant;
}

function createHostAwareLogicalRefinementTrigger(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER trg_logical_call_contract_refinement_once
    BEFORE UPDATE OF argument_digest, effective_argument_digest,
                     refined_at, refinement_event_id
    ON logical_tool_calls
    WHEN NOT (
      OLD.state = 'open'
      AND NEW.state = 'open'
      AND OLD.argument_digest = OLD.raw_argument_digest
      AND OLD.effective_argument_digest IS NULL
      AND OLD.refined_at IS NULL
      AND OLD.refinement_event_id IS NULL
      AND NEW.raw_argument_digest = OLD.raw_argument_digest
      AND NEW.effective_argument_digest IS NOT NULL
      AND length(NEW.effective_argument_digest) = 64
      AND NEW.argument_digest = NEW.effective_argument_digest
      AND NEW.argument_digest != NEW.raw_argument_digest
      AND NEW.refined_at IS NOT NULL
      AND NEW.refinement_event_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM accepted_turn_call_authorities a
         WHERE a.session_id = OLD.session_id
           AND a.source_user_seq = OLD.source_user_seq
           AND a.accepted_task_id = OLD.accepted_task_id
           AND a.state = 'open'
           AND (
             a.authority_kind IN (
               'host_v1','host_v1_read_only','workflow_v1_read_only','workflow_v2_paginated_read'
             )
             OR EXISTS (
               SELECT 1 FROM accepted_task_resolutions r
                WHERE r.session_id = OLD.session_id
                  AND r.source_user_seq = OLD.source_user_seq
                  AND r.accepted_task_id = OLD.accepted_task_id
                  AND r.state = 'open'
             )
           )
      )
      AND NOT EXISTS (
        SELECT 1 FROM physical_dispatches p
         WHERE p.session_id = OLD.session_id
           AND p.source_user_seq = OLD.source_user_seq
           AND p.logical_tool_call_id = OLD.logical_tool_call_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM logical_call_settlements s
         WHERE s.session_id = OLD.session_id
           AND s.source_user_seq = OLD.source_user_seq
           AND s.logical_tool_call_id = OLD.logical_tool_call_id
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'logical call contract refinement is not monotonic');
    END;
  `);
}

/** Retarget the one logical parent without rewriting any child table. The
 * migration runner disables FK enforcement around this transaction; legacy
 * rename mode then keeps child declarations pointed at the canonical table
 * name while the parent is copied and replaced. */
function rebuildLogicalToolCallAuthorityParent(db: Database.Database): void {
  const table = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'logical_tool_calls'`,
  ).get() as { sql: string | null } | undefined;
  if (!table?.sql) return;
  const root = db.prepare(
    `SELECT 1 AS ok FROM sqlite_master
      WHERE type = 'table' AND name = 'accepted_turn_call_authorities'`,
  ).get() as { ok: number } | undefined;
  if (!root) throw new Error('schema v50 call-authority root is missing');

  const parentFks = db.prepare('PRAGMA foreign_key_list(logical_tool_calls)').all() as Array<{
    table: string;
    from: string;
    to: string;
  }>;
  const currentParent = new Set(parentFks
    .filter((row) => row.from === 'session_id' || row.from === 'source_user_seq')
    .map((row) => row.table));
  if (currentParent.size === 1 && currentParent.has('accepted_turn_call_authorities')) return;
  if (currentParent.size !== 1 || !currentParent.has('accepted_task_resolutions')) {
    throw new Error('schema v50 refuses an unknown logical-tool-call parent');
  }

  const columns = (db.prepare('PRAGMA table_info(logical_tool_calls)').all() as Array<{ name: string }>)
    .map((column) => column.name);
  if (!columns.length) throw new Error('schema v50 logical-tool-call columns are missing');
  const beforeRows = (db.prepare('SELECT COUNT(*) AS n FROM logical_tool_calls').get() as { n: number }).n;
  const objects = db.prepare(`
    SELECT type, name, sql FROM sqlite_master
     WHERE tbl_name = 'logical_tool_calls'
       AND type IN ('index','trigger') AND sql IS NOT NULL
     ORDER BY type, name
  `).all() as Array<{ type: 'index' | 'trigger'; name: string; sql: string }>;
  const childTables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => (db.prepare(`PRAGMA foreign_key_list(${quotedSchemaIdentifier(name)})`).all() as Array<{ table: string }>)
      .some((fk) => fk.table === 'logical_tool_calls'));
  const childSnapshot = new Map(childTables.map((name) => [name, {
    rows: (db.prepare(`SELECT COUNT(*) AS n FROM ${quotedSchemaIdentifier(name)}`).get() as { n: number }).n,
    foreignKeys: JSON.stringify(db.prepare(`PRAGMA foreign_key_list(${quotedSchemaIdentifier(name)})`).all()),
  }]));

  const parentReference = /REFERENCES\s+accepted_task_resolutions\s*\(\s*session_id\s*,\s*source_user_seq\s*\)/gi;
  const matches = table.sql.match(parentReference) ?? [];
  if (matches.length !== 1) {
    throw new Error(`schema v50 expected one logical parent reference, found ${matches.length}`);
  }
  const rebuiltSql = table.sql.replace(
    parentReference,
    'REFERENCES accepted_turn_call_authorities(session_id, source_user_seq)',
  );
  const priorLegacyRename = Number(db.pragma('legacy_alter_table', { simple: true })) === 1;
  db.pragma('legacy_alter_table = ON');
  try {
    for (const object of objects) {
      db.exec(`DROP ${object.type.toUpperCase()} ${quotedSchemaIdentifier(object.name)}`);
    }
    db.exec('ALTER TABLE logical_tool_calls RENAME TO logical_tool_calls_v49');
    db.exec(rebuiltSql);
    const columnList = columns.map(quotedSchemaIdentifier).join(', ');
    db.exec(`INSERT INTO logical_tool_calls (${columnList})
      SELECT ${columnList} FROM logical_tool_calls_v49`);
    const copiedRows = (db.prepare('SELECT COUNT(*) AS n FROM logical_tool_calls').get() as { n: number }).n;
    if (copiedRows !== beforeRows) {
      throw new Error(`schema v50 logical row-count mismatch: ${beforeRows} -> ${copiedRows}`);
    }
    db.exec('DROP TABLE logical_tool_calls_v49');
    for (const object of objects) {
      if (object.name === 'trg_logical_call_contract_refinement_once') continue;
      db.exec(object.sql);
    }
    createHostAwareLogicalRefinementTrigger(db);
  } finally {
    db.pragma(`legacy_alter_table = ${priorLegacyRename ? 'ON' : 'OFF'}`);
  }

  for (const [name, before] of childSnapshot) {
    const rows = (db.prepare(`SELECT COUNT(*) AS n FROM ${quotedSchemaIdentifier(name)}`).get() as { n: number }).n;
    const foreignKeys = JSON.stringify(db.prepare(`PRAGMA foreign_key_list(${quotedSchemaIdentifier(name)})`).all());
    if (rows !== before.rows || foreignKeys !== before.foreignKeys) {
      throw new Error(`schema v50 changed child-table rows or foreign keys for ${name}`);
    }
  }
  const relevantTables = new Set(['accepted_turn_call_authorities', 'logical_tool_calls', ...childTables]);
  const violations = db.pragma('foreign_key_check') as Array<{ table: string }>;
  const relevantViolations = violations.filter((violation) => relevantTables.has(violation.table));
  if (relevantViolations.length > 0) {
    throw new Error(`schema v50 foreign-key check failed for ${relevantViolations.length} call-authority row(s)`);
  }
  const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error(`schema v50 integrity check failed: ${JSON.stringify(integrity).slice(0, 240)}`);
  }
}

function createV51AcceptedCallAuthoritySchema(
  db: Database.Database,
  includePaginated = false,
  includeProductionHost = false,
  includeWorkflowV3 = false,
): void {
  db.exec(`
    CREATE TABLE accepted_turn_call_authorities (
      session_id                TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      source_user_seq           INTEGER NOT NULL CHECK (source_user_seq > 0),
      accepted_task_id          TEXT NOT NULL UNIQUE,
      authority_protocol        INTEGER NOT NULL CHECK (authority_protocol = 1),
      authority_kind            TEXT NOT NULL
                                CHECK (authority_kind IN (
                                  'turn_graph','host_v1_read_only','workflow_v1_read_only'
                                  ${includeProductionHost ? ",'host_v1'" : ''}
                                  ${includePaginated ? ",'workflow_v2_paginated_read'" : ''}
                                  ${includeWorkflowV3 ? ",'workflow_v3_call'" : ''}
                                )),
      source_event_id           TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
      source_event_digest       TEXT NOT NULL CHECK (length(source_event_digest) = 64),
      source_turn               INTEGER NOT NULL CHECK (source_turn >= 0),
      engine_version            TEXT NOT NULL CHECK (length(engine_version) BETWEEN 1 AND 128),
      surface_version           TEXT NOT NULL CHECK (length(surface_version) BETWEEN 1 AND 128),
      surface_digest            TEXT NOT NULL CHECK (length(surface_digest) = 64),
      effect_ceiling            TEXT NOT NULL CHECK (length(effect_ceiling) BETWEEN 1 AND 64),
      effect_bounds_json        TEXT NOT NULL
                                CHECK (json_valid(effect_bounds_json)
                                  AND json_type(effect_bounds_json) = 'array'),
      max_logical_calls         INTEGER CHECK (max_logical_calls IS NULL OR max_logical_calls > 0),
      max_parallel_calls        INTEGER CHECK (max_parallel_calls IS NULL OR max_parallel_calls > 0),
      catalog_revision_digest   TEXT
                                CHECK (catalog_revision_digest IS NULL OR length(catalog_revision_digest) = 64),
      binding_revision_digest   TEXT
                                CHECK (binding_revision_digest IS NULL OR length(binding_revision_digest) = 64),
      graph_event_id            TEXT REFERENCES events(id) ON DELETE RESTRICT,
      graph_hash                TEXT CHECK (graph_hash IS NULL OR length(graph_hash) = 64),
      workflow_activation_id    TEXT REFERENCES workflow_node_invocation_activations(activation_id)
                                ON DELETE RESTRICT,
      workflow_activation_digest TEXT
                                CHECK (workflow_activation_digest IS NULL OR length(workflow_activation_digest) = 64),
      workflow_id               TEXT CHECK (workflow_id IS NULL OR length(workflow_id) BETWEEN 1 AND 256),
      workflow_revision         INTEGER CHECK (workflow_revision IS NULL OR workflow_revision > 0),
      workflow_digest           TEXT CHECK (workflow_digest IS NULL OR length(workflow_digest) = 64),
      run_id                    TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 256),
      run_occurrence_id         TEXT CHECK (run_occurrence_id IS NULL OR length(run_occurrence_id) BETWEEN 1 AND 256),
      workflow_node_id          TEXT CHECK (workflow_node_id IS NULL OR length(workflow_node_id) BETWEEN 1 AND 256),
      workflow_node_attempt     INTEGER CHECK (workflow_node_attempt IS NULL OR workflow_node_attempt > 0),
      invocation_plan_digest    TEXT CHECK (invocation_plan_digest IS NULL OR length(invocation_plan_digest) = 64),
      binding_snapshot_digest   TEXT CHECK (binding_snapshot_digest IS NULL OR length(binding_snapshot_digest) = 64),
      control_digest            TEXT CHECK (control_digest IS NULL OR length(control_digest) = 64),
      workflow_logical_call_id  TEXT
                                CHECK (workflow_logical_call_id IS NULL OR length(workflow_logical_call_id) BETWEEN 1 AND 512),
      authority_digest          TEXT NOT NULL UNIQUE CHECK (length(authority_digest) = 64),
      state                     TEXT NOT NULL DEFAULT 'open'
                                CHECK (state IN ('open','closed','conflict')),
      revision                  INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      opened_at                 TEXT NOT NULL,
      closed_at                 TEXT,
      close_reason              TEXT CHECK (close_reason IS NULL OR length(close_reason) BETWEEN 1 AND 160),
      PRIMARY KEY (session_id, source_user_seq),
      CHECK (
        authority_kind IN ('workflow_v1_read_only'
          ${includePaginated ? ",'workflow_v2_paginated_read'" : ''}
          ${includeWorkflowV3 ? ",'workflow_v3_call'" : ''})
        OR accepted_task_id = 'task:' || session_id || '#' || source_user_seq
      ),
      CHECK (
        (state = 'open' AND closed_at IS NULL AND close_reason IS NULL)
        OR (state IN ('closed','conflict') AND closed_at IS NOT NULL AND close_reason IS NOT NULL)
      ),
      CHECK (
        (authority_kind = 'host_v1_read_only'
          AND source_turn >= 0
          AND engine_version = 'host_v1_read_only'
          AND effect_ceiling = 'read_compute_host_only'
          AND effect_bounds_json = '["compute","host_only","read"]'
          AND max_logical_calls IS NOT NULL
          AND max_parallel_calls IS NOT NULL
          AND max_parallel_calls <= max_logical_calls
          AND catalog_revision_digest IS NOT NULL
          AND binding_revision_digest IS NOT NULL
          AND graph_event_id IS NULL
          AND graph_hash IS NULL
          AND workflow_activation_id IS NULL
          AND workflow_activation_digest IS NULL
          AND workflow_id IS NULL
          AND workflow_revision IS NULL
          AND workflow_digest IS NULL
          AND run_id IS NULL
          AND run_occurrence_id IS NULL
          AND workflow_node_id IS NULL
          AND workflow_node_attempt IS NULL
          AND invocation_plan_digest IS NULL
          AND binding_snapshot_digest IS NULL
          AND control_digest IS NULL
          AND workflow_logical_call_id IS NULL)
        ${includeProductionHost ? `
        OR
        (authority_kind = 'host_v1'
          AND source_turn >= 0
          AND engine_version = 'host_v1'
          AND surface_version = 'configured_harness_capability_surface_v1'
          AND effect_ceiling = 'admin'
          AND effect_bounds_json = '["admin","compute","external_write","host_only","local_write","read"]'
          AND max_logical_calls IS NOT NULL
          AND max_parallel_calls IS NOT NULL
          AND max_parallel_calls <= max_logical_calls
          AND catalog_revision_digest IS NOT NULL
          AND binding_revision_digest IS NOT NULL
          AND graph_event_id IS NULL
          AND graph_hash IS NULL
          AND workflow_activation_id IS NULL
          AND workflow_activation_digest IS NULL
          AND workflow_id IS NULL
          AND workflow_revision IS NULL
          AND workflow_digest IS NULL
          AND run_id IS NULL
          AND run_occurrence_id IS NULL
          AND workflow_node_id IS NULL
          AND workflow_node_attempt IS NULL
          AND invocation_plan_digest IS NULL
          AND binding_snapshot_digest IS NULL
          AND control_digest IS NULL
          AND workflow_logical_call_id IS NULL)
        ` : ''}
        OR
        (authority_kind = 'turn_graph'
          AND source_turn >= 0
          AND surface_version = 'turn_graph_ir_v1'
          AND effect_bounds_json = '[]'
          AND catalog_revision_digest IS NULL
          AND graph_event_id IS NOT NULL
          AND graph_hash IS NOT NULL
          AND binding_revision_digest = graph_hash
          AND max_logical_calls IS NULL
          AND max_parallel_calls IS NULL
          AND workflow_activation_id IS NULL
          AND workflow_activation_digest IS NULL
          AND workflow_id IS NULL
          AND workflow_revision IS NULL
          AND workflow_digest IS NULL
          AND run_id IS NULL
          AND run_occurrence_id IS NULL
          AND workflow_node_id IS NULL
          AND workflow_node_attempt IS NULL
          AND invocation_plan_digest IS NULL
          AND binding_snapshot_digest IS NULL
          AND control_digest IS NULL
          AND workflow_logical_call_id IS NULL)
        OR
        (authority_kind = 'workflow_v1_read_only'
          AND engine_version = 'workflow_v1_read_only'
          AND surface_version = 'workflow_node_invocation_plan_v1'
          AND effect_ceiling = 'read'
          AND effect_bounds_json = '["read"]'
          AND max_logical_calls = 1
          AND max_parallel_calls = 1
          AND catalog_revision_digest = binding_snapshot_digest
          AND binding_revision_digest = invocation_plan_digest
          AND graph_event_id IS NULL
          AND graph_hash IS NULL
          AND workflow_activation_id IS NOT NULL
          AND workflow_activation_digest IS NOT NULL
          AND workflow_id IS NOT NULL
          AND workflow_revision IS NOT NULL
          AND workflow_digest IS NOT NULL
          AND run_id IS NOT NULL
          AND run_occurrence_id IS NOT NULL
          AND workflow_node_id IS NOT NULL
          AND workflow_node_attempt IS NOT NULL
          AND invocation_plan_digest IS NOT NULL
          AND binding_snapshot_digest IS NOT NULL
          AND control_digest IS NOT NULL
          AND workflow_logical_call_id IS NOT NULL)
        ${includePaginated ? `
        OR
        (authority_kind = 'workflow_v2_paginated_read'
          AND engine_version = 'workflow_v2_paginated_read'
          AND surface_version = 'workflow_paginated_read_plan_v1'
          AND effect_ceiling = 'read'
          AND effect_bounds_json = '["read"]'
          AND max_logical_calls IS NOT NULL
          AND max_logical_calls BETWEEN 1 AND 10000
          AND max_parallel_calls = 1
          AND catalog_revision_digest = binding_snapshot_digest
          AND binding_revision_digest = invocation_plan_digest
          AND graph_event_id IS NULL
          AND graph_hash IS NULL
          AND workflow_activation_id IS NULL
          AND workflow_activation_digest IS NOT NULL
          AND workflow_id IS NOT NULL
          AND workflow_revision IS NOT NULL
          AND workflow_digest IS NOT NULL
          AND run_id IS NOT NULL
          AND run_occurrence_id IS NOT NULL
          AND workflow_node_id IS NOT NULL
          AND workflow_node_attempt IS NOT NULL
          AND invocation_plan_digest IS NOT NULL
          AND binding_snapshot_digest IS NOT NULL
          AND control_digest IS NOT NULL
          AND workflow_logical_call_id IS NULL)
        ` : ''}
        ${includeWorkflowV3 ? `
        OR
        (authority_kind = 'workflow_v3_call'
          AND engine_version = 'workflow_v3_call'
          AND surface_version = 'workflow_node_invocation_plan_v1'
          AND effect_ceiling IN ('host_only','local_write','external_write','admin')
          AND effect_bounds_json = '["' || effect_ceiling || '"]'
          AND max_logical_calls = 1
          AND max_parallel_calls = 1
          AND catalog_revision_digest = binding_snapshot_digest
          AND binding_revision_digest IS NOT NULL
          AND graph_event_id IS NULL
          AND graph_hash IS NULL
          AND workflow_activation_id IS NOT NULL
          AND workflow_activation_digest IS NOT NULL
          AND workflow_id IS NOT NULL
          AND workflow_revision IS NOT NULL
          AND workflow_digest IS NOT NULL
          AND run_id IS NOT NULL
          AND run_occurrence_id IS NOT NULL
          AND workflow_node_id IS NOT NULL
          AND workflow_node_attempt IS NOT NULL
          AND invocation_plan_digest IS NOT NULL
          AND binding_snapshot_digest IS NOT NULL
          AND control_digest IS NOT NULL
          AND workflow_logical_call_id IS NOT NULL)
        ` : ''}
      )
    );

    CREATE INDEX idx_accepted_turn_call_authority_state
      ON accepted_turn_call_authorities(authority_kind, state, opened_at);

    CREATE INDEX idx_accepted_workflow_call_authority_occurrence
      ON accepted_turn_call_authorities(
        workflow_id, workflow_revision, run_occurrence_id,
        workflow_node_id, workflow_node_attempt
      ) WHERE authority_kind = 'workflow_v1_read_only';

    ${includePaginated ? `
    CREATE INDEX idx_accepted_paginated_workflow_call_authority_occurrence
      ON accepted_turn_call_authorities(
        workflow_id, workflow_revision, run_occurrence_id,
        workflow_node_id, workflow_node_attempt
      ) WHERE authority_kind = 'workflow_v2_paginated_read';
    ` : ''}

    ${includeWorkflowV3 ? `
    CREATE INDEX idx_accepted_workflow_v3_call_authority_occurrence
      ON accepted_turn_call_authorities(
        workflow_id, workflow_revision, run_occurrence_id,
        workflow_node_id, workflow_node_attempt
      ) WHERE authority_kind = 'workflow_v3_call';
    ` : ''}

    CREATE TRIGGER trg_accepted_turn_call_authority_source_exact
    BEFORE INSERT ON accepted_turn_call_authorities
    WHEN NEW.authority_kind NOT IN ('workflow_v1_read_only'
      ${includePaginated ? ",'workflow_v2_paginated_read'" : ''}
      ${includeWorkflowV3 ? ",'workflow_v3_call'" : ''}) AND NOT EXISTS (
      SELECT 1 FROM events e
       WHERE e.id = NEW.source_event_id
         AND e.seq = NEW.source_user_seq
         AND e.session_id = NEW.session_id
         AND e.turn = NEW.source_turn
         AND e.role = 'user'
         AND e.type = 'user_input_received'
    )
    BEGIN
      SELECT RAISE(ABORT, 'accepted-turn call authority requires its exact user source event');
    END;

    CREATE TRIGGER trg_accepted_workflow_call_authority_source_exact
    BEFORE INSERT ON accepted_turn_call_authorities
    WHEN NEW.authority_kind = 'workflow_v1_read_only' AND NOT EXISTS (
      SELECT 1 FROM workflow_node_invocation_activations w
       WHERE w.activation_id = NEW.workflow_activation_id
         AND w.activation_digest = NEW.workflow_activation_digest
         AND w.authority_root_id = NEW.accepted_task_id
         AND w.session_id = NEW.session_id
         AND w.source_event_seq = NEW.source_user_seq
         AND w.source_event_id = NEW.source_event_id
         AND w.source_event_digest = NEW.source_event_digest
         AND w.workflow_id = NEW.workflow_id
         AND w.workflow_revision = NEW.workflow_revision
         AND w.workflow_digest = NEW.workflow_digest
         AND w.run_id = NEW.run_id
         AND w.run_occurrence_id = NEW.run_occurrence_id
         AND w.node_id = NEW.workflow_node_id
         AND w.node_attempt = NEW.workflow_node_attempt
         AND w.invocation_plan_digest = NEW.invocation_plan_digest
         AND w.binding_snapshot_digest = NEW.binding_snapshot_digest
         AND w.control_digest = NEW.control_digest
         AND w.logical_call_id = NEW.workflow_logical_call_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'workflow call authority requires its exact durable activation');
    END;

    ${includePaginated ? `
    CREATE TRIGGER trg_accepted_paginated_workflow_call_authority_source_exact
    BEFORE INSERT ON accepted_turn_call_authorities
    WHEN NEW.authority_kind = 'workflow_v2_paginated_read' AND NOT EXISTS (
      SELECT 1 FROM workflow_paginated_read_activations w
       WHERE w.authority_root_id = NEW.accepted_task_id
         AND w.activation_digest = NEW.workflow_activation_digest
         AND w.session_id = NEW.session_id
         AND w.source_event_seq = NEW.source_user_seq
         AND w.source_event_id = NEW.source_event_id
         AND w.source_event_digest = NEW.source_event_digest
         AND w.workflow_id = NEW.workflow_id
         AND w.workflow_revision = NEW.workflow_revision
         AND w.workflow_digest = NEW.workflow_digest
         AND w.run_id = NEW.run_id
         AND w.run_occurrence_id = NEW.run_occurrence_id
         AND w.node_id = NEW.workflow_node_id
         AND w.node_attempt = NEW.workflow_node_attempt
         AND w.invocation_plan_digest = NEW.invocation_plan_digest
         AND w.binding_snapshot_digest = NEW.binding_snapshot_digest
         AND w.control_digest = NEW.control_digest
         AND w.max_pages = NEW.max_logical_calls
    )
    BEGIN
      SELECT RAISE(ABORT, 'paginated workflow call authority requires its exact durable activation');
    END;
    ` : ''}

    ${includeWorkflowV3 ? `
    CREATE TRIGGER trg_accepted_workflow_v3_call_authority_source_exact
    BEFORE INSERT ON accepted_turn_call_authorities
    WHEN NEW.authority_kind = 'workflow_v3_call' AND NOT EXISTS (
      SELECT 1
        FROM workflow_node_invocation_activations w
        JOIN workflow_v3_call_activation_bindings b
          ON b.activation_id = w.activation_id
       WHERE w.activation_id = NEW.workflow_activation_id
         AND w.activation_digest = NEW.workflow_activation_digest
         AND w.authority_root_id = NEW.accepted_task_id
         AND w.session_id = NEW.session_id
         AND w.source_event_seq = NEW.source_user_seq
         AND w.source_event_id = NEW.source_event_id
         AND w.source_event_digest = NEW.source_event_digest
         AND w.workflow_id = NEW.workflow_id
         AND w.workflow_revision = NEW.workflow_revision
         AND w.workflow_digest = NEW.workflow_digest
         AND w.run_id = NEW.run_id
         AND w.run_occurrence_id = NEW.run_occurrence_id
         AND w.node_id = NEW.workflow_node_id
         AND w.node_attempt = NEW.workflow_node_attempt
         AND w.invocation_plan_digest = NEW.invocation_plan_digest
         AND w.binding_snapshot_digest = NEW.binding_snapshot_digest
         AND w.control_digest = NEW.control_digest
         AND w.logical_call_id = NEW.workflow_logical_call_id
         AND b.session_id = NEW.session_id
         AND b.authority_binding_digest = NEW.binding_revision_digest
         AND b.effect = NEW.effect_ceiling
    )
    BEGIN
      SELECT RAISE(ABORT, 'workflow v3 call authority requires its exact durable activation binding');
    END;
    ` : ''}

    CREATE TRIGGER trg_accepted_turn_call_authority_graph_exact
    BEFORE INSERT ON accepted_turn_call_authorities
    WHEN NEW.authority_kind = 'turn_graph' AND NOT EXISTS (
      SELECT 1 FROM accepted_task_resolutions r
       WHERE r.session_id = NEW.session_id
         AND r.source_user_seq = NEW.source_user_seq
         AND r.accepted_task_id = NEW.accepted_task_id
         AND r.graph_event_id = NEW.graph_event_id
         AND r.graph_hash = NEW.graph_hash
         AND r.compiler_version = NEW.engine_version
         AND r.effect_ceiling = NEW.effect_ceiling
    )
    BEGIN
      SELECT RAISE(ABORT, 'graph call authority requires its exact graph resolution');
    END;

    CREATE TRIGGER trg_accepted_turn_call_authority_host_graphless
    BEFORE INSERT ON accepted_turn_call_authorities
    WHEN NEW.authority_kind != 'turn_graph' AND EXISTS (
      SELECT 1 FROM accepted_task_resolutions r
       WHERE r.session_id = NEW.session_id
         AND r.source_user_seq = NEW.source_user_seq
    )
    BEGIN
      SELECT RAISE(ABORT, 'non-graph call authority cannot replace graph resolution authority');
    END;

    CREATE TRIGGER trg_accepted_turn_call_authority_identity_immutable
    BEFORE UPDATE ON accepted_turn_call_authorities
    WHEN OLD.session_id IS NOT NEW.session_id
      OR OLD.source_user_seq IS NOT NEW.source_user_seq
      OR OLD.accepted_task_id IS NOT NEW.accepted_task_id
      OR OLD.authority_protocol IS NOT NEW.authority_protocol
      OR OLD.authority_kind IS NOT NEW.authority_kind
      OR OLD.source_event_id IS NOT NEW.source_event_id
      OR OLD.source_event_digest IS NOT NEW.source_event_digest
      OR OLD.source_turn IS NOT NEW.source_turn
      OR OLD.engine_version IS NOT NEW.engine_version
      OR OLD.surface_version IS NOT NEW.surface_version
      OR OLD.surface_digest IS NOT NEW.surface_digest
      OR OLD.effect_ceiling IS NOT NEW.effect_ceiling
      OR OLD.effect_bounds_json IS NOT NEW.effect_bounds_json
      OR OLD.max_logical_calls IS NOT NEW.max_logical_calls
      OR OLD.max_parallel_calls IS NOT NEW.max_parallel_calls
      OR OLD.catalog_revision_digest IS NOT NEW.catalog_revision_digest
      OR OLD.binding_revision_digest IS NOT NEW.binding_revision_digest
      OR OLD.graph_event_id IS NOT NEW.graph_event_id
      OR OLD.graph_hash IS NOT NEW.graph_hash
      OR OLD.workflow_activation_id IS NOT NEW.workflow_activation_id
      OR OLD.workflow_activation_digest IS NOT NEW.workflow_activation_digest
      OR OLD.workflow_id IS NOT NEW.workflow_id
      OR OLD.workflow_revision IS NOT NEW.workflow_revision
      OR OLD.workflow_digest IS NOT NEW.workflow_digest
      OR OLD.run_id IS NOT NEW.run_id
      OR OLD.run_occurrence_id IS NOT NEW.run_occurrence_id
      OR OLD.workflow_node_id IS NOT NEW.workflow_node_id
      OR OLD.workflow_node_attempt IS NOT NEW.workflow_node_attempt
      OR OLD.invocation_plan_digest IS NOT NEW.invocation_plan_digest
      OR OLD.binding_snapshot_digest IS NOT NEW.binding_snapshot_digest
      OR OLD.control_digest IS NOT NEW.control_digest
      OR OLD.workflow_logical_call_id IS NOT NEW.workflow_logical_call_id
      OR OLD.authority_digest IS NOT NEW.authority_digest
      OR OLD.opened_at IS NOT NEW.opened_at
    BEGIN
      SELECT RAISE(ABORT, 'accepted-turn call authority identity is immutable');
    END;

    CREATE TRIGGER trg_accepted_turn_call_authority_state_machine
    BEFORE UPDATE OF state, revision, closed_at, close_reason
    ON accepted_turn_call_authorities
    WHEN NOT (
      NEW.revision = OLD.revision + 1
      AND (
        (OLD.state = 'open' AND NEW.state IN ('closed','conflict'))
        OR (OLD.state = 'closed' AND NEW.state = 'conflict')
      )
      AND NEW.closed_at IS NOT NULL
      AND NEW.close_reason IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid accepted-turn call authority transition');
    END;
  `);
}

function createWorkflowNodeInvocationActivationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_node_invocation_activations (
      activation_id            TEXT PRIMARY KEY CHECK (length(activation_id) BETWEEN 1 AND 512),
      authority_root_id        TEXT NOT NULL UNIQUE CHECK (length(authority_root_id) BETWEEN 1 AND 512),
      session_id               TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      source_event_seq         INTEGER NOT NULL CHECK (source_event_seq > 0),
      source_event_id          TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
      source_event_digest      TEXT NOT NULL CHECK (length(source_event_digest) = 64),
      workflow_id              TEXT NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 256),
      workflow_revision        INTEGER NOT NULL CHECK (workflow_revision > 0),
      workflow_digest          TEXT NOT NULL CHECK (length(workflow_digest) = 64),
      run_id                   TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 256),
      run_occurrence_id        TEXT NOT NULL CHECK (length(run_occurrence_id) BETWEEN 1 AND 256),
      node_id                  TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
      node_attempt             INTEGER NOT NULL CHECK (node_attempt > 0),
      invocation_plan_digest  TEXT NOT NULL CHECK (length(invocation_plan_digest) = 64),
      binding_snapshot_digest TEXT NOT NULL CHECK (length(binding_snapshot_digest) = 64),
      control_digest          TEXT NOT NULL CHECK (length(control_digest) = 64),
      logical_call_id         TEXT NOT NULL CHECK (length(logical_call_id) BETWEEN 1 AND 512),
      one_shot_authorization_approval_id TEXT
                                REFERENCES pending_approvals(approval_id) ON DELETE RESTRICT,
      one_shot_authorization_resume_key TEXT,
      one_shot_authorization_decision_digest TEXT
                                CHECK (one_shot_authorization_decision_digest IS NULL
                                  OR length(one_shot_authorization_decision_digest) = 64),
      activation_digest       TEXT NOT NULL UNIQUE CHECK (length(activation_digest) = 64),
      activated_at            TEXT NOT NULL,
      UNIQUE (session_id, source_event_seq),
      CHECK (
        (one_shot_authorization_approval_id IS NULL
          AND one_shot_authorization_resume_key IS NULL
          AND one_shot_authorization_decision_digest IS NULL)
        OR
        (one_shot_authorization_approval_id IS NOT NULL
          AND length(one_shot_authorization_approval_id) BETWEEN 1 AND 128
          AND one_shot_authorization_resume_key IS NOT NULL
          AND length(one_shot_authorization_resume_key) BETWEEN 1 AND 1024
          AND one_shot_authorization_decision_digest IS NOT NULL)
      ),
      UNIQUE (
        workflow_id, workflow_revision, run_id, run_occurrence_id,
        node_id, node_attempt
      )
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_node_invocation_activation_run
      ON workflow_node_invocation_activations(
        workflow_id, workflow_revision, run_occurrence_id, node_id, node_attempt
      );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_node_invocation_activation_one_shot_authorization
      ON workflow_node_invocation_activations(one_shot_authorization_approval_id)
      WHERE one_shot_authorization_approval_id IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_node_invocation_activation_source_exact
    BEFORE INSERT ON workflow_node_invocation_activations
    WHEN NOT EXISTS (
      SELECT 1 FROM events e
       WHERE e.id = NEW.source_event_id
         AND e.session_id = NEW.session_id
         AND e.seq = NEW.source_event_seq
         AND e.turn = 0
         AND e.role = 'system'
         AND e.type = 'workflow_node_invocation_activated'
         AND e.created_at = NEW.activated_at
         AND json_valid(e.data_json)
         AND json_extract(e.data_json, '$.protocolVersion') = 1
         AND json_extract(e.data_json, '$.activationId') = NEW.activation_id
         AND json_extract(e.data_json, '$.authorityRootId') = NEW.authority_root_id
         AND json_extract(e.data_json, '$.activationDigest') = NEW.activation_digest
         AND json_extract(e.data_json, '$.workflowId') = NEW.workflow_id
         AND json_extract(e.data_json, '$.workflowRevision') = NEW.workflow_revision
         AND json_extract(e.data_json, '$.workflowDigest') = NEW.workflow_digest
         AND json_extract(e.data_json, '$.runId') = NEW.run_id
         AND json_extract(e.data_json, '$.runOccurrenceId') = NEW.run_occurrence_id
         AND json_extract(e.data_json, '$.nodeId') = NEW.node_id
         AND json_extract(e.data_json, '$.nodeAttempt') = NEW.node_attempt
         AND json_extract(e.data_json, '$.invocationPlanDigest') = NEW.invocation_plan_digest
         AND json_extract(e.data_json, '$.bindingSnapshotDigest') = NEW.binding_snapshot_digest
         AND json_extract(e.data_json, '$.controlDigest') = NEW.control_digest
         AND json_extract(e.data_json, '$.logicalCallId') = NEW.logical_call_id
         AND (
           (NEW.one_shot_authorization_approval_id IS NULL
             AND json_type(e.data_json, '$.oneShotActivationAuthorization') IS NULL
             AND (SELECT COUNT(*) FROM json_each(e.data_json)) = 15)
           OR
           (NEW.one_shot_authorization_approval_id IS NOT NULL
             AND json_type(e.data_json, '$.oneShotActivationAuthorization') = 'object'
             AND json_extract(e.data_json, '$.oneShotActivationAuthorization.approvalId')
                   = NEW.one_shot_authorization_approval_id
             AND json_extract(e.data_json, '$.oneShotActivationAuthorization.resumeKey')
                   = NEW.one_shot_authorization_resume_key
             AND json_extract(e.data_json, '$.oneShotActivationAuthorization.decisionDigest')
                   = NEW.one_shot_authorization_decision_digest
             AND (SELECT COUNT(*)
                    FROM json_each(e.data_json, '$.oneShotActivationAuthorization')) = 3
             AND (SELECT COUNT(*) FROM json_each(e.data_json)) = 16)
         )
    )
    BEGIN
      SELECT RAISE(ABORT, 'workflow activation requires its exact system event');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_node_invocation_activation_authorization_exact
    BEFORE INSERT ON workflow_node_invocation_activations
    WHEN NEW.one_shot_authorization_approval_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pending_approvals p
       WHERE p.approval_id = NEW.one_shot_authorization_approval_id
         AND p.resume_key = NEW.one_shot_authorization_resume_key
         AND p.status = 'resolved'
         AND p.resolution = 'approved'
         AND p.consumed_at IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'workflow activation requires its exact consumed one-shot authorization');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_node_invocation_activation_immutable
    BEFORE UPDATE ON workflow_node_invocation_activations
    BEGIN
      SELECT RAISE(ABORT, 'workflow node invocation activation is immutable');
    END;
  `);
}

function createWorkflowPaginatedReadSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_paginated_read_activations (
      activation_id            TEXT PRIMARY KEY CHECK (length(activation_id) BETWEEN 1 AND 512),
      authority_root_id        TEXT NOT NULL UNIQUE CHECK (length(authority_root_id) BETWEEN 1 AND 512),
      session_id               TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      source_event_seq         INTEGER NOT NULL CHECK (source_event_seq > 0),
      source_event_id          TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
      source_event_digest      TEXT NOT NULL CHECK (length(source_event_digest) = 64),
      workflow_id              TEXT NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 256),
      workflow_revision        INTEGER NOT NULL CHECK (workflow_revision > 0),
      workflow_digest          TEXT NOT NULL CHECK (length(workflow_digest) = 64),
      run_id                   TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 256),
      run_occurrence_id        TEXT NOT NULL CHECK (length(run_occurrence_id) BETWEEN 1 AND 256),
      node_id                  TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
      node_attempt             INTEGER NOT NULL CHECK (node_attempt > 0),
      invocation_plan_digest  TEXT NOT NULL CHECK (length(invocation_plan_digest) = 64),
      binding_snapshot_digest TEXT NOT NULL CHECK (length(binding_snapshot_digest) = 64),
      control_digest          TEXT NOT NULL CHECK (length(control_digest) = 64),
      max_pages               INTEGER NOT NULL CHECK (max_pages BETWEEN 1 AND 10000),
      cursor_argument         TEXT NOT NULL CHECK (length(cursor_argument) BETWEEN 1 AND 128),
      next_cursor_path        TEXT NOT NULL CHECK (length(next_cursor_path) BETWEEN 1 AND 512),
      exhausted_path          TEXT NOT NULL CHECK (length(exhausted_path) BETWEEN 1 AND 512),
      one_shot_authorization_approval_id TEXT
                                REFERENCES pending_approvals(approval_id) ON DELETE RESTRICT,
      one_shot_authorization_resume_key TEXT,
      one_shot_authorization_decision_digest TEXT
                                CHECK (one_shot_authorization_decision_digest IS NULL
                                  OR length(one_shot_authorization_decision_digest) = 64),
      activation_digest       TEXT NOT NULL UNIQUE CHECK (length(activation_digest) = 64),
      aggregate_state         TEXT NOT NULL DEFAULT 'open'
                                CHECK (aggregate_state IN (
                                  'open','complete','partial','failed','cancelled','conflict'
                                )),
      next_page_ordinal       INTEGER NOT NULL DEFAULT 0
                                CHECK (next_page_ordinal BETWEEN 0 AND 10000),
      latest_page_receipt_digest TEXT
                                CHECK (latest_page_receipt_digest IS NULL
                                  OR length(latest_page_receipt_digest) = 64),
      terminal_aggregate_receipt_id TEXT UNIQUE,
      terminal_aggregate_receipt_digest TEXT
                                CHECK (terminal_aggregate_receipt_digest IS NULL
                                  OR length(terminal_aggregate_receipt_digest) = 64),
      activated_at            TEXT NOT NULL,
      closed_at               TEXT,
      close_reason            TEXT CHECK (close_reason IS NULL OR length(close_reason) BETWEEN 1 AND 160),
      UNIQUE (session_id, source_event_seq),
      UNIQUE (
        workflow_id, workflow_revision, run_id, run_occurrence_id,
        node_id, node_attempt
      ),
      CHECK (
        (one_shot_authorization_approval_id IS NULL
          AND one_shot_authorization_resume_key IS NULL
          AND one_shot_authorization_decision_digest IS NULL)
        OR
        (one_shot_authorization_approval_id IS NOT NULL
          AND length(one_shot_authorization_approval_id) BETWEEN 1 AND 128
          AND one_shot_authorization_resume_key IS NOT NULL
          AND length(one_shot_authorization_resume_key) BETWEEN 1 AND 1024
          AND one_shot_authorization_decision_digest IS NOT NULL)
      ),
      CHECK (
        (aggregate_state = 'open'
          AND terminal_aggregate_receipt_id IS NULL
          AND terminal_aggregate_receipt_digest IS NULL
          AND closed_at IS NULL AND close_reason IS NULL)
        OR
        (aggregate_state != 'open'
          AND terminal_aggregate_receipt_id IS NOT NULL
          AND terminal_aggregate_receipt_digest IS NOT NULL
          AND closed_at IS NOT NULL AND close_reason IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_paginated_read_activation_run
      ON workflow_paginated_read_activations(
        workflow_id, workflow_revision, run_occurrence_id, node_id, node_attempt
      );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_paginated_read_one_shot_authorization
      ON workflow_paginated_read_activations(one_shot_authorization_approval_id)
      WHERE one_shot_authorization_approval_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS workflow_paginated_read_pages (
      activation_id            TEXT NOT NULL
                                REFERENCES workflow_paginated_read_activations(activation_id)
                                ON DELETE CASCADE,
      page_ordinal             INTEGER NOT NULL CHECK (page_ordinal BETWEEN 0 AND 9999),
      prior_page_receipt_digest TEXT
                                CHECK (prior_page_receipt_digest IS NULL
                                  OR length(prior_page_receipt_digest) = 64),
      input_cursor_digest      TEXT
                                CHECK (input_cursor_digest IS NULL OR length(input_cursor_digest) = 64),
      binding_identity_digest TEXT NOT NULL CHECK (length(binding_identity_digest) = 64),
      argument_digest          TEXT NOT NULL CHECK (length(argument_digest) = 64),
      logical_call_id          TEXT NOT NULL CHECK (length(logical_call_id) BETWEEN 1 AND 512),
      physical_dispatch_id     TEXT NOT NULL CHECK (length(physical_dispatch_id) BETWEEN 1 AND 512),
      state                    TEXT NOT NULL DEFAULT 'reserved'
                                CHECK (state IN (
                                  'reserved','settled','failed','uncertain','cancelled','conflict'
                                )),
      page_receipt_id          TEXT UNIQUE,
      page_receipt_digest      TEXT UNIQUE
                                CHECK (page_receipt_digest IS NULL OR length(page_receipt_digest) = 64),
      result_handle_id         TEXT REFERENCES durable_result_handles(handle_id) ON DELETE RESTRICT,
      settled_result_digest    TEXT
                                CHECK (settled_result_digest IS NULL OR length(settled_result_digest) = 64),
      next_cursor_digest       TEXT
                                CHECK (next_cursor_digest IS NULL OR length(next_cursor_digest) = 64),
      provider_exhausted_truth TEXT CHECK (provider_exhausted_truth IN ('true','false','unknown')),
      item_count               INTEGER CHECK (item_count IS NULL OR item_count BETWEEN 0 AND 2147483647),
      evidence_digest          TEXT CHECK (evidence_digest IS NULL OR length(evidence_digest) = 64),
      evidence_valid           INTEGER CHECK (evidence_valid IN (0,1)),
      continuation_state       TEXT CHECK (continuation_state IN (
                                  'exhausted','continue','missing_cursor','repeated_cursor',
                                  'unknown_exhaustion','malformed_evidence'
                                )),
      reserved_at              TEXT NOT NULL,
      settled_at               TEXT,
      PRIMARY KEY (activation_id, page_ordinal),
      UNIQUE (activation_id, logical_call_id),
      UNIQUE (activation_id, physical_dispatch_id),
      CHECK (
        (page_ordinal = 0
          AND prior_page_receipt_digest IS NULL AND input_cursor_digest IS NULL)
        OR
        (page_ordinal > 0
          AND prior_page_receipt_digest IS NOT NULL AND input_cursor_digest IS NOT NULL)
      ),
      CHECK (
        (state = 'reserved'
          AND page_receipt_id IS NULL AND page_receipt_digest IS NULL
          AND result_handle_id IS NULL AND settled_result_digest IS NULL
          AND provider_exhausted_truth IS NULL AND item_count IS NULL
          AND evidence_digest IS NULL AND evidence_valid IS NULL
          AND continuation_state IS NULL AND settled_at IS NULL)
        OR
        (state = 'settled'
          AND page_receipt_id IS NOT NULL AND page_receipt_digest IS NOT NULL
          AND result_handle_id IS NOT NULL AND settled_result_digest IS NOT NULL
          AND provider_exhausted_truth IS NOT NULL AND item_count IS NOT NULL
          AND evidence_digest IS NOT NULL AND evidence_valid IS NOT NULL
          AND continuation_state IS NOT NULL AND settled_at IS NOT NULL)
        OR state IN ('failed','uncertain','cancelled','conflict')
      )
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_paginated_read_page_state
      ON workflow_paginated_read_pages(activation_id, state, page_ordinal);

    CREATE TABLE IF NOT EXISTS workflow_paginated_cursor_visits (
      activation_id       TEXT NOT NULL,
      cursor_digest       TEXT NOT NULL CHECK (length(cursor_digest) = 64),
      first_page_ordinal  INTEGER NOT NULL CHECK (first_page_ordinal BETWEEN 1 AND 9999),
      visited_at          TEXT NOT NULL,
      PRIMARY KEY (activation_id, cursor_digest),
      UNIQUE (activation_id, first_page_ordinal),
      FOREIGN KEY (activation_id, first_page_ordinal)
        REFERENCES workflow_paginated_read_pages(activation_id, page_ordinal)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workflow_paginated_aggregate_receipts (
      aggregate_receipt_id       TEXT PRIMARY KEY CHECK (length(aggregate_receipt_id) BETWEEN 1 AND 512),
      activation_id              TEXT NOT NULL UNIQUE
                                   REFERENCES workflow_paginated_read_activations(activation_id)
                                   ON DELETE RESTRICT,
      activation_digest          TEXT NOT NULL CHECK (length(activation_digest) = 64),
      authority_root_id          TEXT NOT NULL CHECK (length(authority_root_id) BETWEEN 1 AND 512),
      invocation_plan_digest     TEXT NOT NULL CHECK (length(invocation_plan_digest) = 64),
      binding_snapshot_digest    TEXT NOT NULL CHECK (length(binding_snapshot_digest) = 64),
      control_digest             TEXT NOT NULL CHECK (length(control_digest) = 64),
      page_receipt_digests_json  TEXT NOT NULL
                                   CHECK (json_valid(page_receipt_digests_json)
                                     AND json_type(page_receipt_digests_json) = 'array'),
      page_result_handles_json   TEXT NOT NULL
                                   CHECK (json_valid(page_result_handles_json)
                                     AND json_type(page_result_handles_json) = 'array'),
      page_count                 INTEGER NOT NULL CHECK (page_count BETWEEN 0 AND 10000),
      total_item_count           INTEGER NOT NULL CHECK (total_item_count >= 0),
      final_exhausted_truth      TEXT NOT NULL
                                   CHECK (final_exhausted_truth IN ('true','false','unknown','none')),
      coverage_state             TEXT NOT NULL CHECK (coverage_state IN ('complete','partial','unknown')),
      outcome                    TEXT NOT NULL
                                   CHECK (outcome IN ('complete','partial','failed','cancelled','conflict')),
      reason                     TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 160),
      aggregate_receipt_digest   TEXT NOT NULL UNIQUE CHECK (length(aggregate_receipt_digest) = 64),
      created_at                 TEXT NOT NULL,
      CHECK (
        outcome != 'complete'
        OR (coverage_state = 'complete' AND final_exhausted_truth = 'true' AND page_count > 0)
      )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_paginated_read_activation_source_exact
    BEFORE INSERT ON workflow_paginated_read_activations
    WHEN NOT EXISTS (
      SELECT 1 FROM events e
       WHERE e.id = NEW.source_event_id
         AND e.session_id = NEW.session_id
         AND e.seq = NEW.source_event_seq
         AND e.turn = 0
         AND e.role = 'system'
         AND e.type = 'workflow_paginated_read_activated'
         AND e.created_at = NEW.activated_at
         AND json_valid(e.data_json)
         AND json_extract(e.data_json, '$.protocolVersion') = 1
         AND json_extract(e.data_json, '$.activationId') = NEW.activation_id
         AND json_extract(e.data_json, '$.authorityRootId') = NEW.authority_root_id
         AND json_extract(e.data_json, '$.activationDigest') = NEW.activation_digest
         AND json_extract(e.data_json, '$.workflowId') = NEW.workflow_id
         AND json_extract(e.data_json, '$.workflowRevision') = NEW.workflow_revision
         AND json_extract(e.data_json, '$.workflowDigest') = NEW.workflow_digest
         AND json_extract(e.data_json, '$.runId') = NEW.run_id
         AND json_extract(e.data_json, '$.runOccurrenceId') = NEW.run_occurrence_id
         AND json_extract(e.data_json, '$.nodeId') = NEW.node_id
         AND json_extract(e.data_json, '$.nodeAttempt') = NEW.node_attempt
         AND json_extract(e.data_json, '$.invocationPlanDigest') = NEW.invocation_plan_digest
         AND json_extract(e.data_json, '$.bindingSnapshotDigest') = NEW.binding_snapshot_digest
         AND json_extract(e.data_json, '$.controlDigest') = NEW.control_digest
         AND json_extract(e.data_json, '$.maxPages') = NEW.max_pages
         AND json_extract(e.data_json, '$.cursorArgument') = NEW.cursor_argument
         AND json_extract(e.data_json, '$.nextCursorPath') = NEW.next_cursor_path
         AND json_extract(e.data_json, '$.exhaustedPath') = NEW.exhausted_path
         AND (
           (NEW.one_shot_authorization_approval_id IS NULL
             AND json_type(e.data_json, '$.oneShotActivationAuthorization') IS NULL
             AND (SELECT COUNT(*) FROM json_each(e.data_json)) = 18)
           OR
           (NEW.one_shot_authorization_approval_id IS NOT NULL
             AND json_type(e.data_json, '$.oneShotActivationAuthorization') = 'object'
             AND json_extract(e.data_json, '$.oneShotActivationAuthorization.approvalId')
                   = NEW.one_shot_authorization_approval_id
             AND json_extract(e.data_json, '$.oneShotActivationAuthorization.resumeKey')
                   = NEW.one_shot_authorization_resume_key
             AND json_extract(e.data_json, '$.oneShotActivationAuthorization.decisionDigest')
                   = NEW.one_shot_authorization_decision_digest
             AND (SELECT COUNT(*)
                    FROM json_each(e.data_json, '$.oneShotActivationAuthorization')) = 3
             AND (SELECT COUNT(*) FROM json_each(e.data_json)) = 19)
         )
    )
    BEGIN
      SELECT RAISE(ABORT, 'paginated workflow activation requires its exact system event');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_paginated_read_activation_authorization_exact
    BEFORE INSERT ON workflow_paginated_read_activations
    WHEN NEW.one_shot_authorization_approval_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pending_approvals p
       WHERE p.approval_id = NEW.one_shot_authorization_approval_id
         AND p.resume_key = NEW.one_shot_authorization_resume_key
         AND p.status = 'resolved'
         AND p.resolution = 'approved'
         AND p.consumed_at IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'paginated workflow activation requires its exact consumed one-shot authorization');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_paginated_read_excludes_single_call_activation
    BEFORE INSERT ON workflow_paginated_read_activations
    WHEN EXISTS (
      SELECT 1 FROM workflow_node_invocation_activations w
       WHERE w.workflow_id = NEW.workflow_id
         AND w.workflow_revision = NEW.workflow_revision
         AND w.run_id = NEW.run_id
         AND w.run_occurrence_id = NEW.run_occurrence_id
         AND w.node_id = NEW.node_id
         AND w.node_attempt = NEW.node_attempt
    )
    BEGIN
      SELECT RAISE(ABORT, 'workflow node attempt already has a single-call activation');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_node_invocation_excludes_paginated_activation
    BEFORE INSERT ON workflow_node_invocation_activations
    WHEN EXISTS (
      SELECT 1 FROM workflow_paginated_read_activations w
       WHERE w.workflow_id = NEW.workflow_id
         AND w.workflow_revision = NEW.workflow_revision
         AND w.run_id = NEW.run_id
         AND w.run_occurrence_id = NEW.run_occurrence_id
         AND w.node_id = NEW.node_id
         AND w.node_attempt = NEW.node_attempt
    )
    BEGIN
      SELECT RAISE(ABORT, 'workflow node attempt already has a paginated activation');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_paginated_read_activation_identity_immutable
    BEFORE UPDATE ON workflow_paginated_read_activations
    WHEN OLD.activation_id IS NOT NEW.activation_id
      OR OLD.authority_root_id IS NOT NEW.authority_root_id
      OR OLD.session_id IS NOT NEW.session_id
      OR OLD.source_event_seq IS NOT NEW.source_event_seq
      OR OLD.source_event_id IS NOT NEW.source_event_id
      OR OLD.source_event_digest IS NOT NEW.source_event_digest
      OR OLD.workflow_id IS NOT NEW.workflow_id
      OR OLD.workflow_revision IS NOT NEW.workflow_revision
      OR OLD.workflow_digest IS NOT NEW.workflow_digest
      OR OLD.run_id IS NOT NEW.run_id
      OR OLD.run_occurrence_id IS NOT NEW.run_occurrence_id
      OR OLD.node_id IS NOT NEW.node_id
      OR OLD.node_attempt IS NOT NEW.node_attempt
      OR OLD.invocation_plan_digest IS NOT NEW.invocation_plan_digest
      OR OLD.binding_snapshot_digest IS NOT NEW.binding_snapshot_digest
      OR OLD.control_digest IS NOT NEW.control_digest
      OR OLD.max_pages IS NOT NEW.max_pages
      OR OLD.cursor_argument IS NOT NEW.cursor_argument
      OR OLD.next_cursor_path IS NOT NEW.next_cursor_path
      OR OLD.exhausted_path IS NOT NEW.exhausted_path
      OR OLD.one_shot_authorization_approval_id IS NOT NEW.one_shot_authorization_approval_id
      OR OLD.one_shot_authorization_resume_key IS NOT NEW.one_shot_authorization_resume_key
      OR OLD.one_shot_authorization_decision_digest IS NOT NEW.one_shot_authorization_decision_digest
      OR OLD.activation_digest IS NOT NEW.activation_digest
      OR OLD.activated_at IS NOT NEW.activated_at
    BEGIN
      SELECT RAISE(ABORT, 'paginated workflow activation identity is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_paginated_read_activation_progress_monotonic
    BEFORE UPDATE ON workflow_paginated_read_activations
    WHEN NOT (
      (OLD.aggregate_state = 'open' AND NEW.aggregate_state = 'open'
        AND NEW.next_page_ordinal IN (OLD.next_page_ordinal, OLD.next_page_ordinal + 1)
        AND NEW.terminal_aggregate_receipt_id IS NULL
        AND NEW.terminal_aggregate_receipt_digest IS NULL
        AND NEW.closed_at IS NULL AND NEW.close_reason IS NULL)
      OR
      (OLD.aggregate_state = 'open' AND NEW.aggregate_state != 'open'
        AND NEW.next_page_ordinal = OLD.next_page_ordinal
        AND NEW.terminal_aggregate_receipt_id IS NOT NULL
        AND NEW.terminal_aggregate_receipt_digest IS NOT NULL
        AND NEW.closed_at IS NOT NULL AND NEW.close_reason IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM workflow_paginated_aggregate_receipts r
           WHERE r.aggregate_receipt_id = NEW.terminal_aggregate_receipt_id
             AND r.activation_id = NEW.activation_id
             AND r.aggregate_receipt_digest = NEW.terminal_aggregate_receipt_digest
        ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'paginated workflow activation transition is not monotonic');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_paginated_read_page_identity_immutable
    BEFORE UPDATE ON workflow_paginated_read_pages
    WHEN OLD.activation_id IS NOT NEW.activation_id
      OR OLD.page_ordinal IS NOT NEW.page_ordinal
      OR OLD.prior_page_receipt_digest IS NOT NEW.prior_page_receipt_digest
      OR OLD.input_cursor_digest IS NOT NEW.input_cursor_digest
      OR OLD.binding_identity_digest IS NOT NEW.binding_identity_digest
      OR OLD.argument_digest IS NOT NEW.argument_digest
      OR OLD.logical_call_id IS NOT NEW.logical_call_id
      OR OLD.physical_dispatch_id IS NOT NEW.physical_dispatch_id
      OR OLD.reserved_at IS NOT NEW.reserved_at
    BEGIN
      SELECT RAISE(ABORT, 'paginated workflow page identity is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_paginated_read_page_state_once
    BEFORE UPDATE ON workflow_paginated_read_pages
    WHEN OLD.state != 'reserved' OR NEW.state = 'reserved'
    BEGIN
      SELECT RAISE(ABORT, 'paginated workflow page settles once');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_paginated_aggregate_receipt_immutable
    BEFORE UPDATE ON workflow_paginated_aggregate_receipts
    BEGIN
      SELECT RAISE(ABORT, 'paginated workflow aggregate receipt is immutable');
    END;
  `);
}

function rebuildAcceptedCallAuthoritiesForWorkflow(db: Database.Database): void {
  const table = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accepted_turn_call_authorities'`,
  ).get() as { sql: string | null } | undefined;
  if (!table?.sql) throw new Error('schema v51 call-authority root is missing');
  const existingColumns = new Set((db.prepare(
    'PRAGMA table_info(accepted_turn_call_authorities)',
  ).all() as Array<{ name: string }>).map((column) => column.name));
  if (
    existingColumns.has('workflow_activation_id')
    && existingColumns.has('workflow_logical_call_id')
    && table.sql.includes("'workflow_v1_read_only'")
  ) {
    const logicalParents = new Set((db.prepare(
      'PRAGMA foreign_key_list(logical_tool_calls)',
    ).all() as Array<{ table: string; from: string }>)
      .filter((fk) => fk.from === 'session_id' || fk.from === 'source_user_seq')
      .map((fk) => fk.table));
    if (logicalParents.size !== 1 || !logicalParents.has('accepted_turn_call_authorities')) {
      throw new Error('schema v51 existing workflow root has the wrong logical-call parent');
    }
    const relevantTables = new Set([
      'workflow_node_invocation_activations',
      'accepted_turn_call_authorities',
      'logical_tool_calls',
      ...(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
        .map((row) => row.name)
        .filter((name) => (db.prepare(
          `PRAGMA foreign_key_list(${quotedSchemaIdentifier(name)})`,
        ).all() as Array<{ table: string }>).some((fk) => fk.table === 'logical_tool_calls')),
    ]);
    const violations = (db.pragma('foreign_key_check') as Array<{ table: string }>)
      .filter((violation) => relevantTables.has(violation.table));
    if (violations.length > 0) {
      throw new Error(`schema v51 existing workflow root has ${violations.length} relevant foreign-key violation(s)`);
    }
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error(`schema v51 existing workflow-root integrity failed: ${JSON.stringify(integrity).slice(0, 240)}`);
    }
    return;
  }
  const beforeRows = (db.prepare(
    'SELECT COUNT(*) AS n FROM accepted_turn_call_authorities',
  ).get() as { n: number }).n;
  const logicalRows = (db.prepare(
    'SELECT COUNT(*) AS n FROM logical_tool_calls',
  ).get() as { n: number }).n;
  const logicalFks = JSON.stringify(db.prepare('PRAGMA foreign_key_list(logical_tool_calls)').all());
  const logicalObjects = JSON.stringify(db.prepare(`
    SELECT type, name, sql FROM sqlite_master
     WHERE tbl_name = 'logical_tool_calls'
       AND type IN ('index','trigger') AND sql IS NOT NULL
     ORDER BY type, name
  `).all());
  const logicalChildTables = (db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'`,
  ).all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => (db.prepare(
      `PRAGMA foreign_key_list(${quotedSchemaIdentifier(name)})`,
    ).all() as Array<{ table: string }>).some((fk) => fk.table === 'logical_tool_calls'));
  const logicalChildren = new Map(logicalChildTables.map((name) => [name, {
    rows: (db.prepare(`SELECT COUNT(*) AS n FROM ${quotedSchemaIdentifier(name)}`).get() as { n: number }).n,
    foreignKeys: JSON.stringify(db.prepare(
      `PRAGMA foreign_key_list(${quotedSchemaIdentifier(name)})`,
    ).all()),
  }]));
  const priorLegacyRename = Number(db.pragma('legacy_alter_table', { simple: true })) === 1;
  db.pragma('legacy_alter_table = ON');
  try {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_accepted_turn_call_authority_source_exact;
      DROP TRIGGER IF EXISTS trg_accepted_turn_call_authority_graph_exact;
      DROP TRIGGER IF EXISTS trg_accepted_turn_call_authority_host_graphless;
      DROP TRIGGER IF EXISTS trg_accepted_turn_call_authority_identity_immutable;
      DROP TRIGGER IF EXISTS trg_accepted_turn_call_authority_state_machine;
      DROP INDEX IF EXISTS idx_accepted_turn_call_authority_state;
      ALTER TABLE accepted_turn_call_authorities RENAME TO accepted_turn_call_authorities_v50;
    `);
    createV51AcceptedCallAuthoritySchema(db);
    db.exec(`
      INSERT INTO accepted_turn_call_authorities (
        session_id, source_user_seq, accepted_task_id, authority_protocol,
        authority_kind, source_event_id, source_event_digest, source_turn,
        engine_version, surface_version, surface_digest, effect_ceiling,
        effect_bounds_json, max_logical_calls, max_parallel_calls,
        catalog_revision_digest, binding_revision_digest, graph_event_id,
        graph_hash, authority_digest, state, revision, opened_at, closed_at,
        close_reason
      )
      SELECT session_id, source_user_seq, accepted_task_id, authority_protocol,
             authority_kind, source_event_id, source_event_digest, source_turn,
             engine_version, surface_version, surface_digest, effect_ceiling,
             effect_bounds_json, max_logical_calls, max_parallel_calls,
             catalog_revision_digest, binding_revision_digest, graph_event_id,
             graph_hash, authority_digest, state, revision, opened_at, closed_at,
             close_reason
        FROM accepted_turn_call_authorities_v50;
      DROP TABLE accepted_turn_call_authorities_v50;
    `);
  } finally {
    db.pragma(`legacy_alter_table = ${priorLegacyRename ? 'ON' : 'OFF'}`);
  }
  const afterRows = (db.prepare(
    'SELECT COUNT(*) AS n FROM accepted_turn_call_authorities',
  ).get() as { n: number }).n;
  const afterLogicalRows = (db.prepare(
    'SELECT COUNT(*) AS n FROM logical_tool_calls',
  ).get() as { n: number }).n;
  const afterLogicalFks = JSON.stringify(db.prepare('PRAGMA foreign_key_list(logical_tool_calls)').all());
  const afterLogicalObjects = JSON.stringify(db.prepare(`
    SELECT type, name, sql FROM sqlite_master
     WHERE tbl_name = 'logical_tool_calls'
       AND type IN ('index','trigger') AND sql IS NOT NULL
     ORDER BY type, name
  `).all());
  if (
    afterRows !== beforeRows
    || afterLogicalRows !== logicalRows
    || afterLogicalFks !== logicalFks
    || afterLogicalObjects !== logicalObjects
  ) {
    throw new Error(
      `schema v51 changed authority/logical rows, foreign keys, indexes, or triggers: ${beforeRows}/${logicalRows} -> ${afterRows}/${afterLogicalRows}`,
    );
  }
  for (const [name, before] of logicalChildren) {
    const rows = (db.prepare(`SELECT COUNT(*) AS n FROM ${quotedSchemaIdentifier(name)}`).get() as { n: number }).n;
    const foreignKeys = JSON.stringify(db.prepare(
      `PRAGMA foreign_key_list(${quotedSchemaIdentifier(name)})`,
    ).all());
    if (rows !== before.rows || foreignKeys !== before.foreignKeys) {
      throw new Error(`schema v51 changed logical child rows or foreign keys for ${name}`);
    }
  }
  const violations = db.pragma('foreign_key_check') as Array<{ table: string }>;
  if (violations.length > 0) {
    throw new Error(`schema v51 foreign-key check failed for ${violations.length} row(s)`);
  }
  const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error(`schema v51 integrity check failed: ${JSON.stringify(integrity).slice(0, 240)}`);
  }
}

function rebuildAcceptedCallAuthoritiesForPagination(db: Database.Database): void {
  const table = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accepted_turn_call_authorities'`,
  ).get() as { sql: string | null } | undefined;
  if (!table?.sql) throw new Error('schema v52 call-authority root is missing');
  if (table.sql.includes("'workflow_v2_paginated_read'")) {
    const relevantTables = foreignKeyClosure(db, ['accepted_turn_call_authorities']);
    const violations = (db.pragma('foreign_key_check') as Array<{ table: string }>)
      .filter((violation) => relevantTables.has(violation.table));
    if (violations.length > 0) {
      throw new Error(`schema v52 existing paginated root has ${violations.length} relevant foreign-key violation(s)`);
    }
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error(`schema v52 existing paginated-root integrity failed: ${JSON.stringify(integrity).slice(0, 240)}`);
    }
    return;
  }

  const columns = (db.prepare(
    'PRAGMA table_info(accepted_turn_call_authorities)',
  ).all() as Array<{ name: string }>).map((column) => column.name);
  const beforeRows = (db.prepare(
    'SELECT COUNT(*) AS n FROM accepted_turn_call_authorities',
  ).get() as { n: number }).n;
  const logicalRows = (db.prepare(
    'SELECT COUNT(*) AS n FROM logical_tool_calls',
  ).get() as { n: number }).n;
  const logicalFks = JSON.stringify(db.prepare('PRAGMA foreign_key_list(logical_tool_calls)').all());
  const logicalObjects = JSON.stringify(db.prepare(`
    SELECT type, name, sql FROM sqlite_master
     WHERE tbl_name = 'logical_tool_calls'
       AND type IN ('index','trigger') AND sql IS NOT NULL
     ORDER BY type, name
  `).all());
  const rootObjects = db.prepare(`
    SELECT type, name FROM sqlite_master
     WHERE tbl_name = 'accepted_turn_call_authorities'
       AND type IN ('index','trigger') AND sql IS NOT NULL
     ORDER BY type, name
  `).all() as Array<{ type: 'index' | 'trigger'; name: string }>;
  const childTables = (db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'`,
  ).all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => (db.prepare(
      `PRAGMA foreign_key_list(${quotedSchemaIdentifier(name)})`,
    ).all() as Array<{ table: string }>).some((fk) => fk.table === 'accepted_turn_call_authorities'));
  const childSnapshot = new Map(childTables.map((name) => [name, {
    rows: (db.prepare(`SELECT COUNT(*) AS n FROM ${quotedSchemaIdentifier(name)}`).get() as { n: number }).n,
    foreignKeys: JSON.stringify(db.prepare(
      `PRAGMA foreign_key_list(${quotedSchemaIdentifier(name)})`,
    ).all()),
  }]));

  const priorLegacyRename = Number(db.pragma('legacy_alter_table', { simple: true })) === 1;
  db.pragma('legacy_alter_table = ON');
  try {
    for (const object of rootObjects) {
      db.exec(`DROP ${object.type.toUpperCase()} ${quotedSchemaIdentifier(object.name)}`);
    }
    db.exec('ALTER TABLE accepted_turn_call_authorities RENAME TO accepted_turn_call_authorities_v51');
    createV51AcceptedCallAuthoritySchema(db, true);
    const columnList = columns.map(quotedSchemaIdentifier).join(', ');
    db.exec(`INSERT INTO accepted_turn_call_authorities (${columnList})
      SELECT ${columnList} FROM accepted_turn_call_authorities_v51`);
    db.exec('DROP TABLE accepted_turn_call_authorities_v51');
  } finally {
    db.pragma(`legacy_alter_table = ${priorLegacyRename ? 'ON' : 'OFF'}`);
  }

  const afterRows = (db.prepare(
    'SELECT COUNT(*) AS n FROM accepted_turn_call_authorities',
  ).get() as { n: number }).n;
  const afterLogicalRows = (db.prepare(
    'SELECT COUNT(*) AS n FROM logical_tool_calls',
  ).get() as { n: number }).n;
  const afterLogicalFks = JSON.stringify(db.prepare('PRAGMA foreign_key_list(logical_tool_calls)').all());
  const afterLogicalObjects = JSON.stringify(db.prepare(`
    SELECT type, name, sql FROM sqlite_master
     WHERE tbl_name = 'logical_tool_calls'
       AND type IN ('index','trigger') AND sql IS NOT NULL
     ORDER BY type, name
  `).all());
  if (
    beforeRows !== afterRows
    || logicalRows !== afterLogicalRows
    || logicalFks !== afterLogicalFks
    || logicalObjects !== afterLogicalObjects
  ) {
    throw new Error(
      `schema v52 changed authority/logical rows, foreign keys, indexes, or triggers: ${beforeRows}/${logicalRows} -> ${afterRows}/${afterLogicalRows}`,
    );
  }
  for (const [name, before] of childSnapshot) {
    const rows = (db.prepare(`SELECT COUNT(*) AS n FROM ${quotedSchemaIdentifier(name)}`).get() as { n: number }).n;
    const foreignKeys = JSON.stringify(db.prepare(
      `PRAGMA foreign_key_list(${quotedSchemaIdentifier(name)})`,
    ).all());
    if (rows !== before.rows || foreignKeys !== before.foreignKeys) {
      throw new Error(`schema v52 changed authority child rows or foreign keys for ${name}`);
    }
  }
  const relevantTables = foreignKeyClosure(db, ['accepted_turn_call_authorities']);
  const violations = (db.pragma('foreign_key_check') as Array<{ table: string }>)
    .filter((violation) => relevantTables.has(violation.table));
  if (violations.length > 0) {
    throw new Error(`schema v52 foreign-key check failed for ${violations.length} authority row(s)`);
  }
  const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error(`schema v52 integrity check failed: ${JSON.stringify(integrity).slice(0, 240)}`);
  }
}

/** V54 widens only the root enum/closed CHECK for the effect-capable host.
 * Existing v53 roots and every child row stay byte-identical. The table
 * rebuild is intentionally the same legacy-rename pattern rehearsed by v52. */
function rebuildAcceptedCallAuthoritiesForProductionHost(
  db: Database.Database,
  includeWorkflowV3 = false,
): void {
  const table = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accepted_turn_call_authorities'`,
  ).get() as { sql: string | null } | undefined;
  const schemaVersion = includeWorkflowV3 ? 64 : 54;
  if (!table?.sql) throw new Error(`schema v${schemaVersion} call-authority root is missing`);
  if (table.sql.includes(includeWorkflowV3 ? "'workflow_v3_call'" : "'host_v1'")) {
    const relevantTables = foreignKeyClosure(db, ['accepted_turn_call_authorities']);
    const violations = (db.pragma('foreign_key_check') as Array<{ table: string }>)
      .filter((violation) => relevantTables.has(violation.table));
    if (violations.length > 0) {
      throw new Error(`schema v${schemaVersion} existing host root has ${violations.length} relevant foreign-key violation(s)`);
    }
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error(`schema v${schemaVersion} existing host-root integrity failed: ${JSON.stringify(integrity).slice(0, 240)}`);
    }
    return;
  }

  const columns = (db.prepare(
    'PRAGMA table_info(accepted_turn_call_authorities)',
  ).all() as Array<{ name: string }>).map((column) => column.name);
  const beforeRows = (db.prepare(
    'SELECT COUNT(*) AS n FROM accepted_turn_call_authorities',
  ).get() as { n: number }).n;
  const rootBytes = JSON.stringify(db.prepare(`
    SELECT * FROM accepted_turn_call_authorities
     ORDER BY session_id, source_user_seq
  `).all());
  const logicalRows = (db.prepare(
    'SELECT COUNT(*) AS n FROM logical_tool_calls',
  ).get() as { n: number }).n;
  const logicalFks = JSON.stringify(db.prepare('PRAGMA foreign_key_list(logical_tool_calls)').all());
  const logicalObjectNames = JSON.stringify(db.prepare(`
    SELECT type, name FROM sqlite_master
     WHERE tbl_name = 'logical_tool_calls'
       AND type IN ('index','trigger') AND sql IS NOT NULL
     ORDER BY type, name
  `).all());
  const rootObjects = db.prepare(`
    SELECT type, name FROM sqlite_master
     WHERE tbl_name = 'accepted_turn_call_authorities'
       AND type IN ('index','trigger') AND sql IS NOT NULL
     ORDER BY type, name
  `).all() as Array<{ type: 'index' | 'trigger'; name: string }>;
  const childTables = (db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'`,
  ).all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => (db.prepare(
      `PRAGMA foreign_key_list(${quotedSchemaIdentifier(name)})`,
    ).all() as Array<{ table: string }>).some((fk) => fk.table === 'accepted_turn_call_authorities'));
  const childSnapshot = new Map(childTables.map((name) => [name, {
    rows: (db.prepare(`SELECT COUNT(*) AS n FROM ${quotedSchemaIdentifier(name)}`).get() as { n: number }).n,
    foreignKeys: JSON.stringify(db.prepare(
      `PRAGMA foreign_key_list(${quotedSchemaIdentifier(name)})`,
    ).all()),
  }]));

  const priorLegacyRename = Number(db.pragma('legacy_alter_table', { simple: true })) === 1;
  db.pragma('legacy_alter_table = ON');
  try {
    for (const object of rootObjects) {
      db.exec(`DROP ${object.type.toUpperCase()} ${quotedSchemaIdentifier(object.name)}`);
    }
    const retiredName = includeWorkflowV3
      ? 'accepted_turn_call_authorities_v63'
      : 'accepted_turn_call_authorities_v53';
    db.exec(`ALTER TABLE accepted_turn_call_authorities RENAME TO ${retiredName}`);
    createV51AcceptedCallAuthoritySchema(db, true, true, includeWorkflowV3);
    const columnList = columns.map(quotedSchemaIdentifier).join(', ');
    db.exec(`INSERT INTO accepted_turn_call_authorities (${columnList})
      SELECT ${columnList} FROM ${retiredName}`);
    db.exec(`DROP TABLE ${retiredName}`);
  } finally {
    db.pragma(`legacy_alter_table = ${priorLegacyRename ? 'ON' : 'OFF'}`);
  }

  const afterRows = (db.prepare(
    'SELECT COUNT(*) AS n FROM accepted_turn_call_authorities',
  ).get() as { n: number }).n;
  const afterRootBytes = JSON.stringify(db.prepare(`
    SELECT * FROM accepted_turn_call_authorities
     ORDER BY session_id, source_user_seq
  `).all());
  const afterLogicalRows = (db.prepare(
    'SELECT COUNT(*) AS n FROM logical_tool_calls',
  ).get() as { n: number }).n;
  const afterLogicalFks = JSON.stringify(db.prepare('PRAGMA foreign_key_list(logical_tool_calls)').all());
  const afterLogicalObjectNames = JSON.stringify(db.prepare(`
    SELECT type, name FROM sqlite_master
     WHERE tbl_name = 'logical_tool_calls'
       AND type IN ('index','trigger') AND sql IS NOT NULL
     ORDER BY type, name
  `).all());
  if (
    beforeRows !== afterRows
    || rootBytes !== afterRootBytes
    || logicalRows !== afterLogicalRows
    || logicalFks !== afterLogicalFks
    || logicalObjectNames !== afterLogicalObjectNames
  ) {
    throw new Error(`schema v${schemaVersion} changed authority/logical rows, foreign keys, indexes, or triggers`);
  }
  for (const [name, before] of childSnapshot) {
    const rows = (db.prepare(`SELECT COUNT(*) AS n FROM ${quotedSchemaIdentifier(name)}`).get() as { n: number }).n;
    const foreignKeys = JSON.stringify(db.prepare(
      `PRAGMA foreign_key_list(${quotedSchemaIdentifier(name)})`,
    ).all());
    if (rows !== before.rows || foreignKeys !== before.foreignKeys) {
      throw new Error(`schema v${schemaVersion} changed authority child rows or foreign keys for ${name}`);
    }
  }
  const relevantTables = foreignKeyClosure(db, ['accepted_turn_call_authorities']);
  const violations = (db.pragma('foreign_key_check') as Array<{ table: string }>)
    .filter((violation) => relevantTables.has(violation.table));
  if (violations.length > 0) {
    throw new Error(`schema v${schemaVersion} foreign-key check failed for ${violations.length} authority row(s)`);
  }
  const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error(`schema v${schemaVersion} integrity check failed: ${JSON.stringify(integrity).slice(0, 240)}`);
  }
}

/** V55 adds one truthful system-owned cancellation outcome without rewriting
 * any historical decision. SQLite cannot widen a CHECK in place, so only the
 * canonical constrained table is rebuilt. Intentionally sparse legacy
 * rehearsal tables with an unconstrained resolution column already accept the
 * value and are left byte-for-byte alone. */
function widenPendingApprovalSystemCancellationResolution(db: Database.Database): void {
  const table = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pending_approvals'`,
  ).get() as { sql: string | null } | undefined;
  if (!table?.sql || table.sql.includes("'cancelled_by_system'")) return;

  const oldConstraint = "resolution IN ('approved','rejected','expired','cancelled_by_user')";
  if (!table.sql.includes(oldConstraint)) {
    // The v4/v3.14 rehearsal accepts arbitrary TEXT here. Do not manufacture
    // missing columns, parents, or constraints while moving it forward.
    return;
  }
  const widenedSql = table.sql.replace(
    oldConstraint,
    "resolution IN ('approved','rejected','expired','cancelled_by_user','cancelled_by_system')",
  );
  const legacyExists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pending_approvals_v54'`,
  ).get();
  if (legacyExists) throw new Error('schema v55 rebuild source already exists');

  const columns = (db.prepare('PRAGMA table_info(pending_approvals)').all() as Array<{ name: string }>)
    .map((column) => column.name);
  if (columns.length === 0 || !columns.includes('approval_id') || !columns.includes('resolution')) {
    throw new Error('schema v55 canonical pending approvals columns are missing');
  }
  const objects = db.prepare(`
    SELECT type, name, sql FROM sqlite_master
     WHERE tbl_name = 'pending_approvals'
       AND type IN ('index','trigger')
       AND sql IS NOT NULL
     ORDER BY type, name
  `).all() as Array<{ type: 'index' | 'trigger'; name: string; sql: string }>;
  const beforeRows = (db.prepare('SELECT COUNT(*) AS n FROM pending_approvals').get() as { n: number }).n;
  const beforeBytes = JSON.stringify(db.prepare(
    'SELECT * FROM pending_approvals ORDER BY approval_id',
  ).all());
  const columnList = columns.map(quotedSchemaIdentifier).join(', ');

  // Keep the canonical table name continuously available to schema objects
  // outside this table. V51/V52 authorization triggers query
  // pending_approvals; DROP-first rebuilding leaves those triggers pointing at
  // a missing table and SQLite refuses the subsequent rename on a real v3.14
  // upgrade. legacy_alter_table keeps their exact SQL bound to the canonical
  // name while the old table is moved aside and its widened replacement is
  // installed. Attached indexes/triggers are explicitly recreated unchanged.
  const dependentTriggersBefore = JSON.stringify(db.prepare(`
    SELECT name, tbl_name, sql FROM sqlite_master
     WHERE type = 'trigger'
       AND tbl_name != 'pending_approvals'
       AND sql IS NOT NULL
       AND lower(sql) LIKE '%pending_approvals%'
     ORDER BY name
  `).all());
  const priorLegacyRename = Number(db.pragma('legacy_alter_table', { simple: true })) === 1;
  db.pragma('legacy_alter_table = ON');
  try {
    for (const object of objects) {
      db.exec(`DROP ${object.type.toUpperCase()} ${quotedSchemaIdentifier(object.name)}`);
    }
    db.exec('ALTER TABLE pending_approvals RENAME TO pending_approvals_v54');
    db.exec(widenedSql);
    db.exec(`
      INSERT INTO pending_approvals (${columnList})
        SELECT ${columnList} FROM pending_approvals_v54;
      DROP TABLE pending_approvals_v54;
    `);
    for (const object of objects) db.exec(object.sql);
  } finally {
    db.pragma(`legacy_alter_table = ${priorLegacyRename ? 'ON' : 'OFF'}`);
  }

  const afterRows = (db.prepare('SELECT COUNT(*) AS n FROM pending_approvals').get() as { n: number }).n;
  const afterBytes = JSON.stringify(db.prepare(
    'SELECT * FROM pending_approvals ORDER BY approval_id',
  ).all());
  const finalSql = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pending_approvals'`,
  ).get() as { sql: string | null } | undefined;
  const dependentTriggersAfter = JSON.stringify(db.prepare(`
    SELECT name, tbl_name, sql FROM sqlite_master
     WHERE type = 'trigger'
       AND tbl_name != 'pending_approvals'
       AND sql IS NOT NULL
       AND lower(sql) LIKE '%pending_approvals%'
     ORDER BY name
  `).all());
  if (
    beforeRows !== afterRows
    || beforeBytes !== afterBytes
    || dependentTriggersBefore !== dependentTriggersAfter
    || !finalSql?.sql?.includes("'cancelled_by_system'")
  ) {
    throw new Error('schema v55 changed approval rows/dependent triggers or failed to widen the resolution constraint');
  }
  const relevantTables = foreignKeyClosure(db, ['pending_approvals']);
  const violations = (db.pragma('foreign_key_check') as Array<{ table: string }>)
    .filter((violation) => relevantTables.has(violation.table));
  if (violations.length > 0) {
    throw new Error(`schema v55 foreign-key check failed for ${violations.length} approval row(s)`);
  }
  const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error(`schema v55 integrity check failed: ${JSON.stringify(integrity).slice(0, 240)}`);
  }
}

/** Durable copy of the module-minted foreground host capability envelope.
 * The table owns no argument values and permits the logical ledger's existing
 * one-shot raw -> effective refinement after binding. Every other byte is
 * immutable; session deletion remains the sole cascade cleanup owner. */
function createV57HostCallCapabilityBindingSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS host_call_capability_bindings (
      protocol_version                 INTEGER NOT NULL CHECK (protocol_version = 1),
      root_authority_kind              TEXT NOT NULL CHECK (root_authority_kind = 'host_v1'),
      root_graph_event_id              TEXT REFERENCES events(id) ON DELETE RESTRICT,
      root_graph_hash                  TEXT CHECK (root_graph_hash IS NULL OR length(root_graph_hash) = 64),
      session_id                       TEXT NOT NULL,
      source_user_seq                  INTEGER NOT NULL CHECK (source_user_seq > 0),
      accepted_task_id                 TEXT NOT NULL,
      source_event_id                  TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
      source_event_digest              TEXT NOT NULL CHECK (length(source_event_digest) = 64),
      logical_tool_call_id             TEXT NOT NULL CHECK (length(logical_tool_call_id) BETWEEN 1 AND 512),
      tool_name                        TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 512),
      attested_argument_digest         TEXT NOT NULL CHECK (length(attested_argument_digest) = 64),
      logical_raw_argument_digest      TEXT NOT NULL CHECK (length(logical_raw_argument_digest) = 64),
      bound_effective_argument_digest  TEXT CHECK (
        bound_effective_argument_digest IS NULL OR length(bound_effective_argument_digest) = 64
      ),
      effect                           TEXT NOT NULL CHECK (
        effect IN ('admin','compute','external_write','host_only','local_write','read')
      ),
      binding_kind                     TEXT NOT NULL CHECK (binding_kind IN ('local_envelope','catalog_manifest')),
      capability_id                    TEXT NOT NULL CHECK (length(capability_id) BETWEEN 1 AND 512),
      provider_input_schema_digest     TEXT CHECK (
        provider_input_schema_digest IS NULL OR length(provider_input_schema_digest) = 64
      ),
      schema_fingerprint               TEXT NOT NULL CHECK (length(schema_fingerprint) = 64),
      account_id                       TEXT NOT NULL,
      invoke_port_id                   TEXT NOT NULL CHECK (length(invoke_port_id) BETWEEN 1 AND 512),
      operation_id                     TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 512),
      manifest_id                      TEXT NOT NULL,
      manifest_digest                  TEXT NOT NULL,
      host_binding_digest              TEXT NOT NULL CHECK (length(host_binding_digest) = 64),
      engine_version                   TEXT NOT NULL CHECK (length(engine_version) BETWEEN 1 AND 128),
      surface_version                  TEXT NOT NULL CHECK (length(surface_version) BETWEEN 1 AND 128),
      authority_digest                 TEXT NOT NULL CHECK (length(authority_digest) = 64),
      authority_revision               INTEGER NOT NULL CHECK (authority_revision >= 0),
      surface_digest                   TEXT NOT NULL CHECK (length(surface_digest) = 64),
      catalog_revision_digest          TEXT NOT NULL CHECK (length(catalog_revision_digest) = 64),
      binding_revision_digest          TEXT NOT NULL CHECK (length(binding_revision_digest) = 64),
      durable_binding_digest           TEXT NOT NULL UNIQUE CHECK (length(durable_binding_digest) = 64),
      bound_at                         TEXT NOT NULL,
      PRIMARY KEY (session_id, source_user_seq, logical_tool_call_id),
      FOREIGN KEY (session_id, source_user_seq)
        REFERENCES accepted_turn_call_authorities(session_id, source_user_seq)
        ON DELETE CASCADE,
      FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
        REFERENCES logical_tool_calls(session_id, source_user_seq, logical_tool_call_id)
        ON DELETE CASCADE,
      CHECK (accepted_task_id = 'task:' || session_id || '#' || source_user_seq),
      CHECK (
        root_graph_event_id IS NULL AND root_graph_hash IS NULL
      ),
      CHECK (
        (binding_kind = 'catalog_manifest'
          AND length(account_id) BETWEEN 1 AND 512
          AND length(manifest_id) BETWEEN 1 AND 512
          AND length(manifest_digest) = 64)
        OR
        (binding_kind = 'local_envelope'
          AND provider_input_schema_digest IS NULL
          AND account_id = '' AND manifest_id = '' AND manifest_digest = '')
      ),
      CHECK (
        (bound_effective_argument_digest IS NULL
          AND attested_argument_digest = logical_raw_argument_digest)
        OR
        (bound_effective_argument_digest IS NOT NULL
          AND attested_argument_digest = bound_effective_argument_digest
          AND bound_effective_argument_digest != logical_raw_argument_digest)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_host_call_capability_provider
      ON host_call_capability_bindings(
        account_id, operation_id, provider_input_schema_digest
      ) WHERE binding_kind = 'catalog_manifest';

    CREATE TRIGGER IF NOT EXISTS trg_host_call_capability_binding_root_exact
    BEFORE INSERT ON host_call_capability_bindings
    WHEN NOT EXISTS (
      SELECT 1 FROM accepted_turn_call_authorities root
       WHERE root.session_id = NEW.session_id
         AND root.source_user_seq = NEW.source_user_seq
         AND root.accepted_task_id = NEW.accepted_task_id
         AND root.authority_protocol = 1
         AND root.authority_kind = 'host_v1'
         AND NEW.root_authority_kind = 'host_v1'
         AND root.graph_event_id IS NEW.root_graph_event_id
         AND root.graph_hash IS NEW.root_graph_hash
         AND root.source_event_id = NEW.source_event_id
         AND root.source_event_digest = NEW.source_event_digest
         AND root.engine_version = NEW.engine_version
         AND root.surface_version = NEW.surface_version
         AND root.authority_digest = NEW.authority_digest
         AND root.revision = NEW.authority_revision
         AND root.surface_digest = NEW.surface_digest
         AND root.catalog_revision_digest = NEW.catalog_revision_digest
         AND root.binding_revision_digest = NEW.binding_revision_digest
         AND root.state = 'open'
    )
    BEGIN
      SELECT RAISE(ABORT, 'host-call capability binding requires its exact open host root');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_host_call_capability_binding_logical_exact
    BEFORE INSERT ON host_call_capability_bindings
    WHEN NOT EXISTS (
      SELECT 1 FROM logical_tool_calls call
       WHERE call.session_id = NEW.session_id
         AND call.source_user_seq = NEW.source_user_seq
         AND call.accepted_task_id = NEW.accepted_task_id
         AND call.logical_tool_call_id = NEW.logical_tool_call_id
         AND call.tool_name = NEW.tool_name
         AND call.argument_digest = NEW.attested_argument_digest
         AND call.raw_argument_digest = NEW.logical_raw_argument_digest
         AND call.effective_argument_digest IS NEW.bound_effective_argument_digest
         AND call.state = 'open'
    )
    BEGIN
      SELECT RAISE(ABORT, 'host-call capability binding requires its exact open logical call');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_host_call_capability_binding_update_immutable
    BEFORE UPDATE ON host_call_capability_bindings
    BEGIN
      SELECT RAISE(ABORT, 'host-call capability bindings are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_host_call_capability_binding_delete_immutable
    BEFORE DELETE ON host_call_capability_bindings
    WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
    BEGIN
      SELECT RAISE(ABORT, 'host-call capability bindings are immutable');
    END;
  `);

  const columns = (db.prepare('PRAGMA table_info(host_call_capability_bindings)').all() as Array<{ name: string }>)
    .map((column) => column.name);
  const expectedColumns = [
    'protocol_version', 'root_authority_kind', 'root_graph_event_id',
    'root_graph_hash', 'session_id', 'source_user_seq', 'accepted_task_id',
    'source_event_id', 'source_event_digest', 'logical_tool_call_id', 'tool_name',
    'attested_argument_digest', 'logical_raw_argument_digest',
    'bound_effective_argument_digest', 'effect', 'binding_kind', 'capability_id',
    'provider_input_schema_digest', 'schema_fingerprint', 'account_id',
    'invoke_port_id', 'operation_id', 'manifest_id', 'manifest_digest',
    'host_binding_digest', 'engine_version', 'surface_version', 'authority_digest',
    'authority_revision', 'surface_digest', 'catalog_revision_digest',
    'binding_revision_digest', 'durable_binding_digest', 'bound_at',
  ];
  if (JSON.stringify(columns) !== JSON.stringify(expectedColumns)) {
    throw new Error('schema v57 host-call capability binding columns are not exact');
  }
  const parents = new Set((db.prepare('PRAGMA foreign_key_list(host_call_capability_bindings)').all() as Array<{
    table: string;
  }>).map((fk) => fk.table));
  if (!parents.has('events') || !parents.has('logical_tool_calls') || !parents.has('accepted_turn_call_authorities')) {
    throw new Error('schema v57 host-call capability binding foreign keys are incomplete');
  }
}

function canonicalHistoricalTriggerSql(sql: string): string {
  let canonical = '';
  let inString = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    if (inString) {
      canonical += character;
      if (character === "'") {
        if (sql[index + 1] === "'") {
          canonical += sql[index + 1];
          index += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (character === "'") {
      inString = true;
      canonical += character;
      continue;
    }
    if (/\s/.test(character)) continue;
    canonical += character.toLowerCase();
  }
  if (inString) throw new Error('schema v70 amendment trigger SQL has an unterminated string');
  canonical = canonical.replace(/^createtriggerifnotexists/, 'createtrigger');
  return canonical.replace(/;+$/, '');
}

const EXACT_AMENDMENT_TRIGGER_SQL = new Map<string, string>([
  [
    'trg_expected_work_universe_amendment_update_immutable',
    `CREATE TRIGGER trg_expected_work_universe_amendment_update_immutable
     BEFORE UPDATE ON expected_work_universe_amendments
     BEGIN
       SELECT RAISE(ABORT, 'a universe amendment is immutable');
     END`,
  ],
  [
    'trg_expected_work_universe_amendment_delete_immutable',
    `CREATE TRIGGER trg_expected_work_universe_amendment_delete_immutable
     BEFORE DELETE ON expected_work_universe_amendments
     WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
     BEGIN
       SELECT RAISE(ABORT, 'a universe amendment is immutable');
     END`,
  ],
].map(([name, sql]): [string, string] => [name, canonicalHistoricalTriggerSql(sql)]));

function assertExactAmendmentImmutabilityTriggers(
  objects: Array<{ type: 'index' | 'trigger'; name: string; sql: string }>,
): void {
  const triggers = objects.filter((object) => object.type === 'trigger');
  if (triggers.length !== EXACT_AMENDMENT_TRIGGER_SQL.size) {
    throw new Error('schema v70 amendment trigger set is not exact');
  }
  for (const trigger of triggers) {
    const expected = EXACT_AMENDMENT_TRIGGER_SQL.get(trigger.name);
    if (!expected || canonicalHistoricalTriggerSql(trigger.sql) !== expected) {
      throw new Error(`schema v70 amendment trigger is not exact: ${trigger.name}`);
    }
  }
}

/** V37 made a source-universe amendment immutable, but its two parents used
 * ON DELETE RESTRICT and the row carried no FK to its session. That meant the
 * retention owner's one sanctioned delete -- deleting an old terminal
 * session -- could never cross an amendment row. Retarget all three identities
 * together so only the exact session -> contract/event cascade can remove it;
 * the existing trigger still refuses every standalone delete while the
 * session exists. */
function rebuildExpectedWorkUniverseAmendmentCascade(db: Database.Database): void {
  const tableName = 'expected_work_universe_amendments';
  const table = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(tableName) as { sql: string | null } | undefined;
  if (!table?.sql) return;

  const prerequisites = ['sessions', 'events', 'accepted_task_work_contracts'];
  const tables = new Set((db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'`,
  ).all() as Array<{ name: string }>).map((row) => row.name));
  for (const prerequisite of prerequisites) {
    if (!tables.has(prerequisite)) {
      throw new Error(`schema v70 prerequisite missing: ${prerequisite}`);
    }
  }

  const expectedColumns = [
    'session_id',
    'source_user_seq',
    'contract_id',
    'universe_id',
    'prior_member_id_pointer',
    'member_id_pointer',
    'motivating_refusal',
    'sealed_member_count',
    'amended_at',
    'amendment_event_id',
  ];
  const columns = (db.prepare(
    `PRAGMA table_info(${quotedSchemaIdentifier(tableName)})`,
  ).all() as Array<{ name: string }>).map((column) => column.name);
  if (JSON.stringify(columns) !== JSON.stringify(expectedColumns)) {
    throw new Error('schema v70 amendment columns are not exact');
  }

  const objects = db.prepare(`
    SELECT type, name, sql FROM sqlite_master
     WHERE tbl_name = ?
       AND type IN ('index','trigger')
       AND sql IS NOT NULL
     ORDER BY type, name
  `).all(tableName) as Array<{ type: 'index' | 'trigger'; name: string; sql: string }>;
  // Validate the historical authority boundary before creating even the two
  // parent indexes. A same-named no-op trigger must never be preserved and
  // stamped as v70 merely because it contains a suggestive token.
  assertExactAmendmentImmutabilityTriggers(objects);

  // SQLite requires a declared UNIQUE parent key for each composite FK. Both
  // are already unique by their narrower historical keys (contract_id and id),
  // so these indexes add no new semantic restriction.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_accepted_task_work_contract_exact_identity
      ON accepted_task_work_contracts(session_id, source_user_seq, contract_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_event_exact_session_identity
      ON events(session_id, id);
  `);
  const exactIndexSql = new Map((db.prepare(`
    SELECT name, sql FROM sqlite_master
     WHERE type = 'index'
       AND name IN (
         'uq_accepted_task_work_contract_exact_identity',
         'uq_event_exact_session_identity'
       )
  `).all() as Array<{ name: string; sql: string | null }>).map((row) => [row.name, row.sql ?? '']));
  if (
    !/accepted_task_work_contracts\s*\(\s*session_id\s*,\s*source_user_seq\s*,\s*contract_id\s*\)/i
      .test(exactIndexSql.get('uq_accepted_task_work_contract_exact_identity') ?? '')
    || !/events\s*\(\s*session_id\s*,\s*id\s*\)/i
      .test(exactIndexSql.get('uq_event_exact_session_identity') ?? '')
  ) {
    throw new Error('schema v70 exact parent identity index is missing or incompatible');
  }

  type ForeignKeyRow = {
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_delete: string;
  };
  const exactCascade = (): boolean => {
    const foreignKeys = db.prepare(
      `PRAGMA foreign_key_list(${quotedSchemaIdentifier(tableName)})`,
    ).all() as ForeignKeyRow[];
    const groups = new Map<number, ForeignKeyRow[]>();
    for (const row of foreignKeys) {
      const group = groups.get(row.id) ?? [];
      group.push(row);
      groups.set(row.id, group);
    }
    const canonical = [...groups.values()].map((group) => group
      .sort((left, right) => left.seq - right.seq)
      .map((row) => `${row.from}:${row.table}.${row.to}:${row.on_delete.toUpperCase()}`)
      .join('|'));
    return canonical.length === 3
      && canonical.includes('session_id:sessions.id:CASCADE')
      && canonical.includes(
        'session_id:accepted_task_work_contracts.session_id:CASCADE'
        + '|source_user_seq:accepted_task_work_contracts.source_user_seq:CASCADE'
        + '|contract_id:accepted_task_work_contracts.contract_id:CASCADE',
      )
      && canonical.includes(
        'session_id:events.session_id:CASCADE|amendment_event_id:events.id:CASCADE',
      );
  };

  const verify = (): void => {
    if (!exactCascade()) {
      throw new Error('schema v70 amendment session/contract/event cascade is not exact');
    }
    const finalObjects = db.prepare(`
      SELECT type, name, sql FROM sqlite_master
       WHERE tbl_name = ?
         AND type IN ('index','trigger')
         AND sql IS NOT NULL
       ORDER BY type, name
    `).all(tableName) as Array<{ type: 'index' | 'trigger'; name: string; sql: string }>;
    assertExactAmendmentImmutabilityTriggers(finalObjects);
    const relevantTables = foreignKeyClosure(db, [tableName]);
    const violations = (db.pragma('foreign_key_check') as Array<{ table: string }>)
      .filter((violation) => relevantTables.has(violation.table));
    if (violations.length > 0) {
      throw new Error(`schema v70 foreign-key check failed for ${violations.length} amendment row(s)`);
    }
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error(`schema v70 integrity check failed: ${JSON.stringify(integrity).slice(0, 240)}`);
    }
  };
  if (exactCascade()) {
    verify();
    return;
  }

  const legacyExists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table'
      AND name = 'expected_work_universe_amendments_v69'`,
  ).get();
  if (legacyExists) throw new Error('schema v70 amendment rebuild source already exists');

  // Refuse mixed identities rather than blessing them into the new exact FKs.
  const mismatchedContracts = (db.prepare(`
    SELECT COUNT(*) AS n
      FROM expected_work_universe_amendments a
      LEFT JOIN accepted_task_work_contracts c
        ON c.session_id = a.session_id
       AND c.source_user_seq = a.source_user_seq
       AND c.contract_id = a.contract_id
     WHERE c.contract_id IS NULL
  `).get() as { n: number }).n;
  const mismatchedEvents = (db.prepare(`
    SELECT COUNT(*) AS n
      FROM expected_work_universe_amendments a
      LEFT JOIN events e
        ON e.session_id = a.session_id
       AND e.id = a.amendment_event_id
     WHERE e.id IS NULL
  `).get() as { n: number }).n;
  if (mismatchedContracts > 0 || mismatchedEvents > 0) {
    throw new Error(
      `schema v70 refuses mixed amendment identities: contracts=${mismatchedContracts}, events=${mismatchedEvents}`,
    );
  }

  const beforeRows = (db.prepare(
    'SELECT COUNT(*) AS n FROM expected_work_universe_amendments',
  ).get() as { n: number }).n;
  const beforeBytes = JSON.stringify(db.prepare(`
    SELECT * FROM expected_work_universe_amendments
     ORDER BY session_id, source_user_seq, contract_id, universe_id
  `).all());
  const dependentObjectsBefore = JSON.stringify(db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE tbl_name != 'expected_work_universe_amendments'
       AND sql IS NOT NULL
       AND lower(sql) LIKE '%expected_work_universe_amendments%'
     ORDER BY type, name
  `).all());

  const priorLegacyRename = Number(db.pragma('legacy_alter_table', { simple: true })) === 1;
  db.pragma('legacy_alter_table = ON');
  try {
    for (const object of objects) {
      db.exec(`DROP ${object.type.toUpperCase()} ${quotedSchemaIdentifier(object.name)}`);
    }
    db.exec(`
      ALTER TABLE expected_work_universe_amendments
        RENAME TO expected_work_universe_amendments_v69;

      CREATE TABLE expected_work_universe_amendments (
        session_id              TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_user_seq         INTEGER NOT NULL CHECK (source_user_seq > 0),
        contract_id             TEXT NOT NULL,
        universe_id             TEXT NOT NULL,
        prior_member_id_pointer TEXT NOT NULL,
        member_id_pointer       TEXT NOT NULL
                                CHECK (member_id_pointer != prior_member_id_pointer),
        motivating_refusal      TEXT NOT NULL,
        sealed_member_count     INTEGER NOT NULL CHECK (sealed_member_count > 0),
        amended_at              TEXT NOT NULL,
        amendment_event_id      TEXT NOT NULL,
        PRIMARY KEY (session_id, source_user_seq, contract_id, universe_id),
        FOREIGN KEY (session_id, source_user_seq, contract_id)
          REFERENCES accepted_task_work_contracts(session_id, source_user_seq, contract_id)
          ON DELETE CASCADE,
        FOREIGN KEY (session_id, amendment_event_id)
          REFERENCES events(session_id, id)
          ON DELETE CASCADE
      );

      INSERT INTO expected_work_universe_amendments (
        session_id, source_user_seq, contract_id, universe_id,
        prior_member_id_pointer, member_id_pointer, motivating_refusal,
        sealed_member_count, amended_at, amendment_event_id
      )
      SELECT session_id, source_user_seq, contract_id, universe_id,
             prior_member_id_pointer, member_id_pointer, motivating_refusal,
             sealed_member_count, amended_at, amendment_event_id
        FROM expected_work_universe_amendments_v69;

      DROP TABLE expected_work_universe_amendments_v69;
    `);
    for (const object of objects) db.exec(object.sql);
  } finally {
    db.pragma(`legacy_alter_table = ${priorLegacyRename ? 'ON' : 'OFF'}`);
  }

  const afterRows = (db.prepare(
    'SELECT COUNT(*) AS n FROM expected_work_universe_amendments',
  ).get() as { n: number }).n;
  const afterBytes = JSON.stringify(db.prepare(`
    SELECT * FROM expected_work_universe_amendments
     ORDER BY session_id, source_user_seq, contract_id, universe_id
  `).all());
  const dependentObjectsAfter = JSON.stringify(db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE tbl_name != 'expected_work_universe_amendments'
       AND sql IS NOT NULL
       AND lower(sql) LIKE '%expected_work_universe_amendments%'
     ORDER BY type, name
  `).all());
  if (
    beforeRows !== afterRows
    || beforeBytes !== afterBytes
    || dependentObjectsBefore !== dependentObjectsAfter
  ) {
    throw new Error(
      `schema v70 changed amendment rows or dependent objects: ${beforeRows} -> ${afterRows}`,
    );
  }
  verify();
}

function v71PreambleAddress(input: {
  seq: number;
  id: string;
  session_id: string;
  turn: number;
  role: string;
  type: string;
  parent_event_id: string | null;
  data_json: string;
  created_at: string;
}): { eventDigest: string; deliveryKey: string } | null {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(input.data_json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    raw = parsed as Record<string, unknown>;
  } catch { return null; }
  if (Object.keys(raw).some((key) => ![
    'version', 'kind', 'sourceUserSeq', 'text', 'intentKey',
  ].includes(key))) return null;
  const sourceUserSeq = raw.sourceUserSeq;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  const intentKey = raw.intentKey === undefined
    ? undefined
    : typeof raw.intentKey === 'string' ? raw.intentKey.trim() : '';
  if (
    input.role !== 'Clem'
    || input.type !== 'conversation_preamble'
    || !input.parent_event_id
    || raw.version !== 1
    || raw.kind !== 'pre_execution'
    || !Number.isSafeInteger(sourceUserSeq)
    || Number(sourceUserSeq) <= 0
    || !text
    || text.length > 8_000
    || text.includes('\0')
    || (intentKey !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(intentKey))
  ) return null;
  const data = {
    version: 1,
    kind: 'pre_execution',
    sourceUserSeq: Number(sourceUserSeq),
    text,
    ...(intentKey ? { intentKey } : {}),
  };
  const eventDigest = createHash('sha256').update(JSON.stringify({
    version: 1,
    seq: input.seq,
    id: input.id,
    sessionId: input.session_id,
    turn: input.turn,
    role: input.role,
    type: input.type,
    parentEventId: input.parent_event_id,
    data,
    createdAt: input.created_at,
  }), 'utf8').digest('hex');
  return {
    eventDigest,
    deliveryKey: `preamble-delivery:v1:${createHash('sha256')
      .update(JSON.stringify({ version: 1, eventId: input.id, eventDigest }), 'utf8')
      .digest('hex')}`,
  };
}

/** Upgrade both v70 crash windows without guessing. Existing activation
 * receipts name their exact owner directly. A no-receipt orphan is promoted
 * only when the preamble timestamp intersects exactly one plan call lifetime;
 * ambiguous historical sources remain checkpoint-free and therefore held. */
function backfillPlanTaskPreparationCheckpointsV71(db: Database.Database): void {
  db.exec(`
    INSERT INTO ${PLAN_TASK_BINDING_SEAL_INTENTS_TABLE}
      (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
       intent_version, intent_origin, plan_argument_digest, graph_event_id,
       graph_id, graph_hash, contract_id, objective_text, objective_digest,
       semantic_input_digest, operation_ids_json, operation_ids_digest,
       preamble_text, preamble_text_digest, delivery_owner, recorded_at)
    SELECT receipt.session_id, receipt.source_user_seq, receipt.accepted_task_id,
           receipt.logical_tool_call_id, 1, 'legacy_backfill',
           receipt.plan_argument_digest, receipt.graph_event_id,
           receipt.graph_id, receipt.graph_hash, receipt.contract_id,
           COALESCE(NULLIF(trim(json_extract(source.data_json, '$.displayText')), ''),
                    NULLIF(trim(json_extract(source.data_json, '$.text')), ''),
                    'legacy-v70'),
           COALESCE(json_extract(graph.data_json, '$.graph.source.inputHash'), receipt.graph_hash),
           COALESCE(json_extract(graph.data_json, '$.graph.source.inputHash'), receipt.graph_hash),
           COALESCE((SELECT json_group_array(json_extract(operation.value, '$.id'))
              FROM json_each(contract.contract_json, '$.operations') operation), '[]'),
           receipt.graph_hash,
           json_extract(preamble.data_json, '$.text'), receipt.graph_hash,
           CASE receipt.transport_target
             WHEN 'durable_conversation' THEN 'durable_conversation'
             ELSE 'carrier_owned'
           END,
           receipt.recorded_at
      FROM ${PLAN_TASK_ACTIVATION_RECEIPTS_TABLE} receipt
      JOIN accepted_task_work_contracts contract
        ON contract.session_id = receipt.session_id
       AND contract.source_user_seq = receipt.source_user_seq
       AND contract.contract_id = receipt.contract_id
      JOIN events graph ON graph.id = receipt.graph_event_id
      JOIN events source
        ON source.session_id = receipt.session_id
       AND source.seq = receipt.source_user_seq
      JOIN events preamble ON preamble.id = receipt.preamble_event_id
     WHERE NOT EXISTS (
       SELECT 1 FROM ${PLAN_TASK_BINDING_SEAL_INTENTS_TABLE} intent
        WHERE intent.session_id = receipt.session_id
          AND intent.source_user_seq = receipt.source_user_seq
     );

    INSERT INTO ${PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE}
      (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
       checkpoint_version, plan_argument_digest, graph_event_id, graph_id,
       graph_hash, contract_id, preamble_event_id, preamble_event_digest,
       delivery_key, delivery_owner, recorded_at)
    SELECT receipt.session_id, receipt.source_user_seq, receipt.accepted_task_id,
           receipt.logical_tool_call_id, 1, receipt.plan_argument_digest,
           receipt.graph_event_id, receipt.graph_id, receipt.graph_hash,
           receipt.contract_id, receipt.preamble_event_id,
           receipt.preamble_event_digest, receipt.delivery_key,
           CASE receipt.transport_target
             WHEN 'durable_conversation' THEN 'durable_conversation'
             ELSE 'carrier_owned'
           END,
           receipt.recorded_at
      FROM ${PLAN_TASK_ACTIVATION_RECEIPTS_TABLE} receipt
     WHERE NOT EXISTS (
       SELECT 1 FROM ${PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE} checkpoint
        WHERE checkpoint.session_id = receipt.session_id
          AND checkpoint.source_user_seq = receipt.source_user_seq
     );
  `);

  type Candidate = {
    session_id: string;
    source_user_seq: number;
    accepted_task_id: string;
    logical_tool_call_id: string;
    argument_digest: string;
    graph_event_id: string;
    graph_id: string;
    graph_hash: string;
    contract_id: string;
    objective_text: string;
    semantic_input_digest: string;
    operation_ids_json: string;
    preamble_text: string;
    seq: number;
    id: string;
    turn: number;
    role: string;
    type: string;
    parent_event_id: string | null;
    data_json: string;
    created_at: string;
  };
  const candidates = db.prepare(`
    SELECT root.session_id, root.source_user_seq, root.accepted_task_id,
           call.logical_tool_call_id, call.argument_digest,
           task.graph_event_id, task.graph_id, task.graph_hash,
           contract.contract_id,
           COALESCE(NULLIF(trim(json_extract(source.data_json, '$.displayText')), ''),
                    NULLIF(trim(json_extract(source.data_json, '$.text')), ''),
                    'legacy-v70') AS objective_text,
           COALESCE(json_extract(graph.data_json, '$.graph.source.inputHash'), task.graph_hash)
             AS semantic_input_digest,
           COALESCE((SELECT json_group_array(json_extract(operation.value, '$.id'))
              FROM json_each(contract.contract_json, '$.operations') operation), '[]')
             AS operation_ids_json,
           json_extract(preamble.data_json, '$.text') AS preamble_text,
           preamble.seq, preamble.id, preamble.turn, preamble.role,
           preamble.type, preamble.parent_event_id, preamble.data_json,
           preamble.created_at
      FROM accepted_turn_call_authorities root
      JOIN accepted_task_authority task
        ON task.session_id = root.session_id
       AND task.source_user_seq = root.source_user_seq
       AND task.accepted_task_id = root.accepted_task_id
      JOIN accepted_task_work_contracts contract
        ON contract.session_id = task.session_id
       AND contract.source_user_seq = task.source_user_seq
       AND contract.accepted_task_id = task.accepted_task_id
       AND contract.contract_id = task.work_contract_id
      JOIN events source
        ON source.session_id = root.session_id
       AND source.seq = root.source_user_seq
       AND source.id = root.source_event_id
      JOIN events graph
        ON graph.session_id = root.session_id
       AND graph.id = task.graph_event_id
      JOIN events preamble
        ON preamble.session_id = source.session_id
       AND preamble.parent_event_id = source.id
       AND preamble.turn = source.turn
       AND preamble.role = 'Clem'
       AND preamble.type = 'conversation_preamble'
      JOIN logical_tool_calls call
        ON call.session_id = root.session_id
       AND call.source_user_seq = root.source_user_seq
       AND call.accepted_task_id = root.accepted_task_id
       AND call.tool_name = 'plan_task'
       AND call.opened_at <= preamble.created_at
       AND (call.settled_at IS NULL OR call.settled_at >= preamble.created_at)
     WHERE root.authority_kind = 'host_v1'
       AND root.engine_version = 'host_v1'
       AND root.state = 'open'
       AND task.state != 'conflict'
       AND task.expected_work_required = 0
       AND contract.contract_version = 1
       AND contract.planner_source = 'structured_model'
       AND NOT EXISTS (
         SELECT 1 FROM ${PLAN_TASK_ACTIVATION_RECEIPTS_TABLE} receipt
          WHERE receipt.session_id = root.session_id
            AND receipt.source_user_seq = root.source_user_seq
       )
       AND NOT EXISTS (
         SELECT 1 FROM ${PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE} checkpoint
          WHERE checkpoint.session_id = root.session_id
            AND checkpoint.source_user_seq = root.source_user_seq
       )
     ORDER BY root.session_id, root.source_user_seq, call.opened_at, call.logical_tool_call_id
  `).all() as Candidate[];
  const bySource = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.session_id}\0${candidate.source_user_seq}`;
    const grouped = bySource.get(key) ?? [];
    grouped.push(candidate);
    bySource.set(key, grouped);
  }
  const insert = db.prepare(`
    INSERT INTO ${PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE}
      (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
       checkpoint_version, plan_argument_digest, graph_event_id, graph_id,
       graph_hash, contract_id, preamble_event_id, preamble_event_digest,
       delivery_key, delivery_owner, recorded_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy_unknown', ?)
  `);
  const insertIntent = db.prepare(`
    INSERT INTO ${PLAN_TASK_BINDING_SEAL_INTENTS_TABLE}
      (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
       intent_version, intent_origin, plan_argument_digest, graph_event_id,
       graph_id, graph_hash, contract_id, objective_text, objective_digest,
       semantic_input_digest, operation_ids_json, operation_ids_digest,
       preamble_text, preamble_text_digest, delivery_owner, recorded_at)
    VALUES (?, ?, ?, ?, 1, 'legacy_backfill', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy_unknown', ?)
  `);
  for (const grouped of bySource.values()) {
    if (grouped.length !== 1) continue;
    const candidate = grouped[0]!;
    const address = v71PreambleAddress(candidate);
    if (!address) continue;
    insertIntent.run(
      candidate.session_id,
      candidate.source_user_seq,
      candidate.accepted_task_id,
      candidate.logical_tool_call_id,
      candidate.argument_digest,
      candidate.graph_event_id,
      candidate.graph_id,
      candidate.graph_hash,
      candidate.contract_id,
      candidate.objective_text,
      candidate.semantic_input_digest,
      candidate.semantic_input_digest,
      candidate.operation_ids_json,
      candidate.graph_hash,
      candidate.preamble_text,
      candidate.graph_hash,
      candidate.created_at,
    );
    insert.run(
      candidate.session_id,
      candidate.source_user_seq,
      candidate.accepted_task_id,
      candidate.logical_tool_call_id,
      candidate.argument_digest,
      candidate.graph_event_id,
      candidate.graph_id,
      candidate.graph_hash,
      candidate.contract_id,
      candidate.id,
      address.eventDigest,
      address.deliveryKey,
      candidate.created_at,
    );
  }
}

/** Re-author the two historical graph-continuation walls with the v71
 * checkpoint-backed settlement proof. Historical migration rehearsal keeps
 * using the legacy success-only predicate until this migration is reached. */
function refreshCheckpointBackedPlanContinuationTriggersV71(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_accepted_task_resolution_excludes_host_root;
    CREATE TRIGGER trg_accepted_task_resolution_excludes_host_root
    BEFORE INSERT ON accepted_task_resolutions
    WHEN EXISTS (
      SELECT 1 FROM accepted_turn_call_authorities a
       WHERE a.session_id = NEW.session_id
         AND a.source_user_seq = NEW.source_user_seq
         AND a.authority_kind != 'turn_graph'
    ) AND NOT ${hostPlannedResolutionProofSql('NEW', 'insert')}
    BEGIN
      SELECT RAISE(ABORT, 'graph resolution cannot replace non-graph call authority');
    END;

    DROP TRIGGER IF EXISTS trg_accepted_model_batch_admission_chain;
    CREATE TRIGGER trg_accepted_model_batch_admission_chain
    BEFORE INSERT ON accepted_model_batch_admissions
    WHEN NOT (
      (
        NEW.batch_ordinal = 1
        AND NOT EXISTS (
          SELECT 1 FROM accepted_model_batch_admissions prior
           WHERE prior.session_id = NEW.session_id
             AND prior.source_user_seq = NEW.source_user_seq
        )
      )
      OR
      EXISTS (
        SELECT 1
          FROM accepted_model_batch_checkpoints prior
         WHERE prior.session_id = NEW.session_id
           AND prior.source_user_seq = NEW.source_user_seq
           AND prior.batch_ordinal = NEW.batch_ordinal - 1
           AND prior.history_digest = NEW.pre_history_digest
           AND prior.last_response_id IS NEW.previous_response_id
           AND prior.authority_digest = NEW.authority_digest
           AND (
             (
               prior.graph_event_id IS NEW.graph_event_id
               AND prior.graph_hash IS NEW.graph_hash
               AND prior.work_contract_id IS NEW.work_contract_id
             )
             OR
             (
               prior.graph_event_id IS NULL
               AND prior.graph_hash IS NULL
               AND prior.work_contract_id IS NULL
               AND NEW.graph_event_id IS NOT NULL
               AND NEW.graph_hash IS NOT NULL
               AND NEW.work_contract_id IS NOT NULL
               AND EXISTS (
                 SELECT 1
                   FROM accepted_task_resolutions r
                   JOIN accepted_task_work_contracts contract
                     ON contract.session_id = r.session_id
                    AND contract.source_user_seq = r.source_user_seq
                    AND contract.accepted_task_id = r.accepted_task_id
                    AND contract.graph_event_id = r.graph_event_id
                    AND contract.graph_hash = r.graph_hash
                  WHERE r.session_id = NEW.session_id
                    AND r.source_user_seq = NEW.source_user_seq
                    AND r.accepted_task_id = NEW.accepted_task_id
                    AND r.graph_event_id = NEW.graph_event_id
                    AND r.graph_hash = NEW.graph_hash
                    AND contract.contract_id = NEW.work_contract_id
                    AND ${hostPlannedResolutionProofSql('r', 'existing')}
               )
             )
           )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'model batch admission requires the exact prior balanced checkpoint');
    END;
  `);
}

const MIGRATIONS: EventLogMigration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL CHECK (kind IN ('chat','execution','workflow','agent')),
        channel         TEXT,
        user_id         TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('active','paused','completed','failed','cancelled')),
        title           TEXT,
        objective       TEXT,
        token_budget    INTEGER,
        tokens_used     INTEGER NOT NULL DEFAULT 0,
        current_plan_id TEXT,
        metadata_json   TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON sessions(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel) WHERE channel IS NOT NULL;

      CREATE TABLE IF NOT EXISTS events (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        id              TEXT NOT NULL UNIQUE,
        session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn            INTEGER NOT NULL,
        role            TEXT NOT NULL,
        type            TEXT NOT NULL,
        parent_event_id TEXT,
        data_json       TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_session_type ON events(session_id, type);

      CREATE TABLE IF NOT EXISTS kill_switches (
        session_id   TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        requested_at TEXT NOT NULL,
        reason       TEXT
      );
    `,
  },
  {
    // Reliability pass v0.4.20:
    //   - session_locks: legacy cross-process lock table. Its withSessionLock
    //     helper was removed in the 2026-07-09 subtraction pass (no live caller);
    //     the table CREATE is retained as an inert vestige — dropping it is a
    //     separate schema change, out of scope for that pass.
    //   - pending_approvals: addressable approval requests with per-row TTL.
    //     One row per `approval_requested` event. The reaper expires stale
    //     rows; the approval-registry resolves them by approval_id so a
    //     bare "approve" reply on a busy channel never silently routes to
    //     the wrong paused session.
    //
    // Both tables reference sessions(id) so they cascade on session delete.
    // session_locks is a small set (one row per actively-locked session,
    // typically <10 at peak); pending_approvals grows with usage but the
    // reaper keeps it bounded.
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS session_locks (
        session_id   TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        owner_pid    INTEGER NOT NULL,
        owner_token  TEXT NOT NULL,
        acquired_at  INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_approvals (
        approval_id   TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        channel       TEXT,
        channel_id    TEXT,
        requested_at  TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        subject       TEXT NOT NULL,
        tool          TEXT,
        args_json     TEXT,
        status        TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','resolved','expired','cancelled')),
        resolution    TEXT
                      CHECK (resolution IS NULL OR resolution IN ('approved','rejected','expired','cancelled_by_user')),
        resolver      TEXT,
        resolved_at   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_session_status
        ON pending_approvals(session_id, status);
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_channel_status
        ON pending_approvals(channel_id, status) WHERE channel_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_expires
        ON pending_approvals(expires_at) WHERE status = 'pending';
    `,
  },
  {
    // v0.5.10 auto-compact: lossless tool-output storage keyed by call_id.
    // The event log clips tool_returned payloads to 8KB at write-time
    // (see hooks.ts:202) for readability; that loss broke the
    // recall_tool_result promise. This table stores the full output
    // (up to 200KB) so an agent that sees `[clipped: ... call
    // recall_tool_result …]` stub can retrieve the verbatim
    // original. Append-only; cascade-deleted with the session.
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS tool_outputs (
        session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        call_id             TEXT NOT NULL,
        tool                TEXT,
        output_full         TEXT NOT NULL,
        content_bytes       INTEGER NOT NULL,
        truncated_at_write  INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL,
        PRIMARY KEY (session_id, call_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tool_outputs_session ON tool_outputs(session_id);
    `,
  },
  {
    // v0.5.19 F6 — persist tool-guardrail recent-call queue so the
    // loop-detection thresholds survive daemon restarts. Until v0.5.19
    // tool-guardrail.ts held SessionTrackerState only in-memory, which
    // meant multi-hour workflows that crossed a restart (autonomy
    // loops, cron-scheduled runs) lost their loop-detection history.
    // Append-only blob — one row per session_id, replaced on every
    // write-through (debounced every N calls). Cascade-deleted with
    // the session.
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS tool_guardrail_state (
        session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        recent_json TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `,
  },
  {
    // Workflow-owned Claude SDK approval parking. A workflow query must be able
    // to release its child process + drain slot while a human reviews the exact
    // tool payload, then reuse that decision once after a daemon restart. The
    // resume key identifies the session/tool/payload; consumed_at is claimed
    // atomically before the approved call is allowed through.
    version: 5,
    sql: `
      ALTER TABLE pending_approvals ADD COLUMN resume_key TEXT;
      ALTER TABLE pending_approvals ADD COLUMN consumed_at TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_approvals_pending_resume_key
        ON pending_approvals(resume_key)
        WHERE resume_key IS NOT NULL AND status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_resume_history
        ON pending_approvals(resume_key, requested_at DESC)
        WHERE resume_key IS NOT NULL;
    `,
  },
  {
    // Guardrail trackers are keyed by an EXECUTION SCOPE, not always by a real
    // harness session id. Nested dispatch, certified batches, and workers append
    // `::nestedDispatch`, `::batch:*`, or `::w:*` to the parent session. Legacy
    // databases may still contain the historical `::codeMode` suffix. The v4 table
    // incorrectly made that synthetic key a direct FK to sessions(id), so every
    // fifth scoped tool call failed to persist with FOREIGN KEY constraint
    // errors. Keep the scope isolated while anchoring its lifecycle to the real
    // parent session for cascade cleanup.
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS tool_guardrail_scope_state (
        scope_id          TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        recent_json       TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tool_guardrail_scope_parent
        ON tool_guardrail_scope_state(parent_session_id);
    `,
    backfill: (db) => {
      // A valid v4 database has both tables, but keep the additive migration
      // tolerant of old test fixtures and partially recovered databases. More
      // importantly, do not copy legacy orphan rows: older processes sometimes
      // opened SQLite without FK enforcement and left scope-looking ids in the
      // session-keyed table. Preserve only rows whose real parent still exists.
      const hasTable = (name: string): boolean => Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ).get(name));
      if (!hasTable('sessions') || !hasTable('tool_guardrail_state')) return;
      db.exec(`
        INSERT OR IGNORE INTO tool_guardrail_scope_state
          (scope_id, parent_session_id, recent_json, updated_at)
        SELECT legacy.session_id,
               CASE
                 WHEN instr(legacy.session_id, '::') > 0
                   THEN substr(legacy.session_id, 1, instr(legacy.session_id, '::') - 1)
                 ELSE legacy.session_id
               END,
               legacy.recent_json,
               legacy.updated_at
          FROM tool_guardrail_state AS legacy
          JOIN sessions AS parent
            ON parent.id = CASE
              WHEN instr(legacy.session_id, '::') > 0
                THEN substr(legacy.session_id, 1, instr(legacy.session_id, '::') - 1)
              ELSE legacy.session_id
            END;
      `);
    },
  },
  {
    // Turn-control reliability: cancellation belongs to one concrete run
    // attempt, not to a reusable chat session forever. `kill_switches` is kept
    // for compatibility with the Codex-loop callers, while the two additive
    // tables below carry the precise run/attempt identity used by interactive
    // channels and the Claude SDK brain.
    //
    // The terminal-key index makes a brain attempt's
    // `conversation_completed` append atomic/idempotent. A session legitimately
    // has many completion events across turns, so uniqueness is scoped to the
    // explicit terminalKey rather than merely (session,type).
    version: 7,
    sql: '',
    backfill: (db) => {
      const hasTable = (name: string): boolean => Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ).get(name));
      if (!hasTable('sessions')) return;
      db.exec(`
        CREATE TABLE IF NOT EXISTS run_attempts (
          attempt_id  TEXT PRIMARY KEY,
          session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          run_id      TEXT,
          started_at  TEXT NOT NULL,
          finished_at TEXT,
          status      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_run_attempts_session_active
          ON run_attempts(session_id, finished_at, started_at DESC);

        CREATE TABLE IF NOT EXISTS run_kill_requests (
          session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          attempt_id  TEXT REFERENCES run_attempts(attempt_id) ON DELETE CASCADE,
          run_id      TEXT,
          requested_at TEXT NOT NULL,
          reason      TEXT
        );
      `);
      if (hasTable('events')) {
        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_events_terminal_key
            ON events(session_id, type, json_extract(data_json, '$.terminalKey'))
            WHERE type = 'conversation_completed'
              AND json_extract(data_json, '$.terminalKey') IS NOT NULL;
        `);
      }
    },
  },
  {
    // Desktop POST idempotency: the client owns request_id before sending, and
    // this durable receipt binds it to the server-created session, run identity,
    // original SSE cursor, and exact payload. A retry after a lost 202 or daemon
    // restart therefore rejoins the same turn instead of starting a second run.
    version: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS harness_chat_requests (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL UNIQUE,
        input_hash TEXT NOT NULL,
        since_seq INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_harness_chat_requests_session
        ON harness_chat_requests(session_id, created_at DESC);
    `,
  },
  {
    // A durable request receipt is only half of restart safety: an unfinished
    // attempt also needs bounded ownership. The desktop route renews this
    // lease while its process is alive; a new daemon interrupts foreign-owner
    // attempts at startup, and an expired lease can be reclaimed. This keeps a
    // crash between the 202 and terminal event from making a replay inert
    // forever, without permitting a second executor while the first is alive.
    version: 9,
    sql: '',
    backfill: (db) => {
      const hasAttempts = Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_attempts'`,
      ).get());
      if (!hasAttempts) return;
      const columns = new Set(
        (db.prepare('PRAGMA table_info(run_attempts)').all() as Array<{ name: string }>).map((row) => row.name),
      );
      if (!columns.has('lease_owner')) db.exec('ALTER TABLE run_attempts ADD COLUMN lease_owner TEXT');
      if (!columns.has('lease_expires_at')) db.exec('ALTER TABLE run_attempts ADD COLUMN lease_expires_at TEXT');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_run_attempts_lease
        ON run_attempts(finished_at, lease_expires_at)`);
    },
  },
  {
    // A run attempt must point at the exact user-input event that created it.
    // Timestamps are not an identity: a reusable desktop chat can receive a new
    // input while the prior attempt is still the newest row, and recovery/UI
    // projections otherwise guess the wrong scope. Keep this additive so old
    // attempts remain valid (NULL means the historical source was not recorded).
    version: 10,
    sql: '',
    backfill: (db) => {
      const hasAttempts = Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_attempts'`,
      ).get());
      if (!hasAttempts) return;
      const columns = new Set(
        (db.prepare('PRAGMA table_info(run_attempts)').all() as Array<{ name: string }>).map((row) => row.name),
      );
      if (!columns.has('source_user_seq')) {
        db.exec('ALTER TABLE run_attempts ADD COLUMN source_user_seq INTEGER REFERENCES events(seq)');
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_run_attempts_source_user
        ON run_attempts(session_id, source_user_seq)`);
    },
  },
  {
    // A reusable chat can briefly have attempt A still executing while attempt
    // B is accepted (for example, Move to background followed by a new message).
    // The v7 kill table used PRIMARY KEY(session_id), so B could overwrite or
    // clear A's stop before A observed it. Store independent latches per target;
    // session-scoped rows remain only as the legacy/no-active compatibility
    // shape. The old kill_switch mirror is rebuilt from session rows so a v7
    // targeted latch cannot accidentally become a global stop after migration.
    version: 11,
    sql: '',
    backfill: (db) => {
      const hasTable = (name: string): boolean => Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ).get(name));
      const hasKillTable = hasTable('run_kill_requests');
      if (!hasKillTable) return;
      db.exec(`
        CREATE TABLE IF NOT EXISTS kill_switches (
          session_id   TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          requested_at TEXT NOT NULL,
          reason       TEXT
        );
        ALTER TABLE run_kill_requests RENAME TO run_kill_requests_v7;
        CREATE TABLE run_kill_requests (
          session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          scope_key    TEXT NOT NULL,
          attempt_id   TEXT REFERENCES run_attempts(attempt_id) ON DELETE CASCADE,
          run_id       TEXT,
          requested_at TEXT NOT NULL,
          reason       TEXT,
          PRIMARY KEY (session_id, scope_key)
        );
        CREATE INDEX idx_run_kill_requests_attempt
          ON run_kill_requests(attempt_id) WHERE attempt_id IS NOT NULL;
        CREATE INDEX idx_run_kill_requests_run
          ON run_kill_requests(session_id, run_id) WHERE run_id IS NOT NULL;

        INSERT INTO run_kill_requests
          (session_id, scope_key, attempt_id, run_id, requested_at, reason)
        SELECT session_id,
               CASE
                 WHEN attempt_id IS NOT NULL THEN 'attempt:' || attempt_id
                 WHEN run_id IS NOT NULL THEN 'run:' || run_id
                 ELSE 'session:*'
               END,
               attempt_id, run_id, requested_at, reason
          FROM run_kill_requests_v7;

        INSERT OR IGNORE INTO run_kill_requests
          (session_id, scope_key, attempt_id, run_id, requested_at, reason)
        SELECT legacy.session_id, 'session:*', NULL, NULL,
               legacy.requested_at, legacy.reason
          FROM kill_switches AS legacy
         WHERE NOT EXISTS (
           SELECT 1 FROM run_kill_requests AS scoped
            WHERE scoped.session_id = legacy.session_id
         );

        DROP TABLE run_kill_requests_v7;
        DELETE FROM kill_switches;
        INSERT INTO kill_switches (session_id, requested_at, reason)
        SELECT session_id, requested_at, reason
          FROM run_kill_requests
         WHERE scope_key = 'session:*';
      `);
      // Older builds could delete a session while foreign-key enforcement was
      // disabled, leaving unreachable approval/guardrail rows behind. They are
      // not recoverable execution state (their owning session no longer
      // exists), and they make `foreign_key_check` noisy on otherwise healthy
      // databases. Remove only those proven orphans; valid historical rows are
      // preserved exactly.
      if (hasTable('sessions') && hasTable('tool_guardrail_state')) {
        db.exec(`DELETE FROM tool_guardrail_state
          WHERE NOT EXISTS (
            SELECT 1 FROM sessions WHERE sessions.id = tool_guardrail_state.session_id
          )`);
      }
      if (hasTable('sessions') && hasTable('pending_approvals')) {
        db.exec(`DELETE FROM pending_approvals
          WHERE NOT EXISTS (
            SELECT 1 FROM sessions WHERE sessions.id = pending_approvals.session_id
          )`);
      }
    },
  },
  {
    // Artifact/resource truth and pre-acknowledgement Stop authority must be
    // present before a turn begins. The artifact ledger originally guarded its
    // tables with lazy CREATE statements; keep that repair path, but move the
    // canonical schema into this numbered migration. Chat cancellation rows
    // intentionally have no session FK because Stop can arrive before the
    // server has accepted the request and created/bound its session receipt.
    version: 12,
    sql: `
      CREATE TABLE IF NOT EXISTS run_artifacts (
        id             TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_scope_id   TEXT NOT NULL,
        slot_key       TEXT NOT NULL,
        kind           TEXT NOT NULL,
        provider       TEXT NOT NULL,
        title          TEXT,
        create_shape   TEXT NOT NULL,
        status         TEXT NOT NULL CHECK (status IN ('pending','bound','uncertain')),
        resource_id    TEXT,
        uri            TEXT,
        source_call_id TEXT,
        binding_verified_at TEXT,
        verification_call_id TEXT,
        verification_shape TEXT,
        verification_fingerprint TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        UNIQUE(session_id, run_scope_id, slot_key)
      );
      CREATE INDEX IF NOT EXISTS idx_run_artifacts_session
        ON run_artifacts(session_id, run_scope_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_run_artifacts_resource
        ON run_artifacts(provider, resource_id);

      CREATE TABLE IF NOT EXISTS artifact_run_scopes (
        session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        attempt_scope_id TEXT NOT NULL,
        root_scope_id    TEXT NOT NULL,
        source_user_seq  INTEGER NOT NULL DEFAULT 0,
        reason           TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        PRIMARY KEY(session_id, attempt_scope_id)
      );
      CREATE INDEX IF NOT EXISTS idx_artifact_run_scopes_user
        ON artifact_run_scopes(session_id, source_user_seq DESC, created_at DESC);

      CREATE TABLE IF NOT EXISTS artifact_source_roots (
        session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_user_seq INTEGER NOT NULL,
        root_scope_id   TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        PRIMARY KEY(session_id, source_user_seq)
      );

      CREATE TABLE IF NOT EXISTS harness_chat_request_cancellations (
        request_id   TEXT PRIMARY KEY,
        requested_at TEXT NOT NULL,
        reason       TEXT
      );
    `,
    backfill: (db) => {
      // Some installs already have the original lazy run_artifacts table. Add
      // proof columns in place and preserve every existing resource pointer.
      const columns = new Set(
        (db.prepare('PRAGMA table_info(run_artifacts)').all() as Array<{ name: string }>).map((row) => row.name),
      );
      for (const [name, declaration] of [
        ['binding_verified_at', 'binding_verified_at TEXT'],
        ['verification_call_id', 'verification_call_id TEXT'],
        ['verification_shape', 'verification_shape TEXT'],
        ['verification_fingerprint', 'verification_fingerprint TEXT'],
      ] as const) {
        if (!columns.has(name)) db.exec(`ALTER TABLE run_artifacts ADD COLUMN ${declaration}`);
      }

      // Retain the established root for an old attempt-scoped ledger. The
      // earliest row is authoritative; do not guess a new root during upgrade.
      // Partially recovered legacy fixtures may not have their sessions table;
      // leave their empty child tables repairable instead of invoking the FK.
      const hasSessions = Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`,
      ).get());
      if (!hasSessions) return;
      db.exec(`
        INSERT OR IGNORE INTO artifact_source_roots
          (session_id, source_user_seq, root_scope_id, created_at)
        SELECT s.session_id, s.source_user_seq, s.root_scope_id, s.created_at
          FROM artifact_run_scopes s
         WHERE s.source_user_seq > 0
           AND EXISTS (
             SELECT 1 FROM sessions owner WHERE owner.id = s.session_id
           )
           AND NOT EXISTS (
             SELECT 1
               FROM artifact_run_scopes earlier
              WHERE earlier.session_id = s.session_id
                AND earlier.source_user_seq = s.source_user_seq
                AND (
                  earlier.created_at < s.created_at
                  OR (earlier.created_at = s.created_at AND earlier.rowid < s.rowid)
                )
           );
      `);
    },
  },
  {
    // session_locks was left as a knowing vestige by the 2026-07-09 subtraction
    // (withSessionLock removed; CREATE kept "inert"). The 2026-07-22 legacy
    // sweep confirmed zero readers/writers remain — close the loop.
    version: 13,
    sql: 'DROP TABLE IF EXISTS session_locks;',
  },
  {
    // A fresh human approval may authorize one deliberate duplicate send, but
    // it is not standing permission for unlimited later replays. Keep this
    // consumption independent from the workflow payload-consumption column:
    // the approval gate may consume `consumed_at` immediately before the
    // duplicate wall evaluates the same approved call.
    version: 14,
    sql: '',
    backfill(db) {
      const table = db.prepare(`
        SELECT 1 AS present
          FROM sqlite_master
         WHERE type = 'table' AND name = 'pending_approvals'
      `).get() as { present: number } | undefined;
      if (!table) return;
      const columns = new Set(
        (db.prepare('PRAGMA table_info(pending_approvals)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has('resend_consumed_at')) {
        db.exec('ALTER TABLE pending_approvals ADD COLUMN resend_consumed_at TEXT');
        columns.add('resend_consumed_at');
      }
      if (
        ['session_id', 'resolved_at', 'status', 'resolution', 'resend_consumed_at']
          .every((column) => columns.has(column))
      ) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_pending_approvals_resend_consent
            ON pending_approvals(session_id, resolved_at DESC)
            WHERE status = 'resolved'
              AND resolution = 'approved'
              AND resend_consumed_at IS NULL
        `);
      }
    },
  },
  {
    // Physical model attempts are cancelable transports, not dispatch
    // authority. A provider can acknowledge cancel and still deliver a late
    // tool call after a retry/recovery has begun. Keep one durable generation
    // per execution scope so every process (including the Claude local-MCP
    // child) can reject work from a superseded generation before bookkeeping
    // or provider dispatch.
    version: 15,
    sql: `
      CREATE TABLE IF NOT EXISTS run_dispatch_leases (
        scope_id       TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        lease_id       TEXT NOT NULL,
        run_attempt_id TEXT REFERENCES run_attempts(attempt_id) ON DELETE CASCADE,
        activated_at   TEXT NOT NULL,
        revoked_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_run_dispatch_leases_session
        ON run_dispatch_leases(session_id, revoked_at);
    `,
  },
  {
    // Internal provider retries own a child generation rather than borrowing
    // the caller's shared lease. Persist the exact parent so a parent revoke
    // invalidates every query child across in-process and stdio MCP transports.
    version: 16,
    sql: '',
    backfill: (db) => {
      const table = db.prepare(`
        SELECT 1 AS present
          FROM sqlite_master
         WHERE type = 'table' AND name = 'run_dispatch_leases'
      `).get() as { present: number } | undefined;
      if (!table) return;
      const columns = new Set(
        (db.prepare('PRAGMA table_info(run_dispatch_leases)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has('parent_scope_id')) {
        db.exec('ALTER TABLE run_dispatch_leases ADD COLUMN parent_scope_id TEXT');
      }
      if (!columns.has('parent_lease_id')) {
        db.exec('ALTER TABLE run_dispatch_leases ADD COLUMN parent_lease_id TEXT');
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_run_dispatch_leases_parent
          ON run_dispatch_leases(parent_scope_id, parent_lease_id)
      `);
    },
  },
  {
    // One public terminal belongs to one accepted user_input_received event,
    // even across rolling upgrades where an older process still writes the
    // former brain:<attempt> key. A trigger can be installed safely when a
    // historical database already contains duplicate rows (a UNIQUE index
    // cannot); it prevents every future writer, including an old binary, from
    // adding another terminal for an already-settled logical source.
    version: 17,
    sql: '',
    backfill: (db) => {
      const hasEvents = Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'`,
      ).get());
      if (!hasEvents) return;
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_events_one_terminal_per_user_source
        BEFORE INSERT ON events
        WHEN NEW.type = 'conversation_completed'
          AND COALESCE(
            json_extract(NEW.data_json, '$.sourceUserSeq'),
            json_extract(NEW.data_json, '$.presentation.identity.sourceUserSeq')
          ) IS NOT NULL
          AND EXISTS (
            SELECT 1
              FROM events AS settled
             WHERE settled.session_id = NEW.session_id
               AND settled.type = 'conversation_completed'
               AND COALESCE(
                 json_extract(settled.data_json, '$.sourceUserSeq'),
                 json_extract(settled.data_json, '$.presentation.identity.sourceUserSeq')
               ) = COALESCE(
                 json_extract(NEW.data_json, '$.sourceUserSeq'),
                 json_extract(NEW.data_json, '$.presentation.identity.sourceUserSeq')
               )
          )
        BEGIN
          SELECT RAISE(ABORT, 'logical terminal source already exists');
        END;
      `);
    },
  },
  {
    // One verified/success settlement per exact pre-dispatch reservation. New
    // writers carry settlementKey; historical rows remain untouched so an
    // additive upgrade never rewrites ambiguous external-effect history.
    version: 18,
    sql: '',
    backfill: (db) => {
      // Partially recovered/legacy fixtures can legitimately carry a newer
      // schema_version row while the canonical event table is absent. Keep the
      // additive migration tolerant, matching the guarded v7/v17 indexes.
      const hasEvents = Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'`,
      ).get());
      if (hasEvents) {
        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_events_external_write_settlement_key
            ON events(session_id, type, json_extract(data_json, '$.settlementKey'))
            WHERE type = 'external_write_succeeded'
              AND json_extract(data_json, '$.settlementKey') IS NOT NULL;
        `);
      }
      const hasArtifacts = Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_artifacts'`,
      ).get());
      if (!hasArtifacts) return;
      const columns = new Set(
        (db.prepare('PRAGMA table_info(run_artifacts)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      for (const [name, declaration] of [
        ['external_write_event_id', 'external_write_event_id TEXT'],
        ['external_write_action_key', 'external_write_action_key TEXT'],
        ['external_write_tool_name', 'external_write_tool_name TEXT'],
      ] as const) {
        if (!columns.has(name)) db.exec(`ALTER TABLE run_artifacts ADD COLUMN ${declaration}`);
      }
    },
  },
  {
    // Exact settlement/readback bytes need invocation identity stronger than an
    // SDK call id. Keep them in a parallel nonce-keyed store so concurrent or
    // reused call ids cannot overwrite one another, while the legacy call-id
    // recall store retains its backwards-compatible longest-output behavior.
    // v19 is deliberately separate: local canary databases ran an earlier v18
    // while this patch was under review.
    version: 19,
    sql: `
      CREATE TABLE IF NOT EXISTS tool_output_invocations (
        session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        call_id             TEXT NOT NULL,
        invocation_nonce    TEXT NOT NULL,
        tool                TEXT,
        output_full         TEXT NOT NULL,
        content_bytes       INTEGER NOT NULL,
        truncated_at_write  INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL,
        PRIMARY KEY (session_id, call_id, invocation_nonce)
      );
      CREATE INDEX IF NOT EXISTS idx_tool_output_invocations_session
        ON tool_output_invocations(session_id, created_at);
    `,
  },
  {
    // Authority lookups sit on completion, grounding, artifact verification,
    // and memory-write boundaries.  A long-horizon session can contain tens of
    // thousands of tool events, so resolving one call id must not deserialize
    // the entire session.  Index the durable SDK presentation id directly.
    version: 20,
    sql: '',
    backfill: (db) => {
      // Upgrade rehearsals intentionally construct only the table relevant to
      // the historical version under test. Keep that compatibility while a
      // real harness database (which always has events) gets the hot-path index.
      const hasEvents = Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'`,
      ).get());
      if (!hasEvents) return;
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_events_tool_lifecycle_call
          ON events(session_id, type, json_extract(data_json, '$.callId'), seq)
          WHERE type IN ('tool_called', 'tool_returned');
      `);
    },
  },
  {
    // Discovery is a per-accepted-source resource, not a per-process courtesy.
    // Persist both policy and the category claim so daemon restarts and
    // concurrent workers cannot silently reset or double-spend its allowance.
    version: 21,
    sql: `
      CREATE TABLE IF NOT EXISTS discovery_governor_tasks (
        session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_user_seq   INTEGER NOT NULL CHECK (source_user_seq > 0),
        known_capability  INTEGER NOT NULL CHECK (known_capability IN (0, 1)),
        initialized_at    TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        PRIMARY KEY (session_id, source_user_seq)
      );

      CREATE TABLE IF NOT EXISTS discovery_governor_claims (
        session_id       TEXT NOT NULL,
        source_user_seq  INTEGER NOT NULL,
        category         TEXT NOT NULL
                         CHECK (category IN ('broad_discovery', 'exact_schema_refresh')),
        call_id          TEXT NOT NULL,
        outcome          TEXT NOT NULL DEFAULT 'pending'
                         CHECK (outcome IN ('pending', 'succeeded', 'empty', 'failed', 'timed_out')),
        outcome_detail   TEXT,
        admitted_at      TEXT NOT NULL,
        settled_at       TEXT,
        PRIMARY KEY (session_id, source_user_seq, category),
        FOREIGN KEY (session_id, source_user_seq)
          REFERENCES discovery_governor_tasks(session_id, source_user_seq)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_discovery_governor_claims_call
        ON discovery_governor_claims(session_id, source_user_seq, call_id);
    `,
  },
  {
    // Clem 4 accepted-task evidence authority.
    //
    // Resolution is mutable state (open -> finalized), so unlike telemetry it
    // belongs in normalized rows with database-enforced ownership. Operation
    // admission, the mirror event, and finalization are committed by the domain
    // API in one IMMEDIATE transaction. A process crash therefore cannot leave
    // an event claiming a transition the state machine did not make, or vice
    // versa. Raw provider arguments never enter these tables.
    version: 22,
    sql: `
      -- Existing feature code created this table lazily. Fresh homes get the
      -- complete schema here; the guarded backfill below upgrades partial dev
      -- schemas without pretending an old two-column claim carried evidence.
      CREATE TABLE IF NOT EXISTS obligation_transitions (
        obligation_key       TEXT PRIMARY KEY,
        session_id           TEXT NOT NULL,
        source_user_seq      INTEGER NOT NULL,
        manifest_id          TEXT NOT NULL,
        node_id              TEXT NOT NULL,
        obligation           TEXT NOT NULL,
        receipt_id           TEXT NOT NULL,
        physical_attempt_id  TEXT NOT NULL,
        logical_tool_call_id TEXT,
        physical_dispatch_id TEXT,
        claimed_at           TEXT NOT NULL
      );

      -- Compatibility only. It ceases to be settlement authority in the next
      -- slice, but centralizing its schema prevents another lazy-schema fork.
      CREATE TABLE IF NOT EXISTS settlement_claims (
        settlement_key TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL,
        claimed_at     TEXT NOT NULL
      );
    `,
    backfill: (db) => {
      // Upgrade rehearsals intentionally construct only the historical table
      // under test. A resolution cannot exist without the canonical events
      // spine, so do not create FKs to a table that fixture does not contain.
      const hasEvents = Boolean(db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'`,
      ).get());
      if (hasEvents) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS accepted_task_resolutions (
            session_id                TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            source_user_seq           INTEGER NOT NULL CHECK (source_user_seq > 0),
            accepted_task_id          TEXT NOT NULL UNIQUE,
            graph_event_id            TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
            graph_id                  TEXT NOT NULL,
            graph_hash                TEXT NOT NULL,
            compiler_version          TEXT NOT NULL,
            route                     TEXT NOT NULL CHECK (route IN ('direct_reply','retrieve','act')),
            work_node_id              TEXT,
            work_kind                 TEXT NOT NULL CHECK (work_kind IN ('conversation','retrieve','execute','fanout')),
            effect_ceiling            TEXT NOT NULL,
            external_effect_requested INTEGER NOT NULL CHECK (external_effect_requested IN (0, 1)),
            external_effect_kinds_json TEXT NOT NULL DEFAULT '[]',
            state                     TEXT NOT NULL DEFAULT 'open'
                                      CHECK (state IN ('open','finalized','legacy_ambiguous')),
            revision                  INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
            operation_count           INTEGER NOT NULL DEFAULT 0 CHECK (operation_count >= 0),
            operations_digest         TEXT,
            expectations_satisfied    INTEGER CHECK (expectations_satisfied IN (0, 1)),
            opened_at                 TEXT NOT NULL,
            finalized_at              TEXT,
            finalize_event_id         TEXT REFERENCES events(id) ON DELETE RESTRICT,
            PRIMARY KEY (session_id, source_user_seq)
          );

          CREATE TABLE IF NOT EXISTS accepted_task_operations (
            session_id             TEXT NOT NULL,
            source_user_seq        INTEGER NOT NULL,
            operation_id           TEXT NOT NULL,
            logical_tool_call_id   TEXT NOT NULL,
            graph_node_id          TEXT NOT NULL,
            resolved_tool          TEXT NOT NULL,
            effect_kind            TEXT NOT NULL
                                   CHECK (effect_kind IN ('read','compute','local_write','external_write','admin','unknown')),
            reversibility          TEXT NOT NULL
                                   CHECK (reversibility IN ('read_only','reversible','irreversible','not_applicable','unknown')),
            effect_source          TEXT NOT NULL,
            argument_keys_json     TEXT NOT NULL DEFAULT '[]',
            argument_digest        TEXT NOT NULL,
            physical_dispatch_id  TEXT,
            outcome_kind           TEXT,
            dispatch_state         TEXT CHECK (dispatch_state IN ('not_started','dispatched')),
            recorded_at            TEXT NOT NULL,
            operation_event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
            PRIMARY KEY (session_id, source_user_seq, operation_id),
            UNIQUE (session_id, source_user_seq, logical_tool_call_id),
            FOREIGN KEY (session_id, source_user_seq)
              REFERENCES accepted_task_resolutions(session_id, source_user_seq)
              ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_accepted_task_operations_effect
            ON accepted_task_operations(session_id, source_user_seq, effect_kind);
        `);
      }

      const table = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'obligation_transitions'`,
      ).get();
      if (!table) return;
      const columns = new Set(
        (db.prepare('PRAGMA table_info(obligation_transitions)').all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      const required = [
        'obligation_key', 'session_id', 'source_user_seq', 'manifest_id', 'node_id',
        'obligation', 'receipt_id', 'physical_attempt_id', 'logical_tool_call_id',
        'physical_dispatch_id', 'claimed_at',
      ];
      const missing = required.filter((name) => !columns.has(name));
      if (missing.length === 0) {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_obligation_transitions_task
          ON obligation_transitions(session_id, source_user_seq)`);
        return;
      }

      const priorAuthorityColumns = required.filter((name) =>
        name !== 'logical_tool_call_id' && name !== 'physical_dispatch_id');
      if (priorAuthorityColumns.every((name) => columns.has(name))) {
        // The immediately preceding schema is complete authority and only lacks
        // the corrected identity names. Preserve every row; the legacy
        // physical_attempt_id is compatibility data and is deliberately NOT
        // copied into physical_dispatch_id.
        if (!columns.has('logical_tool_call_id')) {
          db.exec('ALTER TABLE obligation_transitions ADD COLUMN logical_tool_call_id TEXT');
        }
        if (!columns.has('physical_dispatch_id')) {
          db.exec('ALTER TABLE obligation_transitions ADD COLUMN physical_dispatch_id TEXT');
        }
        db.exec(`CREATE INDEX IF NOT EXISTS idx_obligation_transitions_task
          ON obligation_transitions(session_id, source_user_seq)`);
        return;
      }

      // Keep the incompatible rows for forensic inspection. Their absent owner,
      // manifest, receipt, and attempt fields cannot be reconstructed honestly,
      // so none are promoted into terminal authority.
      const legacyExists = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'obligation_transitions_legacy_v21'`,
      ).get();
      if (!legacyExists) {
        db.exec('ALTER TABLE obligation_transitions RENAME TO obligation_transitions_legacy_v21');
      } else {
        db.exec('DROP TABLE obligation_transitions');
      }
      db.exec(`
        CREATE TABLE obligation_transitions (
          obligation_key       TEXT PRIMARY KEY,
          session_id           TEXT NOT NULL,
          source_user_seq      INTEGER NOT NULL,
          manifest_id          TEXT NOT NULL,
          node_id              TEXT NOT NULL,
          obligation           TEXT NOT NULL,
          receipt_id           TEXT NOT NULL,
          physical_attempt_id  TEXT NOT NULL,
          logical_tool_call_id TEXT,
          physical_dispatch_id TEXT,
          claimed_at           TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_obligation_transitions_task
          ON obligation_transitions(session_id, source_user_seq);
      `);
    },
  },
  {
    // Clem 4 logical-call and paid-crossing authority. Inserting a physical
    // dispatch is the permission to let control leave for a provider, not
    // merely telemetry. Domain APIs mirror events in the same transaction and
    // refuse provider I/O when this state cannot be committed.
    version: 23,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (
        !tables.has('sessions')
        || !tables.has('events')
        || !tables.has('accepted_task_resolutions')
      ) return;
      db.exec(`
        CREATE TABLE IF NOT EXISTS logical_tool_calls (
          session_id           TEXT NOT NULL,
          source_user_seq      INTEGER NOT NULL,
          accepted_task_id     TEXT NOT NULL,
          logical_tool_call_id TEXT NOT NULL,
          tool_name            TEXT NOT NULL,
          argument_digest      TEXT NOT NULL,
          state                TEXT NOT NULL DEFAULT 'open'
                               CHECK (state IN ('open','settled','conflict')),
          opened_at            TEXT NOT NULL,
          settled_at           TEXT,
          settlement_event_id  TEXT REFERENCES events(id) ON DELETE RESTRICT,
          outcome_kind         TEXT,
          PRIMARY KEY (session_id, source_user_seq, logical_tool_call_id),
          FOREIGN KEY (session_id, source_user_seq)
            REFERENCES accepted_task_resolutions(session_id, source_user_seq)
            ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS physical_dispatches (
          session_id           TEXT NOT NULL,
          source_user_seq      INTEGER NOT NULL,
          accepted_task_id     TEXT NOT NULL,
          logical_tool_call_id TEXT NOT NULL,
          physical_dispatch_id TEXT NOT NULL,
          ordinal              INTEGER NOT NULL CHECK (ordinal > 0),
          relation             TEXT NOT NULL
                               CHECK (relation IN ('primary','retry','poll','probe','child')),
          retry_of             TEXT,
          tool_name            TEXT NOT NULL,
          argument_digest      TEXT NOT NULL,
          state                TEXT NOT NULL DEFAULT 'started'
                               CHECK (state IN ('started','returned','threw','timed_out','cancelled','unknown')),
          started_at           TEXT NOT NULL,
          settled_at           TEXT,
          start_event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
          settle_event_id      TEXT REFERENCES events(id) ON DELETE RESTRICT,
          PRIMARY KEY (session_id, source_user_seq, physical_dispatch_id),
          UNIQUE (session_id, source_user_seq, logical_tool_call_id, ordinal),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_tool_calls(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_physical_dispatches_open
          ON physical_dispatches(session_id, source_user_seq, state);
        CREATE INDEX IF NOT EXISTS idx_physical_dispatches_logical
          ON physical_dispatches(session_id, source_user_seq, logical_tool_call_id, ordinal);
      `);
    },
  },
  {
    // Clem 4 atomic logical-call settlement.  Migration 23 established paid
    // crossing admission, but left logical settlement as a separate legacy
    // claim plus a best-effort event.  These normalized rows let one domain
    // transaction freeze the exact semantic result and every paid crossing,
    // mirror it once, and close the logical call by CAS.
    //
    // Do not promote `settlement_claims`: those rows carry neither accepted
    // source, result, contract nor crossing evidence and cannot be upgraded
    // honestly.  They remain forensic compatibility data until cutover.
    version: 24,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      // Historical migration rehearsals intentionally contain no event spine.
      // Keep them sparse.  A real harness database has both tables; on that
      // spine a missing v23 authority table is corruption, not an optional
      // feature, so abort without stamping this migration as applied.
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'accepted_task_resolutions',
        'logical_tool_calls',
        'physical_dispatches',
      ]) {
        if (!tables.has(prerequisite)) {
          throw new Error(`schema v24 prerequisite missing: ${prerequisite}`);
        }
      }

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_physical_dispatch_exact_parent
          ON physical_dispatches(
            session_id, source_user_seq, logical_tool_call_id, physical_dispatch_id
          );

        CREATE UNIQUE INDEX IF NOT EXISTS uq_logical_call_settlement_event
          ON logical_tool_calls(settlement_event_id)
          WHERE settlement_event_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS logical_call_settlements (
          session_id                TEXT NOT NULL,
          source_user_seq           INTEGER NOT NULL CHECK (source_user_seq > 0),
          logical_tool_call_id      TEXT NOT NULL,
          protocol_version          INTEGER NOT NULL CHECK (protocol_version = 1),
          semantic_digest           TEXT NOT NULL CHECK (length(semantic_digest) = 64),
          execution_kind            TEXT NOT NULL
                                    CHECK (execution_kind IN (
                                      'refused_pre_dispatch',
                                      'local_execution',
                                      'provider_execution'
                                    )),
          outcome_kind              TEXT NOT NULL
                                    CHECK (outcome_kind IN (
                                      'succeeded','invalid_arguments','transient',
                                      'unsupported_capability','ignored_requirement',
                                      'input_required','auth_failure','policy_denial',
                                      'uncertain_write','empty_result','unknown'
                                    )),
          outcome_evidence          TEXT NOT NULL
                                    CHECK (outcome_evidence IN ('nominal','structured','text')),
          provider_status           TEXT CHECK (provider_status IS NULL OR length(provider_status) <= 64),
          outcome_detail            TEXT CHECK (outcome_detail IS NULL OR length(outcome_detail) <= 160),
          business_call             INTEGER NOT NULL CHECK (business_call IN (0, 1)),
          mutating                  INTEGER NOT NULL CHECK (mutating IN (0, 1)),
          requirement_id            TEXT CHECK (requirement_id IS NULL OR length(requirement_id) <= 256),
          continues_requirement     INTEGER NOT NULL CHECK (continues_requirement IN (0, 1)),
          recovery_action           TEXT NOT NULL
                                    CHECK (recovery_action IN (
                                      'settle','repair_arguments','retry_with_backoff',
                                      'try_sibling_candidate','ask_user','recover_connection',
                                      'stop_and_explain','reconcile_then_decide'
                                    )),
          retry_same_candidate      INTEGER NOT NULL CHECK (retry_same_candidate IN (0, 1)),
          eliminates_candidate      INTEGER NOT NULL CHECK (eliminates_candidate IN (0, 1)),
          discovery_epoch_requested INTEGER NOT NULL CHECK (discovery_epoch_requested IN (0, 1)),
          requires_reconciliation   INTEGER NOT NULL CHECK (requires_reconciliation IN (0, 1)),
          progress_key_digest       TEXT CHECK (
                                      progress_key_digest IS NULL OR length(progress_key_digest) = 64
                                    ),
          progress_claimed          INTEGER NOT NULL CHECK (progress_claimed IN (0, 1)),
          physical_crossing_count   INTEGER NOT NULL CHECK (physical_crossing_count >= 0),
          physical_crossings_digest TEXT NOT NULL CHECK (length(physical_crossings_digest) = 64),
          observer_lane             TEXT NOT NULL
                                    CHECK (observer_lane IN (
                                      'agents_runner','native_mcp','claude_sdk',
                                      'composio','code_mode','byo'
                                    )),
          observer_call_id          TEXT CHECK (observer_call_id IS NULL OR length(observer_call_id) <= 256),
          settlement_event_id       TEXT NOT NULL UNIQUE
                                    REFERENCES events(id) ON DELETE RESTRICT,
          settled_at                TEXT NOT NULL,
          PRIMARY KEY (session_id, source_user_seq, logical_tool_call_id),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_tool_calls(
              session_id, source_user_seq, logical_tool_call_id
            ) ON DELETE CASCADE,
          CHECK (
            (execution_kind IN ('refused_pre_dispatch','local_execution')
              AND physical_crossing_count = 0)
            OR
            (execution_kind = 'provider_execution'
              AND physical_crossing_count > 0)
          ),
          CHECK (
            execution_kind != 'refused_pre_dispatch'
            OR outcome_kind NOT IN ('succeeded','empty_result','uncertain_write')
          ),
          CHECK (progress_claimed = 0 OR progress_key_digest IS NOT NULL)
        );

        CREATE TABLE IF NOT EXISTS logical_call_settlement_crossings (
          session_id            TEXT NOT NULL,
          source_user_seq       INTEGER NOT NULL,
          logical_tool_call_id  TEXT NOT NULL,
          physical_dispatch_id  TEXT NOT NULL,
          ordinal               INTEGER NOT NULL CHECK (ordinal > 0),
          relation              TEXT NOT NULL
                                CHECK (relation IN ('primary','retry','poll','probe','child')),
          retry_of              TEXT,
          tool_name             TEXT NOT NULL,
          argument_digest       TEXT NOT NULL CHECK (length(argument_digest) = 64),
          PRIMARY KEY (
            session_id, source_user_seq,
            logical_tool_call_id, physical_dispatch_id
          ),
          UNIQUE (session_id, source_user_seq, logical_tool_call_id, ordinal),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_call_settlements(
              session_id, source_user_seq, logical_tool_call_id
            ) ON DELETE CASCADE,
          FOREIGN KEY (
            session_id, source_user_seq,
            logical_tool_call_id, physical_dispatch_id
          ) REFERENCES physical_dispatches(
            session_id, source_user_seq,
            logical_tool_call_id, physical_dispatch_id
          ) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS logical_call_progress_claims (
          session_id           TEXT NOT NULL,
          source_user_seq      INTEGER NOT NULL,
          progress_key_digest TEXT NOT NULL CHECK (length(progress_key_digest) = 64),
          logical_tool_call_id TEXT NOT NULL,
          claimed_at           TEXT NOT NULL,
          PRIMARY KEY (session_id, source_user_seq, progress_key_digest),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_call_settlements(
              session_id, source_user_seq, logical_tool_call_id
            ) ON DELETE CASCADE
        );

        CREATE TRIGGER IF NOT EXISTS trg_physical_dispatch_requires_open_logical
        BEFORE INSERT ON physical_dispatches
        WHEN NOT EXISTS (
          SELECT 1 FROM logical_tool_calls
           WHERE session_id = NEW.session_id
             AND source_user_seq = NEW.source_user_seq
             AND logical_tool_call_id = NEW.logical_tool_call_id
             AND accepted_task_id = NEW.accepted_task_id
             AND state = 'open'
        )
        BEGIN
          SELECT RAISE(ABORT, 'physical dispatch requires its exact open logical parent');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_physical_dispatch_identity_immutable
        BEFORE UPDATE OF accepted_task_id, logical_tool_call_id,
                         physical_dispatch_id, ordinal, relation, retry_of,
                         tool_name, argument_digest
        ON physical_dispatches
        WHEN OLD.accepted_task_id IS NOT NEW.accepted_task_id
          OR OLD.logical_tool_call_id IS NOT NEW.logical_tool_call_id
          OR OLD.physical_dispatch_id IS NOT NEW.physical_dispatch_id
          OR OLD.ordinal IS NOT NEW.ordinal
          OR OLD.relation IS NOT NEW.relation
          OR OLD.retry_of IS NOT NEW.retry_of
          OR OLD.tool_name IS NOT NEW.tool_name
          OR OLD.argument_digest IS NOT NEW.argument_digest
        BEGIN
          SELECT RAISE(ABORT, 'physical dispatch identity is immutable');
        END;
      `);
    },
  },
  {
    // Settlement is also the recovery linearization point. Keep the governor
    // decision beside the normalized call so a crash cannot durably settle a
    // failed candidate while losing the discovery epoch that makes recovery
    // possible (or credit a step without its one task-scoped progress claim).
    version: 25,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      if (!tables.has('logical_call_settlements')) {
        throw new Error('schema v25 prerequisite missing: logical_call_settlements');
      }
      const columns = new Set(
        (db.prepare('PRAGMA table_info(logical_call_settlements)').all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!columns.has('governor_evidence_kind')) {
        db.exec(`
          ALTER TABLE logical_call_settlements ADD COLUMN governor_evidence_kind TEXT
            CHECK (governor_evidence_kind IS NULL OR governor_evidence_kind IN (
              'candidate_unsupported','candidate_unavailable','catalog_revision_changed',
              'auth_recovered','capability_satisfied','user_input_provided'
            ));
          ALTER TABLE logical_call_settlements ADD COLUMN governor_evidence_detail TEXT;
          ALTER TABLE logical_call_settlements ADD COLUMN governor_requires_progress INTEGER NOT NULL DEFAULT 0
            CHECK (governor_requires_progress IN (0, 1));
          ALTER TABLE logical_call_settlements ADD COLUMN governor_outcome TEXT
            CHECK (governor_outcome IS NULL OR governor_outcome IN (
              'epoch_opened','epoch_already_fresh','epoch_ceiling_reached','task_not_initialized'
            ));
          ALTER TABLE logical_call_settlements ADD COLUMN opened_discovery_epoch INTEGER NOT NULL DEFAULT 0
            CHECK (opened_discovery_epoch IN (0, 1));
          ALTER TABLE logical_call_settlements ADD COLUMN credited_progress INTEGER NOT NULL DEFAULT 0
            CHECK (credited_progress IN (0, 1));
        `);
      }
    },
  },
  {
    // Per-accepted-source cutover state. Presence is not inferred from a
    // manifest: a source is explicitly armed before provider work, so losing a
    // later manifest can never fall through to legacy success. Manifest freeze,
    // repair grants, and terminal publication advance this row by CAS.
    version: 26,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      db.exec(`
        CREATE TABLE IF NOT EXISTS accepted_task_authority (
          session_id             TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          source_user_seq        INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id       TEXT NOT NULL UNIQUE,
          authority_protocol     INTEGER NOT NULL CHECK (authority_protocol = 1),
          graph_event_id         TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
          graph_id               TEXT NOT NULL,
          graph_hash             TEXT NOT NULL,
          state                  TEXT NOT NULL DEFAULT 'armed'
                                 CHECK (state IN ('armed','manifested_verifying','terminal','conflict')),
          manifest_id            TEXT,
          revision               INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
          repair_grants_used     INTEGER NOT NULL DEFAULT 0 CHECK (repair_grants_used BETWEEN 0 AND 1),
          repair_grant_id        TEXT,
          repair_grant_status    TEXT NOT NULL DEFAULT 'none'
                                 CHECK (repair_grant_status IN ('none','issued','consumed')),
          repair_grant_issued_at TEXT,
          repair_grant_consumed_at TEXT,
          terminal_event_id      TEXT REFERENCES events(id) ON DELETE RESTRICT,
          backstop_event_id      TEXT REFERENCES events(id) ON DELETE RESTRICT,
          armed_at               TEXT NOT NULL,
          updated_at             TEXT NOT NULL,
          PRIMARY KEY (session_id, source_user_seq),
          CHECK (
            (repair_grant_status = 'none' AND repair_grant_id IS NULL AND repair_grants_used = 0)
            OR
            (repair_grant_status IN ('issued','consumed') AND repair_grant_id IS NOT NULL AND repair_grants_used = 1)
          ),
          CHECK (state = 'armed' OR state = 'conflict' OR manifest_id IS NOT NULL)
        );

        CREATE INDEX IF NOT EXISTS idx_accepted_task_authority_state
          ON accepted_task_authority(state, updated_at);

        CREATE TRIGGER IF NOT EXISTS trg_accepted_task_authority_identity_immutable
        BEFORE UPDATE ON accepted_task_authority
        WHEN OLD.session_id IS NOT NEW.session_id
          OR OLD.source_user_seq IS NOT NEW.source_user_seq
          OR OLD.accepted_task_id IS NOT NEW.accepted_task_id
          OR OLD.authority_protocol IS NOT NEW.authority_protocol
          OR OLD.graph_event_id IS NOT NEW.graph_event_id
          OR OLD.graph_id IS NOT NEW.graph_id
          OR OLD.graph_hash IS NOT NEW.graph_hash
        BEGIN
          SELECT RAISE(ABORT, 'accepted task authority identity is immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_accepted_task_authority_state_machine
        BEFORE UPDATE OF state ON accepted_task_authority
        WHEN OLD.state IS NOT NEW.state AND NOT (
          (OLD.state = 'armed' AND NEW.state IN ('manifested_verifying','conflict'))
          OR (OLD.state = 'manifested_verifying' AND NEW.state IN ('terminal','conflict'))
        )
        BEGIN
          SELECT RAISE(ABORT, 'invalid accepted task authority transition');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_accepted_task_authority_grant_monotonic
        BEFORE UPDATE OF repair_grants_used ON accepted_task_authority
        WHEN NEW.repair_grants_used < OLD.repair_grants_used
          OR NEW.repair_grants_used > OLD.repair_grants_used + 1
        BEGIN
          SELECT RAISE(ABORT, 'terminal repair grant count is monotonic');
        END;
      `);
    },
  },
  {
    // Durable result authority. Provider payloads and opaque continuations used
    // to live in process-local Maps, so a restart made an apparently valid
    // handle irredeemable and removed the only host-side copy of its cursor.
    // Authoritative rows are tied to the exact accepted source, logical call,
    // physical crossing and canonical base call. A legacy-unscoped mode exists
    // only for projection helpers that have not entered a dispatch boundary;
    // those rows can never satisfy task-scoped redemption.
    version: 27,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'accepted_task_resolutions',
        'logical_tool_calls',
        'physical_dispatches',
      ]) {
        if (!tables.has(prerequisite)) {
          throw new Error(`schema v27 prerequisite missing: ${prerequisite}`);
        }
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS durable_result_handles (
          handle_id              TEXT PRIMARY KEY,
          scope_kind             TEXT NOT NULL
                                 CHECK (scope_kind IN ('authoritative','legacy_unscoped')),
          session_id             TEXT,
          source_user_seq        INTEGER,
          accepted_task_id       TEXT,
          logical_tool_call_id   TEXT,
          physical_dispatch_id   TEXT,
          continuation_chain_id  TEXT NOT NULL
                                 CHECK (length(continuation_chain_id) BETWEEN 1 AND 256),
          tool_name              TEXT NOT NULL,
          argument_digest        TEXT NOT NULL CHECK (length(argument_digest) = 64),
          base_argument_digest   TEXT NOT NULL CHECK (length(base_argument_digest) = 64),
          raw_location           TEXT UNIQUE,
          raw_payload_json       TEXT,
          raw_payload_sha256     TEXT CHECK (
                                   raw_payload_sha256 IS NULL OR length(raw_payload_sha256) = 64
                                 ),
          raw_byte_count         INTEGER NOT NULL CHECK (raw_byte_count >= 0),
          rejection_reason       TEXT CHECK (rejection_reason IN (
                                   'unserializable','oversized','cursor_oversized','raw_store_skipped'
                                 )),
          success                INTEGER NOT NULL CHECK (success IN (0, 1)),
          record_path            TEXT,
          record_count           INTEGER NOT NULL CHECK (record_count >= 0),
          envelope_meta_json     TEXT,
          completeness           TEXT NOT NULL CHECK (completeness IN ('complete','partial','unknown')),
          projected_records_json TEXT NOT NULL,
          status_code            INTEGER,
          continuation_ref       TEXT UNIQUE,
          cursor_bytes           BLOB,
          cursor_sha256          TEXT CHECK (cursor_sha256 IS NULL OR length(cursor_sha256) = 64),
          cursor_repeated        INTEGER NOT NULL DEFAULT 0 CHECK (cursor_repeated IN (0, 1)),
          created_at             TEXT NOT NULL,
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id, physical_dispatch_id)
            REFERENCES physical_dispatches(
              session_id, source_user_seq, logical_tool_call_id, physical_dispatch_id
            ) ON DELETE CASCADE,
          CHECK (
            (scope_kind = 'authoritative'
              AND session_id IS NOT NULL
              AND source_user_seq IS NOT NULL AND source_user_seq > 0
              AND accepted_task_id IS NOT NULL
              AND logical_tool_call_id IS NOT NULL
              AND physical_dispatch_id IS NOT NULL)
            OR
            (scope_kind = 'legacy_unscoped'
              AND session_id IS NULL
              AND source_user_seq IS NULL
              AND accepted_task_id IS NULL
              AND logical_tool_call_id IS NULL
              AND physical_dispatch_id IS NULL)
          ),
          CHECK (
            (raw_payload_json IS NOT NULL
              AND raw_location IS NOT NULL
              AND raw_payload_sha256 IS NOT NULL
              AND rejection_reason IS NULL)
            OR
            (raw_payload_json IS NULL
              AND raw_location IS NULL
              AND rejection_reason IS NOT NULL)
          ),
          CHECK (
            (continuation_ref IS NULL AND cursor_bytes IS NULL AND cursor_sha256 IS NULL
              AND cursor_repeated = 0)
            OR
            (continuation_ref IS NOT NULL AND cursor_bytes IS NOT NULL
              AND cursor_sha256 IS NOT NULL)
          )
        );

        CREATE UNIQUE INDEX IF NOT EXISTS uq_durable_result_physical
          ON durable_result_handles(
            session_id, source_user_seq, logical_tool_call_id, physical_dispatch_id
          )
          WHERE scope_kind = 'authoritative';

        CREATE INDEX IF NOT EXISTS idx_durable_result_cursor_history
          ON durable_result_handles(
            session_id, source_user_seq, continuation_chain_id,
            base_argument_digest, cursor_sha256, created_at
          )
          WHERE cursor_sha256 IS NOT NULL;

        CREATE TRIGGER IF NOT EXISTS trg_durable_result_exact_authority
        BEFORE INSERT ON durable_result_handles
        WHEN NEW.scope_kind = 'authoritative' AND NOT EXISTS (
          SELECT 1
            FROM physical_dispatches p
           WHERE p.session_id = NEW.session_id
             AND p.source_user_seq = NEW.source_user_seq
             AND p.accepted_task_id = NEW.accepted_task_id
             AND p.logical_tool_call_id = NEW.logical_tool_call_id
             AND p.physical_dispatch_id = NEW.physical_dispatch_id
             AND p.tool_name = NEW.tool_name
             AND p.argument_digest = NEW.argument_digest
             AND p.state = 'returned'
        )
        BEGIN
          SELECT RAISE(ABORT, 'durable result requires its exact returned physical crossing');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_durable_result_base_immutable
        BEFORE INSERT ON durable_result_handles
        WHEN NEW.scope_kind = 'authoritative' AND EXISTS (
          SELECT 1
            FROM durable_result_handles h
           WHERE h.scope_kind = 'authoritative'
             AND h.session_id = NEW.session_id
             AND h.source_user_seq = NEW.source_user_seq
             AND h.continuation_chain_id = NEW.continuation_chain_id
             AND (h.tool_name IS NOT NEW.tool_name
               OR h.base_argument_digest IS NOT NEW.base_argument_digest)
        )
        BEGIN
          SELECT RAISE(ABORT, 'durable result base call is immutable per logical call');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_durable_result_identity_immutable
        BEFORE UPDATE ON durable_result_handles
        BEGIN
          SELECT RAISE(ABORT, 'durable result handles are immutable');
        END;
      `);
    },
  },
  {
    // A logical invocation enters before policy and resolver gates with the
    // exact model/carrier arguments, but trusted host resolution may replace
    // references, remove routing-only metadata, or materialize strict nullable
    // fields before provider I/O. Preserve both value-opaque digests and allow
    // one monotonic raw -> effective transition before the first crossing.
    version: 28,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'accepted_task_resolutions',
        'logical_tool_calls',
        'physical_dispatches',
        'logical_call_settlements',
      ]) {
        if (!tables.has(prerequisite)) {
          throw new Error(`schema v28 prerequisite missing: ${prerequisite}`);
        }
      }
      const columns = new Set(
        (db.prepare('PRAGMA table_info(logical_tool_calls)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has('raw_argument_digest')) {
        db.exec('ALTER TABLE logical_tool_calls ADD COLUMN raw_argument_digest TEXT');
      }
      if (!columns.has('effective_argument_digest')) {
        db.exec('ALTER TABLE logical_tool_calls ADD COLUMN effective_argument_digest TEXT');
      }
      if (!columns.has('refined_at')) {
        db.exec('ALTER TABLE logical_tool_calls ADD COLUMN refined_at TEXT');
      }
      if (!columns.has('refinement_event_id')) {
        db.exec(`ALTER TABLE logical_tool_calls ADD COLUMN refinement_event_id TEXT
          REFERENCES events(id) ON DELETE RESTRICT`);
      }
      db.exec(`
        UPDATE logical_tool_calls
           SET raw_argument_digest = argument_digest
         WHERE raw_argument_digest IS NULL;

        CREATE UNIQUE INDEX IF NOT EXISTS uq_logical_call_refinement_event
          ON logical_tool_calls(refinement_event_id)
          WHERE refinement_event_id IS NOT NULL;

        CREATE TRIGGER IF NOT EXISTS trg_logical_call_contract_insert_valid
        BEFORE INSERT ON logical_tool_calls
        WHEN NEW.raw_argument_digest IS NULL
          OR length(NEW.raw_argument_digest) != 64
          OR NEW.argument_digest IS NOT NEW.raw_argument_digest
          OR NEW.effective_argument_digest IS NOT NULL
          OR NEW.refined_at IS NOT NULL
          OR NEW.refinement_event_id IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'new logical call requires one exact raw contract');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_logical_call_contract_identity_immutable
        BEFORE UPDATE OF accepted_task_id, logical_tool_call_id, tool_name, raw_argument_digest
        ON logical_tool_calls
        WHEN OLD.accepted_task_id IS NOT NEW.accepted_task_id
          OR OLD.logical_tool_call_id IS NOT NEW.logical_tool_call_id
          OR OLD.tool_name IS NOT NEW.tool_name
          OR OLD.raw_argument_digest IS NOT NEW.raw_argument_digest
        BEGIN
          SELECT RAISE(ABORT, 'logical call raw contract identity is immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_logical_call_contract_refinement_once
        BEFORE UPDATE OF argument_digest, effective_argument_digest,
                         refined_at, refinement_event_id
        ON logical_tool_calls
        WHEN NOT (
          OLD.state = 'open'
          AND NEW.state = 'open'
          AND OLD.argument_digest = OLD.raw_argument_digest
          AND OLD.effective_argument_digest IS NULL
          AND OLD.refined_at IS NULL
          AND OLD.refinement_event_id IS NULL
          AND NEW.raw_argument_digest = OLD.raw_argument_digest
          AND NEW.effective_argument_digest IS NOT NULL
          AND length(NEW.effective_argument_digest) = 64
          AND NEW.argument_digest = NEW.effective_argument_digest
          AND NEW.argument_digest != NEW.raw_argument_digest
          AND NEW.refined_at IS NOT NULL
          AND NEW.refinement_event_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM accepted_task_resolutions r
             WHERE r.session_id = OLD.session_id
               AND r.source_user_seq = OLD.source_user_seq
               AND r.accepted_task_id = OLD.accepted_task_id
               AND r.state = 'open'
          )
          AND NOT EXISTS (
            SELECT 1 FROM physical_dispatches p
             WHERE p.session_id = OLD.session_id
               AND p.source_user_seq = OLD.source_user_seq
               AND p.logical_tool_call_id = OLD.logical_tool_call_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM logical_call_settlements s
             WHERE s.session_id = OLD.session_id
               AND s.source_user_seq = OLD.source_user_seq
               AND s.logical_tool_call_id = OLD.logical_tool_call_id
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'logical call contract refinement is not monotonic');
        END;
      `);
    },
  },
  {
    // Immutable expected-work authority for one exact accepted source.
    //
    // This is deliberately separate from accepted_task_operations: expected
    // work is fixed before business dispatch, while observed calls may only
    // discharge it later.  The nullable marker on accepted_task_authority is a
    // staged cutover — direct/retrieve turns can bind now, while action turns
    // remain on the existing runtime until the bounded planner seam exists.
    version: 29,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      if (!tables.has('accepted_task_authority')) {
        throw new Error('schema v29 prerequisite missing: accepted_task_authority');
      }
      const authorityColumns = new Set(
        (db.prepare('PRAGMA table_info(accepted_task_authority)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!authorityColumns.has('work_contract_id')) {
        db.exec('ALTER TABLE accepted_task_authority ADD COLUMN work_contract_id TEXT');
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS accepted_task_work_contracts (
          session_id         TEXT NOT NULL,
          source_user_seq    INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id   TEXT NOT NULL UNIQUE,
          contract_version   INTEGER NOT NULL CHECK (contract_version = 1),
          contract_id        TEXT NOT NULL UNIQUE CHECK (length(contract_id) = 81),
          graph_event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
          graph_id           TEXT NOT NULL,
          graph_hash         TEXT NOT NULL CHECK (length(graph_hash) = 64),
          planner_source     TEXT NOT NULL
                             CHECK (planner_source IN ('deterministic','structured_model')),
          contract_json      TEXT NOT NULL,
          operation_count    INTEGER NOT NULL CHECK (operation_count BETWEEN 0 AND 32),
          universe_count     INTEGER NOT NULL CHECK (universe_count BETWEEN 0 AND 16),
          fixed_at           TEXT NOT NULL,
          PRIMARY KEY (session_id, source_user_seq),
          FOREIGN KEY (session_id, source_user_seq)
            REFERENCES accepted_task_authority(session_id, source_user_seq)
            ON DELETE CASCADE
        );

        CREATE TRIGGER IF NOT EXISTS trg_accepted_task_work_contract_exact_authority
        BEFORE INSERT ON accepted_task_work_contracts
        WHEN NOT EXISTS (
          SELECT 1 FROM accepted_task_authority a
           WHERE a.session_id = NEW.session_id
             AND a.source_user_seq = NEW.source_user_seq
             AND a.accepted_task_id = NEW.accepted_task_id
             AND a.graph_event_id = NEW.graph_event_id
             AND a.graph_id = NEW.graph_id
             AND a.graph_hash = NEW.graph_hash
             AND a.state != 'conflict'
        )
        BEGIN
          SELECT RAISE(ABORT, 'expected-work contract requires its exact accepted authority');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_accepted_task_work_contracts_update_immutable
        BEFORE UPDATE ON accepted_task_work_contracts
        BEGIN
          SELECT RAISE(ABORT, 'accepted task work contracts are immutable');
        END;

        -- Do not block DELETE here: session retention owns parent cascades.
        -- A standalone deletion leaves the authority's immutable contract id
        -- behind, so rehydration fails closed and no replacement can bind.

        CREATE TRIGGER IF NOT EXISTS trg_accepted_task_authority_contract_binding
        BEFORE UPDATE OF work_contract_id ON accepted_task_authority
        WHEN (
          OLD.work_contract_id IS NOT NULL
          AND OLD.work_contract_id IS NOT NEW.work_contract_id
        ) OR (
          NEW.work_contract_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM accepted_task_work_contracts c
             WHERE c.session_id = NEW.session_id
               AND c.source_user_seq = NEW.source_user_seq
               AND c.accepted_task_id = NEW.accepted_task_id
               AND c.graph_event_id = NEW.graph_event_id
               AND c.graph_id = NEW.graph_id
               AND c.graph_hash = NEW.graph_hash
               AND c.contract_id = NEW.work_contract_id
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'accepted task work-contract binding is invalid or immutable');
        END;
      `);
    },
  },
  {
    // Host-issued evidence authority. A successful result becomes evidence
    // only when the logical settlement names the handle in the same commit;
    // finding a handle later beside a returned crossing is not proof that it
    // was the result which closed the call. Read receipts then bind that exact
    // settlement result to one manifest node and one declared obligation.
    version: 30,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'accepted_task_authority',
        'logical_tool_calls',
        'physical_dispatches',
        'logical_call_settlements',
        'logical_call_settlement_crossings',
        'durable_result_handles',
        'obligation_transitions',
      ]) {
        if (!tables.has(prerequisite)) {
          throw new Error(`schema v30 prerequisite missing: ${prerequisite}`);
        }
      }

      const settlementColumns = new Set(
        (db.prepare('PRAGMA table_info(logical_call_settlements)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!settlementColumns.has('result_handle_id')) {
        db.exec(`ALTER TABLE logical_call_settlements ADD COLUMN result_handle_id TEXT
          REFERENCES durable_result_handles(handle_id) ON DELETE RESTRICT`);
      }

      // Promote only rows whose immutable settlement mirror named the handle
      // and exact returned physical crossing at commit time. A plausible later
      // handle beside the same call remains null and therefore unredeemable.
      db.exec(`
        UPDATE logical_call_settlements AS s
           SET result_handle_id = (
             SELECT h.handle_id
               FROM events e
               JOIN durable_result_handles h
                 ON h.handle_id = json_extract(e.data_json, '$.resultHandleId')
               JOIN logical_tool_calls l
                 ON l.session_id = s.session_id
                AND l.source_user_seq = s.source_user_seq
                AND l.logical_tool_call_id = s.logical_tool_call_id
               JOIN physical_dispatches p
                 ON p.session_id = h.session_id
                AND p.source_user_seq = h.source_user_seq
                AND p.logical_tool_call_id = h.logical_tool_call_id
                AND p.physical_dispatch_id = h.physical_dispatch_id
              WHERE e.id = s.settlement_event_id
                AND e.session_id = s.session_id
                AND e.type = 'tool_attempt_settled'
                AND json_extract(e.data_json, '$.sourceUserSeq') = s.source_user_seq
                AND json_extract(e.data_json, '$.acceptedTaskId') = l.accepted_task_id
                AND json_extract(e.data_json, '$.logicalToolCallId') = s.logical_tool_call_id
                AND json_extract(e.data_json, '$.physicalDispatchId') = h.physical_dispatch_id
                AND h.scope_kind = 'authoritative'
                AND h.session_id = s.session_id
                AND h.source_user_seq = s.source_user_seq
                AND h.accepted_task_id = l.accepted_task_id
                AND h.logical_tool_call_id = s.logical_tool_call_id
                AND h.tool_name = l.tool_name
                AND h.argument_digest = l.argument_digest
                AND h.success = 1
                AND p.state = 'returned'
                AND p.ordinal = (
                  SELECT MAX(p2.ordinal) FROM physical_dispatches p2
                   WHERE p2.session_id = s.session_id
                     AND p2.source_user_seq = s.source_user_seq
                     AND p2.logical_tool_call_id = s.logical_tool_call_id
                )
              LIMIT 1
           )
         WHERE s.result_handle_id IS NULL
           AND s.execution_kind = 'provider_execution'
           AND s.outcome_kind IN ('succeeded','empty_result')
           AND EXISTS (
             SELECT 1 FROM events e
              WHERE e.id = s.settlement_event_id
                AND json_type(e.data_json, '$.resultHandleId') = 'text'
           );

        CREATE INDEX IF NOT EXISTS idx_logical_settlement_result_handle
          ON logical_call_settlements(result_handle_id)
          WHERE result_handle_id IS NOT NULL;

        CREATE TRIGGER IF NOT EXISTS trg_logical_settlement_result_required
        BEFORE INSERT ON logical_call_settlements
        WHEN (
          NEW.execution_kind = 'provider_execution'
          AND NEW.outcome_kind IN ('succeeded','empty_result')
          AND NEW.result_handle_id IS NULL
        ) OR (
          NOT (
            NEW.execution_kind = 'provider_execution'
            AND NEW.outcome_kind IN ('succeeded','empty_result')
          )
          AND NEW.result_handle_id IS NOT NULL
        )
        BEGIN
          SELECT RAISE(ABORT, 'logical settlement result-handle binding is inconsistent');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_logical_settlement_result_exact
        BEFORE INSERT ON logical_call_settlements
        WHEN NEW.result_handle_id IS NOT NULL AND NOT EXISTS (
          SELECT 1
            FROM durable_result_handles h
            JOIN logical_tool_calls l
              ON l.session_id = NEW.session_id
             AND l.source_user_seq = NEW.source_user_seq
             AND l.logical_tool_call_id = NEW.logical_tool_call_id
            JOIN physical_dispatches p
              ON p.session_id = h.session_id
             AND p.source_user_seq = h.source_user_seq
             AND p.logical_tool_call_id = h.logical_tool_call_id
             AND p.physical_dispatch_id = h.physical_dispatch_id
           WHERE h.handle_id = NEW.result_handle_id
             AND h.scope_kind = 'authoritative'
             AND h.session_id = NEW.session_id
             AND h.source_user_seq = NEW.source_user_seq
             AND h.accepted_task_id = l.accepted_task_id
             AND h.logical_tool_call_id = NEW.logical_tool_call_id
             AND h.tool_name = l.tool_name
             AND h.argument_digest = l.argument_digest
             AND h.success = 1
             AND p.state = 'returned'
             AND p.ordinal = (
               SELECT MAX(p2.ordinal) FROM physical_dispatches p2
                WHERE p2.session_id = NEW.session_id
                  AND p2.source_user_seq = NEW.source_user_seq
                  AND p2.logical_tool_call_id = NEW.logical_tool_call_id
             )
        )
        BEGIN
          SELECT RAISE(ABORT, 'logical settlement requires its exact returned result handle');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_logical_settlement_result_immutable
        BEFORE UPDATE OF result_handle_id ON logical_call_settlements
        WHEN OLD.result_handle_id IS NOT NEW.result_handle_id
        BEGIN
          SELECT RAISE(ABORT, 'logical settlement result handle is immutable');
        END;

        CREATE TABLE IF NOT EXISTS evidence_receipts (
          receipt_id             TEXT PRIMARY KEY,
          protocol_version       INTEGER NOT NULL CHECK (protocol_version = 1),
          semantic_digest        TEXT NOT NULL UNIQUE CHECK (length(semantic_digest) = 64),
          kind                   TEXT NOT NULL CHECK (kind IN ('observation','collection')),
          session_id             TEXT NOT NULL,
          source_user_seq        INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id       TEXT NOT NULL,
          manifest_id            TEXT NOT NULL,
          node_id                TEXT NOT NULL,
          obligation             TEXT NOT NULL CHECK (obligation IN ('source_observed','source_completeness')),
          logical_tool_call_id   TEXT NOT NULL,
          physical_dispatch_id   TEXT NOT NULL,
          result_handle_id       TEXT NOT NULL REFERENCES durable_result_handles(handle_id) ON DELETE RESTRICT,
          tool_name              TEXT NOT NULL,
          operation_mode         TEXT NOT NULL CHECK (operation_mode IN ('point_read','collection_read')),
          raw_payload_sha256     TEXT NOT NULL CHECK (length(raw_payload_sha256) = 64),
          raw_byte_count         INTEGER NOT NULL CHECK (raw_byte_count >= 0),
          record_identities_json TEXT NOT NULL,
          aggregate_digest       TEXT NOT NULL CHECK (length(aggregate_digest) = 64),
          completeness           TEXT NOT NULL CHECK (completeness IN ('complete','partial','unknown')),
          continuation_outstanding INTEGER NOT NULL CHECK (continuation_outstanding IN (0, 1)),
          cursor_repeated        INTEGER NOT NULL CHECK (cursor_repeated IN (0, 1)),
          receipt_event_id       TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
          issued_at              TEXT NOT NULL,
          UNIQUE (session_id, source_user_seq, manifest_id, node_id, obligation),
          FOREIGN KEY (session_id, source_user_seq)
            REFERENCES accepted_task_authority(session_id, source_user_seq) ON DELETE CASCADE,
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_call_settlements(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_evidence_receipts_task
          ON evidence_receipts(session_id, source_user_seq, manifest_id);

        CREATE TRIGGER IF NOT EXISTS trg_evidence_receipt_exact_authority
        BEFORE INSERT ON evidence_receipts
        WHEN NOT EXISTS (
          SELECT 1
            FROM accepted_task_authority a
            JOIN logical_call_settlements s
              ON s.session_id = a.session_id
             AND s.source_user_seq = a.source_user_seq
             AND s.logical_tool_call_id = NEW.logical_tool_call_id
            JOIN logical_tool_calls l
              ON l.session_id = s.session_id
             AND l.source_user_seq = s.source_user_seq
             AND l.logical_tool_call_id = s.logical_tool_call_id
            JOIN durable_result_handles h
              ON h.handle_id = s.result_handle_id
            JOIN events e
              ON e.id = NEW.receipt_event_id
           WHERE a.session_id = NEW.session_id
             AND a.source_user_seq = NEW.source_user_seq
             AND a.accepted_task_id = NEW.accepted_task_id
             AND a.manifest_id = NEW.manifest_id
             AND a.state = 'manifested_verifying'
             AND l.accepted_task_id = NEW.accepted_task_id
             AND l.state = 'settled'
             AND s.execution_kind = 'provider_execution'
             AND s.outcome_kind IN ('succeeded','empty_result')
             AND s.result_handle_id = NEW.result_handle_id
             AND h.scope_kind = 'authoritative'
             AND h.session_id = NEW.session_id
             AND h.source_user_seq = NEW.source_user_seq
             AND h.accepted_task_id = NEW.accepted_task_id
             AND h.logical_tool_call_id = NEW.logical_tool_call_id
             AND h.physical_dispatch_id = NEW.physical_dispatch_id
             AND h.tool_name = NEW.tool_name
             AND h.raw_payload_sha256 = NEW.raw_payload_sha256
             AND h.raw_byte_count = NEW.raw_byte_count
             AND h.success = 1
             AND e.session_id = NEW.session_id
             AND e.type = 'evidence_receipt'
             AND json_extract(e.data_json, '$.receiptId') = NEW.receipt_id
             AND json_extract(e.data_json, '$.sourceUserSeq') = NEW.source_user_seq
             AND json_extract(e.data_json, '$.acceptedTaskId') = NEW.accepted_task_id
             AND json_extract(e.data_json, '$.manifestId') = NEW.manifest_id
             AND json_extract(e.data_json, '$.nodeId') = NEW.node_id
             AND json_extract(e.data_json, '$.obligation') = NEW.obligation
             AND json_extract(e.data_json, '$.logicalToolCallId') = NEW.logical_tool_call_id
             AND json_extract(e.data_json, '$.physicalDispatchId') = NEW.physical_dispatch_id
             AND json_extract(e.data_json, '$.resultHandleId') = NEW.result_handle_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'evidence receipt requires exact manifested settlement authority');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_evidence_receipt_identity_immutable
        BEFORE UPDATE ON evidence_receipts
        BEGIN
          SELECT RAISE(ABORT, 'evidence receipts are immutable');
        END;
      `);
    },
  },
  {
    // A settlement is the normalized authority for outcome, requirement
    // routing, business-vs-discovery identity and continuation state. v30 made
    // its result-handle binding immutable; v31 closes the wider row so those
    // other fields cannot be rewritten beneath expected-work replay.
    version: 31,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      if (!tables.has('logical_call_settlements')) {
        throw new Error('schema v31 prerequisite missing: logical_call_settlements');
      }
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_logical_call_settlement_row_immutable
        BEFORE UPDATE ON logical_call_settlements
        BEGIN
          SELECT RAISE(ABORT, 'logical call settlements are immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_logical_call_settlement_delete_immutable
        BEFORE DELETE ON logical_call_settlements
        -- Parent session retention remains the one deletion authority. During
        -- its FK cascade the parent session row is already absent; a direct
        -- settlement/logical-call delete still sees the live parent and stops.
        WHEN EXISTS (
          SELECT 1 FROM sessions WHERE id = OLD.session_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'logical call settlements are immutable');
        END;
      `);
    },
  },
  {
    // Action expected-work admission. One immutable row binds an already-open,
    // zero-crossing logical call to the exact frozen semantic requirement it
    // is allowed to discharge. The same row carries the request-side witness
    // needed by read-evidence refinement; no parallel read authority exists.
    //
    // The two cleanup statements are deliberately parent-session based. A
    // live session may legitimately retain a historical run_attempt whose
    // source event was lost by an old/partial writer; that is degraded history,
    // not an orphan attempt. Only rows whose owning session is absent are
    // unreachable and safe to remove before foreign keys are relied upon.
    version: 32,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;

      if (tables.has('run_dispatch_leases')) {
        db.exec(`
          DELETE FROM run_dispatch_leases
           WHERE NOT EXISTS (
             SELECT 1 FROM sessions s WHERE s.id = run_dispatch_leases.session_id
           )
        `);
      }
      if (tables.has('run_attempts')) {
        db.exec(`
          DELETE FROM run_attempts
           WHERE NOT EXISTS (
             SELECT 1 FROM sessions s WHERE s.id = run_attempts.session_id
           )
        `);
      }

      for (const prerequisite of [
        'accepted_task_authority',
        'accepted_task_work_contracts',
        'logical_tool_calls',
        'physical_dispatches',
      ]) {
        if (!tables.has(prerequisite)) {
          throw new Error(`schema v32 prerequisite missing: ${prerequisite}`);
        }
      }

      const authorityColumns = new Set(
        (db.prepare('PRAGMA table_info(accepted_task_authority)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!authorityColumns.has('expected_work_required')) {
        db.exec(`ALTER TABLE accepted_task_authority
          ADD COLUMN expected_work_required INTEGER NOT NULL DEFAULT 0
          CHECK (expected_work_required IN (0, 1))`);
      }

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_accepted_task_expected_work_activation
        BEFORE UPDATE OF expected_work_required ON accepted_task_authority
        WHEN NOT (
          OLD.expected_work_required = NEW.expected_work_required
          OR (
            OLD.expected_work_required = 0
            AND NEW.expected_work_required = 1
            AND OLD.state = 'armed'
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'expected-work activation is one-way and requires armed authority');
        END;

        CREATE TABLE IF NOT EXISTS expected_work_call_bindings (
          session_id              TEXT NOT NULL,
          source_user_seq         INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id        TEXT NOT NULL,
          logical_tool_call_id    TEXT NOT NULL,
          contract_id             TEXT NOT NULL,
          requirement_id          TEXT NOT NULL,
          tool_name                TEXT NOT NULL,
          argument_digest          TEXT NOT NULL CHECK (length(argument_digest) = 64),
          effect_kind              TEXT NOT NULL
                                   CHECK (effect_kind IN ('read','compute','local_write','external_write','admin')),
          cardinality_kind         TEXT NOT NULL
                                   CHECK (cardinality_kind IN ('once','each','set')),
          universe_id              TEXT,
          universe_seal            TEXT
                                   CHECK (universe_seal IS NULL OR universe_seal IN ('accepted_input','complete_source_receipt')),
          universe_item_id         TEXT,
          universe_selector_json   TEXT,
          universe_member_digest   TEXT
                                   CHECK (universe_member_digest IS NULL OR length(universe_member_digest) = 64),
          universe_member_count    INTEGER
                                   CHECK (universe_member_count IS NULL OR universe_member_count > 0),
          input_source_kind        TEXT
                                   CHECK (input_source_kind IS NULL OR input_source_kind IN ('accepted_user_input','complete_source_receipt')),
          input_source_ref         TEXT,
          input_source_digest      TEXT
                                   CHECK (input_source_digest IS NULL OR length(input_source_digest) = 64),
          evidence_mode            TEXT
                                   CHECK (evidence_mode IS NULL OR evidence_mode IN ('point_read','collection_read','finite_read')),
          evidence_basis           TEXT,
          schema_fingerprint       TEXT,
          schema_digest            TEXT
                                   CHECK (schema_digest IS NULL OR length(schema_digest) = 64),
          bound_at                 TEXT NOT NULL,
          PRIMARY KEY (session_id, source_user_seq, logical_tool_call_id),
          FOREIGN KEY (session_id, source_user_seq)
            REFERENCES accepted_task_work_contracts(session_id, source_user_seq)
            ON DELETE CASCADE,
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_tool_calls(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE CASCADE,
          FOREIGN KEY (contract_id)
            REFERENCES accepted_task_work_contracts(contract_id)
            ON DELETE RESTRICT,
          CHECK (
            (cardinality_kind = 'once'
              AND universe_id IS NULL
              AND universe_seal IS NULL
              AND universe_item_id IS NULL
              AND universe_selector_json IS NULL
              AND universe_member_digest IS NULL
              AND universe_member_count IS NULL
              AND input_source_kind IS NULL
              AND input_source_ref IS NULL
              AND input_source_digest IS NULL)
            OR
            (cardinality_kind = 'each'
              AND universe_id IS NOT NULL
              AND universe_seal IS NOT NULL
              AND universe_item_id IS NOT NULL
              AND universe_selector_json IS NOT NULL
              AND json_valid(universe_selector_json)
              AND json_type(universe_selector_json) = 'object'
              AND universe_member_digest IS NOT NULL
              AND universe_member_count = 1
              AND input_source_kind IS NOT NULL
              AND input_source_ref IS NOT NULL
              AND input_source_digest IS NOT NULL)
            OR
            (cardinality_kind = 'set'
              AND universe_id IS NOT NULL
              AND universe_seal IS NOT NULL
              AND universe_item_id IS NULL
              AND universe_selector_json IS NOT NULL
              AND json_valid(universe_selector_json)
              AND json_type(universe_selector_json) = 'object'
              AND universe_member_digest IS NOT NULL
              AND universe_member_count > 0
              AND input_source_kind IS NOT NULL
              AND input_source_ref IS NOT NULL
              AND input_source_digest IS NOT NULL)
          ),
          CHECK (
            (evidence_mode IS NULL AND evidence_basis IS NULL)
            OR (evidence_mode IS NOT NULL AND evidence_basis IS NOT NULL)
          ),
          CHECK (
            (schema_fingerprint IS NULL AND schema_digest IS NULL)
            OR (schema_fingerprint IS NOT NULL AND schema_digest IS NOT NULL)
          )
        );

        CREATE INDEX IF NOT EXISTS idx_expected_work_call_bindings_requirement
          ON expected_work_call_bindings(
            session_id, source_user_seq, requirement_id, universe_item_id
          );

        CREATE TRIGGER IF NOT EXISTS trg_expected_work_call_binding_exact_authority
        BEFORE INSERT ON expected_work_call_bindings
        WHEN NOT EXISTS (
          SELECT 1
            FROM accepted_task_authority a
            JOIN accepted_task_work_contracts c
              ON c.session_id = a.session_id
             AND c.source_user_seq = a.source_user_seq
            JOIN logical_tool_calls l
              ON l.session_id = a.session_id
             AND l.source_user_seq = a.source_user_seq
             AND l.logical_tool_call_id = NEW.logical_tool_call_id
           WHERE a.session_id = NEW.session_id
             AND a.source_user_seq = NEW.source_user_seq
             AND a.accepted_task_id = NEW.accepted_task_id
             AND a.expected_work_required = 1
             AND a.work_contract_id = NEW.contract_id
             AND a.state = 'armed'
             AND c.contract_id = NEW.contract_id
             AND l.accepted_task_id = NEW.accepted_task_id
             AND l.tool_name = NEW.tool_name
             AND l.argument_digest = NEW.argument_digest
             AND l.state = 'open'
             AND NOT EXISTS (
               SELECT 1 FROM physical_dispatches p
                WHERE p.session_id = l.session_id
                  AND p.source_user_seq = l.source_user_seq
                  AND p.logical_tool_call_id = l.logical_tool_call_id
             )
        )
        BEGIN
          SELECT RAISE(ABORT, 'expected-work call binding requires exact open zero-crossing authority');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_expected_work_call_bindings_update_immutable
        BEFORE UPDATE ON expected_work_call_bindings
        BEGIN
          SELECT RAISE(ABORT, 'expected-work call bindings are immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_expected_work_call_bindings_delete_immutable
        BEFORE DELETE ON expected_work_call_bindings
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'expected-work call bindings are immutable');
        END;
      `);
    },
  },
  {
    // Provider-neutral write proof authority.  The pre-dispatch binding is
    // intentionally independent of an obligation manifest: selectors and
    // projections must be fixed before provider I/O, while the authoritative
    // manifest is only available after observed resolution closes.  A later
    // content-addressed proof receipt binds the immutable call contract to the
    // exact manifest node without rewriting either artifact.
    //
    // This migration performs no historical promotion or broad cleanup.  Old
    // event prose and external-write rows do not contain the schema, target,
    // exact input, or crossing identity needed to manufacture v33 authority.
    version: 33,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'accepted_task_authority',
        'accepted_task_work_contracts',
        'expected_work_call_bindings',
        'logical_tool_calls',
        'physical_dispatches',
        'logical_call_settlements',
        'durable_result_handles',
        'obligation_transitions',
      ]) {
        if (!tables.has(prerequisite)) {
          throw new Error(`schema v33 prerequisite missing: ${prerequisite}`);
        }
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS write_evidence_bindings (
          binding_id                  TEXT PRIMARY KEY CHECK (length(binding_id) = 81),
          protocol_version            INTEGER NOT NULL CHECK (protocol_version = 1),
          semantic_digest             TEXT NOT NULL UNIQUE CHECK (length(semantic_digest) = 64),
          session_id                  TEXT NOT NULL,
          source_user_seq             INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id            TEXT NOT NULL,
          work_contract_id            TEXT NOT NULL,
          requirement_id              TEXT NOT NULL,
          logical_tool_call_id        TEXT NOT NULL,
          tool_name                   TEXT NOT NULL,
          argument_digest             TEXT NOT NULL CHECK (length(argument_digest) = 64),
          effect_kind                 TEXT NOT NULL CHECK (effect_kind IN ('external_write','admin')),
          reversibility               TEXT NOT NULL CHECK (reversibility IN ('reversible','irreversible')),
          target_selector_json        TEXT NOT NULL CHECK (
                                         json_valid(target_selector_json)
                                         AND json_type(target_selector_json) = 'array'
                                       ),
          target_digest               TEXT NOT NULL CHECK (length(target_digest) = 64),
          write_input_json            TEXT NOT NULL CHECK (json_valid(write_input_json)),
          write_input_digest          TEXT NOT NULL CHECK (length(write_input_digest) = 64),
          input_schema_json           TEXT NOT NULL CHECK (json_valid(input_schema_json)),
          source_requirement_ids_json TEXT NOT NULL CHECK (
                                         json_valid(source_requirement_ids_json)
                                         AND json_type(source_requirement_ids_json) = 'array'
                                       ),
          verification_json           TEXT NOT NULL CHECK (
                                         json_valid(verification_json)
                                         AND json_type(verification_json) = 'object'
                                       ),
          schema_digest               TEXT NOT NULL CHECK (length(schema_digest) = 64),
          mapping_digest              TEXT NOT NULL CHECK (length(mapping_digest) = 64),
          frozen_at                   TEXT NOT NULL,
          UNIQUE (session_id, source_user_seq, logical_tool_call_id),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES expected_work_call_bindings(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE CASCADE,
          FOREIGN KEY (work_contract_id)
            REFERENCES accepted_task_work_contracts(contract_id) ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_write_evidence_bindings_task
          ON write_evidence_bindings(session_id, source_user_seq, requirement_id);

        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_binding_exact_authority
        BEFORE INSERT ON write_evidence_bindings
        WHEN NOT EXISTS (
          SELECT 1
            FROM expected_work_call_bindings b
            JOIN accepted_task_authority a
              ON a.session_id = b.session_id
             AND a.source_user_seq = b.source_user_seq
            JOIN logical_tool_calls l
              ON l.session_id = b.session_id
             AND l.source_user_seq = b.source_user_seq
             AND l.logical_tool_call_id = b.logical_tool_call_id
           WHERE b.session_id = NEW.session_id
             AND b.source_user_seq = NEW.source_user_seq
             AND b.logical_tool_call_id = NEW.logical_tool_call_id
             AND b.accepted_task_id = NEW.accepted_task_id
             AND b.contract_id = NEW.work_contract_id
             AND b.requirement_id = NEW.requirement_id
             AND b.tool_name = NEW.tool_name
             AND b.argument_digest = NEW.argument_digest
             AND b.effect_kind = NEW.effect_kind
             AND a.accepted_task_id = NEW.accepted_task_id
             AND a.work_contract_id = NEW.work_contract_id
             AND a.expected_work_required = 1
             AND a.state = 'armed'
             AND l.accepted_task_id = NEW.accepted_task_id
             AND l.tool_name = NEW.tool_name
             AND l.argument_digest = NEW.argument_digest
             AND l.state = 'open'
             AND NOT EXISTS (
               SELECT 1 FROM physical_dispatches p
                WHERE p.session_id = NEW.session_id
                  AND p.source_user_seq = NEW.source_user_seq
                  AND p.logical_tool_call_id = NEW.logical_tool_call_id
             )
        )
        BEGIN
          SELECT RAISE(ABORT, 'write evidence binding requires exact pre-dispatch work authority');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_bindings_update_immutable
        BEFORE UPDATE ON write_evidence_bindings
        BEGIN
          SELECT RAISE(ABORT, 'write evidence bindings are immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_bindings_delete_immutable
        BEFORE DELETE ON write_evidence_bindings
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'write evidence bindings are immutable');
        END;

        CREATE TABLE IF NOT EXISTS write_evidence_dispatch_reservations (
          reservation_id       TEXT PRIMARY KEY CHECK (length(reservation_id) = 85),
          binding_id           TEXT NOT NULL REFERENCES write_evidence_bindings(binding_id) ON DELETE CASCADE,
          session_id           TEXT NOT NULL,
          source_user_seq      INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id     TEXT NOT NULL,
          logical_tool_call_id TEXT NOT NULL,
          physical_dispatch_id TEXT NOT NULL,
          ordinal              INTEGER NOT NULL CHECK (ordinal > 0),
          target_digest        TEXT NOT NULL CHECK (length(target_digest) = 64),
          write_input_digest   TEXT NOT NULL CHECK (length(write_input_digest) = 64),
          reserved_at          TEXT NOT NULL,
          UNIQUE (session_id, source_user_seq, physical_dispatch_id),
          UNIQUE (binding_id, ordinal),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_tool_calls(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE CASCADE
        );

        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_reservation_exact_binding
        BEFORE INSERT ON write_evidence_dispatch_reservations
        WHEN NOT EXISTS (
          SELECT 1 FROM write_evidence_bindings b
           WHERE b.binding_id = NEW.binding_id
             AND b.session_id = NEW.session_id
             AND b.source_user_seq = NEW.source_user_seq
             AND b.accepted_task_id = NEW.accepted_task_id
             AND b.logical_tool_call_id = NEW.logical_tool_call_id
             AND b.target_digest = NEW.target_digest
             AND b.write_input_digest = NEW.write_input_digest
        )
        BEGIN
          SELECT RAISE(ABORT, 'write reservation conflicts with its frozen binding');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_bound_write_dispatch_requires_reservation
        BEFORE INSERT ON physical_dispatches
        WHEN EXISTS (
          SELECT 1 FROM write_evidence_bindings b
           WHERE b.session_id = NEW.session_id
             AND b.source_user_seq = NEW.source_user_seq
             AND b.logical_tool_call_id = NEW.logical_tool_call_id
        ) AND NOT EXISTS (
          SELECT 1
            FROM write_evidence_dispatch_reservations r
            JOIN write_evidence_bindings b ON b.binding_id = r.binding_id
           WHERE r.session_id = NEW.session_id
             AND r.source_user_seq = NEW.source_user_seq
             AND r.accepted_task_id = NEW.accepted_task_id
             AND r.logical_tool_call_id = NEW.logical_tool_call_id
             AND r.physical_dispatch_id = NEW.physical_dispatch_id
             AND r.ordinal = NEW.ordinal
             AND b.tool_name = NEW.tool_name
             AND b.argument_digest = NEW.argument_digest
        )
        BEGIN
          SELECT RAISE(ABORT, 'bound write dispatch requires an atomic reservation');
        END;

        CREATE TABLE IF NOT EXISTS write_evidence_dispatch_outcomes (
          outcome_id            TEXT PRIMARY KEY CHECK (length(outcome_id) = 81),
          reservation_id        TEXT NOT NULL UNIQUE
                                REFERENCES write_evidence_dispatch_reservations(reservation_id)
                                ON DELETE CASCADE,
          binding_id            TEXT NOT NULL REFERENCES write_evidence_bindings(binding_id) ON DELETE CASCADE,
          session_id            TEXT NOT NULL,
          source_user_seq       INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id      TEXT NOT NULL,
          logical_tool_call_id  TEXT NOT NULL,
          physical_dispatch_id  TEXT NOT NULL,
          kind                  TEXT NOT NULL CHECK (kind IN ('succeeded','failed','orphaned')),
          result_handle_id      TEXT REFERENCES durable_result_handles(handle_id) ON DELETE RESTRICT,
          settlement_event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
          target_digest         TEXT NOT NULL CHECK (length(target_digest) = 64),
          write_input_digest    TEXT NOT NULL CHECK (length(write_input_digest) = 64),
          recorded_at           TEXT NOT NULL,
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_call_settlements(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE RESTRICT,
          CHECK ((kind = 'succeeded' AND result_handle_id IS NOT NULL)
              OR (kind != 'succeeded' AND result_handle_id IS NULL))
        );

        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_outcome_exact_authority
        BEFORE INSERT ON write_evidence_dispatch_outcomes
        WHEN NOT EXISTS (
          SELECT 1
            FROM write_evidence_dispatch_reservations r
            JOIN write_evidence_bindings b ON b.binding_id = r.binding_id
            JOIN logical_call_settlements s
              ON s.session_id = r.session_id
             AND s.source_user_seq = r.source_user_seq
             AND s.logical_tool_call_id = r.logical_tool_call_id
            JOIN physical_dispatches p
              ON p.session_id = r.session_id
             AND p.source_user_seq = r.source_user_seq
             AND p.logical_tool_call_id = r.logical_tool_call_id
             AND p.physical_dispatch_id = r.physical_dispatch_id
           WHERE r.reservation_id = NEW.reservation_id
             AND r.binding_id = NEW.binding_id
             AND r.session_id = NEW.session_id
             AND r.source_user_seq = NEW.source_user_seq
             AND r.accepted_task_id = NEW.accepted_task_id
             AND r.logical_tool_call_id = NEW.logical_tool_call_id
             AND r.physical_dispatch_id = NEW.physical_dispatch_id
             AND r.target_digest = NEW.target_digest
             AND r.write_input_digest = NEW.write_input_digest
             AND s.settlement_event_id = NEW.settlement_event_id
             AND p.state != 'started'
             AND (
               (NEW.kind = 'succeeded'
                 AND p.state = 'returned'
                 AND s.execution_kind = 'provider_execution'
                 AND s.outcome_kind IN ('succeeded','empty_result')
                 AND s.result_handle_id = NEW.result_handle_id
                 AND EXISTS (
                   SELECT 1 FROM durable_result_handles h
                    WHERE h.handle_id = NEW.result_handle_id
                      AND h.session_id = NEW.session_id
                      AND h.source_user_seq = NEW.source_user_seq
                      AND h.accepted_task_id = NEW.accepted_task_id
                      AND h.logical_tool_call_id = NEW.logical_tool_call_id
                      AND h.physical_dispatch_id = NEW.physical_dispatch_id
                 ))
               OR
               (NEW.kind != 'succeeded'
                 AND s.outcome_kind NOT IN ('succeeded','empty_result'))
             )
        )
        BEGIN
          SELECT RAISE(ABORT, 'write outcome conflicts with reservation, settlement, or result');
        END;

        CREATE TABLE IF NOT EXISTS write_evidence_readback_bindings (
          readback_binding_id      TEXT PRIMARY KEY CHECK (length(readback_binding_id) = 90),
          binding_id               TEXT NOT NULL REFERENCES write_evidence_bindings(binding_id) ON DELETE CASCADE,
          session_id               TEXT NOT NULL,
          source_user_seq          INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id         TEXT NOT NULL,
          work_contract_id         TEXT NOT NULL,
          write_requirement_id     TEXT NOT NULL,
          read_requirement_id      TEXT NOT NULL,
          read_logical_tool_call_id TEXT NOT NULL,
          read_tool_name           TEXT NOT NULL,
          read_argument_digest     TEXT NOT NULL CHECK (length(read_argument_digest) = 64),
          target_selector_json     TEXT NOT NULL CHECK (
                                     json_valid(target_selector_json)
                                     AND json_type(target_selector_json) = 'array'
                                   ),
          target_digest            TEXT NOT NULL CHECK (length(target_digest) = 64),
          schema_digest            TEXT NOT NULL CHECK (length(schema_digest) = 64),
          verification_contract_id TEXT NOT NULL,
          frozen_at                TEXT NOT NULL,
          UNIQUE (binding_id, read_logical_tool_call_id),
          FOREIGN KEY (session_id, source_user_seq, read_logical_tool_call_id)
            REFERENCES expected_work_call_bindings(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE CASCADE
        );

        CREATE TRIGGER IF NOT EXISTS trg_write_readback_exact_authority
        BEFORE INSERT ON write_evidence_readback_bindings
        WHEN NOT EXISTS (
          SELECT 1
            FROM write_evidence_bindings w
            JOIN expected_work_call_bindings r
              ON r.session_id = w.session_id
             AND r.source_user_seq = w.source_user_seq
             AND r.logical_tool_call_id = NEW.read_logical_tool_call_id
            JOIN logical_tool_calls l
              ON l.session_id = r.session_id
             AND l.source_user_seq = r.source_user_seq
             AND l.logical_tool_call_id = r.logical_tool_call_id
           WHERE w.binding_id = NEW.binding_id
             AND w.session_id = NEW.session_id
             AND w.source_user_seq = NEW.source_user_seq
             AND w.accepted_task_id = NEW.accepted_task_id
             AND w.work_contract_id = NEW.work_contract_id
             AND w.requirement_id = NEW.write_requirement_id
             AND w.target_digest = NEW.target_digest
             AND w.binding_id = NEW.verification_contract_id
             AND r.accepted_task_id = NEW.accepted_task_id
             AND r.contract_id = NEW.work_contract_id
             AND r.requirement_id = NEW.read_requirement_id
             AND r.effect_kind = 'read'
             AND r.tool_name = NEW.read_tool_name
             AND r.argument_digest = NEW.read_argument_digest
             AND l.state = 'open'
             AND NOT EXISTS (
               SELECT 1 FROM physical_dispatches p
                WHERE p.session_id = NEW.session_id
                  AND p.source_user_seq = NEW.source_user_seq
                  AND p.logical_tool_call_id = NEW.read_logical_tool_call_id
             )
        )
        BEGIN
          SELECT RAISE(ABORT, 'readback binding requires exact pre-dispatch read authority');
        END;

        CREATE TABLE IF NOT EXISTS write_evidence_derivations (
          derivation_id             TEXT PRIMARY KEY CHECK (length(derivation_id) = 84),
          binding_id                TEXT NOT NULL UNIQUE REFERENCES write_evidence_bindings(binding_id) ON DELETE CASCADE,
          session_id                TEXT NOT NULL,
          source_user_seq           INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id          TEXT NOT NULL,
          work_contract_id          TEXT NOT NULL,
          requirement_id            TEXT NOT NULL,
          output_digest             TEXT NOT NULL CHECK (length(output_digest) = 64),
          transform_artifact_digest TEXT NOT NULL CHECK (length(transform_artifact_digest) = 64),
          source_count              INTEGER NOT NULL CHECK (source_count > 0),
          semantic_digest           TEXT NOT NULL UNIQUE CHECK (length(semantic_digest) = 64),
          recorded_at               TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS write_evidence_derivation_sources (
          derivation_id         TEXT NOT NULL REFERENCES write_evidence_derivations(derivation_id) ON DELETE CASCADE,
          session_id            TEXT NOT NULL,
          source_user_seq       INTEGER NOT NULL CHECK (source_user_seq > 0),
          requirement_id        TEXT NOT NULL,
          logical_tool_call_id  TEXT NOT NULL,
          result_handle_id      TEXT NOT NULL REFERENCES durable_result_handles(handle_id) ON DELETE RESTRICT,
          content_digest        TEXT NOT NULL CHECK (length(content_digest) = 64),
          PRIMARY KEY (derivation_id, requirement_id),
          UNIQUE (derivation_id, logical_tool_call_id),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_call_settlements(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS write_evidence_execution_snapshots (
          snapshot_id          TEXT PRIMARY KEY CHECK (length(snapshot_id) = 82),
          binding_id           TEXT NOT NULL UNIQUE REFERENCES write_evidence_bindings(binding_id) ON DELETE CASCADE,
          session_id           TEXT NOT NULL,
          source_user_seq      INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id     TEXT NOT NULL,
          executions_json      TEXT NOT NULL CHECK (
                                 json_valid(executions_json)
                                 AND json_type(executions_json) = 'array'
                               ),
          opened_ids_json      TEXT NOT NULL CHECK (
                                 json_valid(opened_ids_json)
                                 AND json_type(opened_ids_json) = 'array'
                               ),
          semantic_digest      TEXT NOT NULL UNIQUE CHECK (length(semantic_digest) = 64),
          recorded_at          TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS write_evidence_proofs (
          proof_id                   TEXT PRIMARY KEY CHECK (length(proof_id) = 82),
          protocol_version           INTEGER NOT NULL CHECK (protocol_version = 1),
          binding_id                 TEXT NOT NULL REFERENCES write_evidence_bindings(binding_id) ON DELETE RESTRICT,
          session_id                 TEXT NOT NULL,
          source_user_seq            INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id           TEXT NOT NULL,
          work_contract_id           TEXT NOT NULL,
          manifest_id                TEXT NOT NULL,
          node_id                    TEXT NOT NULL,
          requirement_id             TEXT NOT NULL,
          obligation                 TEXT NOT NULL CHECK (obligation IN (
                                             'derivation_from_current_source','commit_effect',
                                             'verify_committed_readback','stale_destination_reconciled',
                                             'verify_committed_receipt','execution_terminal'
                                           )),
          logical_tool_call_id       TEXT NOT NULL,
          anchor_physical_dispatch_id TEXT NOT NULL,
          target_digest              TEXT NOT NULL CHECK (length(target_digest) = 64),
          physical_dispatch_ids_json TEXT NOT NULL CHECK (
                                         json_valid(physical_dispatch_ids_json)
                                         AND json_type(physical_dispatch_ids_json) = 'array'
                                       ),
          evidence_digests_json      TEXT NOT NULL CHECK (
                                         json_valid(evidence_digests_json)
                                         AND json_type(evidence_digests_json) = 'array'
                                       ),
          proof_json                 TEXT NOT NULL CHECK (
                                         json_valid(proof_json)
                                         AND json_type(proof_json) = 'object'
                                       ),
          receipt_event_id           TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
          issued_at                  TEXT NOT NULL,
          UNIQUE (session_id, source_user_seq, manifest_id, node_id, obligation),
          FOREIGN KEY (session_id, source_user_seq)
            REFERENCES accepted_task_authority(session_id, source_user_seq) ON DELETE CASCADE,
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id, anchor_physical_dispatch_id)
            REFERENCES physical_dispatches(
              session_id, source_user_seq, logical_tool_call_id, physical_dispatch_id
            ) ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_write_evidence_proofs_task
          ON write_evidence_proofs(session_id, source_user_seq, manifest_id);

        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_proof_exact_authority
        BEFORE INSERT ON write_evidence_proofs
        WHEN NOT EXISTS (
          SELECT 1
            FROM write_evidence_bindings b
            JOIN accepted_task_authority a
              ON a.session_id = b.session_id
             AND a.source_user_seq = b.source_user_seq
            JOIN events e ON e.id = NEW.receipt_event_id
           WHERE b.binding_id = NEW.binding_id
             AND b.session_id = NEW.session_id
             AND b.source_user_seq = NEW.source_user_seq
             AND b.accepted_task_id = NEW.accepted_task_id
             AND b.work_contract_id = NEW.work_contract_id
             AND b.requirement_id = NEW.requirement_id
             AND b.logical_tool_call_id = NEW.logical_tool_call_id
             AND b.target_digest = NEW.target_digest
             AND a.accepted_task_id = NEW.accepted_task_id
             AND a.work_contract_id = NEW.work_contract_id
             AND a.manifest_id = NEW.manifest_id
             AND a.state = 'manifested_verifying'
             AND e.session_id = NEW.session_id
             AND e.type = 'write_evidence_proved'
             AND json_extract(e.data_json, '$.proofId') = NEW.proof_id
             AND json_extract(e.data_json, '$.sourceUserSeq') = NEW.source_user_seq
             AND json_extract(e.data_json, '$.acceptedTaskId') = NEW.accepted_task_id
             AND json_extract(e.data_json, '$.manifestId') = NEW.manifest_id
             AND json_extract(e.data_json, '$.nodeId') = NEW.node_id
             AND json_extract(e.data_json, '$.obligation') = NEW.obligation
        )
        BEGIN
          SELECT RAISE(ABORT, 'write proof requires exact manifested authority and event mirror');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_normalized_rows_immutable
        BEFORE UPDATE ON write_evidence_dispatch_reservations
        BEGIN SELECT RAISE(ABORT, 'write evidence reservations are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_outcomes_immutable
        BEFORE UPDATE ON write_evidence_dispatch_outcomes
        BEGIN SELECT RAISE(ABORT, 'write evidence outcomes are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_readbacks_immutable
        BEFORE UPDATE ON write_evidence_readback_bindings
        BEGIN SELECT RAISE(ABORT, 'write evidence readback bindings are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_derivations_immutable
        BEFORE UPDATE ON write_evidence_derivations
        BEGIN SELECT RAISE(ABORT, 'write evidence derivations are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_derivation_sources_immutable
        BEFORE UPDATE ON write_evidence_derivation_sources
        BEGIN SELECT RAISE(ABORT, 'write evidence derivation sources are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_execution_snapshots_immutable
        BEFORE UPDATE ON write_evidence_execution_snapshots
        BEGIN SELECT RAISE(ABORT, 'write evidence execution snapshots are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_proofs_immutable
        BEFORE UPDATE ON write_evidence_proofs
        BEGIN SELECT RAISE(ABORT, 'write evidence proofs are immutable'); END;

        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_reservations_delete_immutable
        BEFORE DELETE ON write_evidence_dispatch_reservations
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'write evidence reservations are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_outcomes_delete_immutable
        BEFORE DELETE ON write_evidence_dispatch_outcomes
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'write evidence outcomes are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_readbacks_delete_immutable
        BEFORE DELETE ON write_evidence_readback_bindings
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'write evidence readback bindings are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_derivations_delete_immutable
        BEFORE DELETE ON write_evidence_derivations
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'write evidence derivations are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_derivation_sources_delete_immutable
        BEFORE DELETE ON write_evidence_derivation_sources
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'write evidence derivation sources are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_execution_snapshots_delete_immutable
        BEFORE DELETE ON write_evidence_execution_snapshots
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'write evidence execution snapshots are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_write_evidence_proofs_delete_immutable
        BEFORE DELETE ON write_evidence_proofs
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'write evidence proofs are immutable'); END;
      `);
    },
  },
  {
    // Exact host completion authority for acknowledgement-only durable-memory
    // actions. The normalized receipt is independent of provider prose and is
    // bound to one accepted source, graph, memory episode, intake call, and
    // candidate-row digest. Historical telemetry is deliberately not
    // backfilled: it lacks enough evidence to manufacture this authority.
    version: 34,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      if (!tables.has('accepted_task_authority')) {
        throw new Error('schema v34 prerequisite missing: accepted_task_authority');
      }
      const authorityColumns = new Set(
        (db.prepare('PRAGMA table_info(accepted_task_authority)').all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!authorityColumns.has('host_completion_receipt_id')) {
        db.exec('ALTER TABLE accepted_task_authority ADD COLUMN host_completion_receipt_id TEXT');
      }
      if (!authorityColumns.has('host_completion_event_id')) {
        db.exec('ALTER TABLE accepted_task_authority ADD COLUMN host_completion_event_id TEXT REFERENCES events(id) ON DELETE RESTRICT');
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS durable_memory_intake_receipts (
          receipt_id             TEXT PRIMARY KEY
                                 CHECK (length(receipt_id) = 81 AND receipt_id LIKE 'memory-intake:v1:%'),
          protocol_version       INTEGER NOT NULL CHECK (protocol_version = 1),
          session_id             TEXT NOT NULL,
          source_user_seq        INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id       TEXT NOT NULL,
          graph_event_id         TEXT NOT NULL,
          graph_id               TEXT NOT NULL,
          graph_hash             TEXT NOT NULL CHECK (length(graph_hash) = 64),
          source_event_id        TEXT NOT NULL,
          source_message_digest  TEXT NOT NULL CHECK (length(source_message_digest) = 64),
          episode_id             TEXT NOT NULL,
          call_id                TEXT NOT NULL,
          episode_content_hash   TEXT NOT NULL CHECK (length(episode_content_hash) = 64),
          candidate_count        INTEGER NOT NULL CHECK (candidate_count > 0 AND candidate_count <= 3),
          candidate_digest       TEXT NOT NULL CHECK (length(candidate_digest) = 64),
          evidence_digest        TEXT NOT NULL CHECK (length(evidence_digest) = 64),
          receipt_json           TEXT NOT NULL CHECK (
                                   json_valid(receipt_json)
                                   AND json_type(receipt_json) = 'object'
                                 ),
          receipt_event_id       TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
          issued_at              TEXT NOT NULL,
          UNIQUE (session_id, source_user_seq),
          FOREIGN KEY (session_id, source_user_seq)
            REFERENCES accepted_task_authority(session_id, source_user_seq) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_durable_memory_intake_receipt_task
          ON durable_memory_intake_receipts(accepted_task_id);

        CREATE TRIGGER IF NOT EXISTS trg_durable_memory_intake_receipt_exact_authority
        BEFORE INSERT ON durable_memory_intake_receipts
        WHEN NOT EXISTS (
          SELECT 1
            FROM accepted_task_authority a
            JOIN events e ON e.id = NEW.receipt_event_id
           WHERE a.session_id = NEW.session_id
             AND a.source_user_seq = NEW.source_user_seq
             AND a.accepted_task_id = NEW.accepted_task_id
             AND a.graph_event_id = NEW.graph_event_id
             AND a.graph_id = NEW.graph_id
             AND a.graph_hash = NEW.graph_hash
             AND a.state = 'armed'
             AND a.expected_work_required = 1
             AND a.work_contract_id IS NULL
             AND a.host_completion_receipt_id IS NULL
             AND e.session_id = NEW.session_id
             AND e.type = 'durable_memory_intake_receipt'
             AND json_extract(e.data_json, '$.receiptId') = NEW.receipt_id
             AND json_extract(e.data_json, '$.sourceUserSeq') = NEW.source_user_seq
             AND json_extract(e.data_json, '$.acceptedTaskId') = NEW.accepted_task_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'durable memory receipt requires exact armed host authority');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_durable_memory_intake_receipts_update_immutable
        BEFORE UPDATE ON durable_memory_intake_receipts
        BEGIN
          SELECT RAISE(ABORT, 'durable memory intake receipts are immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_durable_memory_intake_receipts_delete_immutable
        BEFORE DELETE ON durable_memory_intake_receipts
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'durable memory intake receipts are immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_accepted_task_host_completion_monotonic
        BEFORE UPDATE OF host_completion_receipt_id, host_completion_event_id
        ON accepted_task_authority
        WHEN (OLD.host_completion_receipt_id IS NOT NULL
              AND OLD.host_completion_receipt_id IS NOT NEW.host_completion_receipt_id)
          OR (OLD.host_completion_event_id IS NOT NULL
              AND OLD.host_completion_event_id IS NOT NEW.host_completion_event_id)
          OR (NEW.host_completion_receipt_id IS NULL) IS NOT (NEW.host_completion_event_id IS NULL)
          OR (NEW.host_completion_receipt_id IS NOT NULL AND (
            NEW.work_contract_id IS NOT NULL
            OR NEW.manifest_id IS NOT NEW.host_completion_receipt_id
            OR NEW.backstop_event_id IS NOT NEW.host_completion_event_id
            OR NEW.state NOT IN ('manifested_verifying','terminal')
          ))
          OR (NEW.host_completion_receipt_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM durable_memory_intake_receipts r
             WHERE r.receipt_id = NEW.host_completion_receipt_id
               AND r.receipt_event_id = NEW.host_completion_event_id
               AND r.session_id = NEW.session_id
               AND r.source_user_seq = NEW.source_user_seq
               AND r.accepted_task_id = NEW.accepted_task_id
               AND r.graph_event_id = NEW.graph_event_id
               AND r.graph_id = NEW.graph_id
               AND r.graph_hash = NEW.graph_hash
          ))
        BEGIN
          SELECT RAISE(ABORT, 'accepted task host-completion binding is not exact or monotonic');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_accepted_task_host_terminal_exact
        BEFORE UPDATE OF state ON accepted_task_authority
        WHEN OLD.host_completion_receipt_id IS NOT NULL
          AND NEW.state = 'terminal'
          AND NOT EXISTS (
            SELECT 1
              FROM durable_memory_intake_receipts r
              JOIN events receipt_event ON receipt_event.id = r.receipt_event_id
              JOIN events terminal_event ON terminal_event.id = NEW.terminal_event_id
             WHERE r.receipt_id = OLD.host_completion_receipt_id
               AND r.receipt_event_id = OLD.host_completion_event_id
               AND r.session_id = NEW.session_id
               AND r.source_user_seq = NEW.source_user_seq
               AND r.accepted_task_id = NEW.accepted_task_id
               AND r.graph_event_id = NEW.graph_event_id
               AND r.graph_id = NEW.graph_id
               AND r.graph_hash = NEW.graph_hash
               AND NEW.manifest_id = r.receipt_id
               AND NEW.backstop_event_id = r.receipt_event_id
               AND NEW.work_contract_id IS NULL
               AND receipt_event.session_id = NEW.session_id
               AND receipt_event.type = 'durable_memory_intake_receipt'
               AND terminal_event.session_id = NEW.session_id
               AND terminal_event.type = 'conversation_completed'
               AND COALESCE(
                 json_extract(terminal_event.data_json, '$.sourceUserSeq'),
                 json_extract(terminal_event.data_json, '$.presentation.identity.sourceUserSeq')
               ) = NEW.source_user_seq
          )
        BEGIN
          SELECT RAISE(ABORT, 'host-completed terminal requires its exact receipt and terminal event');
        END;
      `);
    },
  },
  {
    // The host's own in-process execution is a crossing too.
    //
    // Evidence redemption, dependency discharge and terminal projection all
    // key on a physical dispatch, so work the host ran itself produced no
    // evidence at all and no contract naming a local read or local_write
    // could ever be proved (live 2026-08-11: a contracted local source read
    // settled with zero dispatches, zero handles, zero operations).
    //
    // Recording those crossings makes them provable, and this column keeps the
    // table honest about which ones left the machine — a paid provider call
    // and a filesystem write must stay distinguishable to anything that counts
    // crossings. Deliberately an ADD COLUMN, not a widened relation CHECK:
    // three tables carry foreign keys into physical_dispatches, so the table
    // rebuild a CHECK change requires would put those references and a live
    // multi-hundred-megabyte store at risk for a label. NULL means what it has
    // always meant — a crossing that left the process.
    version: 35,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('physical_dispatches')) return;
      const columns = new Set(
        (db.prepare('PRAGMA table_info(physical_dispatches)').all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!columns.has('execution_site')) {
        db.exec('ALTER TABLE physical_dispatches ADD COLUMN execution_site TEXT');
      }
      if (!tables.has('logical_call_settlements')) return;
      // physical_crossing_count keeps its exact meaning — crossings that LEFT
      // the machine, which is what a CHECK on that table and anything counting
      // paid work rely on. The host's own in-process crossings are counted
      // separately so the settlement can still bind every crossing it froze
      // without inflating what looks like provider traffic. NULL reads as zero.
      const settlementColumns = new Set(
        (db.prepare('PRAGMA table_info(logical_call_settlements)').all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!settlementColumns.has('host_crossing_count')) {
        db.exec('ALTER TABLE logical_call_settlements ADD COLUMN host_crossing_count INTEGER');
      }
      // Poisoning a logical call without recording WHY costs the diagnosis:
      // every later reader sees only 'conflict', and the first cause — the one
      // check that actually failed — is gone. A live scheduled workflow failed
      // six times a day for two days with its first cause unrecoverable from
      // the store (platform-49, 2026-08-11).
      if (!tables.has('logical_tool_calls')) return;
      const logicalColumns = new Set(
        (db.prepare('PRAGMA table_info(logical_tool_calls)').all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!logicalColumns.has('conflict_reason')) {
        db.exec('ALTER TABLE logical_tool_calls ADD COLUMN conflict_reason TEXT');
      }
      // A successful PROVIDER crossing must still carry its durable result —
      // that requirement is unchanged. What changes is the converse: a result
      // handle may now also belong to a successful execution the host ran
      // itself. A refusal, or any outcome that did not succeed, still may not
      // hold one. Local success WITHOUT a handle stays legal, because control
      // and discovery calls record no crossing and keep none.
      db.exec(`
        DROP TRIGGER IF EXISTS trg_logical_settlement_result_required;
        CREATE TRIGGER trg_logical_settlement_result_required
        BEFORE INSERT ON logical_call_settlements
        WHEN (
          NEW.execution_kind = 'provider_execution'
          AND NEW.outcome_kind IN ('succeeded','empty_result')
          AND NEW.result_handle_id IS NULL
        ) OR (
          NEW.result_handle_id IS NOT NULL
          AND NOT (
            NEW.execution_kind IN ('provider_execution','local_execution')
            AND NEW.outcome_kind IN ('succeeded','empty_result')
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'logical settlement result-handle binding is inconsistent');
        END;
      `);
    },
  },
  {
    /**
     * Re-assert v35's complete end state.
     *
     * A migration is gated on its version number, so EDITING an already-shipped
     * version is a permanent no-op on every store that recorded it. v35 grew a
     * column after a live daemon had already applied and recorded it, leaving
     * that store with three of v35's four changes and no way to ever receive
     * the fourth — while the code shipping alongside it writes to that column on
     * every poisoned call (found on the live store 2026-08-11, which applied v35
     * at 19:52Z without conflict_reason).
     *
     * Every step is guarded, so this is a no-op on a store that received all of
     * v35 and a repair on one that received part of it. The rule it encodes: a
     * shipped migration is immutable, and a correction ships as its own version.
     */
    version: 36,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      const columnsOf = (table: string): Set<string> => new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (tables.has('physical_dispatches') && !columnsOf('physical_dispatches').has('execution_site')) {
        db.exec('ALTER TABLE physical_dispatches ADD COLUMN execution_site TEXT');
      }
      if (tables.has('logical_call_settlements')) {
        if (!columnsOf('logical_call_settlements').has('host_crossing_count')) {
          db.exec('ALTER TABLE logical_call_settlements ADD COLUMN host_crossing_count INTEGER');
        }
        db.exec(`
          DROP TRIGGER IF EXISTS trg_logical_settlement_result_required;
          CREATE TRIGGER trg_logical_settlement_result_required
          BEFORE INSERT ON logical_call_settlements
          WHEN (
            NEW.execution_kind = 'provider_execution'
            AND NEW.outcome_kind IN ('succeeded','empty_result')
            AND NEW.result_handle_id IS NULL
          ) OR (
            NEW.result_handle_id IS NOT NULL
            AND NOT (
              NEW.execution_kind IN ('provider_execution','local_execution')
              AND NEW.outcome_kind IN ('succeeded','empty_result')
            )
          )
          BEGIN
            SELECT RAISE(ABORT, 'logical settlement result-handle binding is inconsistent');
          END;
        `);
      }
      if (tables.has('logical_tool_calls') && !columnsOf('logical_tool_calls').has('conflict_reason')) {
        db.exec('ALTER TABLE logical_tool_calls ADD COLUMN conflict_reason TEXT');
      }
    },
  },
  {
    /**
     * ONE bounded correction to a source universe's member-id pointer.
     *
     * The pointer says where member identity lives inside a producer record,
     * and the contract freezes it BEFORE the read that would prove it. A wrong
     * guess was therefore fatal for the turn: the seal refused, the contract
     * was immutable, and the per-item lane died with no way back (live
     * 2026-08-11 — records keyed "Id", a natural proposal of '/id').
     *
     * This is seal METADATA, deliberately not part of the contract: the
     * contract is content-addressed, so amending it in place would change its
     * id and orphan every binding. Operations, effects, coverage, dependencies
     * and membership rules stay immutable and unamendable. The primary key is
     * the "exactly once" rule — a second amendment cannot be written at all.
     */
    version: 37,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('accepted_task_work_contracts') || !tables.has('events')) return;
      db.exec(`
        CREATE TABLE IF NOT EXISTS expected_work_universe_amendments (
          session_id              TEXT NOT NULL,
          source_user_seq         INTEGER NOT NULL CHECK (source_user_seq > 0),
          contract_id             TEXT NOT NULL,
          universe_id             TEXT NOT NULL,
          prior_member_id_pointer TEXT NOT NULL,
          member_id_pointer       TEXT NOT NULL
                                  CHECK (member_id_pointer != prior_member_id_pointer),
          motivating_refusal      TEXT NOT NULL,
          sealed_member_count     INTEGER NOT NULL CHECK (sealed_member_count > 0),
          amended_at              TEXT NOT NULL,
          amendment_event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
          PRIMARY KEY (session_id, source_user_seq, contract_id, universe_id),
          FOREIGN KEY (contract_id)
            REFERENCES accepted_task_work_contracts(contract_id) ON DELETE RESTRICT
        );

        CREATE TRIGGER IF NOT EXISTS trg_expected_work_universe_amendment_update_immutable
        BEFORE UPDATE ON expected_work_universe_amendments
        BEGIN
          SELECT RAISE(ABORT, 'a universe amendment is immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_expected_work_universe_amendment_delete_immutable
        BEFORE DELETE ON expected_work_universe_amendments
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'a universe amendment is immutable');
        END;
      `);
    },
  },
  {
    // v28's receipt-authority trigger admitted only provider executions. The
    // host's own returned execution carries the same redeemable evidence — a
    // 'host'-site crossing and a byte-bound result handle — and a local read
    // satisfying the deterministic retrieve route could mint no receipt at
    // all (live 2026-08-12). Shipped migrations are immutable, so the widened
    // trigger ships as its own version: drop and recreate with the host door.
    version: 38,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('evidence_receipts') || !tables.has('physical_dispatches')) return;
      db.exec(`
        DROP TRIGGER IF EXISTS trg_evidence_receipt_exact_authority;
        CREATE TRIGGER trg_evidence_receipt_exact_authority
        BEFORE INSERT ON evidence_receipts
        WHEN NOT EXISTS (
          SELECT 1
            FROM accepted_task_authority a
            JOIN logical_call_settlements s
              ON s.session_id = a.session_id
             AND s.source_user_seq = a.source_user_seq
             AND s.logical_tool_call_id = NEW.logical_tool_call_id
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
            JOIN events e
              ON e.id = NEW.receipt_event_id
           WHERE a.session_id = NEW.session_id
             AND a.source_user_seq = NEW.source_user_seq
             AND a.accepted_task_id = NEW.accepted_task_id
             AND a.manifest_id = NEW.manifest_id
             AND a.state = 'manifested_verifying'
             AND l.accepted_task_id = NEW.accepted_task_id
             AND l.state = 'settled'
             AND (
               s.execution_kind = 'provider_execution'
               OR (s.execution_kind = 'local_execution' AND p.execution_site = 'host')
             )
             AND s.outcome_kind IN ('succeeded','empty_result')
             AND s.result_handle_id = NEW.result_handle_id
             AND h.scope_kind = 'authoritative'
             AND h.session_id = NEW.session_id
             AND h.source_user_seq = NEW.source_user_seq
             AND h.accepted_task_id = NEW.accepted_task_id
             AND h.logical_tool_call_id = NEW.logical_tool_call_id
             AND h.physical_dispatch_id = NEW.physical_dispatch_id
             AND h.tool_name = NEW.tool_name
             AND h.raw_payload_sha256 = NEW.raw_payload_sha256
             AND h.raw_byte_count = NEW.raw_byte_count
             AND h.success = 1
             AND e.session_id = NEW.session_id
             AND e.type = 'evidence_receipt'
             AND json_extract(e.data_json, '$.receiptId') = NEW.receipt_id
             AND json_extract(e.data_json, '$.sourceUserSeq') = NEW.source_user_seq
             AND json_extract(e.data_json, '$.acceptedTaskId') = NEW.accepted_task_id
             AND json_extract(e.data_json, '$.manifestId') = NEW.manifest_id
             AND json_extract(e.data_json, '$.nodeId') = NEW.node_id
             AND json_extract(e.data_json, '$.obligation') = NEW.obligation
             AND json_extract(e.data_json, '$.logicalToolCallId') = NEW.logical_tool_call_id
             AND json_extract(e.data_json, '$.physicalDispatchId') = NEW.physical_dispatch_id
             AND json_extract(e.data_json, '$.resultHandleId') = NEW.result_handle_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'evidence receipt requires exact manifested settlement authority');
        END;
      `);
    },
  },
  {
    /**
     * Provider-neutral requirement identities for broad discovery.
     *
     * A task-wide broad-search row made two different unresolved requirements
     * fight for one slot, while keying by query/provider wording would let one
     * requirement buy unlimited synonymous slots. The capability resolver now
     * supplies opaque role keys for the exact accepted request. Persist that
     * closed membership before the model runs; claims may then reuse the
     * existing `subject` column as the per-role key without trusting model text.
     *
     * The set row distinguishes a deliberately empty/all-resolved projection
     * from a legacy task that has not adopted role-scoped discovery. Requirement
     * text is represented only by a digest. Resolution can tighten from open to
     * resolved, but role identity and source membership are immutable.
     */
    version: 39,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('discovery_governor_tasks')) return;
      db.exec(`
        CREATE TABLE IF NOT EXISTS discovery_governor_role_sets (
          session_id         TEXT NOT NULL,
          source_user_seq    INTEGER NOT NULL CHECK (source_user_seq > 0),
          projection_digest  TEXT NOT NULL CHECK (length(projection_digest) = 64),
          role_count         INTEGER NOT NULL CHECK (role_count >= 0),
          unresolved_count   INTEGER NOT NULL CHECK (
                               unresolved_count >= 0 AND unresolved_count <= role_count
                             ),
          initialized_at     TEXT NOT NULL,
          updated_at         TEXT NOT NULL,
          PRIMARY KEY (session_id, source_user_seq),
          FOREIGN KEY (session_id, source_user_seq)
            REFERENCES discovery_governor_tasks(session_id, source_user_seq)
            ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS discovery_governor_roles (
          session_id          TEXT NOT NULL,
          source_user_seq     INTEGER NOT NULL CHECK (source_user_seq > 0),
          role_key            TEXT NOT NULL CHECK (length(role_key) BETWEEN 1 AND 128),
          requirement_index   INTEGER NOT NULL CHECK (requirement_index >= 0),
          requirement_digest  TEXT NOT NULL CHECK (length(requirement_digest) = 64),
          resolved            INTEGER NOT NULL CHECK (resolved IN (0, 1)),
          registered_at       TEXT NOT NULL,
          resolved_at         TEXT,
          PRIMARY KEY (session_id, source_user_seq, role_key),
          UNIQUE (session_id, source_user_seq, requirement_index),
          FOREIGN KEY (session_id, source_user_seq)
            REFERENCES discovery_governor_role_sets(session_id, source_user_seq)
            ON DELETE CASCADE,
          CHECK (
            (resolved = 0 AND resolved_at IS NULL)
            OR (resolved = 1 AND resolved_at IS NOT NULL)
          )
        );

        CREATE INDEX IF NOT EXISTS idx_discovery_governor_roles_open
          ON discovery_governor_roles(session_id, source_user_seq, resolved, requirement_index);

        CREATE TRIGGER IF NOT EXISTS trg_discovery_governor_role_identity_immutable
        BEFORE UPDATE ON discovery_governor_roles
        WHEN OLD.session_id IS NOT NEW.session_id
          OR OLD.source_user_seq IS NOT NEW.source_user_seq
          OR OLD.role_key IS NOT NEW.role_key
          OR OLD.requirement_index IS NOT NEW.requirement_index
          OR OLD.requirement_digest IS NOT NEW.requirement_digest
          OR OLD.registered_at IS NOT NEW.registered_at
          OR NEW.resolved < OLD.resolved
          OR (OLD.resolved = 1 AND OLD.resolved_at IS NOT NEW.resolved_at)
        BEGIN
          SELECT RAISE(ABORT, 'discovery requirement role identity is immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_discovery_governor_role_set_identity_immutable
        BEFORE UPDATE ON discovery_governor_role_sets
        WHEN OLD.session_id IS NOT NEW.session_id
          OR OLD.source_user_seq IS NOT NEW.source_user_seq
          OR OLD.projection_digest IS NOT NEW.projection_digest
          OR OLD.role_count IS NOT NEW.role_count
          OR OLD.initialized_at IS NOT NEW.initialized_at
          OR NEW.unresolved_count > OLD.unresolved_count
        BEGIN
          SELECT RAISE(ABORT, 'discovery requirement role set is immutable or monotonic');
        END;
      `);
    },
  },
  {
    /** Immutable generated-Sheet source/content/readback authority. */
    version: 40,
    sql: '',
    backfill: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS run_artifacts (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          run_scope_id TEXT NOT NULL, slot_key TEXT NOT NULL, kind TEXT NOT NULL,
          provider TEXT NOT NULL, title TEXT, create_shape TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending','bound','uncertain')),
          resource_id TEXT, uri TEXT, source_call_id TEXT,
          external_write_event_id TEXT, external_write_action_key TEXT,
          external_write_tool_name TEXT, binding_verified_at TEXT,
          verification_call_id TEXT, verification_shape TEXT,
          verification_fingerprint TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(session_id, run_scope_id, slot_key)
        );
        CREATE INDEX IF NOT EXISTS idx_run_artifacts_session
          ON run_artifacts(session_id, run_scope_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_run_artifacts_resource
          ON run_artifacts(provider, resource_id);
        CREATE TABLE IF NOT EXISTS artifact_run_scopes (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          attempt_scope_id TEXT NOT NULL, root_scope_id TEXT NOT NULL,
          source_user_seq INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL,
          created_at TEXT NOT NULL, PRIMARY KEY(session_id, attempt_scope_id)
        );
        CREATE INDEX IF NOT EXISTS idx_artifact_run_scopes_user
          ON artifact_run_scopes(session_id, source_user_seq DESC, created_at DESC);
        CREATE TABLE IF NOT EXISTS artifact_source_roots (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          source_user_seq INTEGER NOT NULL, root_scope_id TEXT NOT NULL,
          created_at TEXT NOT NULL, PRIMARY KEY(session_id, source_user_seq)
        );
        CREATE TABLE IF NOT EXISTS expected_work_source_lineage_identities (
          session_id           TEXT NOT NULL,
          source_user_seq      INTEGER NOT NULL,
          logical_tool_call_id TEXT NOT NULL,
          profile_id           TEXT NOT NULL,
          profile_digest       TEXT NOT NULL CHECK (profile_digest GLOB 'sha256:*'),
          created_at           TEXT NOT NULL,
          PRIMARY KEY (session_id, source_user_seq, logical_tool_call_id),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES expected_work_call_bindings(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE CASCADE
        );
        CREATE TRIGGER IF NOT EXISTS trg_expected_work_source_lineage_identity_immutable
        BEFORE UPDATE ON expected_work_source_lineage_identities
        BEGIN SELECT RAISE(ABORT, 'expected-work source lineage identity is immutable'); END;

        CREATE TABLE IF NOT EXISTS expected_work_generated_artifact_contracts (
          session_id           TEXT NOT NULL,
          source_user_seq      INTEGER NOT NULL,
          logical_tool_call_id TEXT NOT NULL,
          contract_json        TEXT NOT NULL CHECK (json_valid(contract_json)),
          created_at           TEXT NOT NULL,
          PRIMARY KEY (session_id, source_user_seq, logical_tool_call_id),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES expected_work_call_bindings(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE CASCADE
        );
        CREATE TRIGGER IF NOT EXISTS trg_expected_work_generated_artifact_contract_immutable
        BEFORE UPDATE ON expected_work_generated_artifact_contracts
        BEGIN SELECT RAISE(ABORT, 'expected-work generated artifact contract is immutable'); END;

        CREATE TABLE IF NOT EXISTS artifact_content_verifications (
          artifact_id                  TEXT PRIMARY KEY REFERENCES run_artifacts(id) ON DELETE CASCADE,
          session_id                   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          run_scope_id                 TEXT NOT NULL,
          create_logical_tool_call_id  TEXT NOT NULL,
          contract_json                TEXT NOT NULL CHECK (json_valid(contract_json)),
          content_verified_at          TEXT,
          verification_logical_call_id TEXT,
          verification_fingerprint     TEXT,
          created_at                   TEXT NOT NULL,
          CHECK ((content_verified_at IS NULL AND verification_logical_call_id IS NULL
                    AND verification_fingerprint IS NULL)
              OR (content_verified_at IS NOT NULL AND verification_logical_call_id IS NOT NULL
                    AND verification_fingerprint IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS idx_artifact_content_source
          ON artifact_content_verifications(session_id, run_scope_id, create_logical_tool_call_id);
        CREATE TRIGGER IF NOT EXISTS trg_artifact_content_contract_immutable
        BEFORE UPDATE OF artifact_id, session_id, run_scope_id,
                         create_logical_tool_call_id, contract_json
        ON artifact_content_verifications
        BEGIN SELECT RAISE(ABORT, 'artifact content contract is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_artifact_content_verification_once
        BEFORE UPDATE OF content_verified_at, verification_logical_call_id, verification_fingerprint
        ON artifact_content_verifications
        WHEN OLD.content_verified_at IS NOT NULL AND (
          OLD.content_verified_at IS NOT NEW.content_verified_at
          OR OLD.verification_logical_call_id IS NOT NEW.verification_logical_call_id
          OR OLD.verification_fingerprint IS NOT NEW.verification_fingerprint)
        BEGIN SELECT RAISE(ABORT, 'artifact content verification is immutable'); END;
      `);
    },
  },
  {
    /**
     * Human decisions for autonomous irreversible sends still use the exact
     * approval ledger, but their user surface is an ordinary question rather
     * than a formal approval card. Keep that presentation contract beside the
     * frozen row (not inside execution args) so restart/replay cannot infer it
     * from a later policy setting and exact payload authority stays unchanged.
     */
    version: 41,
    sql: '',
    backfill: (db) => {
      const table = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pending_approvals'`,
      ).get();
      if (!table) return;
      const columns = new Set(
        (db.prepare('PRAGMA table_info(pending_approvals)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has('presentation_json')) {
        db.exec('ALTER TABLE pending_approvals ADD COLUMN presentation_json TEXT');
      }
      // Schema-rehearsal fixtures may contain an intentionally sparse legacy
      // table. Add the column for forward reads, but build the optimization
      // only when both historical key columns exist.
      if (columns.has('session_id') && columns.has('status')) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_pending_approvals_conversational_surface
            ON pending_approvals(session_id, status)
            WHERE presentation_json IS NOT NULL;
        `);
      }
    },
  },
  {
    /**
     * Freeze clarification-continuation audience and answer interpretation.
     * The task_continuity_packets table is lazy and may not exist yet; add the
     * columns only when present. Existing rows intentionally remain NULL and
     * fail closed rather than being reinterpreted under a newer resolver.
     */
    version: 42,
    sql: '',
    backfill: (db) => {
      const table = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_continuity_packets'`,
      ).get();
      if (!table) return;
      const columns = new Set(
        (db.prepare('PRAGMA table_info(task_continuity_packets)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      for (const [name, type] of [
        ['origin_audience_hash', 'TEXT'],
        ['consumer_audience_hash', 'TEXT'],
        ['resolver_version', 'TEXT'],
        ['resolution_disposition', 'TEXT'],
        ['resolution_selected_option', 'TEXT'],
        ['resolution_active_task_input', 'TEXT'],
        ['resolution_semantic_input_hash', 'TEXT'],
      ] as const) {
        if (!columns.has(name)) {
          db.exec(`ALTER TABLE task_continuity_packets ADD COLUMN ${name} ${type}`);
        }
      }
      db.exec(`
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
    },
  },
  {
    /**
     * Per-source semantic interpretation claim and exact slot identity on
     * continuity packets. The claim table is CAS, not a semantic store.
     */
    version: 43,
    sql: `
      CREATE TABLE IF NOT EXISTS turn_semantics_claims (
        session_id TEXT NOT NULL,
        source_user_seq INTEGER NOT NULL,
        owner TEXT NOT NULL,
        created_at TEXT NOT NULL,
        event_id TEXT,
        PRIMARY KEY (session_id, source_user_seq)
      );
    `,
    backfill: (db) => {
      const table = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_continuity_packets'`,
      ).get();
      if (!table) return;
      const columns = new Set(
        (db.prepare('PRAGMA table_info(task_continuity_packets)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has('pause_slot_json')) {
        db.exec('ALTER TABLE task_continuity_packets ADD COLUMN pause_slot_json TEXT');
      }
    },
  },
  {
    /**
     * Fence semantic claims by owner token and bind the winning result.
     * A stolen owner cannot persist after the row is replaced.
     */
    version: 44,
    sql: `
      CREATE TABLE IF NOT EXISTS graph_node_leases (
        lease_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        fence INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        released INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS graph_journal_entries (
        session_id TEXT NOT NULL,
        source_user_seq INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        entry_json TEXT NOT NULL,
        PRIMARY KEY (session_id, source_user_seq, seq)
      );
    `,
    backfill: (db) => {
      // Migration rehearsals and interrupted operators can legitimately leave
      // the v44 columns in place while the schema_version row is absent. Raw
      // ALTER statements would then make every subsequent open fail with a
      // duplicate-column error. Structural inspection keeps the additive
      // migration restart-safe without blessing or rewriting any old claim.
      const columns = new Set(
        (db.prepare('PRAGMA table_info(turn_semantics_claims)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      for (const name of ['input_hash', 'audience_hash', 'policy_revision'] as const) {
        if (!columns.has(name)) {
          db.exec(`ALTER TABLE turn_semantics_claims ADD COLUMN ${name} TEXT`);
        }
      }
    },
  },
  {
    /**
     * Durable semantic participation, request-scoped catalog snapshots,
     * exact node bindings, and trusted capability manifests. These used
     * to be created ad-hoc at runtime; they are now a contiguous schema.
     */
    version: 45,
    sql: `
      CREATE TABLE IF NOT EXISTS turn_semantics_dispositions (
        session_id TEXT NOT NULL,
        source_user_seq INTEGER NOT NULL,
        participation TEXT NOT NULL,
        outcome TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, source_user_seq)
      );
      CREATE TABLE IF NOT EXISTS accepted_source_catalog_snapshots (
        session_id TEXT NOT NULL,
        source_user_seq INTEGER NOT NULL,
        snapshot_digest TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (session_id, source_user_seq)
      );
      CREATE TABLE IF NOT EXISTS graph_node_bindings (
        session_id TEXT NOT NULL,
        source_user_seq INTEGER NOT NULL,
        node_id TEXT NOT NULL,
        binding_json TEXT NOT NULL,
        binding_digest TEXT NOT NULL,
        PRIMARY KEY (session_id, source_user_seq, node_id)
      );
      CREATE TABLE IF NOT EXISTS capability_manifests (
        manifest_id TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        installed_at TEXT NOT NULL
      );
    `,
  },
  {
    /**
     * Persist the minted call-authority digest and provider-argument digest
     * with every physical reservation. Replay and settlement must match them.
     */
    version: 46,
    sql: `
      CREATE TABLE IF NOT EXISTS physical_dispatch_authority (
        session_id TEXT NOT NULL,
        source_user_seq INTEGER NOT NULL,
        physical_dispatch_id TEXT NOT NULL,
        authority_digest TEXT NOT NULL,
        provider_argument_digest TEXT NOT NULL,
        PRIMARY KEY (session_id, source_user_seq, physical_dispatch_id)
      );
    `,
    backfill: (db) => {
      const table = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'physical_dispatches'`,
      ).get();
      if (!table) return;
      const columns = new Set(
        (db.prepare('PRAGMA table_info(physical_dispatches)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has('authority_digest')) {
        db.exec('ALTER TABLE physical_dispatches ADD COLUMN authority_digest TEXT');
      }
      if (!columns.has('provider_argument_digest')) {
        db.exec('ALTER TABLE physical_dispatches ADD COLUMN provider_argument_digest TEXT');
      }
    },
  },
  {
    /**
     * Persist reconstructable typed call-authority bytes with the reservation.
     * A digest alone cannot be verified after restart.
     */
    version: 47,
    sql: `
      CREATE TABLE IF NOT EXISTS physical_dispatch_authority_payload (
        session_id TEXT NOT NULL,
        source_user_seq INTEGER NOT NULL,
        physical_dispatch_id TEXT NOT NULL,
        authority_digest TEXT NOT NULL,
        provider_argument_digest TEXT NOT NULL,
        authority_json TEXT NOT NULL,
        PRIMARY KEY (session_id, source_user_seq, physical_dispatch_id)
      );
    `,
    backfill: (db) => {
      const table = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'physical_dispatch_authority'`,
      ).get();
      if (!table) return;
      const columns = new Set(
        (db.prepare('PRAGMA table_info(physical_dispatch_authority)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has('authority_json')) {
        db.exec('ALTER TABLE physical_dispatch_authority ADD COLUMN authority_json TEXT');
      }
    },
  },
  {
    /**
     * Privacy-safe sealed authority: one digest, one crossing, no plaintext
     * provider arguments. Schema 47 payload rows are not copied forward.
     */
    version: 48,
    sql: `
      CREATE TABLE IF NOT EXISTS physical_dispatch_authority_sealed (
        session_id TEXT NOT NULL,
        source_user_seq INTEGER NOT NULL,
        physical_dispatch_id TEXT NOT NULL,
        authority_digest TEXT NOT NULL,
        provider_argument_digest TEXT NOT NULL,
        observation_digest TEXT NOT NULL,
        sealed_json TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        retention_class TEXT NOT NULL,
        created_at TEXT NOT NULL,
        argument_cipher TEXT,
        PRIMARY KEY (session_id, source_user_seq, physical_dispatch_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS physical_dispatch_authority_sealed_digest
        ON physical_dispatch_authority_sealed (authority_digest);
    `,
    backfill: (db) => {
      ensureAuthorityPrivacySchema(db);
    },
  },
  {
    /**
     * One consequential-crossing kernel. Provider-I/O ownership used to live in
     * a runtime-created `graph_dispatch_io` table with its own state machine,
     * so a reservation and its I/O claim could disagree about who owned the
     * crossing. The claim belongs to the reservation it fences: these columns
     * move it onto `physical_dispatches`, where the exact authority, argument
     * digests and settlement already live.
     *
     * `io_claimed_at IS NULL` means unclaimed and therefore replayable by a
     * legitimate lease takeover; non-NULL means provider I/O was claimed and
     * recovery must reconcile rather than redispatch.
     */
    version: 49,
    sql: '',
    backfill: (db) => {
      const columns = new Set(
        (db.prepare('PRAGMA table_info(physical_dispatches)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.size) return;
      if (!columns.has('io_claimed_at')) db.exec('ALTER TABLE physical_dispatches ADD COLUMN io_claimed_at TEXT');
      if (!columns.has('io_owner')) db.exec('ALTER TABLE physical_dispatches ADD COLUMN io_owner TEXT');
      if (!columns.has('io_fence')) db.exec('ALTER TABLE physical_dispatches ADD COLUMN io_fence INTEGER');
      if (!columns.has('io_revision')) db.exec('ALTER TABLE physical_dispatches ADD COLUMN io_revision INTEGER');

      const legacy = db.prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'graph_dispatch_io'`,
      ).get() as { ok: number } | undefined;
      if (!legacy) return;

      // A claimed marker with no reservation would be a provider-I/O fact we
      // cannot bind to an authority. That is corruption, not an upgrade: fail
      // closed inside the migration transaction rather than discard it.
      const orphaned = db.prepare(`
        SELECT COUNT(*) AS n FROM graph_dispatch_io io
         WHERE io.io_started = 1
           AND NOT EXISTS (
             SELECT 1 FROM physical_dispatches p
              WHERE p.session_id = io.session_id
                AND p.source_user_seq = io.source_user_seq
                AND p.physical_dispatch_id = io.physical_dispatch_id
           )
      `).get() as { n: number };
      if (orphaned.n > 0) {
        throw new Error(
          `schema v49 refuses to drop ${orphaned.n} claimed provider-I/O marker(s) with no physical reservation`,
        );
      }

      db.exec(`
        UPDATE physical_dispatches
           SET io_claimed_at = COALESCE(io_claimed_at, started_at),
               io_owner = COALESCE(
                 io_owner,
                 (SELECT io.io_owner FROM graph_dispatch_io io
                   WHERE io.session_id = physical_dispatches.session_id
                     AND io.source_user_seq = physical_dispatches.source_user_seq
                     AND io.physical_dispatch_id = physical_dispatches.physical_dispatch_id)
               ),
               io_fence = COALESCE(
                 io_fence,
                 (SELECT io.io_fence FROM graph_dispatch_io io
                   WHERE io.session_id = physical_dispatches.session_id
                     AND io.source_user_seq = physical_dispatches.source_user_seq
                     AND io.physical_dispatch_id = physical_dispatches.physical_dispatch_id)
               ),
               io_revision = COALESCE(
                 io_revision,
                 (SELECT io.io_revision FROM graph_dispatch_io io
                   WHERE io.session_id = physical_dispatches.session_id
                     AND io.source_user_seq = physical_dispatches.source_user_seq
                     AND io.physical_dispatch_id = physical_dispatches.physical_dispatch_id)
               )
         WHERE EXISTS (
           SELECT 1 FROM graph_dispatch_io io
            WHERE io.session_id = physical_dispatches.session_id
              AND io.source_user_seq = physical_dispatches.source_user_seq
              AND io.physical_dispatch_id = physical_dispatches.physical_dispatch_id
              AND io.io_started = 1
         );

        DROP TABLE graph_dispatch_io;
      `);
    },
  },
  {
    /**
     * Graph-neutral accepted-turn call authority.
     *
     * Foreground host chat must be able to admit bounded read/compute calls
     * without manufacturing a TurnGraphIR. Graph turns retain their exact
     * accepted_task_resolutions and expected-work machinery; both lanes share
     * this one parent and the existing logical/physical/settlement ledgers.
     */
    version: 50,
    foreignKeysOff: true,
    sql: `
      CREATE TABLE IF NOT EXISTS accepted_turn_call_authorities (
        session_id                TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_user_seq           INTEGER NOT NULL CHECK (source_user_seq > 0),
        accepted_task_id          TEXT NOT NULL UNIQUE,
        authority_protocol        INTEGER NOT NULL CHECK (authority_protocol = 1),
        authority_kind            TEXT NOT NULL
                                  CHECK (authority_kind IN ('turn_graph','host_v1_read_only')),
        source_event_id           TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
        source_event_digest       TEXT NOT NULL CHECK (length(source_event_digest) = 64),
        source_turn               INTEGER NOT NULL CHECK (source_turn >= 0),
        engine_version            TEXT NOT NULL CHECK (length(engine_version) BETWEEN 1 AND 128),
        surface_version           TEXT NOT NULL CHECK (length(surface_version) BETWEEN 1 AND 128),
        surface_digest            TEXT NOT NULL CHECK (length(surface_digest) = 64),
        effect_ceiling            TEXT NOT NULL CHECK (length(effect_ceiling) BETWEEN 1 AND 64),
        effect_bounds_json        TEXT NOT NULL
                                  CHECK (json_valid(effect_bounds_json)
                                    AND json_type(effect_bounds_json) = 'array'),
        max_logical_calls         INTEGER CHECK (max_logical_calls IS NULL OR max_logical_calls > 0),
        max_parallel_calls        INTEGER CHECK (max_parallel_calls IS NULL OR max_parallel_calls > 0),
        catalog_revision_digest   TEXT
                                  CHECK (catalog_revision_digest IS NULL OR length(catalog_revision_digest) = 64),
        binding_revision_digest   TEXT
                                  CHECK (binding_revision_digest IS NULL OR length(binding_revision_digest) = 64),
        graph_event_id            TEXT REFERENCES events(id) ON DELETE RESTRICT,
        graph_hash                TEXT CHECK (graph_hash IS NULL OR length(graph_hash) = 64),
        authority_digest          TEXT NOT NULL UNIQUE CHECK (length(authority_digest) = 64),
        state                     TEXT NOT NULL DEFAULT 'open'
                                  CHECK (state IN ('open','closed','conflict')),
        revision                  INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        opened_at                 TEXT NOT NULL,
        closed_at                 TEXT,
        close_reason              TEXT CHECK (close_reason IS NULL OR length(close_reason) BETWEEN 1 AND 160),
        PRIMARY KEY (session_id, source_user_seq),
        CHECK (accepted_task_id = 'task:' || session_id || '#' || source_user_seq),
        CHECK (
          (state = 'open' AND closed_at IS NULL AND close_reason IS NULL)
          OR (state IN ('closed','conflict') AND closed_at IS NOT NULL AND close_reason IS NOT NULL)
        ),
        CHECK (
          (authority_kind = 'host_v1_read_only'
            AND engine_version = 'host_v1_read_only'
            AND effect_ceiling = 'read_compute_host_only'
            AND effect_bounds_json = '["compute","host_only","read"]'
            AND max_logical_calls IS NOT NULL
            AND max_parallel_calls IS NOT NULL
            AND max_parallel_calls <= max_logical_calls
            AND catalog_revision_digest IS NOT NULL
            AND binding_revision_digest IS NOT NULL
            AND graph_event_id IS NULL
            AND graph_hash IS NULL)
          OR
          (authority_kind = 'turn_graph'
            AND surface_version = 'turn_graph_ir_v1'
            AND effect_bounds_json = '[]'
            AND catalog_revision_digest IS NULL
            AND graph_event_id IS NOT NULL
            AND graph_hash IS NOT NULL
            AND binding_revision_digest = graph_hash
            AND max_logical_calls IS NULL
            AND max_parallel_calls IS NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_accepted_turn_call_authority_state
        ON accepted_turn_call_authorities(authority_kind, state, opened_at);

      CREATE TRIGGER IF NOT EXISTS trg_accepted_turn_call_authority_source_exact
      BEFORE INSERT ON accepted_turn_call_authorities
      WHEN NOT EXISTS (
        SELECT 1 FROM events e
         WHERE e.id = NEW.source_event_id
           AND e.seq = NEW.source_user_seq
           AND e.session_id = NEW.session_id
           AND e.turn = NEW.source_turn
           AND e.role = 'user'
           AND e.type = 'user_input_received'
      )
      BEGIN
        SELECT RAISE(ABORT, 'accepted-turn call authority requires its exact user source event');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_accepted_turn_call_authority_graph_exact
      BEFORE INSERT ON accepted_turn_call_authorities
      WHEN NEW.authority_kind = 'turn_graph' AND NOT EXISTS (
        SELECT 1 FROM accepted_task_resolutions r
         WHERE r.session_id = NEW.session_id
           AND r.source_user_seq = NEW.source_user_seq
           AND r.accepted_task_id = NEW.accepted_task_id
           AND r.graph_event_id = NEW.graph_event_id
           AND r.graph_hash = NEW.graph_hash
           AND r.compiler_version = NEW.engine_version
           AND r.effect_ceiling = NEW.effect_ceiling
      )
      BEGIN
        SELECT RAISE(ABORT, 'graph call authority requires its exact graph resolution');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_accepted_turn_call_authority_host_graphless
      BEFORE INSERT ON accepted_turn_call_authorities
      WHEN NEW.authority_kind = 'host_v1_read_only' AND EXISTS (
        SELECT 1 FROM accepted_task_resolutions r
         WHERE r.session_id = NEW.session_id
           AND r.source_user_seq = NEW.source_user_seq
      )
      BEGIN
        SELECT RAISE(ABORT, 'host call authority cannot replace graph resolution authority');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_accepted_turn_call_authority_identity_immutable
      BEFORE UPDATE ON accepted_turn_call_authorities
      WHEN OLD.session_id IS NOT NEW.session_id
        OR OLD.source_user_seq IS NOT NEW.source_user_seq
        OR OLD.accepted_task_id IS NOT NEW.accepted_task_id
        OR OLD.authority_protocol IS NOT NEW.authority_protocol
        OR OLD.authority_kind IS NOT NEW.authority_kind
        OR OLD.source_event_id IS NOT NEW.source_event_id
        OR OLD.source_event_digest IS NOT NEW.source_event_digest
        OR OLD.source_turn IS NOT NEW.source_turn
        OR OLD.engine_version IS NOT NEW.engine_version
        OR OLD.surface_version IS NOT NEW.surface_version
        OR OLD.surface_digest IS NOT NEW.surface_digest
        OR OLD.effect_ceiling IS NOT NEW.effect_ceiling
        OR OLD.effect_bounds_json IS NOT NEW.effect_bounds_json
        OR OLD.max_logical_calls IS NOT NEW.max_logical_calls
        OR OLD.max_parallel_calls IS NOT NEW.max_parallel_calls
        OR OLD.catalog_revision_digest IS NOT NEW.catalog_revision_digest
        OR OLD.binding_revision_digest IS NOT NEW.binding_revision_digest
        OR OLD.graph_event_id IS NOT NEW.graph_event_id
        OR OLD.graph_hash IS NOT NEW.graph_hash
        OR OLD.authority_digest IS NOT NEW.authority_digest
        OR OLD.opened_at IS NOT NEW.opened_at
      BEGIN
        SELECT RAISE(ABORT, 'accepted-turn call authority identity is immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_accepted_turn_call_authority_state_machine
      BEFORE UPDATE OF state, revision, closed_at, close_reason
      ON accepted_turn_call_authorities
      WHEN NOT (
        NEW.revision = OLD.revision + 1
        AND (
          (OLD.state = 'open' AND NEW.state IN ('closed','conflict'))
          OR (OLD.state = 'closed' AND NEW.state = 'conflict')
        )
        AND NEW.closed_at IS NOT NULL
        AND NEW.close_reason IS NOT NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid accepted-turn call authority transition');
      END;
    `,
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      // Historical sparse migration rehearsals intentionally omit the
      // canonical event spine. An accepted-turn root cannot be proven in
      // such a store, and retaining a table whose event FKs point at a
      // missing parent also poisons otherwise unrelated session cascades.
      // Fresh and real harness stores always have both tables by v50.
      if (!tables.has('sessions') || !tables.has('events')) {
        db.exec('DROP TABLE accepted_turn_call_authorities');
        return;
      }
      if (tables.has('accepted_task_resolutions')) {
        // The inverse of the host-root insertion guard. Normal graph
        // provisioning inserts its resolution first and then its shared root
        // in the same transaction; a source already armed for the bounded host
        // lane can never be reinterpreted as a graph by a bypassing writer.
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_accepted_task_resolution_excludes_host_root
          BEFORE INSERT ON accepted_task_resolutions
          WHEN EXISTS (
            SELECT 1 FROM accepted_turn_call_authorities a
             WHERE a.session_id = NEW.session_id
               AND a.source_user_seq = NEW.source_user_seq
               AND a.authority_kind = 'host_v1_read_only'
          )
          BEGIN
            SELECT RAISE(ABORT, 'graph resolution cannot replace host call authority');
          END;
        `);
        const rows = db.prepare(`
          SELECT r.session_id, r.source_user_seq, r.accepted_task_id,
                 r.graph_event_id, r.graph_hash, r.compiler_version,
                 r.effect_ceiling, r.state, r.opened_at, r.finalized_at,
                 e.id AS source_event_id, e.turn AS source_turn,
                 e.role AS source_role, e.type AS source_type,
                 e.parent_event_id, e.data_json, e.created_at
            FROM accepted_task_resolutions r
            LEFT JOIN events e
              ON e.session_id = r.session_id AND e.seq = r.source_user_seq
           ORDER BY r.session_id, r.source_user_seq
        `).all() as Array<{
          session_id: string;
          source_user_seq: number;
          accepted_task_id: string;
          graph_event_id: string;
          graph_hash: string;
          compiler_version: string;
          effect_ceiling: string;
          state: 'open' | 'finalized' | 'legacy_ambiguous';
          opened_at: string;
          finalized_at: string | null;
          source_event_id: string | null;
          source_turn: number | null;
          source_role: string | null;
          source_type: string | null;
          parent_event_id: string | null;
          data_json: string | null;
          created_at: string | null;
        }>;
        const insert = db.prepare(`
          INSERT INTO accepted_turn_call_authorities
            (session_id, source_user_seq, accepted_task_id, authority_protocol,
             authority_kind, source_event_id, source_event_digest, source_turn,
             engine_version, surface_version, surface_digest, effect_ceiling,
             effect_bounds_json, max_logical_calls, max_parallel_calls,
             catalog_revision_digest, binding_revision_digest,
             graph_event_id, graph_hash, authority_digest, state, revision,
             opened_at, closed_at, close_reason)
          VALUES (?, ?, ?, 1, 'turn_graph', ?, ?, ?, ?, 'turn_graph_ir_v1', ?, ?,
                  '[]', NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of rows) {
          if (
            !row.source_event_id
            // Turn zero is the canonical first turn in older and current
            // sessions. Only a missing LEFT JOIN value is invalid here.
            || row.source_turn === null
            || row.source_role !== 'user'
            || row.source_type !== 'user_input_received'
            || row.data_json === null
            || row.created_at === null
          ) {
            throw new Error(
              `schema v50 graph resolution ${row.session_id}#${row.source_user_seq} lacks its exact user source`,
            );
          }
          const acceptedTaskId = `task:${row.session_id}#${row.source_user_seq}`;
          if (row.accepted_task_id !== acceptedTaskId) {
            throw new Error(`schema v50 graph resolution ${row.session_id}#${row.source_user_seq} has an invalid task id`);
          }
          const sourceEventDigest = acceptedTurnSourceEventDigest({
            id: row.source_event_id,
            sessionId: row.session_id,
            seq: row.source_user_seq,
            turn: row.source_turn,
            role: row.source_role,
            type: row.source_type,
            parentEventId: row.parent_event_id,
            dataJson: row.data_json,
            createdAt: row.created_at,
          });
          const effectBoundsJson = '[]';
          const surfaceDigest = acceptedTurnCallSurfaceDigest({
            authorityKind: 'turn_graph',
            engineVersion: row.compiler_version,
            surfaceVersion: 'turn_graph_ir_v1',
            effectCeiling: row.effect_ceiling,
            effectBoundsJson,
            maxLogicalCalls: null,
            maxParallelCalls: null,
            catalogRevisionDigest: null,
            bindingRevisionDigest: row.graph_hash,
            graphEventId: row.graph_event_id,
            graphHash: row.graph_hash,
          });
          const authorityDigest = acceptedTurnCallAuthorityDigest({
            authorityKind: 'turn_graph',
            sessionId: row.session_id,
            sourceUserSeq: row.source_user_seq,
            acceptedTaskId,
            sourceEventId: row.source_event_id,
            sourceEventDigest,
            sourceTurn: row.source_turn,
            engineVersion: row.compiler_version,
            surfaceVersion: 'turn_graph_ir_v1',
            surfaceDigest,
            effectCeiling: row.effect_ceiling,
            effectBoundsJson,
            maxLogicalCalls: null,
            maxParallelCalls: null,
            catalogRevisionDigest: null,
            bindingRevisionDigest: row.graph_hash,
            graphEventId: row.graph_event_id,
            graphHash: row.graph_hash,
          });
          const state = row.state === 'open'
            ? 'open'
            : row.state === 'finalized' ? 'closed' : 'conflict';
          const closedAt = state === 'open' ? null : row.finalized_at ?? row.opened_at;
          const closeReason = state === 'open'
            ? null
            : state === 'closed' ? 'graph_finalized' : 'graph_legacy_ambiguous';
          const existing = db.prepare(`
            SELECT authority_digest FROM accepted_turn_call_authorities
             WHERE session_id = ? AND source_user_seq = ?
          `).get(row.session_id, row.source_user_seq) as { authority_digest: string } | undefined;
          if (existing) {
            if (existing.authority_digest !== authorityDigest) {
              throw new Error(`schema v50 existing call authority conflicts for ${row.session_id}#${row.source_user_seq}`);
            }
            continue;
          }
          insert.run(
            row.session_id,
            row.source_user_seq,
            acceptedTaskId,
            row.source_event_id,
            sourceEventDigest,
            row.source_turn,
            row.compiler_version,
            surfaceDigest,
            row.effect_ceiling,
            row.graph_hash,
            row.graph_event_id,
            row.graph_hash,
            authorityDigest,
            state,
            state === 'open' ? 0 : 1,
            row.opened_at,
            closedAt,
            closeReason,
          );
        }
      }

      if (tables.has('logical_tool_calls')) {
        const orphaned = (db.prepare(`
          SELECT COUNT(*) AS n FROM logical_tool_calls l
           WHERE NOT EXISTS (
             SELECT 1 FROM accepted_turn_call_authorities a
              WHERE a.session_id = l.session_id
                AND a.source_user_seq = l.source_user_seq
                AND a.accepted_task_id = l.accepted_task_id
           )
        `).get() as { n: number }).n;
        if (orphaned > 0) {
          throw new Error(`schema v50 refuses ${orphaned} logical call(s) without an accepted-turn authority root`);
        }
        rebuildLogicalToolCallAuthorityParent(db);
      }
    },
  },
  {
    /**
     * A real workflow-node activation can now own the same call kernel without
     * masquerading as a user turn or manufacturing graph topology. Existing
     * graph and host roots are copied byte-for-byte; logical/physical and all
     * settlement children retain their exact identities and foreign keys.
     */
    version: 51,
    foreignKeysOff: true,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of ['accepted_turn_call_authorities', 'logical_tool_calls']) {
        if (!tables.has(prerequisite)) throw new Error(`schema v51 prerequisite missing: ${prerequisite}`);
      }
      createWorkflowNodeInvocationActivationSchema(db);
      rebuildAcceptedCallAuthoritiesForWorkflow(db);
      db.exec(`
        DROP TRIGGER IF EXISTS trg_accepted_task_resolution_excludes_host_root;
        CREATE TRIGGER trg_accepted_task_resolution_excludes_host_root
        BEFORE INSERT ON accepted_task_resolutions
        WHEN EXISTS (
          SELECT 1 FROM accepted_turn_call_authorities a
           WHERE a.session_id = NEW.session_id
             AND a.source_user_seq = NEW.source_user_seq
             AND a.authority_kind != 'turn_graph'
        )
        BEGIN
          SELECT RAISE(ABORT, 'graph resolution cannot replace non-graph call authority');
        END;
      `);
    },
  },
  {
    /**
     * One durable cursor chain now owns many sequential child calls without
     * minting workflow retries. Page bodies keep using the shared logical,
     * physical, settlement and result-handle tables; only cursor/coverage truth
     * is normalized here.
     */
    version: 52,
    foreignKeysOff: true,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'accepted_turn_call_authorities',
        'logical_tool_calls',
        'workflow_node_invocation_activations',
      ]) {
        if (!tables.has(prerequisite)) throw new Error(`schema v52 prerequisite missing: ${prerequisite}`);
      }
      createWorkflowPaginatedReadSchema(db);
      rebuildAcceptedCallAuthoritiesForPagination(db);
      db.exec(`
        DROP TRIGGER IF EXISTS trg_accepted_task_resolution_excludes_host_root;
        CREATE TRIGGER trg_accepted_task_resolution_excludes_host_root
        BEFORE INSERT ON accepted_task_resolutions
        WHEN EXISTS (
          SELECT 1 FROM accepted_turn_call_authorities a
           WHERE a.session_id = NEW.session_id
             AND a.source_user_seq = NEW.source_user_seq
             AND a.authority_kind != 'turn_graph'
        )
        BEGIN
          SELECT RAISE(ABORT, 'graph resolution cannot replace non-graph call authority');
        END;
      `);
    },
  },
  {
    /**
     * Host-owned per-call stopping authority.
     *
     * A run-level dispatch lease could fence a late provider call, but it could
     * not say which accepted model call owned an already-started crossing. That
     * made a host deadline choose between hanging forever and detaching an
     * unidentifiable write. Bind a child generation to the exact logical call,
     * bind every crossing opened beneath it to that generation, and freeze the
     * terminal state/site into new logical settlements. Historical settlements
     * keep their v1 identity-only crossing digest; new settlements use v2.
     */
    version: 53,
    foreignKeysOff: true,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'run_dispatch_leases',
        'physical_dispatches',
        'logical_call_settlements',
        'logical_call_settlement_crossings',
      ]) {
        if (!tables.has(prerequisite)) throw new Error(`schema v53 prerequisite missing: ${prerequisite}`);
      }
      const columnsOf = (table: string): Set<string> => new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
      );
      const leaseColumns = columnsOf('run_dispatch_leases');
      if (!leaseColumns.has('source_user_seq')) {
        db.exec('ALTER TABLE run_dispatch_leases ADD COLUMN source_user_seq INTEGER');
      }
      if (!leaseColumns.has('accepted_task_id')) {
        db.exec('ALTER TABLE run_dispatch_leases ADD COLUMN accepted_task_id TEXT');
      }
      if (!leaseColumns.has('logical_tool_call_id')) {
        db.exec('ALTER TABLE run_dispatch_leases ADD COLUMN logical_tool_call_id TEXT');
      }
      if (!leaseColumns.has('recovery_effect')) {
        db.exec(`
          ALTER TABLE run_dispatch_leases ADD COLUMN recovery_effect TEXT
            CHECK (recovery_effect IS NULL OR recovery_effect IN (
              'read','compute','host_only','local_write','external_write','admin','unknown'
            ))
        `);
      }
      if (!leaseColumns.has('recovery_business_call')) {
        db.exec(`
          ALTER TABLE run_dispatch_leases ADD COLUMN recovery_business_call INTEGER
            CHECK (recovery_business_call IS NULL OR recovery_business_call IN (0, 1))
        `);
      }
      if (!leaseColumns.has('recovery_tool_name')) {
        db.exec(`
          ALTER TABLE run_dispatch_leases ADD COLUMN recovery_tool_name TEXT
            CHECK (recovery_tool_name IS NULL OR length(recovery_tool_name) BETWEEN 1 AND 512)
        `);
      }
      if (!leaseColumns.has('recovery_argument_digest')) {
        db.exec(`
          ALTER TABLE run_dispatch_leases ADD COLUMN recovery_argument_digest TEXT
            CHECK (recovery_argument_digest IS NULL OR length(recovery_argument_digest) = 64)
        `);
      }
      if (!leaseColumns.has('recovery_argument_cipher')) {
        db.exec(`
          ALTER TABLE run_dispatch_leases ADD COLUMN recovery_argument_cipher TEXT
            CHECK (recovery_argument_cipher IS NULL OR length(recovery_argument_cipher) BETWEEN 1 AND 48000)
        `);
      }
      if (!leaseColumns.has('recovery_turn')) {
        db.exec(`
          ALTER TABLE run_dispatch_leases ADD COLUMN recovery_turn INTEGER
            CHECK (recovery_turn IS NULL OR recovery_turn > 0)
        `);
      }

      const physicalColumns = columnsOf('physical_dispatches');
      if (!physicalColumns.has('lease_scope_id')) {
        db.exec('ALTER TABLE physical_dispatches ADD COLUMN lease_scope_id TEXT');
      }
      if (!physicalColumns.has('lease_id')) {
        db.exec('ALTER TABLE physical_dispatches ADD COLUMN lease_id TEXT');
      }

      const settlementColumns = columnsOf('logical_call_settlements');
      if (!settlementColumns.has('crossing_authority_version')) {
        db.exec(`
          ALTER TABLE logical_call_settlements
          ADD COLUMN crossing_authority_version INTEGER NOT NULL DEFAULT 1
            CHECK (crossing_authority_version IN (1, 2))
        `);
      }
      const frozenColumns = columnsOf('logical_call_settlement_crossings');
      if (!frozenColumns.has('terminal_state')) {
        db.exec(`
          ALTER TABLE logical_call_settlement_crossings ADD COLUMN terminal_state TEXT
            CHECK (terminal_state IS NULL OR terminal_state IN (
              'returned','threw','timed_out','cancelled','unknown'
            ))
        `);
      }
      if (!frozenColumns.has('execution_site')) {
        db.exec(`
          ALTER TABLE logical_call_settlement_crossings ADD COLUMN execution_site TEXT
            CHECK (execution_site IS NULL OR execution_site = 'host')
        `);
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_run_dispatch_leases_call_owner
          ON run_dispatch_leases(
            session_id, source_user_seq, accepted_task_id,
            logical_tool_call_id, lease_id, revoked_at
          );
        CREATE INDEX IF NOT EXISTS idx_run_dispatch_leases_host_recovery
          ON run_dispatch_leases(revoked_at, session_id, source_user_seq, logical_tool_call_id)
          WHERE source_user_seq IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_physical_dispatches_lease_generation
          ON physical_dispatches(session_id, lease_scope_id, lease_id, state);

        CREATE TRIGGER IF NOT EXISTS trg_run_dispatch_call_recovery_complete_insert
        BEFORE INSERT ON run_dispatch_leases
        WHEN (
          ((NEW.source_user_seq IS NOT NULL)
            + (NEW.accepted_task_id IS NOT NULL)
            + (NEW.logical_tool_call_id IS NOT NULL)) NOT IN (0, 3)
          OR ((NEW.source_user_seq IS NOT NULL) != (NEW.recovery_effect IS NOT NULL))
          OR ((NEW.source_user_seq IS NOT NULL) != (NEW.recovery_business_call IS NOT NULL))
          OR ((NEW.source_user_seq IS NOT NULL) != (NEW.recovery_tool_name IS NOT NULL))
          OR ((NEW.source_user_seq IS NOT NULL) != (NEW.recovery_argument_digest IS NOT NULL))
          OR ((NEW.source_user_seq IS NOT NULL) != (NEW.recovery_argument_cipher IS NOT NULL))
          OR (
            NEW.source_user_seq IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM logical_tool_calls call
               WHERE call.session_id = NEW.session_id
                 AND call.source_user_seq = NEW.source_user_seq
                 AND call.accepted_task_id = NEW.accepted_task_id
                 AND call.logical_tool_call_id = NEW.logical_tool_call_id
                 AND call.tool_name = NEW.recovery_tool_name
                 AND (call.argument_digest = NEW.recovery_argument_digest
                   OR call.raw_argument_digest = NEW.recovery_argument_digest)
            )
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'call lease requires one frozen recovery contract');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_run_dispatch_call_recovery_immutable
        BEFORE UPDATE OF session_id, lease_id, run_attempt_id,
                         parent_scope_id, parent_lease_id,
                         source_user_seq, accepted_task_id, logical_tool_call_id,
                         recovery_effect, recovery_business_call, recovery_tool_name,
                         recovery_argument_digest, recovery_argument_cipher, recovery_turn,
                         activated_at
        ON run_dispatch_leases
        WHEN OLD.source_user_seq IS NOT NULL OR NEW.source_user_seq IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'call lease identity and recovery contract are immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_physical_dispatch_lease_owner
        BEFORE INSERT ON physical_dispatches
        WHEN (
          (NEW.lease_scope_id IS NULL) != (NEW.lease_id IS NULL)
          OR (
            NEW.lease_scope_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM run_dispatch_leases lease
               WHERE lease.session_id = NEW.session_id
                 AND lease.scope_id = NEW.lease_scope_id
                 AND lease.lease_id = NEW.lease_id
                 AND lease.revoked_at IS NULL
                 AND lease.source_user_seq = NEW.source_user_seq
                 AND lease.accepted_task_id = NEW.accepted_task_id
                 AND lease.logical_tool_call_id = NEW.logical_tool_call_id
                 AND lease.recovery_effect IS NOT NULL
                 AND lease.recovery_business_call IS NOT NULL
                 AND lease.recovery_tool_name = NEW.tool_name
                 AND lease.recovery_argument_digest = NEW.argument_digest
            )
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'physical dispatch requires its exact current call lease');
        END;

        DROP TRIGGER IF EXISTS trg_physical_dispatch_identity_immutable;
        CREATE TRIGGER trg_physical_dispatch_identity_immutable
        BEFORE UPDATE OF accepted_task_id, logical_tool_call_id,
                         physical_dispatch_id, ordinal, relation, retry_of,
                         tool_name, argument_digest, lease_scope_id, lease_id
        ON physical_dispatches
        WHEN OLD.accepted_task_id IS NOT NEW.accepted_task_id
          OR OLD.logical_tool_call_id IS NOT NEW.logical_tool_call_id
          OR OLD.physical_dispatch_id IS NOT NEW.physical_dispatch_id
          OR OLD.ordinal IS NOT NEW.ordinal
          OR OLD.relation IS NOT NEW.relation
          OR OLD.retry_of IS NOT NEW.retry_of
          OR OLD.tool_name IS NOT NEW.tool_name
          OR OLD.argument_digest IS NOT NEW.argument_digest
          OR OLD.lease_scope_id IS NOT NEW.lease_scope_id
          OR OLD.lease_id IS NOT NEW.lease_id
        BEGIN
          SELECT RAISE(ABORT, 'physical dispatch identity is immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_logical_settlement_crossing_update_immutable
        BEFORE UPDATE ON logical_call_settlement_crossings
        BEGIN
          SELECT RAISE(ABORT, 'logical settlement crossings are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_logical_settlement_crossing_delete_immutable
        BEFORE DELETE ON logical_call_settlement_crossings
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'logical settlement crossings are immutable');
        END;
      `);
    },
  },
  {
    /** A distinct effect-capable foreground host authority. V53 call leases,
     * crossings and settlements remain the execution kernel; this migration
     * only teaches their shared accepted-source parent the new closed kind. */
    version: 54,
    foreignKeysOff: true,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of ['accepted_turn_call_authorities', 'logical_tool_calls']) {
        if (!tables.has(prerequisite)) throw new Error(`schema v54 prerequisite missing: ${prerequisite}`);
      }
      rebuildAcceptedCallAuthoritiesForProductionHost(db);
      db.exec('DROP TRIGGER IF EXISTS trg_logical_call_contract_refinement_once');
      createHostAwareLogicalRefinementTrigger(db);
    },
  },
  {
    /** Preserve historical user decisions while giving daemon/session cleanup
     * a truthful terminal outcome of its own. This is an enum-only widening;
     * no existing approval row is reclassified. */
    version: 55,
    foreignKeysOff: true,
    sql: '',
    backfill: widenPendingApprovalSystemCancellationResolution,
  },
  {
    /**
     * A settled foreground plan may add graph topology/evidence beneath the
     * already-open host_v1 call root. The root itself is never rewritten or
     * replaced. One immutable delivery receipt plus the exact local plan
     * settlement/result is required before a resolution row can coexist.
     */
    version: 56,
    foreignKeysOff: true,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'accepted_turn_call_authorities',
        'accepted_task_authority',
        'accepted_task_work_contracts',
        'accepted_task_resolutions',
        'logical_tool_calls',
        'logical_call_settlements',
        'logical_call_settlement_crossings',
        'physical_dispatches',
        'durable_result_handles',
      ]) {
        if (!tables.has(prerequisite)) throw new Error(`schema v56 prerequisite missing: ${prerequisite}`);
      }
      createHostPlannedResolutionCoexistenceSchema(db);
      db.exec(`
        DROP TRIGGER IF EXISTS trg_accepted_task_resolution_excludes_host_root;
        CREATE TRIGGER trg_accepted_task_resolution_excludes_host_root
        BEFORE INSERT ON accepted_task_resolutions
        WHEN EXISTS (
          SELECT 1 FROM accepted_turn_call_authorities a
           WHERE a.session_id = NEW.session_id
             AND a.source_user_seq = NEW.source_user_seq
             AND a.authority_kind != 'turn_graph'
        ) AND NOT ${hostPlannedResolutionProofSql('NEW', 'insert', 'legacy_success')}
        BEGIN
          SELECT RAISE(ABORT, 'graph resolution cannot replace non-graph call authority');
        END;
      `);
    },
  },
  {
    /**
     * Foreground host calls previously carried their exact capability envelope
     * only in process. Freeze it after logical admission and before any child
     * lease/body so restart, replay and terminal proof reopen the same provider
     * account/schema/tool/argument authority without inventing graph topology.
     */
    version: 57,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'accepted_turn_call_authorities',
        'logical_tool_calls',
      ]) {
        if (!tables.has(prerequisite)) throw new Error(`schema v57 prerequisite missing: ${prerequisite}`);
      }
      createV57HostCallCapabilityBindingSchema(db);
      refreshPlanTaskActivationReceiptInsertTrigger(db);
      const relevantTables = foreignKeyClosure(db, [
        'accepted_turn_call_authorities',
        'logical_tool_calls',
        'host_call_capability_bindings',
      ]);
      const violations = (db.pragma('foreign_key_check') as Array<{ table: string }>)
        .filter((violation) => relevantTables.has(violation.table));
      if (violations.length > 0) {
        throw new Error(`schema v57 foreign-key check failed for ${violations.length} host-call binding row(s)`);
      }
      const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new Error(`schema v57 integrity check failed: ${JSON.stringify(integrity).slice(0, 240)}`);
      }
    },
  },
  {
    /**
     * A call lease is frozen before a trusted resolver materializes optional
     * schema fields, while the physical row correctly names the logical call's
     * one immutable effective digest. The v53 trigger accepted only byte-equal
     * recovery/physical digests, so exact local host execution could complete
     * without its evidence crossing whenever materialization refined the
     * contract. Admit only the durable row's own verified raw -> effective
     * chain; every unrelated digest, tool, call, lease, or later refinement
     * remains outside the trigger proof.
     */
    version: 58,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'run_dispatch_leases',
        'logical_tool_calls',
        'physical_dispatches',
      ]) {
        if (!tables.has(prerequisite)) throw new Error(`schema v58 prerequisite missing: ${prerequisite}`);
      }
      db.exec(`
        DROP TRIGGER IF EXISTS trg_physical_dispatch_lease_owner;
        CREATE TRIGGER trg_physical_dispatch_lease_owner
        BEFORE INSERT ON physical_dispatches
        WHEN (
          (NEW.lease_scope_id IS NULL) != (NEW.lease_id IS NULL)
          OR (
            NEW.lease_scope_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM run_dispatch_leases lease
               WHERE lease.session_id = NEW.session_id
                 AND lease.scope_id = NEW.lease_scope_id
                 AND lease.lease_id = NEW.lease_id
                 AND lease.revoked_at IS NULL
                 AND lease.source_user_seq = NEW.source_user_seq
                 AND lease.accepted_task_id = NEW.accepted_task_id
                 AND lease.logical_tool_call_id = NEW.logical_tool_call_id
                 AND lease.recovery_effect IS NOT NULL
                 AND lease.recovery_business_call IS NOT NULL
                 AND lease.recovery_tool_name = NEW.tool_name
                 AND (
                   lease.recovery_argument_digest = NEW.argument_digest
                   OR EXISTS (
                     SELECT 1 FROM logical_tool_calls call
                      WHERE call.session_id = NEW.session_id
                        AND call.source_user_seq = NEW.source_user_seq
                        AND call.accepted_task_id = NEW.accepted_task_id
                        AND call.logical_tool_call_id = NEW.logical_tool_call_id
                        AND call.tool_name = NEW.tool_name
                        AND call.state = 'open'
                        AND call.raw_argument_digest = lease.recovery_argument_digest
                        AND call.effective_argument_digest IS NOT NULL
                        AND call.effective_argument_digest != call.raw_argument_digest
                        AND call.argument_digest = call.effective_argument_digest
                        AND NEW.argument_digest = call.effective_argument_digest
                   )
                 )
            )
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'physical dispatch requires its exact current call lease');
        END;
      `);
      const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new Error(`schema v58 integrity check failed: ${JSON.stringify(integrity).slice(0, 240)}`);
      }
    },
  },
  {
    /**
     * Durable, source-bound model/tool batch checkpoints for foreground host
     * turns.  A model frame is admitted before any tool body can start; the
     * balanced checkpoint is a separate append-only row written only after the
     * frame can be reconstructed from durable call evidence.  This two-record
     * protocol closes both restart windows without turning a process-local
     * history array into execution authority.
     *
     * The schema is deliberately capability-neutral.  It binds the same
     * accepted-turn call root, optional graph and immutable work contract used
     * by the execution kernel; no provider, connector or business-operation
     * names appear here.
     */
    version: 59,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'accepted_turn_call_authorities',
        'accepted_task_resolutions',
        'accepted_task_work_contracts',
      ]) {
        if (!tables.has(prerequisite)) throw new Error(`schema v59 prerequisite missing: ${prerequisite}`);
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS accepted_model_batch_admissions (
          session_id                 TEXT NOT NULL,
          source_user_seq            INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id           TEXT NOT NULL,
          batch_ordinal              INTEGER NOT NULL CHECK (batch_ordinal > 0),
          batch_id                   TEXT NOT NULL UNIQUE CHECK (length(batch_id) = 64),
          protocol_version           INTEGER NOT NULL CHECK (protocol_version = 1),
          authority_digest           TEXT NOT NULL CHECK (length(authority_digest) = 64),
          source_event_digest        TEXT NOT NULL CHECK (length(source_event_digest) = 64),
          source_turn                INTEGER NOT NULL CHECK (source_turn >= 0),
          engine_version             TEXT NOT NULL CHECK (length(engine_version) BETWEEN 1 AND 128),
          graph_event_id             TEXT REFERENCES events(id) ON DELETE RESTRICT,
          graph_hash                 TEXT CHECK (graph_hash IS NULL OR length(graph_hash) = 64),
          work_contract_id           TEXT CHECK (work_contract_id IS NULL OR length(work_contract_id) = 81),
          previous_response_id       TEXT CHECK (
                                       previous_response_id IS NULL
                                       OR length(previous_response_id) BETWEEN 1 AND 512
                                     ),
          provider_response_id       TEXT CHECK (
                                       provider_response_id IS NULL
                                       OR length(provider_response_id) BETWEEN 1 AND 512
                                     ),
          accepted_response_digest   TEXT NOT NULL CHECK (length(accepted_response_digest) = 64),
          pre_history_json           TEXT NOT NULL CHECK (
                                       json_valid(pre_history_json)
                                       AND json_type(pre_history_json) = 'array'
                                     ),
          pre_history_digest         TEXT NOT NULL CHECK (length(pre_history_digest) = 64),
          pre_history_item_count     INTEGER NOT NULL CHECK (pre_history_item_count >= 0),
          frame_history_json         TEXT NOT NULL CHECK (
                                       json_valid(frame_history_json)
                                       AND json_type(frame_history_json) = 'array'
                                     ),
          frame_history_digest       TEXT NOT NULL CHECK (length(frame_history_digest) = 64),
          frame_history_item_count   INTEGER NOT NULL CHECK (frame_history_item_count > 0),
          call_ids_json              TEXT NOT NULL CHECK (
                                       json_valid(call_ids_json)
                                       AND json_type(call_ids_json) = 'array'
                                     ),
          call_count                 INTEGER NOT NULL CHECK (call_count > 0),
          admitted_at                TEXT NOT NULL,
          PRIMARY KEY (session_id, source_user_seq, batch_ordinal),
          UNIQUE (session_id, source_user_seq, batch_ordinal, batch_id),
          FOREIGN KEY (session_id, source_user_seq)
            REFERENCES accepted_turn_call_authorities(session_id, source_user_seq)
            ON DELETE CASCADE,
          CHECK (
            (graph_event_id IS NULL AND graph_hash IS NULL AND work_contract_id IS NULL)
            OR
            (graph_event_id IS NOT NULL AND graph_hash IS NOT NULL AND work_contract_id IS NOT NULL)
          )
        );

        CREATE TABLE IF NOT EXISTS accepted_model_batch_checkpoints (
          session_id                 TEXT NOT NULL,
          source_user_seq            INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id           TEXT NOT NULL,
          batch_ordinal              INTEGER NOT NULL CHECK (batch_ordinal > 0),
          batch_id                   TEXT NOT NULL UNIQUE CHECK (length(batch_id) = 64),
          protocol_version           INTEGER NOT NULL CHECK (protocol_version = 1),
          authority_digest           TEXT NOT NULL CHECK (length(authority_digest) = 64),
          graph_event_id             TEXT REFERENCES events(id) ON DELETE RESTRICT,
          graph_hash                 TEXT CHECK (graph_hash IS NULL OR length(graph_hash) = 64),
          work_contract_id           TEXT CHECK (work_contract_id IS NULL OR length(work_contract_id) = 81),
          disposition                TEXT NOT NULL
                                     CHECK (disposition IN ('ready','reconciliation_required')),
          history_json               TEXT NOT NULL CHECK (
                                       json_valid(history_json)
                                       AND json_type(history_json) = 'array'
                                     ),
          history_digest             TEXT NOT NULL CHECK (length(history_digest) = 64),
          history_item_count         INTEGER NOT NULL CHECK (history_item_count > 0),
          last_response_id           TEXT CHECK (
                                       last_response_id IS NULL
                                       OR length(last_response_id) BETWEEN 1 AND 512
                                     ),
          committed_at               TEXT NOT NULL,
          PRIMARY KEY (session_id, source_user_seq, batch_ordinal),
          FOREIGN KEY (session_id, source_user_seq, batch_ordinal, batch_id)
            REFERENCES accepted_model_batch_admissions(
              session_id, source_user_seq, batch_ordinal, batch_id
            ) ON DELETE CASCADE,
          CHECK (
            (graph_event_id IS NULL AND graph_hash IS NULL AND work_contract_id IS NULL)
            OR
            (graph_event_id IS NOT NULL AND graph_hash IS NOT NULL AND work_contract_id IS NOT NULL)
          )
        );

        CREATE INDEX IF NOT EXISTS idx_accepted_model_batch_admissions_source
          ON accepted_model_batch_admissions(session_id, source_user_seq, batch_ordinal);
        CREATE INDEX IF NOT EXISTS idx_accepted_model_batch_checkpoints_source
          ON accepted_model_batch_checkpoints(session_id, source_user_seq, batch_ordinal);

        CREATE TRIGGER IF NOT EXISTS trg_accepted_model_batch_admission_exact_root
        BEFORE INSERT ON accepted_model_batch_admissions
        WHEN NOT EXISTS (
          SELECT 1 FROM accepted_turn_call_authorities root
           WHERE root.session_id = NEW.session_id
             AND root.source_user_seq = NEW.source_user_seq
             AND root.accepted_task_id = NEW.accepted_task_id
             AND root.authority_digest = NEW.authority_digest
             AND root.source_event_digest = NEW.source_event_digest
             AND root.source_turn = NEW.source_turn
             AND root.engine_version = NEW.engine_version
             AND root.authority_kind IN ('host_v1','host_v1_read_only')
             AND root.state = 'open'
        )
        BEGIN
          SELECT RAISE(ABORT, 'model batch admission requires its exact open host call root');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_accepted_model_batch_admission_exact_graph_contract
        BEFORE INSERT ON accepted_model_batch_admissions
        WHEN NOT (
          (
            NEW.graph_event_id IS NULL
            AND NEW.graph_hash IS NULL
            AND NEW.work_contract_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM accepted_task_resolutions resolution
               WHERE resolution.session_id = NEW.session_id
                 AND resolution.source_user_seq = NEW.source_user_seq
            )
          )
          OR
          EXISTS (
            SELECT 1
              FROM accepted_task_resolutions resolution
              JOIN accepted_task_work_contracts contract
                ON contract.session_id = resolution.session_id
               AND contract.source_user_seq = resolution.source_user_seq
               AND contract.accepted_task_id = resolution.accepted_task_id
               AND contract.graph_event_id = resolution.graph_event_id
               AND contract.graph_hash = resolution.graph_hash
             WHERE resolution.session_id = NEW.session_id
               AND resolution.source_user_seq = NEW.source_user_seq
               AND resolution.accepted_task_id = NEW.accepted_task_id
               AND resolution.graph_event_id = NEW.graph_event_id
               AND resolution.graph_hash = NEW.graph_hash
               AND resolution.state != 'legacy_ambiguous'
               AND contract.contract_id = NEW.work_contract_id
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'model batch admission graph/contract binding is not exact');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_accepted_model_batch_admission_chain
        BEFORE INSERT ON accepted_model_batch_admissions
        WHEN NOT (
          (
            NEW.batch_ordinal = 1
            AND NOT EXISTS (
              SELECT 1 FROM accepted_model_batch_admissions prior
               WHERE prior.session_id = NEW.session_id
                 AND prior.source_user_seq = NEW.source_user_seq
            )
          )
          OR
          EXISTS (
            SELECT 1
              FROM accepted_model_batch_checkpoints prior
             WHERE prior.session_id = NEW.session_id
               AND prior.source_user_seq = NEW.source_user_seq
               AND prior.batch_ordinal = NEW.batch_ordinal - 1
               AND prior.history_digest = NEW.pre_history_digest
               AND prior.last_response_id IS NEW.previous_response_id
               AND prior.authority_digest = NEW.authority_digest
               AND (
                 (
                   prior.graph_event_id IS NEW.graph_event_id
                   AND prior.graph_hash IS NEW.graph_hash
                   AND prior.work_contract_id IS NEW.work_contract_id
                 )
                 OR
                 (
                   prior.graph_event_id IS NULL
                   AND prior.graph_hash IS NULL
                   AND prior.work_contract_id IS NULL
                   AND NEW.graph_event_id IS NOT NULL
                   AND NEW.graph_hash IS NOT NULL
                   AND NEW.work_contract_id IS NOT NULL
                   AND EXISTS (
                     SELECT 1
                       FROM accepted_task_resolutions r
                       JOIN accepted_task_work_contracts contract
                         ON contract.session_id = r.session_id
                        AND contract.source_user_seq = r.source_user_seq
                        AND contract.accepted_task_id = r.accepted_task_id
                        AND contract.graph_event_id = r.graph_event_id
                        AND contract.graph_hash = r.graph_hash
                      WHERE r.session_id = NEW.session_id
                        AND r.source_user_seq = NEW.source_user_seq
                        AND r.accepted_task_id = NEW.accepted_task_id
                        AND r.graph_event_id = NEW.graph_event_id
                        AND r.graph_hash = NEW.graph_hash
                        AND contract.contract_id = NEW.work_contract_id
                        AND ${hostPlannedResolutionProofSql('r', 'existing', 'legacy_success')}
                   )
                 )
               )
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'model batch admission requires the exact prior balanced checkpoint');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_accepted_model_batch_admission_immutable
        BEFORE UPDATE ON accepted_model_batch_admissions
        BEGIN
          SELECT RAISE(ABORT, 'model batch admissions are append-only');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_accepted_model_batch_admission_delete_immutable
        BEFORE DELETE ON accepted_model_batch_admissions
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'model batch admissions are append-only');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_accepted_model_batch_checkpoint_exact_admission
        BEFORE INSERT ON accepted_model_batch_checkpoints
        WHEN NOT EXISTS (
          SELECT 1 FROM accepted_model_batch_admissions admission
           WHERE admission.session_id = NEW.session_id
             AND admission.source_user_seq = NEW.source_user_seq
             AND admission.accepted_task_id = NEW.accepted_task_id
             AND admission.batch_ordinal = NEW.batch_ordinal
             AND admission.batch_id = NEW.batch_id
             AND admission.protocol_version = NEW.protocol_version
             AND admission.authority_digest = NEW.authority_digest
             AND NEW.last_response_id IS COALESCE(
                   admission.provider_response_id,
                   admission.previous_response_id
                 )
             AND (
               (
                 admission.graph_event_id IS NEW.graph_event_id
                 AND admission.graph_hash IS NEW.graph_hash
                 AND admission.work_contract_id IS NEW.work_contract_id
               )
               OR
               (
                 admission.graph_event_id IS NULL
                 AND admission.graph_hash IS NULL
                 AND admission.work_contract_id IS NULL
                 AND NEW.graph_event_id IS NOT NULL
                 AND NEW.graph_hash IS NOT NULL
                 AND NEW.work_contract_id IS NOT NULL
               )
             )
        )
        BEGIN
          SELECT RAISE(ABORT, 'model batch checkpoint requires its exact immutable admission');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_accepted_model_batch_checkpoint_exact_root
        BEFORE INSERT ON accepted_model_batch_checkpoints
        WHEN NOT EXISTS (
          SELECT 1 FROM accepted_turn_call_authorities root
           WHERE root.session_id = NEW.session_id
             AND root.source_user_seq = NEW.source_user_seq
             AND root.accepted_task_id = NEW.accepted_task_id
             AND root.authority_digest = NEW.authority_digest
             AND root.authority_kind IN ('host_v1','host_v1_read_only')
             AND root.state = 'open'
        )
        BEGIN
          SELECT RAISE(ABORT, 'model batch checkpoint requires its exact open host call root');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_accepted_model_batch_checkpoint_exact_graph_contract
        BEFORE INSERT ON accepted_model_batch_checkpoints
        WHEN NOT (
          (
            NEW.graph_event_id IS NULL
            AND NEW.graph_hash IS NULL
            AND NEW.work_contract_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM accepted_task_resolutions resolution
               WHERE resolution.session_id = NEW.session_id
                 AND resolution.source_user_seq = NEW.source_user_seq
            )
          )
          OR
          EXISTS (
            SELECT 1
              FROM accepted_task_resolutions resolution
              JOIN accepted_task_work_contracts contract
                ON contract.session_id = resolution.session_id
               AND contract.source_user_seq = resolution.source_user_seq
               AND contract.accepted_task_id = resolution.accepted_task_id
               AND contract.graph_event_id = resolution.graph_event_id
               AND contract.graph_hash = resolution.graph_hash
             WHERE resolution.session_id = NEW.session_id
               AND resolution.source_user_seq = NEW.source_user_seq
               AND resolution.accepted_task_id = NEW.accepted_task_id
               AND resolution.graph_event_id = NEW.graph_event_id
               AND resolution.graph_hash = NEW.graph_hash
               AND resolution.state != 'legacy_ambiguous'
               AND contract.contract_id = NEW.work_contract_id
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'model batch checkpoint graph/contract binding is not exact');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_accepted_model_batch_checkpoint_immutable
        BEFORE UPDATE ON accepted_model_batch_checkpoints
        BEGIN
          SELECT RAISE(ABORT, 'model batch checkpoints are append-only');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_accepted_model_batch_checkpoint_delete_immutable
        BEFORE DELETE ON accepted_model_batch_checkpoints
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'model batch checkpoints are append-only');
        END;
      `);

      const relevantTables = foreignKeyClosure(db, [
        'accepted_model_batch_admissions',
        'accepted_model_batch_checkpoints',
      ]);
      const violations = (db.pragma('foreign_key_check') as Array<{ table: string }>)
        .filter((violation) => relevantTables.has(violation.table));
      if (violations.length > 0) {
        throw new Error(`schema v59 foreign-key check failed for ${violations.length} model-batch row(s)`);
      }
      const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new Error(`schema v59 integrity check failed: ${JSON.stringify(integrity).slice(0, 240)}`);
      }
    },
  },
  {
    // Durable, audience-keyed conversational head plus immutable accepted-
    // source selection. Selection and pointer advancement occur inside one
    // IMMEDIATE transaction; a provider retry reopens its exact binding.
    version: 60,
    sql: `
      CREATE TABLE IF NOT EXISTS accepted_source_session_pointers (
        -- Opaque lineage key. It intentionally is not a sessions FK: a TTL
        -- reap of the historical parent must not strand a live successor.
        root_session_id TEXT NOT NULL,
        continuity_digest TEXT NOT NULL
          CHECK (length(continuity_digest) = 64 AND continuity_digest NOT GLOB '*[^0-9a-f]*'),
        head_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (root_session_id, continuity_digest)
      );

      CREATE TABLE IF NOT EXISTS accepted_source_session_bindings (
        durable_source_digest TEXT PRIMARY KEY
          CHECK (length(durable_source_digest) = 64 AND durable_source_digest NOT GLOB '*[^0-9a-f]*'),
        root_session_id TEXT NOT NULL,
        continuity_digest TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
        disposition TEXT NOT NULL
          CHECK (disposition IN ('reused','branched','identity_split','bound_control')),
        selected_after_seq INTEGER NOT NULL CHECK (selected_after_seq >= 0),
        created_at TEXT NOT NULL,
        FOREIGN KEY (root_session_id, continuity_digest)
          REFERENCES accepted_source_session_pointers(root_session_id, continuity_digest)
          ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_accepted_source_session_bindings_session
        ON accepted_source_session_bindings(session_id, created_at DESC);

      CREATE TRIGGER IF NOT EXISTS trg_accepted_source_session_binding_immutable
      BEFORE UPDATE ON accepted_source_session_bindings
      BEGIN
        SELECT RAISE(ABORT, 'accepted source session bindings are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_accepted_source_session_pointer_identity_immutable
      BEFORE UPDATE ON accepted_source_session_pointers
      WHEN OLD.root_session_id != NEW.root_session_id
        OR OLD.continuity_digest != NEW.continuity_digest
      BEGIN
        SELECT RAISE(ABORT, 'accepted source session pointer identity is immutable');
      END;
    `,
  },
  {
    /**
     * Staged provider-file authority and crash-safe physical returns.
     *
     * A transfer side effect is never hidden inside the parent's provider
     * call. Every source read, presign, object-store transfer, business POST,
     * download and local commit owns an exact logical/physical/stage tuple.
     * Only the business stage may reuse the parent logical call; every other
     * stage is a control dependency that is forbidden from binding or
     * discharging expected work.
     *
     * Provider return bytes remain outside SQLite in an authenticated encrypted
     * spill. The checkpoint stores only digests/counts and is valid only beside
     * its exact returned physical crossing. It is forensic recovery authority,
     * not a result handle or a second success settlement.
     */
    version: 61,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'logical_tool_calls',
        'physical_dispatches',
        'logical_call_settlements',
        'expected_work_call_bindings',
        'host_call_capability_bindings',
        'capability_manifests',
        'run_dispatch_leases',
        'pending_approvals',
      ]) {
        if (!tables.has(prerequisite)) {
          throw new Error(`schema v61 prerequisite missing: ${prerequisite}`);
        }
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS staged_transfer_plans (
          plan_id                    TEXT PRIMARY KEY
                                     CHECK (length(plan_id) BETWEEN 1 AND 256),
          session_id                 TEXT NOT NULL,
          source_user_seq            INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id           TEXT NOT NULL,
          parent_logical_tool_call_id TEXT NOT NULL,
          parent_tool_name           TEXT NOT NULL CHECK (length(parent_tool_name) BETWEEN 1 AND 512),
          parent_argument_digest     TEXT NOT NULL
                                     CHECK (length(parent_argument_digest) = 64
                                       AND parent_argument_digest NOT GLOB '*[^0-9a-f]*'),
          parent_effect_kind         TEXT NOT NULL CHECK (parent_effect_kind IN (
                                       'read','compute','local_write','external_write','admin'
                                     )),
          expected_work_contract_id  TEXT NOT NULL CHECK (length(expected_work_contract_id) BETWEEN 1 AND 256),
          expected_work_requirement_id TEXT NOT NULL CHECK (length(expected_work_requirement_id) BETWEEN 1 AND 256),
          expected_work_binding_digest TEXT NOT NULL
                                     CHECK (length(expected_work_binding_digest) = 64
                                       AND expected_work_binding_digest NOT GLOB '*[^0-9a-f]*'),
          host_durable_binding_digest TEXT NOT NULL
                                     CHECK (length(host_durable_binding_digest) = 64
                                       AND host_durable_binding_digest NOT GLOB '*[^0-9a-f]*'),
          host_capability_id          TEXT NOT NULL CHECK (length(host_capability_id) BETWEEN 1 AND 512),
          host_account_id             TEXT NOT NULL CHECK (length(host_account_id) BETWEEN 1 AND 512),
          host_invoke_port_id         TEXT NOT NULL CHECK (length(host_invoke_port_id) BETWEEN 1 AND 512),
          host_operation_id           TEXT NOT NULL CHECK (length(host_operation_id) BETWEEN 1 AND 512),
          host_provider_input_schema_digest TEXT NOT NULL
                                     CHECK (length(host_provider_input_schema_digest) = 64
                                       AND host_provider_input_schema_digest NOT GLOB '*[^0-9a-f]*'),
          host_schema_fingerprint     TEXT NOT NULL
                                     CHECK (length(host_schema_fingerprint) = 64
                                       AND host_schema_fingerprint NOT GLOB '*[^0-9a-f]*'),
          host_definition_fingerprint TEXT NOT NULL
                                     CHECK (length(host_definition_fingerprint) = 64
                                       AND host_definition_fingerprint NOT GLOB '*[^0-9a-f]*'),
          host_manifest_id            TEXT NOT NULL CHECK (length(host_manifest_id) BETWEEN 1 AND 512),
          host_manifest_digest        TEXT NOT NULL
                                     CHECK (length(host_manifest_digest) = 64
                                       AND host_manifest_digest NOT GLOB '*[^0-9a-f]*'),
          input_schema_digest        TEXT NOT NULL
                                     CHECK (length(input_schema_digest) = 64
                                       AND input_schema_digest NOT GLOB '*[^0-9a-f]*'),
          output_schema_digest       TEXT
                                     CHECK (output_schema_digest IS NULL OR (
                                       length(output_schema_digest) = 64
                                       AND output_schema_digest NOT GLOB '*[^0-9a-f]*'
                                     )),
          operation_version          TEXT NOT NULL CHECK (length(operation_version) BETWEEN 1 AND 160),
          toolkit_slug               TEXT NOT NULL CHECK (length(toolkit_slug) BETWEEN 1 AND 160),
          account_identity_digest    TEXT NOT NULL
                                     CHECK (length(account_identity_digest) = 64
                                       AND account_identity_digest NOT GLOB '*[^0-9a-f]*'),
          transfer_manifest_digest   TEXT NOT NULL
                                     CHECK (length(transfer_manifest_digest) = 64
                                       AND transfer_manifest_digest NOT GLOB '*[^0-9a-f]*'),
          manifest_binding_digest    TEXT NOT NULL
                                     CHECK (length(manifest_binding_digest) = 64
                                       AND manifest_binding_digest NOT GLOB '*[^0-9a-f]*'),
          manifest_payload_id        TEXT NOT NULL UNIQUE
                                     CHECK (manifest_payload_id GLOB 'authority-payload:*'),
          manifest_format            TEXT NOT NULL
                                     CHECK (manifest_format = 'staged_transfer_manifest_v1'),
          manifest_plaintext_sha256  TEXT NOT NULL
                                     CHECK (length(manifest_plaintext_sha256) = 64
                                       AND manifest_plaintext_sha256 NOT GLOB '*[^0-9a-f]*'),
          manifest_plaintext_bytes   INTEGER NOT NULL CHECK (manifest_plaintext_bytes >= 0),
          manifest_chunk_count       INTEGER NOT NULL CHECK (manifest_chunk_count >= 0),
          manifest_sealed_sha256     TEXT NOT NULL
                                     CHECK (length(manifest_sealed_sha256) = 64
                                       AND manifest_sealed_sha256 NOT GLOB '*[^0-9a-f]*'),
          manifest_sealed_bytes      INTEGER NOT NULL CHECK (manifest_sealed_bytes > 0),
          state                      TEXT NOT NULL DEFAULT 'prepared'
                                     CHECK (state IN (
                                       'prepared','executing','business_returned',
                                       'downloads_complete','settled'
                                     )),
          created_at                 TEXT NOT NULL,
          updated_at                 TEXT NOT NULL,
          CHECK (input_schema_digest = host_provider_input_schema_digest),
          FOREIGN KEY (session_id, source_user_seq, parent_logical_tool_call_id)
            REFERENCES logical_tool_calls(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS uq_staged_transfer_parent_call
          ON staged_transfer_plans(session_id, source_user_seq, parent_logical_tool_call_id);

        CREATE TABLE IF NOT EXISTS staged_transfer_stage_authorities (
          stage_authority_id       TEXT PRIMARY KEY CHECK (length(stage_authority_id) BETWEEN 1 AND 256),
          plan_id                  TEXT NOT NULL REFERENCES staged_transfer_plans(plan_id) ON DELETE CASCADE,
          session_id               TEXT NOT NULL,
          source_user_seq          INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id         TEXT NOT NULL,
          stage_ordinal            INTEGER NOT NULL CHECK (stage_ordinal > 0),
          stage_kind               TEXT NOT NULL CHECK (stage_kind IN (
                                     'local_snapshot','source_download','upload_presign','upload_transfer',
                                     'business_execute','download_transfer','local_commit'
                                   )),
          json_pointer_digest      TEXT
                                   CHECK (json_pointer_digest IS NULL OR (
                                     length(json_pointer_digest) = 64
                                     AND json_pointer_digest NOT GLOB '*[^0-9a-f]*'
                                   )),
          logical_tool_call_id     TEXT NOT NULL,
          physical_dispatch_id     TEXT NOT NULL,
          tool_name                TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 512),
          argument_digest          TEXT NOT NULL
                                   CHECK (length(argument_digest) = 64
                                     AND argument_digest NOT GLOB '*[^0-9a-f]*'),
          effect_kind              TEXT NOT NULL CHECK (effect_kind IN (
                                     'read','compute','local_write','external_write','admin'
                                   )),
          lease_scope_id           TEXT NOT NULL CHECK (length(lease_scope_id) BETWEEN 1 AND 512),
          lease_id                 TEXT NOT NULL CHECK (length(lease_id) BETWEEN 1 AND 512),
          depends_on_stage_ordinal INTEGER CHECK (
                                     depends_on_stage_ordinal IS NULL
                                     OR depends_on_stage_ordinal > 0
                                   ),
          authority_digest         TEXT NOT NULL UNIQUE
                                   CHECK (length(authority_digest) = 64
                                     AND authority_digest NOT GLOB '*[^0-9a-f]*'),
          created_at               TEXT NOT NULL,
          UNIQUE (plan_id, stage_ordinal),
          UNIQUE (session_id, source_user_seq, logical_tool_call_id),
          UNIQUE (session_id, source_user_seq, physical_dispatch_id),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_tool_calls(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS physical_dispatch_return_checkpoints (
          checkpoint_id          TEXT PRIMARY KEY CHECK (length(checkpoint_id) BETWEEN 1 AND 256),
          session_id             TEXT NOT NULL,
          source_user_seq        INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id       TEXT NOT NULL,
          logical_tool_call_id   TEXT NOT NULL,
          physical_dispatch_id   TEXT NOT NULL,
          stage_authority_id     TEXT NOT NULL UNIQUE
                                 REFERENCES staged_transfer_stage_authorities(stage_authority_id)
                                 ON DELETE CASCADE,
          stage_kind             TEXT NOT NULL CHECK (stage_kind IN (
                                   'local_snapshot','source_download','upload_presign','upload_transfer',
                                   'business_execute','download_transfer','local_commit'
                                 )),
          stage_ordinal          INTEGER NOT NULL CHECK (stage_ordinal > 0),
          tool_name              TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 512),
          argument_digest        TEXT NOT NULL
                                 CHECK (length(argument_digest) = 64
                                   AND argument_digest NOT GLOB '*[^0-9a-f]*'),
          lease_scope_id         TEXT NOT NULL CHECK (length(lease_scope_id) BETWEEN 1 AND 512),
          lease_id               TEXT NOT NULL CHECK (length(lease_id) BETWEEN 1 AND 512),
          payload_id             TEXT NOT NULL UNIQUE CHECK (payload_id GLOB 'authority-payload:*'),
          payload_plaintext_sha256 TEXT NOT NULL
                                 CHECK (length(payload_plaintext_sha256) = 64
                                   AND payload_plaintext_sha256 NOT GLOB '*[^0-9a-f]*'),
          payload_plaintext_bytes INTEGER NOT NULL CHECK (payload_plaintext_bytes >= 0),
          payload_chunk_count    INTEGER NOT NULL CHECK (payload_chunk_count >= 0),
          payload_sealed_sha256  TEXT NOT NULL
                                 CHECK (length(payload_sealed_sha256) = 64
                                   AND payload_sealed_sha256 NOT GLOB '*[^0-9a-f]*'),
          payload_sealed_bytes   INTEGER NOT NULL CHECK (payload_sealed_bytes > 0),
          created_at             TEXT NOT NULL,
          UNIQUE (session_id, source_user_seq, physical_dispatch_id),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id, physical_dispatch_id)
            REFERENCES physical_dispatches(
              session_id, source_user_seq, logical_tool_call_id, physical_dispatch_id
            ) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS staged_transfer_stage_receipts (
          stage_authority_id     TEXT PRIMARY KEY
                                 REFERENCES staged_transfer_stage_authorities(stage_authority_id)
                                 ON DELETE CASCADE,
          plan_id                TEXT NOT NULL REFERENCES staged_transfer_plans(plan_id) ON DELETE CASCADE,
          session_id             TEXT NOT NULL,
          source_user_seq        INTEGER NOT NULL CHECK (source_user_seq > 0),
          stage_ordinal          INTEGER NOT NULL CHECK (stage_ordinal > 0),
          physical_dispatch_id   TEXT NOT NULL,
          terminal_state         TEXT NOT NULL CHECK (terminal_state IN (
                                   'returned','threw','timed_out','cancelled','unknown'
                                 )),
          result_digest          TEXT CHECK (result_digest IS NULL OR (
                                   length(result_digest) = 64
                                   AND result_digest NOT GLOB '*[^0-9a-f]*'
                                 )),
          recorded_at            TEXT NOT NULL,
          UNIQUE (plan_id, stage_ordinal),
          UNIQUE (session_id, source_user_seq, physical_dispatch_id),
          FOREIGN KEY (session_id, source_user_seq, physical_dispatch_id)
            REFERENCES physical_dispatches(session_id, source_user_seq, physical_dispatch_id)
            ON DELETE CASCADE,
          CHECK (
            (terminal_state = 'returned' AND result_digest IS NOT NULL)
            OR terminal_state != 'returned'
          )
        );

        CREATE INDEX IF NOT EXISTS idx_staged_transfer_plan_state
          ON staged_transfer_plans(session_id, source_user_seq, state, updated_at);
        CREATE INDEX IF NOT EXISTS idx_staged_transfer_stage_plan
          ON staged_transfer_stage_authorities(plan_id, stage_ordinal);

        CREATE TRIGGER IF NOT EXISTS trg_staged_transfer_plan_exact_parent
        BEFORE INSERT ON staged_transfer_plans
        WHEN NOT EXISTS (
          SELECT 1
            FROM logical_tool_calls l
            JOIN expected_work_call_bindings b
              ON b.session_id = l.session_id
             AND b.source_user_seq = l.source_user_seq
             AND b.logical_tool_call_id = l.logical_tool_call_id
           WHERE l.session_id = NEW.session_id
             AND l.source_user_seq = NEW.source_user_seq
             AND l.accepted_task_id = NEW.accepted_task_id
             AND l.logical_tool_call_id = NEW.parent_logical_tool_call_id
             AND l.tool_name = NEW.parent_tool_name
             AND l.argument_digest = NEW.parent_argument_digest
             AND l.state = 'open'
             AND b.accepted_task_id = NEW.accepted_task_id
             AND b.contract_id = NEW.expected_work_contract_id
             AND b.requirement_id = NEW.expected_work_requirement_id
             AND b.tool_name = NEW.parent_tool_name
             AND b.argument_digest = NEW.parent_argument_digest
             AND b.effect_kind = NEW.parent_effect_kind
             AND EXISTS (
               SELECT 1 FROM host_call_capability_bindings host
                WHERE host.session_id = NEW.session_id
                  AND host.source_user_seq = NEW.source_user_seq
                  AND host.accepted_task_id = NEW.accepted_task_id
                  AND host.logical_tool_call_id = NEW.parent_logical_tool_call_id
                  AND host.tool_name = NEW.parent_tool_name
                  AND host.attested_argument_digest = NEW.parent_argument_digest
                  AND host.effect = NEW.parent_effect_kind
                  AND host.binding_kind = 'catalog_manifest'
                  AND host.capability_id = NEW.host_capability_id
                  AND host.account_id = NEW.host_account_id
                  AND host.invoke_port_id = NEW.host_invoke_port_id
                  AND host.operation_id = NEW.host_operation_id
                  AND host.provider_input_schema_digest = NEW.host_provider_input_schema_digest
                  AND host.schema_fingerprint = NEW.host_schema_fingerprint
                  AND host.manifest_id = NEW.host_manifest_id
                  AND host.manifest_digest = NEW.host_manifest_digest
                  AND host.durable_binding_digest = NEW.host_durable_binding_digest
                  AND EXISTS (
                    SELECT 1 FROM capability_manifests manifest
                     WHERE manifest.manifest_id = NEW.host_manifest_id
                       AND manifest.digest = NEW.host_manifest_digest
                       AND manifest.lifecycle = 'current'
                       AND json_valid(manifest.manifest_json)
                       AND json_extract(manifest.manifest_json, '$.version') = 1
                       AND json_extract(manifest.manifest_json, '$.manifestId') = NEW.host_manifest_id
                       AND json_extract(manifest.manifest_json, '$.providerKind') = 'composio'
                       AND json_extract(manifest.manifest_json, '$.operationId') = NEW.host_operation_id
                       AND json_extract(manifest.manifest_json, '$.operationVersion') = NEW.operation_version
                       AND json_extract(manifest.manifest_json, '$.definitionFingerprint') = NEW.host_definition_fingerprint
                       AND json_extract(manifest.manifest_json, '$.externalDefinition.providerInputSchemaDigest')
                           = NEW.host_provider_input_schema_digest
                       AND json_extract(manifest.manifest_json, '$.accountId') = NEW.host_account_id
                       AND json_extract(manifest.manifest_json, '$.invokePortId') = NEW.host_invoke_port_id
                       AND json_extract(manifest.manifest_json, '$.lifecycle.state') = 'current'
                  )
             )
        )
        BEGIN
          SELECT RAISE(ABORT, 'staged transfer requires its exact open parent call');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_staged_transfer_plan_identity_immutable
        BEFORE UPDATE ON staged_transfer_plans
        WHEN OLD.plan_id IS NOT NEW.plan_id
          OR OLD.session_id IS NOT NEW.session_id
          OR OLD.source_user_seq IS NOT NEW.source_user_seq
          OR OLD.accepted_task_id IS NOT NEW.accepted_task_id
          OR OLD.parent_logical_tool_call_id IS NOT NEW.parent_logical_tool_call_id
          OR OLD.parent_tool_name IS NOT NEW.parent_tool_name
          OR OLD.parent_argument_digest IS NOT NEW.parent_argument_digest
          OR OLD.parent_effect_kind IS NOT NEW.parent_effect_kind
          OR OLD.expected_work_contract_id IS NOT NEW.expected_work_contract_id
          OR OLD.expected_work_requirement_id IS NOT NEW.expected_work_requirement_id
          OR OLD.expected_work_binding_digest IS NOT NEW.expected_work_binding_digest
          OR OLD.host_durable_binding_digest IS NOT NEW.host_durable_binding_digest
          OR OLD.host_capability_id IS NOT NEW.host_capability_id
          OR OLD.host_account_id IS NOT NEW.host_account_id
          OR OLD.host_invoke_port_id IS NOT NEW.host_invoke_port_id
          OR OLD.host_operation_id IS NOT NEW.host_operation_id
          OR OLD.host_provider_input_schema_digest IS NOT NEW.host_provider_input_schema_digest
          OR OLD.host_schema_fingerprint IS NOT NEW.host_schema_fingerprint
          OR OLD.host_definition_fingerprint IS NOT NEW.host_definition_fingerprint
          OR OLD.host_manifest_id IS NOT NEW.host_manifest_id
          OR OLD.host_manifest_digest IS NOT NEW.host_manifest_digest
          OR OLD.input_schema_digest IS NOT NEW.input_schema_digest
          OR OLD.output_schema_digest IS NOT NEW.output_schema_digest
          OR OLD.operation_version IS NOT NEW.operation_version
          OR OLD.toolkit_slug IS NOT NEW.toolkit_slug
          OR OLD.account_identity_digest IS NOT NEW.account_identity_digest
          OR OLD.transfer_manifest_digest IS NOT NEW.transfer_manifest_digest
          OR OLD.manifest_binding_digest IS NOT NEW.manifest_binding_digest
          OR OLD.manifest_payload_id IS NOT NEW.manifest_payload_id
          OR OLD.manifest_format IS NOT NEW.manifest_format
          OR OLD.manifest_plaintext_sha256 IS NOT NEW.manifest_plaintext_sha256
          OR OLD.manifest_plaintext_bytes IS NOT NEW.manifest_plaintext_bytes
          OR OLD.manifest_chunk_count IS NOT NEW.manifest_chunk_count
          OR OLD.manifest_sealed_sha256 IS NOT NEW.manifest_sealed_sha256
          OR OLD.manifest_sealed_bytes IS NOT NEW.manifest_sealed_bytes
          OR OLD.created_at IS NOT NEW.created_at
        BEGIN
          SELECT RAISE(ABORT, 'staged transfer plan authority is immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_staged_transfer_plan_delete_immutable
        BEFORE DELETE ON staged_transfer_plans
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'staged transfer plan authority is immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_staged_transfer_plan_state_machine
        BEFORE UPDATE OF state ON staged_transfer_plans
        WHEN OLD.state IS NOT NEW.state AND NOT (
          (OLD.state = 'prepared' AND NEW.state = 'executing')
          OR (OLD.state = 'executing' AND NEW.state = 'business_returned')
          OR (OLD.state = 'business_returned' AND NEW.state IN ('downloads_complete','settled'))
          OR (OLD.state = 'downloads_complete' AND NEW.state = 'settled')
        )
        BEGIN
          SELECT RAISE(ABORT, 'invalid staged transfer plan transition');
        END;

        /* State is a bounded index hint, never recovery authority. Even that
         * hint may advance only beside the exact receipts/parent settlement;
         * recovery recomputes progress from immutable rows and encrypted
         * definition/result authority instead of trusting this column. */
        CREATE TRIGGER IF NOT EXISTS trg_staged_transfer_plan_state_receipts
        BEFORE UPDATE OF state ON staged_transfer_plans
        WHEN OLD.state IS NOT NEW.state AND (
          (NEW.state IN ('business_returned','downloads_complete','settled')
            AND NOT EXISTS (
              SELECT 1
                FROM staged_transfer_stage_authorities business
                JOIN staged_transfer_stage_receipts receipt
                  ON receipt.stage_authority_id = business.stage_authority_id
               WHERE business.plan_id = NEW.plan_id
                 AND business.stage_kind = 'business_execute'
                 AND receipt.terminal_state = 'returned'
            ))
          OR (NEW.state IN ('downloads_complete','settled') AND EXISTS (
            SELECT 1 FROM staged_transfer_stage_authorities download
             WHERE download.plan_id = NEW.plan_id
               AND download.stage_kind IN ('download_transfer','local_commit')
               AND NOT EXISTS (
                 SELECT 1 FROM staged_transfer_stage_receipts receipt
                  WHERE receipt.stage_authority_id = download.stage_authority_id
                    AND receipt.terminal_state = 'returned'
               )
          ))
          OR (NEW.state = 'settled' AND NOT EXISTS (
            SELECT 1 FROM logical_call_settlements settled
             WHERE settled.session_id = NEW.session_id
               AND settled.source_user_seq = NEW.source_user_seq
               AND settled.logical_tool_call_id = NEW.parent_logical_tool_call_id
          ))
        )
        BEGIN
          SELECT RAISE(ABORT, 'staged transfer plan state lacks exact receipts');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_staged_transfer_stage_exact_plan
        BEFORE INSERT ON staged_transfer_stage_authorities
        WHEN NOT EXISTS (
          SELECT 1
            FROM staged_transfer_plans p
            JOIN logical_tool_calls l
              ON l.session_id = NEW.session_id
             AND l.source_user_seq = NEW.source_user_seq
             AND l.logical_tool_call_id = NEW.logical_tool_call_id
           WHERE p.plan_id = NEW.plan_id
             AND p.session_id = NEW.session_id
             AND p.source_user_seq = NEW.source_user_seq
             AND p.accepted_task_id = NEW.accepted_task_id
             AND l.accepted_task_id = NEW.accepted_task_id
             AND l.tool_name = NEW.tool_name
             AND l.argument_digest = NEW.argument_digest
             AND l.state = 'open'
             AND (
               (NEW.stage_kind = 'business_execute'
                 AND NEW.logical_tool_call_id = p.parent_logical_tool_call_id)
               OR
               (NEW.stage_kind != 'business_execute'
                 AND NEW.logical_tool_call_id != p.parent_logical_tool_call_id
                 AND NOT EXISTS (
                   SELECT 1 FROM expected_work_call_bindings b
                    WHERE b.session_id = NEW.session_id
                      AND b.source_user_seq = NEW.source_user_seq
                      AND b.logical_tool_call_id = NEW.logical_tool_call_id
                 ))
             )
             AND (NEW.stage_kind NOT IN ('download_transfer','local_commit')
               OR p.output_schema_digest IS NOT NULL)
             AND (
               (NEW.stage_kind = 'local_snapshot' AND NEW.effect_kind = 'local_write')
               OR (NEW.stage_kind IN ('source_download','download_transfer') AND NEW.effect_kind = 'read')
               OR (NEW.stage_kind IN ('upload_presign','upload_transfer') AND NEW.effect_kind = 'external_write')
               OR (NEW.stage_kind = 'local_commit' AND NEW.effect_kind = 'local_write')
               OR (NEW.stage_kind = 'business_execute' AND NEW.effect_kind = p.parent_effect_kind)
             )
             AND EXISTS (
               SELECT 1 FROM run_dispatch_leases lease
                WHERE lease.scope_id = NEW.lease_scope_id
                  AND lease.lease_id = NEW.lease_id
                  AND lease.session_id = NEW.session_id
                  AND lease.source_user_seq = NEW.source_user_seq
                  AND lease.accepted_task_id = NEW.accepted_task_id
                  AND lease.logical_tool_call_id = NEW.logical_tool_call_id
                  AND lease.revoked_at IS NULL
             )
             AND (NEW.depends_on_stage_ordinal IS NULL OR EXISTS (
               SELECT 1 FROM staged_transfer_stage_authorities prerequisite
                WHERE prerequisite.plan_id = NEW.plan_id
                  AND prerequisite.stage_ordinal = NEW.depends_on_stage_ordinal
                  AND prerequisite.stage_ordinal < NEW.stage_ordinal
             ))
        )
        BEGIN
          SELECT RAISE(ABORT, 'staged transfer stage authority is not exact');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_staged_transfer_stage_immutable
        BEFORE UPDATE ON staged_transfer_stage_authorities
        BEGIN
          SELECT RAISE(ABORT, 'staged transfer stage authority is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_staged_transfer_stage_delete_immutable
        BEFORE DELETE ON staged_transfer_stage_authorities
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'staged transfer stage authority is immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_staged_transfer_child_no_expected_work
        BEFORE INSERT ON expected_work_call_bindings
        WHEN EXISTS (
          SELECT 1 FROM staged_transfer_stage_authorities s
           WHERE s.session_id = NEW.session_id
             AND s.source_user_seq = NEW.source_user_seq
             AND s.logical_tool_call_id = NEW.logical_tool_call_id
             AND s.stage_kind != 'business_execute'
        )
        BEGIN
          SELECT RAISE(ABORT, 'staged control dependencies cannot bind expected work');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_staged_transfer_child_no_progress
        BEFORE INSERT ON logical_call_settlements
        WHEN EXISTS (
          SELECT 1 FROM staged_transfer_stage_authorities s
           WHERE s.session_id = NEW.session_id
             AND s.source_user_seq = NEW.source_user_seq
             AND s.logical_tool_call_id = NEW.logical_tool_call_id
             AND s.stage_kind != 'business_execute'
        ) AND (
          NEW.business_call != 0
          OR NEW.progress_claimed != 0
          OR NEW.requirement_id IS NOT NULL
          OR NEW.continues_requirement != 0
        )
        BEGIN
          SELECT RAISE(ABORT, 'staged control dependencies cannot discharge expected work');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_staged_transfer_physical_prerequisite
        BEFORE INSERT ON physical_dispatches
        WHEN EXISTS (
          SELECT 1 FROM staged_transfer_stage_authorities s
           WHERE s.session_id = NEW.session_id
             AND s.source_user_seq = NEW.source_user_seq
             AND s.logical_tool_call_id = NEW.logical_tool_call_id
             AND (
               s.physical_dispatch_id != NEW.physical_dispatch_id
               OR s.accepted_task_id != NEW.accepted_task_id
               OR s.tool_name != NEW.tool_name
               OR s.argument_digest != NEW.argument_digest
               OR s.lease_scope_id IS NOT NEW.lease_scope_id
               OR s.lease_id IS NOT NEW.lease_id
               OR (s.depends_on_stage_ordinal IS NOT NULL AND NOT EXISTS (
                 SELECT 1
                   FROM staged_transfer_stage_authorities dependency
                   JOIN staged_transfer_stage_receipts receipt
                     ON receipt.stage_authority_id = dependency.stage_authority_id
                  WHERE dependency.plan_id = s.plan_id
                    AND dependency.stage_ordinal = s.depends_on_stage_ordinal
                    AND receipt.terminal_state = 'returned'
               ))
               OR (s.stage_kind = 'business_execute' AND EXISTS (
                 SELECT 1 FROM staged_transfer_stage_authorities upload
                  WHERE upload.plan_id = s.plan_id
                    AND upload.stage_kind = 'upload_transfer'
                    AND NOT EXISTS (
                      SELECT 1 FROM staged_transfer_stage_receipts upload_receipt
                       WHERE upload_receipt.stage_authority_id = upload.stage_authority_id
                         AND upload_receipt.terminal_state = 'returned'
                    )
               ))
             )
        )
        BEGIN
          SELECT RAISE(ABORT, 'staged transfer physical dispatch lacks exact settled prerequisites');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_physical_return_checkpoint_exact_return
        BEFORE INSERT ON physical_dispatch_return_checkpoints
        WHEN NOT EXISTS (
          SELECT 1
            FROM physical_dispatches p
            JOIN staged_transfer_stage_authorities s
              ON s.stage_authority_id = NEW.stage_authority_id
           WHERE p.session_id = NEW.session_id
             AND p.source_user_seq = NEW.source_user_seq
             AND p.accepted_task_id = NEW.accepted_task_id
             AND p.logical_tool_call_id = NEW.logical_tool_call_id
             AND p.physical_dispatch_id = NEW.physical_dispatch_id
             AND p.tool_name = NEW.tool_name
             AND p.argument_digest = NEW.argument_digest
             AND p.lease_scope_id IS NEW.lease_scope_id
             AND p.lease_id IS NEW.lease_id
             AND p.state = 'returned'
             AND s.session_id = NEW.session_id
             AND s.source_user_seq = NEW.source_user_seq
             AND s.accepted_task_id = NEW.accepted_task_id
             AND s.logical_tool_call_id = NEW.logical_tool_call_id
             AND s.physical_dispatch_id = NEW.physical_dispatch_id
             AND s.stage_kind = NEW.stage_kind
             AND s.stage_ordinal = NEW.stage_ordinal
             AND s.tool_name = NEW.tool_name
             AND s.argument_digest = NEW.argument_digest
             AND s.lease_scope_id = NEW.lease_scope_id
             AND s.lease_id = NEW.lease_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'physical return checkpoint requires its exact returned stage crossing');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_physical_return_checkpoint_immutable
        BEFORE UPDATE ON physical_dispatch_return_checkpoints
        BEGIN
          SELECT RAISE(ABORT, 'physical return checkpoints are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_physical_return_checkpoint_delete_immutable
        BEFORE DELETE ON physical_dispatch_return_checkpoints
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'physical return checkpoints are immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_staged_transfer_receipt_exact_crossing
        BEFORE INSERT ON staged_transfer_stage_receipts
        WHEN NOT EXISTS (
          SELECT 1
            FROM staged_transfer_stage_authorities s
            JOIN physical_dispatches p
              ON p.session_id = s.session_id
             AND p.source_user_seq = s.source_user_seq
             AND p.physical_dispatch_id = s.physical_dispatch_id
           WHERE s.stage_authority_id = NEW.stage_authority_id
             AND s.plan_id = NEW.plan_id
             AND s.session_id = NEW.session_id
             AND s.source_user_seq = NEW.source_user_seq
             AND s.stage_ordinal = NEW.stage_ordinal
             AND s.physical_dispatch_id = NEW.physical_dispatch_id
             AND p.accepted_task_id = s.accepted_task_id
             AND p.logical_tool_call_id = s.logical_tool_call_id
             AND p.tool_name = s.tool_name
             AND p.argument_digest = s.argument_digest
             AND p.lease_scope_id = s.lease_scope_id
             AND p.lease_id = s.lease_id
             AND p.state = NEW.terminal_state
             AND (NEW.terminal_state != 'returned' OR EXISTS (
               SELECT 1 FROM physical_dispatch_return_checkpoints c
                WHERE c.stage_authority_id = s.stage_authority_id
                  AND c.physical_dispatch_id = s.physical_dispatch_id
             ))
        )
        BEGIN
          SELECT RAISE(ABORT, 'staged transfer receipt requires its exact terminal crossing');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_staged_transfer_receipt_immutable
        BEFORE UPDATE ON staged_transfer_stage_receipts
        BEGIN
          SELECT RAISE(ABORT, 'staged transfer receipts are append-only');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_staged_transfer_receipt_delete_immutable
        BEFORE DELETE ON staged_transfer_stage_receipts
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'staged transfer receipts are append-only');
        END;
      `);
    },
  },
  {
    /**
     * Corrective staged-transfer authority. v61 was intentionally never a
     * production execution surface, but a daemon may already have stamped it.
     * Do not reinterpret those rows: retire every v61 logical owner, drop the
     * unsafe scaffolding, and rebuild an attempt-generational authority graph.
     */
    version: 62,
    sql: '',
    foreignKeysOff: true,
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'logical_tool_calls',
        'physical_dispatches',
        'logical_call_settlements',
        'expected_work_call_bindings',
        'host_call_capability_bindings',
        'capability_manifests',
        'run_dispatch_leases',
      ]) {
        if (!tables.has(prerequisite)) {
          throw new Error(`schema v62 prerequisite missing: ${prerequisite}`);
        }
      }

      const physicalColumns = new Set(
        (db.prepare('PRAGMA table_info(physical_dispatches)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!physicalColumns.has('staged_authority_digest')) {
        db.exec(`ALTER TABLE physical_dispatches ADD COLUMN staged_authority_digest TEXT
          CHECK (staged_authority_digest IS NULL OR (
            length(staged_authority_digest) = 64
            AND staged_authority_digest NOT GLOB '*[^0-9a-f]*'
          ))`);
      }

      // A v61 row was never minted from an authenticated manifest carrier.
      // Poison every open logical owner before removing those rows so neither
      // a parent nor a side-call can later be treated as ordinary authority.
      if (tables.has('staged_transfer_plans')) {
        db.exec(`
          UPDATE logical_tool_calls
             SET state = 'conflict',
                 conflict_reason = 'staged_transfer_v61_authority_retired'
           WHERE state = 'open' AND EXISTS (
             SELECT 1 FROM staged_transfer_plans p
              WHERE p.session_id = logical_tool_calls.session_id
                AND p.source_user_seq = logical_tool_calls.source_user_seq
                AND p.parent_logical_tool_call_id = logical_tool_calls.logical_tool_call_id
           );
        `);
      }
      if (tables.has('staged_transfer_stage_authorities')) {
        db.exec(`
          UPDATE logical_tool_calls
             SET state = 'conflict',
                 conflict_reason = 'staged_transfer_v61_authority_retired'
           WHERE state = 'open' AND EXISTS (
             SELECT 1 FROM staged_transfer_stage_authorities s
              WHERE s.session_id = logical_tool_calls.session_id
                AND s.source_user_seq = logical_tool_calls.source_user_seq
                AND s.logical_tool_call_id = logical_tool_calls.logical_tool_call_id
           );
          UPDATE run_dispatch_leases
             SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
           WHERE EXISTS (
             SELECT 1 FROM staged_transfer_stage_authorities s
              WHERE s.lease_scope_id = run_dispatch_leases.scope_id
                AND s.lease_id = run_dispatch_leases.lease_id
           );
        `);
      }

      for (const trigger of [
        'trg_staged_transfer_plan_exact_parent',
        'trg_staged_transfer_plan_identity_immutable',
        'trg_staged_transfer_plan_delete_immutable',
        'trg_staged_transfer_plan_state_machine',
        'trg_staged_transfer_plan_state_receipts',
        'trg_staged_transfer_stage_exact_plan',
        'trg_staged_transfer_stage_immutable',
        'trg_staged_transfer_stage_delete_immutable',
        'trg_staged_transfer_child_no_expected_work',
        'trg_staged_transfer_child_no_progress',
        'trg_staged_transfer_physical_prerequisite',
        'trg_physical_return_checkpoint_exact_return',
        'trg_physical_return_checkpoint_immutable',
        'trg_physical_return_checkpoint_delete_immutable',
        'trg_staged_transfer_receipt_exact_crossing',
        'trg_staged_transfer_receipt_immutable',
        'trg_staged_transfer_receipt_delete_immutable',
        'trg_staged_transfer_attempt_exact_stage',
        'trg_staged_transfer_attempt_immutable',
        'trg_staged_transfer_attempt_delete_immutable',
        'trg_staged_transfer_physical_exact_attempt',
        'trg_staged_transfer_receipt_exact_attempt',
        'trg_staged_transfer_one_success_per_stage',
        'trg_staged_transfer_download_topology_exact',
        'trg_staged_transfer_download_topology_immutable',
        'trg_staged_transfer_download_topology_delete_immutable',
        'trg_staged_transfer_logical_settlement_fence',
        'trg_staged_transfer_consent_exact_plan',
        'trg_staged_transfer_consent_immutable',
        'trg_staged_transfer_consent_delete_immutable',
        'trg_staged_transfer_reconciliation_exact_attempt',
        'trg_staged_transfer_reconciliation_requires_opaque_kernel',
        'trg_staged_transfer_reconciliation_immutable',
        'trg_staged_transfer_reconciliation_delete_immutable',
        'trg_staged_transfer_secret_exact_attempt',
        'trg_staged_transfer_secret_immutable',
        'trg_staged_transfer_secret_delete_immutable',
        'trg_staged_transfer_blob_exact_stage',
        'trg_staged_transfer_blob_immutable',
        'trg_staged_transfer_blob_delete_immutable',
      ]) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
      db.exec(`
        DROP TABLE IF EXISTS staged_transfer_secret_payloads;
        DROP TABLE IF EXISTS staged_transfer_blob_owners;
        DROP TABLE IF EXISTS staged_transfer_consent_redemptions;
        DROP TABLE IF EXISTS staged_transfer_attempt_reconciliations;
        DROP TABLE IF EXISTS staged_transfer_download_topology_receipts;
        DROP TABLE IF EXISTS staged_transfer_stage_receipts;
        DROP TABLE IF EXISTS physical_dispatch_return_checkpoints;
        DROP TABLE IF EXISTS staged_transfer_stage_authorities;
        DROP TABLE IF EXISTS staged_transfer_stages;
        DROP TABLE IF EXISTS staged_transfer_plans;
      `);

      db.exec(`
        CREATE TABLE staged_transfer_plans (
          plan_id TEXT PRIMARY KEY CHECK (length(plan_id) BETWEEN 1 AND 256),
          session_id TEXT NOT NULL,
          source_user_seq INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id TEXT NOT NULL,
          parent_logical_tool_call_id TEXT NOT NULL,
          parent_tool_name TEXT NOT NULL CHECK (length(parent_tool_name) BETWEEN 1 AND 512),
          parent_argument_digest TEXT NOT NULL CHECK (
            length(parent_argument_digest) = 64 AND parent_argument_digest NOT GLOB '*[^0-9a-f]*'
          ),
          parent_effect_kind TEXT NOT NULL CHECK (parent_effect_kind IN (
            'read','compute','local_write','external_write','admin'
          )),
          expected_work_contract_id TEXT NOT NULL CHECK (length(expected_work_contract_id) BETWEEN 1 AND 256),
          expected_work_requirement_id TEXT NOT NULL CHECK (length(expected_work_requirement_id) BETWEEN 1 AND 256),
          expected_work_binding_digest TEXT NOT NULL CHECK (
            length(expected_work_binding_digest) = 64 AND expected_work_binding_digest NOT GLOB '*[^0-9a-f]*'
          ),
          host_durable_binding_digest TEXT NOT NULL CHECK (
            length(host_durable_binding_digest) = 64 AND host_durable_binding_digest NOT GLOB '*[^0-9a-f]*'
          ),
          host_capability_id TEXT NOT NULL CHECK (length(host_capability_id) BETWEEN 1 AND 512),
          host_account_id TEXT NOT NULL CHECK (length(host_account_id) BETWEEN 1 AND 512),
          host_invoke_port_id TEXT NOT NULL CHECK (length(host_invoke_port_id) BETWEEN 1 AND 512),
          host_operation_id TEXT NOT NULL CHECK (length(host_operation_id) BETWEEN 1 AND 512),
          host_provider_input_schema_digest TEXT NOT NULL CHECK (
            length(host_provider_input_schema_digest) = 64
            AND host_provider_input_schema_digest NOT GLOB '*[^0-9a-f]*'
          ),
          host_schema_fingerprint TEXT NOT NULL CHECK (
            length(host_schema_fingerprint) = 64 AND host_schema_fingerprint NOT GLOB '*[^0-9a-f]*'
          ),
          host_definition_fingerprint TEXT NOT NULL CHECK (
            length(host_definition_fingerprint) = 64
            AND host_definition_fingerprint NOT GLOB '*[^0-9a-f]*'
          ),
          host_manifest_id TEXT NOT NULL CHECK (length(host_manifest_id) BETWEEN 1 AND 512),
          host_manifest_digest TEXT NOT NULL CHECK (
            length(host_manifest_digest) = 64 AND host_manifest_digest NOT GLOB '*[^0-9a-f]*'
          ),
          input_schema_digest TEXT NOT NULL CHECK (
            length(input_schema_digest) = 64 AND input_schema_digest NOT GLOB '*[^0-9a-f]*'
          ),
          output_schema_digest TEXT CHECK (output_schema_digest IS NULL OR (
            length(output_schema_digest) = 64 AND output_schema_digest NOT GLOB '*[^0-9a-f]*'
          )),
          output_may_contain_downloads INTEGER NOT NULL CHECK (
            output_may_contain_downloads IN (0, 1)
          ),
          operation_version TEXT NOT NULL CHECK (length(operation_version) BETWEEN 1 AND 160),
          toolkit_slug TEXT NOT NULL CHECK (length(toolkit_slug) BETWEEN 1 AND 160),
          account_identity_digest TEXT NOT NULL CHECK (
            length(account_identity_digest) = 64 AND account_identity_digest NOT GLOB '*[^0-9a-f]*'
          ),
          transfer_manifest_digest TEXT NOT NULL CHECK (
            length(transfer_manifest_digest) = 64 AND transfer_manifest_digest NOT GLOB '*[^0-9a-f]*'
          ),
          manifest_binding_digest TEXT NOT NULL CHECK (
            length(manifest_binding_digest) = 64 AND manifest_binding_digest NOT GLOB '*[^0-9a-f]*'
          ),
          manifest_payload_id TEXT NOT NULL UNIQUE CHECK (manifest_payload_id GLOB 'authority-payload:*'),
          manifest_format TEXT NOT NULL CHECK (manifest_format = 'staged_transfer_manifest_v2'),
          manifest_plaintext_sha256 TEXT NOT NULL CHECK (
            length(manifest_plaintext_sha256) = 64 AND manifest_plaintext_sha256 NOT GLOB '*[^0-9a-f]*'
          ),
          manifest_plaintext_bytes INTEGER NOT NULL CHECK (manifest_plaintext_bytes >= 0),
          manifest_chunk_count INTEGER NOT NULL CHECK (manifest_chunk_count >= 0),
          manifest_sealed_sha256 TEXT NOT NULL CHECK (
            length(manifest_sealed_sha256) = 64 AND manifest_sealed_sha256 NOT GLOB '*[^0-9a-f]*'
          ),
          manifest_sealed_bytes INTEGER NOT NULL CHECK (manifest_sealed_bytes > 0),
          consent_requirement TEXT NOT NULL CHECK (consent_requirement IN ('none','exact_grant')),
          consent_subject_digest TEXT CHECK (consent_subject_digest IS NULL OR (
            length(consent_subject_digest) = 64 AND consent_subject_digest NOT GLOB '*[^0-9a-f]*'
          )),
          plan_authority_digest TEXT NOT NULL UNIQUE CHECK (
            length(plan_authority_digest) = 64 AND plan_authority_digest NOT GLOB '*[^0-9a-f]*'
          ),
          state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN (
            'prepared','executing','business_returned','downloads_complete',
            'reconciling','failed','settled'
          )),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (input_schema_digest = host_provider_input_schema_digest),
          CHECK (host_schema_fingerprint = host_definition_fingerprint),
          CHECK (output_may_contain_downloads = 0 OR output_schema_digest IS NOT NULL),
          CHECK (
            (consent_requirement = 'none' AND consent_subject_digest IS NULL)
            OR (consent_requirement = 'exact_grant' AND consent_subject_digest IS NOT NULL)
          ),
          FOREIGN KEY (session_id, source_user_seq, parent_logical_tool_call_id)
            REFERENCES logical_tool_calls(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX uq_staged_transfer_parent_call
          ON staged_transfer_plans(session_id, source_user_seq, parent_logical_tool_call_id);

        CREATE TABLE staged_transfer_stages (
          stage_id TEXT PRIMARY KEY CHECK (length(stage_id) BETWEEN 1 AND 256),
          plan_id TEXT NOT NULL REFERENCES staged_transfer_plans(plan_id) ON DELETE CASCADE,
          session_id TEXT NOT NULL,
          source_user_seq INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id TEXT NOT NULL,
          stage_ordinal INTEGER NOT NULL CHECK (stage_ordinal > 0),
          stage_kind TEXT NOT NULL CHECK (stage_kind IN (
            'local_snapshot','source_download','upload_presign','upload_transfer',
            'business_execute','download_transfer','local_commit'
          )),
          json_pointer_digest TEXT CHECK (json_pointer_digest IS NULL OR (
            length(json_pointer_digest) = 64 AND json_pointer_digest NOT GLOB '*[^0-9a-f]*'
          )),
          tool_name TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 512),
          effect_kind TEXT NOT NULL CHECK (effect_kind IN (
            'read','compute','local_write','external_write','admin'
          )),
          depends_on_stage_ordinal INTEGER CHECK (
            depends_on_stage_ordinal IS NULL OR depends_on_stage_ordinal > 0
          ),
          retry_policy TEXT NOT NULL CHECK (retry_policy IN (
            'none','safe_terminal','reconcile_before_retry'
          )),
          manifest_node_digest TEXT NOT NULL CHECK (
            length(manifest_node_digest) = 64 AND manifest_node_digest NOT GLOB '*[^0-9a-f]*'
          ),
          stage_digest TEXT NOT NULL UNIQUE CHECK (
            length(stage_digest) = 64 AND stage_digest NOT GLOB '*[^0-9a-f]*'
          ),
          created_at TEXT NOT NULL,
          UNIQUE (plan_id, stage_ordinal),
          UNIQUE (plan_id, manifest_node_digest)
        );

        CREATE TABLE staged_transfer_stage_authorities (
          stage_authority_id TEXT PRIMARY KEY CHECK (length(stage_authority_id) BETWEEN 1 AND 256),
          stage_id TEXT NOT NULL REFERENCES staged_transfer_stages(stage_id) ON DELETE CASCADE,
          plan_id TEXT NOT NULL REFERENCES staged_transfer_plans(plan_id) ON DELETE CASCADE,
          session_id TEXT NOT NULL,
          source_user_seq INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id TEXT NOT NULL,
          stage_ordinal INTEGER NOT NULL CHECK (stage_ordinal > 0),
          stage_kind TEXT NOT NULL,
          attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal > 0),
          logical_tool_call_id TEXT NOT NULL,
          physical_dispatch_id TEXT NOT NULL,
          tool_name TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 512),
          argument_digest TEXT NOT NULL CHECK (
            length(argument_digest) = 64 AND argument_digest NOT GLOB '*[^0-9a-f]*'
          ),
          provider_argument_digest TEXT NOT NULL CHECK (
            length(provider_argument_digest) = 64
            AND provider_argument_digest NOT GLOB '*[^0-9a-f]*'
          ),
          effect_kind TEXT NOT NULL,
          lease_scope_id TEXT NOT NULL CHECK (length(lease_scope_id) BETWEEN 1 AND 512),
          lease_id TEXT NOT NULL CHECK (length(lease_id) BETWEEN 1 AND 512),
          retry_of_stage_authority_id TEXT REFERENCES staged_transfer_stage_authorities(stage_authority_id),
          authority_digest TEXT NOT NULL UNIQUE CHECK (
            length(authority_digest) = 64 AND authority_digest NOT GLOB '*[^0-9a-f]*'
          ),
          created_at TEXT NOT NULL,
          UNIQUE (stage_id, attempt_ordinal),
          UNIQUE (session_id, source_user_seq, logical_tool_call_id),
          UNIQUE (session_id, source_user_seq, physical_dispatch_id),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
            REFERENCES logical_tool_calls(session_id, source_user_seq, logical_tool_call_id)
            ON DELETE CASCADE
        );

        CREATE TABLE physical_dispatch_return_checkpoints (
          checkpoint_id TEXT PRIMARY KEY CHECK (length(checkpoint_id) BETWEEN 1 AND 256),
          session_id TEXT NOT NULL,
          source_user_seq INTEGER NOT NULL CHECK (source_user_seq > 0),
          accepted_task_id TEXT NOT NULL,
          logical_tool_call_id TEXT NOT NULL,
          physical_dispatch_id TEXT NOT NULL,
          stage_authority_id TEXT NOT NULL UNIQUE
            REFERENCES staged_transfer_stage_authorities(stage_authority_id) ON DELETE CASCADE,
          stage_kind TEXT NOT NULL,
          stage_ordinal INTEGER NOT NULL CHECK (stage_ordinal > 0),
          attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal > 0),
          tool_name TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 512),
          argument_digest TEXT NOT NULL CHECK (
            length(argument_digest) = 64 AND argument_digest NOT GLOB '*[^0-9a-f]*'
          ),
          provider_argument_digest TEXT NOT NULL CHECK (
            length(provider_argument_digest) = 64
            AND provider_argument_digest NOT GLOB '*[^0-9a-f]*'
          ),
          lease_scope_id TEXT NOT NULL CHECK (length(lease_scope_id) BETWEEN 1 AND 512),
          lease_id TEXT NOT NULL CHECK (length(lease_id) BETWEEN 1 AND 512),
          payload_id TEXT NOT NULL UNIQUE CHECK (payload_id GLOB 'authority-payload:*'),
          payload_plaintext_sha256 TEXT NOT NULL CHECK (
            length(payload_plaintext_sha256) = 64 AND payload_plaintext_sha256 NOT GLOB '*[^0-9a-f]*'
          ),
          payload_plaintext_bytes INTEGER NOT NULL CHECK (payload_plaintext_bytes >= 0),
          payload_chunk_count INTEGER NOT NULL CHECK (payload_chunk_count >= 0),
          payload_sealed_sha256 TEXT NOT NULL CHECK (
            length(payload_sealed_sha256) = 64 AND payload_sealed_sha256 NOT GLOB '*[^0-9a-f]*'
          ),
          payload_sealed_bytes INTEGER NOT NULL CHECK (payload_sealed_bytes > 0),
          created_at TEXT NOT NULL,
          UNIQUE (session_id, source_user_seq, physical_dispatch_id),
          FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id, physical_dispatch_id)
            REFERENCES physical_dispatches(
              session_id, source_user_seq, logical_tool_call_id, physical_dispatch_id
            ) ON DELETE CASCADE
        );

        CREATE TABLE staged_transfer_stage_receipts (
          stage_authority_id TEXT PRIMARY KEY
            REFERENCES staged_transfer_stage_authorities(stage_authority_id) ON DELETE CASCADE,
          stage_id TEXT NOT NULL REFERENCES staged_transfer_stages(stage_id) ON DELETE CASCADE,
          plan_id TEXT NOT NULL REFERENCES staged_transfer_plans(plan_id) ON DELETE CASCADE,
          session_id TEXT NOT NULL,
          source_user_seq INTEGER NOT NULL,
          stage_ordinal INTEGER NOT NULL,
          attempt_ordinal INTEGER NOT NULL,
          physical_dispatch_id TEXT NOT NULL,
          terminal_state TEXT NOT NULL CHECK (terminal_state IN (
            'returned','threw','timed_out','cancelled','unknown'
          )),
          result_digest TEXT CHECK (result_digest IS NULL OR (
            length(result_digest) = 64 AND result_digest NOT GLOB '*[^0-9a-f]*'
          )),
          recorded_at TEXT NOT NULL,
          UNIQUE (session_id, source_user_seq, physical_dispatch_id),
          UNIQUE (stage_id, attempt_ordinal),
          CHECK (
            (terminal_state = 'returned' AND result_digest IS NOT NULL)
            OR (terminal_state != 'returned' AND result_digest IS NULL)
          )
        );

        -- A successful business return is not enough to close a staged
        -- parent whose frozen output definition exists.  This append-only
        -- receipt proves that the encrypted returned payload was projected
        -- and that its complete, deterministic download successor set
        -- (including the empty set) was committed in the same transaction.
        CREATE TABLE staged_transfer_download_topology_receipts (
          plan_id TEXT PRIMARY KEY REFERENCES staged_transfer_plans(plan_id) ON DELETE CASCADE,
          business_stage_authority_id TEXT NOT NULL UNIQUE
            REFERENCES staged_transfer_stage_authorities(stage_authority_id) ON DELETE CASCADE,
          business_result_digest TEXT NOT NULL CHECK (
            length(business_result_digest) = 64
            AND business_result_digest NOT GLOB '*[^0-9a-f]*'
          ),
          topology_digest TEXT NOT NULL CHECK (
            length(topology_digest) = 64 AND topology_digest NOT GLOB '*[^0-9a-f]*'
          ),
          successor_stage_count INTEGER NOT NULL CHECK (
            successor_stage_count >= 0 AND successor_stage_count % 2 = 0
          ),
          recorded_at TEXT NOT NULL
        );

        CREATE TABLE staged_transfer_attempt_reconciliations (
          reconciliation_id TEXT PRIMARY KEY CHECK (length(reconciliation_id) BETWEEN 1 AND 256),
          prior_stage_authority_id TEXT NOT NULL UNIQUE
            REFERENCES staged_transfer_stage_authorities(stage_authority_id) ON DELETE CASCADE,
          plan_id TEXT NOT NULL REFERENCES staged_transfer_plans(plan_id) ON DELETE CASCADE,
          disposition TEXT NOT NULL CHECK (disposition IN ('not_applied','applied','unknown')),
          evidence_digest TEXT NOT NULL CHECK (
            length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'
          ),
          recorded_at TEXT NOT NULL
        );

        CREATE TABLE staged_transfer_consent_redemptions (
          plan_id TEXT PRIMARY KEY REFERENCES staged_transfer_plans(plan_id) ON DELETE CASCADE,
          approval_id TEXT NOT NULL UNIQUE,
          consent_subject_digest TEXT NOT NULL CHECK (
            length(consent_subject_digest) = 64 AND consent_subject_digest NOT GLOB '*[^0-9a-f]*'
          ),
          grant_digest TEXT NOT NULL CHECK (
            length(grant_digest) = 64 AND grant_digest NOT GLOB '*[^0-9a-f]*'
          ),
          redeemed_at TEXT NOT NULL
        );

        CREATE TABLE staged_transfer_secret_payloads (
          payload_id TEXT PRIMARY KEY CHECK (payload_id GLOB 'authority-payload:*'),
          stage_authority_id TEXT NOT NULL UNIQUE
            REFERENCES staged_transfer_stage_authorities(stage_authority_id) ON DELETE CASCADE,
          payload_kind TEXT NOT NULL CHECK (payload_kind = 'staged_signed_url'),
          binding_digest TEXT NOT NULL CHECK (
            length(binding_digest) = 64 AND binding_digest NOT GLOB '*[^0-9a-f]*'
          ),
          plaintext_sha256 TEXT NOT NULL CHECK (
            length(plaintext_sha256) = 64 AND plaintext_sha256 NOT GLOB '*[^0-9a-f]*'
          ),
          plaintext_bytes INTEGER NOT NULL CHECK (plaintext_bytes >= 0),
          chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
          sealed_sha256 TEXT NOT NULL CHECK (
            length(sealed_sha256) = 64 AND sealed_sha256 NOT GLOB '*[^0-9a-f]*'
          ),
          sealed_bytes INTEGER NOT NULL CHECK (sealed_bytes > 0),
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE staged_transfer_blob_owners (
          plan_id TEXT NOT NULL REFERENCES staged_transfer_plans(plan_id) ON DELETE CASCADE,
          stage_id TEXT NOT NULL REFERENCES staged_transfer_stages(stage_id) ON DELETE CASCADE,
          blob_sha256 TEXT NOT NULL CHECK (
            length(blob_sha256) = 64 AND blob_sha256 NOT GLOB '*[^0-9a-f]*'
          ),
          blob_md5 TEXT NOT NULL CHECK (
            length(blob_md5) = 32 AND blob_md5 NOT GLOB '*[^0-9a-f]*'
          ),
          blob_bytes INTEGER NOT NULL CHECK (blob_bytes >= 0),
          created_at TEXT NOT NULL,
          PRIMARY KEY (plan_id, stage_id, blob_sha256)
        );

        CREATE INDEX idx_staged_transfer_plan_state
          ON staged_transfer_plans(session_id, source_user_seq, state, updated_at);
        CREATE INDEX idx_staged_transfer_stage_plan
          ON staged_transfer_stages(plan_id, stage_ordinal);
        CREATE INDEX idx_staged_transfer_attempt_stage
          ON staged_transfer_stage_authorities(stage_id, attempt_ordinal);
      `);

      db.exec(`
        CREATE TRIGGER trg_staged_transfer_plan_exact_parent
        BEFORE INSERT ON staged_transfer_plans
        WHEN NOT EXISTS (
          SELECT 1
            FROM logical_tool_calls l
            JOIN expected_work_call_bindings b
              ON b.session_id = l.session_id
             AND b.source_user_seq = l.source_user_seq
             AND b.logical_tool_call_id = l.logical_tool_call_id
            JOIN host_call_capability_bindings host
              ON host.session_id = l.session_id
             AND host.source_user_seq = l.source_user_seq
             AND host.logical_tool_call_id = l.logical_tool_call_id
            JOIN capability_manifests manifest
              ON manifest.manifest_id = host.manifest_id
             AND manifest.digest = host.manifest_digest
           WHERE l.session_id = NEW.session_id
             AND l.source_user_seq = NEW.source_user_seq
             AND l.accepted_task_id = NEW.accepted_task_id
             AND l.logical_tool_call_id = NEW.parent_logical_tool_call_id
             AND l.tool_name = NEW.parent_tool_name
             AND l.argument_digest = NEW.parent_argument_digest
             AND l.state = 'open'
             AND b.accepted_task_id = NEW.accepted_task_id
             AND b.contract_id = NEW.expected_work_contract_id
             AND b.requirement_id = NEW.expected_work_requirement_id
             AND b.tool_name = NEW.parent_tool_name
             AND b.argument_digest = NEW.parent_argument_digest
             AND b.effect_kind = NEW.parent_effect_kind
             AND host.accepted_task_id = NEW.accepted_task_id
             AND host.tool_name = NEW.parent_tool_name
             AND host.attested_argument_digest = NEW.parent_argument_digest
             AND host.effect = NEW.parent_effect_kind
             AND host.binding_kind = 'catalog_manifest'
             AND host.capability_id = NEW.host_capability_id
             AND host.account_id = NEW.host_account_id
             AND host.invoke_port_id = NEW.host_invoke_port_id
             AND host.operation_id = NEW.host_operation_id
             AND host.provider_input_schema_digest = NEW.host_provider_input_schema_digest
             AND host.schema_fingerprint = NEW.host_schema_fingerprint
             AND host.manifest_id = NEW.host_manifest_id
             AND host.manifest_digest = NEW.host_manifest_digest
             AND host.durable_binding_digest = NEW.host_durable_binding_digest
             AND manifest.lifecycle = 'current'
             AND json_valid(manifest.manifest_json)
             AND json_extract(manifest.manifest_json, '$.providerKind') = 'composio'
             AND json_extract(manifest.manifest_json, '$.operationId') = NEW.host_operation_id
             AND json_extract(manifest.manifest_json, '$.operationVersion') = NEW.operation_version
             AND json_extract(manifest.manifest_json, '$.definitionFingerprint')
                 = NEW.host_definition_fingerprint
             AND json_extract(manifest.manifest_json, '$.externalDefinition.providerInputSchemaDigest')
                 = NEW.host_provider_input_schema_digest
             AND json_extract(manifest.manifest_json,
                   '$.externalDefinition.providerOutputSchemaObserved') = 1
             AND (
               (NEW.output_schema_digest IS NULL
                 AND json_type(manifest.manifest_json,
                   '$.externalDefinition.providerOutputSchemaDigest') IS NULL)
               OR json_extract(manifest.manifest_json,
                    '$.externalDefinition.providerOutputSchemaDigest') = NEW.output_schema_digest
             )
             AND json_extract(manifest.manifest_json, '$.accountId') = NEW.host_account_id
             AND json_extract(manifest.manifest_json, '$.invokePortId') = NEW.host_invoke_port_id
             AND json_extract(manifest.manifest_json, '$.lifecycle.state') = 'current'
        )
        BEGIN SELECT RAISE(ABORT, 'staged transfer requires its exact open parent call'); END;

        CREATE TRIGGER trg_staged_transfer_plan_immutable
        BEFORE UPDATE ON staged_transfer_plans
        WHEN OLD.plan_id IS NOT NEW.plan_id
          OR OLD.session_id IS NOT NEW.session_id
          OR OLD.source_user_seq IS NOT NEW.source_user_seq
          OR OLD.accepted_task_id IS NOT NEW.accepted_task_id
          OR OLD.parent_logical_tool_call_id IS NOT NEW.parent_logical_tool_call_id
          OR OLD.parent_tool_name IS NOT NEW.parent_tool_name
          OR OLD.parent_argument_digest IS NOT NEW.parent_argument_digest
          OR OLD.parent_effect_kind IS NOT NEW.parent_effect_kind
          OR OLD.expected_work_contract_id IS NOT NEW.expected_work_contract_id
          OR OLD.expected_work_requirement_id IS NOT NEW.expected_work_requirement_id
          OR OLD.expected_work_binding_digest IS NOT NEW.expected_work_binding_digest
          OR OLD.host_durable_binding_digest IS NOT NEW.host_durable_binding_digest
          OR OLD.host_capability_id IS NOT NEW.host_capability_id
          OR OLD.host_account_id IS NOT NEW.host_account_id
          OR OLD.host_invoke_port_id IS NOT NEW.host_invoke_port_id
          OR OLD.host_operation_id IS NOT NEW.host_operation_id
          OR OLD.host_provider_input_schema_digest IS NOT NEW.host_provider_input_schema_digest
          OR OLD.host_schema_fingerprint IS NOT NEW.host_schema_fingerprint
          OR OLD.host_definition_fingerprint IS NOT NEW.host_definition_fingerprint
          OR OLD.host_manifest_id IS NOT NEW.host_manifest_id
          OR OLD.host_manifest_digest IS NOT NEW.host_manifest_digest
          OR OLD.input_schema_digest IS NOT NEW.input_schema_digest
          OR OLD.output_schema_digest IS NOT NEW.output_schema_digest
          OR OLD.output_may_contain_downloads IS NOT NEW.output_may_contain_downloads
          OR OLD.operation_version IS NOT NEW.operation_version
          OR OLD.toolkit_slug IS NOT NEW.toolkit_slug
          OR OLD.account_identity_digest IS NOT NEW.account_identity_digest
          OR OLD.transfer_manifest_digest IS NOT NEW.transfer_manifest_digest
          OR OLD.manifest_binding_digest IS NOT NEW.manifest_binding_digest
          OR OLD.manifest_payload_id IS NOT NEW.manifest_payload_id
          OR OLD.manifest_format IS NOT NEW.manifest_format
          OR OLD.manifest_plaintext_sha256 IS NOT NEW.manifest_plaintext_sha256
          OR OLD.manifest_plaintext_bytes IS NOT NEW.manifest_plaintext_bytes
          OR OLD.manifest_chunk_count IS NOT NEW.manifest_chunk_count
          OR OLD.manifest_sealed_sha256 IS NOT NEW.manifest_sealed_sha256
          OR OLD.manifest_sealed_bytes IS NOT NEW.manifest_sealed_bytes
          OR OLD.consent_requirement IS NOT NEW.consent_requirement
          OR OLD.consent_subject_digest IS NOT NEW.consent_subject_digest
          OR OLD.plan_authority_digest IS NOT NEW.plan_authority_digest
          OR OLD.created_at IS NOT NEW.created_at
        BEGIN SELECT RAISE(ABORT, 'staged transfer plan authority is immutable'); END;

        CREATE TRIGGER trg_staged_transfer_consent_exact_plan
        BEFORE INSERT ON staged_transfer_consent_redemptions
        WHEN NOT EXISTS (
          SELECT 1
            FROM staged_transfer_plans plan
            JOIN pending_approvals approval ON approval.approval_id = NEW.approval_id
           WHERE plan.plan_id = NEW.plan_id
             AND plan.consent_requirement = 'exact_grant'
             AND plan.consent_subject_digest = NEW.consent_subject_digest
             AND approval.session_id = plan.session_id
             AND approval.resume_key = 'host-consent:v1:' || NEW.consent_subject_digest
             AND approval.status = 'resolved'
             AND approval.resolution = 'approved'
             AND approval.resolved_at IS NOT NULL
             AND approval.resolved_at <= approval.expires_at
             AND approval.consumed_at IS NOT NULL
             AND approval.consumed_at <= approval.expires_at
        )
        BEGIN SELECT RAISE(ABORT, 'staged transfer consent grant is not exact and redeemed'); END;
        CREATE TRIGGER trg_staged_transfer_consent_immutable
        BEFORE UPDATE ON staged_transfer_consent_redemptions
        BEGIN SELECT RAISE(ABORT, 'staged transfer consent redemption is immutable'); END;
        CREATE TRIGGER trg_staged_transfer_consent_delete_immutable
        BEFORE DELETE ON staged_transfer_consent_redemptions
        WHEN EXISTS (SELECT 1 FROM staged_transfer_plans WHERE plan_id = OLD.plan_id)
        BEGIN SELECT RAISE(ABORT, 'staged transfer consent redemption is immutable'); END;

        CREATE TRIGGER trg_staged_transfer_reconciliation_exact_attempt
        BEFORE INSERT ON staged_transfer_attempt_reconciliations
        WHEN NOT EXISTS (
          SELECT 1
            FROM staged_transfer_stage_authorities attempt
            JOIN staged_transfer_stages stage ON stage.stage_id = attempt.stage_id
            JOIN staged_transfer_stage_receipts receipt
              ON receipt.stage_authority_id = attempt.stage_authority_id
           WHERE attempt.stage_authority_id = NEW.prior_stage_authority_id
             AND attempt.plan_id = NEW.plan_id
             AND stage.retry_policy = 'reconcile_before_retry'
             AND receipt.terminal_state != 'returned'
        )
        BEGIN SELECT RAISE(ABORT, 'staged reconciliation lacks its exact terminal attempt'); END;
        -- v62 does not yet ship a provider-owned reconciliation carrier. A
        -- copyable disposition/digest must never authorize a second external
        -- body; keep the table forensic-only until that exact kernel lands.
        CREATE TRIGGER trg_staged_transfer_reconciliation_requires_opaque_kernel
        BEFORE INSERT ON staged_transfer_attempt_reconciliations
        BEGIN SELECT RAISE(ABORT, 'staged reconciliation requires its opaque provider kernel'); END;
        CREATE TRIGGER trg_staged_transfer_reconciliation_immutable
        BEFORE UPDATE ON staged_transfer_attempt_reconciliations
        BEGIN SELECT RAISE(ABORT, 'staged reconciliation evidence is immutable'); END;
        CREATE TRIGGER trg_staged_transfer_reconciliation_delete_immutable
        BEFORE DELETE ON staged_transfer_attempt_reconciliations
        WHEN EXISTS (SELECT 1 FROM staged_transfer_plans WHERE plan_id = OLD.plan_id)
        BEGIN SELECT RAISE(ABORT, 'staged reconciliation evidence is immutable'); END;

        CREATE TRIGGER trg_staged_transfer_plan_delete_immutable
        BEFORE DELETE ON staged_transfer_plans
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'staged transfer plan authority is immutable'); END;

        -- State is a cache of the immutable receipt graph, never an authority
        -- source.  A writer may advance it only to the state derived from the
        -- exact receipts that are already durable in this transaction.
        CREATE TRIGGER trg_staged_transfer_plan_state_receipts
        BEFORE UPDATE OF state ON staged_transfer_plans
        WHEN NEW.state IS NOT (
          CASE
            WHEN EXISTS (
              SELECT 1 FROM logical_call_settlements settlement
               WHERE settlement.session_id = OLD.session_id
                 AND settlement.source_user_seq = OLD.source_user_seq
                 AND settlement.logical_tool_call_id = OLD.parent_logical_tool_call_id
            ) THEN 'settled'
            WHEN EXISTS (
              SELECT 1
                FROM staged_transfer_stages stage
                JOIN staged_transfer_stage_authorities attempt ON attempt.stage_id = stage.stage_id
                JOIN staged_transfer_stage_receipts receipt ON receipt.stage_authority_id = attempt.stage_authority_id
               WHERE stage.plan_id = OLD.plan_id
                 AND receipt.terminal_state IN ('unknown','timed_out')
                 AND NOT EXISTS (
                   SELECT 1
                     FROM staged_transfer_stage_authorities recovered_attempt
                     JOIN staged_transfer_stage_receipts recovered_receipt
                       ON recovered_receipt.stage_authority_id = recovered_attempt.stage_authority_id
                    WHERE recovered_attempt.stage_id = stage.stage_id
                      AND recovered_receipt.terminal_state = 'returned'
                 )
            ) THEN 'reconciling'
            WHEN EXISTS (
              SELECT 1
                FROM staged_transfer_stages stage
                JOIN staged_transfer_stage_authorities attempt ON attempt.stage_id = stage.stage_id
                JOIN staged_transfer_stage_receipts receipt ON receipt.stage_authority_id = attempt.stage_authority_id
               WHERE stage.plan_id = OLD.plan_id
                 AND receipt.terminal_state IN ('threw','cancelled')
                 AND NOT EXISTS (
                   SELECT 1
                     FROM staged_transfer_stage_authorities recovered_attempt
                     JOIN staged_transfer_stage_receipts recovered_receipt
                       ON recovered_receipt.stage_authority_id = recovered_attempt.stage_authority_id
                    WHERE recovered_attempt.stage_id = stage.stage_id
                      AND recovered_receipt.terminal_state = 'returned'
                 )
            ) THEN 'failed'
            WHEN EXISTS (
              SELECT 1
                FROM staged_transfer_stages business
                JOIN staged_transfer_stage_authorities attempt ON attempt.stage_id = business.stage_id
                JOIN staged_transfer_stage_receipts receipt ON receipt.stage_authority_id = attempt.stage_authority_id
               WHERE business.plan_id = OLD.plan_id
                 AND business.stage_kind = 'business_execute'
                 AND receipt.terminal_state = 'returned'
            ) AND NOT EXISTS (
              SELECT 1 FROM staged_transfer_stages required_stage
               WHERE required_stage.plan_id = OLD.plan_id
                 AND NOT EXISTS (
                   SELECT 1
                     FROM staged_transfer_stage_authorities required_attempt
                     JOIN staged_transfer_stage_receipts required_receipt
                       ON required_receipt.stage_authority_id = required_attempt.stage_authority_id
                    WHERE required_attempt.stage_id = required_stage.stage_id
                      AND required_receipt.terminal_state = 'returned'
                 )
            ) AND (
              OLD.output_may_contain_downloads = 0
              OR EXISTS (
                SELECT 1 FROM staged_transfer_download_topology_receipts topology
                 WHERE topology.plan_id = OLD.plan_id
              )
            ) THEN 'downloads_complete'
            WHEN EXISTS (
              SELECT 1
                FROM staged_transfer_stages business
                JOIN staged_transfer_stage_authorities attempt ON attempt.stage_id = business.stage_id
                JOIN staged_transfer_stage_receipts receipt ON receipt.stage_authority_id = attempt.stage_authority_id
               WHERE business.plan_id = OLD.plan_id
                 AND business.stage_kind = 'business_execute'
                 AND receipt.terminal_state = 'returned'
            ) THEN 'business_returned'
            WHEN EXISTS (
              SELECT 1 FROM staged_transfer_stage_authorities attempt
               WHERE attempt.plan_id = OLD.plan_id
            ) THEN 'executing'
            ELSE 'prepared'
          END
        )
        BEGIN SELECT RAISE(ABORT, 'staged transfer plan state lacks exact receipts'); END;

        CREATE TRIGGER trg_staged_transfer_stage_exact_plan
        BEFORE INSERT ON staged_transfer_stages
        WHEN NOT EXISTS (
          SELECT 1 FROM staged_transfer_plans p
           WHERE p.plan_id = NEW.plan_id
             AND p.session_id = NEW.session_id
             AND p.source_user_seq = NEW.source_user_seq
             AND p.accepted_task_id = NEW.accepted_task_id
             AND (NEW.depends_on_stage_ordinal IS NULL OR EXISTS (
               SELECT 1 FROM staged_transfer_stages prior
                WHERE prior.plan_id = NEW.plan_id
                  AND prior.stage_ordinal = NEW.depends_on_stage_ordinal
                  AND prior.stage_ordinal < NEW.stage_ordinal
             ))
             AND (NEW.stage_kind NOT IN ('download_transfer','local_commit')
               OR p.output_may_contain_downloads = 1)
             AND (NEW.stage_kind NOT IN ('download_transfer','local_commit') OR (
               NOT EXISTS (
                 SELECT 1 FROM staged_transfer_download_topology_receipts topology
                  WHERE topology.plan_id = NEW.plan_id
               )
               AND EXISTS (
                 SELECT 1
                   FROM staged_transfer_stages business
                   JOIN staged_transfer_stage_authorities business_attempt
                     ON business_attempt.stage_id = business.stage_id
                   JOIN staged_transfer_stage_receipts business_receipt
                     ON business_receipt.stage_authority_id = business_attempt.stage_authority_id
                  WHERE business.plan_id = NEW.plan_id
                    AND business.stage_kind = 'business_execute'
                    AND business_receipt.terminal_state = 'returned'
               )
             ))
             AND (
               (NEW.stage_kind = 'local_snapshot' AND NEW.effect_kind = 'local_write')
               OR (NEW.stage_kind IN ('source_download','download_transfer') AND NEW.effect_kind = 'read')
               OR (NEW.stage_kind IN ('upload_presign','upload_transfer') AND NEW.effect_kind = 'external_write')
               OR (NEW.stage_kind = 'local_commit' AND NEW.effect_kind = 'local_write')
               OR (NEW.stage_kind = 'business_execute' AND NEW.effect_kind = p.parent_effect_kind
                 AND NEW.retry_policy = 'none')
             )
        )
        BEGIN SELECT RAISE(ABORT, 'staged transfer stage is not in its exact plan'); END;

        CREATE TRIGGER trg_staged_transfer_stage_immutable
        BEFORE UPDATE ON staged_transfer_stages
        BEGIN SELECT RAISE(ABORT, 'staged transfer stages are immutable'); END;
        CREATE TRIGGER trg_staged_transfer_stage_delete_immutable
        BEFORE DELETE ON staged_transfer_stages
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'staged transfer stages are immutable'); END;

        CREATE TRIGGER trg_staged_transfer_attempt_exact_stage
        BEFORE INSERT ON staged_transfer_stage_authorities
        WHEN NOT EXISTS (
          SELECT 1
            FROM staged_transfer_stages stage
            JOIN staged_transfer_plans plan ON plan.plan_id = stage.plan_id
            JOIN logical_tool_calls logical
              ON logical.session_id = NEW.session_id
             AND logical.source_user_seq = NEW.source_user_seq
             AND logical.logical_tool_call_id = NEW.logical_tool_call_id
            JOIN run_dispatch_leases lease
              ON lease.scope_id = NEW.lease_scope_id AND lease.lease_id = NEW.lease_id
           WHERE stage.stage_id = NEW.stage_id
             AND stage.plan_id = NEW.plan_id
             AND stage.session_id = NEW.session_id
             AND stage.source_user_seq = NEW.source_user_seq
             AND stage.accepted_task_id = NEW.accepted_task_id
             AND stage.stage_ordinal = NEW.stage_ordinal
             AND stage.stage_kind = NEW.stage_kind
             AND stage.tool_name = NEW.tool_name
             AND stage.effect_kind = NEW.effect_kind
             AND (
               plan.consent_requirement = 'none'
               OR EXISTS (
                 SELECT 1 FROM staged_transfer_consent_redemptions consent
                  WHERE consent.plan_id = plan.plan_id
                    AND consent.consent_subject_digest = plan.consent_subject_digest
               )
             )
             AND logical.accepted_task_id = NEW.accepted_task_id
             AND logical.tool_name = NEW.tool_name
             AND logical.argument_digest = NEW.argument_digest
             AND logical.state = 'open'
             AND lease.session_id = NEW.session_id
             AND lease.source_user_seq = NEW.source_user_seq
             AND lease.accepted_task_id = NEW.accepted_task_id
             AND lease.logical_tool_call_id = NEW.logical_tool_call_id
             AND lease.revoked_at IS NULL
             AND (
               (NEW.stage_kind = 'business_execute'
                 AND NEW.attempt_ordinal = 1
                 AND NEW.retry_of_stage_authority_id IS NULL
                 AND NEW.logical_tool_call_id = plan.parent_logical_tool_call_id)
               OR
               (NEW.stage_kind != 'business_execute'
                 AND NEW.logical_tool_call_id != plan.parent_logical_tool_call_id
                 AND NOT EXISTS (
                   SELECT 1 FROM expected_work_call_bindings b
                    WHERE b.session_id = NEW.session_id
                      AND b.source_user_seq = NEW.source_user_seq
                      AND b.logical_tool_call_id = NEW.logical_tool_call_id
                 )
                 AND (
                   (NEW.attempt_ordinal = 1 AND NEW.retry_of_stage_authority_id IS NULL)
                   OR
                   (NEW.attempt_ordinal > 1 AND EXISTS (
                     SELECT 1
                       FROM staged_transfer_stage_authorities prior
                       JOIN staged_transfer_stage_receipts receipt
                         ON receipt.stage_authority_id = prior.stage_authority_id
                      WHERE prior.stage_id = NEW.stage_id
                        AND prior.attempt_ordinal = NEW.attempt_ordinal - 1
                        AND prior.stage_authority_id = NEW.retry_of_stage_authority_id
                        AND receipt.terminal_state != 'returned'
                        AND stage.retry_policy != 'none'
                        AND (
                          stage.effect_kind NOT IN ('external_write','admin')
                          OR EXISTS (
                            SELECT 1 FROM staged_transfer_attempt_reconciliations reconcile
                             WHERE reconcile.prior_stage_authority_id = prior.stage_authority_id
                               AND reconcile.disposition = 'not_applied'
                          )
                        )
                   ))
                 ))
             )
        )
        BEGIN SELECT RAISE(ABORT, 'staged transfer attempt authority is not exact'); END;

        CREATE TRIGGER trg_staged_transfer_attempt_immutable
        BEFORE UPDATE ON staged_transfer_stage_authorities
        BEGIN SELECT RAISE(ABORT, 'staged transfer attempt authority is immutable'); END;
        CREATE TRIGGER trg_staged_transfer_attempt_delete_immutable
        BEFORE DELETE ON staged_transfer_stage_authorities
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'staged transfer attempt authority is immutable'); END;

        CREATE TRIGGER trg_staged_transfer_child_no_expected_work
        BEFORE INSERT ON expected_work_call_bindings
        WHEN EXISTS (
          SELECT 1 FROM staged_transfer_stage_authorities attempt
           WHERE attempt.session_id = NEW.session_id
             AND attempt.source_user_seq = NEW.source_user_seq
             AND attempt.logical_tool_call_id = NEW.logical_tool_call_id
             AND attempt.stage_kind != 'business_execute'
        )
        BEGIN SELECT RAISE(ABORT, 'staged control dependencies cannot bind expected work'); END;

        CREATE TRIGGER trg_staged_transfer_physical_exact_attempt
        BEFORE INSERT ON physical_dispatches
        WHEN (
          EXISTS (
            SELECT 1 FROM staged_transfer_stage_authorities attempt
             WHERE attempt.session_id = NEW.session_id
               AND attempt.source_user_seq = NEW.source_user_seq
               AND (attempt.logical_tool_call_id = NEW.logical_tool_call_id
                 OR attempt.physical_dispatch_id = NEW.physical_dispatch_id)
               AND (
                 attempt.accepted_task_id != NEW.accepted_task_id
                 OR attempt.logical_tool_call_id != NEW.logical_tool_call_id
                 OR attempt.physical_dispatch_id != NEW.physical_dispatch_id
                 OR attempt.tool_name != NEW.tool_name
                 OR attempt.argument_digest != NEW.argument_digest
                 OR attempt.provider_argument_digest != NEW.provider_argument_digest
                 OR attempt.lease_scope_id IS NOT NEW.lease_scope_id
                 OR attempt.lease_id IS NOT NEW.lease_id
                 OR attempt.authority_digest IS NOT NEW.staged_authority_digest
                 OR EXISTS (
                   SELECT 1 FROM staged_transfer_stages stage
                    WHERE stage.stage_id = attempt.stage_id
                      AND stage.depends_on_stage_ordinal IS NOT NULL
                      AND NOT EXISTS (
                        SELECT 1
                          FROM staged_transfer_stages dependency
                          JOIN staged_transfer_stage_authorities dependency_attempt
                            ON dependency_attempt.stage_id = dependency.stage_id
                          JOIN staged_transfer_stage_receipts dependency_receipt
                            ON dependency_receipt.stage_authority_id = dependency_attempt.stage_authority_id
                         WHERE dependency.plan_id = stage.plan_id
                           AND dependency.stage_ordinal = stage.depends_on_stage_ordinal
                           AND dependency_receipt.terminal_state = 'returned'
                      )
                 )
                 OR (attempt.stage_kind = 'business_execute' AND EXISTS (
                   SELECT 1 FROM staged_transfer_stages upload
                    WHERE upload.plan_id = attempt.plan_id
                      AND upload.stage_kind = 'upload_transfer'
                      AND NOT EXISTS (
                        SELECT 1
                          FROM staged_transfer_stage_authorities upload_attempt
                          JOIN staged_transfer_stage_receipts upload_receipt
                            ON upload_receipt.stage_authority_id = upload_attempt.stage_authority_id
                         WHERE upload_attempt.stage_id = upload.stage_id
                           AND upload_receipt.terminal_state = 'returned'
                      )
                 ))
               )
          )
          OR (NEW.staged_authority_digest IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM staged_transfer_stage_authorities exact_attempt
             WHERE exact_attempt.session_id = NEW.session_id
               AND exact_attempt.source_user_seq = NEW.source_user_seq
               AND exact_attempt.physical_dispatch_id = NEW.physical_dispatch_id
               AND exact_attempt.logical_tool_call_id = NEW.logical_tool_call_id
               AND exact_attempt.authority_digest = NEW.staged_authority_digest
          ))
        )
        BEGIN SELECT RAISE(ABORT, 'staged physical dispatch lacks exact opaque attempt authority'); END;

        CREATE TRIGGER trg_physical_return_checkpoint_exact_return
        BEFORE INSERT ON physical_dispatch_return_checkpoints
        WHEN NOT EXISTS (
          SELECT 1
            FROM staged_transfer_stage_authorities attempt
            JOIN physical_dispatches physical
              ON physical.session_id = attempt.session_id
             AND physical.source_user_seq = attempt.source_user_seq
             AND physical.physical_dispatch_id = attempt.physical_dispatch_id
           WHERE attempt.stage_authority_id = NEW.stage_authority_id
             AND attempt.session_id = NEW.session_id
             AND attempt.source_user_seq = NEW.source_user_seq
             AND attempt.accepted_task_id = NEW.accepted_task_id
             AND attempt.logical_tool_call_id = NEW.logical_tool_call_id
             AND attempt.physical_dispatch_id = NEW.physical_dispatch_id
             AND attempt.stage_kind = NEW.stage_kind
             AND attempt.stage_ordinal = NEW.stage_ordinal
             AND attempt.attempt_ordinal = NEW.attempt_ordinal
             AND attempt.tool_name = NEW.tool_name
             AND attempt.argument_digest = NEW.argument_digest
             AND attempt.provider_argument_digest = NEW.provider_argument_digest
             AND attempt.lease_scope_id = NEW.lease_scope_id
             AND attempt.lease_id = NEW.lease_id
             AND physical.state = 'returned'
             AND physical.staged_authority_digest = attempt.authority_digest
        )
        BEGIN SELECT RAISE(ABORT, 'physical return checkpoint requires exact returned attempt'); END;

        CREATE TRIGGER trg_physical_return_checkpoint_immutable
        BEFORE UPDATE ON physical_dispatch_return_checkpoints
        BEGIN SELECT RAISE(ABORT, 'physical return checkpoints are immutable'); END;
        CREATE TRIGGER trg_physical_return_checkpoint_delete_immutable
        BEFORE DELETE ON physical_dispatch_return_checkpoints
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'physical return checkpoints are immutable'); END;

        CREATE TRIGGER trg_staged_transfer_receipt_exact_attempt
        BEFORE INSERT ON staged_transfer_stage_receipts
        WHEN NOT EXISTS (
          SELECT 1
            FROM staged_transfer_stage_authorities attempt
            JOIN physical_dispatches physical
              ON physical.session_id = attempt.session_id
             AND physical.source_user_seq = attempt.source_user_seq
             AND physical.physical_dispatch_id = attempt.physical_dispatch_id
           WHERE attempt.stage_authority_id = NEW.stage_authority_id
             AND attempt.stage_id = NEW.stage_id
             AND attempt.plan_id = NEW.plan_id
             AND attempt.session_id = NEW.session_id
             AND attempt.source_user_seq = NEW.source_user_seq
             AND attempt.stage_ordinal = NEW.stage_ordinal
             AND attempt.attempt_ordinal = NEW.attempt_ordinal
             AND attempt.physical_dispatch_id = NEW.physical_dispatch_id
             AND physical.staged_authority_digest = attempt.authority_digest
             AND physical.state = NEW.terminal_state
             AND (NEW.terminal_state != 'returned' OR EXISTS (
               SELECT 1 FROM physical_dispatch_return_checkpoints checkpoint
                WHERE checkpoint.stage_authority_id = NEW.stage_authority_id
                  AND checkpoint.physical_dispatch_id = NEW.physical_dispatch_id
                  AND checkpoint.payload_plaintext_sha256 = NEW.result_digest
             ))
        )
        BEGIN SELECT RAISE(ABORT, 'staged transfer receipt requires exact terminal attempt'); END;

        CREATE TRIGGER trg_staged_transfer_one_success_per_stage
        BEFORE INSERT ON staged_transfer_stage_receipts
        WHEN NEW.terminal_state = 'returned' AND EXISTS (
          SELECT 1
            FROM staged_transfer_stage_receipts prior_receipt
            JOIN staged_transfer_stage_authorities prior_attempt
              ON prior_attempt.stage_authority_id = prior_receipt.stage_authority_id
           WHERE prior_attempt.stage_id = NEW.stage_id
             AND prior_receipt.terminal_state = 'returned'
        )
        BEGIN SELECT RAISE(ABORT, 'staged transfer stage already has a returned attempt'); END;

        CREATE TRIGGER trg_staged_transfer_receipt_immutable
        BEFORE UPDATE ON staged_transfer_stage_receipts
        BEGIN SELECT RAISE(ABORT, 'staged transfer receipts are append-only'); END;
        CREATE TRIGGER trg_staged_transfer_receipt_delete_immutable
        BEFORE DELETE ON staged_transfer_stage_receipts
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'staged transfer receipts are append-only'); END;

        CREATE TRIGGER trg_staged_transfer_download_topology_exact
        BEFORE INSERT ON staged_transfer_download_topology_receipts
        WHEN clementine_staged_topology_admitted_v1(
          NEW.plan_id,
          NEW.business_stage_authority_id,
          NEW.business_result_digest,
          NEW.topology_digest,
          NEW.successor_stage_count
        ) != 1 OR NOT EXISTS (
          SELECT 1
            FROM staged_transfer_plans plan
            JOIN staged_transfer_stages business
              ON business.plan_id = plan.plan_id
             AND business.stage_kind = 'business_execute'
            JOIN staged_transfer_stage_authorities business_attempt
              ON business_attempt.stage_id = business.stage_id
            JOIN staged_transfer_stage_receipts business_receipt
              ON business_receipt.stage_authority_id = business_attempt.stage_authority_id
            JOIN physical_dispatch_return_checkpoints checkpoint
              ON checkpoint.stage_authority_id = business_attempt.stage_authority_id
           WHERE plan.plan_id = NEW.plan_id
             AND plan.output_may_contain_downloads = 1
             AND business_attempt.stage_authority_id = NEW.business_stage_authority_id
             AND business_receipt.terminal_state = 'returned'
             AND business_receipt.result_digest = NEW.business_result_digest
             AND checkpoint.payload_plaintext_sha256 = NEW.business_result_digest
             AND NEW.successor_stage_count = (
               SELECT COUNT(*) FROM staged_transfer_stages successor
                WHERE successor.plan_id = plan.plan_id
                  AND successor.stage_ordinal > business.stage_ordinal
             )
             AND NOT EXISTS (
               SELECT 1 FROM staged_transfer_stages successor
                WHERE successor.plan_id = plan.plan_id
                  AND successor.stage_ordinal > business.stage_ordinal
                  AND (
                    ((successor.stage_ordinal - business.stage_ordinal) % 2 = 1 AND (
                      successor.stage_kind != 'download_transfer'
                      OR successor.depends_on_stage_ordinal != business.stage_ordinal
                    ))
                    OR
                    ((successor.stage_ordinal - business.stage_ordinal) % 2 = 0 AND (
                      successor.stage_kind != 'local_commit'
                      OR successor.depends_on_stage_ordinal != successor.stage_ordinal - 1
                      OR NOT EXISTS (
                        SELECT 1 FROM staged_transfer_stages download
                         WHERE download.plan_id = successor.plan_id
                           AND download.stage_ordinal = successor.stage_ordinal - 1
                           AND download.stage_kind = 'download_transfer'
                           AND download.json_pointer_digest IS successor.json_pointer_digest
                      )
                    ))
                  )
             )
        )
        BEGIN SELECT RAISE(ABORT, 'staged download topology lacks its exact business projection'); END;
        CREATE TRIGGER trg_staged_transfer_download_topology_immutable
        BEFORE UPDATE ON staged_transfer_download_topology_receipts
        BEGIN SELECT RAISE(ABORT, 'staged download topology receipts are append-only'); END;
        CREATE TRIGGER trg_staged_transfer_download_topology_delete_immutable
        BEFORE DELETE ON staged_transfer_download_topology_receipts
        WHEN EXISTS (SELECT 1 FROM staged_transfer_plans WHERE plan_id = OLD.plan_id)
        BEGIN SELECT RAISE(ABORT, 'staged download topology receipts are append-only'); END;

        CREATE TRIGGER trg_staged_transfer_secret_exact_attempt
        BEFORE INSERT ON staged_transfer_secret_payloads
        WHEN NOT EXISTS (
          SELECT 1
            FROM staged_transfer_stage_authorities attempt
            JOIN staged_transfer_stage_receipts receipt
              ON receipt.stage_authority_id = attempt.stage_authority_id
           WHERE attempt.stage_authority_id = NEW.stage_authority_id
             AND attempt.stage_kind = 'upload_presign'
             AND receipt.terminal_state = 'returned'
        )
        BEGIN SELECT RAISE(ABORT, 'staged signed URL lacks its exact returned presign attempt'); END;
        CREATE TRIGGER trg_staged_transfer_secret_immutable
        BEFORE UPDATE ON staged_transfer_secret_payloads
        BEGIN SELECT RAISE(ABORT, 'staged secret payload ownership is immutable'); END;
        CREATE TRIGGER trg_staged_transfer_secret_delete_immutable
        BEFORE DELETE ON staged_transfer_secret_payloads
        WHEN EXISTS (
          SELECT 1 FROM staged_transfer_stage_authorities
           WHERE stage_authority_id = OLD.stage_authority_id
        )
        BEGIN SELECT RAISE(ABORT, 'staged secret payload ownership is immutable'); END;

        CREATE TRIGGER trg_staged_transfer_blob_exact_stage
        BEFORE INSERT ON staged_transfer_blob_owners
        WHEN clementine_staged_blob_owner_admitted_v1(
          NEW.plan_id,
          NEW.stage_id,
          NEW.blob_sha256,
          NEW.blob_md5,
          NEW.blob_bytes
        ) != 1 OR NOT EXISTS (
          SELECT 1
            FROM staged_transfer_stages stage
            JOIN staged_transfer_stage_authorities attempt ON attempt.stage_id = stage.stage_id
            JOIN staged_transfer_stage_receipts receipt
              ON receipt.stage_authority_id = attempt.stage_authority_id
           WHERE stage.plan_id = NEW.plan_id
             AND stage.stage_id = NEW.stage_id
             AND stage.stage_kind IN ('local_snapshot','source_download','download_transfer','local_commit')
             AND receipt.terminal_state = 'returned'
        )
        BEGIN SELECT RAISE(ABORT, 'staged blob ownership lacks its exact returned stage'); END;
        CREATE TRIGGER trg_staged_transfer_blob_immutable
        BEFORE UPDATE ON staged_transfer_blob_owners
        BEGIN SELECT RAISE(ABORT, 'staged blob ownership is immutable'); END;
        CREATE TRIGGER trg_staged_transfer_blob_delete_immutable
        BEFORE DELETE ON staged_transfer_blob_owners
        WHEN EXISTS (SELECT 1 FROM staged_transfer_plans WHERE plan_id = OLD.plan_id)
        BEGIN SELECT RAISE(ABORT, 'staged blob ownership is immutable'); END;

        CREATE TRIGGER trg_staged_transfer_logical_settlement_fence
        BEFORE INSERT ON logical_call_settlements
        WHEN (
          EXISTS (
            SELECT 1 FROM staged_transfer_stage_authorities attempt
             WHERE attempt.session_id = NEW.session_id
               AND attempt.source_user_seq = NEW.source_user_seq
               AND attempt.logical_tool_call_id = NEW.logical_tool_call_id
               AND attempt.stage_kind != 'business_execute'
               AND (
                 NOT EXISTS (
                   SELECT 1 FROM staged_transfer_stage_receipts receipt
                    WHERE receipt.stage_authority_id = attempt.stage_authority_id
                 )
                 OR (NEW.outcome_kind IN ('succeeded','empty_result') AND NOT EXISTS (
                   SELECT 1 FROM staged_transfer_stage_receipts receipt
                    WHERE receipt.stage_authority_id = attempt.stage_authority_id
                      AND receipt.terminal_state = 'returned'
                 ))
               )
          )
          OR EXISTS (
            SELECT 1 FROM staged_transfer_plans plan
             WHERE plan.session_id = NEW.session_id
               AND plan.source_user_seq = NEW.source_user_seq
               AND plan.parent_logical_tool_call_id = NEW.logical_tool_call_id
               AND (
                 NOT EXISTS (
                   SELECT 1
                     FROM staged_transfer_stages business
                     JOIN staged_transfer_stage_authorities business_attempt
                       ON business_attempt.stage_id = business.stage_id
                     JOIN staged_transfer_stage_receipts business_receipt
                       ON business_receipt.stage_authority_id = business_attempt.stage_authority_id
                    WHERE business.plan_id = plan.plan_id
                      AND business.stage_kind = 'business_execute'
                 )
                 OR (NEW.outcome_kind IN ('succeeded','empty_result') AND EXISTS (
                   SELECT 1 FROM staged_transfer_stages required_stage
                    WHERE required_stage.plan_id = plan.plan_id
                      AND NOT EXISTS (
                        SELECT 1
                          FROM staged_transfer_stage_authorities required_attempt
                          JOIN staged_transfer_stage_receipts required_receipt
                            ON required_receipt.stage_authority_id = required_attempt.stage_authority_id
                         WHERE required_attempt.stage_id = required_stage.stage_id
                           AND required_receipt.terminal_state = 'returned'
                      )
                 ))
                 OR (NEW.outcome_kind IN ('succeeded','empty_result')
                   AND plan.output_may_contain_downloads = 1
                   AND NOT EXISTS (
                     SELECT 1 FROM staged_transfer_download_topology_receipts topology
                      WHERE topology.plan_id = plan.plan_id
                   ))
               )
          )
        )
        BEGIN SELECT RAISE(ABORT, 'staged logical settlement lacks exact terminal receipt graph'); END;

        CREATE TRIGGER trg_staged_transfer_child_no_progress
        BEFORE INSERT ON logical_call_settlements
        WHEN EXISTS (
          SELECT 1 FROM staged_transfer_stage_authorities attempt
           WHERE attempt.session_id = NEW.session_id
             AND attempt.source_user_seq = NEW.source_user_seq
             AND attempt.logical_tool_call_id = NEW.logical_tool_call_id
             AND attempt.stage_kind != 'business_execute'
        ) AND (
          NEW.business_call != 0 OR NEW.progress_claimed != 0
          OR NEW.requirement_id IS NOT NULL OR NEW.continues_requirement != 0
        )
        BEGIN SELECT RAISE(ABORT, 'staged control dependencies cannot discharge expected work'); END;
      `);

      const foreignKeyViolations = [
        'staged_transfer_plans',
        'staged_transfer_stages',
        'staged_transfer_stage_authorities',
        'physical_dispatch_return_checkpoints',
        'staged_transfer_stage_receipts',
        'staged_transfer_download_topology_receipts',
        'staged_transfer_attempt_reconciliations',
        'staged_transfer_consent_redemptions',
        'staged_transfer_secret_payloads',
        'staged_transfer_blob_owners',
      ].flatMap((table) => db.prepare(`PRAGMA foreign_key_check(${table})`).all());
      if (foreignKeyViolations.length > 0) {
        throw new Error(
          `schema v62 staged-transfer rebuild failed foreign-key validation: ${JSON.stringify(foreignKeyViolations.slice(0, 8))}`,
        );
      }
    },
  },
  {
    /**
     * v62 could persist a returned presign secret through a copyable SQL row.
     * No production upload body consumed it, so v63 retires every such row and
     * requires the physical-return module's connection-local, tuple-exact
     * admission for all newly returned presign attempts.
     */
    version: 63,
    sql: '',
    backfill: (db) => {
      const secretTable = db.prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'staged_transfer_secret_payloads'",
      ).get() as { ok: number } | undefined;
      // Legacy migration rehearsals intentionally contain no event spine and
      // therefore no staged-transfer graph. Preserve that sparse shape while
      // still stamping the corrective version; there is no secret row to
      // retire or trigger surface to install.
      if (!secretTable) return;
      db.exec(`
      DROP TRIGGER IF EXISTS trg_staged_transfer_secret_exact_attempt;
      DROP TRIGGER IF EXISTS trg_staged_transfer_secret_immutable;
      DROP TRIGGER IF EXISTS trg_staged_transfer_secret_delete_immutable;

      DELETE FROM staged_transfer_secret_payloads;

      CREATE TRIGGER trg_staged_transfer_secret_exact_attempt
      BEFORE INSERT ON staged_transfer_secret_payloads
      WHEN clementine_staged_secret_admitted_v1(
        NEW.payload_id,
        NEW.stage_authority_id,
        NEW.binding_digest,
        NEW.plaintext_sha256,
        NEW.plaintext_bytes,
        NEW.chunk_count,
        NEW.sealed_sha256,
        NEW.sealed_bytes,
        NEW.expires_at
      ) != 1 OR NOT EXISTS (
        SELECT 1
          FROM staged_transfer_stage_authorities attempt
          JOIN staged_transfer_stage_receipts receipt
            ON receipt.stage_authority_id = attempt.stage_authority_id
          JOIN physical_dispatch_return_checkpoints checkpoint
            ON checkpoint.stage_authority_id = attempt.stage_authority_id
         WHERE attempt.stage_authority_id = NEW.stage_authority_id
           AND attempt.stage_kind = 'upload_presign'
           AND receipt.terminal_state = 'returned'
           AND receipt.result_digest = NEW.plaintext_sha256
           AND checkpoint.payload_plaintext_sha256 = NEW.plaintext_sha256
      )
      BEGIN SELECT RAISE(ABORT, 'staged signed URL lacks its exact opaque return authority'); END;

      CREATE TRIGGER trg_staged_transfer_secret_immutable
      BEFORE UPDATE ON staged_transfer_secret_payloads
      BEGIN SELECT RAISE(ABORT, 'staged secret payload ownership is immutable'); END;
      CREATE TRIGGER trg_staged_transfer_secret_delete_immutable
      BEFORE DELETE ON staged_transfer_secret_payloads
      WHEN EXISTS (
        SELECT 1 FROM staged_transfer_stage_authorities
         WHERE stage_authority_id = OLD.stage_authority_id
      )
      BEGIN SELECT RAISE(ABORT, 'staged secret payload ownership is immutable'); END;
      `);
    },
  },
  {
    /**
     * Durable workflow_v3 call identity. Existing v1/v2 activation rows stay
     * byte-identical; one append-only 1:1 binding supplies the exact mutation
     * authority fields that v63 could not represent. The accepted-root rebuild
     * widens only its closed authority-kind CHECK and adds the exact v3 join.
     * Any pre-standard lookalike table is retired instead of trusted.
     */
    version: 64,
    sql: '',
    foreignKeysOff: true,
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      // As with v62/v63, sparse historical rehearsal stores have no accepted
      // event spine and cannot carry workflow execution authority. Do not
      // invent the spine merely to install an unreachable v3 table.
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'sessions',
        'events',
        'pending_approvals',
        'workflow_node_invocation_activations',
        'accepted_turn_call_authorities',
        'logical_tool_calls',
      ]) {
        if (!tables.has(prerequisite)) {
          throw new Error(`schema v64 prerequisite missing: ${prerequisite}`);
        }
      }

      // v63 had no sanctioned table by this name. Retaining a local/partial
      // experiment would silently promote copyable rows into authority.
      db.exec(`
        DROP TRIGGER IF EXISTS trg_workflow_v3_call_binding_exact_activation;
        DROP TRIGGER IF EXISTS trg_workflow_v3_call_binding_immutable;
        DROP TRIGGER IF EXISTS trg_workflow_v3_call_binding_delete_immutable;
        DROP TABLE IF EXISTS workflow_v3_call_activation_bindings;

        CREATE TABLE workflow_v3_call_activation_bindings (
          activation_id              TEXT PRIMARY KEY
                                     REFERENCES workflow_node_invocation_activations(activation_id)
                                     ON DELETE CASCADE,
          session_id                 TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          authority_binding_digest   TEXT NOT NULL UNIQUE
                                     CHECK (length(authority_binding_digest) = 64
                                       AND authority_binding_digest NOT GLOB '*[^0-9a-f]*'),
          requirement_id             TEXT NOT NULL CHECK (length(requirement_id) BETWEEN 1 AND 256),
          logical_capability_id      TEXT NOT NULL CHECK (length(logical_capability_id) BETWEEN 1 AND 256),
          effect                     TEXT NOT NULL
                                     CHECK (effect IN ('host_only','local_write','external_write','admin')),
          canonical_argument_digest  TEXT NOT NULL
                                     CHECK (length(canonical_argument_digest) = 64
                                       AND canonical_argument_digest NOT GLOB '*[^0-9a-f]*'),
          source_argument_digest     TEXT NOT NULL
                                     CHECK (length(source_argument_digest) = 64
                                       AND source_argument_digest NOT GLOB '*[^0-9a-f]*'),
          obligation_digest          TEXT NOT NULL
                                     CHECK (length(obligation_digest) = 64
                                       AND obligation_digest NOT GLOB '*[^0-9a-f]*'),
          capability_id              TEXT NOT NULL CHECK (length(capability_id) BETWEEN 1 AND 512),
          manifest_id                TEXT NOT NULL CHECK (length(manifest_id) BETWEEN 1 AND 512),
          manifest_digest            TEXT NOT NULL
                                     CHECK (length(manifest_digest) = 64
                                       AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
          operation_id               TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 512),
          operation_version          TEXT NOT NULL CHECK (length(operation_version) BETWEEN 1 AND 128),
          schema_digest              TEXT NOT NULL
                                     CHECK (length(schema_digest) = 64
                                       AND schema_digest NOT GLOB '*[^0-9a-f]*'),
          provider_version           TEXT NOT NULL CHECK (length(provider_version) BETWEEN 1 AND 128),
          live_fingerprint           TEXT NOT NULL
                                     CHECK (length(live_fingerprint) = 64
                                       AND live_fingerprint NOT GLOB '*[^0-9a-f]*'),
          account_id                 TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 512),
          invoke_port_id             TEXT NOT NULL CHECK (length(invoke_port_id) BETWEEN 1 AND 512),
          argument_compiler_id       TEXT NOT NULL CHECK (length(argument_compiler_id) BETWEEN 1 AND 256),
          argument_compiler_version  TEXT NOT NULL CHECK (length(argument_compiler_version) BETWEEN 1 AND 128),
          activated_at               TEXT NOT NULL
        );

        CREATE INDEX idx_workflow_v3_call_binding_session
          ON workflow_v3_call_activation_bindings(session_id, activated_at);

        CREATE TRIGGER trg_workflow_v3_call_binding_exact_activation
        BEFORE INSERT ON workflow_v3_call_activation_bindings
        WHEN clementine_workflow_v3_binding_admitted_v1(
          NEW.activation_id,
          NEW.session_id,
          NEW.authority_binding_digest,
          NEW.requirement_id,
          NEW.logical_capability_id,
          NEW.effect,
          NEW.canonical_argument_digest,
          NEW.source_argument_digest,
          NEW.obligation_digest,
          NEW.capability_id,
          NEW.manifest_id,
          NEW.manifest_digest,
          NEW.operation_id,
          NEW.operation_version,
          NEW.schema_digest,
          NEW.provider_version,
          NEW.live_fingerprint,
          NEW.account_id,
          NEW.invoke_port_id,
          NEW.argument_compiler_id,
          NEW.argument_compiler_version,
          NEW.activated_at
        ) != 1 OR NOT EXISTS (
          SELECT 1 FROM workflow_node_invocation_activations activation
           WHERE activation.activation_id = NEW.activation_id
             AND activation.session_id = NEW.session_id
             AND activation.logical_call_id IS NOT NULL
             AND activation.activated_at = NEW.activated_at
        )
        BEGIN
          SELECT RAISE(ABORT, 'workflow v3 binding lacks its exact opaque activation admission');
        END;

        CREATE TRIGGER trg_workflow_v3_call_binding_immutable
        BEFORE UPDATE ON workflow_v3_call_activation_bindings
        BEGIN
          SELECT RAISE(ABORT, 'workflow v3 activation bindings are immutable');
        END;

        CREATE TRIGGER trg_workflow_v3_call_binding_delete_immutable
        BEFORE DELETE ON workflow_v3_call_activation_bindings
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'workflow v3 activation bindings are append-only');
        END;
      `);

      rebuildAcceptedCallAuthoritiesForProductionHost(db, true);

      const relevantTables = foreignKeyClosure(db, [
        'workflow_v3_call_activation_bindings',
        'accepted_turn_call_authorities',
      ]);
      const violations = (db.pragma('foreign_key_check') as Array<{ table: string }>)
        .filter((violation) => relevantTables.has(violation.table));
      if (violations.length > 0) {
        throw new Error(`schema v64 foreign-key check failed for ${violations.length} workflow-v3 row(s)`);
      }
      const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new Error(`schema v64 integrity check failed: ${JSON.stringify(integrity).slice(0, 240)}`);
      }
    },
  },
  {
    // Lossless large tool-output storage. The legacy row remains the compact
    // lookup/preview record; bytes beyond its inline segment live in ordered,
    // content-addressed chunks. This removes the old 16MB terminal tail cliff
    // without forcing every lookup or SQL scan to hydrate a very large value.
    // Exact invocation rows get an independent chunk spine so reused SDK call
    // ids cannot alias evidence across physical attempts.
    version: 65,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      const addManifestColumns = (table: string): void => {
        if (!tables.has(table)) return;
        const columns = new Set(
          (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
            .map((column) => column.name),
        );
        if (!columns.has('output_sha256')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN output_sha256 TEXT`);
        }
        if (!columns.has('chunk_count')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0`);
        }
        if (!columns.has('output_chars')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN output_chars INTEGER`);
        }
        if (!columns.has('inline_sha256')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN inline_sha256 TEXT`);
        }
        if (!columns.has('inline_bytes')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN inline_bytes INTEGER`);
        }
        if (!columns.has('inline_chars')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN inline_chars INTEGER`);
        }
      };

      addManifestColumns('tool_outputs');
      addManifestColumns('tool_output_invocations');

      // v65 chunk/continuation names had no sanctioned predecessor. Refuse a
      // local lookalike instead of stamping arbitrary columns/foreign keys as
      // durable result authority.
      for (const table of [
        'tool_output_chunks',
        'tool_output_invocation_chunks',
        'tool_search_continuations',
      ]) {
        if (tables.has(table)) {
          throw new Error(`schema v65 refuses preexisting unsanctioned table ${table}`);
        }
      }

      if (tables.has('tool_outputs')) {
        const select = db.prepare(
          `SELECT session_id, call_id, output_full FROM tool_outputs
            WHERE output_sha256 IS NULL OR output_chars IS NULL OR inline_sha256 IS NULL
               OR inline_bytes IS NULL OR inline_chars IS NULL
            ORDER BY session_id, call_id LIMIT 1`,
        );
        const update = db.prepare(
          `UPDATE tool_outputs
              SET output_sha256 = COALESCE(output_sha256, ?),
                  output_chars = COALESCE(output_chars, ?),
                  inline_sha256 = ?, inline_bytes = ?, inline_chars = ?
            WHERE session_id = ? AND call_id = ?`,
        );
        while (true) {
          // Never hydrate every legacy 16MB side-store row together during an
          // upgrade. Select, hash, and retire one manifest gap at a time; the
          // update makes it ineligible for the next bounded query.
          const row = select.get() as { session_id: string; call_id: string; output_full: string } | undefined;
          if (!row) break;
          const bytes = Buffer.from(row.output_full, 'utf8');
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          update.run(
            sha256,
            row.output_full.length,
            sha256,
            bytes.length,
            row.output_full.length,
            row.session_id,
            row.call_id,
          );
        }
      }
      if (tables.has('tool_output_invocations')) {
        const select = db.prepare(
          `SELECT session_id, call_id, invocation_nonce, output_full
             FROM tool_output_invocations
            WHERE output_sha256 IS NULL OR output_chars IS NULL OR inline_sha256 IS NULL
               OR inline_bytes IS NULL OR inline_chars IS NULL
            ORDER BY session_id, call_id, invocation_nonce LIMIT 1`,
        );
        const update = db.prepare(
          `UPDATE tool_output_invocations
              SET output_sha256 = COALESCE(output_sha256, ?),
                  output_chars = COALESCE(output_chars, ?),
                  inline_sha256 = ?, inline_bytes = ?, inline_chars = ?
            WHERE session_id = ? AND call_id = ? AND invocation_nonce = ?`,
        );
        while (true) {
          const row = select.get() as {
            session_id: string;
            call_id: string;
            invocation_nonce: string;
            output_full: string;
          } | undefined;
          if (!row) break;
          const bytes = Buffer.from(row.output_full, 'utf8');
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          update.run(
            sha256,
            row.output_full.length,
            sha256,
            bytes.length,
            row.output_full.length,
            row.session_id,
            row.call_id,
            row.invocation_nonce,
          );
        }
      }

      if (tables.has('tool_outputs')) {
        db.exec(`
          CREATE TABLE tool_output_chunks (
            session_id    TEXT NOT NULL,
            call_id       TEXT NOT NULL,
            chunk_index   INTEGER NOT NULL CHECK (chunk_index >= 0),
            chunk_bytes   BLOB NOT NULL,
            content_bytes INTEGER NOT NULL CHECK (content_bytes >= 0),
            char_start     INTEGER NOT NULL CHECK (char_start >= 0),
            char_count     INTEGER NOT NULL CHECK (char_count > 0),
            chunk_sha256  TEXT NOT NULL
                          CHECK (length(chunk_sha256) = 64
                            AND chunk_sha256 NOT GLOB '*[^0-9a-f]*'),
            PRIMARY KEY (session_id, call_id, chunk_index),
            FOREIGN KEY (session_id, call_id)
              REFERENCES tool_outputs(session_id, call_id) ON DELETE CASCADE
          );
          CREATE INDEX idx_tool_outputs_session_created_call
            ON tool_outputs(session_id, created_at DESC, call_id ASC);
        `);
      }
      if (tables.has('tool_output_invocations')) {
        db.exec(`
          CREATE TABLE tool_output_invocation_chunks (
            session_id       TEXT NOT NULL,
            call_id          TEXT NOT NULL,
            invocation_nonce TEXT NOT NULL,
            chunk_index      INTEGER NOT NULL CHECK (chunk_index >= 0),
            chunk_bytes      BLOB NOT NULL,
            content_bytes    INTEGER NOT NULL CHECK (content_bytes >= 0),
            char_start        INTEGER NOT NULL CHECK (char_start >= 0),
            char_count        INTEGER NOT NULL CHECK (char_count > 0),
            chunk_sha256     TEXT NOT NULL
                             CHECK (length(chunk_sha256) = 64
                               AND chunk_sha256 NOT GLOB '*[^0-9a-f]*'),
            PRIMARY KEY (session_id, call_id, invocation_nonce, chunk_index),
            FOREIGN KEY (session_id, call_id, invocation_nonce)
              REFERENCES tool_output_invocations(session_id, call_id, invocation_nonce)
              ON DELETE CASCADE
          );
        `);
      }

      // `tool_search` result/schema cursors are local reads of one already
      // admitted discovery snapshot. Persist those exact bytes under the
      // durable session so a daemon/MCP restart cannot strand the cursor and
      // tempt a second provider discovery. The content/entry ceilings are
      // enforced again by the eventlog API inside each write transaction.
      if (tables.has('sessions')) {
        db.exec(`
          CREATE TABLE tool_search_continuations (
            session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            kind           TEXT NOT NULL CHECK (kind IN ('page', 'schema')),
            content_sha256 TEXT NOT NULL
                           CHECK (length(content_sha256) = 64
                             AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
            content_text   TEXT NOT NULL,
            content_bytes  INTEGER NOT NULL
                           CHECK (content_bytes BETWEEN 1 AND 1048576),
            created_at     TEXT NOT NULL,
            accessed_at    TEXT NOT NULL,
            access_seq     INTEGER NOT NULL CHECK (access_seq > 0),
            PRIMARY KEY (session_id, kind, content_sha256)
          );
          CREATE INDEX idx_tool_search_continuations_lru
            ON tool_search_continuations(session_id, access_seq);
        `);
      }

      const violations = db.pragma('foreign_key_check') as Array<{ table: string }>;
      const relevant = new Set([
        'tool_output_chunks',
        'tool_output_invocation_chunks',
        'tool_search_continuations',
      ]);
      const v65Violations = violations.filter((row) => relevant.has(row.table));
      if (v65Violations.length > 0) {
        throw new Error(`schema v65 foreign-key check failed for ${v65Violations.length} row(s)`);
      }
    },
  },
  {
    // Exact, encrypted provider-request reconstruction. The append-only owner
    // row contains only hashes, durable source references, and an encrypted
    // payload reference; raw model-visible bytes remain outside SQLite.
    version: 66,
    sql: '',
    backfill: (db) => {
      const existing = db.prepare(
        `SELECT 1 AS ok FROM sqlite_master
          WHERE type = 'table' AND name = 'model_request_provenance'`,
      ).get() as { ok: number } | undefined;
      if (existing) {
        throw new Error('schema v66 refuses preexisting unsanctioned table model_request_provenance');
      }
      const prerequisites = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!prerequisites.has('sessions') || !prerequisites.has('events')) {
        throw new Error('schema v66 prerequisite missing: sessions/events');
      }
      db.exec(`
        CREATE TABLE model_request_provenance (
          record_id                  TEXT PRIMARY KEY,
          session_id                 TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          source_user_seq            INTEGER NOT NULL CHECK (source_user_seq > 0),
          source_event_id            TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
          request_ordinal            INTEGER NOT NULL CHECK (request_ordinal > 0),
          protocol_version           INTEGER NOT NULL CHECK (protocol_version = 1),
          boundary                   TEXT NOT NULL
                                     CHECK (boundary IN ('whole_instructions','layered')),
          normalized_request_digest  TEXT NOT NULL
                                     CHECK (length(normalized_request_digest) = 64
                                       AND normalized_request_digest NOT GLOB '*[^0-9a-f]*'),
          host_projection_digest     TEXT NOT NULL
                                     CHECK (length(host_projection_digest) = 64
                                       AND host_projection_digest NOT GLOB '*[^0-9a-f]*'),
          provenance_digest          TEXT NOT NULL
                                     CHECK (length(provenance_digest) = 64
                                       AND provenance_digest NOT GLOB '*[^0-9a-f]*'),
          provenance_json            TEXT NOT NULL CHECK (length(provenance_json) BETWEEN 2 AND 1048576),
          payload_id                 TEXT NOT NULL UNIQUE,
          payload_binding_digest     TEXT NOT NULL
                                     CHECK (length(payload_binding_digest) = 64
                                       AND payload_binding_digest NOT GLOB '*[^0-9a-f]*'),
          payload_reference_json     TEXT NOT NULL
                                     CHECK (length(payload_reference_json) BETWEEN 2 AND 8192),
          created_at                 TEXT NOT NULL,
          UNIQUE (session_id, source_user_seq, request_ordinal)
        );
        CREATE INDEX idx_model_request_provenance_source
          ON model_request_provenance(session_id, source_user_seq, request_ordinal);

        CREATE TRIGGER trg_model_request_provenance_exact_source
        BEFORE INSERT ON model_request_provenance
        WHEN NOT EXISTS (
          SELECT 1 FROM events source
           WHERE source.id = NEW.source_event_id
             AND source.session_id = NEW.session_id
             AND source.seq = NEW.source_user_seq
             AND source.role = 'user'
             AND source.type = 'user_input_received'
             AND COALESCE(json_extract(source.data_json, '$.synthetic'), 0) != 1
        )
        BEGIN
          SELECT RAISE(ABORT, 'model request provenance requires its exact accepted source');
        END;

        CREATE TRIGGER trg_model_request_provenance_immutable
        BEFORE UPDATE ON model_request_provenance
        BEGIN
          SELECT RAISE(ABORT, 'model request provenance is immutable');
        END;

        CREATE TRIGGER trg_model_request_provenance_delete_immutable
        BEFORE DELETE ON model_request_provenance
        -- A parent-session retention delete remains the only deletion
        -- authority. Direct deletion while that parent exists is forbidden.
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'model request provenance is immutable');
        END;
      `);
      const violations = (db.pragma('foreign_key_check') as Array<{ table: string }>)
        .filter((row) => row.table === 'model_request_provenance');
      if (violations.length > 0) {
        throw new Error(`schema v66 foreign-key check failed for ${violations.length} model request row(s)`);
      }
    },
  },
  {
    /**
     * Exact, non-business results committed by the foreground host.
     *
     * A locally refused/not-started/user-rejected function call has no logical
     * settlement because it crossed neither the logical-call nor provider
     * boundary. Those results are still model-visible history, so durable
     * request provenance needs an immutable receipt for the exact output field.
     * The receipt is deliberately metadata-only: no provider response and no
     * raw output are duplicated here. Its parent model-batch admission proves
     * the exact accepted source, call id, and tool name.
     */
    version: 67,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'accepted_turn_call_authorities',
        'accepted_model_batch_admissions',
        'logical_tool_calls',
        'logical_call_settlements',
      ]) {
        if (!tables.has(prerequisite)) {
          throw new Error(`schema v67 prerequisite missing: ${prerequisite}`);
        }
      }
      if (tables.has('host_model_result_receipts')) {
        throw new Error('schema v67 refuses preexisting unsanctioned table host_model_result_receipts');
      }
      db.exec(`
        CREATE TABLE host_model_result_receipts (
          receipt_id          TEXT PRIMARY KEY CHECK (
                                length(receipt_id) = 64
                                AND receipt_id NOT GLOB '*[^0-9a-f]*'
                              ),
          session_id          TEXT NOT NULL,
          source_user_seq     INTEGER NOT NULL CHECK (source_user_seq > 0),
          source_event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
          accepted_task_id    TEXT NOT NULL CHECK (length(accepted_task_id) BETWEEN 1 AND 512),
          batch_ordinal       INTEGER NOT NULL CHECK (batch_ordinal > 0),
          batch_id            TEXT NOT NULL CHECK (length(batch_id) = 64),
          call_id             TEXT NOT NULL CHECK (length(call_id) BETWEEN 1 AND 512),
          tool_name           TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 512),
          disposition         TEXT NOT NULL CHECK (disposition IN (
                                'refused_pre_dispatch','not_started','user_rejected'
                              )),
          frame_digest        TEXT CHECK (
                                frame_digest IS NULL OR (
                                  length(frame_digest) = 64
                                  AND frame_digest NOT GLOB '*[^0-9a-f]*'
                                )
                              ),
          frame_index         INTEGER CHECK (frame_index IS NULL OR frame_index >= 0),
          frame_size          INTEGER CHECK (frame_size IS NULL OR frame_size > 0),
          counts_refusal      INTEGER NOT NULL DEFAULT 0 CHECK (counts_refusal IN (0, 1)),
          retry_mode          TEXT NOT NULL CHECK (retry_mode IN ('replan','do_not_retry')),
          output_bytes        INTEGER NOT NULL CHECK (output_bytes > 0),
          output_sha256       TEXT NOT NULL CHECK (
                                length(output_sha256) = 64
                                AND output_sha256 NOT GLOB '*[^0-9a-f]*'
                              ),
          recorded_at         TEXT NOT NULL,
          UNIQUE (session_id, source_user_seq, call_id),
          FOREIGN KEY (session_id, source_user_seq)
            REFERENCES accepted_turn_call_authorities(session_id, source_user_seq)
            ON DELETE CASCADE,
          FOREIGN KEY (session_id, source_user_seq, batch_ordinal, batch_id)
            REFERENCES accepted_model_batch_admissions(
              session_id, source_user_seq, batch_ordinal, batch_id
            ) ON DELETE CASCADE,
          CHECK (
            (disposition = 'user_rejected'
              AND frame_digest IS NULL AND frame_index IS NULL AND frame_size IS NULL
              AND counts_refusal = 0 AND retry_mode = 'do_not_retry')
            OR
            (disposition = 'not_started'
              AND frame_digest IS NOT NULL AND frame_index IS NOT NULL
              AND frame_size IS NOT NULL AND frame_index < frame_size
              AND counts_refusal = 0 AND retry_mode = 'replan')
            OR
            (disposition = 'refused_pre_dispatch'
              AND frame_digest IS NOT NULL AND frame_index IS NOT NULL
              AND frame_size IS NOT NULL AND frame_index < frame_size)
          )
        );

        CREATE INDEX idx_host_model_result_receipts_call
          ON host_model_result_receipts(session_id, call_id, source_user_seq);

        CREATE TRIGGER trg_host_model_result_receipt_exact_lineage
        BEFORE INSERT ON host_model_result_receipts
        WHEN NOT EXISTS (
          SELECT 1
            FROM accepted_model_batch_admissions admission
            JOIN accepted_turn_call_authorities root
              ON root.session_id = admission.session_id
             AND root.source_user_seq = admission.source_user_seq
            JOIN events source ON source.id = root.source_event_id
           WHERE admission.session_id = NEW.session_id
             AND admission.source_user_seq = NEW.source_user_seq
             AND admission.accepted_task_id = NEW.accepted_task_id
             AND admission.batch_ordinal = NEW.batch_ordinal
             AND admission.batch_id = NEW.batch_id
             AND root.accepted_task_id = NEW.accepted_task_id
             AND root.source_event_id = NEW.source_event_id
             AND root.state = 'open'
             AND source.session_id = NEW.session_id
             AND source.seq = NEW.source_user_seq
             AND source.role = 'user'
             AND source.type = 'user_input_received'
             AND COALESCE(json_extract(source.data_json, '$.synthetic'), 0) != 1
             AND (
               SELECT COUNT(*)
                 FROM json_each(admission.frame_history_json) item
                WHERE json_extract(item.value, '$.type') = 'function_call'
                  AND json_extract(item.value, '$.callId') = NEW.call_id
                  AND json_extract(item.value, '$.name') = NEW.tool_name
             ) = 1
        )
        BEGIN
          SELECT RAISE(ABORT, 'host model result receipt requires exact accepted source/call lineage');
        END;

        CREATE TRIGGER trg_host_model_result_receipt_no_business_call
        BEFORE INSERT ON host_model_result_receipts
        WHEN EXISTS (
          SELECT 1 FROM logical_tool_calls logical
           WHERE logical.session_id = NEW.session_id
             AND logical.logical_tool_call_id = NEW.call_id
        ) OR EXISTS (
          SELECT 1 FROM logical_call_settlements settlement
           WHERE settlement.session_id = NEW.session_id
             AND (settlement.logical_tool_call_id = NEW.call_id
               OR settlement.observer_call_id = NEW.call_id)
        )
        BEGIN
          SELECT RAISE(ABORT, 'host model result receipt cannot replace logical settlement evidence');
        END;

        CREATE TRIGGER trg_host_model_result_receipt_immutable
        BEFORE UPDATE ON host_model_result_receipts
        BEGIN
          SELECT RAISE(ABORT, 'host model result receipts are immutable');
        END;

        CREATE TRIGGER trg_host_model_result_receipt_delete_immutable
        BEFORE DELETE ON host_model_result_receipts
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'host model result receipts are immutable');
        END;
      `);
      const violations = (db.pragma('foreign_key_check') as Array<{ table: string }>)
        .filter((row) => row.table === 'host_model_result_receipts');
      if (violations.length > 0) {
        throw new Error(`schema v67 foreign-key check failed for ${violations.length} host result row(s)`);
      }
    },
  },
  {
    /**
     * Durable reason for the one boot-only dispatch quarantine.
     *
     * `revoked_at` predates reasoned revocation and therefore remains valid on
     * its own. New daemon-boot quarantine writes use the one closed reason
     * below, while ordinary exact-generation release stays backward-compatible
     * with a NULL reason. The lease row is reused by scope, so a successor
     * generation clears both fields when it wins that scope.
     */
    version: 68,
    sql: '',
    backfill: (db) => {
      const table = db.prepare(
        `SELECT 1 AS ok FROM sqlite_master
          WHERE type = 'table' AND name = 'run_dispatch_leases'`,
      ).get() as { ok: number } | undefined;
      if (!table) throw new Error('schema v68 prerequisite missing: run_dispatch_leases');
      const columns = new Set(
        (db.prepare('PRAGMA table_info(run_dispatch_leases)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has('revocation_reason')) {
        db.exec(`
          ALTER TABLE run_dispatch_leases
          ADD COLUMN revocation_reason TEXT
            CHECK (
              revocation_reason IS NULL
              OR revocation_reason = 'terminal_run_attempt_at_daemon_boot'
            )
        `);
      }
    },
  },
  {
    /**
     * Immutable evidence for the exact model-visible projection of a settled
     * logical call. Logical settlement/result-handle rows prove provider-side
     * outcome bytes, but the host may preserve structured SDK content or apply
     * a deterministic presentation transform before the next model request.
     * This metadata receipt seals that whole `function_call_result` item's
     * canonical byte count and SHA-256 without copying either the projection
     * payload or a separate raw provider payload into SQLite.
     *
     * Existing ready checkpoints are safe backfill authority: only an exact
     * admission call/result pair with one unambiguous same-source/task logical
     * or observer settlement is adopted. Ambiguous and unsettled history is
     * deliberately skipped rather than inferred.
     */
    version: 69,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'accepted_turn_call_authorities',
        'accepted_model_batch_admissions',
        'accepted_model_batch_checkpoints',
        'logical_tool_calls',
        'logical_call_settlements',
      ]) {
        if (!tables.has(prerequisite)) {
          throw new Error(`schema v69 prerequisite missing: ${prerequisite}`);
        }
      }
      if (tables.has('logical_model_result_projection_receipts')) {
        throw new Error(
          'schema v69 refuses preexisting unsanctioned table logical_model_result_projection_receipts',
        );
      }
      db.exec(`
        CREATE TABLE logical_model_result_projection_receipts (
          receipt_id                       TEXT PRIMARY KEY CHECK (
                                             length(receipt_id) = 64
                                             AND receipt_id NOT GLOB '*[^0-9a-f]*'
                                           ),
          protocol_version                 INTEGER NOT NULL CHECK (protocol_version = 1),
          session_id                       TEXT NOT NULL,
          source_user_seq                  INTEGER NOT NULL CHECK (source_user_seq > 0),
          source_event_id                  TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
          accepted_task_id                 TEXT NOT NULL CHECK (
                                             length(accepted_task_id) BETWEEN 1 AND 512
                                           ),
          batch_ordinal                    INTEGER NOT NULL CHECK (batch_ordinal > 0),
          batch_id                         TEXT NOT NULL CHECK (
                                             length(batch_id) = 64
                                             AND batch_id NOT GLOB '*[^0-9a-f]*'
                                           ),
          call_id                          TEXT NOT NULL CHECK (length(call_id) BETWEEN 1 AND 512),
          tool_name                        TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 512),
          call_namespace                   TEXT CHECK (
                                             call_namespace IS NULL
                                             OR length(call_namespace) <= 512
                                           ),
          settlement_identity_kind         TEXT NOT NULL CHECK (
                                             settlement_identity_kind IN ('logical','observer')
                                           ),
          settlement_logical_tool_call_id  TEXT NOT NULL CHECK (
                                             length(settlement_logical_tool_call_id) BETWEEN 1 AND 512
                                           ),
          settlement_observer_call_id      TEXT CHECK (
                                             settlement_observer_call_id IS NULL
                                             OR length(settlement_observer_call_id) BETWEEN 1 AND 256
                                           ),
          settlement_event_id              TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
          settlement_semantic_digest       TEXT NOT NULL CHECK (
                                             length(settlement_semantic_digest) = 64
                                             AND settlement_semantic_digest NOT GLOB '*[^0-9a-f]*'
                                           ),
          result_class                     TEXT NOT NULL CHECK (result_class IN (
                                             'text','structured','media',
                                             'refused_pre_dispatch','not_started',
                                             'user_rejected','effect_unknown'
                                           )),
          result_item_bytes                INTEGER NOT NULL CHECK (result_item_bytes > 0),
          result_item_sha256               TEXT NOT NULL CHECK (
                                             length(result_item_sha256) = 64
                                             AND result_item_sha256 NOT GLOB '*[^0-9a-f]*'
                                           ),
          recorded_at                      TEXT NOT NULL,
          UNIQUE (session_id, source_user_seq, call_id),
          FOREIGN KEY (session_id, source_user_seq)
            REFERENCES accepted_turn_call_authorities(session_id, source_user_seq)
            ON DELETE CASCADE,
          FOREIGN KEY (session_id, source_user_seq, batch_ordinal, batch_id)
            REFERENCES accepted_model_batch_admissions(
              session_id, source_user_seq, batch_ordinal, batch_id
            ) ON DELETE CASCADE,
          FOREIGN KEY (session_id, source_user_seq, settlement_logical_tool_call_id)
            REFERENCES logical_call_settlements(
              session_id, source_user_seq, logical_tool_call_id
            ) ON DELETE CASCADE
        );

        CREATE INDEX idx_logical_model_result_projection_receipts_call
          ON logical_model_result_projection_receipts(
            session_id, call_id, source_user_seq, batch_ordinal
          );
        CREATE INDEX idx_logical_model_result_projection_receipts_settlement
          ON logical_model_result_projection_receipts(
            session_id, source_user_seq, settlement_logical_tool_call_id
          );

        CREATE TRIGGER trg_logical_model_result_projection_exact_lineage
        BEFORE INSERT ON logical_model_result_projection_receipts
        WHEN NOT EXISTS (
          SELECT 1
            FROM accepted_model_batch_admissions admission
            JOIN accepted_turn_call_authorities root
              ON root.session_id = admission.session_id
             AND root.source_user_seq = admission.source_user_seq
            JOIN events source ON source.id = root.source_event_id
           WHERE admission.session_id = NEW.session_id
             AND admission.source_user_seq = NEW.source_user_seq
             AND admission.accepted_task_id = NEW.accepted_task_id
             AND admission.batch_ordinal = NEW.batch_ordinal
             AND admission.batch_id = NEW.batch_id
             AND root.accepted_task_id = NEW.accepted_task_id
             AND root.source_event_id = NEW.source_event_id
             AND source.session_id = NEW.session_id
             AND source.seq = NEW.source_user_seq
             AND source.role = 'user'
             AND source.type = 'user_input_received'
             AND COALESCE(json_extract(source.data_json, '$.synthetic'), 0) != 1
             AND (
               SELECT COUNT(*)
                 FROM json_each(admission.frame_history_json) item
                WHERE json_extract(item.value, '$.type') = 'function_call'
                  AND json_extract(item.value, '$.callId') = NEW.call_id
                  AND json_extract(item.value, '$.name') = NEW.tool_name
                  AND json_extract(item.value, '$.namespace') IS NEW.call_namespace
             ) = 1
        )
        BEGIN
          SELECT RAISE(ABORT,
            'logical model result projection requires exact accepted source/call lineage');
        END;

        CREATE TRIGGER trg_logical_model_result_projection_exact_settlement
        BEFORE INSERT ON logical_model_result_projection_receipts
        WHEN (
          SELECT COUNT(*)
            FROM logical_call_settlements settlement
            JOIN logical_tool_calls logical
              ON logical.session_id = settlement.session_id
             AND logical.source_user_seq = settlement.source_user_seq
             AND logical.logical_tool_call_id = settlement.logical_tool_call_id
           WHERE settlement.session_id = NEW.session_id
             AND settlement.source_user_seq = NEW.source_user_seq
             AND logical.accepted_task_id = NEW.accepted_task_id
             AND logical.state = 'settled'
             AND logical.settlement_event_id = settlement.settlement_event_id
             AND (
               settlement.logical_tool_call_id = NEW.call_id
               OR settlement.observer_call_id = NEW.call_id
             )
        ) != 1
        OR NOT EXISTS (
          SELECT 1
            FROM logical_call_settlements settlement
            JOIN logical_tool_calls logical
              ON logical.session_id = settlement.session_id
             AND logical.source_user_seq = settlement.source_user_seq
             AND logical.logical_tool_call_id = settlement.logical_tool_call_id
           WHERE settlement.session_id = NEW.session_id
             AND settlement.source_user_seq = NEW.source_user_seq
             AND settlement.logical_tool_call_id = NEW.settlement_logical_tool_call_id
             AND settlement.observer_call_id IS NEW.settlement_observer_call_id
             AND settlement.settlement_event_id = NEW.settlement_event_id
             AND settlement.semantic_digest = NEW.settlement_semantic_digest
             AND logical.accepted_task_id = NEW.accepted_task_id
             AND logical.state = 'settled'
             AND logical.settlement_event_id = settlement.settlement_event_id
             AND (
               (NEW.settlement_identity_kind = 'logical'
                 AND settlement.logical_tool_call_id = NEW.call_id
                 AND logical.tool_name = NEW.tool_name)
               OR
               (NEW.settlement_identity_kind = 'observer'
                 AND settlement.observer_call_id = NEW.call_id
                 AND (
                   settlement.logical_tool_call_id != NEW.call_id
                   OR logical.tool_name != NEW.tool_name
                 ))
             )
        )
        BEGIN
          SELECT RAISE(ABORT,
            'logical model result projection requires one exact settled logical identity');
        END;

        CREATE TRIGGER trg_logical_model_result_projection_immutable
        BEFORE UPDATE ON logical_model_result_projection_receipts
        BEGIN
          SELECT RAISE(ABORT, 'logical model result projections are immutable');
        END;

        CREATE TRIGGER trg_logical_model_result_projection_delete_immutable
        BEFORE DELETE ON logical_model_result_projection_receipts
        WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'logical model result projections are immutable');
        END;
      `);

      const checkpointRows = db.prepare(`
        SELECT checkpoint.session_id, checkpoint.source_user_seq,
               checkpoint.accepted_task_id, checkpoint.batch_ordinal,
               checkpoint.batch_id, checkpoint.history_json,
               checkpoint.committed_at, admission.pre_history_json,
               admission.frame_history_json,
               root.source_event_id
          FROM accepted_model_batch_checkpoints checkpoint
          JOIN accepted_model_batch_admissions admission
            ON admission.session_id = checkpoint.session_id
           AND admission.source_user_seq = checkpoint.source_user_seq
           AND admission.batch_ordinal = checkpoint.batch_ordinal
           AND admission.batch_id = checkpoint.batch_id
          JOIN accepted_turn_call_authorities root
            ON root.session_id = checkpoint.session_id
           AND root.source_user_seq = checkpoint.source_user_seq
           AND root.accepted_task_id = checkpoint.accepted_task_id
         WHERE checkpoint.disposition = 'ready'
         ORDER BY checkpoint.session_id, checkpoint.source_user_seq, checkpoint.batch_ordinal
      `).all() as Array<{
        session_id: string;
        source_user_seq: number;
        accepted_task_id: string;
        batch_ordinal: number;
        batch_id: string;
        history_json: string;
        committed_at: string;
        pre_history_json: string;
        frame_history_json: string;
        source_event_id: string;
      }>;
      const settlementCandidates = db.prepare(`
        SELECT settlement.logical_tool_call_id,
               logical.tool_name AS logical_tool_name,
               settlement.observer_call_id,
               settlement.settlement_event_id,
               settlement.semantic_digest
          FROM logical_call_settlements settlement
          JOIN logical_tool_calls logical
            ON logical.session_id = settlement.session_id
           AND logical.source_user_seq = settlement.source_user_seq
           AND logical.logical_tool_call_id = settlement.logical_tool_call_id
         WHERE settlement.session_id = ?
           AND settlement.source_user_seq = ?
           AND logical.accepted_task_id = ?
           AND logical.state = 'settled'
           AND logical.settlement_event_id = settlement.settlement_event_id
           AND (settlement.logical_tool_call_id = ? OR settlement.observer_call_id = ?)
         ORDER BY settlement.logical_tool_call_id
      `);
      const insertReceipt = db.prepare(`
        INSERT INTO logical_model_result_projection_receipts
          (receipt_id, protocol_version, session_id, source_user_seq,
           source_event_id, accepted_task_id, batch_ordinal, batch_id,
           call_id, tool_name, call_namespace, settlement_identity_kind,
           settlement_logical_tool_call_id, settlement_observer_call_id,
           settlement_event_id, settlement_semantic_digest, result_class,
           result_item_bytes, result_item_sha256, recorded_at)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const checkpoint of checkpointRows) {
        let preHistory: unknown;
        let frameHistory: unknown;
        let history: unknown;
        try {
          preHistory = JSON.parse(checkpoint.pre_history_json) as unknown;
          frameHistory = JSON.parse(checkpoint.frame_history_json) as unknown;
          history = JSON.parse(checkpoint.history_json) as unknown;
        } catch {
          continue;
        }
        if (
          !Array.isArray(preHistory)
          || !Array.isArray(frameHistory)
          || !Array.isArray(history)
          || !exactOpenAdmissionFrameForMigration(preHistory, frameHistory)
          || !inspectProtocolForMigration(history, true).valid
        ) continue;
        for (const candidateCall of frameHistory) {
          if (!candidateCall || typeof candidateCall !== 'object' || Array.isArray(candidateCall)) continue;
          const call = candidateCall as Record<string, unknown>;
          const callId = typeof call.callId === 'string' ? call.callId : '';
          const toolName = typeof call.name === 'string' ? call.name : '';
          if (
            call.type !== 'function_call' || !callId || !toolName
            || (call.namespace !== undefined && typeof call.namespace !== 'string')
          ) continue;
          const callNamespace = typeof call.namespace === 'string' ? call.namespace : null;
          const resultCandidates = history.filter((candidate) => {
            if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
            const result = candidate as Record<string, unknown>;
            return result.type === 'function_call_result'
              && result.callId === callId
              && result.name === toolName;
          });
          if (resultCandidates.length !== 1) continue;
          let material: LogicalModelResultProjectionMaterialForMigration | null = null;
          try {
            material = projectionMaterialForMigration(resultCandidates[0]);
          } catch {
            material = null;
          }
          if (
            !material
            || material.callId !== callId
            || material.toolName !== toolName
            || material.callNamespace !== callNamespace
          ) continue;
          const settlements = settlementCandidates.all(
            checkpoint.session_id,
            checkpoint.source_user_seq,
            checkpoint.accepted_task_id,
            callId,
            callId,
          ) as Array<{
            logical_tool_call_id: string;
            logical_tool_name: string;
            observer_call_id: string | null;
            settlement_event_id: string;
            semantic_digest: string;
          }>;
          if (settlements.length !== 1) continue;
          const settlement = settlements[0]!;
          const logicalMatch = settlement.logical_tool_call_id === callId;
          const observerMatch = settlement.observer_call_id === callId;
          if (!logicalMatch && !observerMatch) continue;
          if (settlement.logical_tool_name !== toolName && !observerMatch) continue;
          const identityKind = logicalMatch && settlement.logical_tool_name === toolName
            ? 'logical'
            : 'observer';
          const receiptIdentity = {
            protocol: 'clementine.logical_model_result_projection_receipt.v1',
            sessionId: checkpoint.session_id,
            sourceUserSeq: checkpoint.source_user_seq,
            sourceEventId: checkpoint.source_event_id,
            acceptedTaskId: checkpoint.accepted_task_id,
            batchOrdinal: checkpoint.batch_ordinal,
            batchId: checkpoint.batch_id,
            callId,
            toolName,
            callNamespace,
            settlementIdentityKind: identityKind,
            settlementLogicalToolCallId: settlement.logical_tool_call_id,
            settlementObserverCallId: settlement.observer_call_id,
            settlementEventId: settlement.settlement_event_id,
            settlementSemanticDigest: settlement.semantic_digest,
            resultClass: material.resultClass,
            resultItemBytes: material.resultItemBytes,
            resultItemSha256: material.resultItemSha256,
          };
          const receiptId = createHash('sha256')
            .update(canonicalProjectionJsonForMigration(receiptIdentity), 'utf8')
            .digest('hex');
          insertReceipt.run(
            receiptId,
            checkpoint.session_id,
            checkpoint.source_user_seq,
            checkpoint.source_event_id,
            checkpoint.accepted_task_id,
            checkpoint.batch_ordinal,
            checkpoint.batch_id,
            callId,
            toolName,
            callNamespace,
            identityKind,
            settlement.logical_tool_call_id,
            settlement.observer_call_id,
            settlement.settlement_event_id,
            settlement.semantic_digest,
            material.resultClass,
            material.resultItemBytes,
            material.resultItemSha256,
            checkpoint.committed_at,
          );
        }
      }

      const relevantTables = foreignKeyClosure(db, [
        'logical_model_result_projection_receipts',
      ]);
      const violations = (db.pragma('foreign_key_check') as Array<{ table: string }>)
        .filter((violation) => relevantTables.has(violation.table));
      if (violations.length > 0) {
        throw new Error(
          `schema v69 foreign-key check failed for ${violations.length} logical result projection row(s)`,
        );
      }
    },
  },
  {
    // Session retention is the sole sanctioned owner of durable task cleanup.
    // V37 amendments accidentally used RESTRICT parents and had no session FK,
    // so one valid amendment stranded the entire old terminal session. Rebuild
    // only that child with exact session-bound contract/event CASCADE parents;
    // its retention-aware immutability trigger continues to reject standalone
    // deletion while the session exists.
    version: 70,
    sql: '',
    foreignKeysOff: true,
    backfill: rebuildExpectedWorkUniverseAmendmentCascade,
  },
  {
    /** Close both plan_task post-persist crash windows. The immutable
     * preparation checkpoint names the exact plan call, graph, contract,
     * preamble content address, and presentation owner before delivery. */
    version: 71,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        'accepted_turn_call_authorities',
        'accepted_task_authority',
        'accepted_task_work_contracts',
        'accepted_task_resolutions',
        'accepted_model_batch_admissions',
        'accepted_model_batch_checkpoints',
        'logical_tool_calls',
        'logical_call_settlements',
        'logical_call_settlement_crossings',
        'physical_dispatches',
        'durable_result_handles',
        PLAN_TASK_ACTIVATION_RECEIPTS_TABLE,
      ]) {
        if (!tables.has(prerequisite)) throw new Error(`schema v71 prerequisite missing: ${prerequisite}`);
      }
      createPlanTaskPreparationCheckpointSchema(db);
      createAsyncReadRefinementSchema(db);
      backfillPlanTaskPreparationCheckpointsV71(db);
      refreshCheckpointBackedPlanContinuationTriggersV71(db);

      const relevantTables = foreignKeyClosure(db, [
        PLAN_TASK_BINDING_SEAL_RECOVERY_CURSOR_TABLE,
        PLAN_TASK_BINDING_SEAL_INTENTS_TABLE,
        PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE,
        PLAN_TASK_ACTIVATION_RECEIPTS_TABLE,
        ASYNC_READ_REFINEMENT_INTENTS_TABLE,
        ASYNC_READ_REFINEMENT_START_RECEIPTS_TABLE,
        ASYNC_READ_REFINEMENT_COMPLETION_RECEIPTS_TABLE,
      ]);
      const violations = (db.pragma('foreign_key_check') as Array<{ table: string }>)
        .filter((violation) => relevantTables.has(violation.table));
      if (violations.length > 0) {
        throw new Error(
          `schema v71 foreign-key check failed for ${violations.length} plan preparation row(s)`,
        );
      }
    },
  },
  {
    /** Add the mutually-exclusive terminal outcome and the durable paged crash
     * claimant after the v71 async owner shipped. This must remain its own
     * migration: developer homes may already have recorded v71. */
    version: 72,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        ASYNC_READ_REFINEMENT_INTENTS_TABLE,
        ASYNC_READ_REFINEMENT_START_RECEIPTS_TABLE,
        ASYNC_READ_REFINEMENT_COMPLETION_RECEIPTS_TABLE,
      ]) {
        if (!tables.has(prerequisite)) throw new Error(`schema v72 prerequisite missing: ${prerequisite}`);
      }
      createAsyncReadRefinementTerminalRecoverySchemaV72(db);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sessions_chat_run_in_flight_updated
          ON sessions(updated_at, id)
          WHERE kind = 'chat'
            AND json_type(metadata_json, '$.__run_in_flight') IS NOT NULL;
      `);
      const relevantTables = foreignKeyClosure(db, [
        ASYNC_READ_REFINEMENT_RECOVERY_CURSOR_TABLE,
        ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE,
      ]);
      const violations = (db.pragma('foreign_key_check') as Array<{ table: string }>)
        .filter((violation) => relevantTables.has(violation.table));
      if (violations.length > 0) {
        throw new Error(
          `schema v72 foreign-key check failed for ${violations.length} async refinement terminal row(s)`,
        );
      }
    },
  },
  {
    /** Normalize stamped v71/v72 development candidates. v73 is intentionally
     * additive even though the release is not final: a running daemon may have
     * already recorded either earlier version and numbered migrations never
     * rewrite history. */
    version: 73,
    sql: '',
    backfill: (db) => {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      if (!tables.has('sessions') || !tables.has('events')) return;
      for (const prerequisite of [
        ASYNC_READ_REFINEMENT_INTENTS_TABLE,
        ASYNC_READ_REFINEMENT_START_RECEIPTS_TABLE,
        ASYNC_READ_REFINEMENT_COMPLETION_RECEIPTS_TABLE,
      ]) {
        if (!tables.has(prerequisite)) throw new Error(`schema v73 prerequisite missing: ${prerequisite}`);
      }
      createPlanTaskPreparationCheckpointSchema(db);
      createAsyncReadRefinementSchema(db);
      createAsyncReadRefinementTerminalRecoverySchema(db);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sessions_chat_run_in_flight_updated
          ON sessions(updated_at, id)
          WHERE kind = 'chat'
            AND json_type(metadata_json, '$.__run_in_flight') IS NOT NULL;
      `);
      const relevantTables = foreignKeyClosure(db, [
        PLAN_TASK_BINDING_SEAL_RECOVERY_CURSOR_TABLE,
        PLAN_TASK_BINDING_SEAL_INTENTS_TABLE,
        PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE,
        ASYNC_READ_REFINEMENT_RECOVERY_CURSOR_TABLE,
        ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE,
      ]);
      const violations = (db.pragma('foreign_key_check') as Array<{ table: string }>)
        .filter((violation) => relevantTables.has(violation.table));
      if (violations.length > 0) {
        throw new Error(
          `schema v73 foreign-key check failed for ${violations.length} recovery authority row(s)`,
        );
      }
    },
  },
];

function ensureAuthorityPrivacySchema(db: Database.Database): void {
  const sealed = db.prepare(
    `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'physical_dispatch_authority_sealed'`,
  ).get() as { ok: number } | undefined;
  if (sealed) {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(physical_dispatch_authority_sealed)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!columns.has('argument_cipher')) {
      db.exec('ALTER TABLE physical_dispatch_authority_sealed ADD COLUMN argument_cipher TEXT');
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS capability_port_implementations (
      invoke_port_id TEXT NOT NULL,
      reconcile_port_id TEXT NOT NULL DEFAULT '',
      implementation_digest TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (invoke_port_id, reconcile_port_id)
    );
    CREATE TABLE IF NOT EXISTS physical_dispatch_owner_fences (
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL,
      physical_dispatch_id TEXT NOT NULL,
      owner_fence TEXT NOT NULL,
      PRIMARY KEY (session_id, source_user_seq, physical_dispatch_id)
    );
  `);
  const scrub = (table: string): void => {
    const exists = db.prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(table) as { ok: number } | undefined;
    if (!exists) return;
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!columns.has('authority_json')) return;
    if (table === 'physical_dispatch_authority_payload') {
      db.prepare(
        `DELETE FROM physical_dispatch_authority_payload
          WHERE authority_json LIKE '%canonicalArgs%'
            AND authority_json NOT LIKE '%"argsRedacted":true%'`,
      ).run();
      return;
    }
    db.prepare(
      `UPDATE physical_dispatch_authority SET authority_json = NULL
        WHERE authority_json LIKE '%canonicalArgs%'`,
    ).run();
  };
  scrub('physical_dispatch_authority_payload');
  scrub('physical_dispatch_authority');
}

const newestMigrationVersion = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
if (newestMigrationVersion !== HARNESS_SCHEMA_VERSION) {
  throw new Error(
    `HARNESS_SCHEMA_VERSION=${HARNESS_SCHEMA_VERSION} does not match newest migration ${newestMigrationVersion}`,
  );
}

/** Production migration entry used by rehearsal. Callers must already bind CLEMENTINE_HOME. */
/**
 * Tables owned by a refuse-on-existence migration.
 *
 * v65, v66, v67 and v69 each REFUSE their table name when their version row is
 * absent: those names had no sanctioned predecessor, so a preexisting lookalike
 * must never be blessed as durable authority. That guard is correct and is why
 * a real store is protected.
 *
 * It also means a migration REHEARSAL — which rewinds schema_version and
 * replays — must shed these first, or a migration fails on the structure its
 * own earlier run created. The shed list used to be hand-maintained beside the
 * guards and rotted twice: v66's table was added, v67's was not, and 46 tests
 * failed with "schema v67 refuses preexisting unsanctioned table
 * host_model_result_receipts" while production was perfectly fine.
 *
 * This is the single source of truth. A pin asserts it covers every table named
 * by a guard, so adding a guarded migration without listing it here fails
 * loudly instead of silently breaking every rehearsal.
 */
export const STRICT_TAIL_TABLES: readonly string[] = Object.freeze([
  // v65
  'tool_output_chunks',
  'tool_output_invocation_chunks',
  'tool_search_continuations',
  // v66
  'model_request_provenance',
  // v67
  'host_model_result_receipts',
  // v69
  'logical_model_result_projection_receipts',
]);

export function applyHarnessMigrations(db: Database.Database): void {
  runMigrations(db);
  ensureAuthorityPrivacySchema(db);
}

/** Exact historical rehearsal seam. It is unavailable outside the isolated
 * test contract so production cannot deliberately strand a store mid-chain. */
export function applyHarnessMigrationsThroughVersionForTests(
  db: Database.Database,
  version: number,
): void {
  if (process.env.CLEMMY_TEST_ISOLATED_HOME !== '1') {
    throw new Error('partial harness migrations require the isolated test contract');
  }
  if (!Number.isSafeInteger(version) || version < 0 || version > HARNESS_SCHEMA_VERSION) {
    throw new Error('partial harness migration target is invalid');
  }
  runMigrations(db, version);
}

function runMigrations(db: Database.Database, throughVersion = HARNESS_SCHEMA_VERSION): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const current =
    (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }).v ?? 0;
  const apply = db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)');
  for (const migration of MIGRATIONS) {
    if (migration.version > throughVersion) break;
    if (migration.version <= current) continue;
    const foreignKeysWereEnabled = Number(db.pragma('foreign_keys', { simple: true })) === 1;
    if (migration.foreignKeysOff && foreignKeysWereEnabled) db.pragma('foreign_keys = OFF');
    try {
      const tx = db.transaction(() => {
        db.exec(migration.sql);
        migration.backfill?.(db);
        apply.run(migration.version, new Date().toISOString());
      });
      tx();
    } finally {
      if (migration.foreignKeysOff && foreignKeysWereEnabled) db.pragma('foreign_keys = ON');
    }
  }
}
