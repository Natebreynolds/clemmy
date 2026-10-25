import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileWorkflowPath, readWidgetWorkflow, settleWidgetWorkflowClaim, widgetWorkflowCanRun, workflowFromSearch, workflowWidgetTarget } from './workflow-widget.js';

const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('workflow shortcuts preserve exact canonical slugs and admit only a closed unique query', () => {
  assert.equal(mobileWorkflowPath('Saved.Flow_2'), '/m/?tab=workflows&workflow=Saved.Flow_2');
  assert.deepEqual(workflowWidgetTarget(`?tab=workflows&workflow=Saved.Flow_2&widgetNavigation=${id}`), { slug: 'Saved.Flow_2', navigationId: id });
  assert.deepEqual(workflowWidgetTarget(`?tab=workflows&widgetNavigation=${id}`), { slug: null, navigationId: id });
  assert.equal(workflowFromSearch('?tab=workflows&workflow=Saved.Flow_2'), 'Saved.Flow_2');
  for (const search of [
    '?tab=spaces&workflow=saved', '?tab=workflows&workflow=', '?tab=workflows&workflow=../private',
    '?tab=workflows&workflow=a&workflow=b', '?tab=workflows&tab=workflows&workflow=a',
    `?tab=workflows&workflow=a&widgetNavigation=${id}&widgetNavigation=${id}`,
    '?tab=workflows&workflow=a&widgetNavigation=not-a-uuid', '?tab=workflows&workflow=a&run=true',
    '?tab=workflows&workflow=a&pair=secret', `?tab=workflows&workflow=${'a'.repeat(181)}`,
  ]) assert.equal(workflowWidgetTarget(search), null, search);
  assert.throws(() => mobileWorkflowPath('../private'));
});

test('a shortcut reads its exact definition and only an actual 404 can settle it as unavailable', async () => {
  const called: string[] = [];
  const definition = { slug: 'Saved.Flow_2', name: 'Friendly display name' };
  assert.deepEqual(await readWidgetWorkflow('Saved.Flow_2', async slug => { called.push(slug); return definition; }), { kind: 'ready', info: definition });
  assert.deepEqual(called, ['Saved.Flow_2']);
  assert.deepEqual(await readWidgetWorkflow('saved', async () => { throw { status: 404 }; }), { kind: 'not_found' });
  for (const failure of [{ status: 503 }, { status: 0, offline: true }, { status: 404, offline: true }]) {
    await assert.rejects(readWidgetWorkflow('saved', async () => { throw failure; }), error => error === failure);
  }
  await assert.rejects(readWidgetWorkflow('saved', async () => ({ slug: 'foreign' })), /did not return/);
  await assert.rejects(readWidgetWorkflow('../private', async () => { assert.fail('invalid target must not be read'); }), /invalid/);
});

test('native launch readiness requires a fresh exact list match with no declared inputs or gaps', () => {
  const info = { enabled: true, inputs: [] };
  const row = { enabled: true, requiresInput: false, resourceGaps: [] };
  assert.equal(widgetWorkflowCanRun(info, row), true);
  assert.equal(widgetWorkflowCanRun({ ...info, inputs: [{ required: false }] }, row), false, 'even optional inputs require normal review');
  assert.equal(widgetWorkflowCanRun({ ...info, enabled: false }, row), false);
  assert.equal(widgetWorkflowCanRun(info, null), false, 'unavailable list state is not readiness');
  assert.equal(widgetWorkflowCanRun(info, { ...row, enabled: false }), false);
  assert.equal(widgetWorkflowCanRun(info, { ...row, requiresInput: true }), false);
  assert.equal(widgetWorkflowCanRun(info, { enabled: true, requiresInput: false }), false, 'missing gap evidence is not an empty gap list');
  assert.equal(widgetWorkflowCanRun(info, { ...row, resourceGaps: ['account'] }), false);
});

test('refresh or navigation during native claim releases the UI without launching or acknowledging stale work', async () => {
  let deliver!: (granted: boolean) => void;
  let current = true; let pending = true; const decisions: boolean[] = [];
  const claim = new Promise<boolean>(resolve => { deliver = resolve; });
  const settling = settleWidgetWorkflowClaim(() => claim, () => { pending = false; }, () => current, granted => decisions.push(granted));
  current = false; deliver(true); await settling;
  assert.equal(pending, false, 'the UI must not stay disabled when an in-flight refresh invalidates this owner');
  assert.equal(decisions.length, 0, 'a successful but stale native receipt cannot launch or acknowledge a different screen');
  await settleWidgetWorkflowClaim(async () => true, () => {}, () => true, granted => decisions.push(granted));
  assert.deepEqual(decisions, [true]);
});
