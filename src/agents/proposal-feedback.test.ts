/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-feedback npx tsx --test src/agents/proposal-feedback.test.ts
 *
 * Covers the proposal learning loop:
 *   - aggregator collects approved + rejected within window
 *   - older proposals outside the window are dropped
 *   - approval `overrides` captured as appliedEdits and counted
 *   - renderer returns '' on no signal
 *   - renderer surfaces approved, rejected (with reasons), edits
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const TEST_HOME = '/tmp/clemmy-test-feedback';
process.env.CLEMENTINE_HOME = TEST_HOME;

const PROPOSALS_DIR = path.join(TEST_HOME, 'state', 'check-in-proposals');

const {
  proposeCheckInTemplate,
  approveProposal,
  rejectProposal,
} = await import('./check-in-proposals.js');

const { getProposalFeedback, renderProposalFeedback } = await import('./proposal-feedback.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME + '/state', { recursive: true });
});

beforeEach(() => {
  rmSync(PROPOSALS_DIR, { recursive: true, force: true });
  rmSync(TEST_HOME + '/state/check-in-templates', { recursive: true, force: true });
  rmSync(TEST_HOME + '/state/check-in-templates-state.json', { force: true });
});

function backdateProposal(id: string, resolvedDaysAgo: number): void {
  const filePath = path.join(PROPOSALS_DIR, `${id}.json`);
  const record = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  const ts = new Date(Date.now() - resolvedDaysAgo * 24 * 60 * 60 * 1000).toISOString();
  record.resolvedAt = ts;
  record.proposedAt = ts;
  writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
}

function propose(name: string) {
  return proposeCheckInTemplate({
    name,
    trigger: 'schedule',
    schedule: '0 9 * * 1',
    questionTemplate: 'How is the week shaping up?',
    rationale: 'A weekly rhythm worth surfacing.',
  });
}

// ─── empty state ───────────────────────────────────────────────

test('getProposalFeedback: empty when no resolved proposals', () => {
  const f = getProposalFeedback();
  assert.equal(f.totalApproved, 0);
  assert.equal(f.totalRejected, 0);
  assert.deepEqual(f.approvedSamples, []);
  assert.deepEqual(f.rejectedSamples, []);
});

test('renderProposalFeedback: empty signal returns empty string', () => {
  assert.equal(renderProposalFeedback(getProposalFeedback()), '');
});

// ─── basic aggregation ─────────────────────────────────────────

test('getProposalFeedback: counts approved + rejected within window', () => {
  const a = propose('Mon standup');
  approveProposal(a.id);
  const b = propose('Hourly inbox poke');
  rejectProposal(b.id, 'way too frequent');
  const c = propose('Friday deploy retro');
  approveProposal(c.id);

  const f = getProposalFeedback();
  assert.equal(f.totalApproved, 2);
  assert.equal(f.totalRejected, 1);
  assert.equal(f.approvedTriggerCounts.schedule, 2);
  assert.equal(f.rejectedTriggerCounts.schedule, 1);
  assert.equal(f.rejectedSamples[0].reason, 'way too frequent');
});

// ─── windowing ─────────────────────────────────────────────────

test('getProposalFeedback: drops resolutions older than the window', () => {
  const fresh = propose('Recent approve');
  approveProposal(fresh.id);
  const old = propose('Old reject');
  rejectProposal(old.id, 'stale');
  backdateProposal(old.id, 90); // 3 months ago, default window is 30 days

  const f = getProposalFeedback({ windowDays: 30 });
  assert.equal(f.totalApproved, 1);
  assert.equal(f.totalRejected, 0, 'old rejection should fall outside window');
  // Widening the window should pick the old one back up.
  const wide = getProposalFeedback({ windowDays: 365 });
  assert.equal(wide.totalRejected, 1);
});

// ─── appliedEdits / commonEdits ────────────────────────────────

test('approveProposal: records appliedEdits when overrides differ from proposal', () => {
  const p = propose('Original wording');
  approveProposal(p.id, { overrides: { schedule: '0 10 * * 1', cooldownHours: 4 } });
  const f = getProposalFeedback();
  assert.equal(f.totalApproved, 1);
  const sample = f.approvedSamples[0];
  assert.ok(sample.appliedEdits);
  assert.equal(sample.appliedEdits.schedule, '0 10 * * 1');
  assert.equal(sample.appliedEdits.cooldownHours, 4);
  assert.equal(f.commonEdits.schedule, 1);
  assert.equal(f.commonEdits.cooldownHours, 1);
});

test('approveProposal: no appliedEdits when overrides match proposal exactly', () => {
  const p = propose('No edits');
  approveProposal(p.id, { overrides: { schedule: '0 9 * * 1' } });
  const f = getProposalFeedback();
  const sample = f.approvedSamples[0];
  assert.equal(sample.appliedEdits, undefined, 'override that matches original should not count as an edit');
  assert.deepEqual(f.commonEdits, {});
});

test('getProposalFeedback: commonEdits ranks fields across multiple approvals', () => {
  const a = propose('First weekly');
  approveProposal(a.id, { overrides: { schedule: '0 10 * * 1' } });
  const b = propose('Second weekly');
  approveProposal(b.id, { overrides: { schedule: '0 11 * * 1', cooldownHours: 4 } });
  const c = propose('Third weekly');
  approveProposal(c.id, { overrides: { schedule: '0 12 * * 1' } });

  const f = getProposalFeedback();
  assert.equal(f.commonEdits.schedule, 3);
  assert.equal(f.commonEdits.cooldownHours, 1);
});

// ─── renderer ──────────────────────────────────────────────────

test('renderProposalFeedback: surfaces approved + rejected + edits', () => {
  const a = propose('Weekly retro');
  approveProposal(a.id);
  const b = propose('Inbox spam');
  rejectProposal(b.id, 'too noisy');
  const c = propose('Schedule edit');
  approveProposal(c.id, { overrides: { schedule: '0 10 * * 1' } });

  const out = renderProposalFeedback(getProposalFeedback());
  assert.match(out, /PROPOSAL FEEDBACK/);
  assert.match(out, /Approved \(2\)/);
  assert.match(out, /Rejected \(1\)/);
  assert.match(out, /Weekly retro/);
  assert.match(out, /Inbox spam/);
  assert.match(out, /too noisy/);
  assert.match(out, /Schedule edit/);
  assert.match(out, /Fields the user often edits/);
  assert.match(out, /schedule/);
});

test('renderProposalFeedback: skips edits section when no edits recorded', () => {
  const a = propose('Approved no edits');
  approveProposal(a.id);
  const out = renderProposalFeedback(getProposalFeedback());
  assert.match(out, /Approved \(1\)/);
  assert.doesNotMatch(out, /Fields the user often edits/);
});
