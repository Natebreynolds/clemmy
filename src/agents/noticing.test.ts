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
  NOTICING_DECISION_REUSE_MS,
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

test('no model is a quiet wait; a wrong digest or a read failure is written down as such; none proposes anything', async () => {
  const none = await runNoticingTick(harness({}).deps);
  assert.equal(none.produced, 0);
  // A home with no model signed in is not set up yet, not failing (live
  // 10-02: a fresh install read "Could not finish: no model is available").
  const noModel = harness({}); noModel.deps.propose = async () => null;
  const tick = await runNoticingTick(noModel.deps);
  assert.equal(tick.error, undefined);
  assert.equal(tick.quiet, true);
  assert.equal(tick.produced, 0);
  assert.match(tick.summary, /^Quiet: waiting until a model is set up/);
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

test('Noticing is told what Home already asks the owner, and never to raise it again', async () => {
  // Live 2026-10-09: the calendar watch already asked about an invite; Noticing
  // proposed drafting a reply to the same invite, a second card for one thing.
  const { NOTICING_PROPOSAL_SYSTEM } = await import('../runtime/semantic-boundary/configured-brain-semantic-port.js');
  assert.match(NOTICING_PROPOSAL_SYSTEM, /alreadyAskingOwner/);
  assert.match(NOTICING_PROPOSAL_SYSTEM, /one open thing is one card, so never propose any of it, or a step toward answering it/);
});

const REUSE_START = Date.parse('2026-10-01T15:00:00Z');
const MINUTE = 60_000;
function reuseHarness(state = emptyNoticingState()) {
  const h = harness({ state });
  const control = {
    now: REUSE_START,
    observation: structuredClone(OBSERVATION),
    modelCalls: 0,
    reads: 0,
    respond: (async ({ evidenceDigest }) => ({ answer: { proposal: null, setAside: [], evidenceDigest }, modelIdentity: 'fixture-brain' })) as NoticingTickDeps['propose'],
  };
  h.deps.source = 'heartbeat';
  h.deps.now = () => control.now;
  h.deps.observe = async () => {
    control.reads++;
    return { ...structuredClone(control.observation), at: new Date(control.now).toISOString() };
  };
  h.deps.propose = async input => { control.modelCalls++; return control.respond(input); };
  return { ...h, control };
}

test('an empty local home reads and settles replies without a model or pretending to check providers', async () => {
  const h = reuseHarness();
  const record = { ...proposal('a'.repeat(64)).proposal!, id: 'old-question', shapeKey: 'old-shape',
    createdAt: new Date(REUSE_START - MINUTE).toISOString(), status: 'open' as const, checkInId: 'old-check-in' };
  h.state().proposals[record.id] = record;
  h.deps.isAnswered = id => ({ answered: id === 'old-check-in', text: 'Do not send anything; keep the draft.', at: new Date(REUSE_START).toISOString() });
  h.control.observation = { at: '', goals: [], work: { runs: [], waits: [], drafts: [] }, calendar: [], memories: [],
    conversations: [{ title: '(untitled)', updatedAt: new Date(REUSE_START).toISOString() },
      { title: 'New chat', updatedAt: new Date(REUSE_START).toISOString(), lastRequest: '   ' }] };
  const tick = await runNoticingTick(h.deps);
  assert.equal(h.control.reads, 1);
  assert.equal(h.control.modelCalls, 0);
  assert.equal(tick.modelCheck, 'no_local_evidence');
  assert.equal(tick.read.conversations, 2, 'metadata was read even though placeholder chats are not actionable evidence');
  assert.equal(h.state().proposals[record.id]?.answer?.text, 'Do not send anything; keep the draft.');
  assert.equal(h.state().proposals[record.id]?.status, 'answered');
  assert.equal(h.state().thinking[0]?.tickId, tick.tickId);
  assert.equal(h.state().decisionReuse, undefined);
  assert.match(tick.summary, /no local evidence/);
  assert.doesNotMatch(tick.summary, /checked.*provider|provider.*checked/i);
});

test('a recent unchanged successful decision skips only the model, survives reload, and expires without renewal', async () => {
  const h = reuseHarness();
  const first = await runNoticingTick(h.deps);
  assert.equal(first.modelCheck, 'fresh');
  assert.equal(h.control.modelCalls, 1);
  const recordedAt = h.state().decisionReuse!.decidedAt;
  const reopened = reuseHarness(JSON.parse(JSON.stringify(h.state())) as NoticingState);
  reopened.control.now += 30 * MINUTE;
  const second = await runNoticingTick(reopened.deps);
  assert.equal(second.modelCheck, 'recent_unchanged');
  assert.equal(reopened.control.reads, 1);
  assert.equal(reopened.control.modelCalls, 0);
  assert.equal(reopened.state().metrics.modelCalls, 1, 'skips are not recorded as completed model calls');
  reopened.control.now = REUSE_START + 45 * MINUTE;
  reopened.deps.source = 'boot';
  assert.equal((await runNoticingTick(reopened.deps)).modelCheck, 'recent_unchanged');
  assert.equal(reopened.state().decisionReuse?.decidedAt, recordedAt);
  reopened.control.now = REUSE_START + NOTICING_DECISION_REUSE_MS;
  assert.equal((await runNoticingTick(reopened.deps)).modelCheck, 'fresh');
  assert.equal(reopened.control.modelCalls, 1);
  assert.equal(reopened.control.reads, 3);
  assert.equal(reopened.state().thinking.length, 4, 'every metadata check remains visible');
});

test('manual Check now and unknown sources reconsider unchanged evidence with the exact current attestation digest', async () => {
  const h = reuseHarness();
  const digests: string[] = [];
  h.control.respond = async input => {
    digests.push(input.evidenceDigest);
    assert.equal(input.evidenceDigest, observationDigest(input.observation, input.rules));
    return { answer: { proposal: null, setAside: [], evidenceDigest: input.evidenceDigest } };
  };
  await runNoticingTick(h.deps);
  const fingerprint = h.state().decisionReuse!.fingerprint;
  for (const source of ['manual', 'future-unknown-source']) {
    h.control.now += 5 * MINUTE;
    h.deps.source = source;
    assert.equal((await runNoticingTick(h.deps)).modelCheck, 'fresh');
    assert.equal(h.state().decisionReuse?.fingerprint, fingerprint, 'clock-only change is absent only from the reuse fingerprint');
  }
  assert.equal(h.control.modelCalls, 3);
  assert.equal(new Set(digests).size, 3, 'the model attestation continues to bind each exact observation timestamp');
});

const evidenceMutations: Array<[string, (h: ReturnType<typeof reuseHarness>) => void]> = [
  ['goal state', h => { h.control.observation.goals[0]!.status = 'blocked'; }],
  ['goal progress', h => { h.control.observation.goals[0]!.progressNotes.push('A controlled result arrived.'); }],
  ['run result', h => { h.control.observation.work.runs[0]!.error = 'A different exact failure.'; }],
  ['draft version', h => { h.control.observation.work.drafts[0]!.modifiedAt = new Date(REUSE_START).toISOString(); }],
  ['literal user request', h => { h.control.observation.conversations[0]!.lastRequest = 'Use the selected account, but do not send.'; }],
  ['remembered instruction', h => { h.control.observation.memories[0]!.text = 'Use the requested work account only.'; }],
  ['memory age', h => { h.control.observation.memories[0]!.ageDays++; }],
  ['already pending question', h => { h.control.observation.alreadyAskingOwner = [{ from: 'Calendar', about: 'Which meeting should stay?' }]; }],
  ['heartbeat rule', h => { h.deps.rules = ['Never suggest sending these drafts.']; }],
  ['standing answer', h => { h.state().standingAnswers.push({ text: 'Not this kind of work.', about: 'Draft follow-up', at: new Date(REUSE_START).toISOString() }); }],
  ['policy', h => { h.deps.config = { ...h.deps.config, minConfidence: 0.9 }; }],
  ['proposal handoff', h => {
    const existing = Object.values(h.state().proposals)[0]!;
    existing.handoff = { version: 1, answerDigest: 'a'.repeat(64), state: 'needs_attention', updatedAt: new Date(REUSE_START).toISOString(), reason: 'The exact connection is unavailable.' };
  }],
];
for (const [name, mutate] of evidenceMutations) test(`changed ${name} invalidates a recent Noticing decision`, async () => {
  const h = reuseHarness();
  h.state().proposals.old = { ...proposal('a'.repeat(64)).proposal!, id: 'old', shapeKey: 'old',
    createdAt: '2026-09-20T12:00:00Z', status: 'retired', retiredReason: 'Already closed' };
  await runNoticingTick(h.deps);
  mutate(h);
  h.control.now += 30 * MINUTE;
  assert.equal((await runNoticingTick(h.deps)).modelCheck, 'fresh');
  assert.equal(h.control.modelCalls, 2);
});

for (const kind of ['calendar', 'wait', 'target date', 'unknown target date'] as const) {
  test(`unchanged ${kind} evidence retains normal time-sensitive model checks`, async () => {
    const h = reuseHarness();
    if (kind === 'calendar') h.control.observation.calendar.push({ kind: 'meeting', subject: 'Upcoming controlled meeting', createdAt: new Date(REUSE_START).toISOString() });
    else if (kind === 'wait') h.control.observation.work.waits.push({ title: 'Pending work', waitingOn: 'A reply', since: new Date(REUSE_START).toISOString() });
    else h.control.observation.goals[0]!.targetDate = kind === 'target date' ? new Date(REUSE_START + 20 * MINUTE).toISOString() : 'legacy unknown date';
    await runNoticingTick(h.deps);
    h.control.now += 30 * MINUTE;
    assert.equal((await runNoticingTick(h.deps)).modelCheck, 'fresh');
    assert.equal(h.control.modelCalls, 2);
  });
}

test('a relative observation age boundary invalidates a decision without changing its saved timestamp', async () => {
  const h = reuseHarness();
  h.control.observation.work.drafts[0]!.modifiedAt = new Date(REUSE_START - 24 * 60 * MINUTE + 15 * MINUTE).toISOString();
  await runNoticingTick(h.deps);
  h.control.now += 30 * MINUTE;
  assert.equal((await runNoticingTick(h.deps)).modelCheck, 'fresh');
  assert.equal(h.control.modelCalls, 2);
});

for (const kind of ['not now', 'do it', 'rolling daily count', 'recent proposal', 'open question'] as const) {
  test(`${kind} expiry invalidates a recent decision inside the reuse window`, async () => {
    const h = reuseHarness();
    const created = kind === 'rolling daily count' ? REUSE_START - 24 * 60 * MINUTE + 15 * MINUTE
      : kind === 'recent proposal' ? REUSE_START - 14 * 24 * 60 * MINUTE + 15 * MINUTE
      : kind === 'open question' ? REUSE_START - h.deps.config.openForMs + 15 * MINUTE
      : REUSE_START - 8 * 24 * 60 * MINUTE;
    const answerAt = kind === 'do it' ? REUSE_START - 7 * 24 * 60 * MINUTE + 15 * MINUTE : REUSE_START;
    if (kind === 'not now') h.deps.config = { ...h.deps.config, notNowForMs: 15 * MINUTE };
    h.state().proposals.old = { ...proposal('a'.repeat(64)).proposal!, id: 'old', shapeKey: 'old',
      createdAt: new Date(created).toISOString(), status: kind === 'open question' ? 'open' : 'answered',
      ...(kind !== 'open question' ? { answer: { text: 'Controlled answer', at: new Date(answerAt).toISOString(),
        decision: kind === 'not now' ? 'not_now' as const : kind === 'do it' ? 'do_it' as const : 'unclear' as const } } : {}) };
    await runNoticingTick(h.deps);
    h.control.now += 30 * MINUTE;
    assert.equal((await runNoticingTick(h.deps)).modelCheck, 'fresh');
    assert.equal(h.control.modelCalls, 2);
    if (kind === 'open question') assert.equal(h.state().proposals.old!.status, 'expired');
  });
}

for (const failure of ['missing model', 'model error', 'invalid answer', 'wrong digest', 'throw', 'ask failure'] as const) {
  test(`a ${failure} never seeds or preserves an older successful decision cache`, async () => {
    const h = reuseHarness();
    await runNoticingTick(h.deps);
    assert.ok(h.state().decisionReuse);
    h.deps.source = 'manual';
    h.control.now += 5 * MINUTE;
    h.control.respond = async ({ evidenceDigest }) => {
      if (failure === 'missing model') return null;
      if (failure === 'model error') return { answer: null, error: 'Controlled model outage' };
      if (failure === 'invalid answer') return { answer: { proposal: { title: 'Malformed' }, setAside: [], evidenceDigest } as never };
      if (failure === 'wrong digest') return { answer: { proposal: null, setAside: [], evidenceDigest: '0'.repeat(64) } };
      if (failure === 'throw') throw new Error('Controlled transport failure');
      return { answer: proposal(evidenceDigest) };
    };
    h.deps.ask = async () => { throw new Error('Controlled publication failure'); };
    const failed = await runNoticingTick(h.deps);
    assert.equal(failed.produced, 0);
    assert.equal(h.state().decisionReuse, undefined);
    h.control.respond = async ({ evidenceDigest }) => ({ answer: { proposal: null, setAside: [], evidenceDigest } });
    h.deps.source = 'heartbeat';
    h.control.now += 5 * MINUTE;
    assert.equal((await runNoticingTick(h.deps)).modelCheck, 'fresh');
    assert.equal(h.control.modelCalls, 3);
  });
}

test('a failed local read clears reuse without a model call, then a recovered read is reconsidered', async () => {
  const h = reuseHarness();
  await runNoticingTick(h.deps);
  const observe = h.deps.observe;
  h.deps.observe = async () => { throw new Error('Controlled store unavailable'); };
  const failed = await runNoticingTick(h.deps);
  assert.match(failed.error!, /could not read/);
  assert.equal(h.control.modelCalls, 1);
  assert.equal(h.state().decisionReuse, undefined);
  h.deps.observe = observe;
  assert.equal((await runNoticingTick(h.deps)).modelCheck, 'fresh');
  assert.equal(h.control.modelCalls, 2);
});

for (const kind of ['malformed', 'future', 'clock rollback', 'malformed fingerprint', 'unknown version'] as const) test(`${kind} decision metadata does not suppress fresh reasoning`, async () => {
  const h = reuseHarness();
  await runNoticingTick(h.deps);
  if (kind === 'malformed') h.state().decisionReuse!.decidedAt = 'not a timestamp';
  else if (kind === 'future') h.state().decisionReuse!.decidedAt = new Date(REUSE_START + MINUTE).toISOString();
  else if (kind === 'malformed fingerprint') h.state().decisionReuse!.fingerprint = { toString: 42 } as never;
  else if (kind === 'unknown version') h.state().decisionReuse!.version = 2 as never;
  else h.control.now -= MINUTE;
  assert.equal((await runNoticingTick(h.deps)).modelCheck, 'fresh');
  assert.equal(h.control.modelCalls, 2);
});

for (const change of ['new open proposal', 'standing answer', 'heartbeat rule'] as const) {
  test(`a ${change} committed during model reasoning prevents stale publication without another model call`, async () => {
    const h = reuseHarness();
    const latest = { state: structuredClone(h.state()), rules: [...h.deps.rules] };
    const generation = () => JSON.stringify({ proposals: latest.state.proposals, standingAnswers: latest.state.standingAnswers, rules: latest.rules });
    const original = generation();
    h.deps.publicationStillCurrent = () => generation() === original;
    let entered!: () => void;
    let release!: () => void;
    const modelEntered = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    h.control.respond = async ({ evidenceDigest }) => { entered(); await waiting; return { answer: proposal(evidenceDigest) }; };
    const pending = runNoticingTick(h.deps);
    await modelEntered;
    if (change === 'new open proposal') latest.state.proposals.concurrent = { ...proposal('a'.repeat(64)).proposal!,
      id: 'concurrent', shapeKey: 'concurrent', createdAt: new Date(REUSE_START).toISOString(), status: 'open', checkInId: 'concurrent-check-in' };
    else if (change === 'standing answer') latest.state.standingAnswers.push({ about: 'Follow-ups', text: 'Never suggest these sends.', at: new Date(REUSE_START).toISOString() });
    else latest.rules.push('Keep these drafts; do not suggest sending them.');
    release();
    const result = await pending;
    assert.equal(h.control.modelCalls, 1);
    assert.equal(h.asked.length, 0);
    assert.equal(result.produced, 0);
    assert.equal(result.error, undefined, 'an owner metadata change is not a model failure');
    assert.equal(h.state().metrics.modelFailures, 0);
    assert.equal(h.state().decisionReuse, undefined);
    assert.match(result.summary, /local context changed/);
  });
}

test('the final publication fence and unavailable metadata retain a quiet retry path without cache or questions', async () => {
  for (const mode of ['changed just before ask', 'read unavailable'] as const) {
    const h = reuseHarness();
    h.control.respond = async ({ evidenceDigest }) => ({ answer: proposal(evidenceDigest) });
    let checks = 0;
    h.deps.publicationStillCurrent = () => {
      checks++;
      if (mode === 'read unavailable') throw new Error('Controlled metadata read failure');
      return checks === 1;
    };
    const result = await runNoticingTick(h.deps);
    assert.equal(h.control.modelCalls, 1);
    assert.equal(h.asked.length, 0);
    assert.equal(result.produced, 0);
    assert.equal(h.state().decisionReuse, undefined);
    assert.equal(h.state().metrics.modelFailures, 0);
    assert.match(result.summary, mode === 'read unavailable' ? /could not be confirmed/ : /local context changed/);
    h.deps.publicationStillCurrent = () => true;
    h.control.now += 30 * MINUTE;
    const retried = await runNoticingTick(h.deps);
    assert.equal(retried.produced, 1);
    assert.equal(h.control.modelCalls, 2, 'only the next cadence retries the model');
  }
});

test('a stale quiet model answer cannot seed a successful-decision cache', async () => {
  const h = reuseHarness();
  h.deps.publicationStillCurrent = () => false;
  const result = await runNoticingTick(h.deps);
  assert.equal(result.produced, 0);
  assert.equal(h.control.modelCalls, 1);
  assert.equal(h.state().decisionReuse, undefined);
  assert.match(result.summary, /local context changed/);
});
