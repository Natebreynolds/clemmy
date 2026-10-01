/**
 * Run: node scripts/run-tests-isolated.mjs src/agents/calendar-read-learning.test.ts
 *
 * The calendar watch names no operation. A connected provider's calendar
 * read is learned in two stages — one names-only call that picks each
 * provider's window operation or none, then one recipe call for a chosen
 * operation — remembered against its definition, and "none" is remembered
 * against the provider's operation list. No provider is spelled anywhere but
 * in these fixtures.
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
const { CALENDAR_READ_RECIPE_PURPOSE, CALENDAR_READ_OPERATION_PURPOSE } = await import('../runtime/semantic-boundary/turn-semantic-model-port.js');

const TOOLS = [
  { slug: 'FIXTURECAL_GET_EVENT', description: 'Fetch one event by id.', inputParameters: { type: 'object', properties: { event_id: { type: 'string' } } } },
  { slug: 'FIXTURECAL_LIST_EVENTS', description: 'List events on the calendar between two times. '.repeat(10), inputParameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'integer' } } } },
  { slug: 'FIXTURECAL_FREE_BUSY', description: 'Free/busy slots.', inputParameters: { type: 'object' } },
];
const MAIL_TOOLS = [
  { slug: 'FIXTUREMAIL_LIST_MESSAGES', description: 'List mail.', inputParameters: { type: 'object', properties: { top: { type: 'integer' } } } },
  { slug: 'FIXTUREMAIL_SEND', description: 'Send mail.', inputParameters: { type: 'object' } },
];
const SHEET_TOOLS = [{ slug: 'FIXTURESHEET_READ_RANGE', description: 'Read a range.', inputParameters: { type: 'object' } }];
const RECIPE = {
  version: 1 as const, operationId: 'fixturecal_list_events',
  window: { start: 'from', end: 'to', limit: 'limit', timezone: null, fixed: null },
  fields: { id: 'id', title: 'name', start: 'when.start', end: 'when.end', allDay: null, cancelled: null, showAs: null,
    myResponse: null, myResponseFromAttendee: null, attendees: null, organizer: null, location: null },
};

type FindCall = { purpose: string; providers: ReadonlyArray<{ toolkit: string; operations: ReadonlyArray<Record<string, unknown>> }>; evidenceDigest: string };
type DeriveCall = { purpose: string; operations: ReadonlyArray<{ operationId: string }>; sample?: unknown; evidenceDigest: string };

/** A scripted model: stage one picks per provider, stage two writes a recipe. */
function scriptedPort(recipe: (call: DeriveCall) => unknown, pick: (toolkit: string) => string | null = (t) => (t.startsWith('fixturecal') ? 'FIXTURECAL_LIST_EVENTS' : null)) {
  const finds: FindCall[] = [];
  const derives: DeriveCall[] = [];
  return {
    finds, derives,
    port: () => ({
      async findCalendarReadOperations(call: FindCall) {
        finds.push(call);
        assert.equal(call.purpose, CALENDAR_READ_OPERATION_PURPOSE);
        return { picks: call.providers.map((p) => ({ toolkit: p.toolkit, operationId: pick(p.toolkit) })), evidenceDigest: call.evidenceDigest, modelIdentity: 'fixture-brain' };
      },
      async deriveCalendarRead(call: DeriveCall) {
        derives.push(call);
        assert.equal(call.purpose, CALENDAR_READ_RECIPE_PURPOSE);
        return { recipe: recipe(call), evidenceDigest: call.evidenceDigest, modelIdentity: 'fixture-judge' };
      },
    }),
  };
}
const toolsFor = (catalog: Record<string, typeof TOOLS>) => async (toolkit: string) => catalog[toolkit] ?? [];

