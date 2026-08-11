/**
 * Fail-closed cutover state for one exact accepted user task.
 *
 * Historical turns have no row. A current turn is explicitly armed from its
 * content-addressed TurnGraph before provider work starts. From that point on,
 * absence of a manifest is an incomplete protocol state, never permission to
 * fall back to legacy terminal success.
 */
import { createHash } from 'node:crypto';
import { BoundaryError } from '../boundary-error.js';
import {
  insertInternalEventInTransaction,
  openEventLog,
  publishCommittedInternalEvent,
  type EventRow,
} from './eventlog.js';
import { expectedTaskFor } from './resolution-ledger.js';
import {
  compileObligationManifest,
  manifestIdMatches,
  type ObligationManifest,
} from './obligation-manifest.js';

export const ACCEPTED_TASK_AUTHORITY_PROTOCOL = 1 as const;

export type AcceptedTaskAuthorityPhase =
  | 'armed'
  | 'manifested_verifying'
  | 'terminal'
  | 'conflict';

export interface AcceptedTaskAuthority {
  protocol: typeof ACCEPTED_TASK_AUTHORITY_PROTOCOL;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  graphEventId: string;
  graphId: string;
  graphHash: string;
  /** Immutable expected-work contract, when this source has entered the staged
   * v1 contract protocol. Nullable during the action-planner cutover. */
  workContractId?: string;
  /** New action turns set this before constructing any business-tool surface.
   * It distinguishes an intentionally staged action from a migrated authority
   * row whose nullable work-contract slot was never part of its protocol. */
  expectedWorkRequired: boolean;
  state: AcceptedTaskAuthorityPhase;
  manifestId?: string;
  revision: number;
  repairGrantsUsed: 0 | 1;
  repairGrantId?: string;
  repairGrantStatus: 'none' | 'issued' | 'consumed';
  terminalEventId?: string;
  backstopEventId?: string;
  hostCompletionReceiptId?: string;
  hostCompletionEventId?: string;
  armedAt: string;
  updatedAt: string;
}

interface AuthorityRow {
  session_id: string;
  source_user_seq: number;
  accepted_task_id: string;
  authority_protocol: number;
  graph_event_id: string;
  graph_id: string;
  graph_hash: string;
  work_contract_id: string | null;
  expected_work_required: number;
  state: AcceptedTaskAuthorityPhase;
  manifest_id: string | null;
  revision: number;
  repair_grants_used: number;
  repair_grant_id: string | null;
  repair_grant_status: AcceptedTaskAuthority['repairGrantStatus'];
  terminal_event_id: string | null;
  backstop_event_id: string | null;
  host_completion_receipt_id: string | null;
  host_completion_event_id: string | null;
  armed_at: string;
  updated_at: string;
}

function project(row: AuthorityRow): AcceptedTaskAuthority {
  return {
    protocol: ACCEPTED_TASK_AUTHORITY_PROTOCOL,
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    acceptedTaskId: row.accepted_task_id,
    graphEventId: row.graph_event_id,
    graphId: row.graph_id,
    graphHash: row.graph_hash,
    ...(row.work_contract_id ? { workContractId: row.work_contract_id } : {}),
    expectedWorkRequired: row.expected_work_required === 1,
    state: row.state,
    ...(row.manifest_id ? { manifestId: row.manifest_id } : {}),
    revision: row.revision,
    repairGrantsUsed: row.repair_grants_used === 1 ? 1 : 0,
    ...(row.repair_grant_id ? { repairGrantId: row.repair_grant_id } : {}),
    repairGrantStatus: row.repair_grant_status,
    ...(row.terminal_event_id ? { terminalEventId: row.terminal_event_id } : {}),
    ...(row.backstop_event_id ? { backstopEventId: row.backstop_event_id } : {}),
    ...(row.host_completion_receipt_id
      ? { hostCompletionReceiptId: row.host_completion_receipt_id }
      : {}),
    ...(row.host_completion_event_id
      ? { hostCompletionEventId: row.host_completion_event_id }
      : {}),
    armedAt: row.armed_at,
    updatedAt: row.updated_at,
  };
}

