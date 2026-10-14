import type Database from 'better-sqlite3';
import { openEventLog } from './eventlog.js';
import { loadHostCallCapabilityBinding } from './host-call-capability-binding.js';
import { parseResolvedCallAuthority } from './resolved-call-authority.js';

/** A source-local write freeze is a fact about exact unsettled calls, not a
 * tool name, model instruction, successful read or elapsed time. Reading and
 * explaining remain available; this inventory never authorizes a retry. */
export interface PendingUnacknowledgedWrite {
  logicalToolCallId: string;
  toolName: string;
  acceptedTaskId: string;
  effect: 'external_write' | 'admin';
  accountId: string;
  authorityDigest: string;
  physicalDispatchIds: string[];
}

export interface ResolvedUnacknowledgedWrite extends PendingUnacknowledgedWrite {
  resolution: 'present' | 'absent';
  reservationEventId: string;
  terminalEventId: string;
}

export type PendingUnacknowledgedWrites =
  | { status: 'ok'; pending: PendingUnacknowledgedWrite[]; resolved: ResolvedUnacknowledgedWrite[] }
  | { status: 'unavailable'; reason: 'unacknowledged_write_inventory_unavailable' };

interface UnknownCallRow {
  logical_tool_call_id: string;
  accepted_task_id: string | null;
  tool_name: string | null;
  argument_digest: string | null;
  state: string | null;
}

interface CrossingRow {
  physical_dispatch_id: string;
  accepted_task_id: string;
  tool_name: string;
  argument_digest: string;
  state: string;
  ordinal: number;
  relation: string;
  authority_digest: string | null;
  provider_argument_digest: string | null;
}

interface WriteEvent {
  id: string;
  type: string;
  parent_event_id: string | null;
  role: string;
  data: Record<string, unknown>;
}

const unavailable = (): PendingUnacknowledgedWrites => ({
  status: 'unavailable', reason: 'unacknowledged_write_inventory_unavailable',
});

/** The typed graph lane predates host-v1 capability bindings. Reopen only its
 * original sealed physical authority to distinguish a local write; a current
 * tool spelling/catalog/argument shape cannot downgrade an external effect.
 * Parsing verifies the canonical authority digest, and every crossing must
 * agree with its exact admitted call and sealed request digests. This proves
 * classification only, never that a write landed or may be replayed. */
function originalTypedLocalWrite(input: {
  database: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  row: UnknownCallRow;
  crossings: readonly CrossingRow[];
}): boolean {
  if (input.row.state !== 'settled' || input.crossings.length === 0) return false;
  return input.crossings.every(crossing => {
    const sealed = input.database.prepare(`SELECT authority_digest, provider_argument_digest, sealed_json
      FROM main.physical_dispatch_authority_sealed
      WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?`).get(
      input.sessionId, input.sourceUserSeq, crossing.physical_dispatch_id) as {
        authority_digest: string; provider_argument_digest: string; sealed_json: string;
      } | undefined;
    if (!sealed) return false;
    const parsed = parseResolvedCallAuthority(sealed.sealed_json);
    if (!parsed.ok) return false;
    const authority = parsed.authority;
    return authority.resolvedEffect === 'local_write'
      && authority.acceptedSource.sessionId === input.sessionId
      && authority.acceptedSource.sourceUserSeq === input.sourceUserSeq
      && authority.acceptedTaskId === input.row.accepted_task_id
      && authority.acceptedTaskId === crossing.accepted_task_id
      && authority.logicalCallId === input.row.logical_tool_call_id
      && authority.physicalDispatchId === crossing.physical_dispatch_id
      && authority.ordinal === crossing.ordinal && authority.relation === crossing.relation
      && authority.operationId === input.row.tool_name && authority.operationId === crossing.tool_name
      && authority.logicalArgumentDigest === input.row.argument_digest
      && authority.logicalArgumentDigest === crossing.argument_digest
      && authority.authorityDigest === sealed.authority_digest
      && authority.authorityDigest === crossing.authority_digest
      && authority.canonicalArgumentDigest === sealed.provider_argument_digest
      && authority.canonicalArgumentDigest === crossing.provider_argument_digest;
  });
}

