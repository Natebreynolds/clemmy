/**
 * Jev-first trajectory review: a confident on-track reading from Jev settles
 * the window without the flagship watcher; drift, low confidence or silence
 * escalates to the configured watcher exactly as before, with Jev kept as the
 * shadow so the agreement measurement continues.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-watcher-jev-first-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { runWatcherJudge, JEV_TRAJECTORY_TRUST_MIN } = await import('./watcher-judge.js');
const { closeEventLog } = await import('./eventlog.js');
after(() => { closeEventLog(); rmSync(TMP_HOME, { recursive: true, force: true }); });

const input = {
  objective: 'Draft three cold prospect emails for review, nothing sent.',
  toolCallSummary: 'skill_read → ok; read_file ×6 → ok; run_worker ×3 → started',
  latestAssistantNote: 'Workers are drafting; I will review each against the checklist.',
  toolCallCount: 10,
  sourceEvidence: 'UNIQUE-EVIDENCE: three drafts pending',
};

function flagship(verdict: { onTrack: boolean; miss?: string; steer?: string }) {
  const calls: string[] = [];
  const hedgedJudge = (async (_instructions: string, prompt: string) => {
    calls.push(prompt);
    return { value: { onTrack: verdict.onTrack, miss: verdict.miss ?? '', steer: verdict.steer ?? '' }, failure: null,
      routing: { model: null, modelId: 'fixture-flagship', judgeFamily: 'claude', brainFamily: 'byo', selfJudge: false, ownerSelectedJudge: true } };
  }) as unknown as NonNullable<Parameters<typeof runWatcherJudge>[1]>['hedgedJudge'];
  return { calls, hedgedJudge };
}

test('a confident on-track reading from Jev settles the window without the flagship watcher', async () => {
  const { calls, hedgedJudge } = flagship({ onTrack: true });
  const verdict = await runWatcherJudge(input, {
    hedgedJudge,
    jev: async () => ({ onTrack: true, confidence: 0.93, model: 'jev-fixture', durationMs: 120 }),
  });
  assert.ok(verdict);
  assert.equal(verdict.onTrack, true);
  assert.equal(verdict.decidedBy, 'jev');
  assert.deepEqual(verdict.review, { modelId: 'jev-fixture', provider: 'jev' });
  assert.equal(verdict.jevShadow?.agrees, true);
  assert.equal(verdict.coverage, undefined, 'Jev did not read the evidence bytes, so the window is not marked covered');
  assert.equal(calls.length, 0, 'no flagship call');
});

for (const [label, jev] of [
  ['drift', async () => ({ onTrack: false, confidence: 0.9, model: 'jev-fixture', durationMs: 100 })],
  ['low confidence', async () => ({ onTrack: true, confidence: JEV_TRAJECTORY_TRUST_MIN - 0.01, model: 'jev-fixture', durationMs: 100 })],
  ['silence', async () => null],
  ['failure', async () => { throw new Error('jev down'); }],
] as const) test(`Jev ${label} hands the window to the configured watcher with the shadow recorded`, async () => {
  const { calls, hedgedJudge } = flagship({ onTrack: false, miss: 'no drafts yet', steer: 'wait for the workers' });
  const verdict = await runWatcherJudge(input, { hedgedJudge, jev: jev as never });
  assert.ok(verdict, 'the flagship verdict is returned');
  assert.equal(calls.length, 1, 'exactly one flagship call');
  assert.match(calls[0]!, /UNIQUE-EVIDENCE/, 'the flagship reads the evidence bytes');
  assert.equal(verdict.decidedBy, 'watcher');
  assert.equal(verdict.onTrack, false);
  assert.equal(verdict.review?.modelId, 'fixture-flagship');
  assert.equal(verdict.coverage?.complete, true);
  if (label === 'drift') assert.equal(verdict.jevShadow?.agrees, true);
  if (label === 'low confidence') assert.equal(verdict.jevShadow?.agrees, false);
  if (label === 'silence' || label === 'failure') assert.equal(verdict.jevShadow, undefined);
});
