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

test('preparation rejects malformed, incomplete or invalid required gates and unreadable storage', () => {
  const valid = { ...DEFAULT_PROACTIVITY_POLICY };
  const missing = { ...valid } as Record<string, unknown>; delete missing.noticingEnabled;
  for (const value of [null, [], true, missing,
    { ...valid, calendarWatchEnabled: 'false' }, { ...valid, quietHoursEnabled: null },
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
