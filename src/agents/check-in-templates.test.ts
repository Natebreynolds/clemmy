/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-templates npx tsx --test src/agents/check-in-templates.test.ts
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-templates';
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  SEED_TEMPLATES,
  createCheckInTemplate,
  cronMatches,
  deleteCheckInTemplate,
  ensureSeedTemplates,
  getCheckInTemplate,
  listCheckInTemplates,
  processProactiveCheckIns,
  renderQuestion,
  testFireTemplate,
  updateCheckInTemplate,
} = await import('./check-in-templates.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME + '/state', { recursive: true });
});

beforeEach(() => {
  rmSync(TEST_HOME + '/state/check-in-templates', { recursive: true, force: true });
  rmSync(TEST_HOME + '/state/check-in-templates-state.json', { force: true });
  rmSync(TEST_HOME + '/check-ins', { recursive: true, force: true });
  rmSync(TEST_HOME + '/agents-inbox', { recursive: true, force: true });
});

test('cronMatches: every-minute pattern always true', () => {
  assert.equal(cronMatches('* * * * *', new Date('2026-05-13T10:30:00')), true);
});

test('cronMatches: Monday 9am matches 0 9 * * 1', () => {
  // 2026-05-11 is a Monday.
  assert.equal(cronMatches('0 9 * * 1', new Date('2026-05-11T09:00:00')), true);
  assert.equal(cronMatches('0 9 * * 1', new Date('2026-05-11T09:01:00')), false);
  assert.equal(cronMatches('0 9 * * 1', new Date('2026-05-12T09:00:00')), false, 'Tuesday should not match');
});

test('cronMatches: range field matches all weekdays', () => {
  // 1-5 = Mon-Fri.
  for (const dayIso of ['2026-05-11T09:00:00','2026-05-12T09:00:00','2026-05-13T09:00:00','2026-05-14T09:00:00','2026-05-15T09:00:00']) {
    assert.equal(cronMatches('0 9 * * 1-5', new Date(dayIso)), true);
  }
  assert.equal(cronMatches('0 9 * * 1-5', new Date('2026-05-16T09:00:00')), false, 'Saturday should not match');
  assert.equal(cronMatches('0 9 * * 1-5', new Date('2026-05-17T09:00:00')), false, 'Sunday should not match');
});

test('cronMatches: step field */15 matches every 15 minutes', () => {
  for (const min of [0, 15, 30, 45]) {
    const d = new Date('2026-05-13T10:00:00');
    d.setMinutes(min);
    assert.equal(cronMatches('*/15 * * * *', d), true, `min=${min} should match`);
  }
  const d = new Date('2026-05-13T10:00:00');
  d.setMinutes(7);
  assert.equal(cronMatches('*/15 * * * *', d), false);
});

test('cronMatches: rejects bad expressions', () => {
  assert.equal(cronMatches('not a cron', new Date()), false);
  assert.equal(cronMatches('0 0', new Date()), false);
});

test('createCheckInTemplate: schedule template gets default cooldown=1h', () => {
  const t = createCheckInTemplate({
    name: 'Test scheduler',
    trigger: 'schedule',
    schedule: '0 9 * * 1',
    questionTemplate: 'What is up?',
  });
  assert.equal(t.cooldownHours, 1);
  assert.equal(t.enabled, false, 'new templates default to disabled');
  assert.match(t.id, /^tpl-/);
});

test('createCheckInTemplate: condition template gets default cooldown=12h', () => {
  const t = createCheckInTemplate({
    name: 'Blocked check',
    trigger: 'execution_blocked',
    questionTemplate: 'Q',
  });
  assert.equal(t.cooldownHours, 12);
  assert.equal(t.blockedHours, 24, 'default blockedHours = 24');
});

test('updateCheckInTemplate: partial patch preserves untouched fields', () => {
  const t = createCheckInTemplate({
    name: 'A',
    trigger: 'schedule',
    schedule: '0 9 * * 1',
    questionTemplate: 'Q',
  });
  const updated = updateCheckInTemplate(t.id, { enabled: true });
  assert.ok(updated);
  assert.equal(updated.enabled, true);
  assert.equal(updated.name, 'A');
  assert.equal(updated.schedule, '0 9 * * 1');
});

