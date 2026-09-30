/** Compact durable identity for one accepted request. No prompt or memory dump. */
import { createHash } from 'node:crypto';
import { getSession, openEventLog, type SessionKind } from './eventlog.js';
import { composeSession, type SessionMount } from './session-composition.js';
import { getAgentRecord } from '../../agents/agent-record.js';
import { agentScopeKey, type MemoryScope } from '../../memory/memory-scope.js';
import { readApprovalRecoveryActivation } from './recovery-activation.js';
import { currentSourceSessionContext, withSourceSessionContext,
  type SourceSessionContext, type SourceSessionContextRef } from './source-session-context-scope.js';

interface SourceSessionIdentity {
  version: 1;
  sessionId: string;
  sourceUserSeq: number;
  sessionKind: SessionKind;
  mountKind: SessionMount['kind'];
  workspaceSlug: string | null;
  workflow: SessionMount['workflow'];
  delegatedTaskId: string | null;
  agent: { id: string; createdAt: string | null; digest: string } | null;
  project: { id: string; revision: string } | null;
  mountDigest: string;
  memoryScope: MemoryScope;
  parent?: SourceSessionContextRef;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function table() {
  const db = openEventLog();
  db.exec(`CREATE TABLE IF NOT EXISTS source_session_contexts_v1 (
    session_id TEXT NOT NULL, source_user_seq INTEGER NOT NULL,
    identity_json TEXT NOT NULL, identity_digest TEXT NOT NULL,
    PRIMARY KEY(session_id, source_user_seq), FOREIGN KEY(source_user_seq) REFERENCES events(seq)
  );
  CREATE TRIGGER IF NOT EXISTS source_session_contexts_v1_no_update BEFORE UPDATE ON source_session_contexts_v1
    BEGIN SELECT RAISE(ABORT, 'source composition is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS source_session_contexts_v1_no_delete BEFORE DELETE ON source_session_contexts_v1
    BEGIN SELECT RAISE(ABORT, 'source composition is immutable'); END;`);
  return db;
}

function agentIdentity(mount: SessionMount): SourceSessionIdentity['agent'] {
  const binding = mount.agent;
  if (!binding) return null;
  return { id: binding.agent.id, createdAt: binding.agent.createdAt,
    digest: hash({ context: binding.context, model: binding.model, tools: binding.tools,
      pinnedSkills: binding.pinnedSkills, missingSkills: binding.missingSkills }) };
}
function mountDigest(mount: SessionMount): string {
  return hash({ kind: mount.kind, workspaceSlug: mount.workspaceSlug, workflow: mount.workflow,
    primers: mount.primers, pinnedTools: mount.pinnedTools, hotTools: mount.hotTools,
    agent: agentIdentity(mount), project: mount.project ? { id: mount.project.project.id, revision: mount.project.revision } : null });
}

function assertSource(input: Pick<SourceSessionContextRef, 'sessionId' | 'sourceUserSeq'>): void {
  if (!Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 0
    || !openEventLog().prepare("SELECT 1 FROM events WHERE session_id = ? AND seq = ? AND type = 'user_input_received' AND role = 'user'")
      .get(input.sessionId, input.sourceUserSeq)) throw new Error('Task composition has no exact accepted source.');
}

function reopen(identity: SourceSessionIdentity, digest: string): SourceSessionContext {
  assertSource(identity);
  if (!getSession(identity.sessionId) || identity.version !== 1 || !identity.memoryScope
    || ![identity.memoryScope.projectId, identity.memoryScope.agentKey].every(v => v === null || typeof v === 'string')) {
    throw new Error('The retained task composition is unavailable.');
  }
  // An id is not a name lookup. A new agent with the old name cannot take over.
  if (identity.agent && !identity.agent.createdAt) {
    throw new Error('The original task agent has no durable creation identity for recovery.');
  }
  if (identity.agent && getAgentRecord(identity.agent.id)?.createdAt !== identity.agent.createdAt) {
    throw new Error('The original task agent was deleted or replaced.');
  }
  const mount = composeSession({ sessionId: identity.sessionId, sessionKind: identity.sessionKind,
    metadata: {
      ...(identity.agent ? { agentId: identity.agent.id, delegatedAgentCreatedAt: identity.agent.createdAt } : {}),
      ...(identity.project ? { projectId: identity.project.id } : {}),
      ...(identity.delegatedTaskId ? { delegatedTaskId: identity.delegatedTaskId } : {}),
      ...(identity.workspaceSlug ? { __session_mount: { version: 1, kind: 'workspace',
        workspaceSlug: identity.workspaceSlug, rootSessionId: `space-${identity.workspaceSlug}` } } : {}),
      ...(identity.workflow ? { workflowName: identity.workflow.name, workflowRunId: identity.workflow.runId,
        stepId: identity.workflow.stepId } : {}),
    } });
  if (mount.kind !== identity.mountKind || mountDigest(mount) !== identity.mountDigest) {
    throw new Error('The original task agent, project, skills or workspace context changed.');
  }
  if (identity.parent) {
    const parent = readSourceSessionContext(identity.parent, identity.parent.digest);
    if (!parent || hash(parent.memoryScope) !== hash(identity.memoryScope)) {
      throw new Error('The worker lost its original parent memory scope.');
    }
  }
  return { sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq, digest, mount,
    memoryScope: { ...identity.memoryScope } };
}

/** Does not infer a missing historical identity from today's chat settings. */
export function readSourceSessionContext(input: Pick<SourceSessionContextRef, 'sessionId' | 'sourceUserSeq'>,
  expectedDigest?: string): SourceSessionContext | null {
  const db = openEventLog();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_session_contexts_v1'").get()) return null;
  const row = db.prepare('SELECT identity_json, identity_digest FROM source_session_contexts_v1 WHERE session_id = ? AND source_user_seq = ?')
    .get(input.sessionId, input.sourceUserSeq) as { identity_json: string; identity_digest: string } | undefined;
  if (!row) return null;
  const value = JSON.parse(row.identity_json) as SourceSessionIdentity;
  if (value.sessionId !== input.sessionId || value.sourceUserSeq !== input.sourceUserSeq
    || hash(value) !== row.identity_digest || (expectedDigest && row.identity_digest !== expectedDigest)) {
    throw new Error('The retained task composition identity is inconsistent.');
  }
  return reopen(value, row.identity_digest);
}

/** Only the entry point that just accepted a NEW source may call this.
 * A legacy agent without an incarnation or a helper without retained parent
 * context keeps its existing behavior, but cannot claim durable reconstruction. */
export function captureFreshSourceSessionContext(input: Pick<SourceSessionContextRef, 'sessionId' | 'sourceUserSeq'>): SourceSessionContext | null {
  const active = currentSourceSessionContext(input.sessionId);
  if (active) {
    if (active.sourceUserSeq !== input.sourceUserSeq) throw new Error('Task composition source changed during execution.');
    return active;
  }
  return openEventLog().transaction(() => {
    const prior = readSourceSessionContext(input);
    if (prior) return prior;
    assertSource(input);
    const row = getSession(input.sessionId);
    if (!row) throw new Error('The task session is unavailable.');
    const mount = composeSession({ sessionId: input.sessionId, sessionKind: row.kind, metadata: row.metadata });
    if (mount.agent && !mount.agent.agent.createdAt) return null;
    // Ordinary task reads and learning share this exact scope. A helper child
    // inherits the current parent scope through its existing runtime binding.
    const parentId = typeof row.metadata?.parentSessionId === 'string' ? row.metadata.parentSessionId : null;
    const parentSeq = row.metadata?.parentSourceUserSeq;
    const helper = row.metadata?.workerScope === true || row.metadata?.source === 'delegated_worker';
    const parent = helper && parentId && parentId !== input.sessionId && Number.isSafeInteger(parentSeq)
      ? currentSourceSessionContext(parentId) ?? readSourceSessionContext({ sessionId: parentId, sourceUserSeq: Number(parentSeq) })
      : undefined;
    if (parent && parent.sourceUserSeq !== parentSeq) throw new Error('Worker composition points to another parent request.');
    if (helper && !parent) return null;
    // Never persist a process cache/pin as evidence of the freshly selected
    // agent incarnation. Only a validated parent can supply inherited scope.
    const memoryScope: MemoryScope = parent?.memoryScope ?? {
      projectId: mount.project?.project.id ?? null, agentKey: mount.agent ? agentScopeKey(mount.agent.agent) : null };
    const identity: SourceSessionIdentity = { version: 1, ...input, sessionKind: row.kind,
      mountKind: mount.kind, workspaceSlug: mount.workspaceSlug, workflow: mount.workflow,
      delegatedTaskId: typeof row.metadata?.delegatedTaskId === 'string' ? row.metadata.delegatedTaskId : null,
      agent: agentIdentity(mount), project: mount.project ? { id: mount.project.project.id, revision: mount.project.revision } : null,
      mountDigest: mountDigest(mount), memoryScope,
      ...(parent ? { parent: { sessionId: parent.sessionId, sourceUserSeq: parent.sourceUserSeq, digest: parent.digest } } : {}) };
    const digest = hash(identity);
    table().prepare('INSERT INTO source_session_contexts_v1 VALUES (?, ?, ?, ?)')
      .run(input.sessionId, input.sourceUserSeq, JSON.stringify(identity), digest);
    return { ...input, digest, mount, memoryScope };
  }).immediate();
}

export function withAcceptedSourceSessionContext<T>(
  input: Pick<SourceSessionContextRef, 'sessionId' | 'sourceUserSeq'>,
  run: (execution: Pick<SourceSessionContextRef, 'sessionId' | 'sourceUserSeq'>) => T,
  options: { newlyAccepted?: boolean } = {},
): T {
  // Approval checkpoints have a delivery source and a different execution
  // root. Resolve the validated root BEFORE retrieval or construction. Never
  // nest a control-event context around the original execution's context.
  const rawOwner = getSession(input.sessionId)?.metadata?.__host_recovery_owner as { sourceUserSeq?: number } | undefined;
  const activation = rawOwner?.sourceUserSeq === input.sourceUserSeq
    ? readApprovalRecoveryActivation(input.sessionId) : null;
  const execution = activation?.approvalContinuation
    ? { sessionId: input.sessionId, sourceUserSeq: activation.approvalContinuation.requestSourceUserSeq }
    : input;
  const active = currentSourceSessionContext(execution.sessionId);
  if (active && active.sourceUserSeq !== execution.sourceUserSeq) throw new Error('Task composition source changed during execution.');
  const context = active ?? (options.newlyAccepted && execution === input
    ? captureFreshSourceSessionContext(execution) : readSourceSessionContext(execution));
  return context ? withSourceSessionContext(context, () => run(execution)) : run(execution);
}
