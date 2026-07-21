/**
 * Run: npx tsx --test src/execution/workflow-health.test.ts
 * Workflow health (2026-07-21 break-scenario B): an already-saved workflow
 * whose structured call references a since-killed/renamed tool is marked
 * BROKEN against the live catalog — so it's surfaced before it silently
 * no-ops on schedule, not discovered as a missed run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWorkflowHealth } from './workflow-health.js';
import type { WorkflowDefinition } from '../memory/workflow-store.js';

function wf(steps: Array<Record<string, unknown>>): WorkflowDefinition {
  return { name: 'w', description: 'd', enabled: true, trigger: {}, steps } as unknown as WorkflowDefinition;
}

test('a call node with a prose/hallucinated tool slug is BROKEN', () => {
  const report = checkWorkflowHealth(wf([{ id: 'send', prompt: 'x', call: { tool: 'send the follow up emails', args: {} } }]));
  assert.equal(report.status, 'broken');
  assert.equal(report.issues.length, 1);
  assert.equal(report.issues[0].stepId, 'send');
  assert.equal(report.issues[0].kind, 'unknown_call_tool');
});

test('valid tool references are OK: local tool, Composio slug, cx alias, plain LLM step', () => {
  const report = checkWorkflowHealth(wf([
    { id: 'read', prompt: 'x', call: { tool: 'memory_recall', args: {} } },
    { id: 'send', prompt: 'x', call: { tool: 'GMAIL_SEND_EMAIL', args: {}, }, requiresApproval: true },
    { id: 'cx', prompt: 'x', call: { tool: 'cx_gmail_send_email', args: {} }, requiresApproval: true },
    { id: 'think', prompt: 'summarize the results' },
  ]));
  assert.equal(report.status, 'ok');
  assert.deepEqual(report.issues, []);
});

test('an unverifiable Composio slug is NOT flagged broken (a false badge is worse than none)', () => {
  // Looks like a Composio slug shape but is not in the local catalog — the
  // catalog can't prove a remote slug wrong, so health stays OK.
  const report = checkWorkflowHealth(wf([{ id: 's', prompt: 'x', call: { tool: 'SALESFORCE_CREATE_LEAD', args: {} }, requiresApproval: true }]));
  assert.equal(report.status, 'ok');
});

test('multiple broken steps are all reported', () => {
  const report = checkWorkflowHealth(wf([
    { id: 'a', prompt: 'x', call: { tool: 'do the thing please', args: {} } },
    { id: 'b', prompt: 'x', call: { tool: 'another bad one', args: {} } },
    { id: 'c', prompt: 'x', call: { tool: 'memory_recall', args: {} } },
  ]));
  assert.equal(report.status, 'broken');
  assert.deepEqual(report.issues.map((i) => i.stepId), ['a', 'b']);
});

test('a workflow with no call nodes is trivially OK', () => {
  assert.equal(checkWorkflowHealth(wf([{ id: 'a', prompt: 'just think' }])).status, 'ok');
  assert.equal(checkWorkflowHealth(wf([])).status, 'ok');
});
