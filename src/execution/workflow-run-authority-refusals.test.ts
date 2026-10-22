/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-run-authority-refusals.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflowRunAuthorityRefusals } from './workflow-run-authority-refusals.js';

const settled = (tool: string, kind: string, detail?: string) => ({ data: { tool, kind, ...(detail ? { detail } : {}) } });

test('only calls the definition refused, and that never ran, are named', () => {
  const sessions: Record<string, Array<{ data: Record<string, unknown> }>> = {
    'workflow:run-1:main': [
      settled('space_refresh', 'policy_denial', 'work_binding:consent_repair_coverage_missing'),
      settled('space_refresh', 'policy_denial', 'work_binding:consent_repair_coverage_missing'),
      // A sibling refused only because another call in its batch needed a fix.
      settled('sheet_update', 'policy_denial', 'work_binding:sibling_frame_replanned_before_dispatch'),
      settled('sheet_update', 'succeeded'),
      // Refused, then run successfully: the definition covers it.
      settled('goal_upsert', 'policy_denial', 'work_binding:consent_repair_coverage_missing'),
      settled('goal_upsert', 'succeeded'),
    ],
    'workflow:run-1:notify': [
      settled('send_note', 'policy_denial', 'work_binding:consent_repair_scope_mismatch'),
    ],
  };
  const read = (sessionId: string) => sessions[sessionId] ?? [];
  assert.deepEqual(workflowRunAuthorityRefusals('run-1', ['main', 'notify', 'absent'], read), [
    { stepId: 'main', tool: 'space_refresh', reason: 'coverage_missing' },
    { stepId: 'notify', tool: 'send_note', reason: 'scope_mismatch' },
  ]);
  assert.deepEqual(workflowRunAuthorityRefusals('run-1', ['main'], () => { throw new Error('log unavailable'); }), []);
});
