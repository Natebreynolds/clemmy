import { createHash } from 'node:crypto';
import type { AgentInputItem } from '@openai/agents';
import { openEventLog } from './eventlog.js';
import {
  ConversationProtocolMigrationError,
  CONVERSATION_PROTOCOL_SYNTHETIC_RESULT,
  conversationProtocolItemBytesSha256,
  inspectConversationProtocol,
  migratePersistedConversationProtocol,
  type ConversationMigration,
  type MigrationEvidence,
  type ProtocolIssueCode,
} from './conversation-protocol.js';
import { redeemDurableLogicalCallSettlementForHost } from './logical-call-settlement-store.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';

const META_CONVERSATION = '__conversation';
const META_INTERRUPT = '__interrupt_state';
const META_QUARANTINE = '__conversation_protocol_quarantine';
const QUARANTINE_PROTOCOL = 'clementine.conversation_protocol_quarantine.v1' as const;

type HarnessDb = ReturnType<typeof openEventLog>;
type ItemRecord = Record<string, unknown>;

interface ConversationSnapshot {
  items: AgentInputItem[];
  lastResponseId?: string;
  updatedAt: string;
}

interface LogicalIdentityRow {
  source_user_seq: number;
  accepted_task_id: string;
  logical_tool_call_id: string;
  state: 'open' | 'settled' | 'conflict';
}

interface PhysicalRow {
  physical_dispatch_id: string;
  ordinal: number;
  state: 'started' | 'returned' | 'threw' | 'timed_out' | 'cancelled' | 'unknown';
}

export interface ConversationProtocolQuarantineRecord {
  protocol: typeof QUARANTINE_PROTOCOL;
  quarantinedAt: string;
  snapshotUpdatedAt: string;
  issues: ProtocolIssueCode[];
  originalItems: AgentInputItem[];
}

export type PreparedProviderConversation =
  | {
      status: 'ready';
      disposition: 'ready';
      migration: ConversationMigration['migration'];
      history: AgentInputItem[];
      providerHistory: AgentInputItem[];
      quarantine?: ConversationMigration['quarantine'];
    }
  | {
      status: 'held';
      disposition: 'pending_approval' | 'reconciliation_required' | 'evidence_unavailable';
      migration: ConversationMigration['migration'] | 'none';
      history: AgentInputItem[];
      providerHistory: null;
      reason: string;
    };

function record(value: unknown): ItemRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ItemRecord
    : null;
}

function parseMetadata(raw: string): ItemRecord {
  const parsed = JSON.parse(raw) as unknown;
  const metadata = record(parsed);
  if (!metadata) throw new Error('session metadata is not a JSON object');
  return metadata;
}

function snapshotFromMetadata(metadata: ItemRecord, createdAt: string): ConversationSnapshot {
  const raw = record(metadata[META_CONVERSATION]);
  return {
    items: Array.isArray(raw?.items) ? raw.items as AgentInputItem[] : [],
    ...(typeof raw?.lastResponseId === 'string' ? { lastResponseId: raw.lastResponseId } : {}),
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : createdAt,
  };
}

function itemField(item: AgentInputItem, field: string): unknown {
  return (item as unknown as ItemRecord)[field];
}

function callItemFor(history: readonly AgentInputItem[], callId: string): AgentInputItem | undefined {
  return history.find((item) => (
    itemField(item, 'type') === 'function_call' && itemField(item, 'callId') === callId
  ));
}

function pendingHostInterruptCallIds(metadata: ItemRecord): string[] {
  const blob = metadata[META_INTERRUPT];
  if (typeof blob !== 'string' || !blob.trimStart().startsWith('{')) return [];
  try {
    const parsed = record(JSON.parse(blob) as unknown);
    if (!parsed || !Array.isArray(parsed.pending)) return [];
    const ids: string[] = [];
    for (const value of parsed.pending) {
      const pending = record(value);
      const rawItem = record(pending?.rawItem);
      const callId = typeof pending?.callId === 'string' ? pending.callId : undefined;
      if (
        callId
        && pending?.decision === undefined
        && rawItem?.callId === callId
        && rawItem?.name === pending?.name
      ) ids.push(callId);
    }
    return ids;
  } catch {
    return [];
  }
}

function sessionHasPendingApproval(db: HarnessDb, sessionId: string, metadata: ItemRecord): boolean {
  if (pendingHostInterruptCallIds(metadata).length > 0) return true;
  const row = db.prepare(`
    SELECT 1 FROM pending_approvals
     WHERE session_id = ? AND status = 'pending'
     LIMIT 1
  `).get(sessionId);
  return Boolean(row);
}

