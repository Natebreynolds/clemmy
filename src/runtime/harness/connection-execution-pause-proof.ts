/** Event-log-level proof only. Keep this module free of runtime imports: the
 * event log initializes before model/tool adapters and must not load them. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import type { PresentationEvent } from './turn-outcome.js';
import type { SourceConnectionCheckpoint } from './source-connection-checkpoints.js';

export interface ConnectionExecutionPauseV1 {
  version: 1;
  requestId: string;
  checkpointDigest: string;
  executionSourceUserSeq: number;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Property order is part of the already-retained digest. Status and account
 * readiness are mutable and deliberately excluded from this identity. */
export function connectionDependencyIdentity(db: Database.Database, input: { sessionId: string; requestId: string }) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dependency_requests'").get()) return null;
  return db.prepare(`SELECT request_id, session_id, source_user_seq, kind, subject_kind,
    subject_provider, subject_toolkit, subject_capability, subject_capability_ref,
    subject_discovery_query, subject_discovery_role, continue_option_id, continue_option_label
    FROM dependency_requests WHERE request_id = ? AND session_id = ?
    AND kind = 'connection_missing' AND subject_kind = 'exact_capability_connection'`)
    .get(input.requestId, input.sessionId) as ({ source_user_seq: number } & Record<string, unknown>) | undefined;
}

/** The high-level pause producer validates canonical recovery before proposing
 * this binding. In the terminal transaction, compare its immutable checkpoint
 * and batch against the current journal and require no unsettled dispatch.
 * Historical replay checks the retained batch, never a later batch/account.
 * A future activation must prove its closure chain before UI resume is enabled. */
