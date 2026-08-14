/**
 * Read-only terminal audit for one exact accepted source.
 *
 * Callers may propose presentation or workflow state, but only the normalized
 * logical/physical ledgers and the write-evidence ledger can say whether work
 * is still running, failed without recovery, or may have committed. This
 * module deliberately does not infer anything from model prose, SDK tool-use
 * summaries, or transport mirrors. The Claude SDK's canonical top-level
 * `tool_returned` row is different: it is written by the host at the exact
 * result boundary and carries the host's successful-business verdict or the
 * registry-authorized successful-authoring verdict.
 */
import { listEvents, openEventLog, type EventRow } from './eventlog.js';
import { resolveWriteEvidence } from './work-report.js';

export type AcceptedSourceSettlementAuditStatus =
  | 'clean'
  | 'in_flight'
  | 'uncertain_write'
  | 'unrecovered_failure'
  | 'no_business_evidence'
  | 'storage_error';

/** Durable identity by which one successful business settlement may repair a
 * failed one. Expected-work requirements outrank carrier shape; legacy calls
 * without that binding fall back to their exact normalized callable contract. */
export type AcceptedSourceSettlementRecoveryIdentity =
  | { kind: 'requirement'; requirementId: string }
  | {
    kind: 'call';
    logicalToolCallId: string;
    toolName: string;
    /** Accepted-task-salted. Safe for same-source corrected-call matching;
     * cross-source reconciliation uses the durable logical call id instead. */
    argumentDigest: string;
  };

export interface AcceptedSourceSettlementAudit {
  status: AcceptedSourceSettlementAuditStatus;
  reason: string;
  facts: {
    openLogicalCalls: number;
    conflictingLogicalCalls: number;
    startedDispatches: number;
    businessSettlements: number;
    successfulBusinessSettlements: number;
    /** Successful business results observed at the Claude SDK's exact host
     * return boundary. These tools do not traverse the logical-settlement
     * ledger, so omitting them makes a worked Claude turn look empty. */
    successfulSdkBusinessResults: number;
    /** Successful user-deliverable authoring results observed at the same
     * canonical host boundary. Registry metadata—not SDK profile membership
     * or model tool-use summaries—defines this deliberately tiny class. */
    successfulSdkAuthoringResults: number;
    unrecoveredBusinessFailures: number;
    confirmedWrites: number;
    uncertainWrites: number;
    /** The subset of uncertain writes whose ambiguity is worth vetoing a turn
     * over: the host could not classify the effect as reversible. */
    blockingUncertainWrites: number;
    successfulBusinessIdentities: AcceptedSourceSettlementRecoveryIdentity[];
    unrecoveredBusinessFailureIdentities: AcceptedSourceSettlementRecoveryIdentity[];
  };
}

interface SettlementRow {
  logical_tool_call_id: string;
  tool_name: string;
  argument_digest: string;
  outcome_kind: string;
  execution_kind: string;
  mutating: number;
  requirement_id: string | null;
}

function boundedReason(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 240);
}

function writeCallId(event: EventRow): string {
  const canonical = event.data.canonicalCallId;
  if (typeof canonical === 'string' && canonical.trim()) return canonical.trim();
  const legacy = event.data.callId;
  return typeof legacy === 'string' ? legacy.trim() : '';
}

