import { isLiveApprovalAcknowledgement } from './accepted-source-kind.js';
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
import { createHash } from 'node:crypto';
import { classifyRuntimeToolEffect } from './tool-effect.js';
import { classifyExternalWrite } from './confirm-first-gate.js';
import { parseCurrentManifestRecoverySemantics } from './current-manifest-operation-semantics.js';
import { listEvents, openEventLog, type EventRow } from './eventlog.js';
import { extractExternalWriteIdentityKeys } from './grounding-gate.js';
import { catalogOperationIdentitiesEqual } from './runtime-tool-identity.js';
import { resolveWriteEvidence } from './work-report.js';

export type AcceptedSourceSettlementAuditStatus =
  | 'clean'
  | 'in_flight'
  | 'uncertain_write'
  | 'write_projection_missing'
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
    /** Successful settlements of MUTATING calls that are not business calls:
     * the task ledger, memory, a notification, a Workspace write. A declared
     * write/send step whose work is local has its evidence here (live
     * 2026-09-01: end-of-day, 18 prior successes on the SDK lane, blocked on
     * the host lane as "no business evidence" after completing every step). */
    successfulLocalMutations: number;
    /** Successful non-mutating settlements (business or local). A declared
     * write step that READ and found nothing to change is complete when its
     * output satisfies its contract and no mutation was ever attempted
     * (weekly-review with zero active goals, 2026-09-01). */
    successfulReads: number;
    /** Mutating settlements of any outcome: the step tried to change
     * something. Present → "found nothing to change" can never apply. */
    attemptedMutations: number;
    unrecoveredBusinessFailures: number;
    confirmedWrites: number;
    /** Successful direct host provider mutations which require one exact
     * confirmed hostOwnedExternal reservation/terminal projection. */
    requiredHostExternalWriteProjections: number;
    /** Required direct-host successes without exactly one matching confirmed
     * reservation. Any non-zero value is a terminal audit blocker. */
    missingHostExternalWriteProjections: number;
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

function directHostPhysicalId(input: {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
}): string {
  const digest = createHash('sha256').update(JSON.stringify({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    modelCallId: input.logicalToolCallId,
  })).digest('hex');
  return `dispatch:host:v1:${digest}`;
}

function acceptedTaskAttributionIsCompatible(
  event: EventRow,
  acceptedTaskId: string,
): boolean {
  // Current producers stamp the canonical task id. The first shared-wrapper
  // projection release stamped only the exact source sequence, so absence is
  // a bounded compatibility case; a conflicting present task id is never
  // allowed to cross a later user-input boundary.
  return event.data.acceptedTaskId === undefined
    || event.data.acceptedTaskId === acceptedTaskId;
}

