import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentSwitchLabel, agentThreadMarks, messageAgent, type AgentAttributed } from './turn-agent.js';
import { reduceActivity } from './reduce-activity.js';
import type { ActivityItem, HarnessEvent } from './types.js';

function routed(agentName?: string): ActivityItem[] {
  return reduceActivity([], {
    seq: 1,
    type: 'turn_model_routed',
    data: { model: 'test-model', provider: 'test', ...(agentName ? { agentName } : {}) },
  } as HarnessEvent, () => 1);
}

const user = (text: string, agentName?: string | null): AgentAttributed & { text: string } => ({
  role: 'user', text, ...(agentName !== undefined ? { agentName } : {}),
});
const reply = (text: string, activity?: ActivityItem[], agentName?: string | null): AgentAttributed & { text: string } => ({
  role: 'assistant', text, ...(activity ? { activity } : {}), ...(agentName !== undefined ? { agentName } : {}),
});

test('a reply names its agent from the route marker; a routed reply with no agent is Clem', () => {
  assert.equal(messageAgent(reply('a', routed('Instagram Manager'))), 'Instagram Manager');
  assert.equal(messageAgent(reply('b', routed())), null);
  assert.equal(messageAgent(reply('c')), undefined, 'no route marker says nothing');
  assert.equal(messageAgent(reply('d', undefined, null)), null, 'a reopened turn states it directly');
});

test('the line sits above the question that moved the conversation, and speakers follow it', () => {
  const thread = [
    user('plain question'),
    reply('plain answer', routed()),
    user('draft the posts'),
    reply('three drafts', routed('Instagram Manager')),
    user('one more'),
    reply('a fourth', routed('Instagram Manager')),
    user('back to my calendar', null),
    reply('calendar', routed()),
  ];
  const marks = agentThreadMarks(thread);
  assert.deepEqual(marks.map((m) => m.speaker), [null, null, null, 'Instagram Manager', 'Instagram Manager', 'Instagram Manager', null, null]);
  assert.deepEqual(marks.map((m, i) => (m.switchedTo ? [i, m.switchedTo.name] : null)).filter(Boolean), [
    [2, 'Instagram Manager'],
    [6, null],
  ]);
  assert.equal(agentSwitchLabel(null), 'Switched to Clem');
  assert.equal(agentSwitchLabel('Instagram Manager'), 'Switched to Instagram Manager');
});

test('a thread opened in an agent starts without a line; unknown replies keep the current speaker', () => {
  const thread = [
    user('first'),
    reply('first answer', routed('Prospect Research')),
    user('approve it'),
    reply('done'),
  ];
  const marks = agentThreadMarks(thread, null);
  assert.deepEqual(marks.map((m) => m.speaker), ['Prospect Research', 'Prospect Research', 'Prospect Research', 'Prospect Research']);
  assert.equal(marks.some((m) => m.switchedTo), false);
});

test('a just-sent question addressed to a new agent shows the line before the reply arrives', () => {
  const thread = [
    user('plain'),
    reply('answer', routed()),
    user('draft posts', 'Instagram Manager'),
    reply('', undefined),
  ];
  const marks = agentThreadMarks(thread);
  assert.deepEqual(marks[2].switchedTo, { name: 'Instagram Manager' });
  assert.equal(marks[3].speaker, 'Instagram Manager');
});

test('with nothing said at all, the fallback speaks', () => {
  const marks = agentThreadMarks([user('hi'), reply('hello')], 'Instagram Manager');
  assert.deepEqual(marks.map((m) => m.speaker), ['Instagram Manager', 'Instagram Manager']);
});
