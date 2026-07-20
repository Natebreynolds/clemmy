/**
 * End-to-end correction loop: a user correction of the prior answer records a
 * bounded not_useful signal against the facts that fed it, and demotes them —
 * including the JUDGE-ABSENT path, which must still work for every user.
 *
 * Run: npx tsx --test src/runtime/harness/correction-hook.test.ts
 */
import { before, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-correction-hook';
process.env.CLEMENTINE_HOME = TEST_HOME;
// Keep the judged-path escalation from touching self-heal in these unit tests.
process.env.CLEMMY_MEMORY_SELF_HEAL = 'off';

const { resetMemoryDb } = await import('../../memory/db.js');
const { rememberFact } = await import('../../memory/facts.js');
const { readRecallRefUtilitySignals } = await import('../../memory/recall-usage.js');
const { recallUtilityBonus } = await import('../../memory/recall-memory.js');
const { setCorrectionJudgeForTest } = await import('../../memory/correction-detector.js');
const { appendEvent, listEvents, resetEventLog, createSession } = await import('./eventlog.js');
const { detectCorrection } = await import('./correction-hook.js');

const SESSION = 'sess-correction';

function seedPriorCredit(factId: number): void {
  appendEvent({
    sessionId: SESSION,
    turn: 1,
    role: 'system',
    type: 'recall_auto_credit',
    data: { runs: [{ recallId: 'mr-prev', refs: [{ ref: `fact:${factId}`, evidence: 'cited' }] }] },
  });
}

before(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });
beforeEach(() => {
  resetMemoryDb();
  resetEventLog();
  setCorrectionJudgeForTest(null);
  createSession({ id: SESSION, kind: 'chat' });
});
afterEach(() => setCorrectionJudgeForTest(null));

test('judge ABSENT: a correction still records not_useful and demotes the fact', async () => {
  // The common single-provider / BYO case — force "no different-family judge".
  setCorrectionJudgeForTest(async () => ({ verdict: 'unavailable', reason: 'test: no judge' }));
  const fact = rememberFact({ kind: 'project', content: 'Renewal closes in September.' });
  seedPriorCredit(fact.id);

  const outcome = await detectCorrection({ sessionId: SESSION, turn: 2, userInput: "No, it closes in March." });

  assert.equal(outcome.status, 'recorded');
  if (outcome.status === 'recorded') {
    assert.equal(outcome.judged, false); // soft path, no judge
    assert.deepEqual(outcome.factIds, [fact.id]);
  }
  const signal = readRecallRefUtilitySignals([{ type: 'fact', id: String(fact.id) }]).get(`fact:${fact.id}`);
  assert.equal(signal?.notUseful, 1);
  assert.ok(recallUtilityBonus(signal) < 0, 'corrected fact is demoted');

  const audit = listEvents(SESSION, { types: ['memory_correction'] });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].data.applied, true);
});

test('judge VETO: no signal is written', async () => {
  setCorrectionJudgeForTest(async () => ({ verdict: 'veto', reason: 'new question, not a correction' }));
  const fact = rememberFact({ kind: 'project', content: 'ARR is 240k.' });
  seedPriorCredit(fact.id);

  const outcome = await detectCorrection({ sessionId: SESSION, turn: 2, userInput: "No, tell me about Q3 instead." });

  assert.equal(outcome.status, 'veto');
  const signal = readRecallRefUtilitySignals([{ type: 'fact', id: String(fact.id) }]).get(`fact:${fact.id}`);
  assert.equal(signal?.notUseful ?? 0, 0);
});

test('judge APPROVE: records a judged signal', async () => {
  setCorrectionJudgeForTest(async () => ({ verdict: 'approve', reason: 'clearly rejects the date' }));
  const fact = rememberFact({ kind: 'project', content: 'Close date is Friday.' });
  seedPriorCredit(fact.id);

  const outcome = await detectCorrection({ sessionId: SESSION, turn: 2, userInput: "That's wrong, it's Monday." });

  assert.equal(outcome.status, 'recorded');
  if (outcome.status === 'recorded') assert.equal(outcome.judged, true);
});

test('no cue: an ordinary follow-up records nothing', async () => {
  const fact = rememberFact({ kind: 'project', content: 'The deal is with Acme.' });
  seedPriorCredit(fact.id);
  const outcome = await detectCorrection({ sessionId: SESSION, turn: 2, userInput: 'Great, can you draft a follow-up email?' });
  assert.equal(outcome.status, 'no_cue');
});

test('no target: a correction with no prior credited answer is a no-op', async () => {
  const outcome = await detectCorrection({ sessionId: SESSION, turn: 2, userInput: "No, that's wrong." });
  assert.equal(outcome.status, 'no_target');
});

test('stale prior credit (>15m) is not targeted', async () => {
  const fact = rememberFact({ kind: 'project', content: 'Owner is Priya.' });
  seedPriorCredit(fact.id);
  // 16 minutes in the future -> the seeded credit is now stale.
  const future = Date.now() + 16 * 60 * 1000;
  const outcome = await detectCorrection({ sessionId: SESSION, turn: 2, userInput: 'No, the owner is Sam.', nowMs: future });
  assert.equal(outcome.status, 'no_target');
});

test('a wrong-recipient complaint is attributed to the sent payload, not the correct recalled roster', async () => {
  setCorrectionJudgeForTest(async () => ({ verdict: 'approve', reason: 'the user clearly reports a bad send' }));
  const fact = rememberFact({
    kind: 'project',
    content: 'The team is Avery Rowan <avery@example.com> and Blair Solis <blair@example.com>.',
  });
  seedPriorCredit(fact.id);
  appendEvent({
    sessionId: SESSION,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: { toolName: 'composio_execute_tool', targets: ['wrong-a@example.com', 'wrong-b@example.com'] },
  });

  const outcome = await detectCorrection({
    sessionId: SESSION,
    turn: 2,
    userInput: 'That invitation was sent to the wrong recipients.',
  });

  assert.equal(outcome.status, 'downstream_error');
  const signal = readRecallRefUtilitySignals([{ type: 'fact', id: String(fact.id) }]).get(`fact:${fact.id}`);
  assert.equal(signal?.notUseful ?? 0, 0, 'the correct source fact is not demoted for a bad downstream payload');
  const audit = listEvents(SESSION, { types: ['memory_correction'] }).at(-1);
  assert.equal(audit?.data.reason, 'downstream_derivation_failure');
  assert.equal(audit?.data.applied, false);
});
