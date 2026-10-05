/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/app-guide/abilities.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appAbilitiesFromFacts, appGuideText, type AppAbilityFacts } from './abilities.js';
import { APP_PLACE_IDS } from './app-places.js';

const SET_UP: AppAbilityFacts = {
  brain: { model: 'model-a', provider: 'codex' },
  checker: { otherFamilyConnected: true, reviewsOwnFamily: false },
  jev: { configured: true, enabled: true },
  recallKey: true,
  apps: { keyPresent: true, connected: ['mail', 'chat'] },
  mcp: { servers: 2, unhealthy: [] },
  phones: 1,
  phonePush: { ready: true },
  calendarWatch: { enabled: true, lastFinding: 'No change across 3 upcoming events' },
};

const BLANK: AppAbilityFacts = {
  brain: null,
  checker: { otherFamilyConnected: false, reviewsOwnFamily: true },
  jev: { configured: false, enabled: false },
  recallKey: false,
  apps: { keyPresent: false, connected: [] },
  mcp: { servers: 0, unhealthy: [] },
  phones: 0,
  phonePush: { ready: false, reason: 'no_phone_registered' },
  calendarWatch: { enabled: false },
};

test('a fully set up home reads ready everywhere, and every ability points at a real place', () => {
  const abilities = appAbilitiesFromFacts(SET_UP);
  assert.deepEqual(abilities.filter((a) => a.state !== 'ready').map((a) => a.id), []);
  for (const ability of abilities) assert.ok(APP_PLACE_IDS.has(ability.place), ability.id);
});

test('a blank home says what is missing, what it would give, and where to set it up', () => {
  const abilities = appAbilitiesFromFacts(BLANK);
  assert.deepEqual(abilities.filter((a) => a.state === 'ready').map((a) => a.id), []);
  const brain = abilities.find((a) => a.id === 'brain')!;
  assert.equal(brain.place, 'model-accounts');
  const meetings = abilities.find((a) => a.id === 'meetings')!;
  assert.equal(meetings.state, 'not_set_up');
  assert.match(meetings.detail, /not recorded/);
  assert.equal(abilities.find((a) => a.id === 'second-model')!.state, 'not_set_up');
});

test('a fact that could not be read is reported as unknown without hiding the rest', () => {
  const abilities = appAbilitiesFromFacts({ ...SET_UP, recallKey: null, apps: null });
  assert.equal(abilities.find((a) => a.id === 'meetings')!.state, 'unknown');
  assert.equal(abilities.find((a) => a.id === 'apps')!.state, 'unknown');
  assert.equal(abilities.find((a) => a.id === 'brain')!.state, 'ready');
});

test('something set up but broken needs attention rather than reading as missing', () => {
  const abilities = appAbilitiesFromFacts({ ...SET_UP,
    mcp: { servers: 2, unhealthy: ['notes'] },
    phonePush: { ready: false, reason: 'apns_key_missing' },
    calendarWatch: { enabled: true, error: 'calendar refused the read' } });
  for (const id of ['mcp', 'phone-alerts', 'calendar-watch']) {
    assert.equal(abilities.find((a) => a.id === id)!.state, 'needs_attention', id);
  }
});

test('the guide lists every place and tells Clem how to link one', () => {
  const text = appGuideText(appAbilitiesFromFacts(BLANK));
  assert.match(text, /Not set up:/);
  for (const id of APP_PLACE_IDS) assert.match(text, new RegExp(`- ${id}: `));
  assert.match(text, /\[Open <name>\]\(app:<id>\)/);
  assert.match(text, /meetings: Meetings, Recorded meetings and their summaries \(Mac only\)/);
});

test('the guide can leave the place list out when only what is set up matters', () => {
  const text = appGuideText(appAbilitiesFromFacts(BLANK), { places: false });
  assert.match(text, /Not set up:/);
  assert.doesNotMatch(text, /Places \(id: name/);
});
