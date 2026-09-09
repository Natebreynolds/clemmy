/**
 * Ledger-truth progress projection for run heartbeats.
 *
 * While a long turn runs, the ledger already knows the plan's requirement
 * states, how much evidence has landed, and what the run is collecting — but
 * every lane's heartbeat said only "Still working." (live 2026-08-18: a
 * 12-minute 25-item run surfaced nothing else). This composer projects the
 * same oracle the admission plan card uses, so the user-visible progress line
 * and "may proceed" can never disagree. Pure DATA — no model call, no
 * vocabulary detection, shared by every brain lane.
 */
import { getEvent, getTurnGraphEventForSource, openEventLog } from './eventlog.js';
import { isLiveApprovalAcknowledgement } from './accepted-source-kind.js';
import { turnGraphFromShadowEvent } from '../graph/turn-graph-shadow.js';
import { expectedWorkPlanLines, type ExpectedWorkPlanLine } from './expected-work-admission.js';

function latestUserSeq(sessionId: string): number | null {
  try {
    const rows = openEventLog().prepare(`
      SELECT id FROM events
       WHERE session_id = ? AND type = 'user_input_received'
       ORDER BY seq DESC
    `).iterate(sessionId) as Iterable<{ id: string }>;
    for (const row of rows) {
      const event = getEvent(row.id);
      if (event && !isLiveApprovalAcknowledgement(event)) return event.seq;
    }
    return null;
  } catch {
    return null;
  }
}

function collectionFacts(sessionId: string, sourceUserSeq: number): {
  itemCount: number;
  destinationFamily?: string;
} | null {
  try {
    const graph = turnGraphFromShadowEvent(getTurnGraphEventForSource(sessionId, sourceUserSeq));
    if (!graph) return null;
    const goal = graph.classification.goalConstraints;
    const itemCount = goal?.collection?.count ?? graph.classification.multiItem?.itemCount ?? 0;
    return {
      itemCount,
      ...(goal?.destination?.family ? { destinationFamily: goal.destination.family } : {}),
    };
  } catch {
    return null;
  }
}

function stepLabel(line: ExpectedWorkPlanLine): string {
  switch (line.effect) {
    case 'read': return 'collecting';
    case 'compute': return 'processing';
    case 'external_write': return 'writing the deliverable';
    case 'local_write': return 'writing locally';
    default: return String(line.effect);
  }
}

/** One human-readable progress line derived only from durable run state.
 * Normal work has no frozen plan; its exact source settlements still show
 * completed operations. These are operation counts, never unique-item claims. */
export function composeRunProgressLine(input: {
  sessionId: string;
  sourceUserSeq?: number;
  fallback: string;
}): string {
  try {
    const sourceUserSeq = input.sourceUserSeq ?? latestUserSeq(input.sessionId) ?? undefined;
    if (!sourceUserSeq) return input.fallback;
    const lines = expectedWorkPlanLines({ sessionId: input.sessionId, sourceUserSeq });
    const counts = openEventLog().prepare(`
        SELECT SUM(CASE WHEN mutating = 1 THEN 1 ELSE 0 END) AS writes,
               SUM(CASE WHEN mutating = 0 THEN 1 ELSE 0 END) AS reads
          FROM logical_call_settlements
         WHERE session_id = ? AND source_user_seq = ? AND business_call = 1
           AND outcome_kind IN ('succeeded', 'empty_result')
      `).get(input.sessionId, sourceUserSeq) as { writes: number | null; reads: number | null };
    const completedOperations = [
        counts.writes ? `${counts.writes} write${counts.writes === 1 ? '' : 's'} completed` : '',
        counts.reads ? `${counts.reads} result${counts.reads === 1 ? '' : 's'} collected` : '',
    ].filter(Boolean);
    if (lines.length === 0) {
      return completedOperations.length ? `Still working — ${completedOperations.join(' · ')}.` : input.fallback;
    }
    const satisfied = lines.filter((line) => line.state === 'satisfied').length;
    const evidenceIn = lines.filter((line) => line.state === 'data_in').length;
    const next = lines.find((line) => line.state !== 'satisfied');
    const facts = collectionFacts(input.sessionId, sourceUserSeq);
    // Evidence landing IS progress. "plan 0/3 steps done" for sixteen minutes
    // of real collection (live 2026-08-18 sess-synthetic-002, 13 heartbeats) read
    // as a stall while two steps had data in.
    const underway = Math.min(lines.length, satisfied + evidenceIn);
    const parts: string[] = [
      ...completedOperations,
      evidenceIn > 0 && satisfied < lines.length
        ? `plan ${underway}/${lines.length} steps underway (${satisfied} done)`
        : `plan ${satisfied}/${lines.length} steps done`,
    ];
    if (evidenceIn > 0) parts.push(`${evidenceIn} with evidence in`);
    if (facts && facts.itemCount >= 2) {
      parts.push(`${facts.itemCount}-item collection${facts.destinationFamily ? ` → ${facts.destinationFamily.replace(/_/g, ' ')}` : ''}`);
    }
    // An unsatisfied requirement is the next target, not proof that its tool
    // is executing. Live discovery/reads must not be labelled as active writes.
    if (next) parts.push(`next step: ${stepLabel(next)}${next.state === 'blocked_on_dependency' ? ' (waiting on a predecessor)' : ''}`);
    return `Still working — ${parts.join(' · ')}.`;
  } catch {
    return input.fallback;
  }
}


/** Safe counters for surface tickers: steps underway (evidence in or done)
 *  over total plan steps. Null when the turn owns no frozen plan. */
export function runPlanCounters(sessionId: string): { completed: number; total: number } | null {
  try {
    const sourceUserSeq = latestUserSeq(sessionId) ?? undefined;
    if (!sourceUserSeq) return null;
    const lines = expectedWorkPlanLines({ sessionId, sourceUserSeq });
    if (lines.length === 0) return null;
    const completed = lines.filter((line) => line.state === 'satisfied' || line.state === 'data_in').length;
    return { completed, total: lines.length };
  } catch {
    return null;
  }
}
