/**
 * Run: node scripts/run-tests-isolated.mjs src/agents/noticing.test.ts
 *
 * Noticing proposes at most one thing per tick, under the owner's
 * boundaries: the daily cap, no repeats of what is open or recently
 * answered, nothing the owner ruled out, nothing the model is unsure of. It
 * writes its thinking down every tick, and a yes is a yes only once the
 * owner's words have been read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_NOTICING_CONFIG,
  emptyNoticingState,
  observationDigest,
  recordNoticingAnswer,
  runNoticingTick,
  type NoticingAnswerV1,
  type NoticingObservation,
  type NoticingState,
  type NoticingTickDeps,
} from './noticing.js';

const OBSERVATION: NoticingObservation = {
  at: '2026-10-01T15:00:00Z',
  goals: [{ id: 'goal-1', title: 'Close three new coaching clients this quarter', status: 'active', priority: 'high', updatedAt: '2026-09-28T00:00:00Z',
    progressNotes: ['Two discovery calls booked'], nextActions: ['Follow up with the Tuesday lead'], blockers: [] }],
  work: { runs: [{ workflow: 'weekly-pipeline-sheet', status: 'failed', finishedAt: '2026-10-01T13:00:00Z', error: 'sheet tab missing' }],
    waits: [], drafts: [{ name: 'proposal-draft.md', modifiedAt: '2026-09-29T20:00:00Z' }] },
  calendar: [],
  conversations: [{ title: 'Tuesday lead follow-up', updatedAt: '2026-09-30T18:00:00Z', lastRequest: 'Draft a follow-up to the Tuesday lead' }],
  memories: [{ text: 'The owner prefers follow-ups within two days of a call', ageDays: 12 }],
};

function harness(input: {
  state?: NoticingState;
  answer?: (digest: string) => NoticingAnswerV1 | null;
  now?: number;
  cap?: number;
  rules?: string[];
  answered?: Record<string, { text: string; at: string }>;
  closed?: string[];
}) {
  let state = input.state ?? emptyNoticingState();
  const asked: string[] = [];
  const deps: NoticingTickDeps = {
    now: () => input.now ?? Date.parse('2026-10-01T15:00:00Z'),
    tickId: 'tick-1',
    source: 'test',
    config: { ...DEFAULT_NOTICING_CONFIG, dailyCap: input.cap ?? 2 },
    rules: input.rules ?? [],
    observe: async () => OBSERVATION,
    propose: async ({ evidenceDigest }) => ({ answer: input.answer ? input.answer(evidenceDigest) : null, modelIdentity: 'fixture-brain' }),
    ask: async (record) => { asked.push(record.title); return { checkInId: `chk-${asked.length}` }; },
    isAnswered: (checkInId) => input.answered?.[checkInId] ? { answered: true, ...input.answered[checkInId] }
      : input.closed?.includes(checkInId) ? { answered: false, closed: true } : { answered: false },
    loadState: () => state,
    saveState: (next) => { state = next; },
  };
  return { deps, asked, state: () => state };
}

const proposal = (digest: string, over: Partial<NoticingAnswerV1['proposal'] & object> = {}): NoticingAnswerV1 => ({
  proposal: { title: 'Send the Tuesday lead the follow-up you drafted', action: 'Open the follow-up draft for the Tuesday lead and send it from my work mailbox, then note it on the goal.',
    why: 'The call was Tuesday, the draft exists, and you prefer follow-ups within two days.', evidence: ['conversation: Tuesday lead follow-up', 'draft proposal-draft.md', 'memory: follow-ups within two days'],
    goalId: 'goal-1', confidence: 0.82, ...over },
  setAside: [{ subject: 'weekly-pipeline-sheet failed', why: 'the run already reported it and a fix needs the sheet tab name' }],
  evidenceDigest: digest,
});

test('one proposal per tick, asked as a question, with the thinking written down', async () => {
  const h = harness({ answer: (d) => proposal(d) });
  const tick = await runNoticingTick(h.deps);
  assert.equal(tick.produced, 1);
  assert.deepEqual(h.asked, ['Send the Tuesday lead the follow-up you drafted']);
  assert.equal(tick.quiet, false);
  assert.match(tick.summary, /^Proposed: Send the Tuesday lead/);
  assert.deepEqual(tick.read, { goals: 1, runs: 1, waits: 0, drafts: 1, calendar: 0, conversations: 1, memories: 1 });
  assert.deepEqual(tick.considered.map((c) => [c.subject, c.outcome]), [
    ['weekly-pipeline-sheet failed', 'set_aside'],
    ['Send the Tuesday lead the follow-up you drafted', 'proposed'],
  ]);
  const state = h.state();
  const record = Object.values(state.proposals)[0]!;
  assert.equal(record.status, 'open');
  assert.equal(record.checkInId, 'chk-1');
  assert.equal(record.goalId, 'goal-1');
  assert.equal(state.thinking.length, 1);
  assert.equal(state.thinking[0]!.model, 'fixture-brain');
  assert.equal(observationDigest(OBSERVATION, []).length, 64);
});

test('the same proposal is not asked twice while open, and a low-confidence one is set aside', async () => {
  const h = harness({ answer: (d) => proposal(d) });
  await runNoticingTick(h.deps);
  const again = await runNoticingTick({ ...h.deps, tickId: 'tick-2', now: () => Date.parse('2026-10-01T18:00:00Z') });
  assert.equal(again.produced, 0);
  assert.equal(h.asked.length, 1);
  assert.ok(again.considered.some((c) => c.outcome === 'duplicate' && /waiting for your answer/.test(c.why)), JSON.stringify(again.considered));

  const unsure = harness({ answer: (d) => proposal(d, { confidence: 0.4 }) });
  const tick = await runNoticingTick(unsure.deps);
  assert.equal(tick.produced, 0);
  assert.ok(tick.considered.some((c) => c.outcome === 'low_confidence'));
});

test('the daily cap holds and is named; the model is not asked past it', async () => {
  const h = harness({ answer: (d) => proposal(d), cap: 1 });
  await runNoticingTick(h.deps);
  let modelAsked = 0;
  const capped = await runNoticingTick({ ...h.deps, tickId: 'tick-2', now: () => Date.parse('2026-10-01T20:00:00Z'),
    propose: async () => { modelAsked += 1; return null; } });
  assert.equal(capped.produced, 0);
  assert.equal(modelAsked, 0, 'no model call when there is no room to speak');
  assert.ok(capped.considered.some((c) => c.outcome === 'capped'));
  assert.match(capped.summary, /used up/);
});

test('an answer is read into a decision; "never" becomes a standing answer the next proposal honours', async () => {
  const h = harness({ answer: (d) => proposal(d) });
  await runNoticingTick(h.deps);
  const state = h.state();
  const id = Object.keys(state.proposals)[0]!;
  const recorded = recordNoticingAnswer(state, { proposalId: id, text: 'No — never nudge me about sending follow-ups, I do those myself.', decision: 'never', at: '2026-10-01T16:00:00Z' });
  assert.equal(recorded?.status, 'answered');
  assert.equal(state.metrics.never, 1);
  assert.equal(state.standingAnswers.length, 1);
  // Next day, the model proposes the same kind of thing again.
  const next = await runNoticingTick({ ...h.deps, tickId: 'tick-3', now: () => Date.parse('2026-10-02T15:00:00Z'),
    propose: async ({ standingAnswers, evidenceDigest }) => {
      assert.equal(standingAnswers.length, 1, 'the model is told what the owner ruled out');
      return { answer: proposal(evidenceDigest, { title: 'Send the Tuesday lead a follow-up today' }), modelIdentity: 'fixture-brain' };
    } });
  assert.equal(next.produced, 0);
  assert.ok(next.considered.some((c) => c.outcome === 'standing_no' && /never nudge me/.test(c.why)), JSON.stringify(next.considered));
});

test('an open proposal answered in the inbox leaves "open" on the next tick, and an unanswered one expires', async () => {
  const h = harness({ answer: (d) => proposal(d), answered: { 'chk-1': { text: 'do it', at: '2026-10-01T16:00:00Z' } } });
  await runNoticingTick(h.deps);
  await runNoticingTick({ ...h.deps, tickId: 'tick-2', now: () => Date.parse('2026-10-01T17:00:00Z'), propose: async () => null });
  const answered = Object.values(h.state().proposals)[0]!;
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answer?.text, 'do it');
  assert.equal(answered.answer?.decision, 'unclear', 'the tick records the words; the decision is read by a model elsewhere');

  const stale = harness({ answer: (d) => proposal(d) });
  await runNoticingTick(stale.deps);
  const later = await runNoticingTick({ ...stale.deps, tickId: 'tick-2', now: () => Date.parse('2026-10-06T15:00:00Z'), propose: async () => null });
  assert.equal(later.retired, 1);
  assert.equal(Object.values(stale.state().proposals)[0]!.status, 'expired');
});

test('no model, a wrong digest, or a read failure is written down as such and proposes nothing', async () => {
  const none = await runNoticingTick(harness({}).deps);
  assert.equal(none.produced, 0);
  const noModel = harness({}); noModel.deps.propose = async () => null;
  const tick = await runNoticingTick(noModel.deps);
  assert.match(tick.error ?? '', /no model/);
  const wrong = harness({ answer: () => proposal('0'.repeat(64)) });
  const mismatch = await runNoticingTick(wrong.deps);
  assert.match(mismatch.error ?? '', /different evidence/);
  const broken = harness({}); broken.deps.observe = async () => { throw new Error('store locked'); };
  const failed = await runNoticingTick(broken.deps);
  assert.match(failed.error ?? '', /could not read: store locked/);
  assert.equal(failed.quiet, true);
});

test('a proposal whose question was closed without an answer is settled on the next tick, not left asking', async () => {
  const h = harness({ answer: (d) => proposal(d), closed: ['chk-1'] });
  await runNoticingTick(h.deps);
  const next = await runNoticingTick({ ...h.deps, tickId: 'tick-2', now: () => Date.parse('2026-10-01T16:00:00Z'), propose: async () => null });
  const record = Object.values(h.state().proposals)[0]!;
  assert.equal(record.status, 'retired');
  assert.match(record.retiredReason ?? '', /closed without an answer/);
  assert.equal(next.retired, 1);
});
