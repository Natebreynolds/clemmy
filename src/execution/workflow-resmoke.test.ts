/**
 * Run: npx tsx --test src/execution/workflow-resmoke.test.ts
 * Re-smoke-on-edit (2026-06-11): workflowExecutionSurfaceChanged decides
 * when an edit changes what a workflow EXECUTES (→ re-test) vs cosmetic /
 * scheduling changes (→ never re-test).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowDefinition } from '../memory/workflow-store.js';

const { workflowExecutionSurfaceChanged } = await import('./workflow-enforce.js');

function wf(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'fb-trends',
    description: 'scrape facebook trends',
    enabled: true,
    trigger: { schedule: '0 9 * * 1-5' },
    steps: [
      { id: 'find', prompt: 'Find the official page.', allowedTools: ['composio_execute_tool'] },
      { id: 'scrape', prompt: 'Scrape with Apify.', dependsOn: ['find'], allowedTools: ['composio_execute_tool'] },
    ],
    ...overrides,
  };
}

test('execution changes ARE detected: prompt, tools, skill, forEach, contract, loopUntil, deps', () => {
  const base = wf();
  assert.ok(workflowExecutionSurfaceChanged(base, wf({ steps: [base.steps[0], { ...base.steps[1], prompt: 'Scrape with the OTHER actor.' }] })), 'prompt change');
  assert.ok(workflowExecutionSurfaceChanged(base, wf({ steps: [base.steps[0], { ...base.steps[1], allowedTools: ['firecrawl_scrape'] }] })), 'tool change');
  assert.ok(workflowExecutionSurfaceChanged(base, wf({ steps: [base.steps[0], { ...base.steps[1], usesSkill: 'fb-analyzer' }] })), 'skill change');
  assert.ok(workflowExecutionSurfaceChanged(base, wf({ steps: [base.steps[0], { ...base.steps[1], forEach: 'find' }] })), 'forEach change');
  assert.ok(workflowExecutionSurfaceChanged(base, wf({ steps: [base.steps[0], { ...base.steps[1], output: { type: 'array' } }] })), 'contract change');
  assert.ok(workflowExecutionSurfaceChanged(base, wf({ steps: [base.steps[0], { ...base.steps[1], loopUntil: {} }] })), 'loopUntil change');
  assert.ok(workflowExecutionSurfaceChanged(base, wf({ steps: [{ ...base.steps[0] }, { ...base.steps[1], dependsOn: [] }] })), 'dependency change');
  assert.ok(workflowExecutionSurfaceChanged(base, wf({ steps: [base.steps[0]] })), 'step removed');
  assert.ok(workflowExecutionSurfaceChanged(base, wf({ inputs: { url: { type: 'string' } } })), 'workflow inputs change');
});

test('cosmetic / scheduling changes are NOT execution changes', () => {
  const base = wf();
  assert.ok(!workflowExecutionSurfaceChanged(base, wf({ description: 'better words, same behavior' })), 'description');
  assert.ok(!workflowExecutionSurfaceChanged(base, wf({ trigger: { schedule: '0 6 * * *' } })), 'reschedule');
  assert.ok(!workflowExecutionSurfaceChanged(base, wf({ trigger: { manual: true } })), 'schedule removed');
  assert.ok(!workflowExecutionSurfaceChanged(base, wf({ enabled: false })), 'enable flip');
  assert.ok(!workflowExecutionSurfaceChanged(base, wf()), 'identical');
});
