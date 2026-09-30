/** A connection pause retains the reviewed execution's canonical batch cursor.
 * It is context, not a connection grant, an approval, or a new execution owner. */
import { createHash } from 'node:crypto';
import { acceptedPlanExecution } from './accepted-plan-execution.js';
import {
  isAcceptedModelBatchRestartToken, prepareAcceptedModelBatchRestart,
  type AcceptedModelBatchRestartToken,
} from './accepted-model-batch-checkpoint.js';
import { parkObservedConnectionDependencyForSource } from './dependency-request.js';
import { appendEvent, openEventLog } from './eventlog.js';
import { completionEvidenceSource } from './recovery-activation.js';
import type { PlanRevisionRef } from './task-mode.js';
import { boundAgentCapabilityEnvelope, boundAgentCapabilityRevision } from '../../agents/capability-envelope.js';
import { boundAgentRebuildContext, type AgentRebuildContext } from '../../agents/agent-rebuild-context.js';
import { boundAgentMcpToolScope } from '../mcp-tool-authority.js';
import type { McpToolScope } from '../mcp-tool-scope.js';
import { sealAdmissionEnvelope, type AdmissionEnvelope, type CapabilityBindingRevision } from '../graph/admission-envelope.js';
import { boundAgentSourceSessionContext, type SourceSessionContextRef } from './source-session-context-scope.js';

/** Same construction records retained at workflow handoff. Historical tool
 * definitions and scope are context for rebuilding, never current authority. */
export interface ConnectionAgentCheckpoint {
  envelope: AdmissionEnvelope;
  bindingRevision?: CapabilityBindingRevision;
  rebuildContext: AgentRebuildContext;
  mcpToolScope: McpToolScope | null;
  modelId?: string;
  sessionContext?: SourceSessionContextRef;
}

export interface SourceConnectionCheckpoint {
  version: 1;
  requestId: string;
  sessionId: string;
  sourceUserSeq: number;
  dependencyDigest: string;
  plan: PlanRevisionRef;
  executionClaimId: string;
  executionClaimDigest: string;
  executionRunId: string;
  restartToken: AcceptedModelBatchRestartToken;
  /** Absent on older/custom builders: retain progress, but do not infer an
   * unrestricted replacement agent when activating a connection resume. */
  agent?: ConnectionAgentCheckpoint;
}

type CaptureResult =
  | { status: 'retained'; checkpoint: SourceConnectionCheckpoint }
  | { status: 'not_applicable' }
  | { status: 'unavailable'; reason: string };

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function captureAgent(agent: object | undefined, sessionId: string): ConnectionAgentCheckpoint | undefined {
  if (!agent) return undefined;
  const envelope = boundAgentCapabilityEnvelope(agent);
  const rebuildContext = boundAgentRebuildContext(agent);
  const mcp = boundAgentMcpToolScope(agent);
  if (!envelope || !rebuildContext || !mcp.bound || mcp.scope === undefined) return undefined;
  if (envelope.attemptId !== sessionId) throw new Error('The connection agent belongs to another session.');
  const bindingRevision = boundAgentCapabilityRevision(agent);
  const model = (agent as { model?: unknown }).model;
  const sessionContext = boundAgentSourceSessionContext(agent);
  // Never serialize an SDK agent, provider object, authentication or tool
  // closures. An opaque custom model cannot supply a replayable model id.
  return JSON.parse(JSON.stringify({ envelope, rebuildContext, mcpToolScope: mcp.scope,
    ...(bindingRevision ? { bindingRevision } : {}),
    ...(typeof model === 'string' && model.trim() ? { modelId: model } : {}),
    ...(sessionContext ? { sessionContext } : {}),
  })) as ConnectionAgentCheckpoint;
}

