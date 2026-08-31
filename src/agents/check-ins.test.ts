/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-checkins npx tsx --test src/agents/check-ins.test.ts
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TEST_HOME = '/tmp/clemmy-test-checkins';
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  CHECK_INS_DIR,
  answerCheckIn,
  answerCheckInCas,
  closeCheckIn,
  createCheckIn,
  deleteCheckIn,
  findOpenLinkedCheckIn,
  getCheckIn,
  listCheckIns,
  listOpenCheckIns,
  reconcileOpenLinkedCheckIns,
  repairLinkedCheckInAnswers,
  renderOpenCheckInsForAgent,
  validateCheckInQuestion,
} = await import('./check-ins.js');
const { listNotifications, listQueuedNotificationDeliveries } = await import('../runtime/notifications.js');
const {
  createBackgroundTask,
  getBackgroundTask,
  markBackgroundTaskAwaitingInput,
} = await import('../execution/background-tasks.js');
const CHECK_INS_MODULE_URL = new URL('./check-ins.ts', import.meta.url).href;

const INBOX_DIR = path.join(TEST_HOME, 'agents-inbox');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

beforeEach(() => {
  rmSync(CHECK_INS_DIR, { recursive: true, force: true });
  rmSync(INBOX_DIR, { recursive: true, force: true });
  rmSync(path.join(TEST_HOME, 'state', 'notifications.json'), { force: true });
  rmSync(path.join(TEST_HOME, 'state', 'notification-delivery-queue.json'), { force: true });
  rmSync(path.join(TEST_HOME, 'state', 'background-tasks'), { recursive: true, force: true });
});

test('createCheckIn writes an open record', () => {
  const rec = createCheckIn({
    agentSlug: 'clementine',
    question: 'Which Salesforce instance should I sync to?',
    urgency: 'high',
    contextSummary: 'Setting up the daily pipeline pull.',
  });
  assert.match(rec.id, /^chk-/);
  assert.equal(rec.status, 'open');
  assert.equal(rec.urgency, 'high');
  assert.equal(rec.agentSlug, 'clementine');
  assert.ok(rec.askedAt);
  // Persisted to disk
  assert.ok(existsSync(path.join(CHECK_INS_DIR, `${rec.id}.json`)));
});

test('createCheckIn projects an ordinary question notification, never an approval card', () => {
  const rec = createCheckIn({
    agentSlug: 'clementine',
    question: 'Which exact mailbox address should receive the finished report?',
  });
  const notification = listNotifications(10).find(
    (item) => item.metadata?.checkInId === rec.id,
  );
  assert.ok(notification, 'the question still reaches the notification inbox');
  assert.equal(notification.kind, 'execution');
  assert.equal(notification.metadata?.approvalId, undefined);
});

test('createCheckIn rejects empty question', () => {
  assert.throws(() => createCheckIn({ agentSlug: 'clementine', question: '   ' }));
});

test('createCheckIn rejects empty agent slug', () => {
  assert.throws(() => createCheckIn({ agentSlug: '', question: 'real question' }));
});

test('createCheckIn defaults urgency to normal', () => {
  const rec = createCheckIn({ agentSlug: 'a', question: 'how high should I jump' });
  assert.equal(rec.urgency, 'normal');
});

test('linked check-in mints and persists one immutable question generation', () => {
  const rec = createCheckIn({
    agentSlug: 'clementine',
    question: 'Which exact workspace should receive the report?',
    linkedTaskId: 'bg-linked-question',
  });
  assert.match(rec.linkedQuestionId ?? '', /^bgq-[A-Za-z0-9_-]+$/);
  assert.equal(getCheckIn(rec.id)?.linkedQuestionId, rec.linkedQuestionId);
  assert.equal(findOpenLinkedCheckIn('bg-linked-question', rec.question)?.id, rec.id);
  const notification = listNotifications(10).find((row) => row.metadata?.checkInId === rec.id);
  assert.equal(notification?.metadata?.linkedTaskId, 'bg-linked-question');
  assert.equal(notification?.metadata?.linkedQuestionId, rec.linkedQuestionId);
});

test('a sole stale linked Q1 is never adopted as a different Q2 generation', () => {
  const q1 = createCheckIn({
    agentSlug: 'clementine',
    question: 'Which exact workspace should receive the first report?',
    linkedTaskId: 'bg-question-advanced',
  });
  assert.equal(findOpenLinkedCheckIn('bg-question-advanced', q1.question)?.id, q1.id);
  assert.equal(
    findOpenLinkedCheckIn('bg-question-advanced', 'Which exact mailbox should receive the second report?'),
    null,
    'question text must match even when Q1 is the only open linked record',
  );
});

