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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-identity-md-test-'));
process.env.CLEMENTINE_HOME = TMP;

const { regenerateIdentityMd } = await import('./identity-md-builder.js');
const { saveUserProfile } = await import('../runtime/user-profile.js');
const { IDENTITY_FILE, loadMemoryContext } = await import('./vault.js');
const { rememberFact, setFactPinned, recordFactUtility } = await import('./facts.js');
const { openMemoryDb } = await import('./db.js');

// Seed a starter IDENTITY.md so we have user-curated content to preserve.
const SEED = [
  '# Identity',
  '',
  'I am Clementine — Alex\'s executive assistant.',
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
    displayName: 'Alexander Chen',
    preferredName: 'Alex',
    role: 'Product Lead',
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
  assert.match(body, /\*\*Name:\*\* Alexander Chen \(preferred: Alex\)/);
  assert.match(body, /\*\*Role:\*\* Product Lead/);
  assert.match(body, /\*\*Timezone:\*\* America\/Los_Angeles/);
  // Weekday helper kicked in
  assert.match(body, /weekdays \(Mon–Fri\)/);
  assert.match(body, /08:00–17:30/);

  const injectedIdentity = loadMemoryContext().identity ?? '';
  assert.match(injectedIdentity, /I am Clementine/);
  assert.doesNotMatch(injectedIdentity, /AUTO-GENERATED|## Working with|Product Lead/, 'generated profile projection is not duplicated into the prompt');
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
  assert.doesNotMatch(body, /\*\*Role:\*\* Product Lead/);
});

test('regenerateIdentityMd: only preferred name set still renders cleanly', () => {
  // Reset profile to minimal — displayName falls back to default, but
  // preferred name should still produce a Name line.
  saveUserProfile({ displayName: 'the user', preferredName: 'Alex' });
  const result = regenerateIdentityMd();
  assert.equal(result.written, true);
  const body = readFileSync(IDENTITY_FILE, 'utf-8');
  assert.match(body, /\*\*Name:\*\* Alex/);
  // No "the user (preferred: Alex)" silliness
  assert.doesNotMatch(body, /the user \(preferred: Alex\)/);
});

// ── "Learned about you" section — durable kind:'user' facts ──────────

test('learned section: fresh unpinned fact inside the hygiene window is excluded', () => {
  rememberFact({ kind: 'user', content: 'User preference: Prefers async updates over meetings' });
  const result = regenerateIdentityMd();
  // Fact exists but is not yet durable → auto section is unchanged.
  assert.equal(result.written, false);
  assert.equal(result.reason, 'unchanged');
  const body = readFileSync(IDENTITY_FILE, 'utf-8');
  assert.doesNotMatch(body, /## Learned about you/);
});

test('learned section: pinned fact renders with the capture prefix stripped', () => {
  const fact = rememberFact({ kind: 'user', content: 'User preference: Prefers async updates over meetings' });
  setFactPinned(fact.id, true);
  const result = regenerateIdentityMd();
  assert.equal(result.written, true);
  const body = readFileSync(IDENTITY_FILE, 'utf-8');
  assert.match(body, /## Learned about you/);
  assert.match(body, /- Prefers async updates over meetings/);
  assert.doesNotMatch(body, /User preference:/);
  // Profile half still renders alongside the learned half.
  assert.match(body, /## Working with/);
  // Prompt injection contract unchanged: only the curated half is injected.
  const injectedIdentity = loadMemoryContext().identity ?? '';
  assert.doesNotMatch(injectedIdentity, /Learned about you|Prefers async updates/);
});

test('learned section: utility-credited fact counts as durable', () => {
  const fact = rememberFact({ kind: 'user', content: 'Reviews drafts on Sunday evenings' });
  recordFactUtility(fact.id);
  const result = regenerateIdentityMd();
  assert.equal(result.written, true);
  assert.match(readFileSync(IDENTITY_FILE, 'utf-8'), /- Reviews drafts on Sunday evenings/);
});

test('learned section: fact older than the hygiene window counts as durable', () => {
  const fact = rememberFact({ kind: 'user', content: 'Prefers Slack over email for internal chatter' });
  const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
  openMemoryDb().prepare('UPDATE consolidated_facts SET created_at = ? WHERE id = ?').run(fourDaysAgo, fact.id);
  const result = regenerateIdentityMd();
  assert.equal(result.written, true);
  assert.match(readFileSync(IDENTITY_FILE, 'utf-8'), /- Prefers Slack over email for internal chatter/);
});

test('learned section: non-user kinds never render, even pinned', () => {
  const fact = rememberFact({ kind: 'project', content: 'The staging deploy runs from the release branch' });
  setFactPinned(fact.id, true);
  regenerateIdentityMd();
  assert.doesNotMatch(readFileSync(IDENTITY_FILE, 'utf-8'), /staging deploy/);
});

test('learned section: durable facts alone (default profile) still produce the auto block', () => {
  // Wipe the saved profile → loadUserProfile returns defaults, which
  // fail the profile gate. Durable facts must carry the write alone.
  rmSync(path.join(TMP, 'state', 'user-profile.json'));
  const result = regenerateIdentityMd();
  assert.equal(result.written, true);
  const body = readFileSync(IDENTITY_FILE, 'utf-8');
  assert.match(body, /## Learned about you/);
  assert.match(body, /- Prefers async updates over meetings/);
  // No profile fields set → no "Working with" half.
  assert.doesNotMatch(body, /## Working with/);
  // Curated half still preserved verbatim.
  assert.match(body, /I am Clementine/);
});
