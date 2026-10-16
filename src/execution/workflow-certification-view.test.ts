/** A catalog view is host-issued display evidence, never queue authority. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WorkflowDefinition } from '../memory/workflow-store.js';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-certification-view-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(testHome, 'workspace'), { recursive: true });
writeFileSync(path.join(testHome, '.env'), `WORKSPACE_DIRS=${path.join(testHome, 'workspace')}\n`);
const { captureWorkflowCertificationView, workflowCertificationDisplayInputs } = await import('./workflow-certification-view.js');
const { certifyWorkflow } = await import('./workflow-certification.js');
const { checkWorkflowRunReadiness } = await import('./workflow-run-readiness.js');
const { resolveStepDisplayModel } = await import('./workflow-routing-check.js');
const { SKILLS_DIR } = await import('../memory/skill-store.js');
const { resetEventLog } = await import('../runtime/harness/eventlog.js');

test.beforeEach(() => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLAUDE_MODEL = 'claude-sonnet-5';
  process.env.MODEL_ROUTING_MODE = 'off';
  process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'on';
  process.env.CLEMMY_MODEL_ROLES = '';
  rmSync(SKILLS_DIR, { recursive: true, force: true });
});
test.after(() => { resetEventLog(); rmSync(testHome, { recursive: true, force: true }); });

function workflow(name = 'captured-view'): WorkflowDefinition {
  return { name, description: 'Controlled display-view fixture.', enabled: true, trigger: { manual: true },
    steps: [{ id: 'read', prompt: 'Read the controlled fixture.', sideEffect: 'read', usesSkill: 'required-fixture-skill' }] };
}
function install(name = 'required-fixture-skill') {
  const dir = path.join(SKILLS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Controlled fixture only.\n---\nRead the controlled fixture.\n`);
}

test('an issued view retains its readiness while fresh queue checks and later captures see install/delete', () => {
  const def = workflow();
  const missing = captureWorkflowCertificationView([{ name: def.name, data: def }]).forWorkflow(def.name)!;
  assert.equal(certifyWorkflow(def, { workflowSlug: def.name, displayView: missing }).canRun, false);
  install();
  assert.equal(certifyWorkflow(def, { workflowSlug: def.name, displayView: missing }).canRun, false, 'key and cold result keep the same observed facts');
  assert.equal(checkWorkflowRunReadiness(def, def.name).ok, true, 'queue readiness never borrows a display snapshot');
  const ready = captureWorkflowCertificationView([{ name: def.name, data: def }]).forWorkflow(def.name)!;
  assert.notEqual(ready.key, missing.key);
  assert.equal(certifyWorkflow(def, { workflowSlug: def.name, displayView: ready }).canRun, true);
  rmSync(path.join(SKILLS_DIR, 'required-fixture-skill'), { recursive: true });
  assert.equal(checkWorkflowRunReadiness(def, def.name).ok, false);
  assert.equal(certifyWorkflow(def, { workflowSlug: def.name, displayView: ready }).canRun, true, 'older display remains internally coherent');
  const deleted = captureWorkflowCertificationView([{ name: def.name, data: def }]).forWorkflow(def.name)!;
  assert.equal(deleted.key, missing.key);
  assert.equal(certifyWorkflow(def, { workflowSlug: def.name, displayView: deleted }).canRun, false);
});

test('copied, foreign-slug, changed-definition and changed-plan views cannot supply certification facts', () => {
  const def = workflow();
  const view = captureWorkflowCertificationView([{ name: def.name, data: def }]).forWorkflow(def.name)!;
  install();
  assert.equal(workflowCertificationDisplayInputs({ ...view }, def, def.name), null);
  assert.equal(certifyWorkflow(def, { workflowSlug: def.name, displayView: { ...view } }).canRun, true, 'JSON lookalike falls back fresh');
  assert.equal(workflowCertificationDisplayInputs(view, def, 'another-slug'), null);
  assert.equal(certifyWorkflow(def, { workflowSlug: 'another-slug', displayView: view }).canRun, true);
  const changed = { ...def, description: 'A changed effective definition.' };
  assert.equal(workflowCertificationDisplayInputs(view, changed, def.name), null);
  assert.equal(certifyWorkflow(changed, { workflowSlug: def.name, displayView: view }).canRun, true);
  assert.equal(workflowCertificationDisplayInputs(view, def, def.name, { stepConcurrency: 2 }), null);
  const differentPlan = certifyWorkflow(def, { workflowSlug: def.name, displayView: view, planOptions: { stepConcurrency: 2 } });
  assert.equal(differentPlan.canRun, true);
  assert.equal(differentPlan.dryRun.plan.runner.stepConcurrency, 2);
});

test('unrelated installed skills do not invalidate a workflow whose effective readiness is unchanged', () => {
  const def = workflow();
  const before = captureWorkflowCertificationView([{ name: def.name, data: def }]).forWorkflow(def.name)!;
  install('unrelated-fixture-skill');
  const unrelated = captureWorkflowCertificationView([{ name: def.name, data: def }]).forWorkflow(def.name)!;
  assert.equal(unrelated.key, before.key);
  install();
  const required = captureWorkflowCertificationView([{ name: def.name, data: def }]).forWorkflow(def.name)!;
  assert.notEqual(required.key, before.key);
});

test('captured worker routing stays coherent while step and workflow pins keep canonical precedence', () => {
  const def = workflow();
  def.steps = [
    { id: 'default', prompt: 'Read fixture.', sideEffect: 'read' },
    { id: 'intent', prompt: 'Read fixture.', sideEffect: 'read', intent: 'Fixture Writing' },
    { id: 'pinned', prompt: 'Read fixture.', sideEffect: 'read', model: 'exact-step-pin' },
  ];
  const expected = def.steps.map(step => resolveStepDisplayModel(step, def));
  const view = captureWorkflowCertificationView([{ name: def.name, data: def }]).forWorkflow(def.name)!;
  process.env.CLAUDE_MODEL = 'claude-opus-4-8';
  const old = certifyWorkflow(def, { workflowSlug: def.name, displayView: view });
  assert.deepEqual(old.dryRun.steps.map(step => step.model), expected);
  const next = captureWorkflowCertificationView([{ name: def.name, data: def }]).forWorkflow(def.name)!;
  assert.notEqual(next.key, view.key);
  assert.equal(certifyWorkflow(def, { workflowSlug: def.name, displayView: next }).dryRun.steps[0].model, 'claude-opus-4-8');
  def.models = { brain: 'exact-workflow-pin' };
  const pinned = captureWorkflowCertificationView([{ name: def.name, data: def }]).forWorkflow(def.name)!;
  assert.deepEqual(certifyWorkflow(def, { workflowSlug: def.name, displayView: pinned }).dryRun.steps.map(step => step.model),
    ['exact-workflow-pin', 'exact-workflow-pin', 'exact-step-pin']);
  assert.equal(resolveStepDisplayModel({ prompt: 'Read.', intent: 'Fixture Writing' }, undefined,
    intent => intent === 'Fixture Writing' ? 'exact-intent-pin' : 'default-pin'), 'exact-intent-pin');
});

test('freezing a view neither mutates nor freezes caller-owned definitions or goals', () => {
  const def = workflow();
  def.goal = { objective: 'Read the fixture completely.', successCriteria: ['The controlled value is returned.'] };
  const before = JSON.stringify(def);
  const view = captureWorkflowCertificationView([{ name: def.name, data: def }]).forWorkflow(def.name)!;
  assert.equal(JSON.stringify(def), before);
  assert.equal(Object.isFrozen(def.steps), false);
  assert.equal(Object.isFrozen(def.goal), false);
  assert.ok(Object.isFrozen(workflowCertificationDisplayInputs(view, def, def.name)?.readiness));
  def.goal.successCriteria!.push('A later caller edit is allowed.');
  def.steps.push({ id: 'later', prompt: 'Read another fixture.', sideEffect: 'read' });
  assert.equal(workflowCertificationDisplayInputs(view, def, def.name), null);
});
