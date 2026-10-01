/**
 * Run: node scripts/run-tests-isolated.mjs src/agents/calendar-read-learning.test.ts
 *
 * The calendar watch names no operation. A connected provider's calendar
 * read is learned from the provider's own definitions by the judge role,
 * remembered against the definition it was read from, derived again when
 * that definition changes, and left alone when the model says no operation
 * lists a window. No provider is spelled anywhere but in these fixtures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-calendar-learn-'));
process.env.CLEMENTINE_HOME = TMP;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TMP, 'state'), { recursive: true });
test.after(() => rmSync(TMP, { recursive: true, force: true }));

const recipes = await import('./calendar-read-recipe.js');
const runtime = await import('./calendar-watch-runtime.js');
const { CALENDAR_READ_RECIPE_PURPOSE } = await import('../runtime/semantic-boundary/turn-semantic-model-port.js');

const TOOLS = [
  { slug: 'FIXTURECAL_GET_EVENT', description: 'Fetch one event by id.', inputParameters: { type: 'object', properties: { event_id: { type: 'string' } } } },
  { slug: 'FIXTURECAL_LIST_EVENTS', description: 'List events on the calendar between two times.', inputParameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'integer' } } } },
  { slug: 'FIXTURECAL_FREE_BUSY', description: 'Free/busy slots.', inputParameters: { type: 'object' } },
];
const RECIPE = {
  version: 1 as const, operationId: 'fixturecal_list_events',
  window: { start: 'from', end: 'to', limit: 'limit' },
  fields: { id: 'id', title: 'name', start: 'when.start', end: 'when.end' },
};

function scriptedPort(answer: (call: { operations: ReadonlyArray<{ operationId: string }>; sample?: unknown }) => unknown) {
  const calls: unknown[] = [];
  return {
    calls,
    port: () => ({
      async deriveCalendarRead(call: { purpose: string; operations: ReadonlyArray<{ operationId: string }>; sample?: unknown; evidenceDigest: string }) {
        calls.push(call);
        assert.equal(call.purpose, CALENDAR_READ_RECIPE_PURPOSE);
        return { recipe: answer(call), evidenceDigest: call.evidenceDigest, modelIdentity: 'fixture-judge' };
      },
    }),
  };
}

test('a connected provider with no recipe gets one from its own definitions, remembered against that definition', async () => {
  runtime._resetCalendarReadLearningForTests();
  const judge = scriptedPort((call) => {
    assert.deepEqual(call.operations.map((op) => op.operationId), TOOLS.map((tool) => tool.slug));
    return RECIPE;
  });
  const notes = await runtime.ensureLearnedCalendarReads({
    listToolkits: async () => [{ slug: 'fixturecal', status: 'ACTIVE' }],
    listTools: async () => TOOLS,
    fingerprint: async () => 'fp-1',
    port: judge.port,
  });
  assert.deepEqual(notes, []);
  assert.equal(judge.calls.length, 1);
  const learned = recipes.learnedCalendarRead('FIXTURECAL_LIST_EVENTS', 'fp-1');
  assert.ok(learned);
  assert.equal(learned.recipe.operationId, 'FIXTURECAL_LIST_EVENTS', 'the provider\'s own spelling is kept');
  assert.equal(learned.toolkit, 'fixturecal');
  assert.equal(learned.basis.modelIdentity, 'fixture-judge');
  assert.equal(recipes.learnedCalendarRead('FIXTURECAL_LIST_EVENTS', 'fp-2'), null, 'a different definition is not this recipe');

  // The watch now has a read for the provider, before any manifest exists.
  const operations = runtime.connectedCalendarOperations();
  assert.deepEqual(operations.map((op) => op.operationId), ['FIXTURECAL_LIST_EVENTS']);
  assert.deepEqual(operations[0]!.provider.args({ startIso: 's', endIso: 'e', top: 7, timezone: 'UTC' }), { from: 's', to: 'e', limit: 7 });
  const events = operations[0]!.provider.parse({ data: [{ id: 'e1', name: 'Standup', when: { start: '2026-10-01T16:00:00Z', end: '2026-10-01T16:15:00Z' } }] }, { timezone: 'UTC' });
  assert.equal(events[0]?.subject, 'Standup');

  // Same definition next tick: nothing is asked again.
  await runtime.ensureLearnedCalendarReads({
    listToolkits: async () => [{ slug: 'fixturecal', status: 'ACTIVE' }],
    listTools: async () => TOOLS, fingerprint: async () => 'fp-1', port: judge.port,
  });
  assert.equal(judge.calls.length, 1);

  // The definition changed: the recipe is derived again.
  await runtime.ensureLearnedCalendarReads({
    listToolkits: async () => [{ slug: 'fixturecal', status: 'ACTIVE' }],
    listTools: async () => TOOLS, fingerprint: async () => 'fp-2', port: judge.port,
  });
  assert.equal(judge.calls.length, 2);
  assert.ok(recipes.learnedCalendarRead('FIXTURECAL_LIST_EVENTS', 'fp-2'));
});

test('a provider with no window read is left alone, and a model that names an unlisted operation teaches nothing', async () => {
  runtime._resetCalendarReadLearningForTests();
  const none = scriptedPort(() => null);
  const notes = await runtime.ensureLearnedCalendarReads({
    listToolkits: async () => [{ slug: 'fixturemail', status: 'ACTIVE' }],
    listTools: async () => [{ slug: 'FIXTUREMAIL_LIST_MESSAGES', description: 'List mail.', inputParameters: {} }],
    fingerprint: async () => 'fp-m', port: none.port,
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /fixturemail: none of its operations lists calendar events/);

  runtime._resetCalendarReadLearningForTests();
  const wrong = scriptedPort(() => ({ ...RECIPE, operationId: 'FIXTUREMAIL_SOMETHING_ELSE' }));
  const notes2 = await runtime.ensureLearnedCalendarReads({
    listToolkits: async () => [{ slug: 'fixturemail', status: 'ACTIVE' }],
    listTools: async () => [{ slug: 'FIXTUREMAIL_LIST_MESSAGES', description: 'List mail.', inputParameters: {} }],
    fingerprint: async () => 'fp-m', port: wrong.port,
  });
  assert.match(notes2[0]!, /does not list/);
  assert.equal(recipes.listLearnedCalendarReads().some((row) => row.toolkit === 'fixturemail'), false);

  // No model: named, retried later, nothing invented.
  runtime._resetCalendarReadLearningForTests();
  const notes3 = await runtime.ensureLearnedCalendarReads({
    listToolkits: async () => [{ slug: 'fixturemail', status: 'ACTIVE' }],
    listTools: async () => [], fingerprint: async () => 'fp-m', port: () => null,
  });
  assert.match(notes3[0]!, /no model is available/);
});

test('a recipe that reads nothing out of a non-empty response is wrong about the fields, not an empty calendar', () => {
  const payload = { data: { items: [{ uid: 'q', title: 'Review', starts: '2026-10-01T10:00:00Z', ends: '2026-10-01T11:00:00Z' }] } };
  assert.equal(recipes.recipeReadsPayload(RECIPE, payload, 'UTC'), 'misses');
  assert.equal(recipes.recipeReadsPayload({ ...RECIPE, fields: { id: 'uid', title: 'title', start: 'starts', end: 'ends' } }, payload, 'UTC'), 'reads');
  assert.equal(recipes.recipeReadsPayload(RECIPE, { data: { items: [] } }, 'UTC'), 'empty');
});
