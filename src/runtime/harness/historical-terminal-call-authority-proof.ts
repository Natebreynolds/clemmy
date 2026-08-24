import { openEventLog } from './eventlog.js';
import {
  settlementCrossingAuthorityDigest,
  type SettlementCrossingAuthorityEntry,
  type SettlementCrossingAuthorityVersion,
} from './settlement-crossing-authority.js';
import {
  presentationEventFromCompletionData,
  type PresentationEvent,
} from './turn-outcome.js';

/**
 * This close reason is intentionally unique. It is the only state/resolution
 * mismatch accepted by the call-authority reader, and only after this module
 * independently re-proves the exact historical terminal and every child.
 */
export const HISTORICAL_TERMINAL_COMPLETE_CLOSE_REASON = 'historical_terminal_complete' as const;

type HarnessDb = ReturnType<typeof openEventLog>;

export interface HistoricalTerminalCallAuthorityIdentity {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  sourceEventId: string;
  sourceTurn: number;
}

export type HistoricalTerminalCallAuthorityProof =
  | {
      status: 'complete';
      terminalEventId: string;
      terminalAt: string;
      presentation: PresentationEvent;
    }
  | {
      status: 'hold';
      reason: string;
      terminalEventId?: string;
      terminalAt?: string;
      presentation?: PresentationEvent;
    }
  | {
      status: 'conflict';
      reason: string;
      terminalEventId?: string;
      terminalAt?: string;
      presentation?: PresentationEvent;
    };

interface LogicalRow {
  logical_tool_call_id: string;
  accepted_task_id: string;
  tool_name: string;
  argument_digest: string;
  state: 'open' | 'settled' | 'conflict';
  settlement_event_id: string | null;
  outcome_kind: string | null;
}

interface SettlementRow {
  logical_tool_call_id: string;
  outcome_kind: string;
  requires_reconciliation: number;
  physical_crossing_count: number;
  host_crossing_count: number | null;
  crossing_authority_version: number;
  physical_crossings_digest: string;
  settlement_event_id: string;
}

interface PhysicalRow {
  physical_dispatch_id: string;
  ordinal: number;
  relation: SettlementCrossingAuthorityEntry['relation'];
  retry_of: string | null;
  tool_name: string;
  argument_digest: string;
  state: 'started' | 'returned' | 'threw' | 'timed_out' | 'cancelled' | 'unknown';
  execution_site: string | null;
  settled_at: string | null;
  settle_event_id: string | null;
}

interface FrozenCrossingRow {
  physical_dispatch_id: string;
  ordinal: number;
  relation: SettlementCrossingAuthorityEntry['relation'];
  retry_of: string | null;
  tool_name: string;
  argument_digest: string;
  terminal_state: PhysicalRow['state'] | null;
  execution_site: string | null;
}

const MAX_LOGICAL_CHILDREN_PER_ROOT = 256;
const MAX_CROSSINGS_PER_ROOT = 2_048;

function boundedReason(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function tableExists(db: HarnessDb, name: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(name));
}

