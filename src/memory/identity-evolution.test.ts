/**
 * Run: npx tsx --test src/memory/identity-evolution.test.ts
 *
 * Covers the curated-identity evolution loop end to end with a mocked
 * distiller (no LLM call):
 *
 *   1. kill switch (CLEMMY_IDENTITY_EVOLUTION=0) → 'disabled';
 *   2. evidence gate — fewer than 5 durable facts → 'not-enough-evidence';
 *   3. draft path — pending proposal stored, file NOT written;
 *   4. single-pending invariant → 'pending-exists';
 *   5. approve applies curated text AND preserves the auto section;
 *   6. staleness — manual curated edit after drafting supersedes the
 *      proposal instead of clobbering the edit;
 *   7. reject resolves without writing;
 *   8. cadence — a resolved proposal blocks redrafting for 7 days;
 *   9. heading-mismatch output → 'invalid-output', nothing stored.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-identity-evolution-test-'));
process.env.CLEMENTINE_HOME = TMP;

const {
  maybeProposeIdentityUpdate, approveIdentityProposal, rejectIdentityProposal,
  listIdentityProposals, setIdentityDistillerForTest,
} = await import('./identity-evolution.js');
const { rememberFact, setFactPinned } = await import('./facts.js');
const { openMemoryDb } = await import('./db.js');
const { IDENTITY_FILE } = await import('./vault.js');

/** Seed a pinned durable fact whose created_at lands at `when`, so the
 *  "new evidence since the last proposal" gate can be exercised at
 *  simulated future times. */
function seedDurableFactAt(content: string, when: Date): void {
  const fact = rememberFact({ kind: 'user', content });
  setFactPinned(fact.id, true);
  openMemoryDb().prepare('UPDATE consolidated_facts SET created_at = ? WHERE id = ?').run(when.toISOString(), fact.id);
}

const SEED_CURATED = [
  '# Identity',
  '',
  'I am Clementine — a personal executive assistant.',
].join('\n');
const AUTO_MARKER = '<!-- AUTO-GENERATED · do not edit below this line — overwritten on next refresh -->';
const SEED_FILE = `${SEED_CURATED}\n\n${AUTO_MARKER}\n\n## Working with\n- **Name:** Alex\n`;

mkdirSync(path.dirname(IDENTITY_FILE), { recursive: true });
writeFileSync(IDENTITY_FILE, SEED_FILE, 'utf-8');

const PROPOSED = [
  '# Identity',
  '',
  'I am Clementine — Alex\'s executive assistant, focused on their sales pipeline.',
].join('\n');

function stubDistiller(output: { proposedText: string; rationale: string } | null) {
  setIdentityDistillerForTest(async () => output);
}

test('kill switch: CLEMMY_IDENTITY_EVOLUTION=0 skips entirely', async () => {
  process.env.CLEMMY_IDENTITY_EVOLUTION = '0';
  const result = await maybeProposeIdentityUpdate();
  assert.equal(result.reason, 'disabled');
  delete process.env.CLEMMY_IDENTITY_EVOLUTION;
});

test('evidence gate: fewer than 5 durable facts skips', async () => {
  stubDistiller({ proposedText: PROPOSED, rationale: 'x' });
  const fact = rememberFact({ kind: 'user', content: 'Works in enterprise sales' });
  setFactPinned(fact.id, true);
  const result = await maybeProposeIdentityUpdate();
  assert.equal(result.reason, 'not-enough-evidence');
});

