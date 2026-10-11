/**
 * What a turn's routed model calls earned.
 *
 * Route metrics record each model request as the provider answered it:
 * status, latency, tokens. Whether the work was right is known only when the
 * turn finishes: the completion verdict the terminal was published under and
 * the settlement ledger's account of the tool calls. This joins those two
 * facts onto the one brain request that wrote the reviewed reply, in the same
 * run attempt, so the route policy can prefer the model whose answers pass
 * review over the one that answers fastest.
 *
 * Only what is proven is written. The verdict is the terminal's own
 * completionVerdictRef (the review it was published under, whether the
 * delivered reply is the judged one, whether it still stands); a reply nobody
 * judged, a failed-open or self-judged review and an answer waiting on the
 * owner stay unknown. A write whose outcome is uncertain keeps the turn's tool
 * result unknown and is counted, so confirmed siblings cannot make it look
 * landed.
 *
 * Telemetry only. It runs after the terminal is published, off the response
 * path; any failure leaves the row as it was and never reaches the owner.
 */
import type Database from 'better-sqlite3';
import { appendEvent, getEvent, listEvents, openEventLog, type EventRow } from './eventlog.js';
import {
  attemptRouteDecision,
  updateModelRouteOutcomeVerdict,
  type ModelRouteRole,
} from '../model-route-metrics.js';

export interface SourceIdentity {
  sessionId: string;
  sourceUserSeq: number;
}

export interface SourceRouteVerdict {
  /** The review passed the shipped reply; undefined when that is not proven. */
  objectiveMet?: boolean;
  /** The verdict event the terminal was published under. */
  verdictEventId?: string;
  /** Every dispatched call landed; undefined when none ran or any is uncertain. */
  toolSuccess?: boolean;
  /** Dispatched calls with a known outcome. */
  toolCalls: number;
  /** Dispatched writes whose outcome is not known; never folded into success. */
  uncertainWrites: number;
}

/** The terminal's record of the review it was published under. */
export interface PublishedVerdictRef {
  sourceUserSeq?: number;
  eventId?: string;
  fulfills?: boolean;
  verified?: boolean;
  replyMatches?: boolean;
  failedOpen?: boolean;
  selfJudge?: boolean;
}

/**
 * The model's verdict, from the review the terminal was published under.
 * Passed is true only when the reviewer passed the reply that shipped and the
 * review still stands against it. The reviewer rejecting that reply is false,
 * including a reply the host edited by deleting the claims a reviewer flagged
 * (the model's own answer failed). Everything else is unknown, never false:
 * no review, a review that failed open, a model judging its own work, a
 * delivered reply that is not the judged one, a verdict waiting on the owner,
 * a plan review, or a verdict the turn went on past.
 */
export function objectiveFromPublishedVerdict(
  ref: PublishedVerdictRef | undefined,
  verdictRow: Pick<EventRow, 'id' | 'data'> | null,
): Pick<SourceRouteVerdict, 'objectiveMet' | 'verdictEventId'> {
  if (!ref?.eventId || !verdictRow || String(verdictRow.id) !== ref.eventId) return {};
  const verdictEventId = ref.eventId;
  const data = verdictRow.data as Record<string, unknown>;
  if (ref.failedOpen === true || ref.selfJudge === true || ref.replyMatches !== true) return { verdictEventId };
  if (data.kind !== 'completion' || data.awaitingUser === true || data.planDigest !== undefined
    || data.continuation === true || data.failedOpen === true || data.selfJudge === true) return { verdictEventId };
  if (data.claimRemoval !== undefined) return { objectiveMet: false, verdictEventId };
  if (ref.fulfills === true && data.fulfills === true) {
    return ref.verified === true ? { objectiveMet: true, verdictEventId } : { verdictEventId };
  }
  if (ref.fulfills === false && data.fulfills === false) return { objectiveMet: false, verdictEventId };
  return { verdictEventId };
}

/** Outcomes that are neither landed nor failed: the call waits on the owner. */
const WAITING = new Set(['input_required']);

/**
 * Whether the turn's tool calls landed. A failure after dispatch is false and
 * outranks everything. A write whose outcome is uncertain makes the result
 * unknown, whatever its siblings did, and is counted. Otherwise true when
 * every dispatched call succeeded or honestly came back empty. A call the host
 * refused before dispatch never reached a tool and is not counted.
 */
export function toolSuccessFromSettlements(
  rows: ReadonlyArray<{ execution_kind: string; outcome_kind: string }>,
): Pick<SourceRouteVerdict, 'toolSuccess' | 'toolCalls' | 'uncertainWrites'> {
  const dispatched = rows.filter((row) => row.execution_kind !== 'refused_pre_dispatch' && !WAITING.has(row.outcome_kind));
  const uncertainWrites = dispatched.filter((row) => row.outcome_kind === 'uncertain_write').length;
  const known = dispatched.filter((row) => row.outcome_kind !== 'uncertain_write');
  const failed = known.some((row) => row.outcome_kind !== 'succeeded' && row.outcome_kind !== 'empty_result');
  if (failed) return { toolSuccess: false, toolCalls: known.length, uncertainWrites };
  if (uncertainWrites > 0 || known.length === 0) return { toolCalls: known.length, uncertainWrites };
  return { toolSuccess: true, toolCalls: known.length, uncertainWrites };
}

