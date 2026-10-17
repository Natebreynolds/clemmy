/**
 * Run: node scripts/run-tests-isolated.mjs src/spaces/space-workflow-action.test.ts
 *
 * A Space button can run any tool by naming a saved workflow: one click starts
 * one run with the merged args as its inputs, under that workflow's own rules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-space-workflow-action-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';

const { writeWorkflow } = await import('../memory/workflow-store.js');
const { checkSpaceForWrite } = await import('./space-enforce.js');
const { workspaceActionRequiresApproval } = await import('./space-execution-policy.js');
const { runSpaceAction } = await import('./runner.js');

function saveWorkflow(name: string, enabled: boolean): void {
  writeWorkflow(name, {
    name,
    description: 'Publish one reviewed blog draft.',
    enabled,
    trigger: { manual: true },
    inputs: { draft_id: { type: 'string', description: 'The draft to publish.' } },
    steps: [{ id: 'publish', prompt: 'Publish draft {{input.draft_id}}.', sideEffect: 'write' }],
  } as Parameters<typeof writeWorkflow>[1]);
}

function queuedRuns(): Array<Record<string, unknown>> {
  const dir = path.join(TMP_HOME, 'workflows', 'runs');
  let names: string[] = [];
  try { names = readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return []; }
  return names.map((name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as Record<string, unknown>);
}

test('a workflow button names a saved workflow and takes no extra card', () => {
  saveWorkflow('Publish Blog Draft', true);
  const action = { id: 'approve', label: 'Approve', workflow: 'Publish Blog Draft' };
  assert.equal(workspaceActionRequiresApproval(action), false);
  assert.deepEqual(checkSpaceForWrite('site-ops', [], [action]).errors, []);
  const missing = checkSpaceForWrite('site-ops', [], [{ id: 'x', workflow: 'Not Saved' }]).errors;
  assert.match(missing.join(' '), /names workflow "Not Saved", which is not saved/);
  const mixed = checkSpaceForWrite('site-ops', [], [{ id: 'y', workflow: 'Publish Blog Draft', composioSlug: 'GITHUB_CREATE_A_PULL_REQUEST' }]).errors;
  assert.match(mixed.join(' '), /names a workflow and also a composio_slug or runner/);
});

test('a click starts one run with the template and click args as inputs', async () => {
  saveWorkflow('Publish Blog Draft', true);
  const before = queuedRuns().length;
  const result = await runSpaceAction(
    'site-ops',
    { id: 'approve', workflow: 'Publish Blog Draft', argsTemplate: { channel: 'blog' } },
    { draft_id: 'swim-safety-101' },
  );
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  const runs = queuedRuns();
  assert.equal(runs.length, before + 1);
  const run = runs.find((record) => record.workflow === 'Publish Blog Draft' || record.workflowName === 'Publish Blog Draft') ?? runs.at(-1)!;
  const inputs = (run.inputs ?? {}) as Record<string, unknown>;
  assert.equal(inputs.draft_id, 'swim-safety-101');
  assert.equal(inputs.channel, 'blog');
});

test('a workflow that is off says how to turn it on and starts nothing', async () => {
  saveWorkflow('Draft Only Off', false);
  const before = queuedRuns().length;
  const result = await runSpaceAction('site-ops', { id: 'go', workflow: 'Draft Only Off' }, {});
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /is off\. Turn it on/);
  assert.equal(queuedRuns().length, before);
});

test("the owner's press starts a person's run; Clem's own press does not", async () => {
  // Live 2026-10-16: "Request changes" ran its workflow, which then parked its
  // own Space write on a second card because the run did not count as a
  // person's. Only the console route passes initiatedBy.
  saveWorkflow('Redraft On Press', true);
  const pressed = await runSpaceAction('site-ops', { id: 'redraft', workflow: 'Redraft On Press' },
    { draft_id: 'owner-press' }, { initiatedBy: 'person' });
  assert.equal(pressed.ok, true, pressed.ok ? '' : pressed.error);
  const byClem = await runSpaceAction('site-ops', { id: 'redraft', workflow: 'Redraft On Press' },
    { draft_id: 'clem-press' });
  assert.equal(byClem.ok, true, byClem.ok ? '' : byClem.error);
  const sourceOf = (draftId: string) => queuedRuns()
    .find((record) => (record.inputs as Record<string, unknown> | undefined)?.draft_id === draftId)?.source;
  assert.equal(sourceOf('owner-press'), 'space_click:site-ops');
  assert.equal(sourceOf('clem-press'), 'space_action:site-ops');
});