test('draft path: stores a pending proposal without touching the file', async () => {
  for (const content of [
    'Runs the northeast sales region',
    'Weekly pipeline review is Monday 9am',
    'Prefers Slack over email internally',
    'Biggest account is Meridian Health',
  ]) {
    const fact = rememberFact({ kind: 'user', content });
    setFactPinned(fact.id, true);
  }
  stubDistiller({ proposedText: PROPOSED, rationale: 'Folded in the sales-role facts.' });
  const result = await maybeProposeIdentityUpdate();
  assert.equal(result.reason, 'drafted');
  assert.ok(result.proposalId);

  const pending = listIdentityProposals('pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].target, 'identity');
  assert.equal(pending[0].rationale, 'Folded in the sales-role facts.');
  // Proposal time never writes the target file.
  assert.equal(readFileSync(IDENTITY_FILE, 'utf-8'), SEED_FILE);
});

test('single-pending invariant: a second draft attempt is blocked', async () => {
  stubDistiller({ proposedText: PROPOSED, rationale: 'y' });
  const result = await maybeProposeIdentityUpdate();
  assert.equal(result.reason, 'pending-exists');
});

test('approve applies curated text and preserves the auto section', () => {
  const [pending] = listIdentityProposals('pending');
  const result = approveIdentityProposal(pending.id);
  assert.equal(result.applied, true);
  const body = readFileSync(IDENTITY_FILE, 'utf-8');
  assert.match(body, /focused on their sales pipeline/);
  assert.match(body, /AUTO-GENERATED/);
  assert.match(body, /\*\*Name:\*\* Alex/);
  assert.doesNotMatch(body, /a personal executive assistant\./);
  assert.equal(listIdentityProposals('pending').length, 0);
  // Double-approve is a no-op.
  assert.equal(approveIdentityProposal(pending.id).reason, 'not-pending');
});

test('cadence: a resolved proposal blocks redrafting for 7 days', async () => {
  stubDistiller({ proposedText: PROPOSED, rationale: 'z' });
  const result = await maybeProposeIdentityUpdate();
  assert.equal(result.reason, 'too-soon');
  // 8 days later the cadence gate opens again (evidence gate now applies).
  const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
  const reopened = await maybeProposeIdentityUpdate(later);
  assert.notEqual(reopened.reason, 'too-soon');
});

test('staleness: manual curated edit after drafting supersedes the proposal', async () => {
  // Open the cadence gate and draft against the CURRENT curated text.
  const later = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000);
  for (const content of ['Territory expanded to mid-Atlantic', 'New quota cycle starts in August', 'Uses Salesforce as the CRM of record', 'Discovery calls run 25 minutes', 'Reports to a VP named for the region']) {
    const fact = rememberFact({ kind: 'user', content });
    setFactPinned(fact.id, true);
  }
  stubDistiller({ proposedText: PROPOSED.replace('sales pipeline', 'expanded territory'), rationale: 'territory update' });
  const drafted = await maybeProposeIdentityUpdate(later);
  assert.equal(drafted.reason, 'drafted');

  // User edits the curated half before reviewing.
  const raw = readFileSync(IDENTITY_FILE, 'utf-8');
  const edited = raw.replace('executive assistant', 'chief-of-staff-style assistant');
  writeFileSync(IDENTITY_FILE, edited, 'utf-8');

  const result = approveIdentityProposal(drafted.proposalId!);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'stale');
  assert.equal(result.proposal?.status, 'superseded');
  // The user's edit survives untouched.
  assert.equal(readFileSync(IDENTITY_FILE, 'utf-8'), edited);
});

test('reject resolves a pending proposal without writing', async () => {
  const evenLater = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
  for (let i = 0; i < 5; i++) {
    seedDurableFactAt(`Post-supersede confirmed detail number ${i}`, new Date(evenLater.getTime() - 60 * 60 * 1000));
  }
  stubDistiller({ proposedText: PROPOSED, rationale: 'r' });
  const drafted = await maybeProposeIdentityUpdate(evenLater);
  assert.equal(drafted.reason, 'drafted');
  const before = readFileSync(IDENTITY_FILE, 'utf-8');
  assert.equal(rejectIdentityProposal(drafted.proposalId!), true);
  assert.equal(readFileSync(IDENTITY_FILE, 'utf-8'), before);
  assert.equal(listIdentityProposals('pending').length, 0);
  // Rejecting again is a no-op.
  assert.equal(rejectIdentityProposal(drafted.proposalId!), false);
});

test('heading-mismatch output is refused and nothing is stored', async () => {
  const evenLater = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
  for (let i = 0; i < 5; i++) {
    seedDurableFactAt(`Even-later confirmed detail number ${i}`, new Date(evenLater.getTime() - 60 * 60 * 1000));
  }
  stubDistiller({ proposedText: '# Soul\n\nWrong heading for identity target.', rationale: 'bad' });
  const result = await maybeProposeIdentityUpdate(evenLater);
  assert.equal(result.reason, 'invalid-output');
  assert.equal(listIdentityProposals('pending').length, 0);
});
