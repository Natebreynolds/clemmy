/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-checkins npx tsx --test src/agents/check-ins.test.ts
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TEST_HOME = '/tmp/clemmy-test-checkins';
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  CHECK_INS_DIR,
  answerCheckIn,
  closeCheckIn,
  createCheckIn,
  deleteCheckIn,
  getCheckIn,
  listCheckIns,
  listOpenCheckIns,
  renderOpenCheckInsForAgent,
  validateCheckInQuestion,
} = await import('./check-ins.js');

const INBOX_DIR = path.join(TEST_HOME, 'agents-inbox');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

beforeEach(() => {
  rmSync(CHECK_INS_DIR, { recursive: true, force: true });
  rmSync(INBOX_DIR, { recursive: true, force: true });
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