function sourceSettlements(identity: SourceIdentity, db: Database.Database): Array<{ execution_kind: string; outcome_kind: string }> {
  return db.prepare(`
    SELECT execution_kind, outcome_kind FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ?
  `).all(identity.sessionId, identity.sourceUserSeq) as Array<{ execution_kind: string; outcome_kind: string }>;
}

/** When the source was accepted, to bound the decision scan to its lifetime. */
function sourceAcceptedAt(identity: SourceIdentity): string | undefined {
  const [row] = listEvents(identity.sessionId, { sinceSeq: identity.sourceUserSeq - 1, limit: 1 });
  return row?.seq === identity.sourceUserSeq ? row.createdAt : undefined;
}

function readPublishedVerdictRef(terminal: Pick<EventRow, 'data'>): PublishedVerdictRef | undefined {
  const ref = (terminal.data as Record<string, unknown>).completionVerdictRef;
  return ref && typeof ref === 'object' ? ref as PublishedVerdictRef : undefined;
}

export interface RouteOutcomeJoin {
  decisionId?: string;
  verdict: SourceRouteVerdict;
  updated: boolean;
}

/**
 * Join one published terminal's verdict and tool result onto the brain
 * request that wrote the reviewed reply, in the terminal's own run attempt.
 * A terminal with no attempt, or nothing proven, changes nothing. Writing the
 * same verdict twice is a no-op, so a replayed terminal records once.
 */
export function joinRouteOutcomeVerdict(
  input: SourceIdentity & { terminal: Pick<EventRow, 'id' | 'data' | 'createdAt'> },
  deps: { metricsDb?: Database.Database; settlementsDb?: Database.Database } = {},
): RouteOutcomeJoin {
  const identity = { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq };
  const terminalData = input.terminal.data as Record<string, unknown>;
  const runAttemptId = typeof terminalData.attemptId === 'string' && terminalData.attemptId ? terminalData.attemptId : null;
  const ref = readPublishedVerdictRef(input.terminal);
  const verdictRow = ref?.eventId ? getEvent(ref.eventId) : null;
  // The work's own source: a terminal published under an approval answers for
  // the request that was approved, and that request's calls are its tools.
  const workSource = { sessionId: identity.sessionId,
    sourceUserSeq: Number.isSafeInteger(ref?.sourceUserSeq) && (ref?.sourceUserSeq ?? 0) > 0 ? ref!.sourceUserSeq! : identity.sourceUserSeq };
  const verdict: SourceRouteVerdict = {
    ...objectiveFromPublishedVerdict(ref, verdictRow),
    ...toolSuccessFromSettlements(sourceSettlements(workSource, deps.settlementsDb ?? openEventLog())),
  };
  const nothingProven = verdict.objectiveMet === undefined && verdict.toolSuccess === undefined && verdict.uncertainWrites === 0;
  if (!runAttemptId || nothingProven) return { verdict, updated: false };
  const decision = attemptRouteDecision({
    sessionId: identity.sessionId, runAttemptId, role: 'brain',
    since: sourceAcceptedAt(workSource) ?? sourceAcceptedAt(identity),
    until: verdictRow?.createdAt ?? input.terminal.createdAt,
  }, deps.metricsDb);
  if (!decision) return { verdict, updated: false };
  const updated = updateModelRouteOutcomeVerdict(decision.id, {
    objectiveMet: verdict.objectiveMet,
    toolSuccess: verdict.toolSuccess,
    toolCalls: verdict.toolCalls,
    basis: {
      sourceUserSeq: identity.sourceUserSeq,
      ...(workSource.sourceUserSeq !== identity.sourceUserSeq ? { workSourceUserSeq: workSource.sourceUserSeq } : {}),
      runAttemptId,
      terminalEventId: String(input.terminal.id),
      attemptRequests: decision.requests,
      ...(verdict.verdictEventId ? { verdictEventId: verdict.verdictEventId } : {}),
      ...(verdict.uncertainWrites > 0 ? { uncertainWrites: verdict.uncertainWrites } : {}),
    },
  }, deps.metricsDb);
  if (updated) recordJudged(identity, decision.id, 'brain', verdict);
  return { decisionId: decision.id, verdict, updated };
}

/**
 * A helper's own result is its signal: the request that wrote the helper's
 * answer, in the helper's own run attempt, records whether it came back with
 * a usable result.
 */
export function joinWorkerRouteOutcome(
  identity: SourceIdentity & { runAttemptId: string; usable: boolean },
  deps: { metricsDb?: Database.Database } = {},
): RouteOutcomeJoin {
  const verdict: SourceRouteVerdict = { toolSuccess: identity.usable, toolCalls: 0, uncertainWrites: 0 };
  const decision = attemptRouteDecision({ sessionId: identity.sessionId, runAttemptId: identity.runAttemptId,
    role: 'worker', since: sourceAcceptedAt(identity) }, deps.metricsDb);
  if (!decision) return { verdict, updated: false };
  const updated = updateModelRouteOutcomeVerdict(decision.id, {
    toolSuccess: identity.usable,
    basis: { sourceUserSeq: identity.sourceUserSeq, runAttemptId: identity.runAttemptId,
      workerResult: identity.usable ? 'usable' : 'unusable' },
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
      ...(verdict.uncertainWrites > 0 ? { uncertainWrites: verdict.uncertainWrites } : {}),
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
