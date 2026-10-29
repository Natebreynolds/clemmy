import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-question-presentation-'));
process.env.CLEMENTINE_HOME = home;
mkdirSync(path.join(home, 'state'), { recursive: true });
const { answerCheckIn, CHECK_INS_DIR, createCheckIn, getCheckIn } = await import('../agents/check-ins.js');
const { listInboxQuestions } = await import('../execution/inbox-questions.js');
const { listQuestionPresentations, presentInboxQuestion, projectInboxQuestion, questionHidden, visibleInboxQuestions } = await import('./question-presentation.js');
const { needsYouReferents, notificationNeedsYou, summarizeNeedsYou } = await import('./needs-you.js');
const { addNotification } = await import('../runtime/notifications.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');

test('dismiss clears an exact question and its carrier without answering or resuming', async () => {
  const checkIn = createCheckIn({ agentSlug: 'clementine', question: 'Controlled question to dismiss', urgency: 'normal' });
  const id = `checkin:${checkIn.id}`;
  const row = listInboxQuestions().find((item) => item.id === id)!;
  const carrier = { id: 'dismiss-carrier', kind: 'execution' as const, title: 'Question', body: '',
    createdAt: checkIn.askedAt, read: false, metadata: { checkInId: checkIn.id, needsAttention: true } };
  addNotification(carrier);
  assert.ok((await summarizeNeedsYou()).keys.includes(id));
  const dismissed = presentInboxQuestion(id, 'dismiss');
  assert.equal(dismissed.ok, true);
  assert.equal(getCheckIn(checkIn.id)?.status, 'open', 'attention preference never settles the owning question');
  assert.equal(visibleInboxQuestions().some((item) => item.id === id), false);
  assert.equal((await summarizeNeedsYou()).keys.includes(id), false);
  assert.equal(notificationNeedsYou(carrier, needsYouReferents()), false);
  assert.equal(questionHidden({ ...row, askedAt: new Date(Date.parse(row.askedAt) + 1).toISOString() }), false, 'a different generation is visible');
  assert.equal(questionHidden({ ...row, question: 'A changed question' }), false);
  assert.equal(projectInboxQuestion(row).lifecycle.effect, 'hide_only');
  assert.equal(presentInboxQuestion(id, 'restore', Date.now(), '0'.repeat(64)).ok, false, 'an unrelated generation cannot restore this question');
  assert.equal(presentInboxQuestion(id, 'restore').ok, false, 'undo requires its exact generation');
  assert.equal(presentInboxQuestion(id, 'restore', Date.now(), dismissed.generation, dismissed.mutationToken).ok, true);
  assert.equal(presentInboxQuestion(id, 'restore', Date.now(), dismissed.generation, dismissed.mutationToken).ok, true, 'identical Undo replay is idempotent');
  assert.ok(visibleInboxQuestions().some((item) => item.id === id));
  assert.ok((await summarizeNeedsYou()).keys.includes(id));
  assert.equal(getCheckIn(checkIn.id)?.status, 'open');
});

test('an older desktop Undo cannot clear a newer phone attention preference for the same question', () => {
  const checkIn = createCheckIn({ agentSlug: 'clementine', question: 'Controlled cross-device attention fixture', urgency: 'normal' });
  const id = `checkin:${checkIn.id}`;
  const desktop = presentInboxQuestion(id, 'dismiss');
  const phone = presentInboxQuestion(id, 'defer');
  assert.ok(desktop.ok && phone.ok);
  assert.equal(desktop.generation, phone.generation, 'the question has not changed');
  assert.notEqual(desktop.mutationToken, phone.mutationToken);
  assert.equal(presentInboxQuestion(id, 'restore', Date.now(), desktop.generation, desktop.mutationToken).ok, false);
  assert.equal(visibleInboxQuestions().some((row) => row.id === id), false, 'the newer phone defer remains');
  assert.equal(presentInboxQuestion(id, 'restore', Date.now(), phone.generation, phone.mutationToken).ok, true);
  assert.ok(visibleInboxQuestions().some((row) => row.id === id));
});