function terminalFor(
  db: HarnessDb,
  identity: HistoricalTerminalCallAuthorityIdentity,
): HistoricalTerminalCallAuthorityProof {
  const source = db.prepare(`
    SELECT id, turn, role, type
      FROM events
     WHERE session_id = ? AND seq = ?
  `).get(identity.sessionId, identity.sourceUserSeq) as {
    id: string;
    turn: number;
    role: string;
    type: string;
  } | undefined;
  if (
    !source
    || source.id !== identity.sourceEventId
    || source.turn !== identity.sourceTurn
    || source.role !== 'user'
    || source.type !== 'user_input_received'
  ) return { status: 'conflict', reason: 'historical source identity is contradictory' };

  // A row can claim the source through any compatibility identity. We select
  // only exact claims and cap at two because a second claimant is already an
  // ambiguity; there is no reason to scan the rest of the event history.
  const rows = db.prepare(`
    SELECT id, turn, data_json, created_at
      FROM events
     WHERE session_id = ?
       AND type = 'conversation_completed'
       AND json_valid(data_json) = 1
       AND (
         json_extract(data_json, '$.terminalKey') = ?
         OR json_extract(data_json, '$.sourceUserSeq') = ?
         OR json_extract(data_json, '$.presentation.identity.sourceUserSeq') = ?
         OR json_extract(data_json, '$.turnOutcome.identity.sourceUserSeq') = ?
       )
     ORDER BY seq
     LIMIT 2
  `).all(
    identity.sessionId,
    `turn:${identity.sourceUserSeq}`,
    identity.sourceUserSeq,
    identity.sourceUserSeq,
    identity.sourceUserSeq,
  ) as Array<{ id: string; turn: number; data_json: string; created_at: string }>;
  if (rows.length === 0) {
    return { status: 'hold', reason: 'exact typed historical terminal is absent' };
  }
  if (rows.length !== 1) {
    return { status: 'conflict', reason: 'multiple historical terminals claim the accepted source' };
  }
  const terminal = rows[0]!;
  let data: unknown;
  let presentation: PresentationEvent | null;
  try {
    data = JSON.parse(terminal.data_json) as unknown;
    presentation = presentationEventFromCompletionData(data);
  } catch (error) {
    return {
      status: 'conflict',
      reason: `historical terminal is malformed: ${boundedReason(error)}`,
      terminalEventId: terminal.id,
      terminalAt: terminal.created_at,
    };
  }
  if (!presentation) {
    return {
      status: 'hold',
      reason: 'historical terminal has no typed outcome proof',
      terminalEventId: terminal.id,
      terminalAt: terminal.created_at,
    };
  }
  if (
    terminal.turn !== identity.sourceTurn
    || presentation.identity.sessionId !== identity.sessionId
    || presentation.identity.sourceUserSeq !== identity.sourceUserSeq
    || presentation.identity.turn !== identity.sourceTurn
  ) {
    return {
      status: 'conflict',
      reason: 'historical terminal contradicts the accepted source identity',
      terminalEventId: terminal.id,
      terminalAt: terminal.created_at,
      presentation,
    };
  }
  if (presentation.status === 'failed' || presentation.status === 'uncertain') {
    return {
      status: 'conflict',
      reason: `historical terminal outcome is ${presentation.status}`,
      terminalEventId: terminal.id,
      terminalAt: terminal.created_at,
      presentation,
    };
  }
  if (presentation.status === 'transferred') {
    return {
      status: 'hold',
      reason: 'historical terminal transferred ownership',
      terminalEventId: terminal.id,
      terminalAt: terminal.created_at,
      presentation,
    };
  }
  return {
    status: 'complete',
    terminalEventId: terminal.id,
    terminalAt: terminal.created_at,
    presentation,
  };
}

function childConflict(reason: string): HistoricalTerminalCallAuthorityProof {
  return { status: 'conflict', reason };
}

