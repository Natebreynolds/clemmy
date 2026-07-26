import assert from 'node:assert/strict';
import test from 'node:test';
import { focusActionHref, hasWorkstateDetails, type FocusWorkstate } from './focus';

function workstate(patch: Partial<FocusWorkstate> = {}): FocusWorkstate {
  return {
    version: 1,
    updatedAt: '2026-07-26T12:00:00.000Z',
    candidates: [],
    constraints: [],
    decisions: [],
    openLoops: [],
    actions: [],
    ...patch,
  };
}

test('shared-workstate visibility treats an empty notebook as quiet', () => {
  assert.equal(hasWorkstateDetails(null), false);
  assert.equal(hasWorkstateDetails(workstate()), false);
  assert.equal(hasWorkstateDetails(workstate({ decisions: ['Use the vegetarian menu.'] })), true);
});

test('only task-backed linked actions become internal Tasks deep links', () => {
  assert.equal(focusActionHref({
    id: 'a1',
    label: 'Update Airtable',
    status: 'running',
    kind: 'workflow',
    ref: 'run with spaces',
  }), '/tasks?select=run%20with%20spaces');
  assert.equal(focusActionHref({
    id: 'a2',
    label: 'Read the recipe',
    status: 'planned',
    kind: 'external',
    ref: 'https://example.com',
  }), null);
  assert.equal(focusActionHref({
    id: 'a3',
    label: 'Unlinked task',
    status: 'planned',
    kind: 'background',
  }), null);
});