test('defer returns at the next morning and unsupported identities never become decisions', () => {
  const checkIn = createCheckIn({ agentSlug: 'clementine', question: 'Controlled question for tomorrow', urgency: 'normal' });
  const id = `checkin:${checkIn.id}`;
  const now = Date.now();
  const result = presentInboxQuestion(id, 'defer', now);
  assert.ok(result.ok && result.until);
  assert.equal(visibleInboxQuestions(undefined, now).some((item) => item.id === id), false);
  assert.equal(visibleInboxQuestions(undefined, Date.parse(result.until!)).some((item) => item.id === id), true);
  assert.equal(getCheckIn(checkIn.id)?.status, 'open');
  assert.equal(presentInboxQuestion('approval:never-hide-approval', 'dismiss').ok, false);
});

test('durable recovery lists only pending exact-generation preferences and excludes expired, answered and revised content', () => {
  const now = Date.now();
  const make = (question: string) => createCheckIn({ agentSlug: 'clementine', question, urgency: 'normal', contextSummary: 'Controlled recovery context' });
  const dismissed = make('Controlled dismissed recovery question');
  const deferred = make('Controlled later recovery question');
  const answered = make('Controlled answered question must not be disclosed');
  const revised = make('Controlled old revision must not be disclosed');
  const receipts = new Map([dismissed, deferred, answered, revised].map((row) => [row.id,
    presentInboxQuestion(`checkin:${row.id}`, row.id === deferred.id ? 'defer' : 'dismiss', now)]));
  assert.equal(getCheckIn(dismissed.id)?.status, 'open');
  assert.equal(getCheckIn(deferred.id)?.status, 'open');
  const stored = readFileSync(path.join(home, 'state/question-presentation.json'), 'utf8');
  const first = listQuestionPresentations(now);
  const second = listQuestionPresentations(now); // A fresh read reconstructs receipts from disk.
  assert.deepEqual(second, first);
  assert.equal(readFileSync(path.join(home, 'state/question-presentation.json'), 'utf8'), stored, 'listing is read-only');
  const recovery = second.find((row) => row.id === `checkin:${dismissed.id}`)!;
  assert.equal(recovery.context, 'Controlled recovery context');
  assert.equal(recovery.action, 'dismiss');
  assert.equal(recovery.generation, receipts.get(dismissed.id)?.generation);
  assert.equal(recovery.mutationToken, receipts.get(dismissed.id)?.mutationToken);
  answerCheckIn(answered.id, 'Controlled fixture answer');
  writeFileSync(path.join(CHECK_INS_DIR, `${revised.id}.json`), JSON.stringify({ ...revised, question: 'Controlled new revision' }));
  const pending = listQuestionPresentations(now);
  assert.equal(pending.some((row) => row.id === `checkin:${answered.id}` || row.id === `checkin:${revised.id}`), false);
  const oldRevision = receipts.get(revised.id)!;
  assert.equal(presentInboxQuestion(`checkin:${revised.id}`, 'dismiss', now, oldRevision.generation).ok, false, 'a stale visible render cannot hide a revision');
  const until = receipts.get(deferred.id)?.until!;
  assert.equal(listQuestionPresentations(Date.parse(until)).some((row) => row.id === `checkin:${deferred.id}`), false);
  assert.ok(visibleInboxQuestions(undefined, Date.parse(until)).some((row) => row.id === `checkin:${deferred.id}`));
  const newerPhone = presentInboxQuestion(recovery.id, 'defer', now, recovery.generation);
  assert.equal(presentInboxQuestion(recovery.id, 'restore', now, recovery.generation, recovery.mutationToken).ok, false);
  assert.equal(presentInboxQuestion(recovery.id, 'restore', now, newerPhone.generation, newerPhone.mutationToken).ok, true);
  assert.equal(listQuestionPresentations(now).some((row) => row.id === recovery.id), false);
  assert.equal(getCheckIn(dismissed.id)?.status, 'open', 'restoring only changes visibility');
});

