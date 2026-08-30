import { openEventLog } from './eventlog.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';

/**
 * Host-authored retained-work disclosure for an incomplete terminal.
 *
 * This projection never reads model prose or guesses from tool names. A result
 * appears only after the immutable logical settlement can redeem its exact raw
 * result handle. External-write state comes from the same normalized settlement
 * rows and their frozen non-host crossing counts.
 */

export const RETAINED_WORK_TERMINAL_HEADER = 'Retained work (durable checkpoint):';

export type RetainedExternalWriteState =
  | 'not_recorded'
  | 'succeeded'
  | 'failed'
  | 'mixed'
  | 'uncertain';

export interface RetainedWorkItem {
  toolName: string;
  logicalToolCallId: string;
  resultHandleId: string;
  recordCount?: number;
  completeness?: 'complete' | 'partial' | 'unknown';
}

export interface RetainedWorkInventory {
  items: RetainedWorkItem[];
  downstreamWriteState: RetainedExternalWriteState;
  downstreamWriteTools: string[];
}

interface SettlementInventoryRow {
  accepted_task_id: string;
  logical_tool_call_id: string;
  tool_name: string;
  outcome_kind: string;
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

function externalWriteState(rows: readonly SettlementInventoryRow[]): {
  state: RetainedExternalWriteState;
  tools: string[];
} {
  const writes = rows.filter((row) => row.mutating === 1 && row.physical_crossing_count > 0);
  if (writes.length === 0) return { state: 'not_recorded', tools: [] };
  const tools = [...new Set(writes.map((row) => boundedIdentity(row.tool_name, 96)).filter(Boolean))]
    .slice(0, 4);
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
             s.outcome_kind, s.business_call, s.mutating,
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
    if (items.length === 0) return null;
    const write = externalWriteState(rows);
    return {
      items,
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
  return [
    fallbackText.trim(),
    '',
    RETAINED_WORK_TERMINAL_HEADER,
    ...displayed.map(retainedItemLine),
    ...(omitted > 0 ? [`- ${omitted} additional retained result${omitted === 1 ? '' : 's'}.`] : []),
    downstreamWriteLine(inventory),
  ].join('\n');
}