test('linkedQuestionId without a linkedTaskId is rejected', () => {
  assert.throws(() => createCheckIn({
    agentSlug: 'clementine',
    question: 'Which exact workspace should receive the report?',
    linkedQuestionId: 'orphan-question',
  }), /requires linkedTaskId/);
});

test('getCheckIn returns null for unknown id', () => {
  assert.equal(getCheckIn('chk-nope'), null);
});

test('listCheckIns defaults to open only, newest first', async () => {
  const a = createCheckIn({ agentSlug: 'x', question: 'first?' });
  // Force timestamps to differ
  await new Promise((r) => setTimeout(r, 10));
  const b = createCheckIn({ agentSlug: 'x', question: 'second?' });
  await new Promise((r) => setTimeout(r, 10));
  const c = createCheckIn({ agentSlug: 'x', question: 'third?' });
  closeCheckIn(b.id);

  const open = listOpenCheckIns();
  assert.equal(open.length, 2, `expected 2 open, got ${open.length}`);
  // Newest first
  assert.equal(open[0].id, c.id);
  assert.equal(open[1].id, a.id);
});

test('listCheckIns filters by agentSlug', () => {
  createCheckIn({ agentSlug: 'aaa', question: 'q1?' });
  createCheckIn({ agentSlug: 'bbb', question: 'q2?' });
  const aOnly = listOpenCheckIns('aaa');
  assert.equal(aOnly.length, 1);
  assert.equal(aOnly[0].agentSlug, 'aaa');
});

test('answerCheckIn transitions open → answered and enqueues inbox item', () => {
  const rec = createCheckIn({ agentSlug: 'researcher', question: 'which model?' });
  const answered = answerCheckIn(rec.id, 'gpt-4o-mini');
  assert.ok(answered);
  assert.equal(answered!.status, 'answered');
  assert.equal(answered!.answer, 'gpt-4o-mini');
  assert.ok(answered!.answeredAt);

  // Inbox should now have an item for researcher
  const inboxFile = path.join(INBOX_DIR, 'researcher.json');
  assert.ok(existsSync(inboxFile));
  const items = JSON.parse(readFileSync(inboxFile, 'utf-8')) as Array<{ type: string; sourceKey?: string; metadata?: { checkInId?: string } }>;
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'check_in_answered');
  assert.equal(items[0].metadata?.checkInId, rec.id);
});

test('answerCheckIn is a no-op when already answered', () => {
  const rec = createCheckIn({ agentSlug: 'a', question: 'q?' });
  const first = answerCheckIn(rec.id, 'first answer');
  const second = answerCheckIn(rec.id, 'second answer');
  assert.equal(first!.answer, 'first answer');
  assert.equal(second!.answer, 'first answer', 'second answer should not overwrite');
});

test('answerCheckInCas reports a typed stale result instead of overwriting', () => {
  const rec = createCheckIn({ agentSlug: 'a', question: 'Which account should receive the report?' });
  assert.equal(answerCheckInCas(rec.id, 'Company account').status, 'answered');
  const late = answerCheckInCas(rec.id, 'Personal account');
  assert.equal(late.status, 'stale');
  assert.equal(late.status === 'stale' ? late.record.answer : undefined, 'Company account');
});

test('answerCheckInCas refuses a stale linked Q1 expectation without consuming it', () => {
  const rec = createCheckIn({
    agentSlug: 'clementine',
    question: 'Should I use account A or account B?',
    linkedTaskId: 'bg-question-generations',
    linkedQuestionId: 'question-q1',
  });
  const stale = answerCheckInCas(rec.id, 'Account B', {
    linkedTaskId: 'bg-question-generations',
    linkedQuestionId: 'question-q2',
  });
  assert.equal(stale.status, 'stale_link');
  assert.equal(getCheckIn(rec.id)?.status, 'open');
  assert.equal(getCheckIn(rec.id)?.answer, undefined);

  const exact = answerCheckInCas(rec.id, 'Account A', {
    linkedTaskId: 'bg-question-generations',
    linkedQuestionId: 'question-q1',
  });
  assert.equal(exact.status, 'answered');
  assert.equal(getCheckIn(rec.id)?.answer, 'Account A');
});

