import type { AgentInputItem } from '@openai/agents';
import type Database from 'better-sqlite3';
import { openEventLog } from './eventlog.js';

/**
 * Consecutive model steps that may dispatch nothing before the turn stops.
 *
 * A step dispatches nothing when every call it made was refused before it ran:
 * a refused frame, or a call whose arguments failed validation. Each such step
 * adds the call and its refusal to the conversation and changes nothing else,
 * so a model that cannot find a valid call loops at full price. Live
 * 2026-10-16: with a plan active the no-progress governor does not observe,
 * and one turn made 52 refused workflow_create calls and 9 refused plan_task
 * frames over 50 minutes, its prompt growing to 612k tokens. This bound holds
 * in every phase; any call that runs resets it.
 */
export const HOST_NO_DISPATCH_STREAK_LIMIT = 8;

/** How many times one step may be refused before dispatch for the same
 * operation and the same reason within one turn, however many reads land in
 * between, before the host ends the turn with the reason said plainly.
 * Live 10-20 (Platform 49): a scheduled step alternated Slack reads with
 * sheet writes refused on one constraint-check fault; the no-dispatch streak
 * reset on every read, the step cap was off, and a five-minute workflow ran
 * for an hour (52 checker calls). */
export const HOST_IDENTICAL_REFUSAL_LIMIT = 3;

/** The identity of a pre-dispatch refusal: which operations the step
 * proposed and which reason the host gave, with ids, digests and counts
 * removed so the same fault reads the same each time. */
export function identicalRefusalKey(operations: readonly (string | null)[], refusalDetail: string | undefined): string | null {
  const detail = (refusalDetail ?? '').trim();
  if (!detail) return null;
  const named = [...new Set(operations.filter((name): name is string => typeof name === 'string' && name.trim().length > 0))].sort();
  if (named.length === 0) return null;
  const check = /Failed check: ([a-z_]+)/i.exec(detail)?.[1];
  const code = /^([a-z_]+(?::[a-z_]+)*)\s*[:\-]/i.exec(detail)?.[1];
  const reason = (check ?? code ?? detail.slice(0, 120))
    .toLowerCase()
    .replace(/[0-9a-f]{16,}/g, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  return `${named.join(',')}|${reason}`;
}

export type StepDispatch = 'none_dispatched' | 'dispatched' | 'no_calls';

function callIdOf(item: AgentInputItem, type: 'function_call' | 'function_call_result'): string | null {
  const row = item as { type?: unknown; callId?: unknown };
  return row.type === type && typeof row.callId === 'string' && row.callId ? row.callId : null;
}

/**
 * What the calls in one stretch of history did. A call counts as refused when
 * its result carries the host's refused-before-dispatch marker or its durable
 * settlement says it was refused before dispatch. Anything the host cannot
 * read counts as dispatched, so an unreadable ledger never stops a turn.
 */
export function classifyStepDispatch(input: {
  sessionId: string;
  sourceUserSeq: number;
  delta: readonly AgentInputItem[];
  refusedByMarker: (item: AgentInputItem) => boolean;
}, database?: Database.Database): StepDispatch {
  const callIds = [...new Set(input.delta.flatMap((item) => {
    const callId = callIdOf(item, 'function_call');
    return callId ? [callId] : [];
  }))];
  if (callIds.length === 0) return 'no_calls';
  const marked = new Set(input.delta.flatMap((item) => {
    const callId = callIdOf(item, 'function_call_result');
    return callId && input.refusedByMarker(item) ? [callId] : [];
  }));
  const unmarked = callIds.filter((callId) => !marked.has(callId));
  if (unmarked.length === 0) return 'none_dispatched';
  try {
    const db = database ?? openEventLog();
    const placeholders = unmarked.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT logical_tool_call_id, observer_call_id, execution_kind
        FROM logical_call_settlements
       WHERE session_id = ? AND source_user_seq = ?
         AND (logical_tool_call_id IN (${placeholders}) OR observer_call_id IN (${placeholders}))
    `).all(input.sessionId, input.sourceUserSeq, ...unmarked, ...unmarked) as Array<{
      logical_tool_call_id: string;
      observer_call_id: string | null;
      execution_kind: string;
    }>;
    const refused = new Set<string>();
    for (const row of rows) {
      if (row.execution_kind !== 'refused_pre_dispatch') return 'dispatched';
      refused.add(row.logical_tool_call_id);
      if (row.observer_call_id) refused.add(row.observer_call_id);
    }
    return unmarked.every((callId) => refused.has(callId)) ? 'none_dispatched' : 'dispatched';
  } catch {
    return 'dispatched';
  }
}