function assertRetainedAgent(value: ConnectionAgentCheckpoint, sessionId: string): void {
  if (!value || typeof value !== 'object' || !value.envelope || !value.rebuildContext
    || typeof value.rebuildContext !== 'object' || Array.isArray(value.rebuildContext)
    || !Object.hasOwn(value, 'mcpToolScope') || value.mcpToolScope === undefined
    || (value.mcpToolScope !== null && (typeof value.mcpToolScope !== 'object'
      || typeof value.mcpToolScope.reason !== 'string'))
    || value.envelope.attemptId !== sessionId
    || (value.modelId !== undefined && (typeof value.modelId !== 'string' || !value.modelId.trim()))) {
    throw new Error('The retained connection agent context is inconsistent.');
  }
  const sealed = sealAdmissionEnvelope(value.envelope);
  if (!sealed.ok || sealed.envelope.envelopeDigest !== value.envelope.envelopeDigest
    || (value.bindingRevision && value.bindingRevision.envelopeDigest !== value.envelope.envelopeDigest)) {
    throw new Error('The retained connection capability envelope is inconsistent.');
  }
}

function store() {
  const db = openEventLog();
  db.exec(`CREATE TABLE IF NOT EXISTS source_connection_checkpoints_v1 (
    request_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    source_user_seq INTEGER NOT NULL,
    checkpoint_json TEXT NOT NULL,
    checkpoint_digest TEXT NOT NULL,
    FOREIGN KEY(request_id) REFERENCES dependency_requests(request_id)
  );
  CREATE TRIGGER IF NOT EXISTS source_connection_checkpoints_v1_no_update
    BEFORE UPDATE ON source_connection_checkpoints_v1
    BEGIN SELECT RAISE(ABORT, 'connection checkpoints are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS source_connection_checkpoints_v1_no_delete
    BEFORE DELETE ON source_connection_checkpoints_v1
    BEGIN SELECT RAISE(ABORT, 'connection checkpoints are immutable'); END;`);
  return db;
}

function dependencyIdentity(input: { sessionId: string; requestId: string }) {
  const db = openEventLog();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dependency_requests'").get()) return null;
  return db.prepare(`SELECT request_id, session_id, source_user_seq, kind, subject_kind,
    subject_provider, subject_toolkit, subject_capability, subject_capability_ref,
    subject_discovery_query, subject_discovery_role, continue_option_id, continue_option_label
    FROM dependency_requests WHERE request_id = ? AND session_id = ?
    AND kind = 'connection_missing' AND subject_kind = 'exact_capability_connection'`)
    .get(input.requestId, input.sessionId) as ({ source_user_seq: number } & Record<string, unknown>) | undefined;
}

/** Retained identity remains readable after newer chat overwrites the session
 * snapshot. Resume must separately prove current task, account, capability,
 * cancellation, activation lease, and reopen the token's complete evidence. */
export function readSourceConnectionCheckpoint(input: { sessionId: string; requestId: string }): SourceConnectionCheckpoint | null {
  const db = openEventLog();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_connection_checkpoints_v1'").get()) return null;
  const row = db.prepare(`SELECT checkpoint_json, checkpoint_digest, source_user_seq
    FROM source_connection_checkpoints_v1 WHERE request_id = ? AND session_id = ?`)
    .get(input.requestId, input.sessionId) as { checkpoint_json: string; checkpoint_digest: string; source_user_seq: number } | undefined;
  if (!row) return null;
  const value = JSON.parse(row.checkpoint_json) as SourceConnectionCheckpoint;
  if (digest(row.checkpoint_json) !== row.checkpoint_digest || !value || value.version !== 1
    || value.sessionId !== input.sessionId || value.requestId !== input.requestId
    || value.sourceUserSeq !== row.source_user_seq || !isAcceptedModelBatchRestartToken(value.restartToken)
    || value.restartToken.sessionId !== value.sessionId || value.restartToken.sourceUserSeq !== value.sourceUserSeq) {
    throw new Error('The retained connection checkpoint is inconsistent.');
  }
  if (value.agent !== undefined) assertRetainedAgent(value.agent, input.sessionId);
  const dependency = dependencyIdentity(input);
  const selected = acceptedPlanExecution(input.sessionId, value.sourceUserSeq);
  if (!dependency || dependency.source_user_seq !== value.sourceUserSeq
    || digest(JSON.stringify(dependency)) !== value.dependencyDigest || !selected
    || selected.claim.claimId !== value.executionClaimId || selected.claim.digest !== value.executionClaimDigest
    || selected.claim.executionRunId !== value.executionRunId
    || selected.artifact.planId !== value.plan?.planId || selected.artifact.revision !== value.plan?.revision
    || selected.artifact.digest !== value.plan?.digest) {
    throw new Error('The retained connection checkpoint lost its reviewed execution owner.');
  }
  return value;
}

