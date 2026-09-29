/**
 * Run: node scripts/run-tests-isolated.mjs packages/chat-engine/src/turn-project.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  messageProject, projectSwitchLabel, projectThreadMarks, recordedTurnProject, type ProjectAttributed,
} from './turn-project.js';
import { agentThreadMarks } from './turn-agent.js';
import { MODEL_PHASE_ACTIVITY_ID, reduceActivity } from './reduce-activity.js';
import type { ActivityItem, HarnessEvent } from './types.js';

function routed(data: { projectName?: string; agentName?: string } = {}): ActivityItem[] {
  return reduceActivity([], {
    seq: 1,
    type: 'turn_model_routed',
    data: { model: 'test-model', provider: 'test', ...data },
  } as HarnessEvent, () => 1);
}

const user = (text: string, projectName?: string | null): ProjectAttributed & { text: string } => ({
  role: 'user', text, ...(projectName !== undefined ? { projectName } : {}),
});
const reply = (text: string, activity?: ActivityItem[], projectName?: string | null): ProjectAttributed & { text: string } => ({
  role: 'assistant', text, ...(activity ? { activity } : {}), ...(projectName !== undefined ? { projectName } : {}),
});

test('a reply names its project from the route marker; a routed reply with none worked in no project', () => {
  assert.equal(messageProject(reply('a', routed({ projectName: 'Weekly Sales' }))), 'Weekly Sales');
  assert.equal(messageProject(reply('b', routed())), null);
  assert.equal(messageProject(reply('c')), undefined, 'no route marker says nothing');
  assert.equal(messageProject(reply('d', undefined, null)), null, 'a message can state no project directly');
  assert.equal(messageProject(reply('e', routed({ projectName: '   ' }))), null, 'a blank name is no project');
});

test('the route marker carries the project beside the agent, and keeps it through a later phase', () => {
  const first = routed({ projectName: 'Weekly Sales', agentName: 'Sales Assistant' });
  const later = reduceActivity(first, {
    seq: 2, type: 'turn_model_routed', data: { model: 'backup-model', provider: 'test', fallover: true },
  } as HarnessEvent, () => 2);
  const row = later.find((item) => item.id === MODEL_PHASE_ACTIVITY_ID);
  assert.equal(row?.projectName, 'Weekly Sales');
  assert.equal(row?.agentName, 'Sales Assistant');
});

test('a saved turn names its project only when it worked in one', () => {
  assert.equal(recordedTurnProject({ agentName: null, projectName: 'Weekly Sales' }), 'Weekly Sales');
  assert.equal(recordedTurnProject({ agentName: 'Sales Assistant' }), null, 'answered, and named no project');
  assert.equal(recordedTurnProject({ agentName: null }), null);
  assert.equal(recordedTurnProject({}), undefined, 'a turn with no record does not say');
  assert.equal(recordedTurnProject({ projectName: null }), null);
});

test('the line sits above the question that moved the conversation, and older replies keep their project', () => {
  const thread = [
    user('plain question'),
    reply('plain answer', routed()),
    user('pull the numbers'),
    reply('here they are', routed({ projectName: 'Weekly Sales' })),
    user('and last week'),
    reply('last week', routed({ projectName: 'Weekly Sales' })),
    user('now the launch plan', 'Spring Launch'),
    reply('the plan', routed({ projectName: 'Spring Launch' })),
    user('unrelated', null),
    reply('sure', routed()),
  ];
  const marks = projectThreadMarks(thread);
  assert.deepEqual(marks.map((m) => m.project), [
    null, null, null, 'Weekly Sales', 'Weekly Sales', 'Weekly Sales', 'Spring Launch', 'Spring Launch', null, null,
  ]);
  assert.deepEqual(marks.map((m, i) => (m.movedTo ? [i, m.movedTo.name, m.movedTo.from] : null)).filter(Boolean), [
    [2, 'Weekly Sales', null],
    [6, 'Spring Launch', 'Weekly Sales'],
    [8, null, 'Spring Launch'],
  ]);
});

test('a conversation opened in a project starts without a line; unknown replies keep the current project', () => {
  const thread = [
    user('first'),
    reply('first answer', routed({ projectName: 'Weekly Sales' })),
    user('approve it'),
    reply('done'),
  ];
  const marks = projectThreadMarks(thread, null);
  assert.deepEqual(marks.map((m) => m.project), ['Weekly Sales', 'Weekly Sales', 'Weekly Sales', 'Weekly Sales']);
  assert.equal(marks.some((m) => m.movedTo), false);
});

test('with nothing said at all the conversation\'s own project stands, and none means none', () => {
  assert.deepEqual(projectThreadMarks([user('hi'), reply('hello')], 'Weekly Sales').map((m) => m.project), ['Weekly Sales', 'Weekly Sales']);
  const plain = projectThreadMarks([user('hi'), reply('hello', routed())]);
  assert.deepEqual(plain, [{ project: null }, { project: null }], 'a conversation with no project draws nothing');
});

test('a just-sent question sent into a project shows the line before the reply arrives', () => {
  const marks = projectThreadMarks([
    user('plain'),
    reply('answer', routed()),
    user('pull the numbers', 'Weekly Sales'),
    reply(''),
  ]);
  assert.deepEqual(marks[2].movedTo, { name: 'Weekly Sales', from: null });
  assert.equal(marks[3].project, 'Weekly Sales');
});

test('the project and the agent are marked independently on the same thread', () => {
  const thread = [
    { role: 'user' as const },
    { role: 'assistant' as const, activity: routed({ agentName: 'Sales Assistant' }) },
    { role: 'user' as const },
    { role: 'assistant' as const, activity: routed({ agentName: 'Sales Assistant', projectName: 'Weekly Sales' }) },
  ];
  assert.deepEqual(agentThreadMarks(thread).map((m) => Boolean(m.switchedTo)), [false, false, false, false]);
  assert.deepEqual(projectThreadMarks(thread).map((m) => m.movedTo?.name ?? null), [null, null, 'Weekly Sales', null]);
});

test('the words on the line', () => {
  assert.equal(projectSwitchLabel('Weekly Sales'), 'Now working in Weekly Sales');
  assert.equal(projectSwitchLabel('Spring Launch', 'Weekly Sales'), 'Now working in Spring Launch');
  assert.equal(projectSwitchLabel(null, 'Weekly Sales'), 'Left Weekly Sales');
  assert.equal(projectSwitchLabel(null), 'Left the project');
});