test('learning costs one names-only call across providers and one recipe call for the chosen operation, then asks nothing again', async () => {
  // Live 2026-10-01: every provider's 40 operations with full schemas went to
  // the judge one provider at a time — 13 calls, 1.32M prompt tokens.
  runtime._resetCalendarReadLearningForTests();
  const model = scriptedPort(() => RECIPE);
  const catalog = { fixturecal: TOOLS, fixturemail: MAIL_TOOLS, fixturesheet: SHEET_TOOLS };
  const deps = {
    listToolkits: async () => Object.keys(catalog).map((slug) => ({ slug, status: 'ACTIVE' })),
    listTools: toolsFor(catalog), fingerprint: async () => 'fp-1', port: model.port,
  };
  assert.deepEqual(await runtime.ensureLearnedCalendarReads(deps), []);
  assert.equal(model.finds.length, 1, 'one stage-one call for every provider');
  assert.deepEqual(model.finds[0]!.providers.map((p) => p.toolkit).sort(), ['fixturecal', 'fixturemail', 'fixturesheet']);
  for (const provider of model.finds[0]!.providers) {
    for (const op of provider.operations) {
      assert.deepEqual(Object.keys(op).sort(), ['description', 'operationId'], 'names and descriptions only, no schemas');
      assert.ok(String(op.description).length <= 161, 'descriptions are short');
    }
  }
  assert.equal(model.derives.length, 1, 'one recipe call, for the chosen operation only');
  assert.deepEqual(model.derives[0]!.operations.map((op) => op.operationId), ['FIXTURECAL_LIST_EVENTS']);
  assert.ok(recipes.learnedCalendarRead('FIXTURECAL_LIST_EVENTS', 'fp-1'), 'the recipe is remembered');
  assert.equal(recipes.calendarReadAbsence('fixturemail')?.reason, 'none of its operations lists calendar events in a time window');
  assert.ok(recipes.calendarReadAbsence('fixturesheet'));

  // The next tick, nothing changed: no model call at all.
  await runtime.ensureLearnedCalendarReads(deps);
  assert.equal(model.finds.length, 1);
  assert.equal(model.derives.length, 1);

  // A provider whose operations change is asked again, alone.
  catalog.fixturemail = [...MAIL_TOOLS, { slug: 'FIXTUREMAIL_ARCHIVE', description: 'Archive mail.', inputParameters: { type: 'object' } }];
  await runtime.ensureLearnedCalendarReads(deps);
  assert.equal(model.finds.length, 2);
  assert.deepEqual(model.finds[1]!.providers.map((p) => p.toolkit), ['fixturemail']);
  assert.equal(model.derives.length, 1, 'no recipe call when the answer is none');

  // The chosen operation's definition changed: its recipe is derived again.
  await runtime.ensureLearnedCalendarReads({ ...deps, fingerprint: async () => 'fp-2' });
  assert.equal(model.derives.length, 2);
  assert.ok(recipes.learnedCalendarRead('FIXTURECAL_LIST_EVENTS', 'fp-2'));
});

test('a recipe that maps start and end to one argument, or names arguments the operation lacks, is rejected; a stored bad one is ignored', async () => {
  runtime._resetCalendarReadLearningForTests();
  const badWindow = { ...RECIPE, operationId: 'FIXTURECAL2_LIST_EVENTS', window: { start: 'filter', end: 'filter', limit: 'top', timezone: null, fixed: null } };
  const tools = [{ ...TOOLS[1]!, slug: 'FIXTURECAL2_LIST_EVENTS', inputParameters: { type: 'object', properties: { filter: { type: 'string' }, top: { type: 'integer' } } } }];
  const model = scriptedPort(() => badWindow, (t) => (t === 'fixturecal2' ? 'FIXTURECAL2_LIST_EVENTS' : null));
  let now = Date.parse('2026-10-01T16:00:00Z');
  const deps = {
    now: () => now,
    listToolkits: async () => [{ slug: 'fixturecal2', status: 'ACTIVE' }],
    listTools: toolsFor({ fixturecal2: tools as typeof TOOLS }), fingerprint: async () => 'fp-1', port: model.port,
  };
  const notes = await runtime.ensureLearnedCalendarReads(deps);
  assert.match(notes[0] ?? '', /fixturecal2: recipe rejected: the window start and end are the same argument \(filter\)/);
  assert.equal(recipes.listLearnedCalendarReads().some((row) => row.toolkit === 'fixturecal2'), false);
  // Not re-asked within a day; asked again after.
  await runtime.ensureLearnedCalendarReads(deps);
  assert.equal(model.finds.length, 1);
  now += 25 * 60 * 60_000;
  await runtime.ensureLearnedCalendarReads(deps);
  assert.equal(model.finds.length, 2);

  assert.deepEqual(recipes.recipeProblems(RECIPE, TOOLS[1]!.inputParameters), []);
  assert.deepEqual(recipes.recipeProblems({ ...RECIPE, window: { ...RECIPE.window, limit: 'max_results' } }, TOOLS[1]!.inputParameters),
    ['argument max_results is not one the operation declares']);
  // A bad recipe already on disk (the live 10-01 one) is not used.
  recipes.rememberCalendarRead({ recipe: badWindow, toolkit: 'fixturecal2', definitionFingerprint: 'fp-1', basis: { learnedAt: '2026-10-01T16:00:00Z', modelIdentity: 'x' } });
  assert.equal(recipes.listLearnedCalendarReads().some((row) => row.toolkit === 'fixturecal2'), false);
});

