import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import Database from 'better-sqlite3';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-prospective-'));
process.env.CLEMENTINE_HOME = testHome;

const prospective = await import('./prospective-intentions.js');

after(() => {
  prospective.closeProspectiveIntentionsDbForTest();
  rmSync(testHome, { recursive: true, force: true });
  delete process.env.CLEMMY_PROSPECTIVE_MEMORY;
});

function timerDefinition(id: string, at: string, objective = 'Remind me to check the deployment') {
  return {
    id: prospective.prospectiveIntentionId('timer', id),
    sourceKind: 'timer' as const,
    sourceId: id,
    objective,
    trigger: { kind: 'time' as const, at },
    action: { kind: 'notify' as const, ref: id },
    risk: 'read' as const,
    approvalMode: 'none' as const,
  };
}

test('definition updates are versioned and cancellation prevents stale cues', () => {
  const firstDue = '2026-07-27T09:00:00.000Z';
  const secondDue = '2026-07-28T11:30:00.000Z';
  const created = prospective.upsertProspectiveIntention(
    timerDefinition('timer-versioned', firstDue),
    new Date('2026-07-26T12:00:00.000Z'),
  );
  assert.equal(created?.generation, 1);
  assert.equal(created?.status, 'active');
  assert.equal(created?.dueAt, firstDue);

  const unchanged = prospective.upsertProspectiveIntention(
    timerDefinition('timer-versioned', firstDue),
    new Date('2026-07-26T12:01:00.000Z'),
  );
  assert.equal(unchanged?.generation, 1);
  assert.equal(
    unchanged?.updatedAt,
    created?.updatedAt,
    'an unchanged source snapshot must not churn timestamps or acquire a write transaction',
  );

  const revised = prospective.upsertProspectiveIntention(
    timerDefinition('timer-versioned', secondDue),
    new Date('2026-07-26T12:02:00.000Z'),
  );
  assert.equal(revised?.generation, 2);
  assert.equal(revised?.dueAt, secondDue);
  assert.equal(
    prospective.activateDueProspectiveIntentions(new Date('2026-07-27T09:01:00.000Z'))
      .filter((result) => result.accepted).length,
    0,
    'the superseded time must not fire',
  );

  const cancelled = prospective.cancelProspectiveIntention(
    revised!.id,
    'user cancelled it',
    new Date('2026-07-27T10:00:00.000Z'),
  );
  assert.equal(cancelled?.status, 'cancelled');
  const staleCue = prospective.recordProspectiveCue(
    revised!.id,
    `time:${secondDue}`,
    {},
    new Date(secondDue),
  );
  assert.equal(staleCue.accepted, false);
  assert.equal(staleCue.intention?.status, 'cancelled');
});

test('time cues are not early, are deduped, and complete through a claim', () => {
  const at = '2026-07-27T09:00:00.000Z';
  const intention = prospective.upsertProspectiveIntention(timerDefinition('timer-claim', at));
  assert.ok(intention);

  assert.equal(
    prospective.activateDueProspectiveIntentions(new Date('2026-07-27T08:59:59.000Z'))
      .some((result) => result.accepted),
    false,
  );
  const due = prospective.activateDueProspectiveIntentions(new Date(at))
    .find((result) => result.intention?.id === intention!.id);
  assert.equal(due?.accepted, true);
  assert.equal(due?.intention?.status, 'due');

  const duplicate = prospective.recordProspectiveCue(
    intention!.id,
    `time:${at}`,
    {},
    new Date('2026-07-27T09:00:01.000Z'),
  );
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.deduped, true);

  const claimed = prospective.claimProspectiveIntention(
    intention!.id,
    `time:${at}`,
    'timer-daemon',
    new Date('2026-07-27T09:00:02.000Z'),
  );
  assert.equal(claimed?.status, 'claimed');
  const completed = prospective.recordProspectiveOutcome(
    intention!.id,
    'completed',
    { notificationId: 'timer-fired-timer-claim' },
    new Date('2026-07-27T09:00:03.000Z'),
  );
  assert.equal(completed?.status, 'completed');
});

