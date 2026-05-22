/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-identity-md-test npx tsx --test \
 *   src/memory/identity-md-builder.test.ts
 *
 * Covers the IDENTITY.md auto-section behavior. Mirrors the
 * memory-md-builder test plan:
 *
 *   1. default profile (displayName="the user", no name set) →
 *      builder writes nothing, leaves the file alone;
 *   2. populated profile → "Working with" block lands under marker,
 *      user-curated content above is preserved verbatim;
 *   3. idempotent — second call with no profile change is a no-op;
 *   4. preferred name only (no display name) renders correctly;
 *   5. weekday helpers — "Mon..Fri" renders as "weekdays (Mon–Fri)".
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-identity-md-test-'));
process.env.CLEMENTINE_HOME = TMP;

const { regenerateIdentityMd } = await import('./identity-md-builder.js');
const { saveUserProfile } = await import('../runtime/user-profile.js');
const { IDENTITY_FILE } = await import('./vault.js');

// Seed a starter IDENTITY.md so we have user-curated content to preserve.
const SEED = [
  '# Identity',
  '',
  'I am Clementine — Nate\'s executive assistant.',
  '',
  'I keep his work straight across tools.',
  '',
].join('\n');
mkdirSync(path.dirname(IDENTITY_FILE), { recursive: true });
writeFileSync(IDENTITY_FILE, SEED, 'utf-8');

test('regenerateIdentityMd: default profile (no name set) is a no-op on the file', () => {
  // No profile saved yet → loadUserProfile returns DEFAULT_USER_PROFILE
  // with displayName='the user'. The builder should refuse to emit an
  // auto block and leave the file as-is.
  const before = readFileSync(IDENTITY_FILE, 'utf-8');
  const result = regenerateIdentityMd();
  assert.equal(result.written, false);
  assert.equal(result.reason, 'no-profile');
  const after = readFileSync(IDENTITY_FILE, 'utf-8');
  assert.equal(after, before);
});

test('regenerateIdentityMd: populated profile writes auto-section, preserves user content', () => {
  saveUserProfile({
    displayName: 'Nathan Reynolds',
    preferredName: 'Nate',
    role: 'SVP of Sales',
    timezone: 'America/Los_Angeles',
    workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    workingHoursStart: '08:00',
    workingHoursEnd: '17:30',
    communicationTone: 'balanced',
    formality: 'professional',
    urgencyTolerance: 'normal',
  });

  const result = regenerateIdentityMd();
  assert.equal(result.written, true);
  assert.equal(result.reason, 'first-write');

  const body = readFileSync(IDENTITY_FILE, 'utf-8');
  // User-curated content preserved
  assert.match(body, /I am Clementine/);
  assert.match(body, /I keep his work straight/);
  // Marker + auto section appended below
  assert.match(body, /AUTO-GENERATED/);
  assert.match(body, /## Working with/);
  assert.match(body, /\*\*Name:\*\* Nathan Reynolds \(preferred: Nate\)/);
  assert.match(body, /\*\*Role:\*\* SVP of Sales/);
  assert.match(body, /\*\*Timezone:\*\* America\/Los_Angeles/);
  // Weekday helper kicked in
  assert.match(body, /weekdays \(Mon–Fri\)/);
  assert.match(body, /08:00–17:30/);
});

test('regenerateIdentityMd: idempotent — second call is a no-op', () => {
  const stable = regenerateIdentityMd();
  assert.equal(stable.written, false);
  assert.equal(stable.reason, 'unchanged');
});

test('regenerateIdentityMd: profile change triggers a write', () => {
  saveUserProfile({ role: 'Chief Revenue Officer' });
  const result = regenerateIdentityMd();
  assert.equal(result.written, true);
  assert.equal(result.reason, 'updated');
  const body = readFileSync(IDENTITY_FILE, 'utf-8');
  assert.match(body, /\*\*Role:\*\* Chief Revenue Officer/);
  assert.doesNotMatch(body, /\*\*Role:\*\* SVP of Sales/);
});

test('regenerateIdentityMd: only preferred name set still renders cleanly', () => {
  // Reset profile to minimal — displayName falls back to default, but
  // preferred name should still produce a Name line.
  saveUserProfile({ displayName: 'the user', preferredName: 'Nate' });
  const result = regenerateIdentityMd();
  assert.equal(result.written, true);
  const body = readFileSync(IDENTITY_FILE, 'utf-8');
  assert.match(body, /\*\*Name:\*\* Nate/);
  // No "the user (preferred: Nate)" silliness
  assert.doesNotMatch(body, /the user \(preferred: Nate\)/);
});