test('record-returning compatibility facade refuses every id-only linked answer', () => {
  const rec = createCheckIn({
    agentSlug: 'clementine',
    question: 'Should I use account A or account B?',
    linkedTaskId: 'bg-compatibility-must-be-exact',
    linkedQuestionId: 'question-q1',
  });
  assert.equal(answerCheckIn(rec.id, 'Account B'), null);
  assert.equal(getCheckIn(rec.id)?.status, 'open');
  assert.equal(getCheckIn(rec.id)?.answer, undefined);
});

test('restart repair replays a committed linked answer exactly once after the projection crash seam', async () => {
  const task = createBackgroundTask({
    title: 'Resume the exact linked answer',
    prompt: 'Wait for the exact workspace choice.',
  });
  const rec = createCheckIn({
    agentSlug: 'clementine',
    question: 'Which exact workspace should receive the finished report?',
    linkedTaskId: task.id,
  });
  assert.ok(rec.linkedQuestionId);
  markBackgroundTaskAwaitingInput(
    task.id,
    rec.linkedQuestionId!,
    rec.question,
  );

  // Simulate process death after the canonical check-in CAS but before its
  // fire-and-forget task projection had a chance to run.
  const filePath = path.join(CHECK_INS_DIR, `${rec.id}.json`);
  writeFileSync(filePath, JSON.stringify({
    ...rec,
    status: 'answered',
    answer: 'Operations workspace',
    answeredAt: new Date().toISOString(),
  }, null, 2), 'utf-8');

  const repaired = await repairLinkedCheckInAnswers();
  assert.equal(repaired.queued, 1);
  assert.equal(getBackgroundTask(task.id)?.status, 'pending');
  assert.equal(getBackgroundTask(task.id)?.inputResolution?.questionId, rec.linkedQuestionId);
  assert.equal(getBackgroundTask(task.id)?.inputResolution?.answer, 'Operations workspace');
  assert.equal(getCheckIn(rec.id)?.linkedResolutionRequestId, `checkin:${rec.id}`);

  const replay = await repairLinkedCheckInAnswers();
  assert.equal(replay.inspected, 0, 'durable projection acknowledgement prevents repeated work');
});

test('restart reconciliation settles Q1 after Q2, terminal, missing, and exact-resolution crash seams', async () => {
  const fixtures = [
    { kind: 'newer_question' as const, suffix: 'q2' },
    { kind: 'terminal' as const, suffix: 'done' },
    { kind: 'missing' as const, suffix: 'missing' },
    { kind: 'resolved' as const, suffix: 'resolved' },
  ].map(({ kind, suffix }) => {
    const task = createBackgroundTask({
      title: `Restart reconcile ${suffix}`,
      prompt: 'Wait for one exact answer.',
    });
    const questionId = `restart:${task.id}:q1`;
    markBackgroundTaskAwaitingInput(task.id, questionId, 'Which exact region should receive the report?');
    const checkIn = createCheckIn({
      agentSlug: 'clementine',
      question: 'Which exact region should receive the report?',
      linkedTaskId: task.id,
      linkedQuestionId: questionId,
    });
    return { kind, task, questionId, checkIn };
  });

  // Direct file writes model process death after the task authority commit but
  // before the transition-side check-in projection was allowed to run.
  for (const fixture of fixtures) {
    const taskPath = path.join(TEST_HOME, 'state', 'background-tasks', `${fixture.task.id}.json`);
    if (fixture.kind === 'missing') {
      unlinkSync(taskPath);
      continue;
    }
    const raw = JSON.parse(readFileSync(taskPath, 'utf-8')) as Record<string, unknown>;
    if (fixture.kind === 'newer_question') {
      raw.status = 'awaiting_input';
      raw.pendingQuestionId = `restart:${fixture.task.id}:q2`;
      raw.pendingQuestion = 'Which exact mailbox should receive the second report?';
    } else if (fixture.kind === 'terminal') {
      raw.status = 'done';
      raw.pendingQuestionId = undefined;
      raw.pendingQuestion = undefined;
    } else {
      raw.status = 'pending';
      raw.inputResolution = {
        questionId: fixture.questionId,
        answer: 'West',
        queuedAt: new Date().toISOString(),
        requestId: `checkin:${fixture.checkIn.id}`,
      };
      raw.lastInputResolutionRequestId = `checkin:${fixture.checkIn.id}`;
    }
    writeFileSync(taskPath, JSON.stringify(raw, null, 2), 'utf-8');
  }

  assert.ok(fixtures.every(({ checkIn }) => getCheckIn(checkIn.id)?.status === 'open'));
  const repaired = await reconcileOpenLinkedCheckIns();
  assert.equal(repaired.closed, 4);
  assert.ok(fixtures.every(({ checkIn }) => getCheckIn(checkIn.id)?.status === 'closed'));
  const carrierIds = new Set(fixtures.map(({ checkIn }) => checkIn.id));
  assert.ok(
    listNotifications(100)
      .filter((row) => typeof row.metadata?.checkInId === 'string' && carrierIds.has(row.metadata.checkInId))
      .every((row) => row.read),
    'every stale check-in carrier is settled on restart',
  );
  assert.equal(
    listQueuedNotificationDeliveries().some((job) => {
      const row = listNotifications(100).find((notification) => notification.id === job.notificationId);
      return typeof row?.metadata?.checkInId === 'string' && carrierIds.has(row.metadata.checkInId);
    }),
    false,
    'no stale Discord/Slack delivery cursor survives restart reconciliation',
  );
});