function childProof(
  db: HarnessDb,
  identity: HistoricalTerminalCallAuthorityIdentity,
): HistoricalTerminalCallAuthorityProof | null {
  for (const table of [
    'logical_tool_calls',
    'physical_dispatches',
    'logical_call_settlements',
    'logical_call_settlement_crossings',
  ]) {
    if (!tableExists(db, table)) {
      return { status: 'hold', reason: `historical child ledger ${table} is unavailable` };
    }
  }
  const logicalRows = db.prepare(`
    SELECT logical_tool_call_id, accepted_task_id, tool_name, argument_digest,
           state, settlement_event_id, outcome_kind
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY logical_tool_call_id
     LIMIT ?
  `).all(
    identity.sessionId,
    identity.sourceUserSeq,
    MAX_LOGICAL_CHILDREN_PER_ROOT + 1,
  ) as LogicalRow[];
  if (logicalRows.length > MAX_LOGICAL_CHILDREN_PER_ROOT) {
    return { status: 'hold', reason: 'historical logical child inventory exceeds its proof bound' };
  }

  let crossingCount = 0;

  for (const logical of logicalRows) {
    if (logical.accepted_task_id !== identity.acceptedTaskId) {
      return childConflict('historical logical child names a different accepted task');
    }
    if (logical.state !== 'settled') {
      return childConflict(`historical logical child is ${logical.state}`);
    }
    const settlements = db.prepare(`
      SELECT logical_tool_call_id, outcome_kind, requires_reconciliation,
             physical_crossing_count, host_crossing_count,
             crossing_authority_version, physical_crossings_digest,
             settlement_event_id
        FROM logical_call_settlements
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
       LIMIT 2
    `).all(
      identity.sessionId,
      identity.sourceUserSeq,
      logical.logical_tool_call_id,
    ) as SettlementRow[];
    if (settlements.length !== 1) {
      return childConflict('historical logical child lacks one exact settlement');
    }
    const settlement = settlements[0]!;
    if (
      logical.settlement_event_id === null
      || logical.settlement_event_id !== settlement.settlement_event_id
      || logical.outcome_kind !== settlement.outcome_kind
      || settlement.requires_reconciliation !== 0
      || ['uncertain_write', 'unknown'].includes(settlement.outcome_kind)
      || (settlement.crossing_authority_version !== 1
        && settlement.crossing_authority_version !== 2)
    ) return childConflict('historical logical settlement is contradictory or uncertain');

    const settlementMirror = db.prepare(`
      SELECT 1
        FROM events
       WHERE id = ? AND session_id = ? AND type = 'tool_attempt_settled'
    `).get(settlement.settlement_event_id, identity.sessionId);
    if (!settlementMirror) {
      return childConflict('historical logical settlement mirror is missing');
    }

    const physical = db.prepare(`
      SELECT physical_dispatch_id, ordinal, relation, retry_of, tool_name,
             argument_digest, state, execution_site, settled_at, settle_event_id
        FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
       ORDER BY ordinal
       LIMIT ?
    `).all(
      identity.sessionId,
      identity.sourceUserSeq,
      logical.logical_tool_call_id,
      MAX_CROSSINGS_PER_ROOT - crossingCount + 1,
    ) as PhysicalRow[];
    crossingCount += physical.length;
    if (crossingCount > MAX_CROSSINGS_PER_ROOT) {
      return { status: 'hold', reason: 'historical crossing inventory exceeds its proof bound' };
    }
    if (physical.some((row) => (
      row.tool_name !== logical.tool_name
      || row.argument_digest !== logical.argument_digest
      || row.state === 'started'
      || row.state === 'timed_out'
      || row.state === 'unknown'
      || row.settled_at === null
      || row.settle_event_id === null
    ))) {
      // A timed-out/unknown crossing is durable uncertainty, never evidence of
      // completion and never replay authority.
      return childConflict('historical physical crossing is nonterminal or uncertain');
    }
    for (const crossing of physical) {
      const mirror = db.prepare(`
        SELECT 1
          FROM events
         WHERE id = ? AND session_id = ? AND type = 'provider_dispatch_settled'
      `).get(crossing.settle_event_id, identity.sessionId);
      if (!mirror) return childConflict('historical physical settlement mirror is missing');
    }

    const frozen = db.prepare(`
      SELECT physical_dispatch_id, ordinal, relation, retry_of, tool_name,
             argument_digest, terminal_state, execution_site
        FROM logical_call_settlement_crossings
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
       ORDER BY ordinal
       LIMIT ?
    `).all(
      identity.sessionId,
      identity.sourceUserSeq,
      logical.logical_tool_call_id,
      physical.length + 1,
    ) as FrozenCrossingRow[];
    const version = settlement.crossing_authority_version as SettlementCrossingAuthorityVersion;
    const entries: SettlementCrossingAuthorityEntry[] = frozen.map((row) => ({
      physicalDispatchId: row.physical_dispatch_id,
      ordinal: row.ordinal,
      relation: row.relation,
      retryOf: row.retry_of,
      toolName: row.tool_name,
      argumentDigest: row.argument_digest,
      ...(version === 2 ? {
        terminalState: row.terminal_state,
        executionSite: row.execution_site === 'host' ? 'host' as const : null,
      } : {}),
    }));
    const liveById = new Map(physical.map((row) => [row.physical_dispatch_id, row]));
    if (
      frozen.length !== physical.length
      || frozen.some((row) => {
        const live = liveById.get(row.physical_dispatch_id);
        return !live
          || live.ordinal !== row.ordinal
          || live.relation !== row.relation
          || live.retry_of !== row.retry_of
          || live.tool_name !== row.tool_name
          || live.argument_digest !== row.argument_digest
          || (version === 2 && (
            live.state !== row.terminal_state
            || (live.execution_site === 'host' ? 'host' : null) !== row.execution_site
          ));
      })
      || frozen.length !== settlement.physical_crossing_count + (settlement.host_crossing_count ?? 0)
      || physical.filter((row) => row.execution_site !== 'host').length
        !== settlement.physical_crossing_count
      || physical.filter((row) => row.execution_site === 'host').length
        !== (settlement.host_crossing_count ?? 0)
      || settlementCrossingAuthorityDigest(entries, version)
        !== settlement.physical_crossings_digest
    ) return childConflict('historical settlement crossing authority does not recompute');
  }
  return null;
}

/** Pure read proof. It never changes a row and never dispatches work. */
export function proveHistoricalTerminalCallAuthorityInTransaction(
  db: HarnessDb,
  identity: HistoricalTerminalCallAuthorityIdentity,
): HistoricalTerminalCallAuthorityProof {
  try {
    const terminal = terminalFor(db, identity);
    if (terminal.status !== 'complete') return terminal;
    const children = childProof(db, identity);
    return children
      ? {
          ...children,
          terminalEventId: terminal.terminalEventId,
          terminalAt: terminal.terminalAt,
          presentation: terminal.presentation,
        }
      : terminal;
  } catch (error) {
    return { status: 'hold', reason: `historical proof read failed: ${boundedReason(error)}` };
  }
}