test('event subscriptions filter, dedupe, and re-arm without granting action authority', () => {
  const id = prospective.prospectiveIntentionId('workflow_event', 'system_event:lead-vip');
  prospective.upsertProspectiveIntention({
    id,
    sourceKind: 'workflow_event',
    sourceId: 'system_event:lead-vip',
    objective: 'Run the VIP lead workflow when a qualifying lead arrives',
    trigger: { kind: 'event', eventType: 'crm.lead.created', filter: { tier: 'vip' } },
    action: { kind: 'run_workflow', ref: 'vip-lead-followup' },
    workflowName: 'vip-lead-followup',
    risk: 'send',
    approvalMode: 'enforce_at_action',
    recurring: true,
  });

  assert.equal(prospective.recordProspectiveEvent('crm.lead.created', { id: 'L-1', tier: 'standard' }).length, 0);
  const matched = prospective.recordProspectiveEvent(
    'crm.lead.created',
    { id: 'L-2', tier: 'vip' },
    { cueKey: 'lead:L-2', now: new Date('2026-07-27T10:00:00.000Z') },
  );
  assert.equal(matched.length, 1);
  assert.equal(matched[0].accepted, true);
  assert.equal(matched[0].intention?.approvalMode, 'enforce_at_action');

  const rearmed = prospective.recordProspectiveOutcome(
    id,
    'completed',
    { runId: 'run-L-2', verified: true },
    new Date('2026-07-27T10:01:00.000Z'),
  );
  assert.equal(rearmed?.status, 'active', 'recurring subscriptions re-arm after an occurrence');

  const duplicate = prospective.recordProspectiveEvent(
    'crm.lead.created',
    { id: 'L-2', tier: 'vip' },
    { cueKey: 'lead:L-2', now: new Date('2026-07-27T10:02:00.000Z') },
  );
  assert.equal(duplicate[0].deduped, true);
});