test('damaged attention preferences never hide pending questions or get overwritten by a mutation', async () => {
  const file = path.join(home, 'state/question-presentation.json');
  const checkIn = createCheckIn({ agentSlug: 'clementine', question: 'Controlled damaged attention settings fixture', urgency: 'normal' });
  const id = `checkin:${checkIn.id}`;
  const receipt = presentInboxQuestion(id, 'dismiss');
  assert.ok(receipt.ok);
  const healthy = readFileSync(file, 'utf8');
  const damaged = ['{', 'null', '[]', JSON.stringify({ version: 1, entries: [] }),
    JSON.stringify({ version: 2, entries: {} }),
    JSON.stringify({ version: 1, entries: { [id]: { fingerprint: receipt.generation, action: 'dismiss', mutationToken: 42 } } }),
    JSON.stringify({ version: 1, entries: { [id]: { fingerprint: receipt.generation, action: 'defer', until: 'invalid' } } })];
  try {
    for (const bytes of damaged) {
      writeFileSync(file, bytes);
      assert.ok(visibleInboxQuestions().some((row) => row.id === id));
      assert.ok((await summarizeNeedsYou()).keys.includes(id), 'the canonical count remains available');
      assert.throws(() => listQuestionPresentations(), /Saved question settings are unavailable/, 'recovery reports unavailability instead of a false empty state');
      assert.throws(() => presentInboxQuestion(id, 'dismiss'), /Saved question settings are unavailable/);
      assert.throws(() => presentInboxQuestion(id, 'restore', Date.now(), receipt.generation, receipt.mutationToken), /Saved question settings are unavailable/);
      assert.equal(readFileSync(file, 'utf8'), bytes, 'damaged preferences are preserved for repair');
      assert.equal(getCheckIn(checkIn.id)?.status, 'open');
    }
  } finally { writeFileSync(file, healthy); }
  assert.equal(visibleInboxQuestions().some((row) => row.id === id), false, 'healthy preferences work again without restarting');
  assert.equal(presentInboxQuestion(id, 'restore', Date.now(), receipt.generation, receipt.mutationToken).ok, true);
});

test('Tomorrow uses 8 AM on the next calendar day, including a late-night choice', () => {
  const checkIn = createCheckIn({ agentSlug: 'clementine', question: 'Controlled calendar-day deferral fixture', urgency: 'normal' });
  for (const hour of [1, 8, 23]) {
    const now = new Date(2026, 9, 29, hour, 30);
    const result = presentInboxQuestion(`checkin:${checkIn.id}`, 'defer', now.getTime());
    assert.ok(result.ok && result.until);
    const until = new Date(result.until!);
    assert.equal(until.getDate(), 30);
    assert.equal(until.getHours(), 8);
    assert.equal(until.getMinutes(), 0);
  }
});

test('setting aside a workflow question hides both exact and workflow-only carriers and subtracts one canonical item', async () => {
  const now = Date.now() + 20_000;
  const runId = 'FRAMEWORK-TEST-hidden-workflow';
  const questionId = 'FRAMEWORK-TEST-workflow-question';
  const id = `workflow:${runId}|${questionId}`;
  const workflow = 'FRAMEWORK-TEST hidden workflow carrier';
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const bytes = JSON.stringify({ id: runId, workflow, status: 'awaiting_input', createdAt: new Date(now).toISOString(),
    awaitingInput: { questionId, question: 'Which controlled option should this workflow use?', stepId: 'review',
      sessionId: 'FRAMEWORK-TEST-session', sessionIdSuffix: 'review', askedAt: new Date(now).toISOString() } });
  writeFileSync(file, bytes);
  const notices = [false, true].map((exact) => ({ id: `FRAMEWORK-TEST-carrier-${exact}`, kind: 'workflow' as const,
    title: 'Controlled workflow needs a decision', body: '', createdAt: new Date(now).toISOString(), read: false,
    metadata: { workflow, runId, needsAttention: true, ...(exact ? { questionId, stepId: 'review', status: 'awaiting_input' } : {}) } }));
  for (const notice of notices) addNotification(notice);
  const before = await summarizeNeedsYou({ nowMs: now });
  assert.equal(before.keys.filter((key) => key === id).length, 1);
  const receipt = presentInboxQuestion(id, 'dismiss', now);
  assert.ok(receipt.ok);
  const after = await summarizeNeedsYou({ nowMs: now });
  assert.equal(after.total, before.total - 1);
  assert.equal(after.keys.includes(id), false);
  const ref = needsYouReferents(now);
  for (const notice of notices) assert.equal(notificationNeedsYou(notice, ref), false);
  assert.equal(readFileSync(file, 'utf8'), bytes, 'presentation leaves the workflow pause untouched');
  assert.equal(presentInboxQuestion(id, 'restore', now, receipt.generation, receipt.mutationToken).ok, true);
  assert.equal((await summarizeNeedsYou({ nowMs: now })).keys.filter((key) => key === id).length, 1);
});