test('no model, or a model that names an operation the provider does not list, teaches nothing and is named', async () => {
  runtime._resetCalendarReadLearningForTests();
  const deps = { listToolkits: async () => [{ slug: 'fixturecal3', status: 'ACTIVE' }], listTools: toolsFor({ fixturecal3: TOOLS }), fingerprint: async () => 'fp-1' };
  assert.match((await runtime.ensureLearnedCalendarReads({ ...deps, port: () => null }))[0] ?? '', /no model is available/);
  runtime._resetCalendarReadLearningForTests();
  const wrong = scriptedPort(() => RECIPE, () => 'FIXTURECAL3_NOT_LISTED');
  assert.match((await runtime.ensureLearnedCalendarReads({ ...deps, port: wrong.port }))[0] ?? '', /named an operation it does not list/);
  assert.equal(wrong.derives.length, 0);
  assert.equal(recipes.listLearnedCalendarReads().some((row) => row.toolkit === 'fixturecal3'), false);
});

test('a recipe that reads nothing out of a non-empty response is wrong about the fields, not an empty calendar', () => {
  const payload = { data: { items: [{ uid: 'q', title: 'Review', starts: '2026-10-01T10:00:00Z', ends: '2026-10-01T11:00:00Z' }] } };
  assert.equal(recipes.recipeReadsPayload(RECIPE, payload, 'UTC'), 'misses');
  assert.equal(recipes.recipeReadsPayload({ ...RECIPE, fields: { id: 'uid', title: 'title', start: 'starts', end: 'ends' } }, payload, 'UTC'), 'reads');
  assert.equal(recipes.recipeReadsPayload(RECIPE, { data: { items: [] } }, 'UTC'), 'empty');
});

test('each tick prepares the learned read against the current definition, with an accepted source of its own, before compiling it', async () => {
  // Live 09-25 → 10-01: the provider changed the operation's definition and the
  // watch's durable manifest was never rebound, so every read refused as
  // mismatched. A workflow step rebinds through preparation; so does the watch now.
  runtime._resetCalendarReadLearningForTests();
  const judge = scriptedPort(() => RECIPE);
  await runtime.ensureLearnedCalendarReads({
    listToolkits: async () => [{ slug: 'fixturecal', status: 'ACTIVE' }],
    listTools: async () => TOOLS, fingerprint: async () => 'fp-1', port: judge.port,
  });
  const prepared: Array<{ allowedTools: readonly string[]; immutablePrompt: string; source?: { sessionId: string; sourceUserSeq: number; acceptedInput: string } }> = [];
  runtime._setCalendarReadPreparerForTests(async (input) => {
    prepared.push({ allowedTools: input.allowedTools, immutablePrompt: input.immutablePrompt, source: input.acceptedSource });
    return { status: 'refused', reason: 'exact_operation_provisioning_refused', operationId: 'FIXTURECAL_LIST_EVENTS', detail: 'fixture: no provider in this test' };
  });
  try {
    const result = await runtime.readCalendarAccountsAttested({ startIso: '2026-10-01T00:00:00Z', endIso: '2026-10-08T00:00:00Z', top: 50, timezone: 'UTC' }, 'tick-fixture');
    assert.equal(prepared.length, 1, 'one preparation per operation when no account is known yet');
    assert.deepEqual(prepared[0]!.allowedTools, ['FIXTURECAL_LIST_EVENTS']);
    assert.ok(prepared[0]!.source, 'the preparer gets an accepted source');
    assert.equal(prepared[0]!.source!.sessionId, 'watch:calendar');
    assert.match(prepared[0]!.source!.acceptedInput, /Calendar watch tick-fixture: read FIXTURECAL_LIST_EVENTS/);
    const { listEvents } = await import('../runtime/harness/eventlog.js');
    const minted = listEvents('watch:calendar', { types: ['user_input_received'] }).find((e) => e.seq === prepared[0]!.source!.sourceUserSeq);
    assert.equal(minted?.role, 'system', 'the source is a system event, never a person\'s turn');
    assert.equal(minted?.data.synthetic, true);
    assert.equal(result.reads.length, 0);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]!.reason, /preparation: any account: exact_operation_provisioning_refused:fixture/, result.failures[0]!.reason);
  } finally {
    runtime._setCalendarReadPreparerForTests(null);
  }
});
