import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSpaceShape, spaceBuildState, spaceBuildStepFromActivity, spaceBuildSteps } from './space-build';
import type { ActivityItem, ChatMessage } from './useChat';

const item = (label: string, status: ActivityItem['status'] = 'done', extra: Partial<ActivityItem> = {}): ActivityItem =>
  ({ id: `a-${label}-${Math.random().toString(36).slice(2, 6)}`, kind: 'tool', label, status, ...extra });

test('space tools become plain-language build steps', () => {
  assert.equal(spaceBuildStepFromActivity(item('space_save'))?.label, 'Wrote the Space');
  assert.equal(spaceBuildStepFromActivity(item('space_refresh', 'running'))?.status, 'running');
  assert.equal(spaceBuildStepFromActivity(item('space_edit_view'))?.kind, 'write');
});

test('a provider read called through a carrier reads as what it read', () => {
  const step = spaceBuildStepFromActivity(item('composio:OUTLOOK_GET_CALENDAR_VIEW'));
  assert.equal(step?.label, 'Read outlook: get calendar view');
  assert.equal(step?.kind, 'read');
  assert.equal(spaceBuildStepFromActivity(item('work_call')), null, 'the bare carrier is noise');
});

test('build state follows the latest assistant message', () => {
  const user: ChatMessage = { id: 'u', role: 'user', text: 'build it' };
  assert.equal(spaceBuildState([]), 'idle');
  assert.equal(spaceBuildState([user, { id: 'a', role: 'assistant', text: '', status: 'thinking' }]), 'building');
  assert.equal(spaceBuildState([user, { id: 'a', role: 'assistant', text: 'Which mailbox?', status: 'awaiting-reply' }]), 'needs_input');
  assert.equal(spaceBuildState([user, { id: 'a', role: 'assistant', text: 'Done.', status: 'complete' }]), 'built');
  assert.equal(spaceBuildState([user, { id: 'a', role: 'assistant', text: 'x', status: 'failed' }]), 'failed');
});

test('steps come from the latest turn, oldest first, with repeated searches collapsed', () => {
  const msgs: ChatMessage[] = [
    { id: 'u', role: 'user', text: 'build' },
    { id: 'a', role: 'assistant', text: '', status: 'thinking', activity: [
      item('tool_search'), item('tool_search'), item('composio:OUTLOOK_LIST_MESSAGES'), item('space_save', 'running'),
    ] },
  ];
  const steps = spaceBuildSteps(msgs);
  assert.deepEqual(steps.map((s) => s.label), ['Finding the right tool', 'Read outlook: list messages', 'Wrote the Space']);
  assert.equal(steps[2]?.status, 'running');
});

test('describeSpaceShape says what the Space is made of', () => {
  assert.equal(describeSpaceShape({ dataSources: [{ schedule: '0 8 * * *' } as never, {} as never], actions: [{} as never], version: 4 }),
    '2 live sources · 1 action · 1 on a schedule · v4');
  assert.equal(describeSpaceShape({ dataSources: [], actions: [] }), '0 live sources · 0 actions · refreshes on demand');
});