test('two cross-process answers to one check-in have one winner', async () => {
  const rec = createCheckIn({
    agentSlug: 'race-agent',
    question: 'Which exact customer segment should this analysis cover?',
  });
  const childCode = String.raw`
    const { writeFileSync } = await import('node:fs');
    const mod = await import(process.env.CLEM_CHECK_INS_MODULE);
    const result = mod.answerCheckInCas(
      process.env.CLEM_CHECK_IN_ID,
      process.env.CLEM_CHECK_IN_ANSWER,
    );
    writeFileSync(process.env.CLEM_RESULT_FILE, JSON.stringify(result), 'utf-8');
  `;
  const launch = (answer: string, resultFile: string) => spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', childCode],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLEMENTINE_HOME: TEST_HOME,
        CLEM_CHECK_INS_MODULE: CHECK_INS_MODULE_URL,
        CLEM_CHECK_IN_ID: rec.id,
        CLEM_CHECK_IN_ANSWER: answer,
        CLEM_RESULT_FILE: resultFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const firstResult = path.join(TEST_HOME, 'check-in-first.result.json');
  const secondResult = path.join(TEST_HOME, 'check-in-second.result.json');
  const first = launch('Enterprise customers', firstResult);
  const second = launch('Every customer', secondResult);
  const collect = async (child: ReturnType<typeof launch>, resultFile: string) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    const [code] = await once(child, 'close') as [number | null];
    assert.equal(code, 0, stderr);
    return JSON.parse(readFileSync(resultFile, 'utf-8')) as { status: string };
  };
  const results = await Promise.all([
    collect(first, firstResult),
    collect(second, secondResult),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['answered', 'stale']);
  assert.ok(
    ['Enterprise customers', 'Every customer'].includes(getCheckIn(rec.id)?.answer ?? ''),
    'the single winning answer was not durably retained',
  );
});

test('answering centrally clears the old question carrier and leaves a non-actionable receipt', () => {
  const rec = createCheckIn({
    agentSlug: 'researcher',
    question: 'Which precise date range should this research include?',
  });
  answerCheckIn(rec.id, 'The previous twelve months');
  const rows = listNotifications(20).filter((row) => row.metadata?.checkInId === rec.id);
  const carrier = rows.find((row) => row.metadata?.status !== 'answered');
  const receipt = rows.find((row) => row.metadata?.status === 'answered');
  assert.equal(carrier?.read, true);
  assert.equal(receipt?.read, false);
});

test('answerCheckIn inbox enqueue is idempotent on sourceKey', () => {
  const rec = createCheckIn({ agentSlug: 'a', question: 'q?' });
  answerCheckIn(rec.id, 'an answer');
  // Force-clobber the record back to open and re-answer — should NOT
  // double-enqueue because sourceKey is the same.
  const filePath = path.join(CHECK_INS_DIR, `${rec.id}.json`);
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  raw.status = 'open';
  raw.answer = undefined;
  raw.answeredAt = undefined;
  // Direct write to bypass the lifecycle guard
  writeFileSync(filePath, JSON.stringify(raw), 'utf-8');

  answerCheckIn(rec.id, 'a different answer');
  const inboxFile = path.join(INBOX_DIR, 'a.json');
  const items = JSON.parse(readFileSync(inboxFile, 'utf-8'));
  assert.equal(items.length, 1, 'sourceKey should dedup the inbox enqueue');
});

test('closeCheckIn transitions open → closed', () => {
  const rec = createCheckIn({ agentSlug: 'a', question: 'q?' });
  const closed = closeCheckIn(rec.id, 'No longer needed.');
  assert.ok(closed);
  assert.equal(closed!.status, 'closed');
  assert.equal(closed!.closeReason, 'No longer needed.');
  assert.ok(closed!.closedAt);
});

