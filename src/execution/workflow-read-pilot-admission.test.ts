import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createWorkflowNodeInvocationPlan } from '../memory/workflow-node-invocation-plan.js';
import { oneShotActivationAuthorizationDecisionDigest } from '../runtime/harness/accepted-turn-call-authority.js';
import type { PendingApprovalRow } from '../runtime/harness/approval-registry.js';
import {
  bindWorkflowReadPilotAdmission,
  createWorkflowReadPilotAdmissionDraft,
  resolveWorkflowReadPilotAdmission,
  workflowReadPilotApprovalMatches,
  workflowReadPilotApprovalRequest,
  type WorkflowReadPilotAdmissionDraftV1,
  type WorkflowReadPilotLineageV1,
} from './workflow-read-pilot-admission.js';
import {
  workflowDefinitionHash,
  type WorkflowRunDefinitionSnapshot,
} from './workflow-run-definition.js';

function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex');
}

function fixture(options: { paginated?: boolean } = {}) {
  const paginated = options.paginated === true;
  const plan = createWorkflowNodeInvocationPlan({
    requirementId: 'requirement.alpha',
    logicalCapabilityId: 'logical.alpha',
    binding: {
      capabilityId: 'capability.alpha',
      manifestId: 'manifest.alpha',
      manifestDigest: digest('manifest'),
      operationId: 'operation.alpha',
      operationVersion: '1',
      schemaDigest: digest('schema'),
      providerVersion: '1',
      liveFingerprint: digest('live'),
      accountId: 'account.alpha',
      effect: 'read',
      invokePortId: 'port.alpha',
      argumentCompiler: { id: 'compiler.alpha', version: '1' },
    },
    arguments: {
      scope: {
        source: { kind: 'workflow_input', key: 'scope' },
        required: true,
        type: 'string',
      },
      ...(paginated ? {
        cursor: {
          source: { kind: 'continuation_cursor' as const },
          required: false,
          type: 'string' as const,
        },
      } : {}),
    },
    evidence: { requiredPaths: ['records'], nonEmptyPaths: ['records'], minItems: {} },
    completeness: paginated
      ? { kind: 'finite_exhaustive', exhaustedPath: 'page.exhausted', evidencePaths: ['records'] }
      : { kind: 'terminal_result', evidencePaths: ['records'] },
    continuation: paginated
      ? {
          kind: 'cursor',
          cursorArgument: 'cursor',
          nextCursorPath: 'page.next',
          exhaustedPath: 'page.exhausted',
          maxPages: 3,
        }
      : { kind: 'none' },
  });
  const definition = {
    name: 'workflow.alpha',
    description: 'Exact disabled pilot.',
    enabled: false,
    trigger: { manual: true as const },
    allowedTools: [],
    inputs: { scope: { type: 'string' as const, required: true } },
    steps: [{
      id: 'node.alpha',
      prompt: '',
      allowedTools: [],
      sideEffect: 'read' as const,
      requiresApproval: false,
      invocationPlan: plan,
    }],
  };
  const snapshot: WorkflowRunDefinitionSnapshot = {
    version: 1,
    workflowSlug: 'workflow.alpha',
    definitionHash: workflowDefinitionHash(definition),
    admittedAt: '2026-08-22T12:00:00.000Z',
    definition,
  };
  const lineage: WorkflowReadPilotLineageV1 = {
    version: 1,
    proposalId: 'proposal.alpha',
    proposalRevision: 2,
    proposalDigest: digest('proposal'),
    compilationDigest: digest('compilation'),
    bindingSnapshotDigest: digest('binding'),
    controlDigest: digest('control'),
    workflowId: 'workflow.alpha',
    workflowRevision: 2,
    workflowDigest: snapshot.definitionHash,
    runOccurrenceId: 'occurrence.alpha',
    nodeId: 'node.alpha',
    nodeAttempt: 1,
    invocationPlanDigest: plan.bindingDigest,
    workflowSessionId: 'workflow.session.alpha',
  };
  const request = workflowReadPilotApprovalRequest(lineage);
  const baseApproval: PendingApprovalRow = {
    approvalId: 'approval.alpha',
    sessionId: 'chat.alpha',
    channel: 'desktop',
    channelId: null,
    requestedAt: '2026-08-22T12:01:00.000Z',
    expiresAt: '2026-08-23T12:01:00.000Z',
    subject: request.subject,
    tool: request.tool,
    args: request.args,
    status: 'resolved',
    resolution: 'approved',
    resolver: 'user.alpha',
    resolvedAt: '2026-08-22T12:02:00.000Z',
    resumeKey: request.resumeKey,
    consumedAt: null,
    presentation: null,
  };
  const decisionDigest = oneShotActivationAuthorizationDecisionDigest({
    approvalId: baseApproval.approvalId,
    approvalSessionId: baseApproval.sessionId,
    resumeKey: baseApproval.resumeKey!,
    requestedAt: baseApproval.requestedAt,
    expiresAt: baseApproval.expiresAt,
    subject: baseApproval.subject,
    tool: baseApproval.tool,
    args: baseApproval.args,
    resolver: baseApproval.resolver!,
    resolvedAt: baseApproval.resolvedAt!,
  });
  const draft = createWorkflowReadPilotAdmissionDraft({
    lineage,
    oneShotActivationAuthorization: {
      approvalId: baseApproval.approvalId,
      resumeKey: request.resumeKey,
      decisionDigest,
    },
  });
  return { plan, definition, snapshot, lineage, request, approval: baseApproval, draft };
}

