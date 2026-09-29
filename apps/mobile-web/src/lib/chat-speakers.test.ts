/**
 * Run: npx tsx --test src/lib/chat-speakers.test.ts   (from apps/mobile-web)
 *
 * Pins for the name above a reply: a thread with no agent in it shows no
 * names at all, and a thread an agent answered in names every exchange.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentThreadMarks } from '@clem/chat-engine';
import { replySpeakers } from './chat-speakers';

const MODEL_ROW = 'model-phase-live';
const user = () => ({ role: 'user' as const });
const reply = (agentName?: string) => ({
  role: 'assistant' as const,
  activity: [{ id: MODEL_ROW, ...(agentName ? { agentName } : {}) }],
});

test('a conversation with no agent in it draws no names', () => {
  const messages = [user(), reply(), user(), reply()];
  assert.deepEqual(replySpeakers(messages, agentThreadMarks(messages, null)), [null, null, null, null]);
  assert.deepEqual(replySpeakers([], []), []);
});

test('once an agent answered, every exchange is named, Clem included', () => {
  const messages = [user(), reply(), user(), reply('Sales Assistant'), user(), reply()];
  assert.deepEqual(
    replySpeakers(messages, agentThreadMarks(messages, null)),
    [null, 'Clem', null, 'Sales Assistant', null, 'Clem'],
  );
});

test('a conversation opened inside an agent names it before any reply says so', () => {
  const messages = [user(), { role: 'assistant' as const }];
  assert.deepEqual(replySpeakers(messages, agentThreadMarks(messages, 'Sales Assistant')), [null, 'Sales Assistant']);
});

test('one exchange is named once, and a decision card is never named', () => {
  const messages = [
    user(),
    reply('Sales Assistant'),
    { role: 'assistant' as const, approval: { subject: 'Send the email' } },
    reply('Sales Assistant'),
    user(),
    reply('Sales Assistant'),
  ];
  assert.deepEqual(
    replySpeakers(messages, agentThreadMarks(messages, null)),
    [null, 'Sales Assistant', null, null, null, 'Sales Assistant'],
  );
});
