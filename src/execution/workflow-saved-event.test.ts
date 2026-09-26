/**
 * Run: npx tsx --test src/execution/workflow-saved-event.test.ts
 *
 * The card under Clementine's reply is drawn from the saved workflow:
 *   - every step is listed with what the engine derives (effect, gates, dependsOn)
 *   - changed steps are the ones whose behaviour differs; a reworded description marks none
 *   - a creation marks every step as added; a removal is named
 *   - the public projection keeps the bounded shape and drops a malformed row
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wf-saved-event-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { workflowSavedEventData } = await import('./workflow-saved-event.js');
const { projectHarnessEventForPublic } = await import('../runtime/harness/public-presentation.js');
type WorkflowDefinition = import('../memory/workflow-store.js').WorkflowDefinition;

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

const before: WorkflowDefinition = {
  name: 'Weekly posts',
  description: 'Posts every week.',
  enabled: true,
  trigger: { manual: true },
  steps: [
    { id: 'pull', prompt: 'Pull this week\'s blog posts.', allowedTools: ['BLOG_LIST_POSTS'], sideEffect: 'read' },
    { id: 'caption', prompt: 'Write a caption for each post.', dependsOn: ['pull'], forEach: 'pull' },
    { id: 'post', prompt: 'Publish each caption.', dependsOn: ['caption'], sideEffect: 'send', forEach: 'caption' },
  ],
} as never;

test('a creation lists every step as added, with the engine\'s own reading of each', () => {
  const data = workflowSavedEventData('weekly-posts', null, before);
  assert.equal(data.op, 'created');
  assert.equal(data.name, 'Weekly posts');
  assert.deepEqual(data.steps.map((s) => s.id), ['pull', 'caption', 'post']);
  assert.deepEqual(data.steps.map((s) => s.effect), ['read', 'read', 'send']);
  assert.deepEqual(data.steps.map((s) => s.forEach), [false, true, true]);
  assert.deepEqual(data.steps[2].dependsOn, ['caption']);
  assert.deepEqual(data.addedStepIds, ['pull', 'caption', 'post']);
  assert.deepEqual(data.changedStepIds, ['pull', 'caption', 'post']);
  assert.deepEqual(data.removedStepIds, []);
});

test('a change marks the steps whose behaviour changed, and only those', () => {
  const after: WorkflowDefinition = {
    ...before,
    description: 'Posts every Monday.',
    steps: [
      before.steps[0],
      { ...before.steps[1], prompt: 'Write a short caption for each post.' },
      { id: 'review', prompt: 'Show me the drafts.', dependsOn: ['caption'], requiresApproval: true },
      { ...before.steps[2], dependsOn: ['review'] },
    ],
  } as never;
  const data = workflowSavedEventData('weekly-posts', before, after);
  assert.equal(data.op, 'updated');
  assert.deepEqual(data.changedStepIds, ['caption', 'review', 'post']);
  assert.deepEqual(data.addedStepIds, ['review']);
  assert.deepEqual(data.removedStepIds, []);
  assert.equal(data.steps.find((s) => s.id === 'review')?.approval, true);

  const wordingOnly = workflowSavedEventData('weekly-posts', before, { ...before, description: 'Different words.' } as never);
  assert.deepEqual(wordingOnly.changedStepIds, [], 'a description change marks no step');

  const removed = workflowSavedEventData('weekly-posts', before, { ...before, steps: before.steps.slice(0, 2) } as never);
  assert.deepEqual(removed.removedStepIds, ['post']);
  assert.deepEqual(removed.changedStepIds, []);
});

test('the public projection keeps the bounded shape and drops a malformed row', () => {
  const data = workflowSavedEventData('weekly-posts', null, before);
  const row = { seq: 1, sessionId: 's', turn: 0, role: 'system', type: 'workflow_saved', data: { ...data, secret: 'never' }, createdAt: 'now' } as never;
  const projected = projectHarnessEventForPublic(row);
  assert.ok(projected);
  const out = projected!.data as Record<string, unknown>;
  assert.equal('secret' in out, false);
  assert.equal(out.op, 'created');
  assert.deepEqual((out.steps as Array<{ id: string }>).map((s) => s.id), ['pull', 'caption', 'post']);

  const bad = { ...row, data: { name: 'x', slug: '', op: 'created', steps: [] } } as never;
  assert.equal(projectHarnessEventForPublic(bad), null);
});