function turnEventsForAcceptedSource(sessionId: string, sourceUserSeq: number): EventRow[] {
  const events = listEvents(sessionId, { sinceSeq: sourceUserSeq - 1 });
  const source = events.find((event) => event.seq === sourceUserSeq && event.type === 'user_input_received');
  if (!source) throw new Error('accepted source event is missing');
  const nextSource = events.find((event) => event.seq > sourceUserSeq && event.type === 'user_input_received');
  const sourceWindow = events.filter(
    (event) => event.seq >= sourceUserSeq && (!nextSource || event.seq < nextSource.seq),
  );

  // A user-input boundary does not end the lifetime of a physical write. Crash
  // recovery or an explicit reconciliation turn can settle the exact durable
  // reservation later. Carry only resolutions whose canonical call id belongs
  // to this source window; never borrow a sibling source's similarly-shaped
  // write. Legacy reservations without an exact id remain window-scoped and
  // fail closed because cross-source shape/target matching is not authority.
  const sourceWriteCallIds = new Set(
    sourceWindow
      .filter((event) => event.type === 'external_write' && event.data.preDispatch === true)
      .map(writeCallId)
      .filter(Boolean),
  );
  if (!nextSource || sourceWriteCallIds.size === 0) return sourceWindow;
  const exactLaterResolutions = events.filter((event) =>
    event.seq >= nextSource.seq
    && (
      event.type === 'external_write_succeeded'
      || event.type === 'external_write_failed'
      || event.type === 'external_write_orphaned'
    )
    && sourceWriteCallIds.has(writeCallId(event)),
  );
  return [...sourceWindow, ...exactLaterResolutions];
}

/**
 * Does this ambiguous write deserve to veto the whole turn?
 *
 * An uncertain write is always REPORTED — the work report renders every one of
 * them as a caveat. The question here is narrower: may it also refuse delivery
 * of everything else the source accomplished? Only when the effect is not
 * provably reversible. The danger an uncertain write guards against is a
 * duplicated or half-applied change the user cannot undo; a reversible one is a
 * disclosure, not a hazard.
 *
 * Live case (2026-08-12): a business-hours Slack review read every channel,
 * updated its tracking sheet, and finished — but one GOOGLESHEETS_INSERT_DIMENSION
 * came back HTTP 400 invalid_arguments, which parks as ambiguous because a
 * provider may commit before returning a 4xx. The model then REPAIRED the
 * arguments and the insert succeeded. The reversible ambiguity nonetheless
 * vetoed the terminal, so the user received none of the review. Reversibility
 * is the same predicate that decides off-plan work in the expected-work matcher;
 * an unclassified write still fails closed here.
 */
function uncertainWriteVetoesDelivery(event: EventRow): boolean {
  return event.data.irreversible !== false;
}

interface ReversibleWriteShape {
  /** Write shape plus its exact target set: the same action on the same
   * resource. Two inserts into one spreadsheet share this key; an insert into a
   * different spreadsheet does not. */
  shapeTargetKey: string;
  seq: number;
}

/**
 * Index the source's reversible write reservations by their logical call id.
 *
 * Only the host's own pre-dispatch reservation rows are read, so nothing the
 * model says can enter this index, and an unclassified or irreversible write is
 * deliberately absent — those keep the strict exact-argument recovery rule.
 */
function reversibleWriteShapeIndex(events: readonly EventRow[]): Map<string, ReversibleWriteShape> {
  const index = new Map<string, ReversibleWriteShape>();
  for (const event of events) {
    if (event.type !== 'external_write' || event.data.irreversible !== false) continue;
    const callId = writeCallId(event);
    if (!callId) continue;
    const shape = event.data.shapeKey;
    if (typeof shape !== 'string' || !shape.trim()) continue;
    const targets = Array.isArray(event.data.targets)
      ? event.data.targets
        .filter((target): target is string => typeof target === 'string' && target.trim().length > 0)
        .map((target) => target.trim().toLowerCase())
        .sort()
      : [];
    index.set(callId, {
      shapeTargetKey: JSON.stringify([shape.trim().toLowerCase(), targets]),
      seq: event.seq,
    });
  }
  return index;
}

function succeeded(row: SettlementRow): boolean {
  return row.outcome_kind === 'succeeded'
    || (row.outcome_kind === 'empty_result' && row.mutating === 0);
}

function recoveryIdentity(row: SettlementRow): AcceptedSourceSettlementRecoveryIdentity {
  return row.requirement_id
    ? { kind: 'requirement', requirementId: row.requirement_id }
    : {
      kind: 'call',
      logicalToolCallId: row.logical_tool_call_id,
      toolName: row.tool_name,
      argumentDigest: row.argument_digest,
    };
}

