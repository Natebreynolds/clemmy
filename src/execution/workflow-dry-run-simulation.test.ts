/**
 * Run: npx tsx --test src/execution/workflow-dry-run-simulation.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-dry-run-sim-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

const { simulateWorkflowDryRun, renderWorkflowDryRunSimulation } = await import('./workflow-dry-run-simulation.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const CRM_TO_EMAIL = {
  name: 'crm-outreach',
  description: 'Pull prospects and email them.',
  enabled: true,
  trigger: { manual: true },
  inputs: { segment: { type: 'string' as const } },
  steps: [
    { id: 'pull', prompt: 'Search the CRM for prospects in {{input.segment}}.', allowedTools: ['composio'], sideEffect: 'read' as const, output: { type: 'array' } },
    { id: 'draft', prompt: 'Draft an email per prospect.', dependsOn: ['pull'], forEach: 'pull', forEachNewOnly: true },
    { id: 'send', prompt: 'Send the emails to each prospect.', dependsOn: ['draft'], call: { tool: 'composio_gmail_send_email' }, requiresApproval: true },
  ],
};

test('traces waves, per-step effects, and enumerates every external send/write', () => {
  const sim = simulateWorkflowDryRun(CRM_TO_EMAIL);

  // Waves follow the dependency chain: pull -> draft -> send.
  assert.deepEqual(sim.waves.map((w) => w.stepIds), [['pull'], ['draft'], ['send']]);
  assert.deepEqual(sim.criticalPath, ['pull', 'draft', 'send']);

  // The send step is classified as an irreversible SEND (via the call slug),
  // and shows up in the effects rollup — nothing hidden touches or sends.
  assert.deepEqual(sim.effects.sends.map((s) => s.stepId), ['send']);
  assert.equal(sim.effects.writes.length, 0);
  assert.deepEqual(sim.effects.approvals, ['send']);
  assert.ok(sim.effects.toolsTouched.includes('composio_gmail_send_email'));

  const send = sim.steps.find((s) => s.stepId === 'send')!;
  assert.equal(send.effect, 'external_send');
  assert.equal(send.executor, 'call');
  assert.deepEqual(send.reads, ['draft']);
  assert.equal(send.gated, true);

  const draft = sim.steps.find((s) => s.stepId === 'draft')!;
  assert.deepEqual(draft.fanout, { source: 'pull', newOnly: true });
});

test('a read-only workflow reports no external writes or sends', () => {
  const sim = simulateWorkflowDryRun({
    name: 'research-only',
    description: 'Gather and summarize.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'gather', prompt: 'Search the web for recent coverage.', allowedTools: ['web_search'], sideEffect: 'read' as const },
      { id: 'summary', prompt: 'Summarize the findings.', dependsOn: ['gather'] },
    ],
  });
  assert.equal(sim.effects.sends.length, 0);
  assert.equal(sim.effects.writes.length, 0);
  assert.equal(sim.verdict, 'ready');
  assert.match(renderWorkflowDryRunSimulation(sim), /only reads and reasons/);
});

test('step-level project binding overrides workflow project in the effects preview', () => {
  const sim = simulateWorkflowDryRun({
    name: 'project-write-wf',
    description: 'Write to a specific repo.',
    enabled: true,
    trigger: { manual: true },
    project: 'default-repo',
    steps: [
      {
        id: 'patch',
        prompt: 'Patch the service repo.',
        sideEffect: 'write' as const,
        project: 'service-repo',
        allowedTools: ['write_file'],
      },
    ],
  });

  const patch = sim.steps.find((s) => s.stepId === 'patch');
  assert.equal(patch?.touches.project, 'service-repo');
  assert.deepEqual(sim.effects.writes.map((w) => w.detail), ['Patch the service repo. via write_file, project:service-repo']);
});

test('a plain out-of-catalog tool (web_search) does not block the dry-run — it informs', () => {
  const sim = simulateWorkflowDryRun({
    name: 'web-tool-wf',
    description: 'Look things up.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'look', prompt: 'Look it up.', allowedTools: ['web_search'] }],
  });
  assert.equal(sim.verdict, 'ready');
  assert.equal(sim.runnable, true);
  assert.ok(sim.readiness.warnings.some((w) => w.name === 'web_search'));
  assert.equal(sim.readiness.blockers.length, 0);
});

test('a missing declared input flips the verdict to needs_inputs, not blocked', () => {
  const sim = simulateWorkflowDryRun({
    name: 'needs-input-wf',
    description: 'Report on a URL.',
    enabled: true,
    trigger: { manual: true },
    inputs: { url: { type: 'string' as const } },
    steps: [{ id: 'fetch', prompt: 'Fetch {{input.url}} and summarize.', allowedTools: ['web_search'] }],
  });
  assert.equal(sim.verdict, 'needs_inputs');
  assert.equal(sim.runnable, true);
  assert.ok(sim.missingInputs.includes('url'));
});

test('the rendered report leads with the send preview and lists the waves', () => {
  const report = renderWorkflowDryRunSimulation(simulateWorkflowDryRun(CRM_TO_EMAIL));
  assert.match(report, /Will SEND \(irreversible\):/);
  assert.match(report, /send —/);
  assert.match(report, /Execution waves:/);
  assert.match(report, /Gated on approval: send\./);
  assert.match(report, /nothing was sent/);
});
