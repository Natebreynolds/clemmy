/**
 * Run: npx tsx --test src/execution/workflow-certification.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-workflow-certification-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

import type { WorkflowDefinition } from '../memory/workflow-store.js';
const { certifyWorkflow, renderWorkflowCertification } = await import('./workflow-certification.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');

beforeEach(() => {
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  rmSync(path.join(TMP_HOME, 'state'), { recursive: true, force: true });
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function def(overrides: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    name: 'cert-wf',
    description: 'Certify a workflow.',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'draft', prompt: 'Draft an internal note.' }],
    ...overrides,
  };
}

test('disabled workflow without external read is ready to enable', () => {
  const cert = certifyWorkflow(def({}));

  assert.equal(cert.state, 'ready_to_enable');
  assert.equal(cert.canEnableDirectly, true);
  assert.equal(cert.canQueueCreationTest, false);
  assert.equal(cert.canRun, false);
  assert.deepEqual(cert.nextActions, ['enable_workflow', 'review_contract_advisories']);
});

// F2 (live 2026-07-23): FLIPPED — readiness gaps no longer capture the state
// or gate the capability bits (the old needs_info state was EXITLESS: toggle
// refused, creation test refused, and "answer readiness questions" had no
// surface). Gaps ride the advisory rail alongside the state's real action.
test('readiness gaps are advisories — they never block enable or the creation test', () => {
  const cert = certifyWorkflow(def({
    steps: [{ id: 'send', prompt: 'Send the emails to the outside prospect list.' }],
  }));

  assert.notEqual(cert.state, 'needs_info');
  assert.equal(cert.readinessGaps.length > 0, true, 'the questions still surface');
  assert.ok(cert.nextActions.includes('answer_readiness_questions'), 'advisory action rides along');
  assert.ok(
    cert.canEnableDirectly || cert.canQueueCreationTest || cert.canRun,
    `at least one real exit exists, got state=${cert.state}`,
  );
});

// F1 (live 2026-07-23): a step with a DECLARED side_effect: read must never
// trip the send-audience readiness question, whatever its prose says — the
// negation-blind regex read "this report is NEVER emailed, posted, or
// published" as a send and locked a clean read-only workflow.
test('declared-read step with sendy prose raises no send-audience gap', () => {
  const cert = certifyWorkflow(def({
    steps: [{
      id: 'synthesize_report',
      prompt: 'Publish a read-only report. This report has NO recipient — it is never emailed, posted, pushed, or published anywhere; it delivers messages to nobody.',
      sideEffect: 'read',
    } as never],
  }));
  assert.equal(cert.readinessGaps.length, 0, `no gaps expected, got: ${JSON.stringify(cert.readinessGaps)}`);
});

test('required resource bindings block before lifecycle actions', () => {
  const cert = certifyWorkflow(def({
    enabled: true,
    resources: {
      lead_sheet: {
        id: 'lead_sheet',
        kind: 'sheet',
        label: 'Lead sheet',
        toolkit: 'googlesheets',
      },
    },
    steps: [{ id: 'summarize', prompt: 'Summarize the bound sheet status.', sideEffect: 'read' }],
  }));

  assert.equal(cert.state, 'needs_resource_binding');
  assert.equal(cert.canRun, false);
  assert.equal(cert.resourceGaps.length, 1);
  assert.match(cert.resourceGaps[0], /Lead sheet: bind a concrete spreadsheet/);
  assert.ok(cert.nextActions.includes('bind_resources'));
});

test('external-read draft asks for creation-test inputs before testing', () => {
  const cert = certifyWorkflow(def({
    inputs: { url: { type: 'string', description: 'URL to inspect' } },
    steps: [{ id: 'fetch', prompt: 'Fetch the website data for {{input.url}}.', allowedTools: ['web_search'] }],
  }));

  assert.equal(cert.state, 'needs_creation_inputs');
  assert.deepEqual(cert.missingTestInputs, ['url']);
  assert.equal(cert.canQueueCreationTest, false);
  assert.ok(cert.nextActions.includes('provide_test_inputs'));
});

test('external-read draft with test inputs is ready for creation test', () => {
  const cert = certifyWorkflow(def({
    inputs: { url: { type: 'string', description: 'URL to inspect' } },
    steps: [{ id: 'fetch', prompt: 'Fetch the website data for {{input.url}}.', allowedTools: ['web_search'] }],
  }), {
    testInputs: { url: 'https://example.com' },
  });

  assert.equal(cert.state, 'needs_creation_test');
  assert.equal(cert.canQueueCreationTest, true);
  assert.deepEqual(cert.missingTestInputs, []);
  assert.ok(cert.nextActions.includes('start_creation_test'));
});

test('enabled workflow reports missing run inputs separately from creation-test inputs', () => {
  const cert = certifyWorkflow(def({
    enabled: true,
    inputs: { leadId: { type: 'string', description: 'Lead id' } },
  }));

  assert.equal(cert.state, 'needs_run_inputs');
  assert.deepEqual(cert.missingRunInputs, ['leadId']);
  assert.equal(cert.canRun, false);
  assert.ok(cert.nextActions.includes('provide_run_inputs'));
});

test('enabled workflow with required inputs is ready to run when inputs are present', () => {
  const cert = certifyWorkflow(def({
    enabled: true,
    inputs: { leadId: { type: 'string', description: 'Lead id' } },
  }), {
    runInputs: { leadId: 'L-1' },
  });

  assert.equal(cert.state, 'ready_to_run');
  assert.equal(cert.canRun, true);
  assert.ok(cert.nextActions.includes('run_workflow'));
});

test('authoritative readiness blockers stop certification before lifecycle actions', () => {
  const cert = certifyWorkflow(def({
    enabled: true,
    steps: [{ id: 'skill', prompt: 'Use the missing skill.', usesSkill: 'missing-skill' }],
  }));

  assert.equal(cert.state, 'blocked');
  assert.equal(cert.canRun, false);
  assert.ok(cert.blockingReasons.some((reason) => reason.includes('missing-skill')));
  assert.ok(cert.nextActions.includes('fix_blockers'));
});

test('renderWorkflowCertification shows the one-door next action and evidence', () => {
  const cert = certifyWorkflow(def({
    inputs: { url: { type: 'string', description: 'URL to inspect' } },
    steps: [{ id: 'fetch', prompt: 'Fetch the website data for {{input.url}}.', allowedTools: ['web_search'] }],
  }));
  const rendered = renderWorkflowCertification(cert);

  assert.match(rendered, /Workflow certification: NEEDS CREATION INPUTS/);
  assert.match(rendered, /Next action:/);
  assert.match(rendered, /Provide test_inputs/);
  assert.match(rendered, /Missing creation-test inputs:\n- url/);
  assert.match(rendered, /Dry-run:/);
});
