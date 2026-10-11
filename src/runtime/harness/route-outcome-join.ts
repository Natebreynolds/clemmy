/**
 * What a turn's routed model calls earned.
 *
 * Route metrics record each model request as the provider answered it:
 * status, latency, tokens. Whether the work was right is known only when the
 * turn finishes: the completion review's verdict and the settlement ledger's
 * account of the tool calls. This joins those two facts onto the brain request
 * whose answer the turn shipped, so the route policy can prefer the model
 * whose answers pass review over the one that answers fastest.
 *
 * Telemetry only. It runs after the terminal is published, off the response
 * path; any failure leaves the row as it was and never reaches the owner.
 */
import type Database from 'better-sqlite3';
import { appendEvent, listEvents, openEventLog, type EventRow } from './eventlog.js';
import {
  latestSourceRouteDecision,
  updateModelRouteOutcomeVerdict,
  type ModelRouteRole,
} from '../model-route-metrics.js';

export interface SourceIdentity {
  sessionId: string;
  sourceUserSeq: number;
}

export interface SourceRouteVerdict {
  /** The review passed the shipped reply; undefined when nothing reviewed it. */
  objectiveMet?: boolean;
  /** The judged row the objective was read from. */
  verdictEventId?: string;
  /** Every dispatched call landed; undefined when none ran. */
  toolSuccess?: boolean;
  /** Dispatched calls the tool verdict counted. */
  toolCalls: number;
}

/**
 * The reviewer's last word on the reply the source shipped. Passed is true;
 * not passed (blocked, or a rejection carried onto an honest stop) is false.
 * Anything that is not a reviewer judging this model's finished reply leaves
 * it unknown, never false: a review that failed open, a model judging its own
 * work, a verdict waiting on the owner, a plan review, and a verdict the turn
 * went on past (its continuation shipped a reply nobody reviewed). The host
 * deleting claims a reviewer flagged is an edit, not a verdict: the reviewer's
 * rejection before it stands.
 */
export function objectiveFromVerdictRows(
  rows: ReadonlyArray<Pick<EventRow, 'id' | 'data'>>,
  sourceUserSeq: number,
): Pick<SourceRouteVerdict, 'objectiveMet' | 'verdictEventId'> {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    const data = row.data as Record<string, unknown> | undefined;
    if (!data || data.lane !== 'host_v1' || data.kind !== 'completion' || data.sourceUserSeq !== sourceUserSeq) continue;
    if (data.claimRemoval !== undefined) continue;
    const verdictEventId = String(row.id);
    if (data.failedOpen === true || data.selfJudge === true || data.awaitingUser === true
      || data.planDigest !== undefined || data.continuation === true) return { verdictEventId };
    return { objectiveMet: data.fulfills === true, verdictEventId };
  }
  return {};
}

/** Outcomes that are neither a landed call nor a failed one: the call waits
 *  on the owner, or the ledger cannot yet say whether a write took. */
const NO_TOOL_VERDICT = new Set(['input_required', 'uncertain_write']);

/**
 * Whether the turn's tool calls landed: true when every dispatched call
 * succeeded or honestly came back empty, false when any failed after it was
 * dispatched. A call the host refused before dispatch never reached a tool,
 * so it is not counted either way.
 */
export function toolSuccessFromSettlements(
  rows: ReadonlyArray<{ execution_kind: string; outcome_kind: string }>,
): Pick<SourceRouteVerdict, 'toolSuccess' | 'toolCalls'> {
  const counted = rows.filter((row) => row.execution_kind !== 'refused_pre_dispatch' && !NO_TOOL_VERDICT.has(row.outcome_kind));
  if (counted.length === 0) return { toolCalls: 0 };
  return {
    toolSuccess: counted.every((row) => row.outcome_kind === 'succeeded' || row.outcome_kind === 'empty_result'),
    toolCalls: counted.length,
  };
}

function sourceSettlements(identity: SourceIdentity, db: Database.Database): Array<{ execution_kind: string; outcome_kind: string }> {
  return db.prepare(`
    SELECT execution_kind, outcome_kind FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ?
  `).all(identity.sessionId, identity.sourceUserSeq) as Array<{ execution_kind: string; outcome_kind: string }>;
}

