/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/workflow-gate-write-coverage.test.ts
 *
 * A human approved a step at its gate: the step's declared local writes are
 * covered by that approval. Live 2026-09-22: three write_file calls with the
 * right arguments were refused (coverage_missing) after an approval.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-gate-cov-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { gateApprovedStepWriteCoverage, workflowStepSessionRef } = await import('./workflow-gate-write-coverage.js');
const { WORKFLOW_RUNS_DIR } = await import('../../tools/shared.js');

const approvedRows = [{ approvalId: 'apr-1', resolution: 'approved', resolvedAt: '2026-09-22T16:12:04.000Z', requestedAt: '2026-09-22T16:12:00.000Z' }];
const writeStep = { id: 'save_drafts', allowedTools: ['write_file'], requiresApproval: true, sideEffect: 'write' };

test('session ids parse only in the host\'s own step shape', () => {
  assert.deepEqual(workflowStepSessionRef('workflow:1790093495627-86e3b4:save_drafts'), { runId: '1790093495627-86e3b4', stepId: 'save_drafts' });
  assert.equal(workflowStepSessionRef('sess-desktop-abc'), null);
  assert.equal(workflowStepSessionRef('workflow-gate:run:step'), null);
});

test('an approved gate covers the step\'s declared local write, one reservation per call', () => {
  const scope = gateApprovedStepWriteCoverage({
    sessionId: 'workflow:run-1:save_drafts', toolName: 'write_file', logicalToolCallId: 'call-a',
    approvals: () => approvedRows, step: () => writeStep,
  });
  assert.ok(scope);
  assert.equal(scope.contractId, 'workflow-gate:run-1:save_drafts');
  assert.equal(scope.requirementId, 'save_drafts:write_file');
  assert.match(scope.requirementDigest, /^[a-f0-9]{64}$/);
  assert.equal(scope.reservationKey, 'apr-1:write_file:call-a');
  const second = gateApprovedStepWriteCoverage({
    sessionId: 'workflow:run-1:save_drafts', toolName: 'mcp__clementine-local__write_file', logicalToolCallId: 'call-b',
    approvals: () => approvedRows, step: () => writeStep,
  });
  assert.equal(second?.reservationKey, 'apr-1:write_file:call-b', 'a second file is a second reservation, not a spent one');
  assert.equal(second?.requirementDigest, scope.requirementDigest);
});

test('no approval, a declined gate, an undeclared tool, a send step or a chat session give no coverage', () => {
  const base = { sessionId: 'workflow:run-1:save_drafts', toolName: 'write_file', logicalToolCallId: 'call-a' };
  assert.equal(gateApprovedStepWriteCoverage({ ...base, approvals: () => [], step: () => writeStep }), null);
  assert.equal(gateApprovedStepWriteCoverage({ ...base, approvals: () => [{ ...approvedRows[0], resolution: 'rejected' }], step: () => writeStep }), null);
  assert.equal(gateApprovedStepWriteCoverage({ ...base, approvals: () => approvedRows, step: () => ({ ...writeStep, allowedTools: ['read_file'] }) }), null, 'undeclared tool');
  assert.equal(gateApprovedStepWriteCoverage({ ...base, approvals: () => approvedRows, step: () => ({ ...writeStep, requiresApproval: false }) }), null, 'no gate on the step');
  assert.equal(gateApprovedStepWriteCoverage({ ...base, approvals: () => approvedRows, step: () => ({ ...writeStep, sideEffect: 'send', allowedTools: ['write_file'] }) }), null, 'the send floor is untouched');
  assert.equal(gateApprovedStepWriteCoverage({ ...base, sessionId: 'sess-desktop-1', approvals: () => approvedRows, step: () => writeStep }), null);
});

test('production reads the step from the run record\'s admitted snapshot', () => {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'run-snap.json'), JSON.stringify({
    id: 'run-snap', workflow: 'x', status: 'running',
    workflowDefinitionSnapshot: { definition: { steps: [{ id: 'a' }, { id: 'save', call: { tool: 'write_file' }, requiresApproval: true, sideEffect: 'write' }] } },
  }));
  const scope = gateApprovedStepWriteCoverage({ sessionId: 'workflow:run-snap:save', toolName: 'write_file', logicalToolCallId: 'c', approvals: () => approvedRows });
  assert.equal(scope?.requirementId, 'save:write_file', 'call.tool counts as a declared tool');
  assert.equal(gateApprovedStepWriteCoverage({ sessionId: 'workflow:run-missing:save', toolName: 'write_file', logicalToolCallId: 'c', approvals: () => approvedRows }), null);
});
