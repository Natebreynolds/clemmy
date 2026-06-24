/**
 * Run: npx tsx --test src/execution/workflow-step-edit.test.ts
 *
 * Reversible workflow-step prompt edits (the workflow_step proposer's apply path):
 *   - appends to a step prompt, validated + backed up + reversible
 *   - refuses a missing workflow / missing step / empty addendum
 *   - idempotent: never appends the same guidance twice
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-wf-step-edit';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { applyStepPromptAddendum, revertStepEdit, listStepEditBackups } = await import('./workflow-step-edit.js');
const { writeWorkflow, readWorkflow } = await import('../memory/workflow-store.js');
import type { WorkflowDefinition } from '../memory/workflow-store.js';

const NOW = '2026-06-24T12:00:00.000Z';

function def(): WorkflowDefinition {
  return {
    name: 'edit-wf',
    description: 'edit test',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'scrape', prompt: 'Scrape rows.', sideEffect: 'read' }],
  };
}

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
  writeWorkflow('edit-wf', def());
});

test('applyStepPromptAddendum appends, validates, and is reversible', () => {
  const r = applyStepPromptAddendum('edit-wf', 'scrape', 'Always return at least 10 rows.', { nowIso: NOW });
  assert.equal(r.ok, true);
  assert.ok(r.backupId, 'snapshotted a backup');
  const after = readWorkflow('edit-wf')!.data.steps[0].prompt;
  assert.match(after, /Scrape rows\./, 'original prompt preserved');
  assert.match(after, /Always return at least 10 rows\./, 'addendum appended');

  const rev = revertStepEdit(r.backupId!);
  assert.equal(rev.ok, true);
  assert.equal(readWorkflow('edit-wf')!.data.steps[0].prompt, 'Scrape rows.', 'reverted to original');
});

test('idempotent: the same guidance is never appended twice', () => {
  writeWorkflow('edit-wf', def());
  const first = applyStepPromptAddendum('edit-wf', 'scrape', 'Dedupe by URL.', { nowIso: NOW });
  assert.equal(first.ok, true);
  const second = applyStepPromptAddendum('edit-wf', 'scrape', 'Dedupe by URL.', { nowIso: NOW });
  assert.equal(second.ok, false, 'second identical addendum is a no-op');
  assert.match(second.message, /already present/);
});

test('refuses a missing workflow / missing step / empty addendum (no mutation)', () => {
  assert.equal(applyStepPromptAddendum('nope', 'scrape', 'x', { nowIso: NOW }).ok, false);
  assert.equal(applyStepPromptAddendum('edit-wf', 'ghost', 'x', { nowIso: NOW }).ok, false);
  assert.equal(applyStepPromptAddendum('edit-wf', 'scrape', '   ', { nowIso: NOW }).ok, false);
});

test('revertStepEdit reports a missing backup id without throwing', () => {
  const r = revertStepEdit('wfedit-deadbeef');
  assert.equal(r.ok, false);
  assert.match(r.message, /No revertable step edit/);
  assert.ok(Array.isArray(listStepEditBackups()));
});
