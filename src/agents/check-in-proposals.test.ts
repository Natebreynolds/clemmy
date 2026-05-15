/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-proposals npx tsx --test src/agents/check-in-proposals.test.ts
 *
 * Covers the proposal lifecycle:
 *   - propose (validation + write + notify)
 *   - list (filter by status)
 *   - approve (with and without overrides, default-enabled)
 *   - reject (with reason)
 *   - delete (idempotent)
 *   - edit-flow (propose + approve against existing template)
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-proposals';
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  proposeCheckInTemplate,
  proposeTemplateEdit,
  approveProposal,
  approveEditProposal,
  rejectProposal,
  deleteProposal,
  getProposal,
  listProposals,
} = await import('./check-in-proposals.js');

const { createCheckInTemplate, getCheckInTemplate, listCheckInTemplates } = await import('./check-in-templates.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME + '/state', { recursive: true });
});

beforeEach(() => {
  rmSync(TEST_HOME + '/state/check-in-proposals', { recursive: true, force: true });
  rmSync(TEST_HOME + '/state/check-in-templates', { recursive: true, force: true });
  rmSync(TEST_HOME + '/state/check-in-templates-state.json', { force: true });
});

// ─── propose ───────────────────────────────────────────────────

test('proposeCheckInTemplate: writes a pending proposal with defaults', () => {
  const p = proposeCheckInTemplate({
    name: 'Friday deploy retro',
    trigger: 'schedule',
    schedule: '0 17 * * 5',
    questionTemplate: 'How did this week\'s deploy go?',
    rationale: 'User mentioned shipping every Friday three times this week.',
  });
  assert.match(p.id, /^prop-/);
  assert.equal(p.status, 'pending');
  assert.equal(p.urgency, 'normal');
  assert.equal(p.cooldownHours, 1, 'schedule default cooldown is 1h');
  assert.equal(p.agentSlug, 'clementine');
  assert.equal(p.proposedByAgent, 'clementine');
  assert.equal(p.schedule, '0 17 * * 5');
});

test('proposeCheckInTemplate: rejects too-short rationale', () => {
  assert.throws(() =>
    proposeCheckInTemplate({
      name: 'Long enough name',
      trigger: 'schedule',
      schedule: '* * * * *',
      questionTemplate: 'long enough question',
      rationale: 'why',
    }),
    /rationale required/,
  );
});

test('proposeCheckInTemplate: rejects malformed cron for schedule trigger', () => {
  assert.throws(() =>
    proposeCheckInTemplate({
      name: 'name long enough',
      trigger: 'schedule',
      schedule: 'not a cron',
      questionTemplate: 'long enough question',
      rationale: 'pattern observed across many weeks',
    }),
    /5-field cron/,
  );
});

test('proposeCheckInTemplate: rejects too-short name + question', () => {
  assert.throws(() =>
    proposeCheckInTemplate({
      name: 'AB',
      trigger: 'execution_blocked',
      questionTemplate: 'long enough question',
      rationale: 'pattern observed across many weeks',
    }),
    /name required/,
  );
  assert.throws(() =>
    proposeCheckInTemplate({
      name: 'enough chars',
      trigger: 'execution_blocked',
      questionTemplate: 'short',
      rationale: 'pattern observed across many weeks',
    }),
    /questionTemplate required/,
  );
});

test('proposeCheckInTemplate: condition triggers carry their default thresholds', () => {
  const blocked = proposeCheckInTemplate({
    name: 'Stuck nudge',
    trigger: 'execution_blocked',
    questionTemplate: 'A blocked exec needs you.',
    rationale: 'You leave executions blocked for days at a time.',
  });
  assert.equal(blocked.blockedHours, 24);
  assert.equal(blocked.schedule, undefined);
  const stale = proposeCheckInTemplate({
    name: 'Stale goal nudge',
    trigger: 'goal_stale',
    questionTemplate: 'A goal has gone stale.',
    rationale: 'Goals frequently sit idle for a week.',
  });
  assert.equal(stale.staleDays, 7);
});

// ─── list / get ────────────────────────────────────────────────

test('listProposals: defaults to pending and sorts newest first', async () => {
  const a = proposeCheckInTemplate({
    name: 'First proposal',
    trigger: 'schedule',
    schedule: '* * * * *',
    questionTemplate: 'long enough A',
    rationale: 'rationale A long enough',
  });
  await new Promise((r) => setTimeout(r, 5));
  const b = proposeCheckInTemplate({
    name: 'Second proposal',
    trigger: 'schedule',
    schedule: '* * * * *',
    questionTemplate: 'long enough B',
    rationale: 'rationale B long enough',
  });
  const pending = listProposals();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].id, b.id, 'newest first');
  assert.equal(pending[1].id, a.id);
});

test('listProposals: status=all returns approved and rejected too', () => {
  const a = proposeCheckInTemplate({
    name: 'Reject me proposal',
    trigger: 'schedule',
    schedule: '* * * * *',
    questionTemplate: 'long enough A',
    rationale: 'rationale A long enough',
  });
  rejectProposal(a.id, 'not useful');
  const onlyPending = listProposals();
  assert.equal(onlyPending.length, 0);
  const allP = listProposals({ status: 'all' });
  assert.equal(allP.length, 1);
  assert.equal(allP[0].status, 'rejected');
});

