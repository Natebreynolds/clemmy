/**
 * Cycle-free final proof verifier for accepted-task terminal publication.
 *
 * This module deliberately accepts an existing SQLite connection and imports
 * no eventlog/runtime store. `appendEvent` calls it while the terminal event
 * insert and authority CAS are still inside one IMMEDIATE transaction, closing
 * the check-then-publish window that an outer adjudicator cannot close.
 *
 * The staged production cutover currently covers deterministic direct and
 * retrieve tasks. Direct tasks owe zero obligations. Retrieve tasks may close
 * only from the normalized v30 read-receipt chain. Every other obligation
 * fails closed until its own normalized host receipt reaches this boundary.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ObligationManifest } from './obligation-manifest.js';
import { providerEnvelopeHasContradiction } from './provider-read-evidence.js';
import { deriveResultHandleFactsFromRaw } from './result-facts.js';

const MAX_DURABLE_CURSOR_BYTES = 65_536;

export type TerminalPublicationProofResult =
  | { ok: true }
  | { ok: false; status: 'not_ready' | 'conflict' | 'unreadable'; reason: string };

interface TransitionRow {
  obligation_key: string;
  session_id: string;
  source_user_seq: number;
  manifest_id: string;
  node_id: string;
  obligation: string;
  receipt_id: string;
  physical_attempt_id: string;
  logical_tool_call_id: string | null;
  physical_dispatch_id: string | null;
}

interface ReceiptAuthorityRow {
  receipt_id: string;
  protocol_version: number;
  semantic_digest: string;
  kind: 'observation' | 'collection';
  receipt_session_id: string;
  receipt_source_user_seq: number;
  receipt_accepted_task_id: string;
  manifest_id: string;
  node_id: string;
  obligation: 'source_observed' | 'source_completeness';
  receipt_logical_tool_call_id: string;
  receipt_physical_dispatch_id: string;
  receipt_result_handle_id: string;
  receipt_tool_name: string;
  operation_mode: 'point_read' | 'collection_read';
  receipt_raw_payload_sha256: string;
  receipt_raw_byte_count: number;
  record_identities_json: string;
  aggregate_digest: string;
  receipt_completeness: 'complete' | 'partial' | 'unknown';
  receipt_continuation_outstanding: number;
  receipt_cursor_repeated: number;
  receipt_event_id: string;
  mirror_session_id: string;
  mirror_type: string;
  mirror_data_json: string;
  settlement_execution_kind: string;
  settlement_outcome_kind: string;
  settlement_result_handle_id: string | null;
  settlement_crossing_count: number;
  settlement_crossings_digest: string;
  logical_accepted_task_id: string;
  logical_tool_name: string;
  logical_argument_digest: string;
  logical_state: string;
  handle_rowid: number;
  handle_id: string;
  handle_scope_kind: string;
  handle_session_id: string | null;
  handle_source_user_seq: number | null;
  handle_accepted_task_id: string | null;
  handle_logical_tool_call_id: string | null;
  handle_physical_dispatch_id: string | null;
  handle_tool_name: string;
  handle_argument_digest: string;
  continuation_chain_id: string;
  base_argument_digest: string;
  raw_location: string | null;
  raw_payload_json: string | null;
  handle_raw_payload_sha256: string | null;
  handle_raw_byte_count: number;
  rejection_reason: string | null;
  handle_success: number;
  record_path: string | null;
  record_count: number;
  envelope_meta_json: string | null;
  handle_completeness: 'complete' | 'partial' | 'unknown';
  projected_records_json: string;
  status_code: number | null;
  continuation_ref: string | null;
  cursor_bytes: Buffer | null;
  cursor_sha256: string | null;
  cursor_repeated: number;
  dispatch_state: string;
  dispatch_tool_name: string;
  dispatch_argument_digest: string;
  dispatch_ordinal: number;
  final_dispatch_ordinal: number;
  frozen_crossing_count: number;
  frozen_handle_crossing_count: number;
}

interface CrossingAuthorityRow {
  accepted_task_id?: string;
  physical_dispatch_id: string;
  ordinal: number;
  relation: 'primary' | 'retry' | 'poll' | 'probe' | 'child';
  retry_of: string | null;
  tool_name: string;
  argument_digest: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function storedJsonMatches(stored: string | null, expected: unknown): boolean {
  if (stored === null) return expected === null;
  try {
    return canonical(JSON.parse(stored) as unknown) === canonical(expected);
  } catch {
    return false;
  }
}

function storedBytesMatch(stored: Buffer | null, expected: Buffer | null): boolean {
  if (stored === null || expected === null) return stored === null && expected === null;
  const bytes = Buffer.isBuffer(stored) ? stored : Buffer.from(stored as unknown as Uint8Array);
  return bytes.equals(expected);
}

function crossingProjection(rows: readonly CrossingAuthorityRow[]): Array<{
  physicalDispatchId: string;
  ordinal: number;
  relation: CrossingAuthorityRow['relation'];
  retryOf: string | null;
  toolName: string;
  argumentDigest: string;
}> {
  return rows.map((row) => ({
    physicalDispatchId: row.physical_dispatch_id,
    ordinal: row.ordinal,
    relation: row.relation,
    retryOf: row.retry_of,
    toolName: row.tool_name,
    argumentDigest: row.argument_digest,
  }));
}

function exactCrossingAuthority(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
}): { frozen: CrossingAuthorityRow[]; live: CrossingAuthorityRow[] } {
  const params = [input.sessionId, input.sourceUserSeq, input.logicalToolCallId] as const;
  const frozen = input.db.prepare(`
    SELECT physical_dispatch_id, ordinal, relation, retry_of,
           tool_name, argument_digest
      FROM logical_call_settlement_crossings
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
     ORDER BY ordinal
  `).all(...params) as CrossingAuthorityRow[];
  const live = input.db.prepare(`
    SELECT accepted_task_id, physical_dispatch_id, ordinal, relation, retry_of,
           tool_name, argument_digest
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
     ORDER BY ordinal
  `).all(...params) as CrossingAuthorityRow[];
  return { frozen, live };
}

function recordAtPath(payload: unknown, recordPath: string | null): unknown[] | null {
  if (recordPath === null) return null;
  const value = recordPath === ''
    ? payload
    : recordPath.split('.').reduce<unknown>((current, key) => {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
      return (current as Record<string, unknown>)[key];
    }, payload);
  return Array.isArray(value) ? value : [];
}

function scalarIdentity(record: unknown): string | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const value = record as Record<string, unknown>;
  const normalized = new Map(Object.keys(value)
    .map((key) => [key.replace(/[^a-z0-9]/gi, '').toLowerCase(), key]));
  for (const candidate of ['id', 'recordid', 'uuid', 'uid', 'key', 'identifier']) {
    const key = normalized.get(candidate);
    if (!key) continue;
    const identity = value[key];
    if (
      typeof identity === 'string'
      || typeof identity === 'number'
      || typeof identity === 'boolean'
    ) return `${candidate}:${String(identity)}`;
  }
  return undefined;
}

function identities(records: readonly unknown[]): string[] {
  return records.map((record) => scalarIdentity(record) ?? `sha256:${digest(record)}`);
}

function exactReceiptAuthority(
  db: Database.Database,
  receiptId: string,
): ReceiptAuthorityRow | undefined {
  return db.prepare(`
    SELECT
      r.receipt_id, r.protocol_version, r.semantic_digest, r.kind,
      r.session_id AS receipt_session_id,
      r.source_user_seq AS receipt_source_user_seq,
      r.accepted_task_id AS receipt_accepted_task_id,
      r.manifest_id, r.node_id, r.obligation,
      r.logical_tool_call_id AS receipt_logical_tool_call_id,
      r.physical_dispatch_id AS receipt_physical_dispatch_id,
      r.result_handle_id AS receipt_result_handle_id,
      r.tool_name AS receipt_tool_name, r.operation_mode,
      r.raw_payload_sha256 AS receipt_raw_payload_sha256,
      r.raw_byte_count AS receipt_raw_byte_count,
      r.record_identities_json, r.aggregate_digest,
      r.completeness AS receipt_completeness,
      r.continuation_outstanding AS receipt_continuation_outstanding,
      r.cursor_repeated AS receipt_cursor_repeated,
      r.receipt_event_id,
      e.session_id AS mirror_session_id, e.type AS mirror_type,
      e.data_json AS mirror_data_json,
      s.execution_kind AS settlement_execution_kind,
      s.outcome_kind AS settlement_outcome_kind,
      s.result_handle_id AS settlement_result_handle_id,
      s.physical_crossing_count AS settlement_crossing_count,
      s.physical_crossings_digest AS settlement_crossings_digest,
      l.accepted_task_id AS logical_accepted_task_id,
      l.tool_name AS logical_tool_name,
      l.argument_digest AS logical_argument_digest,
      l.state AS logical_state,
      h.rowid AS handle_rowid, h.handle_id, h.scope_kind AS handle_scope_kind,
      h.session_id AS handle_session_id,
      h.source_user_seq AS handle_source_user_seq,
      h.accepted_task_id AS handle_accepted_task_id,
      h.logical_tool_call_id AS handle_logical_tool_call_id,
      h.physical_dispatch_id AS handle_physical_dispatch_id,
      h.tool_name AS handle_tool_name,
      h.argument_digest AS handle_argument_digest,
      h.continuation_chain_id, h.base_argument_digest,
      h.raw_location, h.raw_payload_json,
      h.raw_payload_sha256 AS handle_raw_payload_sha256,
      h.raw_byte_count AS handle_raw_byte_count,
      h.rejection_reason, h.success AS handle_success,
      h.record_path, h.record_count,
      h.envelope_meta_json,
      h.completeness AS handle_completeness,
      h.projected_records_json, h.status_code,
      h.continuation_ref, h.cursor_bytes, h.cursor_sha256, h.cursor_repeated,
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
    FROM evidence_receipts r
    JOIN logical_call_settlements s
      ON s.session_id = r.session_id
     AND s.source_user_seq = r.source_user_seq
     AND s.logical_tool_call_id = r.logical_tool_call_id
    JOIN logical_tool_calls l
      ON l.session_id = s.session_id
     AND l.source_user_seq = s.source_user_seq
     AND l.logical_tool_call_id = s.logical_tool_call_id
    JOIN durable_result_handles h ON h.handle_id = r.result_handle_id
    JOIN physical_dispatches p
      ON p.session_id = h.session_id
     AND p.source_user_seq = h.source_user_seq
     AND p.logical_tool_call_id = h.logical_tool_call_id
     AND p.physical_dispatch_id = h.physical_dispatch_id
    JOIN events e ON e.id = r.receipt_event_id
    WHERE r.receipt_id = ?
  `).get(receiptId) as ReceiptAuthorityRow | undefined;
}

function verifyReceipt(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  manifestId: string;
  node: ObligationManifest['nodes'][number];
  obligation: 'source_observed' | 'source_completeness';
  transition: TransitionRow;
}): TerminalPublicationProofResult {
  const row = exactReceiptAuthority(input.db, input.transition.receipt_id);
  if (!row) return { ok: false, status: 'conflict', reason: 'proof receipt has no exact normalized authority chain' };
  const expectedKind = input.obligation === 'source_observed' ? 'observation' : 'collection';
  const expectedMode = input.obligation === 'source_observed' ? 'point_read' : 'collection_read';
  if (
    row.protocol_version !== 1
    || row.kind !== expectedKind
    || row.receipt_session_id !== input.sessionId
    || row.receipt_source_user_seq !== input.sourceUserSeq
    || row.receipt_accepted_task_id !== input.acceptedTaskId
    || row.manifest_id !== input.manifestId
    || row.node_id !== input.node.nodeId
    || row.obligation !== input.obligation
    || row.operation_mode !== expectedMode
    || row.operation_mode !== input.node.operationMode
    || row.receipt_logical_tool_call_id !== input.node.operationId
    || row.receipt_tool_name !== input.node.resolvedTool
    || input.transition.physical_attempt_id !== row.receipt_physical_dispatch_id
    || (input.transition.logical_tool_call_id !== null
      && input.transition.logical_tool_call_id !== row.receipt_logical_tool_call_id)
    || (input.transition.physical_dispatch_id !== null
      && input.transition.physical_dispatch_id !== row.receipt_physical_dispatch_id)
  ) {
    return { ok: false, status: 'conflict', reason: 'proof transition and receipt identity disagree' };
  }
  if (
    row.logical_accepted_task_id !== input.acceptedTaskId
    || row.logical_state !== 'settled'
    || row.settlement_execution_kind !== 'provider_execution'
    || !['succeeded', 'empty_result'].includes(row.settlement_outcome_kind)
    || row.settlement_result_handle_id !== row.receipt_result_handle_id
    || row.settlement_result_handle_id !== row.handle_id
    || row.logical_tool_name !== row.receipt_tool_name
    || row.logical_argument_digest !== row.handle_argument_digest
    || row.handle_scope_kind !== 'authoritative'
    || row.handle_session_id !== input.sessionId
    || row.handle_source_user_seq !== input.sourceUserSeq
    || row.handle_accepted_task_id !== input.acceptedTaskId
    || row.handle_logical_tool_call_id !== row.receipt_logical_tool_call_id
    || row.handle_physical_dispatch_id !== row.receipt_physical_dispatch_id
    || row.handle_tool_name !== row.receipt_tool_name
    || row.handle_success !== 1
    || row.rejection_reason !== null
    || row.dispatch_state !== 'returned'
    || row.dispatch_tool_name !== row.receipt_tool_name
    || row.dispatch_argument_digest !== row.handle_argument_digest
    || row.dispatch_ordinal !== row.final_dispatch_ordinal
    || row.frozen_handle_crossing_count !== 1
    || row.frozen_crossing_count !== row.settlement_crossing_count
  ) {
    return { ok: false, status: 'conflict', reason: 'receipt settlement, crossing, and result handle disagree' };
  }
  const crossingAuthority = exactCrossingAuthority({
    db: input.db,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    logicalToolCallId: row.receipt_logical_tool_call_id,
  });
  const frozenCrossings = crossingProjection(crossingAuthority.frozen);
  const liveCrossings = crossingProjection(crossingAuthority.live);
  if (
    crossingAuthority.frozen.length !== row.settlement_crossing_count
    || crossingAuthority.live.length !== row.settlement_crossing_count
    || crossingAuthority.live.some((crossing) => crossing.accepted_task_id !== input.acceptedTaskId)
    || sha256Bytes(JSON.stringify(frozenCrossings)) !== row.settlement_crossings_digest
    || JSON.stringify(liveCrossings) !== JSON.stringify(frozenCrossings)
  ) {
    return { ok: false, status: 'conflict', reason: 'settlement crossing snapshot is corrupt or differs from live dispatch authority' };
  }
  if (
    row.raw_location === null
    || row.raw_payload_json === null
    || row.handle_raw_payload_sha256 === null
    || Buffer.byteLength(row.raw_payload_json, 'utf8') !== row.handle_raw_byte_count
    || sha256Bytes(row.raw_payload_json) !== row.handle_raw_payload_sha256
    || row.receipt_raw_payload_sha256 !== row.handle_raw_payload_sha256
    || row.receipt_raw_byte_count !== row.handle_raw_byte_count
  ) {
    return { ok: false, status: 'conflict', reason: 'receipt backing bytes are missing or do not match their digest' };
  }
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(row.raw_payload_json);
  } catch {
    return { ok: false, status: 'conflict', reason: 'receipt backing payload is not valid JSON' };
  }
  if (providerEnvelopeHasContradiction(rawPayload)) {
    return { ok: false, status: 'conflict', reason: 'receipt backing provider envelope is contradictory' };
  }
  const facts = deriveResultHandleFactsFromRaw(rawPayload);
  const cursorBytes = facts.cursor === null ? null : Buffer.from(facts.cursor, 'utf8');
  if (cursorBytes && cursorBytes.byteLength > MAX_DURABLE_CURSOR_BYTES) {
    return { ok: false, status: 'conflict', reason: 'receipt backing cursor exceeds the durable authority bound' };
  }
  const cursorDigest = cursorBytes ? sha256Bytes(cursorBytes) : null;
  const continuationRef = cursorDigest
    ? `cont_${sha256Bytes(`${row.handle_id}|${row.base_argument_digest}|${cursorDigest}`).slice(0, 24)}`
    : null;
  const cursorRepeated = cursorDigest !== null && Boolean(input.db.prepare(`
    SELECT 1 FROM durable_result_handles
     WHERE rowid < ?
       AND scope_kind = ?
       AND session_id IS ? AND source_user_seq IS ?
       AND continuation_chain_id = ?
       AND base_argument_digest = ? AND cursor_sha256 = ?
     LIMIT 1
  `).get(
    row.handle_rowid,
    row.handle_scope_kind,
    row.handle_session_id,
    row.handle_source_user_seq,
    row.continuation_chain_id,
    row.base_argument_digest,
    cursorDigest,
  ));
  const handleScopeSalt = [
    row.handle_session_id,
    row.handle_source_user_seq,
    row.handle_accepted_task_id,
    row.handle_logical_tool_call_id,
    row.handle_physical_dispatch_id,
    row.continuation_chain_id,
  ].join('|');
  const expectedHandleId = `rh_${sha256Bytes(
    `${handleScopeSalt}|${row.handle_argument_digest}|${row.handle_raw_payload_sha256}`,
  ).slice(0, 32)}`;
  if (
    row.handle_id !== expectedHandleId
    || row.raw_location !== `tool_output:${row.handle_id}`
    || row.handle_success !== (facts.success ? 1 : 0)
    || row.record_path !== facts.recordPath
    || row.record_count !== facts.recordCount
    || !storedJsonMatches(row.envelope_meta_json, facts.envelopeMeta)
    || row.handle_completeness !== facts.completeness
    || !storedJsonMatches(row.projected_records_json, facts.projectedRecords)
    || row.status_code !== facts.statusCode
    || !storedBytesMatch(row.cursor_bytes, cursorBytes)
    || row.cursor_sha256 !== cursorDigest
    || row.continuation_ref !== continuationRef
    || row.cursor_repeated !== (cursorRepeated ? 1 : 0)
    || row.receipt_completeness !== facts.completeness
    || row.receipt_continuation_outstanding !== (continuationRef === null ? 0 : 1)
    || row.receipt_cursor_repeated !== (cursorRepeated ? 1 : 0)
  ) {
    return { ok: false, status: 'conflict', reason: 'receipt and durable handle projections do not match their raw payload' };
  }
  const records = recordAtPath(rawPayload, facts.recordPath);
  if (records === null && expectedKind === 'collection') {
    return { ok: false, status: 'conflict', reason: 'collection proof has no durable record collection' };
  }
  const derivedIdentities = identities(records ?? []);
  let storedIdentities: unknown;
  try {
    storedIdentities = JSON.parse(row.record_identities_json);
  } catch {
    return { ok: false, status: 'conflict', reason: 'receipt record identities are unreadable' };
  }
  if (
    !Array.isArray(storedIdentities)
    || storedIdentities.some((identity) => typeof identity !== 'string')
    || JSON.stringify(storedIdentities) !== JSON.stringify(derivedIdentities)
    || JSON.stringify(storedIdentities) !== row.record_identities_json
    || (records !== null && records.length !== row.record_count)
    || row.aggregate_digest !== digest(derivedIdentities)
  ) {
    return { ok: false, status: 'conflict', reason: 'receipt record projection does not match its raw payload' };
  }
  if (expectedKind === 'collection' && (
    row.receipt_completeness !== 'complete'
    || row.handle_completeness !== 'complete'
    || row.receipt_continuation_outstanding !== 0
    || row.continuation_ref !== null
    || row.receipt_cursor_repeated !== 0
    || row.cursor_repeated !== 0
  )) {
    return { ok: false, status: 'not_ready', reason: 'collection proof is incomplete or has unsafe continuation state' };
  }
  const body = {
    protocolVersion: 1,
    kind: row.kind,
    sessionId: row.receipt_session_id,
    sourceUserSeq: row.receipt_source_user_seq,
    acceptedTaskId: row.receipt_accepted_task_id,
    manifestId: row.manifest_id,
    nodeId: row.node_id,
    obligation: row.obligation,
    logicalToolCallId: row.receipt_logical_tool_call_id,
    physicalDispatchId: row.receipt_physical_dispatch_id,
    resultHandleId: row.receipt_result_handle_id,
    toolName: row.receipt_tool_name,
    operationMode: row.operation_mode,
    rawPayloadSha256: row.receipt_raw_payload_sha256,
    rawByteCount: row.receipt_raw_byte_count,
    recordIdentities: derivedIdentities,
    aggregateDigest: row.aggregate_digest,
    completeness: row.receipt_completeness,
    continuationOutstanding: row.receipt_continuation_outstanding === 1,
    cursorRepeated: row.receipt_cursor_repeated === 1,
  };
  const semanticDigest = digest(body);
  if (
    row.semantic_digest !== semanticDigest
    || row.receipt_id !== `evidence:v1:${semanticDigest}`
    || row.mirror_session_id !== input.sessionId
    || row.mirror_type !== 'evidence_receipt'
  ) {
    return { ok: false, status: 'conflict', reason: 'normalized receipt address or mirror identity is invalid' };
  }
  try {
    const mirror = JSON.parse(row.mirror_data_json) as Record<string, unknown>;
    if (
      mirror.receiptId !== row.receipt_id
      || mirror.sourceUserSeq !== input.sourceUserSeq
      || mirror.acceptedTaskId !== input.acceptedTaskId
      || mirror.manifestId !== input.manifestId
      || mirror.nodeId !== input.node.nodeId
      || mirror.obligation !== input.obligation
      || mirror.logicalToolCallId !== row.receipt_logical_tool_call_id
      || mirror.physicalDispatchId !== row.receipt_physical_dispatch_id
      || mirror.resultHandleId !== row.receipt_result_handle_id
      || mirror.aggregateDigest !== row.aggregate_digest
      || mirror.rawPayloadSha256 !== row.receipt_raw_payload_sha256
      || mirror.recordCount !== derivedIdentities.length
    ) {
      return { ok: false, status: 'conflict', reason: 'normalized receipt mirror conflicts with its row' };
    }
  } catch {
    return { ok: false, status: 'conflict', reason: 'normalized receipt mirror is unreadable' };
  }
  return { ok: true };
}

/** Verify every declared obligation and reject every undeclared transition. */
export function verifyAcceptedTaskTerminalProofInTransaction(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  manifest: ObligationManifest;
}): TerminalPublicationProofResult {
  try {
    const transitions = input.db.prepare(`
      SELECT obligation_key, session_id, source_user_seq, manifest_id, node_id,
             obligation, receipt_id, physical_attempt_id,
             logical_tool_call_id, physical_dispatch_id
        FROM obligation_transitions
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY obligation_key
    `).all(input.sessionId, input.sourceUserSeq) as TransitionRow[];
    const declared = input.manifest.nodes.flatMap((node) => node.obligations
      .map((obligation) => ({ node, obligation })));
    if (transitions.some((transition) => transition.manifest_id !== input.manifest.manifestId)) {
      return { ok: false, status: 'conflict', reason: 'proof transition names another manifest' };
    }
    if (transitions.length > declared.length) {
      return { ok: false, status: 'conflict', reason: 'duplicate or undeclared proof transitions exist' };
    }
    if (transitions.length < declared.length) {
      return { ok: false, status: 'not_ready', reason: 'one or more declared obligations are unsatisfied' };
    }
    for (const entry of declared) {
      if (
        entry.node.effectKind !== 'read'
        || !['point_read', 'collection_read'].includes(entry.node.operationMode)
        || (entry.obligation !== 'source_observed' && entry.obligation !== 'source_completeness')
      ) {
        return {
          ok: false,
          status: 'not_ready',
          reason: `obligation ${entry.node.nodeId}:${entry.obligation} has no normalized terminal verifier`,
        };
      }
      const matches = transitions.filter((transition) =>
        transition.node_id === entry.node.nodeId
        && transition.obligation === entry.obligation);
      if (matches.length === 0) {
        return { ok: false, status: 'not_ready', reason: `unsatisfied obligation ${entry.node.nodeId}:${entry.obligation}` };
      }
      if (matches.length !== 1) {
        return { ok: false, status: 'conflict', reason: `ambiguous proof for ${entry.node.nodeId}:${entry.obligation}` };
      }
      const transition = matches[0]!;
      const expectedKey = [
        input.sessionId,
        input.sourceUserSeq,
        input.manifest.manifestId,
        entry.node.nodeId,
        entry.obligation,
      ].join('|');
      if (
        transition.obligation_key !== expectedKey
        || transition.session_id !== input.sessionId
        || transition.source_user_seq !== input.sourceUserSeq
      ) {
        return { ok: false, status: 'conflict', reason: 'proof transition key or task identity is invalid' };
      }
      const receipt = verifyReceipt({
        db: input.db,
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: input.acceptedTaskId,
        manifestId: input.manifest.manifestId,
        node: entry.node,
        obligation: entry.obligation,
        transition,
      });
      if (!receipt.ok) return receipt;
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      status: 'unreadable',
      reason: String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 240),
    };
  }
}
