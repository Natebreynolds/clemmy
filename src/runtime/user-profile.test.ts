/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-profile npx tsx --test src/runtime/user-profile.test.ts
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-profile';
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  configuredUserNameAliases,
  DEFAULT_USER_PROFILE,
  loadUserProfile,
  normalizeUserProfile,
  renderProfileForInstructions,
  saveUserProfile,
  textTargetsConfiguredUserRecipient,
} = await import('./user-profile.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

beforeEach(() => {
  rmSync(`${TEST_HOME}/state`, { recursive: true, force: true });
});

test('loadUserProfile returns defaults when file absent', () => {
  const p = loadUserProfile();
  assert.equal(p.displayName, DEFAULT_USER_PROFILE.displayName);
  assert.equal(p.communicationTone, 'balanced');
  assert.equal(p.formality, 'professional');
  assert.equal(p.urgencyTolerance, 'normal');
});

test('saveUserProfile persists and round-trips', () => {
  saveUserProfile({
    displayName: 'Alexander Chen',
    preferredName: 'Alexander',
    role: 'Building clemmy',
    communicationTone: 'terse',
    timezone: 'America/Los_Angeles',
  });
  const loaded = loadUserProfile();
  assert.equal(loaded.preferredName, 'Alexander');
  assert.equal(loaded.role, 'Building clemmy');
  assert.equal(loaded.communicationTone, 'terse');
  assert.equal(loaded.timezone, 'America/Los_Angeles');
});

test('saveUserProfile is a partial patch — preserves prior fields', () => {
  saveUserProfile({ preferredName: 'Alex', timezone: 'UTC' });
  saveUserProfile({ communicationTone: 'verbose' });
  const loaded = loadUserProfile();
  assert.equal(loaded.preferredName, 'Alex');
  assert.equal(loaded.timezone, 'UTC');
  assert.equal(loaded.communicationTone, 'verbose');
});

test('configured user aliases include preferred, display, owner, and first-name forms', () => {
  const profile = normalizeUserProfile({ displayName: 'Taylor Morgan', preferredName: 'Tay' });
  const aliases = configuredUserNameAliases(profile, 'Jordan Kim');
  assert.ok(aliases.includes('tay'));
  assert.ok(aliases.includes('taylor morgan'));
  assert.ok(aliases.includes('taylor'));
  assert.ok(aliases.includes('jordan kim'));
  assert.ok(aliases.includes('jordan'));
  assert.ok(!aliases.includes('the user'));
});

test('configured user recipient detection requires outbound recipient wording', () => {
  const aliases = ['jordan', 'jordan kim'];
  assert.equal(textTargetsConfiguredUserRecipient('Send Jordan the report.', aliases), true);
  assert.equal(textTargetsConfiguredUserRecipient('Send the report to Jordan Kim.', aliases), true);
  assert.equal(textTargetsConfiguredUserRecipient('Email the report to Jordan.', aliases), true);
  assert.equal(textTargetsConfiguredUserRecipient('Message the result to Jordan.', aliases), true);
  assert.equal(textTargetsConfiguredUserRecipient('DM the summary to Jordan.', aliases), true);
  assert.equal(textTargetsConfiguredUserRecipient('Notify the result to Jordan.', aliases), true);
  assert.equal(textTargetsConfiguredUserRecipient('Jordan approved the report.', aliases), false);
  assert.equal(textTargetsConfiguredUserRecipient('Analyze email trends for Jordan.', aliases), false);
  assert.equal(textTargetsConfiguredUserRecipient('Send Riley the report.', aliases), false);
});

test('normalizeUserProfile rejects invalid tone, falls to balanced', () => {
  const p = normalizeUserProfile({ communicationTone: 'extremely-terse' });
  assert.equal(p.communicationTone, 'balanced');
});

test('normalizeUserProfile rejects invalid formality, falls to professional', () => {
  const p = normalizeUserProfile({ formality: 'gibberish' });
  assert.equal(p.formality, 'professional');
});

test('normalizeUserProfile clamps long notes to 1200 chars', () => {
  const long = 'x'.repeat(2000);
  const p = normalizeUserProfile({ notes: long });
  assert.equal(p.notes?.length, 1200);
});

test('normalizeUserProfile validates working hours format HH:MM', () => {
  const p = normalizeUserProfile({ workingHoursStart: '9:00', workingHoursEnd: '18:00' });
  assert.equal(p.workingHoursStart, '9:00');
  assert.equal(p.workingHoursEnd, '18:00');

  const bad = normalizeUserProfile({ workingHoursStart: '9am', workingHoursEnd: '6pm' });
  assert.equal(bad.workingHoursStart, undefined);
  assert.equal(bad.workingHoursEnd, undefined);
});

test('normalizeUserProfile filters non-string entries from workingDays', () => {
  const p = normalizeUserProfile({ workingDays: ['Mon', 'Tue', 42, null, 'Wed'] as unknown[] });
  assert.deepEqual(p.workingDays, ['Mon', 'Tue', 'Wed']);
});

test('renderProfileForInstructions: empty when profile is default', () => {
  // Default has only generic placeholders. We render only meaningful
  // user-specific guidance — never inject a generic "the user" line.
  const rendered = renderProfileForInstructions(normalizeUserProfile({}));
  // Tone + formality + urgency lines ALWAYS render (they have non-default behavior to convey).
  assert.match(rendered, /balanced/);
  assert.match(rendered, /professional/i);
});

test('renderProfileForInstructions: includes preferred name when set', () => {
  const rendered = renderProfileForInstructions(normalizeUserProfile({
    displayName: 'Alexander Chen',
    preferredName: 'Alexander',
  }));
  assert.match(rendered, /Address them as Alexander/);
});

test('renderProfileForInstructions: surfaces working hours with days', () => {
  const rendered = renderProfileForInstructions(normalizeUserProfile({
    workingHoursStart: '9:00',
    workingHoursEnd: '18:00',
    workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  }));
  assert.match(rendered, /Working hours: 9:00–18:00/);
  assert.match(rendered, /Mon, Tue, Wed, Thu, Fri/);
});

test('renderProfileForInstructions: per-tone guidance reflects setting', () => {
  const terse = renderProfileForInstructions(normalizeUserProfile({ communicationTone: 'terse' }));
  assert.match(terse, /Default to terse/);

  const verbose = renderProfileForInstructions(normalizeUserProfile({ communicationTone: 'verbose' }));
  assert.match(verbose, /thorough/);
});

test('renderProfileForInstructions: per-formality guidance reflects setting', () => {
  const casual = renderProfileForInstructions(normalizeUserProfile({ formality: 'casual' }));
  assert.match(casual, /Casual tone/);

  const formal = renderProfileForInstructions(normalizeUserProfile({ formality: 'formal' }));
  assert.match(formal, /Formal tone/);
});

test('renderProfileForInstructions: urgency tolerance shapes guidance', () => {
  const low = renderProfileForInstructions(normalizeUserProfile({ urgencyTolerance: 'low' }));
  assert.match(low, /notify sparingly/);

  const high = renderProfileForInstructions(normalizeUserProfile({ urgencyTolerance: 'high' }));
  assert.match(high, /frequent updates/);
});

test('saveUserProfile updates updatedAt timestamp', async () => {
  const a = saveUserProfile({ displayName: 'A' });
  await new Promise((r) => setTimeout(r, 10));
  const b = saveUserProfile({ displayName: 'B' });
  assert.ok(b.updatedAt > a.updatedAt, 'updatedAt should advance');
});