test('closeCheckIn is a no-op on already-resolved record', () => {
  const rec = createCheckIn({ agentSlug: 'a', question: 'q?' });
  answerCheckIn(rec.id, 'done');
  const closed = closeCheckIn(rec.id);
  assert.equal(closed!.status, 'answered', 'cannot close an answered check-in');
});

test('renderOpenCheckInsForAgent: empty when no open check-ins', () => {
  assert.equal(renderOpenCheckInsForAgent('nobody'), '');
});

test('renderOpenCheckInsForAgent: lists open questions with urgency flag', () => {
  createCheckIn({ agentSlug: 'agent-x', question: 'Which env should I deploy to?', urgency: 'high' });
  createCheckIn({ agentSlug: 'agent-x', question: 'When is the demo?' });
  const rendered = renderOpenCheckInsForAgent('agent-x');
  assert.match(rendered, /Open check-ins/);
  assert.match(rendered, /\[high\]/);
  assert.match(rendered, /Which env/);
  assert.match(rendered, /When is the demo/);
});

test('renderOpenCheckInsForAgent: excludes resolved check-ins', () => {
  const a = createCheckIn({ agentSlug: 'agent-y', question: 'Q1?' });
  createCheckIn({ agentSlug: 'agent-y', question: 'Q2?' });
  closeCheckIn(a.id);
  const rendered = renderOpenCheckInsForAgent('agent-y');
  assert.doesNotMatch(rendered, /Q1\?/);
  assert.match(rendered, /Q2\?/);
});

test('deleteCheckIn removes the file', () => {
  const rec = createCheckIn({ agentSlug: 'a', question: 'q?' });
  assert.equal(deleteCheckIn(rec.id), true);
  assert.equal(getCheckIn(rec.id), null);
  assert.equal(deleteCheckIn(rec.id), false, 'second delete returns false');
});

test('listCheckIns status="all" includes answered + closed', () => {
  const a = createCheckIn({ agentSlug: 'a', question: 'q1?' });
  const b = createCheckIn({ agentSlug: 'a', question: 'q2?' });
  const c = createCheckIn({ agentSlug: 'a', question: 'q3?' });
  answerCheckIn(b.id, 'ans');
  closeCheckIn(c.id);

  const all = listCheckIns({ status: 'all' });
  assert.equal(all.length, 3);
});

// ---------- validateCheckInQuestion ----------

test('validate: rejects question shorter than 20 chars', () => {
  const r = validateCheckInQuestion('too short?');
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /too short/i);
});

test('validate: rejects generic punts (what should I do)', () => {
  for (const q of ['What should I do?', 'what should I do', 'What now?', 'What next?']) {
    const r = validateCheckInQuestion(q);
    assert.equal(r.ok, false, `expected reject for "${q}"`);
    assert.match(r.reason ?? '', /generic punt/);
  }
});

test('validate: rejects trivial confirmation requests', () => {
  for (const q of ['Should I proceed?', 'Can I continue?', 'Do you want me to start?', 'Is this ok?', 'Are you sure?']) {
    const r = validateCheckInQuestion(q);
    assert.equal(r.ok, false, `expected reject for "${q}"`);
  }
});

test('validate: rejects short yes/no questions', () => {
  for (const q of ['Should I retry?', 'Can I delete it?', 'Are we good?', 'Is this final?']) {
    const r = validateCheckInQuestion(q);
    assert.equal(r.ok, false, `expected reject for "${q}"`);
  }
});

test('validate: accepts a specific yes/no IF long enough to carry context', () => {
  const r = validateCheckInQuestion('Should I publish the v0.2.0 release notes draft now, or wait until after the Friday demo?');
  assert.equal(r.ok, true);
});

test('validate: accepts open-ended specific questions', () => {
  const cases = [
    'Which Stripe account should I sync transactions from?',
    'What budget cap should I set for the embeddings backfill?',
    'Which of the three pricing options aligns with our Q3 strategy?',
  ];
  for (const q of cases) {
    const r = validateCheckInQuestion(q);
    assert.equal(r.ok, true, `expected accept for "${q}"`);
  }
});

test('validate: trims whitespace before checking length', () => {
  const r = validateCheckInQuestion('   short?   ');
  assert.equal(r.ok, false);
});

test('validate: trailing question mark is ignored for pattern matching', () => {
  // Some generic patterns end in `?` optionally — make sure both forms reject.
  assert.equal(validateCheckInQuestion('what should i do').ok, false);
  assert.equal(validateCheckInQuestion('what should i do?').ok, false);
});
