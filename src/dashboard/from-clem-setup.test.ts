/**
 * Run: node scripts/run-tests-isolated.mjs src/dashboard/from-clem-setup.test.ts
 *
 * Set up next: Clem offers one part of Clementine at a time, broken before
 * missing, from the live setup state; the owner's "not now" and "never" hide
 * it, and a part that is set up is not offered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-from-clem-setup-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });
test.after(() => rmSync(TMP, { recursive: true, force: true }));

const { pickSetupSuggestion } = await import('./from-clem-setup.js');
const { buildFromClem } = await import('./from-clem.js');
const { replyToFromClem } = await import('./from-clem-runtime.js');
type Ability = Parameters<typeof pickSetupSuggestion>[0][number];

const ability = (id: string, state: Ability['state'], place = 'settings'): Ability =>
  ({ id, name: id, unlocks: `what ${id} gives`, state, detail: `${id} detail`, place });
const none = () => false;

test('something broken is offered before something missing, then the order a new owner gains most from', () => {
  const abilities = [ability('meetings', 'not_set_up'), ability('phone', 'not_set_up'), ability('mcp', 'needs_attention'), ability('brain', 'ready')];
  assert.equal(pickSetupSuggestion(abilities, none)?.id, 'mcp');
  assert.equal(pickSetupSuggestion(abilities.filter((a) => a.id !== 'mcp'), none)?.id, 'phone');
  assert.equal(pickSetupSuggestion([ability('brain', 'not_set_up'), ability('phone', 'not_set_up')], none)?.id, 'brain');
});

test('a hidden offer is skipped, unknown and ready parts are never offered, and an unbroken tool server is not pushed', () => {
  const abilities = [ability('phone', 'not_set_up'), ability('meetings', 'not_set_up'), ability('apps', 'unknown'), ability('mcp', 'not_set_up')];
  assert.equal(pickSetupSuggestion(abilities, (key) => key === 'setup:phone')?.id, 'meetings');
  assert.equal(pickSetupSuggestion([ability('apps', 'unknown'), ability('mcp', 'not_set_up'), ability('brain', 'ready')], none), null);
});

test('the offer is its own row, after everything else, and says where to set it up', () => {
  const out = buildFromClem({
    heartbeats: [], noticingProposals: [], planProposals: [], asksOwner: () => true,
    notifications: [{ id: 'n1', kind: 'execution', title: 'Reply needed: Interview', body: '', createdAt: '2026-10-04T10:00:00.000Z', read: false, metadata: { watch: 'calendar', itemKey: 'k' } }],
    setup: { ability: 'meetings', name: 'Meeting recording', unlocks: 'summaries of your calls', detail: 'No Recall key is saved.',
      state: 'not_set_up', place: 'meetings', placeName: 'Meetings', since: '2026-10-04T12:00:00.000Z' },
  });
  assert.deepEqual(out.rows.map((row) => row.key), ['notif:n1', 'setup:meetings']);
  const offer = out.rows.at(-1)!;
  assert.equal(offer.asks, false);
  assert.deepEqual(offer.setup, { ability: 'meetings', place: 'meetings', placeName: 'Meetings' });
  assert.match(offer.detail ?? '', /Set it up in Meetings/);
});

test('a button with a fixed meaning settles without reading words, and never hides the offer for good', async () => {
  const stream = buildFromClem({
    heartbeats: [], noticingProposals: [], planProposals: [], notifications: [], asksOwner: () => false,
    setup: { ability: 'phone', name: 'The phone app', unlocks: 'answer from anywhere', detail: 'No phone is paired.',
      state: 'not_set_up', place: 'phone', placeName: 'Your phone', since: '2026-10-04T12:00:00.000Z' },
  });
  const log: string[] = [];
  const deps = {
    read: async () => stream,
    port: () => { throw new Error('a fixed decision reads nothing'); },
    answerQuestion: () => false, markRead: () => {}, addRule: (h: string) => { log.push(`rule:${h}`); },
    approvePlan: () => false, rejectPlan: () => false, snoozePlan: () => {},
    later: (key: string, forever?: boolean) => { log.push(`later:${key}:${forever ? 'forever' : 'tomorrow'}`); },
    startTurn: (input: { displayMessage: string }) => { log.push(`turn:${input.displayMessage}`); return 'clem'; },
  };
  assert.equal((await replyToFromClem('setup:phone', "Don't suggest this", deps as never, { decision: 'never' })).outcome, 'cleared');
  assert.equal((await replyToFromClem('setup:phone', 'Not now', deps as never, { decision: 'not_now' })).outcome, 'later');
  assert.equal((await replyToFromClem('setup:phone', 'Help me set it up', deps as never, { decision: 'do_it' })).outcome, 'started');
  assert.deepEqual(log, ['later:setup:phone:forever', 'later:setup:phone:tomorrow', 'turn:Help me set it up']);
});