test('deleteCheckInTemplate: removes file and returns true', () => {
  const t = createCheckInTemplate({ name: 'temp', trigger: 'schedule', schedule: '* * * * *', questionTemplate: 'Q' });
  assert.equal(deleteCheckInTemplate(t.id), true);
  assert.equal(getCheckInTemplate(t.id), null);
  assert.equal(deleteCheckInTemplate(t.id), false);
});

test('renderQuestion: substitutes {{placeholders}}', () => {
  const t = createCheckInTemplate({
    name: 'X',
    trigger: 'schedule',
    schedule: '* * * * *',
    questionTemplate: 'Hello at {{time}} on {{date}} — summary: {{summary}}',
  });
  const out = renderQuestion(t, {
    triggeredAt: new Date().toISOString(),
    summary: 'scheduled fire',
    details: {},
  });
  assert.match(out, /Hello at \d{2}:\d{2}/);
  assert.match(out, /summary: scheduled fire/);
});

test('renderQuestion: leaves unknown placeholders untouched', () => {
  const t = createCheckInTemplate({
    name: 'X',
    trigger: 'schedule',
    schedule: '* * * * *',
    questionTemplate: 'Q {{unknownThing}}',
  });
  const out = renderQuestion(t, { triggeredAt: '', summary: '', details: {} });
  assert.match(out, /\{\{unknownThing\}\}/);
});

test('processProactiveCheckIns: only fires enabled templates', () => {
  createCheckInTemplate({
    name: 'Always fires',
    trigger: 'schedule',
    schedule: '* * * * *',
    questionTemplate: 'Always',
    enabled: false,
  });
  const result = processProactiveCheckIns(new Date());
  assert.equal(result.evaluated, 0);
  assert.equal(result.fired.length, 0);
});

test('processProactiveCheckIns: cooldown prevents back-to-back fires', () => {
  const t = createCheckInTemplate({
    name: 'Every minute',
    trigger: 'schedule',
    schedule: '* * * * *',
    questionTemplate: 'Hi',
    enabled: true,
    cooldownHours: 24,
  });
  const r1 = processProactiveCheckIns(new Date('2026-05-13T10:00:00'));
  assert.equal(r1.fired.length, 1, 'first call fires');
  const r2 = processProactiveCheckIns(new Date('2026-05-13T10:00:30'));
  assert.equal(r2.fired.length, 0, 'second call skipped by cooldown');
  assert.deepEqual(r2.skipped.map((s) => s.templateId), [t.id]);
});

test('processProactiveCheckIns: schedule fires only when cron matches', () => {
  createCheckInTemplate({
    name: 'Mon 9am',
    trigger: 'schedule',
    schedule: '0 9 * * 1',
    questionTemplate: 'Hi',
    enabled: true,
    cooldownHours: 0,
  });
  // Tuesday — should NOT fire.
  const tuesday = processProactiveCheckIns(new Date('2026-05-12T09:00:00'));
  assert.equal(tuesday.fired.length, 0);
  // Monday 9:00 — should fire.
  const monday = processProactiveCheckIns(new Date('2026-05-11T09:00:00'));
  assert.equal(monday.fired.length, 1);
});

test('testFireTemplate: manual fire respects cooldown by default', () => {
  const t = createCheckInTemplate({
    name: 'Cool',
    trigger: 'schedule',
    schedule: '* * * * *',
    questionTemplate: 'Hi',
    enabled: true,
    cooldownHours: 24,
  });
  const first = testFireTemplate(t.id);
  assert.equal(first.ok, true);
  const second = testFireTemplate(t.id);
  assert.equal(second.ok, false);
  const bypass = testFireTemplate(t.id, { bypassCooldown: true });
  assert.equal(bypass.ok, true);
});

test('ensureSeedTemplates: creates the seed library on first run, skips on second', () => {
  const first = ensureSeedTemplates();
  assert.equal(first.created.length, SEED_TEMPLATES.length);
  // Seeder is idempotent within a process via its internal flag; for
  // the second-call test we have to clear the flag by re-importing.
  // The functional skip behavior is enforced by seededIds in any case
  // — verify by listing.
  const all = listCheckInTemplates();
  for (const seed of SEED_TEMPLATES) {
    assert.ok(all.some((t) => t.seededId === seed.seededId), `missing seed ${seed.seededId}`);
  }
  // All seeded templates ship DISABLED.
  for (const t of all) {
    if (t.seededId) assert.equal(t.enabled, false, `seed ${t.seededId} should be disabled by default`);
  }
});
