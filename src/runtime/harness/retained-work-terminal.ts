import { openEventLog } from './eventlog.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import { RETAINED_WORK_TERMINAL_HEADER } from './retained-work-checkpoint.js';

/**
 * Host-authored retained-work disclosure for an incomplete terminal.
 *
 * This projection never reads model prose or guesses from tool names. A result
 * appears only after the immutable logical settlement can redeem its exact raw
 * result handle. External-write state comes from the same normalized settlement
 * rows and their frozen non-host crossing counts.
 */

export { RETAINED_WORK_TERMINAL_HEADER };

export type RetainedExternalWriteState =
  | 'not_recorded'
  | 'succeeded'
  | 'failed'
  | 'mixed'
  | 'uncertain'
  /** The app refused the write in its own reply; nothing reruns on its own. */
  | 'refused';

export interface RetainedWorkItem {
  toolName: string;
  logicalToolCallId: string;
  resultHandleId: string;
  recordCount?: number;
  completeness?: 'complete' | 'partial' | 'unknown';
}

/**
 * One effect that settled under an accepted source: a mutating logical call
 * the ledger closed as succeeded (with the receipt its tool returned), or a
 * file the runtime saw land. A fact, never a result to reopen or re-run.
 */
export type LandedWrite =
  | {
      kind: 'settled_write';
      acceptedTaskId: string;
      logicalToolCallId: string;
      toolName: string;
      argumentDigest: string;
      settlementEventId: string;
      settlementSeq: number;
      outcomeKind: 'succeeded' | 'empty_result';
      physicalCrossingCount: number;
      resultHandleId: string | null;
      /** The tool's own returned receipt, bounded; null when none was retained. */
      receipt: string | null;
    }
  | {
      kind: 'saved_file';
      eventId: string;
      seq: number;
      name: string;
      dir: string;
      bytes: number;
    };

export interface RetainedWorkInventory {
  items: RetainedWorkItem[];
  landedWrites: LandedWrite[];
  downstreamWriteState: RetainedExternalWriteState;
  downstreamWriteTools: string[];
}

interface SettlementInventoryRow {
  accepted_task_id: string;
  logical_tool_call_id: string;
  tool_name: string;
  outcome_kind: string;
  outcome_detail: string | null;
  business_call: number;
  mutating: number;
  physical_crossing_count: number;
  requires_reconciliation: number;
  result_handle_id: string | null;
  settled_at: string;
}

function boundedIdentity(value: string, max = 120): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const LANDED_RECEIPT_MAX_CHARS = 200;
const LANDED_WRITES_MAX = 8;

/** The receipt a write's tool returned, as bounded text: a string payload as
 * written, anything else as its JSON. Data from the ledger, never a sentence. */
function boundedReceipt(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null;
  const text = boundedIdentity(typeof payload === 'string' ? payload : JSON.stringify(payload), Number.MAX_SAFE_INTEGER);
  if (!text) return null;
  const codepoints = [...text];
  return codepoints.length > LANDED_RECEIPT_MAX_CHARS ? `${codepoints.slice(0, LANDED_RECEIPT_MAX_CHARS).join('')}…` : text;
}

/**
 * The effects that settled under one accepted source, read from the ledger
 * alone: every mutating business call the settlement store closed as a
 * success with nothing left to reconcile, in settlement order, plus every
 * file the runtime recorded landing for that source. Tool names come from the
 * rows. `beforeSeq` bounds both to events before a terminal.
 */
