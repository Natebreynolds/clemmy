import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-preparation-policy-'));
process.env.CLEMENTINE_HOME = home;
const { DEFAULT_PROACTIVITY_POLICY, loadProactivityPolicy, loadMeetingPreparationProactivityPolicy } = await import('./proactivity-policy.js');
const file = path.join(home, 'state', 'proactivity-policy.json');
mkdirSync(path.dirname(file), { recursive: true });
test.after(() => rmSync(home, { recursive: true, force: true }));

test('preparation accepts a missing default profile and exact saved gates without changing legacy fallback', () => {
  assert.equal(loadMeetingPreparationProactivityPolicy().noticingEnabled, true);
  writeFileSync(file, JSON.stringify({ ...DEFAULT_PROACTIVITY_POLICY, noticingEnabled: false,
    calendarWatchEnabled: false, quietHoursEnabled: true }));
  const policy = loadMeetingPreparationProactivityPolicy();
  assert.equal(policy.noticingEnabled, false); assert.equal(policy.calendarWatchEnabled, false);
  assert.equal(policy.quietHoursEnabled, true);
  writeFileSync(file, '{');
  assert.equal(loadProactivityPolicy().noticingEnabled, true, 'legacy monitor fallback is unchanged');
  assert.throws(() => loadMeetingPreparationProactivityPolicy(), /policy is unavailable/);
  assert.equal(readFileSync(file, 'utf8'), '{', 'strict reads never repair the owner policy');
});

test('preparation reads pre-Noticing profiles without rewriting them or changing their saved gates', () => {
  const legacy = { ...DEFAULT_PROACTIVITY_POLICY, calendarWatchEnabled: false,
    quietHoursEnabled: true } as Record<string, unknown>;
  delete legacy.noticingEnabled; delete legacy.noticingMinutes; delete legacy.noticingDailyCap;
  const saved = JSON.stringify(legacy);
  writeFileSync(file, saved);
  const policy = loadMeetingPreparationProactivityPolicy();
  assert.equal(policy.noticingEnabled, DEFAULT_PROACTIVITY_POLICY.noticingEnabled);
  assert.equal(policy.noticingMinutes, DEFAULT_PROACTIVITY_POLICY.noticingMinutes);
  assert.equal(policy.noticingDailyCap, DEFAULT_PROACTIVITY_POLICY.noticingDailyCap);
  assert.equal(policy.calendarWatchEnabled, false);
  assert.equal(policy.quietHoursEnabled, true);
  assert.equal(readFileSync(file, 'utf8'), saved, 'reading an old profile never migrates owner settings');

  writeFileSync(file, JSON.stringify({ ...legacy, noticingEnabled: false, noticingMinutes: 45 }));
  const partial = loadMeetingPreparationProactivityPolicy();
  assert.equal(partial.noticingEnabled, false, 'an explicit disabled suggestion gate stays disabled');
  assert.equal(partial.noticingMinutes, 45);
  assert.equal(partial.noticingDailyCap, DEFAULT_PROACTIVITY_POLICY.noticingDailyCap);
});

test('preparation still rejects omitted legacy calendar and quiet-hour gates', () => {
  for (const key of ['calendarWatchEnabled', 'calendarWatchMinutes', 'quietHoursEnabled', 'quietHoursStart', 'quietHoursEnd']) {
    const missing = { ...DEFAULT_PROACTIVITY_POLICY } as Record<string, unknown>;
    delete missing[key];
    writeFileSync(file, JSON.stringify(missing));
    assert.throws(() => loadMeetingPreparationProactivityPolicy(), /policy is unavailable/, key);
  }
  writeFileSync(file, '{}');
  assert.throws(() => loadMeetingPreparationProactivityPolicy(), /policy is unavailable/);
});

test('preparation rejects malformed, explicitly invalid gates and unreadable storage', () => {
  const valid = { ...DEFAULT_PROACTIVITY_POLICY };
  for (const value of [null, [], true,
    { ...valid, calendarWatchEnabled: 'false' }, { ...valid, quietHoursEnabled: null },
    { ...valid, noticingEnabled: null }, { ...valid, noticingEnabled: 'false' },
    { ...valid, noticingMinutes: null }, { ...valid, noticingMinutes: '180' },
    { ...valid, noticingDailyCap: null }, { ...valid, noticingDailyCap: '2' },
    { ...valid, noticingMinutes: 0 }, { ...valid, noticingDailyCap: 1.5 },
    { ...valid, calendarWatchMinutes: '30' }, { ...valid, quietHoursStart: '24:00' },
    { ...valid, quietHoursEnd: '19:78' }]) {
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => loadMeetingPreparationProactivityPolicy(), /policy is unavailable/);
  }
  rmSync(file); mkdirSync(file);
  assert.throws(() => loadMeetingPreparationProactivityPolicy(), /policy is unavailable/);
  rmSync(file, { recursive: true });
});
