/**
 * Run: npx tsx --test src/execution/workflow-preflight.test.ts
 *
 * Side-effect-free runnability preflight (backs the DRY-RUN button +
 * promotion smoke-test). Composes checkWorkflowForWrite + missing-inputs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightWorkflow, renderPreflightReport, workflowEditAdvisories } from './workflow-preflight.js';
import type { WorkflowDefinition } from '../memory/workflow-store.js';

function wf(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'demo',
    description: 'demo workflow',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'a', prompt: 'do a thing' }],
    ...overrides,
  } as WorkflowDefinition;
}

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('preflight: a clean workflow passes', () => {
  const r = preflightWorkflow(wf());
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.match(r.summary, /Preflight passed/);
});

test('preflight: a structurally-broken workflow fails (hand-off language)', () => {
  const r = preflightWorkflow(wf({ steps: [{ id: 'a', prompt: 'do it; a future turn will handle the rest' }] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 1);
  assert.match(r.summary, /blocking issue/);
});

test('preflight: missing run inputs are a heads-up, NOT a failure (workflow is still runnable)', () => {
  const def = wf({
    steps: [{ id: 'a', prompt: 'audit {{input.segment}}' }],
    inputs: { segment: { type: 'string' } } as WorkflowDefinition['inputs'],
  });
  const r = preflightWorkflow(def, {}); // no inputs supplied
  assert.equal(r.ok, true);                       // structurally runnable
  assert.deepEqual(r.missingInputs, ['segment']); // but flagged
  assert.match(r.summary, /you'll need to supply "segment"/);
});

test('preflight: supplying the input clears the heads-up', () => {
  const def = wf({
    steps: [{ id: 'a', prompt: 'audit {{input.segment}}' }],
    inputs: { segment: { type: 'string' } } as WorkflowDefinition['inputs'],
  });
  const r = preflightWorkflow(def, { segment: 'law firms' });
  assert.deepEqual(r.missingInputs, []);
});

test('preflight: separates semantic edit recommendations from generic warnings', () => {
  const r = preflightWorkflow(wf({
    enabled: true,
    description: 'Workflow that builds a client audit',
    steps: [{ id: 'build', prompt: 'Generate the client audit report and save it to an HTML file.' }],
  }));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /output contract/.test(w)));
  assert.ok(r.editAdvisories.some((w) => /output contract/.test(w)));
  assert.ok(r.editAdvisories.some((w) => /no pinned `goal`/.test(w)));
});

test('workflowEditAdvisories: ignores routine non-edit warnings', () => {
  const out = workflowEditAdvisories([
    'Workflow is currently disabled — scheduled triggers will not fire.',
    'Step "build" looks like it produces a deliverable but declares no output contract.',
  ]);
  assert.deepEqual(out, ['Step "build" looks like it produces a deliverable but declares no output contract.']);
});

test('workflowEditAdvisories: includes sideEffect safety mismatches', () => {
  const out = workflowEditAdvisories([
    'Step "send" declares sideEffect: read, but its prompt looks like a SEND step.',
  ]);
  assert.deepEqual(out, ['Step "send" declares sideEffect: read, but its prompt looks like a SEND step.']);
});

test('workflowEditAdvisories: includes unattended reliability drift warnings', () => {
  const out = workflowEditAdvisories([
    'Step "draft" looks like multi-item work but has no forEach — it will run serially in one context.',
    'Step "pull" looks like it should use your proven cli `sf data query --json`, but its prompt doesn\'t embed it and its tools still include composio — at runtime the step may re-decide and drift onto a stale path.',
    'Workflow is currently disabled — scheduled triggers will not fire.',
  ]);
  assert.deepEqual(out, [
    'Step "draft" looks like multi-item work but has no forEach — it will run serially in one context.',
    'Step "pull" looks like it should use your proven cli `sf data query --json`, but its prompt doesn\'t embed it and its tools still include composio — at runtime the step may re-decide and drift onto a stale path.',
  ]);
});

test('preflight: flags workflow steps whose required local MCP tool is excluded from the worker profile', () => {
  withEnv({ CLEMMY_CLAUDE_AGENT_SDK_ALLOWED_TOOLS: 'ping,notify_user' }, () => {
    const r = preflightWorkflow(wf({
      steps: [{
        id: 'main',
        prompt: 'Use the authenticated Salesforce CLI via run_shell_command: sf data query --query "SELECT Id FROM Event" --json, then notify Alex.',
        sideEffect: 'send',
      }],
    }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /requires local MCP tool run_shell_command/.test(e)), r.errors.join('\n'));
  });
});

test('renderPreflightReport: legible, and states nothing was executed', () => {
  const body = renderPreflightReport('demo', preflightWorkflow(wf()));
  assert.match(body, /✅ Dry-run preflight: demo/);
  assert.match(body, /no tools ran, nothing was sent/);
});

test('renderPreflightReport: shows recommended workflow edits separately', () => {
  const body = renderPreflightReport('demo', preflightWorkflow(wf({
    enabled: true,
    description: 'Workflow that builds a client audit',
    steps: [{ id: 'build', prompt: 'Generate the client audit report and save it to an HTML file.' }],
  })));
  assert.match(body, /Recommended edits before relying on this workflow unattended/);
  assert.match(body, /output contract/);
});