function callId(data: Record<string, unknown>): unknown {
  return data.canonicalCallId ?? data.callId;
}

/** Consume only the already-decided exact write ledger. In particular the
 * generic execution_reconcile_write and artifact-claim producers have not
 * sealed an account/target readback contract; their matching is not upgraded
 * by this reader.
 * A later read, compute, model verdict or similarly named write is irrelevant.
 * No new resource, target or proof is inferred here. */
function exactResolution(input: {
  sourceUserSeq: number;
  write: PendingUnacknowledgedWrite;
  crossings: readonly CrossingRow[];
  events: readonly WriteEvent[];
}): ResolvedUnacknowledgedWrite | undefined {
  const { write, events } = input;
  if (input.crossings.some(row => row.state !== 'returned' && row.state !== 'threw')) return undefined;
  const reservations = events.filter(event => event.type === 'external_write'
    && event.role === 'system'
    && event.data.preDispatch === true
    && event.data.sourceUserSeq === input.sourceUserSeq
    && event.data.acceptedTaskId === write.acceptedTaskId
    && callId(event.data) === write.logicalToolCallId);
  if (reservations.length !== 1) return undefined;
  const reservation = reservations[0]!;
  const physicalId = reservation.data.physicalDispatchId;
  if (typeof physicalId !== 'string' || !write.physicalDispatchIds.includes(physicalId)
    || (reservation.data.accountId !== undefined && reservation.data.accountId !== write.accountId)
    || typeof reservation.data.projectionKey !== 'string'
    || !reservation.data.projectionKey.startsWith('external-write-reservation:')) return undefined;
  const terminals = events.filter(event => event.parent_event_id === reservation.id
    && (event.type === 'external_write_succeeded' || event.type === 'external_write_failed'));
  // A conflict is never "latest wins". The producer's decisive CAS makes one
  // terminal normal; malformed or duplicate historical terminals stay held.
  if (terminals.length !== 1) return undefined;
  const terminal = terminals[0]!;
  if (terminal.role !== 'system'
    || terminal.data.reconciledBy === 'execution_reconcile_write'
    || terminal.data.reconciledBy === 'artifact_ledger'
    || (terminal.data.accountId !== undefined && terminal.data.accountId !== write.accountId)
    || terminal.data.sourceUserSeq !== input.sourceUserSeq
    || terminal.data.acceptedTaskId !== write.acceptedTaskId
    || callId(terminal.data) !== write.logicalToolCallId
    || terminal.data.physicalDispatchId !== physicalId
    || terminal.data.decisiveProjectionKey !== `external-write-decisive:${reservation.id}`
    || terminal.data.actionKey !== reservation.data.actionKey
    || terminal.data.toolName !== reservation.data.toolName
    || terminal.data.correlationFingerprint !== reservation.data.correlationFingerprint
    || terminal.data.semanticFingerprint !== reservation.data.semanticFingerprint) return undefined;
  return { ...write,
    resolution: terminal.type === 'external_write_succeeded' ? 'present' : 'absent',
    reservationEventId: reservation.id, terminalEventId: terminal.id };
}

/** Reopened on every call, including after recovery/restart. Only the requested
 * accepted source is inspected. Missing/conflicted binding or unavailable
 * storage is a hold, never an empty inventory that opens the write boundary. */
