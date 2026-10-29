import test from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT_VIEWS, projectView, projectViewSearch } from './project-navigation';

test('project navigation keeps agents and context first class across reloads and legacy links', () => {
  assert.deepEqual(PROJECT_VIEWS.map(view => view.id), ['overview', 'agents', 'context', 'conversations']);
  assert.equal(projectView('agents'), 'agents');
  assert.equal(projectView(null, '#project-details'), 'context');
  assert.equal(projectView(null, '#project-agents'), 'agents');
  assert.equal(projectView('overview', '#project-details'), 'overview');
  assert.equal(projectView('unrecognized'), 'overview');
});

test('changing project view preserves guide and other context without changing a task or sending work', () => {
  const original = new URLSearchParams('guide=work&source=conversation');
  const next = projectViewSearch(original, 'agents');
  assert.equal(original.has('view'), false);
  assert.equal(next.get('view'), 'agents');
  assert.equal(next.get('guide'), 'work');
  assert.equal(next.get('source'), 'conversation');
  assert.equal(projectViewSearch(next, 'overview').has('view'), false);
});
