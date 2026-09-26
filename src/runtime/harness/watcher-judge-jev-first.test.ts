/**
 * The trajectory watcher runs on Jev alone (owner decision 2026-09-25): the
 * flagship watcher cost about $15 on 09-24 and delivered no steer on 09-25.
 * A confident on-track reading settles the window, a confident drift reading
 * becomes one host steer toward the goal, and anything less says nothing.
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
  sourceEvidence: 'three drafts pending',
};

test('a confident on-track reading from Jev settles the window', async () => {
  const verdict = await runWatcherJudge(input, {
    jev: async () => ({ onTrack: true, confidence: 0.93, model: 'jev-fixture', durationMs: 120 }),
  });
  assert.deepEqual(verdict, {
    onTrack: true, miss: '', steer: '', decidedBy: 'jev', review: { modelId: 'jev-fixture', provider: 'jev' },
  });
});

test('a confident drift reading becomes one steer toward the goal, shaped by how the work drifted', async () => {
  const verdict = await runWatcherJudge(input, {
    jev: async () => ({ onTrack: false, confidence: 0.91, model: 'jev-fixture', durationMs: 90, driftKind: 'repeating' as const }),
  });
  assert.equal(verdict?.onTrack, false);
  assert.equal(verdict?.decidedBy, 'jev');
  assert.match(verdict?.steer ?? '', /Stop retrying it/);
  assert.match(verdict?.steer ?? '', /Draft three cold prospect emails/, 'the steer names the goal');
  assert.ok(verdict?.miss);
  const unnamed = await runWatcherJudge(input, {
    jev: async () => ({ onTrack: false, confidence: 0.9, model: 'jev-fixture', durationMs: 90 }),
  });
  assert.match(unnamed?.steer ?? '', /Re-read it before continuing/);
});

for (const [label, jev, reason] of [
  ['an unsure on-track reading', async () => ({ onTrack: true, confidence: JEV_TRAJECTORY_TRUST_MIN - 0.01, model: 'jev-fixture', durationMs: 100 }), 'watcher_jev_unsure'],
  ['an unsure drift reading', async () => ({ onTrack: false, confidence: 0.6, model: 'jev-fixture', durationMs: 100 }), 'watcher_jev_unsure'],
  ['silence', async () => null, 'watcher_jev_unavailable'],
  ['a failure', async () => { throw new Error('jev down'); }, 'watcher_jev_unavailable'],
] as const) test(`${label} says nothing and leaves the window for the next check`, async () => {
  let unavailable = '';
  const verdict = await runWatcherJudge({ ...input, onUnavailable: (why: string) => { unavailable = why; } }, { jev: jev as never });
  assert.equal(verdict, null);
  assert.equal(unavailable, reason);
});