export function landedWritesForAcceptedSource(input: {
  sessionId: string;
  sourceUserSeq: number;
  beforeSeq?: number;
}): LandedWrite[] {
  if (!input.sessionId.trim() || !Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 0) return [];
  try {
    const db = openEventLog();
    const bound = Number.isSafeInteger(input.beforeSeq) ? Number(input.beforeSeq) : Number.MAX_SAFE_INTEGER;
    const settled = db.prepare(`
      SELECT l.accepted_task_id, l.logical_tool_call_id, l.tool_name, l.argument_digest,
             s.outcome_kind, s.physical_crossing_count, s.result_handle_id, s.settlement_event_id,
             e.seq AS settlement_seq
        FROM logical_call_settlements s
        JOIN logical_tool_calls l
          ON l.session_id = s.session_id
         AND l.source_user_seq = s.source_user_seq
         AND l.logical_tool_call_id = s.logical_tool_call_id
        JOIN events e ON e.id = s.settlement_event_id
       WHERE s.session_id = ? AND s.source_user_seq = ?
         AND s.business_call = 1 AND s.mutating = 1 AND s.requires_reconciliation = 0
         AND s.outcome_kind IN ('succeeded', 'empty_result')
         AND e.seq < ?
       ORDER BY e.seq ASC, l.logical_tool_call_id ASC
       LIMIT ?
    `).all(input.sessionId, input.sourceUserSeq, bound, LANDED_WRITES_MAX) as Array<{
      accepted_task_id: string; logical_tool_call_id: string; tool_name: string; argument_digest: string;
      outcome_kind: 'succeeded' | 'empty_result'; physical_crossing_count: number;
      result_handle_id: string | null; settlement_event_id: string; settlement_seq: number;
    }>;
    const writes: LandedWrite[] = settled.map((row) => {
      let receipt: string | null = null;
      if (row.result_handle_id) {
        const redeemed = redeemSuccessfulSettlementResultForHost({
          sessionId: input.sessionId,
          sourceUserSeq: input.sourceUserSeq,
          acceptedTaskId: row.accepted_task_id,
          logicalToolCallId: row.logical_tool_call_id,
        });
        if (redeemed.status === 'ok' && redeemed.value.resultHandleId === row.result_handle_id) {
          receipt = boundedReceipt(redeemed.value.rawPayload);
        }
      }
      return {
        kind: 'settled_write',
        acceptedTaskId: row.accepted_task_id,
        logicalToolCallId: boundedIdentity(row.logical_tool_call_id, 120),
        toolName: boundedIdentity(row.tool_name, 96),
        argumentDigest: row.argument_digest,
        settlementEventId: row.settlement_event_id,
        settlementSeq: row.settlement_seq,
        outcomeKind: row.outcome_kind,
        physicalCrossingCount: row.physical_crossing_count,
        resultHandleId: row.result_handle_id,
        receipt,
      };
    });
    const saved = db.prepare(`
      SELECT id, seq, data_json FROM events
       WHERE session_id = ? AND type = 'deliverable_saved'
         AND json_extract(data_json, '$.sourceUserSeq') = ? AND seq < ?
       ORDER BY seq ASC
       LIMIT ?
    `).all(input.sessionId, input.sourceUserSeq, bound, LANDED_WRITES_MAX) as Array<{ id: string; seq: number; data_json: string }>;
    for (const row of saved) {
      try {
        const data = JSON.parse(row.data_json) as Record<string, unknown>;
        if (typeof data.name !== 'string' || !data.name.trim() || typeof data.dir !== 'string') continue;
        const bytes = Number.isSafeInteger(data.bytes) && Number(data.bytes) >= 0 ? Number(data.bytes) : 0;
        writes.push({
          kind: 'saved_file',
          eventId: row.id,
          seq: row.seq,
          name: boundedIdentity(data.name, 160),
          dir: boundedIdentity(data.dir, 160),
          bytes,
        });
      } catch { /* an unreadable visibility row is not a landed fact */ }
    }
    return writes;
  } catch {
    return [];
  }
}

/** One landed effect as a line of data: the tool and its own receipt, or the
 * file and its size, and the event sequence it settled at. */
export function landedWriteLine(write: LandedWrite): string {
  if (write.kind === 'saved_file') {
    return `landed: file ${JSON.stringify(write.dir ? `${write.dir}/${write.name}` : write.name)} ${write.bytes} bytes at seq ${write.seq}`;
  }
  const detail = write.receipt === null ? `${write.outcomeKind}, no receipt text retained` : JSON.stringify(write.receipt);
  const crossing = write.physicalCrossingCount > 0 ? ' (left this machine)' : '';
  return `landed: ${write.toolName} ${detail} at seq ${write.settlementSeq}${crossing}`;
}

function externalWriteState(rows: readonly SettlementInventoryRow[]): {
  state: RetainedExternalWriteState;
  tools: string[];
} {
  const writes = rows.filter((row) => row.mutating === 1 && row.physical_crossing_count > 0);
  if (writes.length === 0) return { state: 'not_recorded', tools: [] };
  const tools = [...new Set(writes.map((row) => boundedIdentity(row.tool_name, 96)).filter(Boolean))]
    .slice(0, 4);
  // A failure reply does not settle whether a crossed mutation took effect.
  // Preserve the ledger's uncertainty, even beside a separately settled success.
  if (writes.some((row) => row.requires_reconciliation === 1 || row.outcome_kind === 'uncertain_write')) {
    return { state: 'uncertain', tools };
  }
  const knownSuccess = writes.some((row) => (
    row.outcome_kind === 'succeeded' || row.outcome_kind === 'empty_result'
  ));
  const knownFailure = writes.some((row) => (
    row.outcome_kind !== 'succeeded' && row.outcome_kind !== 'empty_result'
  ));
  if (knownSuccess && knownFailure) return { state: 'mixed', tools };
  if (knownFailure) {
    return { state: 'failed', tools };
  }
  return { state: 'succeeded', tools };
}