function logicalIdentitiesForCall(
  db: HarnessDb,
  sessionId: string,
  callId: string,
): LogicalIdentityRow[] {
  return db.prepare(`
    SELECT DISTINCT l.source_user_seq, l.accepted_task_id,
           l.logical_tool_call_id, l.state
      FROM logical_tool_calls l
      LEFT JOIN logical_call_settlements s
        ON s.session_id = l.session_id
       AND s.source_user_seq = l.source_user_seq
       AND s.logical_tool_call_id = l.logical_tool_call_id
     WHERE l.session_id = ?
       AND (l.logical_tool_call_id = ? OR s.observer_call_id = ?)
     ORDER BY l.source_user_seq, l.logical_tool_call_id
  `).all(sessionId, callId, callId) as LogicalIdentityRow[];
}

function physicalRowsForIdentity(
  db: HarnessDb,
  sessionId: string,
  identity: LogicalIdentityRow,
): PhysicalRow[] {
  return db.prepare(`
    SELECT physical_dispatch_id, ordinal, state
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
     ORDER BY ordinal
  `).all(
    sessionId,
    identity.source_user_seq,
    identity.logical_tool_call_id,
  ) as PhysicalRow[];
}

function crossingEvidence(rows: readonly PhysicalRow[]): MigrationEvidence | undefined {
  const last = rows.at(-1);
  if (!last) return undefined;
  return {
    kind: 'physical_crossing_unreadable',
    physicalDispatchId: last.physical_dispatch_id,
    state: last.state === 'started' || last.state === 'timed_out'
      ? last.state
      : 'unknown',
  };
}

function resultText(rawPayload: unknown, rawPayloadJson: string): string {
  return typeof rawPayload === 'string' ? rawPayload : rawPayloadJson;
}

function settledResultItem(
  call: AgentInputItem,
  rawPayload: unknown,
  rawPayloadJson: string,
): AgentInputItem {
  const callId = itemField(call, 'callId');
  const name = itemField(call, 'name');
  const namespace = itemField(call, 'namespace');
  return {
    type: 'function_call_result',
    callId,
    name,
    ...(typeof namespace === 'string' ? { namespace } : {}),
    output: { type: 'text', text: resultText(rawPayload, rawPayloadJson) },
    status: 'completed',
  } as AgentInputItem;
}

function exactEvidenceForCall(input: {
  db: HarnessDb;
  sessionId: string;
  history: readonly AgentInputItem[];
  callId: string;
}): MigrationEvidence | undefined {
  const identities = logicalIdentitiesForCall(input.db, input.sessionId, input.callId);
  if (identities.length !== 1) return undefined;
  const identity = identities[0]!;
  const crossings = physicalRowsForIdentity(input.db, input.sessionId, identity);
  if (identity.state !== 'settled') {
    if (identity.state === 'open' && crossings.length === 0) {
      return {
        kind: 'proven_no_crossing',
        executionKind: 'not_started',
        physicalDispatchCount: 0,
      };
    }
    return crossingEvidence(crossings);
  }

  const durableIdentity = {
    sessionId: input.sessionId,
    sourceUserSeq: identity.source_user_seq,
    acceptedTaskId: identity.accepted_task_id,
    logicalToolCallId: identity.logical_tool_call_id,
  };
  const settlement = redeemDurableLogicalCallSettlementForHost(durableIdentity);
  if (settlement.status !== 'ok') return crossingEvidence(crossings);
  if (
    settlement.settlement.executionKind === 'refused_pre_dispatch'
    && settlement.settlement.physicalCrossingCount === 0
    && settlement.settlement.hostCrossingCount === 0
  ) {
    return {
      kind: 'proven_no_crossing',
      executionKind: 'refused_pre_dispatch',
      physicalDispatchCount: 0,
    };
  }

  const call = callItemFor(input.history, input.callId);
  if (!call) return crossingEvidence(crossings);
  const redeemed = redeemSuccessfulSettlementResultForHost(durableIdentity);
  if (redeemed.status !== 'ok') return crossingEvidence(crossings);
  const result = settledResultItem(
    call,
    redeemed.value.rawPayload,
    redeemed.value.rawPayloadJson,
  );
  return {
    kind: 'settled_result',
    result,
    resultBytesSha256: conversationProtocolItemBytesSha256(result),
  };
}

/**
 * Reopen the existing durable conversation-protocol evidence for one exact
 * call.  Mid-turn checkpoint recovery uses this same projector rather than
 * maintaining a second settlement/result-handle interpretation.
 *
 * `undefined` is intentionally meaningful: callers may only supplement it
 * when they own stronger durable evidence (for example, an append-only model
 * batch admission proving a sibling never reached logical admission).
 */
