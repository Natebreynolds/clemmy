/**
 * Provider-neutral orchestration for one already-authorized staged Composio
 * call. This module schedules immutable stage rows; it does not invent file
 * paths, signed URLs, provider arguments, consent, retry, or success.
 */
import { openEventLog } from './eventlog.js';
import {
  beginStagedPhysicalDispatch,
  settleStagedPhysicalDispatch,
  type CrossingOutcome,
} from './dispatch-ledger.js';
import type { DispatchLeaseRef } from './dispatch-lease.js';
import type { StagedParentCallAdmission } from './nested-tool-approval-admission.js';
import {
  executeStagedPreparedComposioBody,
  executeStagedPreparedComposioPresignBody,
  executeCommittedComposioDownloadBody,
  prepareStagedBlobBodyReturnCheckpoint,
  projectCommittedComposioResult,
  recoverCommittedStagedPhysicalReturn,
  type PreparedPhysicalReturnCheckpoint,
} from './physical-return-checkpoint.js';
import {
  executeStagedLocalCommitBody,
  executeStagedLocalSnapshotBody,
  executeStagedSourceDownloadBody,
  executeStagedUploadTransferBody,
  inspectStagedPhysicalDispatchAuthority,
  inspectStagedTransferPlanAuthority,
  prepareStagedComposioBusinessBody,
  prepareStagedComposioPresignBody,
  prepareStagedDownloadBodyCarrier,
  prepareStagedDownloadSuccessors,
  prepareStagedPhysicalDispatch,
  prepareStagedTransferPlan,
  reopenStagedPhysicalDispatchAuthority,
  type StagedPhysicalDispatchAuthority,
  type StagedTransferPlanAuthority,
  type StagedTransferStageKind,
} from './staged-transfer-authority.js';

export type StagedComposioExecutionResult =
  | {
      status: 'returned';
      value: { successful: true; error: null; data: unknown };
    }
  | {
      status:
        | 'not_applicable'
        | 'preparation_required'
        | 'provider_failed'
        | 'held'
        | 'conflict'
        | 'storage_error';
      reason: string;
    };

interface StageScheduleRow {
  stage_ordinal: number;
  stage_kind: StagedTransferStageKind;
  retry_policy: 'none' | 'safe_terminal' | 'reconcile_before_retry';
}

interface StageAttemptRow {
  attempt_ordinal: number;
  physical_dispatch_id: string;
  physical_state: string | null;
  terminal_state: string | null;
}

type StageBodyResult =
  | { status: 'returned'; checkpoint: PreparedPhysicalReturnCheckpoint }
  | { status: 'failed'; outcome: CrossingOutcome; reason: string }
  | { status: 'held'; reason: string }
  | { status: 'conflict'; reason: string };