export function readSourceRouteVerdict(
  identity: SourceIdentity,
  deps: { settlementsDb?: Database.Database } = {},
): SourceRouteVerdict {
  const objective = objectiveFromVerdictRows(listEvents(identity.sessionId, { types: ['goal_alignment_judged'] }),
    identity.sourceUserSeq);
  const tools = toolSuccessFromSettlements(sourceSettlements(identity, deps.settlementsDb ?? openEventLog()));
  return { ...objective, ...tools };
}

/** When the source was accepted, to bound the decision scan to its lifetime. */
function sourceAcceptedAt(identity: SourceIdentity): string | undefined {
  const [row] = listEvents(identity.sessionId, { sinceSeq: identity.sourceUserSeq - 1, limit: 1 });
  return row?.seq === identity.sourceUserSeq ? row.createdAt : undefined;
}

export interface RouteOutcomeJoin {
  decisionId?: string;
  verdict: SourceRouteVerdict;
  updated: boolean;
}

/**
 * Join one finished source's verdict onto its brain request. A source with no
 * review and no calls changes nothing. Writing the same verdict twice is a
 * no-op, so a replayed terminal records once.
 */
export function joinRouteOutcomeVerdict(
  identity: SourceIdentity,
  deps: { metricsDb?: Database.Database; settlementsDb?: Database.Database } = {},
): RouteOutcomeJoin {
  const verdict = readSourceRouteVerdict(identity, deps);
  if (verdict.objectiveMet === undefined && verdict.toolSuccess === undefined) return { verdict, updated: false };
  const decision = latestSourceRouteDecision({ ...identity, role: 'brain', since: sourceAcceptedAt(identity) }, deps.metricsDb);
  if (!decision) return { verdict, updated: false };
  const updated = updateModelRouteOutcomeVerdict(decision.id, {
    objectiveMet: verdict.objectiveMet,
    toolSuccess: verdict.toolSuccess,
    toolCalls: verdict.toolCalls,
    basis: {
      sourceUserSeq: identity.sourceUserSeq,
      turnRequests: decision.requests,
      ...(verdict.verdictEventId ? { verdictEventId: verdict.verdictEventId } : {}),
    },
  }, deps.metricsDb);
  if (updated) recordJudged(identity, decision.id, 'brain', verdict);
  return { decisionId: decision.id, verdict, updated };
}

/**
 * A helper's own result is its signal: the request that wrote the helper's
 * answer records whether the helper came back with a usable result.
 */
export function joinWorkerRouteOutcome(
  identity: SourceIdentity & { usable: boolean },
  deps: { metricsDb?: Database.Database } = {},
): RouteOutcomeJoin {
  const verdict: SourceRouteVerdict = { toolSuccess: identity.usable, toolCalls: 0 };
  const decision = latestSourceRouteDecision({ ...identity, role: 'worker', since: sourceAcceptedAt(identity) }, deps.metricsDb);
  if (!decision) return { verdict, updated: false };
  const updated = updateModelRouteOutcomeVerdict(decision.id, {
    toolSuccess: identity.usable,
    basis: { sourceUserSeq: identity.sourceUserSeq, workerResult: identity.usable ? 'usable' : 'unusable' },
  }, deps.metricsDb);
  if (updated) recordJudged(identity, decision.id, 'worker', verdict);
  return { decisionId: decision.id, verdict, updated };
}

function recordJudged(identity: SourceIdentity, decisionId: string, role: ModelRouteRole, verdict: SourceRouteVerdict): void {
  appendEvent({
    sessionId: identity.sessionId,
    turn: 0,
    role: 'system',
    type: 'route_outcome_judged',
    data: {
      sourceUserSeq: identity.sourceUserSeq,
      decisionId,
      routeRole: role,
      ...(verdict.objectiveMet !== undefined ? { objectiveMet: verdict.objectiveMet } : {}),
      ...(verdict.toolSuccess !== undefined ? { toolSuccess: verdict.toolSuccess } : {}),
      toolCalls: verdict.toolCalls,
      ...(verdict.verdictEventId ? { verdictEventId: verdict.verdictEventId } : {}),
    },
  });
}

/** After the terminal, off its path: the join cannot delay or change it. */
export function scheduleRouteOutcomeJoin(run: () => unknown): void {
  setImmediate(() => {
    try { run(); } catch { /* telemetry never reaches the owner */ }
  });
}