export function durableConversationProtocolEvidenceForCall(input: {
  db?: HarnessDb;
  sessionId: string;
  history: readonly AgentInputItem[];
  callId: string;
}): MigrationEvidence | undefined {
  return exactEvidenceForCall({
    db: input.db ?? openEventLog(),
    sessionId: input.sessionId,
    history: input.history,
    callId: input.callId,
  });
}

function isEffectUnknownSynthetic(item: AgentInputItem): boolean {
  if (itemField(item, 'type') !== 'function_call_result') return false;
  const output = record(itemField(item, 'output'));
  if (output?.type !== 'text' || typeof output.text !== 'string') return false;
  try {
    const payload = record(JSON.parse(output.text) as unknown);
    return payload?.protocol === CONVERSATION_PROTOCOL_SYNTHETIC_RESULT
      && payload.disposition === 'effect_unknown';
  } catch {
    return false;
  }
}

function evidenceForHistory(
  db: HarnessDb,
  sessionId: string,
  history: readonly AgentInputItem[],
): Record<string, MigrationEvidence> {
  const inspection = inspectConversationProtocol(history);
  const evidence: Record<string, MigrationEvidence> = {};
  const issueCallIds = new Set(inspection.issues
    .map((issue) => issue.callId)
    .filter((callId): callId is string => typeof callId === 'string'));

  for (const issue of inspection.issues) {
    if (!issue.callId) continue;
    if (issue.code === 'duplicate_function_call_id') {
      evidence[issue.callId] = { kind: 'ambiguous', reason: 'reused_call_id' };
    } else if (issue.code === 'orphan_function_result') {
      evidence[issue.callId] = { kind: 'ambiguous', reason: 'orphan_result' };
    }
  }
  for (const item of history) {
    if (!isEffectUnknownSynthetic(item)) continue;
    const callId = itemField(item, 'callId');
    if (typeof callId === 'string') issueCallIds.add(callId);
  }
  for (const callId of issueCallIds) {
    if (evidence[callId]?.kind === 'ambiguous') continue;
    const exact = exactEvidenceForCall({ db, sessionId, history, callId });
    if (exact) evidence[callId] = exact;
  }
  return evidence;
}

function appendQuarantine(
  metadata: ItemRecord,
  recordValue: ConversationProtocolQuarantineRecord,
): void {
  const existing = metadata[META_QUARANTINE];
  metadata[META_QUARANTINE] = Array.isArray(existing)
    ? [...existing, recordValue]
    : existing === undefined
      ? [recordValue]
      : [existing, recordValue];
}

function exactJson(value: unknown): string {
  return JSON.stringify(value);
}

function held(
  history: AgentInputItem[],
  disposition: Extract<PreparedProviderConversation, { status: 'held' }>['disposition'],
  reason: string,
  migration: ConversationMigration['migration'] | 'none' = 'none',
): PreparedProviderConversation {
  return {
    status: 'held',
    disposition,
    migration,
    history,
    providerHistory: null,
    reason,
  };
}

/**
 * Reconcile one persisted conversation under the eventlog's IMMEDIATE writer
 * transaction. Durable evidence is re-read inside the same transaction; only
 * a ready projection is returned to the caller. No schema or event type is
 * introduced.
 */