/** Read one accepted source's exact, still-redeemable completed business work. */
export function retainedWorkInventoryForAcceptedSource(input: {
  sessionId: string;
  sourceUserSeq: number;
}): RetainedWorkInventory | null {
  if (!input.sessionId.trim() || !Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 0) {
    return null;
  }
  try {
    const rows = openEventLog().prepare(`
      SELECT l.accepted_task_id, l.logical_tool_call_id, l.tool_name,
             s.outcome_kind, s.outcome_detail, s.business_call, s.mutating,
             s.physical_crossing_count, s.requires_reconciliation,
             s.result_handle_id, s.settled_at
        FROM logical_call_settlements s
        JOIN logical_tool_calls l
          ON l.session_id = s.session_id
         AND l.source_user_seq = s.source_user_seq
         AND l.logical_tool_call_id = s.logical_tool_call_id
       WHERE s.session_id = ? AND s.source_user_seq = ?
       ORDER BY s.settled_at ASC, l.logical_tool_call_id ASC
    `).all(input.sessionId, input.sourceUserSeq) as SettlementInventoryRow[];

    const items: RetainedWorkItem[] = [];
    const seenHandles = new Set<string>();
    for (const row of rows) {
      if (
        row.business_call !== 1
        || (row.outcome_kind !== 'succeeded' && row.outcome_kind !== 'empty_result')
        || !row.result_handle_id
        || seenHandles.has(row.result_handle_id)
      ) continue;
      const redeemed = redeemSuccessfulSettlementResultForHost({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: row.accepted_task_id,
        logicalToolCallId: row.logical_tool_call_id,
      });
      if (redeemed.status !== 'ok' || redeemed.value.resultHandleId !== row.result_handle_id) continue;
      seenHandles.add(row.result_handle_id);
      const handle = redeemed.value.handle;
      items.push({
        toolName: boundedIdentity(redeemed.value.toolName, 96),
        logicalToolCallId: boundedIdentity(row.logical_tool_call_id, 120),
        resultHandleId: boundedIdentity(redeemed.value.resultHandleId, 120),
        ...(handle.recordPath !== null
          && Number.isSafeInteger(handle.recordCount)
          && handle.recordCount >= 0
          ? {
              recordCount: handle.recordCount,
              completeness: handle.completeness,
            }
          : {}),
      });
    }
    const landedWrites = landedWritesForAcceptedSource(input);
    if (items.length === 0 && landedWrites.length === 0) return null;
    const write = externalWriteState(rows);
    return {
      items,
      landedWrites,
      downstreamWriteState: write.state,
      downstreamWriteTools: write.tools,
    };
  } catch {
    // Terminal delivery must remain available if the evidence store cannot be
    // read. Silence is safer than inventing a retained-work claim.
    return null;
  }
}

function retainedItemLine(item: RetainedWorkItem): string {
  const recordDetail = item.recordCount === undefined
    ? 'completed result'
    : `${item.recordCount} record${item.recordCount === 1 ? '' : 's'} (${item.completeness ?? 'unknown'})`;
  return `- Source/tool ${item.toolName}: ${recordDetail} retained as ${item.resultHandleId}.`;
}

function downstreamWriteLine(inventory: RetainedWorkInventory): string {
  const tools = inventory.downstreamWriteTools.length > 0
    ? ` (${inventory.downstreamWriteTools.join(', ')})`
    : '';
  switch (inventory.downstreamWriteState) {
    case 'succeeded':
      return `External write state${tools}: succeeded. Do not repeat it.`;
    case 'failed':
      return `External write state${tools}: failed with a known terminal result; the retained work can be reused.`;
    case 'mixed':
      return `External write state${tools}: mixed known results, including at least one success and at least one failure. Do not repeat successful writes; isolate the failed operation before reusing retained source work.`;
    case 'uncertain':
      return `External write state${tools}: uncertain. Reconcile it before any retry.`;
    case 'refused':
      return `External write state${tools}: refused by the app in its reply. Nothing reruns on its own; a changed attempt goes to the owner first.`;
    case 'not_recorded':
      return 'External write state: no settled external-write attempt is recorded.';
  }
}

/** Append an idempotent, bounded inventory to host failure copy. */
export function renderFailureWithRetainedWork(input: {
  sessionId: string;
  sourceUserSeq: number;
  fallbackText: string;
}): string {
  // Re-project instead of trusting a matching phrase in proposed/model copy.
  // This also makes the host-runner -> delivery-committer double pass
  // idempotent while keeping the durable rows as the only claim authority.
  const priorHeader = input.fallbackText.indexOf(RETAINED_WORK_TERMINAL_HEADER);
  const fallbackText = priorHeader >= 0
    ? input.fallbackText.slice(0, priorHeader).trimEnd()
    : input.fallbackText;
  const inventory = retainedWorkInventoryForAcceptedSource(input);
  if (!inventory) return fallbackText;

  const displayed = inventory.items.slice(0, 5);
  const omitted = inventory.items.length - displayed.length;
  // Landed effects ride beside the retained results as bullets of data. The
  // public projection counts none of them as a result; a later turn reads
  // them as settled and continues after them.
  return [
    fallbackText.trim(),
    '',
    RETAINED_WORK_TERMINAL_HEADER,
    ...displayed.map(retainedItemLine),
    ...(omitted > 0 ? [`- ${omitted} additional retained result${omitted === 1 ? '' : 's'}.`] : []),
    ...inventory.landedWrites.map((write) => `- ${landedWriteLine(write)}.`),
    downstreamWriteLine(inventory),
  ].join('\n');
}