test('getProposal: returns null for unknown ids', () => {
  assert.equal(getProposal('prop-nonexistent'), null);
});

// ─── approve ───────────────────────────────────────────────────

test('approveProposal: promotes to active CheckInTemplate (enabled by default)', () => {
  const p = proposeCheckInTemplate({
    name: 'Mon 9am standup',
    trigger: 'schedule',
    schedule: '0 9 * * 1',
    questionTemplate: 'What is on your plate this week?',
    rationale: 'You mentioned weekly standups several times.',
  });
  const out = approveProposal(p.id);
  assert.ok(out);
  assert.equal(out.proposal.status, 'approved');
  assert.equal(out.proposal.resolvedTemplateId, out.template.id);
  assert.equal(out.template.enabled, true, 'default enabledOnInstall=true');
  assert.equal(out.template.name, 'Mon 9am standup');
  // Live template should be in the active library.
  const found = getCheckInTemplate(out.template.id);
  assert.ok(found);
});

test('approveProposal: respects enabledOnInstall=false and overrides', () => {
  const p = proposeCheckInTemplate({
    name: 'Original name',
    trigger: 'schedule',
    schedule: '0 9 * * 1',
    questionTemplate: 'Original question template',
    rationale: 'Some recurring rhythm worth tracking.',
  });
  const out = approveProposal(p.id, {
    enabledOnInstall: false,
    overrides: { name: 'Refined name', schedule: '0 10 * * 1', cooldownHours: 4 },
  });
  assert.ok(out);
  assert.equal(out.template.enabled, false);
  assert.equal(out.template.name, 'Refined name');
  assert.equal(out.template.schedule, '0 10 * * 1');
  assert.equal(out.template.cooldownHours, 4);
});

test('approveProposal: returns null on unknown id and on already-resolved', () => {
  assert.equal(approveProposal('prop-nope'), null);
  const p = proposeCheckInTemplate({
    name: 'Once',
    trigger: 'schedule',
    schedule: '* * * * *',
    questionTemplate: 'long enough question',
    rationale: 'rationale long enough text',
  });
  rejectProposal(p.id);
  assert.equal(approveProposal(p.id), null, 'cannot approve a rejected proposal');
});

// ─── reject / delete ───────────────────────────────────────────

test('rejectProposal: records reason and marks resolved', () => {
  const p = proposeCheckInTemplate({
    name: 'Bad idea',
    trigger: 'schedule',
    schedule: '* * * * *',
    questionTemplate: 'long enough question',
    rationale: 'rationale long enough text',
  });
  const rejected = rejectProposal(p.id, 'Too noisy.');
  assert.ok(rejected);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.rejectionReason, 'Too noisy.');
  assert.equal(rejected.resolvedBy, 'user');
});

test('rejectProposal: trims empty reason to undefined', () => {
  const p = proposeCheckInTemplate({
    name: 'Whatever',
    trigger: 'schedule',
    schedule: '* * * * *',
    questionTemplate: 'long enough question',
    rationale: 'rationale long enough text',
  });
  const rejected = rejectProposal(p.id, '   ');
  assert.ok(rejected);
  assert.equal(rejected.rejectionReason, undefined);
});

test('deleteProposal: removes the file and is idempotent', () => {
  const p = proposeCheckInTemplate({
    name: 'Doomed',
    trigger: 'schedule',
    schedule: '* * * * *',
    questionTemplate: 'long enough question',
    rationale: 'rationale long enough text',
  });
  assert.equal(deleteProposal(p.id), true);
  assert.equal(getProposal(p.id), null);
  assert.equal(deleteProposal(p.id), false, 'second delete is a no-op');
});

// ─── edit-flow ─────────────────────────────────────────────────

test('proposeTemplateEdit + approveEditProposal: updates the target template in place', () => {
  // Create an existing live template the agent will suggest edits to.
  const live = createCheckInTemplate({
    name: 'Existing standup',
    trigger: 'schedule',
    schedule: '0 9 * * 1',
    questionTemplate: 'Old wording',
    enabled: true,
  });
  const beforeCount = listCheckInTemplates().length;

  const edit = proposeTemplateEdit({
    editsTemplateId: live.id,
    name: 'Existing standup',
    trigger: 'schedule',
    schedule: '0 10 * * 1',
    questionTemplate: 'Refreshed wording — what is on your plate?',
    rationale: 'You said you moved standups to 10am.',
  });
  assert.equal(edit.resolvedTemplateId, live.id);

  const out = approveEditProposal(edit.id);
  assert.ok(out);
  assert.equal(out.template.id, live.id, 'updates same template, not creating new');
  assert.equal(out.template.schedule, '0 10 * * 1');
  assert.equal(out.template.questionTemplate, 'Refreshed wording — what is on your plate?');
  assert.equal(listCheckInTemplates().length, beforeCount, 'no new template created');
});

test('approveEditProposal: returns null when target template no longer exists', () => {
  const edit = proposeTemplateEdit({
    editsTemplateId: 'tpl-nonexistent',
    name: 'Edit dangling target',
    trigger: 'schedule',
    schedule: '0 9 * * 1',
    questionTemplate: 'long enough question',
    rationale: 'rationale long enough text',
  });
  assert.equal(approveEditProposal(edit.id), null);
});