export function validateConnectionExecutionPause(input: {
  db: Database.Database;
  presentation: PresentationEvent;
  metadata: Record<string, unknown>;
  historical?: boolean;
}): ConnectionExecutionPauseV1 | null {
  const raw = input.metadata.connectionExecutionPause;
  if (raw === undefined) return null;
  const invalid = (): never => { throw new Error('The connection pause does not match its execution authority.'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const binding = raw as ConnectionExecutionPauseV1;
  const { identity } = input.presentation;
  if (binding.version !== 1 || typeof binding.requestId !== 'string' || !binding.requestId
    || typeof binding.checkpointDigest !== 'string' || !/^[a-f0-9]{64}$/.test(binding.checkpointDigest)
    || Object.keys(binding).some(key => !['version', 'requestId', 'checkpointDigest', 'executionSourceUserSeq'].includes(key))
    || binding.executionSourceUserSeq !== identity.sourceUserSeq
    || input.presentation.status !== 'needs_input' || input.presentation.needs?.kind !== 'input'
    || input.presentation.kind !== 'question') return invalid();
  const row = input.db.prepare(`SELECT source_user_seq, checkpoint_json, checkpoint_digest
    FROM source_connection_checkpoints_v1 WHERE session_id = ? AND request_id = ?`)
    .get(identity.sessionId, binding.requestId) as { source_user_seq: number; checkpoint_json: string; checkpoint_digest: string } | undefined;
  if (!row || row.source_user_seq !== identity.sourceUserSeq || row.checkpoint_digest !== binding.checkpointDigest
    || hash(row.checkpoint_json) !== binding.checkpointDigest) return invalid();
  const checkpoint = JSON.parse(row.checkpoint_json) as SourceConnectionCheckpoint;
  const progress = checkpoint.hostProgress;
  const token = checkpoint.restartToken;
  if (checkpoint.version !== 1 || checkpoint.sessionId !== identity.sessionId || checkpoint.requestId !== binding.requestId
    || checkpoint.sourceUserSeq !== identity.sourceUserSeq || !checkpoint.agent?.modelId || !progress || !token
    || checkpoint.agent.sessionContext?.sessionId !== identity.sessionId
    || checkpoint.agent.sessionContext.sourceUserSeq !== identity.sourceUserSeq
    || token.sessionId !== identity.sessionId || token.sourceUserSeq !== identity.sourceUserSeq
    || progress.batch.sessionId !== identity.sessionId || progress.batch.sourceUserSeq !== identity.sourceUserSeq
    || progress.batch.acceptedTaskId !== token.acceptedTaskId || progress.batch.authorityDigest !== token.authorityDigest
    || progress.batch.batchId !== token.resumeFromBatchId || progress.batch.batchOrdinal !== token.resumeFromBatchOrdinal) return invalid();
  const dependencyIdentity = connectionDependencyIdentity(input.db, { sessionId: identity.sessionId, requestId: binding.requestId });
  if (!dependencyIdentity || dependencyIdentity.source_user_seq !== identity.sourceUserSeq
    || hash(JSON.stringify(dependencyIdentity)) !== checkpoint.dependencyDigest) return invalid();
  // These plan/claim rows are immutable. Recheck their exact relationship and
  // event mirror inside the same transaction rather than trusting a prior
  // successful preparation after other state might have changed.
  const reviewed = input.db.prepare(`SELECT claim.claim_json, event.data_json AS event_json, plan.artifact_json,
      source.data_json AS source_json, source.id AS source_event_id
    FROM reviewed_plan_execution_claims_v1 claim
    JOIN reviewed_plan_revisions_v1 plan ON plan.plan_id = claim.plan_id AND plan.revision = claim.revision
    JOIN events event ON event.id = claim.event_id AND event.type = 'plan_execution_claimed'
      AND event.session_id = claim.session_id
    JOIN events source ON source.session_id = claim.session_id AND source.seq = claim.source_user_seq
      AND source.type = 'user_input_received' AND source.id = event.parent_event_id
    WHERE claim.claim_id = ? AND claim.session_id = ? AND claim.source_user_seq = ?
      AND plan.plan_id = ? AND plan.revision = ? AND plan.digest = ?`)
    .get(checkpoint.executionClaimId, identity.sessionId, identity.sourceUserSeq,
      checkpoint.plan.planId, checkpoint.plan.revision, checkpoint.plan.digest) as {
      claim_json: string; event_json: string; artifact_json: string; source_json: string; source_event_id: string;
    } | undefined;
  if (!reviewed) return invalid();
  const claim = JSON.parse(reviewed.claim_json);
  const plan = JSON.parse(reviewed.artifact_json);
  const mode = JSON.parse(reviewed.source_json).taskMode;
  if (claim.claimId !== checkpoint.executionClaimId || claim.digest !== checkpoint.executionClaimDigest
    || claim.executionRunId !== checkpoint.executionRunId || claim.sessionId !== identity.sessionId
    || claim.sourceUserSeq !== identity.sourceUserSeq || claim.sourceEventId !== reviewed.source_event_id
    || claim.acceptedTaskId !== token.acceptedTaskId || !isDeepStrictEqual(claim.ref, checkpoint.plan)
    || !isDeepStrictEqual(JSON.parse(reviewed.event_json).claim, claim)
    || plan.planId !== checkpoint.plan.planId || plan.revision !== checkpoint.plan.revision
    || plan.digest !== checkpoint.plan.digest || plan.readiness !== 'ready' || plan.missingPrerequisites?.length !== 0
    || mode?.kind !== 'execute' || !isDeepStrictEqual(mode.executeRef, checkpoint.plan)) return invalid();
  const root = input.db.prepare(`SELECT state, authority_digest FROM accepted_turn_call_authorities
    WHERE session_id = ? AND source_user_seq = ? AND authority_kind = 'host_v1'`)
    .get(identity.sessionId, binding.executionSourceUserSeq) as { state: string; authority_digest: string } | undefined;
  if (root?.state !== 'open' || root.authority_digest !== token.authorityDigest) return invalid();
  const batch = input.db.prepare(`SELECT batch_id, authority_digest, history_digest, history_json, disposition
    FROM accepted_model_batch_checkpoints WHERE session_id = ? AND source_user_seq = ? AND batch_ordinal = ?`)
    .get(identity.sessionId, identity.sourceUserSeq, token.resumeFromBatchOrdinal) as {
      batch_id: string; authority_digest: string; history_digest: string; history_json: string; disposition: string;
    } | undefined;
  if (!batch || batch.batch_id !== token.resumeFromBatchId || batch.authority_digest !== token.authorityDigest
    || batch.disposition !== 'ready' || batch.history_digest !== token.resumeFromHistoryDigest
    || hash(batch.history_json) !== token.resumeFromHistoryDigest) return invalid();
  if (!input.historical) {
    const dependency = input.db.prepare(`SELECT status FROM dependency_requests WHERE request_id = ? AND session_id = ?`)
      .get(binding.requestId, identity.sessionId) as { status: string } | undefined;
    const latest = input.db.prepare(`SELECT batch_id FROM accepted_model_batch_admissions
      WHERE session_id = ? AND source_user_seq = ? ORDER BY batch_ordinal DESC LIMIT 1`)
      .get(identity.sessionId, identity.sourceUserSeq) as { batch_id: string } | undefined;
    if (dependency?.status !== 'open' || latest?.batch_id !== token.resumeFromBatchId) return invalid();
    const unsettled = input.db.prepare(`SELECT
      (SELECT COUNT(*) FROM logical_tool_calls WHERE session_id = ? AND source_user_seq = ? AND state != 'settled') AS logical,
      (SELECT COUNT(*) FROM physical_dispatches WHERE session_id = ? AND source_user_seq = ? AND state = 'started') AS physical`)
      .get(identity.sessionId, identity.sourceUserSeq, identity.sessionId, identity.sourceUserSeq) as { logical: number; physical: number };
    if (unsettled.logical || unsettled.physical) return invalid();
  }
  return { ...binding };
}