test('exact pilot admission binds run/snapshot bytes and round-trips canonically', () => {
  const value = fixture();
  assert.equal(workflowReadPilotApprovalMatches(value.approval, value.draft), true);
  const bound = bindWorkflowReadPilotAdmission({
    draft: value.draft,
    runId: 'run.alpha',
    snapshot: value.snapshot,
    approval: value.approval,
  });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  if (!bound.ok) return;
  const replay = resolveWorkflowReadPilotAdmission({
    value: structuredClone(bound.admission),
    runId: 'run.alpha',
    snapshot: value.snapshot,
    approval: value.approval,
  });
  assert.deepEqual(replay, bound);
});

test('queue admission requires an unused grant while exact runtime restart may revalidate consumed lineage', () => {
  const value = fixture();
  const consumed = { ...value.approval, consumedAt: '2026-08-22T12:03:00.000Z' };
  assert.equal(workflowReadPilotApprovalMatches(consumed, value.draft), false);
  assert.equal(workflowReadPilotApprovalMatches(consumed, value.draft, { allowConsumed: true }), true);
  assert.equal(bindWorkflowReadPilotAdmission({
    draft: value.draft,
    runId: 'run.alpha',
    snapshot: value.snapshot,
    approval: consumed,
  }).ok, false);
  assert.equal(bindWorkflowReadPilotAdmission({
    draft: value.draft,
    runId: 'run.alpha',
    snapshot: value.snapshot,
    approval: consumed,
    allowConsumedApproval: true,
  }).ok, true);
});

test('exact paginated pilot admission is selected only by its sealed cursor and completeness contract', () => {
  const value = fixture({ paginated: true });
  const bound = bindWorkflowReadPilotAdmission({
    draft: value.draft,
    runId: 'run.alpha',
    snapshot: value.snapshot,
    approval: value.approval,
  });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  assert.deepEqual(value.plan.continuation, {
    kind: 'cursor',
    cursorArgument: 'cursor',
    nextCursorPath: 'page.next',
    exhaustedPath: 'page.exhausted',
    maxPages: 3,
  });
  assert.equal(value.plan.completeness.kind, 'finite_exhaustive');
});

test('pilot admission remains manual-only even when an exact interval contract is present', () => {
  const value = fixture();
  const definition = {
    ...value.definition,
    trigger: {
      manual: true as const,
      interval: {
        version: 1 as const,
        every: 2,
        unit: 'hour' as const,
        anchorAt: '2026-08-22T12:00:00.000Z',
        overlapPolicy: 'skip' as const,
        catchUpPolicy: 'run_once' as const,
      },
    },
  };
  const snapshot: WorkflowRunDefinitionSnapshot = {
    ...value.snapshot,
    definition,
    definitionHash: workflowDefinitionHash(definition),
  };
  const lineage: WorkflowReadPilotLineageV1 = {
    ...value.lineage,
    workflowDigest: snapshot.definitionHash,
  };
  const request = workflowReadPilotApprovalRequest(lineage);
  const approval: PendingApprovalRow = {
    ...value.approval,
    subject: request.subject,
    tool: request.tool,
    args: request.args,
    resumeKey: request.resumeKey,
  };
  const decisionDigest = oneShotActivationAuthorizationDecisionDigest({
    approvalId: approval.approvalId,
    approvalSessionId: approval.sessionId,
    resumeKey: approval.resumeKey!,
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
    subject: approval.subject,
    tool: approval.tool,
    args: approval.args,
    resolver: approval.resolver!,
    resolvedAt: approval.resolvedAt!,
  });
  const draft = createWorkflowReadPilotAdmissionDraft({
    lineage,
    oneShotActivationAuthorization: {
      approvalId: approval.approvalId,
      resumeKey: request.resumeKey,
      decisionDigest,
    },
  });
  const result = bindWorkflowReadPilotAdmission({
    draft,
    runId: 'run.alpha',
    snapshot,
    approval,
  });
  assert.deepEqual(result, {
    ok: false,
    reason: 'admitted workflow snapshot does not match the disabled one-read pilot',
  });
});

test('getter, reserved, deep, oversized, and non-plain admission bytes fail without getter execution', () => {
  const value = fixture();
  let reads = 0;
  const getterDraft = structuredClone(value.draft) as WorkflowReadPilotAdmissionDraftV1;
  Object.defineProperty(getterDraft, 'proposalId', {
    enumerable: true,
    get() {
      reads += 1;
      return 'proposal.alpha';
    },
  });
  const reserved = structuredClone(value.draft) as WorkflowReadPilotAdmissionDraftV1 & Record<string, unknown>;
  Object.defineProperty(reserved, '__proto__', { value: {}, enumerable: true });
  const deep = structuredClone(value.draft) as WorkflowReadPilotAdmissionDraftV1 & Record<string, unknown>;
  let cursor: Record<string, unknown> = deep;
  for (let index = 0; index < 30; index += 1) {
    cursor.extra = {};
    cursor = cursor.extra as Record<string, unknown>;
  }
  const oversized = structuredClone(value.draft) as WorkflowReadPilotAdmissionDraftV1 & Record<string, unknown>;
  oversized.extra = 'x'.repeat(33_000);

  for (const draft of [getterDraft, reserved, deep, oversized, new Date() as unknown as WorkflowReadPilotAdmissionDraftV1]) {
    const result = bindWorkflowReadPilotAdmission({
      draft,
      runId: 'run.alpha',
      snapshot: value.snapshot,
      approval: value.approval,
    });
    assert.equal(result.ok, false);
  }
  assert.equal(reads, 0);
});
