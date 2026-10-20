/** Pure canonical accepted-source/call digest codecs; no store initialization. */
import { createHash } from 'node:crypto';

export interface AcceptedTurnSourceEventDigestInput {
  id: string;
  sessionId: string;
  seq: number;
  turn: number;
  role: string;
  type: string;
  parentEventId: string | null;
  dataJson: string;
  createdAt: string;
}

/** Value-opaque identity for the exact accepted source event. The raw prompt
 * stays in events.data_json; call authority persists only this digest. */
export function acceptedTurnSourceEventDigest(
  input: AcceptedTurnSourceEventDigestInput,
): string {
  return createHash('sha256').update(JSON.stringify({
    id: input.id,
    sessionId: input.sessionId,
    seq: input.seq,
    turn: input.turn,
    role: input.role,
    type: input.type,
    parentEventId: input.parentEventId,
    dataJson: input.dataJson,
    createdAt: input.createdAt,
  })).digest('hex');
}

export interface AcceptedTurnCallAuthorityDigestInput {
  authorityKind:
    | 'turn_graph'
    | 'host_v1'
    | 'host_v1_read_only'
    | 'workflow_v1_read_only'
    | 'workflow_v2_paginated_read'
    | 'workflow_v3_call';
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  sourceEventId: string;
  sourceEventDigest: string;
  sourceTurn: number;
  engineVersion: string;
  surfaceVersion: string;
  surfaceDigest: string;
  effectCeiling: string;
  effectBoundsJson: string;
  maxLogicalCalls: number | null;
  maxParallelCalls: number | null;
  catalogRevisionDigest: string | null;
  bindingRevisionDigest: string | null;
  graphEventId: string | null;
  graphHash: string | null;
  workflowActivationId?: string | null;
  workflowActivationDigest?: string | null;
  workflowId?: string | null;
  workflowRevision?: number | null;
  workflowDigest?: string | null;
  runId?: string | null;
  runOccurrenceId?: string | null;
  workflowNodeId?: string | null;
  workflowNodeAttempt?: number | null;
  invocationPlanDigest?: string | null;
  bindingSnapshotDigest?: string | null;
  controlDigest?: string | null;
  workflowLogicalCallId?: string | null;
}

/** Immutable root digest shared by migration backfill and runtime arming. */
export function acceptedTurnCallAuthorityDigest(
  input: AcceptedTurnCallAuthorityDigestInput,
): string {
  return createHash('sha256').update(JSON.stringify({
    protocolVersion: 1,
    ...input,
  })).digest('hex');
}

export function acceptedTurnCallSurfaceDigest(input: {
  authorityKind: AcceptedTurnCallAuthorityDigestInput['authorityKind'];
  engineVersion: string;
  surfaceVersion: string;
  effectCeiling: string;
  effectBoundsJson: string;
  maxLogicalCalls: number | null;
  maxParallelCalls: number | null;
  catalogRevisionDigest: string | null;
  bindingRevisionDigest: string | null;
  graphEventId: string | null;
  graphHash: string | null;
  workflowActivationId?: string | null;
  workflowActivationDigest?: string | null;
  workflowId?: string | null;
  workflowRevision?: number | null;
  workflowDigest?: string | null;
  runId?: string | null;
  runOccurrenceId?: string | null;
  workflowNodeId?: string | null;
  workflowNodeAttempt?: number | null;
  invocationPlanDigest?: string | null;
  bindingSnapshotDigest?: string | null;
  controlDigest?: string | null;
  workflowLogicalCallId?: string | null;
}): string {
  return createHash('sha256').update(JSON.stringify({
    protocolVersion: 1,
    ...input,
  })).digest('hex');
}