export function readPendingUnacknowledgedWritesForSource(input: {
  sessionId: string;
  sourceUserSeq: number;
}, suppliedDatabase?: Database.Database): PendingUnacknowledgedWrites {
  if (!input.sessionId.trim() || input.sessionId !== input.sessionId.trim()
    || !Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 0) return unavailable();
  try {
    const database = suppliedDatabase ?? openEventLog();
    const read = (): PendingUnacknowledgedWrites => {
      // The binding reader predates main-qualified SQL. Refuse temporary
      // shadows rather than allowing them to manufacture authority for it.
      if (database.prepare(`SELECT 1 FROM sqlite_temp_master WHERE type IN ('table', 'view')
        AND name IN ('events', 'accepted_turn_call_authorities', 'logical_tool_calls',
          'host_call_capability_bindings', 'physical_dispatches', 'physical_dispatch_authority_sealed',
          'logical_call_settlements') LIMIT 1`).get()) return unavailable();
      const source = database.prepare(`SELECT role, type FROM main.events
        WHERE session_id = ? AND seq = ?`).get(input.sessionId, input.sourceUserSeq) as { role: string; type: string } | undefined;
      if (!source || !((source.role === 'user' && source.type === 'user_input_received')
        || (source.role === 'system' && ['workflow_node_invocation_activated', 'workflow_paginated_read_activated'].includes(source.type)))) return unavailable();
      const calls = database.prepare(`
        SELECT s.logical_tool_call_id, l.accepted_task_id, l.tool_name, l.argument_digest, l.state
          FROM main.logical_call_settlements s
          LEFT JOIN main.logical_tool_calls l ON l.session_id = s.session_id
           AND l.source_user_seq = s.source_user_seq AND l.logical_tool_call_id = s.logical_tool_call_id
         WHERE s.session_id = ? AND s.source_user_seq = ? AND s.mutating = 1
           AND s.outcome_kind = 'uncertain_write' AND s.outcome_detail = 'unacknowledged_mutation'
         ORDER BY s.logical_tool_call_id
      `).all(input.sessionId, input.sourceUserSeq) as UnknownCallRow[];
      if (calls.length === 0) return { status: 'ok', pending: [], resolved: [] };
      const pending: PendingUnacknowledgedWrite[] = [];
      const resolved: ResolvedUnacknowledgedWrite[] = [];
      const eventRows = database.prepare(`SELECT id, type, parent_event_id, role, data_json
        FROM main.events WHERE session_id = ? AND type IN
        ('external_write', 'external_write_succeeded', 'external_write_failed') ORDER BY seq`).all(input.sessionId) as Array<{
          id: string; type: string; parent_event_id: string | null; role: string; data_json: string;
        }>;
      const events = eventRows.map(row => {
        const data: unknown = JSON.parse(row.data_json);
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid write ledger');
        return { ...row, data: data as Record<string, unknown> };
      });
      for (const row of calls) {
        const crossings = database.prepare(`SELECT physical_dispatch_id, accepted_task_id, tool_name,
            argument_digest, state, ordinal, relation, authority_digest, provider_argument_digest
          FROM main.physical_dispatches WHERE session_id = ? AND source_user_seq = ?
            AND logical_tool_call_id = ? ORDER BY ordinal, physical_dispatch_id`).all(
          input.sessionId, input.sourceUserSeq, row.logical_tool_call_id) as CrossingRow[];
        const loaded = loadHostCallCapabilityBinding({ db: database, ...input,
          logicalToolCallId: row.logical_tool_call_id });
        if (loaded.status !== 'ok') {
          if (loaded.status === 'missing' && originalTypedLocalWrite({ database, ...input, row, crossings })) continue;
          return unavailable();
        }
        const binding = loaded.binding;
        if (row.state !== 'settled' || row.accepted_task_id !== binding.acceptedTaskId
          || row.tool_name !== binding.toolName || row.argument_digest !== binding.effectiveArgumentDigest) return unavailable();
        if (binding.effect !== 'external_write' && binding.effect !== 'admin') continue;
        if (crossings.length === 0 || crossings.some(crossing => crossing.accepted_task_id !== binding.acceptedTaskId
          || crossing.tool_name !== binding.toolName || crossing.argument_digest !== binding.effectiveArgumentDigest)) return unavailable();
        const write: PendingUnacknowledgedWrite = {
          logicalToolCallId: binding.logicalToolCallId, toolName: binding.toolName,
          acceptedTaskId: binding.acceptedTaskId, effect: binding.effect,
          accountId: binding.accountId, authorityDigest: binding.authorityDigest,
          physicalDispatchIds: crossings.map(crossing => crossing.physical_dispatch_id),
        };
        const resolution = exactResolution({ sourceUserSeq: input.sourceUserSeq, write, crossings, events });
        if (resolution) resolved.push(resolution);
        else pending.push(write);
      }
      return { status: 'ok', pending, resolved };
    };
    return database.inTransaction ? read() : database.transaction(read)();
  } catch { return unavailable(); }
}