test('cue history fingerprints payloads without duplicating raw webhook or event data', () => {
  const id = prospective.prospectiveIntentionId('workflow_event', 'privacy-proof');
  prospective.upsertProspectiveIntention({
    id,
    sourceKind: 'workflow_event',
    sourceId: 'privacy-proof',
    objective: 'Run the privacy-safe event workflow',
    trigger: { kind: 'event', eventType: 'private.event' },
    action: { kind: 'run_workflow', ref: 'privacy-proof' },
    risk: 'read',
    approvalMode: 'none',
    recurring: true,
  });
  const secret = 'private-customer-token-never-copy-me';
  prospective.recordProspectiveEvent(
    'private.event',
    { customer: 'Acme', token: secret },
    { cueKey: 'private:event:1' },
  );

  const database = new Database(path.join(testHome, 'state', 'prospective-intentions.db'), {
    readonly: true,
  });
  try {
    const row = database.prepare(`
      SELECT payload_json AS payload
      FROM prospective_intention_events
      WHERE intention_id = ? AND event_type = 'cue'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(id) as { payload?: string } | undefined;
    assert.ok(row?.payload);
    assert.doesNotMatch(row.payload, new RegExp(secret));
    assert.match(row.payload, /sha256/);
    assert.match(row.payload, /customer/);
    assert.match(row.payload, /token/);
  } finally {
    database.close();
  }
});

test('reconciliation cancels removed source definitions but preserves terminal history', () => {
  prospective.reconcileProspectiveIntentions('monitor', [
    {
      id: prospective.prospectiveIntentionId('monitor', 'inbox'),
      sourceKind: 'monitor',
      sourceId: 'inbox',
      objective: 'Watch connected inboxes for messages that need the user',
      trigger: { kind: 'state', channel: 'inbox', intervalMs: 15 * 60_000 },
      action: { kind: 'observe', ref: 'inbox-monitor' },
      risk: 'read',
      approvalMode: 'none',
      recurring: true,
    },
    {
      id: prospective.prospectiveIntentionId('monitor', 'calendar'),
      sourceKind: 'monitor',
      sourceId: 'calendar',
      objective: 'Watch calendars for conflicts and unanswered invitations',
      trigger: { kind: 'state', channel: 'calendar', intervalMs: 30 * 60_000 },
      action: { kind: 'observe', ref: 'calendar-monitor' },
      risk: 'read',
      approvalMode: 'none',
      recurring: true,
    },
  ]);
  const reconciled = prospective.reconcileProspectiveIntentions('monitor', [
    {
      id: prospective.prospectiveIntentionId('monitor', 'calendar'),
      sourceKind: 'monitor',
      sourceId: 'calendar',
      objective: 'Watch calendars for conflicts and unanswered invitations',
      trigger: { kind: 'state', channel: 'calendar', intervalMs: 30 * 60_000 },
      action: { kind: 'observe', ref: 'calendar-monitor' },
      risk: 'read',
      approvalMode: 'none',
      recurring: true,
    },
  ]);
  assert.equal(reconciled.cancelled, 1);
  assert.equal(
    prospective.getProspectiveIntention(prospective.prospectiveIntentionId('monitor', 'inbox'))?.status,
    'cancelled',
  );
  assert.equal(
    prospective.getProspectiveIntention(prospective.prospectiveIntentionId('monitor', 'calendar'))?.status,
    'active',
  );
});

test('model context is relevance-scoped, session-aware, and bounded', () => {
  const beforeEitherReminderIsDue = new Date('2026-07-28T12:00:00.000Z');
  prospective.upsertProspectiveIntention({
    ...timerDefinition('deploy-reminder', '2026-07-29T17:00:00.000Z', 'Check the Railway deployment'),
    sessionId: 'sess-deploy',
  });
  prospective.upsertProspectiveIntention({
    ...timerDefinition('dentist-reminder', '2026-07-30T17:00:00.000Z', 'Call the dentist'),
    sessionId: 'sess-personal',
  });

  const unrelated = prospective.buildProspectiveIntentionContext({
    query: 'Explain how CSS grid works',
    sessionId: 'sess-other',
    now: beforeEitherReminderIsDue,
  });
  assert.equal(unrelated.text, '', 'global commitments must not tax unrelated turns');

  const unrelatedSameSession = prospective.buildProspectiveIntentionContext({
    query: 'Explain how CSS grid works',
    sessionId: 'sess-deploy',
    now: beforeEitherReminderIsDue,
  });
  assert.equal(
    unrelatedSameSession.text,
    '',
    'sharing a session is context, not enough relevance to impose a permanent prompt tax',
  );

  const scoped = prospective.buildProspectiveIntentionContext({
    query: 'What is next with the deployment?',
    sessionId: 'sess-deploy',
    maxChars: 900,
    now: beforeEitherReminderIsDue,
  });
  assert.match(scoped.text, /Railway deployment/);
  assert.doesNotMatch(scoped.text, /dentist/i);
  assert.ok(scoped.bytes <= 900);

  const overview = prospective.buildProspectiveIntentionContext({
    query: 'What reminders and upcoming commitments do I have?',
    maxChars: 1_400,
    now: beforeEitherReminderIsDue,
  });
  assert.match(overview.text, /Railway deployment/);
  assert.match(overview.text, /dentist/i);
  assert.match(overview.text, /cue is not permission/i);
});

test('generic execution vocabulary does not recall unrelated future intentions', () => {
  const id = prospective.prospectiveIntentionId('timer', 'salesforce-snapshot');
  prospective.upsertProspectiveIntention({
    ...timerDefinition(
      'salesforce-snapshot',
      '2026-08-03T17:00:00.000Z',
      'Run the weekly Salesforce snapshot task',
    ),
    sessionId: 'sess-salesforce',
  });
  try {
    const unrelated = prospective.buildProspectiveIntentionContext({
      query: 'Run one task per worker in parallel and return each output.',
      sessionId: 'sess-other',
    });
    assert.equal(
      unrelated.text,
      '',
      'shared harness verbs are not durable-memory relevance',
    );

    const relevant = prospective.buildProspectiveIntentionContext({
      query: 'What is next with the Salesforce snapshot?',
      sessionId: 'sess-other',
    });
    assert.match(relevant.text, /weekly Salesforce snapshot task/);
  } finally {
    prospective.cancelProspectiveIntention(id, 'test_cleanup');
  }
});

test('read-back validation does not recall unrelated due report-back commitments', () => {
  const id = prospective.prospectiveIntentionId('timer', 'background-seo-reportback');
  prospective.upsertProspectiveIntention({
    ...timerDefinition(
      'background-seo-reportback',
      '2020-01-01T00:00:00.000Z',
      'Report back when the background task completes: pull the deep SEO rankings',
    ),
    sessionId: 'sess-old-background',
  });
  try {
    const unrelated = prospective.buildProspectiveIntentionContext({
      query: 'Create a disposable Google Sheet, write the exact matrix, and read back every cell.',
      sessionId: 'sess-sheet-proof',
      now: new Date('2026-07-27T12:00:00.000Z'),
    });
    assert.equal(
      unrelated.text,
      '',
      '"read back" is validation vocabulary, not a cue for every old "report back" intention',
    );
  } finally {
    prospective.cancelProspectiveIntention(id, 'test_cleanup');
  }
});

test('blocked time commitments stay blocked until their source is explicitly resumed', () => {
  const at = '2026-07-27T09:00:00.000Z';
  const intention = prospective.upsertProspectiveIntention(
    timerDefinition('timer-blocked', at, 'Wait for the deployment credential'),
  );
  prospective.recordProspectiveOutcome(
    intention!.id,
    'blocked',
    { reason: 'credential_missing' },
    new Date('2026-07-27T08:30:00.000Z'),
  );
  const activated = prospective.activateDueProspectiveIntentions(new Date('2026-07-27T10:00:00.000Z'));
  assert.equal(
    activated.some((result) => result.intention?.id === intention!.id && result.accepted),
    false,
  );
  assert.equal(prospective.getProspectiveIntention(intention!.id)?.status, 'blocked');
});

test('status and source filters are applied before limits, and counts include terminal history', () => {
  for (let index = 0; index < 12; index += 1) {
    const created = prospective.upsertProspectiveIntention({
      id: prospective.prospectiveIntentionId('monitor', `history-${index}`),
      sourceKind: 'monitor',
      sourceId: `history-${index}`,
      objective: `Historical monitor ${index}`,
      trigger: { kind: 'state', channel: `history-${index}` },
      action: { kind: 'observe', ref: `history-${index}` },
      sessionId: 'filter-proof',
      risk: 'read',
      approvalMode: 'none',
      recurring: false,
    });
    prospective.recordProspectiveOutcome(created!.id, 'completed', { index });
  }
  prospective.upsertProspectiveIntention({
    id: prospective.prospectiveIntentionId('monitor', 'limit-proof'),
    sourceKind: 'monitor',
    sourceId: 'limit-proof',
    objective: 'Watch the proof channel',
    trigger: { kind: 'state', channel: 'proof' },
    action: { kind: 'observe', ref: 'limit-proof' },
    sessionId: 'filter-proof',
    risk: 'read',
    approvalMode: 'none',
    recurring: true,
  });

  const activeMonitors = prospective.listProspectiveIntentions({
    statuses: ['active'],
    sourceKind: 'monitor',
    sessionId: 'filter-proof',
    limit: 1,
  });
  assert.equal(activeMonitors.length, 1);
  assert.equal(activeMonitors[0]?.sourceId, 'limit-proof');
  const counts = prospective.countProspectiveIntentions();
  assert.ok(counts.completed >= 12);
  assert.ok(counts.total > 12);
});

test('capture directive fires only for concrete future commitments', () => {
  assert.match(
    prospective.prospectiveCaptureDirective('Remind me tomorrow to review the proposal') ?? '',
    /Persist it/,
  );
  assert.match(
    prospective.prospectiveCaptureDirective('Keep an eye on the inbox and tell me if Acme replies') ?? '',
    /future cue/,
  );
  assert.equal(
    prospective.prospectiveCaptureDirective('If CSS grid has three columns, how wide is each one?'),
    null,
  );
  assert.equal(prospective.prospectiveCaptureDirective('Tell me how reminders work'), null);
  assert.equal(
    prospective.prospectiveCaptureDirective('How should I automate a daily research digest?'),
    null,
    'discussion about future automation is not authorization to create one',
  );
});

test('PM-Bench-style sequence handles reschedule, cancellation, distractors, and hidden event cues', () => {
  const medicationId = prospective.prospectiveIntentionId('timer', 'medication');
  const appointmentId = prospective.prospectiveIntentionId('workflow_event', 'appointment-slot');
  prospective.upsertProspectiveIntention({
    ...timerDefinition('medication', '2026-07-28T21:00:00.000Z', 'Take evening medication'),
    id: medicationId,
  });
  prospective.upsertProspectiveIntention({
    id: appointmentId,
    sourceKind: 'workflow_event',
    sourceId: 'appointment-slot',
    objective: 'Book the appointment when Dr. Rivera has an opening',
    trigger: {
      kind: 'event',
      eventType: 'calendar.slot.opened',
      filter: { doctor: 'Rivera' },
    },
    action: { kind: 'run_workflow', ref: 'book-appointment' },
    risk: 'write',
    approvalMode: 'enforce_at_action',
    recurring: false,
  });

  // Reschedule the medication before its original cue.
  prospective.upsertProspectiveIntention({
    ...timerDefinition('medication', '2026-07-28T22:00:00.000Z', 'Take evening medication'),
    id: medicationId,
  });
  assert.equal(
    prospective.activateDueProspectiveIntentions(new Date('2026-07-28T21:00:00.000Z'))
      .filter((result) => result.accepted).length,
    0,
  );
  const medicationDue = prospective.activateDueProspectiveIntentions(new Date('2026-07-28T22:00:00.000Z'))
    .find((result) => result.intention?.id === medicationId);
  assert.equal(medicationDue?.accepted, true);

  // Distractor and wrong-doctor events must not create false-positive actions.
  assert.equal(prospective.recordProspectiveEvent('email.received', { from: 'newsletter' }).length, 0);
  assert.equal(
    prospective.recordProspectiveEvent('calendar.slot.opened', { doctor: 'Morgan' }).length,
    0,
  );
  const slot = prospective.recordProspectiveEvent(
    'calendar.slot.opened',
    { doctor: 'Rivera', slotId: 'S-42' },
    { cueKey: 'slot:S-42' },
  );
  assert.equal(slot.length, 1);
  assert.equal(slot[0].accepted, true);

  prospective.cancelProspectiveIntention(appointmentId, 'user booked elsewhere');
  const afterCancellation = prospective.recordProspectiveEvent(
    'calendar.slot.opened',
    { doctor: 'Rivera', slotId: 'S-43' },
    { cueKey: 'slot:S-43' },
  );
  assert.equal(afterCancellation.length, 0);
});