function projectPersistedSessionConversationProtocol(input: {
  sessionId: string;
  now?: () => string;
  persistChanges: boolean;
  db?: HarnessDb;
  transactionMode?: 'deferred' | 'immediate' | 'none';
}): PreparedProviderConversation {
  const db = input.db ?? openEventLog();
  const project = (): PreparedProviderConversation => {
    const row = db.prepare(`
      SELECT created_at, metadata_json FROM sessions WHERE id = ?
    `).get(input.sessionId) as { created_at: string; metadata_json: string } | undefined;
    if (!row) throw new Error(`session not found: ${input.sessionId}`);
    const metadata = parseMetadata(row.metadata_json);
    const snapshot = snapshotFromMetadata(metadata, row.created_at);

    // Approval ownership is independent of whether the pre-pause SDK/host
    // history was copied into __conversation. Never start a second provider
    // turn over an unresolved durable approval.
    if (sessionHasPendingApproval(db, input.sessionId, metadata)) {
      return held(snapshot.items, 'pending_approval', 'durable approval remains pending');
    }

    const evidenceByCallId = evidenceForHistory(db, input.sessionId, snapshot.items);
    let migrated: ConversationMigration;
    try {
      migrated = migratePersistedConversationProtocol({
        history: snapshot.items,
        evidenceByCallId,
      });
    } catch (error) {
      if (error instanceof ConversationProtocolMigrationError) {
        return held(snapshot.items, 'evidence_unavailable', error.code);
      }
      throw error;
    }

    if (migrated.disposition === 'pending_approval') {
      return held(migrated.history, 'pending_approval', 'durable approval remains pending', migrated.migration);
    }

    const historyChanged = exactJson(migrated.history) !== exactJson(snapshot.items);
    if (historyChanged && input.persistChanges) {
      const now = input.now?.() ?? new Date().toISOString();
      const nextMetadata: ItemRecord = { ...metadata };
      nextMetadata[META_CONVERSATION] = {
        items: migrated.history,
        // A repaired/truncated transcript cannot continue a provider-owned
        // previous-response chain whose hidden history predates the repair.
        updatedAt: now,
      } satisfies ConversationSnapshot;
      if (migrated.quarantine) {
        appendQuarantine(nextMetadata, {
          protocol: QUARANTINE_PROTOCOL,
          quarantinedAt: now,
          snapshotUpdatedAt: snapshot.updatedAt,
          issues: migrated.quarantine.issues,
          originalItems: migrated.quarantine.originalItems,
        });
      }
      const updated = db.prepare(`
        UPDATE sessions
           SET metadata_json = ?, updated_at = ?
         WHERE id = ? AND metadata_json = ?
      `).run(JSON.stringify(nextMetadata), now, input.sessionId, row.metadata_json);
      if (updated.changes !== 1) {
        throw new Error('conversation protocol session compare-and-swap lost');
      }
    }

    if (migrated.disposition === 'reconciliation_required') {
      return held(
        migrated.history,
        'reconciliation_required',
        'physical effect requires durable reconciliation',
        migrated.migration,
      );
    }
    if (!migrated.providerHistory) {
      return held(migrated.history, 'evidence_unavailable', 'ready migration omitted provider history', migrated.migration);
    }
    const finalInspection = inspectConversationProtocol(migrated.providerHistory);
    if (finalInspection.status !== 'valid') {
      return held(migrated.history, 'evidence_unavailable', 'ready provider history failed final assertion', migrated.migration);
    }
    return {
      status: 'ready',
      disposition: 'ready',
      migration: migrated.migration,
      history: migrated.history,
      providerHistory: migrated.providerHistory,
      ...(migrated.quarantine ? { quarantine: migrated.quarantine } : {}),
    };
  };

  try {
    if (input.transactionMode === 'none') return project();
    const transact = db.transaction(project);
    return input.transactionMode === 'deferred'
      ? transact.deferred()
      : transact.immediate();
  } catch (error) {
    if (input.transactionMode === 'none') throw error;
    // Storage uncertainty is an internal hold, never permission to project an
    // uninspected transcript and never provider-facing prose.
    return held(
      [],
      'evidence_unavailable',
      error instanceof Error ? error.name : 'conversation_protocol_storage_error',
    );
  }
}

/**
 * Read-only projection used before a fresh external source is accepted.
 *
 * The evidence and migration decision are computed under one deferred read
 * transaction, and no repaired/quarantined bytes are ever written. Callers may
 * therefore decide that a source needs a clean successor without changing the
 * older source whose recovery state they inspected or reserving the writer.
 */
export function previewPersistedSessionConversationProtocol(input: {
  sessionId: string;
  now?: () => string;
}): PreparedProviderConversation {
  return projectPersistedSessionConversationProtocol({
    ...input,
    persistChanges: false,
    transactionMode: 'deferred',
  });
}

/** Same read-only projector when the caller already owns the SQLite snapshot. */
export function previewPersistedSessionConversationProtocolInTransaction(input: {
  db: HarnessDb;
  sessionId: string;
  now?: () => string;
}): PreparedProviderConversation {
  return projectPersistedSessionConversationProtocol({
    ...input,
    persistChanges: false,
    transactionMode: 'none',
  });
}

/**
 * Provider boundary used by runTurn. Unlike the ingress preview, this may
 * durably repair/quarantine a historical snapshot before model replay.
 */
export function preparePersistedSessionConversationProtocol(input: {
  sessionId: string;
  now?: () => string;
}): PreparedProviderConversation {
  return projectPersistedSessionConversationProtocol({
    ...input,
    persistChanges: true,
    transactionMode: 'immediate',
  });
}

export function conversationProtocolQuarantineDigest(
  recordValue: ConversationProtocolQuarantineRecord,
): string {
  return createHash('sha256').update(JSON.stringify(recordValue)).digest('hex');
}