function turnEventsForAcceptedSource(sessionId: string, sourceUserSeq: number): EventRow[] {
  const events = listEvents(sessionId, { sinceSeq: sourceUserSeq - 1 });
  const source = events.find((event) => event.seq === sourceUserSeq && event.type === 'user_input_received');
  if (!source) throw new Error('accepted source event is missing');
  const nextSource = events.find((event) => event.seq > sourceUserSeq && event.type === 'user_input_received' && !isLiveApprovalAcknowledgement(event));
  const acceptedTaskId = `task:${sessionId}#${sourceUserSeq}`;
  const chronologicalSourceWindow = events.filter(
    (event) => event.seq >= sourceUserSeq && (!nextSource || event.seq < nextSource.seq),
  );
  const reservationById = new Map(events
    .filter((event) => event.type === 'external_write')
    .map((event) => [event.id, event]));
  const belongsToAcceptedSource = (event: EventRow): boolean => (
    event.data.sourceUserSeq === undefined
    || (
      event.data.sourceUserSeq === sourceUserSeq
      && acceptedTaskAttributionIsCompatible(event, acceptedTaskId)
    )
  );
  const sourceWindow = chronologicalSourceWindow.filter((event) => {
    // Any current event which names an accepted source belongs only to that
    // source. Chronology remains a compatibility fallback solely for legacy
    // rows without source attribution; otherwise late A tool/accounting rows
    // could be borrowed by newest source B when SDK call ids are reused.
    if (!belongsToAcceptedSource(event)) return false;
    if (event.type === 'external_write') return true;
    if (
      event.type !== 'external_write_succeeded'
      && event.type !== 'external_write_failed'
      && event.type !== 'external_write_orphaned'
    ) return true;
    if (!event.parentEventId) return true;
    const parent = reservationById.get(event.parentEventId);
    // A parented terminal can belong to this accepted source only through its
    // exact reservation. A missing parent necessarily predates this source's
    // sinceSeq window and must not be borrowed chronologically.
    return parent !== undefined && belongsToAcceptedSource(parent);
  });

  // A user-input boundary does not end the lifetime of a physical write. A
  // concurrent source can arrive before this source's host-owned reservation
  // is appended, so reopen later reservations only from their exact accepted
  // source/task attribution. Legacy unattributed reservations remain confined
  // to the chronological source window.
  if (!nextSource) return sourceWindow;
  const windowReservations = sourceWindow
    .filter((event) => event.type === 'external_write' && event.data.preDispatch === true);
  const exactLaterReservations = events.filter((event) => (
    event.seq >= nextSource.seq
    && event.type === 'external_write'
    && event.data.preDispatch === true
    && event.data.sourceUserSeq === sourceUserSeq
    && acceptedTaskAttributionIsCompatible(event, acceptedTaskId)
  ));
  const sourceReservations = [...windowReservations, ...exactLaterReservations];
  const sourceReservationIds = new Set(sourceReservations.map((event) => event.id));
  const legacyWindowWriteCallIds = new Set(windowReservations
    .filter((event) => event.data.sourceUserSeq === undefined)
    .map(writeCallId)
    .filter(Boolean));
  const callIds = [...legacyWindowWriteCallIds];
  const ownerRows = callIds.length === 0
    ? []
    : openEventLog().prepare(`
      SELECT COALESCE(
               NULLIF(TRIM(json_extract(data_json, '$.canonicalCallId')), ''),
               NULLIF(TRIM(json_extract(data_json, '$.callId')), '')
             ) AS call_id,
             COUNT(*) AS owner_count
        FROM events
       WHERE session_id = ? AND type = 'external_write'
         AND json_extract(data_json, '$.preDispatch') = 1
         AND COALESCE(
               NULLIF(TRIM(json_extract(data_json, '$.canonicalCallId')), ''),
               NULLIF(TRIM(json_extract(data_json, '$.callId')), '')
             ) IN (${callIds.map(() => '?').join(', ')})
       GROUP BY call_id
    `).all(sessionId, ...callIds) as Array<{ call_id: string; owner_count: number }>;
  const reservationOwnerCountByCallId = new Map(
    ownerRows.map((row) => [row.call_id, row.owner_count]),
  );
  const exactLaterResolutions = events.filter((event) =>
    event.seq >= nextSource.seq
    && (
      event.type === 'external_write_succeeded'
      || event.type === 'external_write_failed'
      || event.type === 'external_write_orphaned'
    )
    && (
      // Current terminals name the exact reservation and repeat the accepted
      // source attribution. A later source reusing the SDK call id therefore
      // cannot inject its orphan/failure into this source's audit window.
      (Boolean(event.parentEventId)
        && sourceReservationIds.has(event.parentEventId ?? '')
        && event.data.sourceUserSeq === sourceUserSeq
        && acceptedTaskAttributionIsCompatible(event, acceptedTaskId))
      // Historical unparented terminals have only a call id. Preserve that
      // compatibility solely when one reservation in the entire observed
      // history owns the id and that reservation belongs to this source.
      || (!event.parentEventId
        && legacyWindowWriteCallIds.has(writeCallId(event))
        && reservationOwnerCountByCallId.get(writeCallId(event)) === 1)
    ),
  );
  return [...sourceWindow, ...exactLaterReservations, ...exactLaterResolutions];
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
function modelVisibleArguments(event: EventRow): unknown {
  const raw = event.data.arguments;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function reversibleWriteShapeIndex(
  events: readonly EventRow[],
  settlements: readonly SettlementRow[],
): Map<string, ReversibleWriteShape> {
  const index = new Map<string, ReversibleWriteShape>();
  for (const event of events) {
    if (
      event.type !== 'external_write'
      || event.data.irreversible !== false
      // A host-owned provider reservation may carry `false` only because an
      // unknown operation had no positive irreversible classification. That
      // is not proof of reversibility. These calls qualify solely through the
      // exact tool_called + durable recoverySemantics authority below.
      || event.data.hostOwnedExternal === true
    ) continue;
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

  // The host-v1 lane owns provider dispatch directly and therefore does not
  // traverse brackets.ts's legacy `external_write` reservation emitter. Its
  // exact `tool_called` event is nevertheless host-authored at the same
  // accepted-source boundary and carries the effective operation, canonical
  // call id, and model-visible arguments. Materialize the same reversible
  // shape/target identity from that boundary so a corrected host call is not
  // declared unrecovered merely because it used the newer execution lane.
  //
  // Fail closed: synthesize only for a settlement already classified as a
  // mutation, only when the call event durably carries positive current-
  // manifest repair authority, and only when an explicit resource target is
  // extractable. Irreversible/unknown/ambient-destination writes retain exact
  // call identity and can never be laundered by a later success.
  const settlementByCallId = new Map(settlements.map((row) => [row.logical_tool_call_id, row]));
  for (const event of events) {
    if (event.type !== 'tool_called') continue;
    const callId = writeCallId(event);
    if (!callId || index.has(callId)) continue;
    const row = settlementByCallId.get(callId);
    if (!row || row.mutating !== 1) continue;
    const args = modelVisibleArguments(event);
    // Positive recovery semantics are captured durably while the exact
    // selected capability manifest and reconcile port are current.
    // Recomputing them here is unsound: terminal publication may run in a fresh
    // process where the catalog singleton is absent. Legacy explicitly-
    // reversible rows remain valid; a durable exact-artifact reconciliation
    // contract is equally authoritative for a provider-rejected call. Neither
    // an irreversible declaration nor a missing/malformed contract qualifies.
    const recovery = parseCurrentManifestRecoverySemantics(event.data.recoverySemantics);
    const eventOperation = typeof event.data.effectiveTool === 'string'
      ? event.data.effectiveTool
      : typeof event.data.toolSlug === 'string'
        ? event.data.toolSlug
        : '';
    const hasDurableRepairAuthority = event.data.reversibility === 'reversible'
      || Boolean(
        event.data.reversibility !== 'irreversible'
        && recovery
        && eventOperation
        && catalogOperationIdentitiesEqual(recovery.operationId, eventOperation),
      );
    if (!hasDurableRepairAuthority || event.data.effect !== 'external_write') continue;
    const carrier = typeof event.data.tool === 'string' ? event.data.tool : row.tool_name;
    const shape = classifyExternalWrite(carrier, args);
    if (!shape.external || !shape.mutating || !shape.shapeKey) continue;
    const targets = extractExternalWriteIdentityKeys(args)
      .map((target) => target.trim().toLowerCase())
      .filter(Boolean)
      .sort();
    if (targets.length === 0) continue;
    index.set(callId, {
      shapeTargetKey: JSON.stringify([shape.shapeKey.trim().toLowerCase(), targets]),
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
    successfulLocalMutations: 0,
    successfulReads: 0,
    attemptedMutations: 0,
    unrecoveredBusinessFailures: 0,
    confirmedWrites: 0,
    requiredHostExternalWriteProjections: 0,
    missingHostExternalWriteProjections: 0,
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
    // Local mutations are evidence of declared work too. The business-only
    // filter above made a send/write step whose tools are all local (task
    // hygiene, memory, notify_user) unprovable on the host lane, while the
    // SDK lane's own `successfulAuthoringResult` marker let the identical
    // step pass — a brain-dependent gate.
    const localSettlements = db.prepare(`
      SELECT s.logical_tool_call_id, l.tool_name, l.argument_digest,
             s.outcome_kind, s.execution_kind, s.mutating, s.requirement_id
      FROM logical_call_settlements s
      JOIN logical_tool_calls l
        ON l.session_id = s.session_id
       AND l.source_user_seq = s.source_user_seq
       AND l.logical_tool_call_id = s.logical_tool_call_id
      WHERE s.session_id = ? AND s.source_user_seq = ?
        AND s.business_call = 0 AND s.continues_requirement = 0
    `).all(input.sessionId, input.sourceUserSeq) as SettlementRow[];
    // The invocation seam records host_only calls (notify_user,
    // memory_remember, plan_task) as non-mutating for lease recovery; for
    // EVIDENCE they are the mutation the step declared. One classifier, no
    // second vocabulary: ask the registry what the tool's effect is.
    const localMutates = (row: SettlementRow): boolean => {
      if (row.mutating === 1) return true;
      try {
        const effect = classifyRuntimeToolEffect(row.tool_name, {}).effect;
        return effect === 'host_only' || effect === 'local_write' || effect === 'external_write' || effect === 'admin';
      } catch {
        return false;
      }
    };
    const localMutations = localSettlements.filter(localMutates);

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
    const reversibleWrites = reversibleWriteShapeIndex(turnEvents, settlements);
    const writeEvidence = resolveWriteEvidence(turnEvents);
    type RequiredHostExternalWriteProjection = {
      logical_tool_call_id: string;
      accepted_task_id: string;
      physical_dispatch_id: string;
    };
    // A successful direct host provider mutation is not complete audit truth
    // until the write ledger confirms that exact logical/physical crossing.
    // Derive requirements from normalized immutable authority—not event
    // presence—so an unrelated confirmed write cannot cover a missing one.
    const requiredHostExternalWriteProjections = db.prepare(`
      SELECT settlement.logical_tool_call_id,
             binding.accepted_task_id,
             physical.physical_dispatch_id
        FROM logical_call_settlements settlement
        JOIN host_call_capability_bindings binding
          ON binding.session_id = settlement.session_id
         AND binding.source_user_seq = settlement.source_user_seq
         AND binding.logical_tool_call_id = settlement.logical_tool_call_id
        JOIN physical_dispatches physical
          ON physical.session_id = settlement.session_id
         AND physical.source_user_seq = settlement.source_user_seq
         AND physical.logical_tool_call_id = settlement.logical_tool_call_id
       WHERE settlement.session_id = ? AND settlement.source_user_seq = ?
         AND settlement.outcome_kind = 'succeeded'
         AND settlement.execution_kind = 'provider_execution'
         AND settlement.mutating = 1
         AND settlement.physical_crossing_count = 1
         AND settlement.result_handle_id IS NOT NULL
         AND binding.root_authority_kind = 'host_v1'
         AND binding.binding_kind = 'catalog_manifest'
         AND binding.effect IN ('external_write', 'admin')
         AND physical.ordinal = 1
         AND physical.relation = 'primary'
         AND physical.execution_site IS NULL
         -- A null execution_site means provider-side, not direct-host.
         -- Nested SDK/carrier owners also record provider rows with a null
         -- execution site and already project their write lifecycle through
         -- brackets.ts. Only the deterministic direct-host id belongs to the
         -- additional hostOwnedExternal coverage invariant below.
         AND physical.physical_dispatch_id LIKE 'dispatch:host:v1:%'
         AND physical.state = 'returned'
    `).all(
      input.sessionId,
      input.sourceUserSeq,
    ) as RequiredHostExternalWriteProjection[];
    const missingHostExternalWriteProjections = requiredHostExternalWriteProjections.filter((required) => {
      const expectedPhysicalDispatchId = directHostPhysicalId({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        logicalToolCallId: required.logical_tool_call_id,
      });
      if (required.physical_dispatch_id !== expectedPhysicalDispatchId) return true;
      const matches = writeEvidence.confirmed.filter((reservation) => (
        reservation.data.preDispatch === true
        && reservation.data.hostOwnedExternal === true
        && reservation.data.sourceUserSeq === input.sourceUserSeq
        && reservation.data.acceptedTaskId === required.accepted_task_id
        && writeCallId(reservation) === required.logical_tool_call_id
        && reservation.data.physicalDispatchId === required.physical_dispatch_id
        && typeof reservation.data.projectionKey === 'string'
        && reservation.data.projectionKey.startsWith('external-write-reservation:')
      ));
      if (matches.length !== 1) return true;
      const reservation = matches[0]!;
      const exactSuccesses = turnEvents.filter((terminal) => (
        terminal.type === 'external_write_succeeded'
        && terminal.parentEventId === reservation.id
        && terminal.data.sourceUserSeq === input.sourceUserSeq
        && terminal.data.acceptedTaskId === required.accepted_task_id
        && writeCallId(terminal) === required.logical_tool_call_id
        && terminal.data.physicalDispatchId === required.physical_dispatch_id
        && (
          terminal.data.decisiveProjectionKey === `external-write-decisive:${reservation.id}`
          // Exact compatibility for the brief v76 combined terminal CAS. Its
          // unique key made success/failure mutually exclusive; v77 split the
          // orphan and decisive domains so read-back can resolve ambiguity.
          || terminal.data.terminalProjectionKey === `external-write-terminal:${reservation.id}`
        )
      ));
      return exactSuccesses.length !== 1;
    });
    // `resolveWriteEvidence` accepts only a terminal for the exact reservation
    // call. A later similar write is not reconciliation: it may be a duplicate.
    // Both proved-present and proved-absent readback terminals remove the
    // reservation from uncertainty; expected-work/business-evidence gates then
    // decide whether an absent effect still needs a real retry.
    const reservationCountByCallId = new Map<string, number>();
    for (const event of turnEvents) {
      if (event.type !== 'external_write' || event.data.preDispatch !== true) continue;
      const callId = writeCallId(event);
      if (!callId) continue;
      reservationCountByCallId.set(callId, (reservationCountByCallId.get(callId) ?? 0) + 1);
    }
    const resolvedWriteCallIds = new Set(
      [...writeEvidence.confirmed, ...writeEvidence.failed]
        .map(writeCallId)
        .filter((callId) => Boolean(callId) && reservationCountByCallId.get(callId) === 1),
    );
    const successful = settlements.filter(succeeded);
    const successfulIdentities = successful.map(recoveryIdentity);
    const successfulIdentityKeys = new Set(successfulIdentities.map(recoveryIdentityKey));
    const repairedReversibleWrites = successful
      .map((row) => reversibleWrites.get(row.logical_tool_call_id))
      .filter((entry): entry is ReversibleWriteShape => entry !== undefined);
    const failed = settlements.filter((row) => !succeeded(row));
    const uncertainSettlements = failed.filter((row) => row.outcome_kind === 'uncertain_write');
    // Logical ambiguity clears only when the exact reservation has a durable
    // terminal. Reversibility means the host can repair after readback; it does
    // not prove whether the original effect happened.
    const blockingUncertainSettlements = uncertainSettlements.filter(
      (row) => !resolvedWriteCallIds.has(row.logical_tool_call_id),
    );
    const unrecovered = failed.filter((row) => {
      // An acknowledged-false mutation is consequential regardless of its
      // namespace or reversibility. Only the exact reservation's terminal
      // reconciliation may discharge its ambiguity.
      if (row.outcome_kind === 'uncertain_write') {
        return !resolvedWriteCallIds.has(row.logical_tool_call_id);
      }
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

    const facts: AcceptedSourceSettlementAudit['facts'] = {
      openLogicalCalls: logical.open_calls ?? 0,
      conflictingLogicalCalls: logical.conflict_calls ?? 0,
      startedDispatches: dispatch.started_dispatches,
      businessSettlements: settlements.length,
      successfulBusinessSettlements: successful.length,
      successfulSdkBusinessResults,
      successfulSdkAuthoringResults,
      successfulLocalMutations: localMutations.filter(succeeded).length,
      successfulReads: [...settlements, ...localSettlements].filter((row) => succeeded(row) && !localMutates(row) && row.mutating === 0).length,
      attemptedMutations: [...settlements.filter((row) => row.mutating === 1), ...localMutations].length,
      unrecoveredBusinessFailures: unrecovered.length,
      confirmedWrites: writeEvidence.confirmed.length,
      requiredHostExternalWriteProjections: requiredHostExternalWriteProjections.length,
      missingHostExternalWriteProjections: missingHostExternalWriteProjections.length,
      uncertainWrites: writeEvidence.uncertain.length,
      blockingUncertainWrites: Math.max(
        writeEvidence.uncertain.length,
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
    if (facts.missingHostExternalWriteProjections > 0) {
      return {
        status: 'write_projection_missing',
        reason: `${facts.missingHostExternalWriteProjections} successful direct-host external write(s) lack exact confirmed projection`,
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
      && facts.successfulLocalMutations === 0
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