/** Called only after a typed dependency has been parked. Never copy the mutable
 * session/outcome history: its final ASK frame is outside the accepted batch
 * chain, so passing it to the next batch would break the history digest. */
export function captureSourceConnectionCheckpoint(input: { sessionId: string; requestId: string; agent?: object }): CaptureResult {
  return openEventLog().transaction((): CaptureResult => {
    const dependency = dependencyIdentity(input);
    if (!dependency) return { status: 'not_applicable' };
    const selected = acceptedPlanExecution(input.sessionId, dependency.source_user_seq);
    if (!selected) return { status: 'not_applicable' };
    const prior = readSourceConnectionCheckpoint(input);
    if (prior) return { status: 'retained', checkpoint: prior };
    const restart = prepareAcceptedModelBatchRestart({ sessionId: input.sessionId, sourceUserSeq: dependency.source_user_seq });
    if (restart.status !== 'ready') return { status: 'unavailable', reason: restart.status };
    const agent = captureAgent(input.agent, input.sessionId);
    if (agent) assertRetainedAgent(agent, input.sessionId);
    if (agent?.sessionContext && (agent.sessionContext.sessionId !== input.sessionId
      || agent.sessionContext.sourceUserSeq !== dependency.source_user_seq)) {
      throw new Error('The paused agent belongs to another accepted task.');
    }
    const checkpoint: SourceConnectionCheckpoint = {
      version: 1, sessionId: input.sessionId, requestId: input.requestId, sourceUserSeq: dependency.source_user_seq,
      dependencyDigest: digest(JSON.stringify(dependency)),
      plan: { planId: selected.artifact.planId, revision: selected.artifact.revision, digest: selected.artifact.digest },
      executionClaimId: selected.claim.claimId, executionClaimDigest: selected.claim.digest,
      executionRunId: selected.claim.executionRunId, restartToken: restart.token,
      ...(agent ? { agent } : {}),
    };
    const json = JSON.stringify(checkpoint);
    store().prepare('INSERT INTO source_connection_checkpoints_v1 VALUES (?, ?, ?, ?, ?)')
      .run(input.requestId, input.sessionId, dependency.source_user_seq, json, digest(json));
    return { status: 'retained', checkpoint };
  }).immediate();
}

/** Both ASK projection and explicit awaiting-input use this seam. Missing
 * recovery evidence keeps the task paused and emits one diagnostic; it must
 * never invent a checkpoint or turn account readiness into execution consent. */
export function parkObservedConnectionWithCheckpoint(input: Parameters<typeof parkObservedConnectionDependencyForSource>[0] & { agent?: object }) {
  return openEventLog().transaction(() => {
    // After an approval, this hook receives the delivery source. Only the
    // already-validated durable resume marker may select its execution root.
    const execution = completionEvidenceSource(input);
    const dependency = parkObservedConnectionDependencyForSource({ ...input, ...execution });
    if (!dependency || dependency.connectionSubject?.kind !== 'exact_capability_connection') return dependency;
    let captured: CaptureResult;
    try {
      captured = captureSourceConnectionCheckpoint({ sessionId: input.sessionId, requestId: dependency.requestId, agent: input.agent });
    } catch {
      // The strict reader must reject corrupt or mismatched retained context,
      // but optional capture must not destroy the existing public pause.
      captured = { status: 'unavailable', reason: 'checkpoint_context_inconsistent' };
    }
    if (captured.status === 'unavailable') {
      const prior = openEventLog().prepare(`SELECT 1 FROM events WHERE session_id = ?
        AND type = 'connection_execution_checkpoint_unavailable'
        AND json_extract(data_json, '$.requestId') = ? AND json_extract(data_json, '$.reason') = ?`)
        .get(input.sessionId, dependency.requestId, captured.reason);
      if (!prior) appendEvent({ sessionId: input.sessionId, turn: input.turn, role: 'system',
        type: 'connection_execution_checkpoint_unavailable',
        data: { sourceUserSeq: execution.sourceUserSeq, deliverySourceUserSeq: input.sourceUserSeq,
          requestId: dependency.requestId, reason: captured.reason } });
    }
    return dependency;
  }).immediate();
}
