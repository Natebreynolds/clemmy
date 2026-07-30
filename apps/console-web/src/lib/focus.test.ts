import assert from 'node:assert/strict';
import test from 'node:test';
import {
  focusActionHref,
  hasWorkstateDetails,
  shouldShowWorkstate,
  type FocusSnapshot,
  type FocusView,
  type FocusWorkstate,
} from './focus';

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

function snapshot(patch: Partial<FocusView> = {}, needsConfirm = false): FocusSnapshot {
  const view: FocusView = {
    id: 1,
    resource_ref: 'chat:abc',
    title: 'All three pieces are live. Sheet — Platform 4.9',
    summary: 'A summary echoing the last chat message.',
    status: 'active',
    resource_kind: null,
    related_session_id: null,
    related_goal_id: null,
    created_at: '2026-07-30T12:00:00.000Z',
    last_touched_at: '2026-07-30T12:00:00.000Z',
    confirm_after: '2026-07-31T12:00:00.000Z',
    parked_at: null,
    parked_reason: null,
    workstate: null,
    ...patch,
  };
  return { active: view, parked: [], needsConfirm };
}

test('the Working Together card hides unless there is real detail or a check to answer', () => {
  // Live complaint (owner, 2026-07-30): a bare title+summary card is an echo
  // of the last chat message — "there are no actions for it".
  assert.equal(shouldShowWorkstate(null), false);
  assert.equal(shouldShowWorkstate(snapshot()), false, 'no workstate at all stays hidden');
  assert.equal(
    shouldShowWorkstate(snapshot({ workstate: workstate({ objective: 'Compile Slack insights daily.' }) })),
    false,
    'an objective alone is still just two lines of text — hidden',
  );
  assert.equal(
    shouldShowWorkstate(snapshot({
      workstate: workstate({ actions: [{ id: 'a1', label: 'Write the sheet', status: 'running' }] }),
    })),
    true,
    'structured detail earns the card its space',
  );
  assert.equal(
    shouldShowWorkstate(snapshot({}, true)),
    true,
    'a pending context check must always surface',
  );
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