function safeReason(prefix: string, reason?: string): string {
  const suffix = String(reason ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return suffix ? `${prefix}: ${suffix}` : prefix;
}

function stageRows(planId: string): StageScheduleRow[] {
  return openEventLog().prepare(`
    SELECT stage_ordinal, stage_kind, retry_policy
      FROM staged_transfer_stages
     WHERE plan_id = ?
     ORDER BY stage_ordinal
  `).all(planId) as StageScheduleRow[];
}

function latestAttempt(planId: string, stageOrdinal: number): StageAttemptRow | null {
  return (openEventLog().prepare(`
    SELECT attempt.attempt_ordinal, attempt.physical_dispatch_id,
           physical.state AS physical_state, receipt.terminal_state
      FROM staged_transfer_stage_authorities attempt
      LEFT JOIN physical_dispatches physical
        ON physical.session_id = attempt.session_id
       AND physical.source_user_seq = attempt.source_user_seq
       AND physical.physical_dispatch_id = attempt.physical_dispatch_id
      LEFT JOIN staged_transfer_stage_receipts receipt
        ON receipt.stage_authority_id = attempt.stage_authority_id
     WHERE attempt.plan_id = ? AND attempt.stage_ordinal = ?
     ORDER BY attempt.attempt_ordinal DESC
     LIMIT 1
  `).get(planId, stageOrdinal) as StageAttemptRow | undefined) ?? null;
}

function businessStageOrdinal(planId: string): number | null {
  const rows = openEventLog().prepare(`
    SELECT stage_ordinal
      FROM staged_transfer_stages
     WHERE plan_id = ? AND stage_kind = 'business_execute'
     LIMIT 2
  `).all(planId) as Array<{ stage_ordinal: number }>;
  return rows.length === 1 ? rows[0]!.stage_ordinal : null;
}

function localBlobCheckpoint(input: {
  authority: StagedPhysicalDispatchAuthority;
  body: Extract<ReturnType<typeof executeStagedLocalSnapshotBody>, { status: 'returned' }>;
}): StageBodyResult {
  const prepared = prepareStagedBlobBodyReturnCheckpoint({
    authority: input.authority,
    result: input.body.result,
    sha256: input.body.sha256,
    md5: input.body.md5,
    byteCount: input.body.byteCount,
    bodyDigest: input.body.bodyDigest,
    resultDigest: input.body.resultDigest,
  });
  return prepared.status === 'prepared'
    ? { status: 'returned', checkpoint: prepared.checkpoint }
    : { status: 'held', reason: 'local body returned before its exact checkpoint could be committed' };
}

async function executeStartedStage(
  authority: StagedPhysicalDispatchAuthority,
): Promise<StageBodyResult> {
  const state = inspectStagedPhysicalDispatchAuthority(authority);
  if (!state || state.terminalOnly) {
    return { status: 'conflict', reason: 'started staged authority no longer reopens' };
  }
  switch (state.stageKind) {
    case 'local_snapshot': {
      const body = executeStagedLocalSnapshotBody({ authority });
      if (body.status === 'returned') return localBlobCheckpoint({ authority, body });
      if (body.status === 'threw') return { status: 'failed', outcome: 'threw', reason: body.code };
      return { status: 'conflict', reason: body.reason };
    }
    case 'source_download': {
      const body = await executeStagedSourceDownloadBody({ authority });
      if (body.status === 'returned') return { status: 'returned', checkpoint: body.checkpoint };
      if (body.status === 'checkpoint_failed') return { status: 'held', reason: body.reason };
      if (body.status === 'threw') return { status: 'failed', outcome: 'threw', reason: body.code };
      if (body.status === 'preparation_required') {
        return { status: 'failed', outcome: 'threw', reason: body.reason };
      }
      return { status: 'conflict', reason: body.reason };
    }
    case 'upload_presign': {
      const prepared = prepareStagedComposioPresignBody({ authority });
      if (prepared.status !== 'prepared' && prepared.status !== 'replayed') {
        return { status: 'failed', outcome: 'threw', reason: 'reason' in prepared ? prepared.reason : 'presign preparation failed' };
      }
      const body = await executeStagedPreparedComposioPresignBody({
        authority,
        preparedPresign: prepared.preparedPresign,
      });
      if (body.status === 'returned') return { status: 'returned', checkpoint: body.checkpoint };
      if (body.status === 'checkpoint_failed') {
        return { status: 'held', reason: 'presign returned before its exact checkpoint could be committed' };
      }
      if (body.status === 'threw') {
        return { status: 'failed', outcome: 'unknown', reason: 'presign provider outcome is ambiguous' };
      }
      return { status: 'conflict', reason: body.reason };
    }
    case 'upload_transfer': {
      const body = await executeStagedUploadTransferBody({ authority });
      if (body.status === 'returned') return { status: 'returned', checkpoint: body.checkpoint };
      if (body.status === 'checkpoint_failed') return { status: 'held', reason: body.reason };
      if (body.status === 'threw') {
        return {
          status: 'failed',
          outcome: body.code === 'upload_ambiguous' ? 'unknown' : 'threw',
          reason: body.code,
        };
      }
      return { status: 'conflict', reason: body.reason };
    }
    case 'business_execute': {
      const prepared = prepareStagedComposioBusinessBody({ authority });
      if (prepared.status !== 'prepared' && prepared.status !== 'replayed') {
        return { status: 'failed', outcome: 'threw', reason: 'reason' in prepared ? prepared.reason : 'business preparation failed' };
      }
      const body = await executeStagedPreparedComposioBody({
        authority,
        preparedDispatch: prepared.preparedDispatch,
      });
      if (body.status === 'returned') return { status: 'returned', checkpoint: body.checkpoint };
      if (body.status === 'checkpoint_failed') {
        return { status: 'held', reason: 'business provider returned before its exact checkpoint could be committed' };
      }
      if (body.status === 'threw') {
        return {
          status: 'failed',
          outcome: state.effect === 'external_write' || state.effect === 'admin' ? 'unknown' : 'threw',
          reason: 'business provider outcome is ambiguous',
        };
      }
      return { status: 'conflict', reason: body.reason };
    }
    case 'download_transfer': {
      const prepared = prepareStagedDownloadBodyCarrier({ authority });
      if (prepared.status !== 'prepared' && prepared.status !== 'replayed') {
        return { status: 'failed', outcome: 'threw', reason: 'reason' in prepared ? prepared.reason : 'download preparation failed' };
      }
      const body = await executeCommittedComposioDownloadBody({ authority, carrier: prepared.carrier });
      if (body.status === 'returned') return { status: 'returned', checkpoint: body.checkpoint };
      if (body.status === 'checkpoint_failed') return { status: 'held', reason: body.reason };
      if (body.status === 'threw') return { status: 'failed', outcome: 'threw', reason: body.code };
      return { status: 'conflict', reason: body.reason };
    }
    case 'local_commit': {
      const body = executeStagedLocalCommitBody({ authority });
      if (body.status === 'returned') return localBlobCheckpoint({ authority, body });
      if (body.status === 'threw') return { status: 'failed', outcome: 'threw', reason: body.code };
      return { status: 'conflict', reason: body.reason };
    }
  }
}

/**
 * Execute or replay one exact prepared saga. Only a newly inserted physical
 * reservation enters a body. A pre-existing started row is held for recovery,
 * never replayed; a non-return terminal receipt is likewise never retried.
 */
export async function executePreparedStagedComposioPlan(input: {
  planAuthority: StagedTransferPlanAuthority;
  parentDispatchLease: DispatchLeaseRef;
  outputSchema: Record<string, unknown>;
}): Promise<StagedComposioExecutionResult> {
  let planAuthority = input.planAuthority;
  const plan = inspectStagedTransferPlanAuthority(planAuthority);
  if (!plan) return { status: 'conflict', reason: 'staged plan authority no longer reopens' };
  const planId = plan.planId;

  for (;;) {
    const stages = stageRows(planId);
    if (stages.length === 0) return { status: 'conflict', reason: 'staged plan has no immutable stages' };
    let advanced = false;
    for (const stage of stages) {
      const prior = latestAttempt(planId, stage.stage_ordinal);
      if (prior?.terminal_state === 'returned') continue;
      let attemptOrdinal = 1;
      if (prior?.terminal_state && stage.retry_policy === 'safe_terminal') {
        // One new, separately visible physical identity is attempted per
        // orchestration call. A failure returns to the host instead of hiding
        // an inline retry loop; a later host continuation may mint the next
        // generation from the durable terminal predecessor.
        attemptOrdinal = prior.attempt_ordinal + 1;
      } else if (prior?.terminal_state) {
        return {
          status: 'held',
          reason: `stage ${stage.stage_ordinal} requires reconciliation after ${prior.terminal_state}`,
        };
      }
      if (!prior?.terminal_state && prior?.physical_state === 'started') {
        return {
          status: 'held',
          reason: `stage ${stage.stage_ordinal} has an in-flight crossing that cannot be replayed`,
        };
      }
      if (!prior?.terminal_state && prior?.physical_state && prior.physical_state !== 'started') {
        return {
          status: 'conflict',
          reason: `stage ${stage.stage_ordinal} physical evidence lacks its terminal receipt`,
        };
      }

      const prepared = prepareStagedPhysicalDispatch({
        planAuthority,
        stageOrdinal: stage.stage_ordinal,
        attemptOrdinal,
        parentDispatchLease: input.parentDispatchLease,
      });
      if (prepared.status !== 'prepared' && prepared.status !== 'replayed') {
        return {
          status: prepared.status === 'storage_error' ? 'storage_error' : 'conflict',
          reason: safeReason(
            `stage ${stage.stage_ordinal} could not prepare`,
            'reason' in prepared ? prepared.reason : undefined,
          ),
        };
      }
      const begun = beginStagedPhysicalDispatch({ authority: prepared.authority });
      if (begun.status !== 'inserted') {
        return {
          status: begun.status === 'storage_error' ? 'storage_error' : begun.status === 'replayed' ? 'held' : 'conflict',
          reason: begun.status === 'replayed'
            ? `stage ${stage.stage_ordinal} crossing already exists and cannot be replayed`
            : safeReason(`stage ${stage.stage_ordinal} could not reserve its crossing`, begun.reason),
        };
      }

      const body = await executeStartedStage(prepared.authority);
      if (body.status === 'held') return { status: 'held', reason: safeReason('staged body needs recovery', body.reason) };
      if (body.status === 'conflict') {
        const terminal = settleStagedPhysicalDispatch({ authority: prepared.authority, outcome: 'threw' });
        return {
          status: terminal.status === 'storage_error' ? 'storage_error' : 'conflict',
          reason: safeReason('staged body authority conflicted', body.reason),
        };
      }
      if (body.status === 'failed') {
        const settled = settleStagedPhysicalDispatch({ authority: prepared.authority, outcome: body.outcome });
        if (settled.status !== 'inserted' && settled.status !== 'replayed') {
          return {
            status: settled.status === 'storage_error' ? 'storage_error' : 'conflict',
            reason: safeReason('staged failure settlement was not durable', settled.reason),
          };
        }
        return {
          status: body.outcome === 'unknown' ? 'held' : 'provider_failed',
          reason: safeReason(
            body.outcome === 'unknown' ? 'provider outcome requires reconciliation' : 'staged body failed',
            body.reason,
          ),
        };
      }
      const settled = settleStagedPhysicalDispatch({
        authority: prepared.authority,
        outcome: 'returned',
        returnCheckpoint: body.checkpoint,
      });
      if (settled.status !== 'inserted' && settled.status !== 'replayed') {
        return {
          status: settled.status === 'storage_error' ? 'storage_error' : 'conflict',
          reason: safeReason('staged returned settlement was not durable', settled.reason),
        };
      }
      advanced = true;
      if (stage.stage_kind === 'business_execute') {
        const successors = prepareStagedDownloadSuccessors({ planAuthority });
        if (successors.status === 'prepared' || successors.status === 'replayed') {
          planAuthority = successors.authority;
        } else if (successors.status !== 'not_applicable') {
          return {
            status: successors.status === 'storage_error' ? 'storage_error' : 'conflict',
            reason: safeReason(
              'download topology could not be committed',
              'reason' in successors ? successors.reason : undefined,
            ),
          };
        }
      }
      // Re-read immutable topology after every returned stage. This also makes
      // dynamic post-business successors visible without speculative ordering.
      break;
    }
    if (advanced) continue;

    const ordinal = businessStageOrdinal(planId);
    if (!ordinal) return { status: 'conflict', reason: 'staged plan lacks one business stage' };
    const business = reopenStagedPhysicalDispatchAuthority({
      planAuthority,
      stageOrdinal: ordinal,
    });
    if (business.status !== 'replayed') {
      return {
        status: business.status === 'storage_error' ? 'storage_error' : 'conflict',
        reason: safeReason(
          'business return authority could not reopen',
          'reason' in business ? business.reason : undefined,
        ),
      };
    }
    const committed = recoverCommittedStagedPhysicalReturn({ authority: business.authority });
    if (committed.status !== 'committed') {
      return {
        status: committed.status === 'storage_error' ? 'storage_error' : 'conflict',
        reason: safeReason('business return checkpoint could not reopen', committed.reason),
      };
    }
    const projected = projectCommittedComposioResult({
      returned: committed.returned,
      outputSchema: input.outputSchema,
    });
    return projected.status === 'projected'
      ? { status: 'returned', value: projected.value }
      : { status: 'conflict', reason: safeReason('business result could not project', projected.reason) };
  }
}

/** Prepare and execute only when the exact provider definition/runtime values
 * require staged file work. Ordinary no-file calls remain on their existing
 * one-shot transport and receive `not_applicable` here. */
export async function executeStagedComposioCall(input: {
  parentAdmission: StagedParentCallAdmission;
  providerArgs: Record<string, unknown>;
  parentDispatchLease: DispatchLeaseRef;
  outputSchema: Record<string, unknown>;
}): Promise<StagedComposioExecutionResult> {
  const prepared = prepareStagedTransferPlan({
    parentAdmission: input.parentAdmission,
    providerArgs: input.providerArgs,
  });
  if (prepared.status !== 'prepared' && prepared.status !== 'replayed') {
    return {
      status: prepared.status,
      reason: 'reason' in prepared ? prepared.reason : 'staged plan preparation failed',
    };
  }
  return executePreparedStagedComposioPlan({
    planAuthority: prepared.authority,
    parentDispatchLease: input.parentDispatchLease,
    outputSchema: input.outputSchema,
  });
}