function readRow(
  db: ReturnType<typeof openEventLog>,
  sessionId: string,
  sourceUserSeq: number,
): AuthorityRow | undefined {
  return db.prepare(`
    SELECT * FROM accepted_task_authority
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, sourceUserSeq) as AuthorityRow | undefined;
}

function boundedReason(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 180);
}

export type LoadAcceptedTaskAuthorityResult =
  | { status: 'ok'; authority: AcceptedTaskAuthority }
  | { status: 'legacy' }
  | { status: 'unreadable'; reason: string };

export function loadAcceptedTaskAuthority(
  sessionId: string,
  sourceUserSeq: number,
): LoadAcceptedTaskAuthorityResult {
  try {
    const row = readRow(openEventLog(), sessionId, sourceUserSeq);
    return row ? { status: 'ok', authority: project(row) } : { status: 'legacy' };
  } catch (error) {
    return { status: 'unreadable', reason: boundedReason(error) };
  }
}

export type ArmAcceptedTaskAuthorityResult =
  | { status: 'armed' | 'existing'; authority: AcceptedTaskAuthority }
  | { status: 'missing' | 'conflict' | 'storage_error'; reason: string };

/** Arm only from the exact hash-validated graph already persisted for source. */
export function armAcceptedTaskAuthority(input: {
  sessionId: string;
  sourceUserSeq: number;
}): ArmAcceptedTaskAuthorityResult {
  const expected = expectedTaskFor(input.sessionId, input.sourceUserSeq);
  if (expected.status !== 'ok') {
    return { status: expected.status === 'missing' ? 'missing' : 'conflict', reason: expected.reason };
  }
  const contract = expected.expectation;
  let mirror: EventRow | null = null;
  try {
    const db = openEventLog();
    const transaction = db.transaction((): ArmAcceptedTaskAuthorityResult => {
      const existing = readRow(db, input.sessionId, input.sourceUserSeq);
      if (existing) {
        const exact = existing.authority_protocol === ACCEPTED_TASK_AUTHORITY_PROTOCOL
          && existing.accepted_task_id === contract.acceptedTaskId
          && existing.graph_event_id === contract.graphEventId
          && existing.graph_id === contract.graphId
          && existing.graph_hash === contract.graphHash;
        if (exact && existing.state !== 'conflict') {
          return { status: 'existing', authority: project(existing) };
        }
        if (existing.state === 'armed' || existing.state === 'manifested_verifying') {
          db.prepare(`
            UPDATE accepted_task_authority
               SET state = 'conflict', revision = revision + 1, updated_at = ?
             WHERE session_id = ? AND source_user_seq = ?
          `).run(new Date().toISOString(), input.sessionId, input.sourceUserSeq);
        }
        return { status: 'conflict', reason: 'accepted task authority conflicts with its exact graph' };
      }
      const at = new Date().toISOString();
      mirror = insertInternalEventInTransaction(db, {
        sessionId: input.sessionId,
        turn: contract.identity.turn,
        role: 'system',
        type: 'accepted_task_authority_armed',
        data: {
          protocol: ACCEPTED_TASK_AUTHORITY_PROTOCOL,
          sourceUserSeq: input.sourceUserSeq,
          acceptedTaskId: contract.acceptedTaskId,
          graphEventId: contract.graphEventId,
          graphId: contract.graphId,
          graphHash: contract.graphHash,
        },
      });
      db.prepare(`
        INSERT INTO accepted_task_authority
          (session_id, source_user_seq, accepted_task_id, authority_protocol,
           graph_event_id, graph_id, graph_hash, state, revision,
           repair_grants_used, repair_grant_status, armed_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, 'armed', 0, 0, 'none', ?, ?)
      `).run(
        input.sessionId,
        input.sourceUserSeq,
        contract.acceptedTaskId,
        contract.graphEventId,
        contract.graphId,
        contract.graphHash,
        at,
        at,
      );
      const row = readRow(db, input.sessionId, input.sourceUserSeq);
      if (!row) throw new Error('armed authority could not be read back');
      return { status: 'armed', authority: project(row) };
    });
    const result = transaction.immediate();
    if (result.status === 'armed' && mirror) publishCommittedInternalEvent(mirror);
    return result;
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

/**
 * Production admission boundary for provider work.
 *
 * A persisted graph and its accepted-task marker are execution authority, not
 * optional telemetry.  Provider lanes call this after recording the exact
 * graph and before constructing or invoking a model/tool surface.  The typed
 * BoundaryError deliberately leaves publication to the existing outer
 * infrastructure-failure path; this function never invents conversational
 * text and never falls back to an unarmed legacy run.
 */
export function requireAcceptedTaskAuthority(input: {
  sessionId: string;
  sourceUserSeq: number;
}): AcceptedTaskAuthority {
  const result = armAcceptedTaskAuthority(input);
  if (result.status === 'armed' || result.status === 'existing') return result.authority;
  const failure = result as Extract<ArmAcceptedTaskAuthorityResult, { reason: string }>;
  throw new BoundaryError({
    kind: failure.status === 'conflict' ? 'state.read_corrupted' : 'state.write_failed',
    retryable: failure.status !== 'conflict',
    userMessage: 'I could not safely start that turn because its local execution state was unavailable. Please retry.',
    operatorMessage: `accepted-task authority admission ${failure.status}: ${failure.reason}`,
    context: {
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      authorityStatus: failure.status,
    },
  });
}

export type ManifestAcceptedTaskAuthorityResult =
  | { status: 'manifested' | 'replayed'; authority: AcceptedTaskAuthority; manifestEventId: string }
  | { status: 'not_armed' | 'not_ready' | 'conflict' | 'storage_error'; reason: string };

/** Freeze one ready manifest and advance the cutover marker in one transaction. */
export function manifestAcceptedTaskAuthority(
  manifest: ObligationManifest,
): ManifestAcceptedTaskAuthorityResult {
  if (!manifestIdMatches(manifest) || manifest.readiness !== 'ready') {
    return { status: 'not_ready', reason: 'manifest is unresolved or its content address is invalid' };
  }
  let mirror: EventRow | null = null;
  try {
    const db = openEventLog();
    const transaction = db.transaction((): ManifestAcceptedTaskAuthorityResult => {
      // The caller is not manifest authority. Recompile the one admissible
      // manifest from the exact persisted graph + frozen observed resolution
      // while holding the writer transaction, then require byte-address
      // identity. Merely presenting a self-content-addressed `ready` object is
      // insufficient: otherwise a caller could relabel a collection read as a
      // point observation (or delete an obligation) and make weaker evidence
      // look authoritative.
      const expected = expectedTaskFor(
        manifest.identity.sessionId,
        manifest.identity.sourceUserSeq,
      );
      if (expected.status !== 'ok') {
        return {
          status: 'conflict',
          reason: `accepted task expectation is ${expected.status}: ${expected.reason}`,
        };
      }
      const authoritative = compileObligationManifest({ graph: expected.graph });
      if (
        !authoritative.validation.ok
        || authoritative.manifest.readiness !== 'ready'
        || authoritative.manifest.manifestId !== manifest.manifestId
      ) {
        return {
          status: 'conflict',
          reason: 'submitted manifest is not the exact host-compiled manifest',
        };
      }
      const row = readRow(db, manifest.identity.sessionId, manifest.identity.sourceUserSeq);
      if (!row) return { status: 'not_armed', reason: 'accepted task authority is not armed' };
      if (
        row.accepted_task_id !== `task:${manifest.identity.sessionId}#${manifest.identity.sourceUserSeq}`
        || row.graph_id !== manifest.graphId
        || row.graph_hash !== manifest.graphHash
      ) {
        return { status: 'conflict', reason: 'manifest does not refine the armed accepted task' };
      }
      if (row.state === 'manifested_verifying' || row.state === 'terminal') {
        if (row.manifest_id !== manifest.manifestId) {
          return { status: 'conflict', reason: 'a different manifest already owns this accepted task' };
        }
        const prior = db.prepare(`
          SELECT id FROM events
           WHERE session_id = ? AND type = 'obligation_manifest'
             AND json_extract(data_json, '$.sourceUserSeq') = ?
           ORDER BY seq LIMIT 1
        `).get(manifest.identity.sessionId, manifest.identity.sourceUserSeq) as { id: string } | undefined;
        if (!prior) return { status: 'conflict', reason: 'marker names a manifest whose event is missing' };
        return { status: 'replayed', authority: project(row), manifestEventId: prior.id };
      }
      if (row.state !== 'armed') {
        return { status: 'conflict', reason: `accepted task authority is ${row.state}` };
      }
      const resolution = db.prepare(`
        SELECT state, accepted_task_id, graph_event_id, graph_id, graph_hash,
               expectations_satisfied
          FROM accepted_task_resolutions
         WHERE session_id = ? AND source_user_seq = ?
      `).get(manifest.identity.sessionId, manifest.identity.sourceUserSeq) as {
        state: string;
        accepted_task_id: string;
        graph_event_id: string;
        graph_id: string;
        graph_hash: string;
        expectations_satisfied: number | null;
      } | undefined;
      if (
        !resolution
        || resolution.state !== 'finalized'
        || resolution.expectations_satisfied !== 1
        || resolution.accepted_task_id !== row.accepted_task_id
        || resolution.graph_event_id !== row.graph_event_id
        || resolution.graph_id !== row.graph_id
        || resolution.graph_hash !== row.graph_hash
      ) {
        return { status: 'not_ready', reason: 'accepted task resolution is not exactly finalized' };
      }
      const openWork = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM logical_tool_calls
            WHERE session_id = ? AND source_user_seq = ? AND state != 'settled') AS logical_n,
          (SELECT COUNT(*) FROM physical_dispatches
            WHERE session_id = ? AND source_user_seq = ? AND state = 'started') AS dispatch_n
      `).get(
        manifest.identity.sessionId,
        manifest.identity.sourceUserSeq,
        manifest.identity.sessionId,
        manifest.identity.sourceUserSeq,
      ) as { logical_n: number; dispatch_n: number };
      if (openWork.logical_n > 0 || openWork.dispatch_n > 0) {
        return { status: 'not_ready', reason: 'accepted task still has unsettled tool work' };
      }
      const competing = db.prepare(`
        SELECT COUNT(*) AS n FROM events
         WHERE session_id = ? AND type = 'obligation_manifest'
           AND json_extract(data_json, '$.sourceUserSeq') = ?
      `).get(manifest.identity.sessionId, manifest.identity.sourceUserSeq) as { n: number };
      if (competing.n !== 0) {
        return { status: 'conflict', reason: 'an unbound manifest event already claims this accepted task' };
      }
      mirror = insertInternalEventInTransaction(db, {
        sessionId: manifest.identity.sessionId,
        turn: manifest.identity.turn,
        role: 'system',
        type: 'obligation_manifest',
        data: { sourceUserSeq: manifest.identity.sourceUserSeq, manifest },
      });
      const at = mirror.createdAt;
      const updated = db.prepare(`
        UPDATE accepted_task_authority
           SET state = 'manifested_verifying', manifest_id = ?,
               revision = revision + 1, updated_at = ?
         WHERE session_id = ? AND source_user_seq = ?
           AND state = 'armed' AND revision = ?
      `).run(
        manifest.manifestId,
        at,
        manifest.identity.sessionId,
        manifest.identity.sourceUserSeq,
        row.revision,
      );
      if (updated.changes !== 1) throw new Error('manifest freeze lost its authority CAS');
      const frozen = readRow(db, manifest.identity.sessionId, manifest.identity.sourceUserSeq);
      if (!frozen) throw new Error('manifested authority could not be read back');
      return { status: 'manifested', authority: project(frozen), manifestEventId: mirror.id };
    });
    const result = transaction.immediate();
    if (result.status === 'manifested' && mirror) publishCommittedInternalEvent(mirror);
    return result;
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export interface TerminalRepairGrant {
  grantId: string;
  anchorKind: 'manifest' | 'work_contract';
  anchorId: string;
  manifestId?: string;
  workContractId?: string;
  missingDigest: string;
  revision: number;
  missing: string[];
}

export type ClaimTerminalRepairGrantResult =
  | { status: 'granted'; grant: TerminalRepairGrant; authority: AcceptedTaskAuthority }
  | { status: 'exhausted' | 'not_ready' | 'storage_error'; reason: string };

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Claim the task's only verification pass before injecting any model steer. */
export function claimTerminalRepairGrant(input: {
  sessionId: string;
  sourceUserSeq: number;
  /** Compatibility assertion for manifested callers. The host still derives
   * the actual anchor from the authority row. */
  manifestId?: string;
  missing: readonly string[];
}): ClaimTerminalRepairGrantResult {
  const missing = [...new Set(input.missing.map((entry) => entry.trim()).filter(Boolean))]
    .sort()
    .slice(0, 16);
  let mirror: EventRow | null = null;
  try {
    const db = openEventLog();
    const transaction = db.transaction((): ClaimTerminalRepairGrantResult => {
      const row = readRow(db, input.sessionId, input.sourceUserSeq);
      if (!row) return { status: 'not_ready', reason: 'accepted task authority is missing' };
      const anchor = row.state === 'manifested_verifying' && row.manifest_id
        ? { kind: 'manifest' as const, id: row.manifest_id }
        : row.state === 'armed'
          && row.expected_work_required === 1
          && row.work_contract_id
          ? { kind: 'work_contract' as const, id: row.work_contract_id }
          : null;
      if (!anchor) {
        return { status: 'not_ready', reason: 'accepted task has no immutable terminal-repair anchor' };
      }
      if (input.manifestId !== undefined && (
        anchor.kind !== 'manifest' || anchor.id !== input.manifestId
      )) {
        return { status: 'not_ready', reason: 'terminal-repair anchor does not match the manifested task' };
      }
      const hasOpenLogicalCall = Boolean(db.prepare(`
        SELECT 1 FROM logical_tool_calls
         WHERE session_id = ? AND source_user_seq = ? AND accepted_task_id = ?
           AND state = 'open'
         LIMIT 1
      `).get(input.sessionId, input.sourceUserSeq, row.accepted_task_id));
      const hasStartedDispatch = Boolean(db.prepare(`
        SELECT 1 FROM physical_dispatches
         WHERE session_id = ? AND source_user_seq = ? AND accepted_task_id = ?
           AND state = 'started'
         LIMIT 1
      `).get(input.sessionId, input.sourceUserSeq, row.accepted_task_id));
      if (hasOpenLogicalCall || hasStartedDispatch) {
        return { status: 'not_ready', reason: 'accepted task still owns unsettled execution work' };
      }
      if (row.repair_grants_used !== 0 || row.repair_grant_status !== 'none') {
        return { status: 'exhausted', reason: 'the bounded terminal repair grant was already claimed' };
      }
      const missingDigest = digest(JSON.stringify(missing));
      const grantId = `terminal-repair:v1:${digest([
        row.accepted_task_id,
        anchor.kind,
        anchor.id,
        row.revision,
        missingDigest,
      ].join('|'))}`;
      const at = new Date().toISOString();
      mirror = insertInternalEventInTransaction(db, {
        sessionId: input.sessionId,
        turn: 0,
        role: 'system',
        type: 'terminal_authority_repair_granted',
        data: {
          sourceUserSeq: input.sourceUserSeq,
          acceptedTaskId: row.accepted_task_id,
          anchorKind: anchor.kind,
          anchorId: anchor.id,
          ...(anchor.kind === 'manifest'
            ? { manifestId: anchor.id }
            : { workContractId: anchor.id }),
          grantId,
          missing,
          missingDigest,
          remainingAttempts: 1,
        },
      });
      const anchorPredicate = anchor.kind === 'manifest'
        ? "state = 'manifested_verifying' AND manifest_id = ?"
        : "state = 'armed' AND expected_work_required = 1 AND work_contract_id = ?";
      const updated = db.prepare(`
        UPDATE accepted_task_authority
           SET repair_grants_used = 1, repair_grant_id = ?,
               repair_grant_status = 'issued', repair_grant_issued_at = ?,
               revision = revision + 1, updated_at = ?
         WHERE session_id = ? AND source_user_seq = ?
           AND ${anchorPredicate}
           AND repair_grants_used = 0 AND repair_grant_status = 'none'
           AND revision = ?
      `).run(
        grantId,
        at,
        at,
        input.sessionId,
        input.sourceUserSeq,
        anchor.id,
        row.revision,
      );
      if (updated.changes !== 1) throw new Error('terminal repair grant lost its authority CAS');
      const granted = readRow(db, input.sessionId, input.sourceUserSeq);
      if (!granted) throw new Error('granted authority could not be read back');
      return {
        status: 'granted',
        grant: {
          grantId,
          anchorKind: anchor.kind,
          anchorId: anchor.id,
          ...(anchor.kind === 'manifest'
            ? { manifestId: anchor.id }
            : { workContractId: anchor.id }),
          missingDigest,
          revision: granted.revision,
          missing,
        },
        authority: project(granted),
      };
    });
    const result = transaction.immediate();
    if (result.status === 'granted' && mirror) publishCommittedInternalEvent(mirror);
    return result;
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export type ConsumeTerminalRepairGrantResult =
  | { status: 'consumed' | 'replayed'; authority: AcceptedTaskAuthority }
  | { status: 'missing' | 'conflict' | 'storage_error'; reason: string };

export function consumeTerminalRepairGrant(input: {
  sessionId: string;
  sourceUserSeq: number;
  grantId: string;
}): ConsumeTerminalRepairGrantResult {
  let mirror: EventRow | null = null;
  try {
    const db = openEventLog();
    const transaction = db.transaction((): ConsumeTerminalRepairGrantResult => {
      const row = readRow(db, input.sessionId, input.sourceUserSeq);
      if (!row || !row.repair_grant_id) return { status: 'missing', reason: 'terminal repair grant is missing' };
      if (row.repair_grant_id !== input.grantId) {
        return { status: 'conflict', reason: 'terminal repair grant identity conflicts' };
      }
      if (row.repair_grant_status === 'consumed') {
        return { status: 'replayed', authority: project(row) };
      }
      if (row.repair_grant_status !== 'issued') {
        return { status: 'conflict', reason: `terminal repair grant is ${row.repair_grant_status}` };
      }
      const at = new Date().toISOString();
      mirror = insertInternalEventInTransaction(db, {
        sessionId: input.sessionId,
        turn: 0,
        role: 'system',
        type: 'terminal_authority_repair_consumed',
        data: {
          sourceUserSeq: input.sourceUserSeq,
          acceptedTaskId: row.accepted_task_id,
          manifestId: row.manifest_id,
          grantId: input.grantId,
        },
      });
      const updated = db.prepare(`
        UPDATE accepted_task_authority
           SET repair_grant_status = 'consumed', repair_grant_consumed_at = ?,
               revision = revision + 1, updated_at = ?
         WHERE session_id = ? AND source_user_seq = ?
           AND repair_grant_id = ? AND repair_grant_status = 'issued'
           AND revision = ?
      `).run(
        at,
        at,
        input.sessionId,
        input.sourceUserSeq,
        input.grantId,
        row.revision,
      );
      if (updated.changes !== 1) throw new Error('terminal repair consumption lost its authority CAS');
      const consumed = readRow(db, input.sessionId, input.sourceUserSeq);
      if (!consumed) throw new Error('consumed authority could not be read back');
      return { status: 'consumed', authority: project(consumed) };
    });
    const result = transaction.immediate();
    if (result.status === 'consumed' && mirror) publishCommittedInternalEvent(mirror);
    return result;
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}