function recoveryIdentityKey(identity: AcceptedSourceSettlementRecoveryIdentity): string {
  return identity.kind === 'requirement'
    ? JSON.stringify(['requirement', identity.requirementId])
    // Within one accepted source the task salt is identical, so exact
    // tool+argument digest is stronger than a sibling call id.
    : JSON.stringify(['call', identity.toolName, identity.argumentDigest]);
}

/**
 * Audit one source without changing any authority state.
 *
 * A prior failed candidate is considered recovered only by a successful call
 * bound to the same requirement. Legacy/unbound histories require the exact
 * normalized tool + argument digest; an unrelated success can never erase a
 * failure. `uncertain_write` is never cleared this way; it requires
 * write-ledger reconciliation.
 */
export function auditAcceptedSourceSettlementTruth(input: {
  sessionId: string;
  sourceUserSeq: number;
  requiresBusinessEvidence?: boolean;
  /**
   * Scheduled/workflow source steps declare every business read in the step as
   * load-bearing.  In that lane, one successful query must not launder a
   * sibling failed query into a clean aggregate.  Interactive chat keeps the
   * historical exploratory-read recovery rule unless the caller opts in.
   */
  requireEveryBusinessReadToSettle?: boolean;
}): AcceptedSourceSettlementAudit {
  const emptyFacts: AcceptedSourceSettlementAudit['facts'] = {
    openLogicalCalls: 0,
    conflictingLogicalCalls: 0,
    startedDispatches: 0,
    businessSettlements: 0,
    successfulBusinessSettlements: 0,
    successfulSdkBusinessResults: 0,
    successfulSdkAuthoringResults: 0,
    unrecoveredBusinessFailures: 0,
    confirmedWrites: 0,
    uncertainWrites: 0,
    blockingUncertainWrites: 0,
    successfulBusinessIdentities: [],
    unrecoveredBusinessFailureIdentities: [],
  };
  try {
    const db = openEventLog();
    // A CALL THAT NEVER CROSSED IS NOT IN FLIGHT. `open` means the runtime
    // opened the call and never recorded its outcome, which for a call with at
    // least one physical dispatch is genuine ambiguity — something left the
    // house and may still be running. With ZERO crossings nothing was ever
    // sent, so the open row is an abandoned bookkeeping entry, not work in
    // progress. Refusal paths are the usual author: a permission callback that
    // denies after the provider's tool_called already opened the call strands
    // it, and one stranded row held an entire completed source `in_flight`
    // (live 2026-08-12, a denied free `composio_search_tools` withheld a
    // finished Apify pull and a created sheet). Genuinely running work is still
    // caught by `startedDispatches` below.
    const logical = db.prepare(`
      SELECT
        SUM(CASE WHEN state = 'open' AND EXISTS (
              SELECT 1 FROM physical_dispatches p
               WHERE p.session_id = l.session_id
                 AND p.source_user_seq = l.source_user_seq
                 AND p.logical_tool_call_id = l.logical_tool_call_id
            ) THEN 1 ELSE 0 END) AS open_calls,
        SUM(CASE WHEN state = 'conflict' THEN 1 ELSE 0 END) AS conflict_calls
      FROM logical_tool_calls l
      WHERE session_id = ? AND source_user_seq = ?
    `).get(input.sessionId, input.sourceUserSeq) as {
      open_calls: number | null;
      conflict_calls: number | null;
    };
    const dispatch = db.prepare(`
      SELECT COUNT(*) AS started_dispatches
      FROM physical_dispatches
      WHERE session_id = ? AND source_user_seq = ? AND state = 'started'
    `).get(input.sessionId, input.sourceUserSeq) as { started_dispatches: number };
    const settlements = db.prepare(`
      SELECT s.logical_tool_call_id, l.tool_name, l.argument_digest,
             s.outcome_kind, s.execution_kind, s.mutating, s.requirement_id
      FROM logical_call_settlements s
      JOIN logical_tool_calls l
        ON l.session_id = s.session_id
       AND l.source_user_seq = s.source_user_seq
       AND l.logical_tool_call_id = s.logical_tool_call_id
      WHERE s.session_id = ? AND s.source_user_seq = ?
        AND s.business_call = 1 AND s.continues_requirement = 0
    `).all(input.sessionId, input.sourceUserSeq) as SettlementRow[];

    const turnEvents = turnEventsForAcceptedSource(input.sessionId, input.sourceUserSeq);
    const successfulSdkBusinessResults = turnEvents.filter((event) =>
      event.type === 'tool_returned'
      && event.data.accounting === 'top_level'
      && event.data.sourceUserSeq === input.sourceUserSeq
      && event.data.successfulBusinessResult === true).length;
    const successfulSdkAuthoringResults = turnEvents.filter((event) =>
      event.type === 'tool_returned'
      && event.data.accounting === 'top_level'
      && event.data.sourceUserSeq === input.sourceUserSeq
      && event.data.successfulAuthoringResult === true).length;
    const reversibleWrites = reversibleWriteShapeIndex(turnEvents);
    const successful = settlements.filter(succeeded);
    const successfulIdentities = successful.map(recoveryIdentity);
    const successfulIdentityKeys = new Set(successfulIdentities.map(recoveryIdentityKey));
    const repairedReversibleWrites = successful
      .map((row) => reversibleWrites.get(row.logical_tool_call_id))
      .filter((entry): entry is ReversibleWriteShape => entry !== undefined);
    const failed = settlements.filter((row) => !succeeded(row));
    const uncertainSettlements = failed.filter((row) => row.outcome_kind === 'uncertain_write');
    // A logical uncertain-write outcome is only a delivery veto when the host
    // could not prove the underlying effect reversible. The external-write
    // reservation is the authority for that classification; a settlement for
    // a call present in the reversible index remains a reportable failure, but
    // it is not the one deterministic reason to make a human inspect state.
    const blockingUncertainSettlements = uncertainSettlements.filter(
      (row) => !reversibleWrites.has(row.logical_tool_call_id),
    );
    const unrecovered = failed.filter((row) => {
      if (row.outcome_kind === 'uncertain_write') return true;
      // A REFUSAL IS NOT A FAILED EFFECT. `refused_pre_dispatch` means the
      // harness blocked the call before it crossed the boundary: no request was
      // sent, no external state moved, nothing exists to reconcile — and this
      // gate exists solely to reconcile external state. Treating a refusal as
      // an unrecovered failure makes Clementine's own guardrails the reason she
      // cannot report (live 2026-08-12: a pre-dispatch policy denial on
      // GOOGLESHEETS_CREATE, immediately followed by the same sheet being
      // created successfully through another carrier, still blocked the turn).
      // Work the refusal actually prevented remains visible to the
      // expected-work gates, which judge coverage rather than blame.
      if (row.execution_kind === 'refused_pre_dispatch') return false;
      // A FAILED READ THAT WAS WORKED AROUND IS NOT AN UNRECOVERED FAILURE.
      // Recovery identity is the exact call (requirement, or tool+arguments),
      // so trying a query, having it rejected, and getting the same facts from
      // a DIFFERENT query never registers as recovery — which is precisely how
      // exploration works. A live Slack workflow that had run for days with a
      // few rejected SOQL shapes among its dozen queries began blocking the
      // moment failed shell reads started classifying as failures: 9 of 12
      // queries returned the data, 3 were malformed, and the run refused to
      // post anything (2026-08-12). A read that returned nothing is already
      // visible as missing evidence to the terminal gates; it does not need to
      // veto the turn as well. MUTATIONS keep the strict rule — a write that
      // failed and was never redone is exactly what this audit is for.
      //
      // The exemption is earned, not free: it applies only when this source
      // actually completed OTHER business work. A source whose every business
      // call failed has no story but the failure, so it still blocks (that is
      // the case where chronology must never pass for recovery).
      if (
        row.mutating === 0
        && successful.length > 0
        && input.requireEveryBusinessReadToSettle !== true
      ) return false;
      // A REPAIRED WRITE IS A RECOVERED WRITE. Recovery identity is the exact
      // argument digest, so fixing the arguments the provider rejected produces
      // a different identity and never registers as recovery — which is exactly
      // what repair does. The same live Slack review lost its whole report to
      // this: GOOGLESHEETS_INSERT_DIMENSION was refused with HTTP 400, the model
      // corrected the arguments, and the very next insert into the same
      // spreadsheet succeeded. Recovery here means a LATER success of the same
      // write shape against the same target, and only for an effect the host
      // classified reversible — a rejected irreversible send is never repaired
      // by a different send.
      const attempted = reversibleWrites.get(row.logical_tool_call_id);
      if (attempted && repairedReversibleWrites.some((done) =>
        done.shapeTargetKey === attempted.shapeTargetKey && done.seq > attempted.seq)) return false;
      return !successfulIdentityKeys.has(recoveryIdentityKey(recoveryIdentity(row)));
    });

    const writeEvidence = resolveWriteEvidence(turnEvents);
    const facts: AcceptedSourceSettlementAudit['facts'] = {
      openLogicalCalls: logical.open_calls ?? 0,
      conflictingLogicalCalls: logical.conflict_calls ?? 0,
      startedDispatches: dispatch.started_dispatches,
      businessSettlements: settlements.length,
      successfulBusinessSettlements: successful.length,
      successfulSdkBusinessResults,
      successfulSdkAuthoringResults,
      unrecoveredBusinessFailures: unrecovered.length,
      confirmedWrites: writeEvidence.confirmed.length,
      uncertainWrites: writeEvidence.uncertain.length,
      blockingUncertainWrites: Math.max(
        writeEvidence.uncertain.filter(uncertainWriteVetoesDelivery).length,
        blockingUncertainSettlements.length,
      ),
      successfulBusinessIdentities: successfulIdentities,
      unrecoveredBusinessFailureIdentities: unrecovered.map(recoveryIdentity),
    };

    if (facts.conflictingLogicalCalls > 0) {
      return { status: 'storage_error', reason: 'logical-call authority is conflicted', facts };
    }
    if (facts.openLogicalCalls > 0 || facts.startedDispatches > 0) {
      return {
        status: 'in_flight',
        reason: `${facts.openLogicalCalls} logical call(s) and ${facts.startedDispatches} dispatch(es) remain open`,
        facts,
      };
    }
    if (facts.blockingUncertainWrites > 0) {
      return {
        status: 'uncertain_write',
        reason: `${facts.blockingUncertainWrites} irreversible external write(s) require reconciliation`,
        facts,
      };
    }
    if (facts.unrecoveredBusinessFailures > 0) {
      return {
        status: 'unrecovered_failure',
        reason: `${facts.unrecoveredBusinessFailures} business call failure(s) have no successful recovery`,
        facts,
      };
    }
    if (
      input.requiresBusinessEvidence === true
      && facts.successfulBusinessSettlements === 0
      && facts.successfulSdkBusinessResults === 0
      && facts.successfulSdkAuthoringResults === 0
      && facts.confirmedWrites === 0
    ) {
      return {
        status: 'no_business_evidence',
        reason: 'no completed business settlement or confirmed write exists for this accepted source',
        facts,
      };
    }
    return { status: 'clean', reason: 'settlement spine is reconciled', facts };
  } catch (error) {
    return {
      status: 'storage_error',
      reason: `settlement audit could not read durable authority: ${boundedReason(error)}`,
      facts: emptyFacts,
    };
  }
}
