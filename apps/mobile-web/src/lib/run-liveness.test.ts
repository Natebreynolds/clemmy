/**
 * A remembered run is never a live one.
 *
 * The defect these pin: /m/api/runs/:id keeps a last-good copy, and a run that
 * was RUNNING when that copy was taken still says "running" forever. Rendered
 * off `status` alone the phone showed a pulsing dot, an elapsed clock counting
 * up from a start time days old, and a live Stop button over a process it
 * could not reach — and, because the stamp was looked up under a different
 * spelling of the path, with no age banner above any of it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runDetailPath } from './api';
import { forgetLastGoodStamps, lastGoodAt, noteLastGood } from './last-good';
import { runElapsedLabel, runIsLive } from './run-liveness';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('a stamped copy of a running run is not live', () => {
  assert.equal(runIsLive({ status: 'running', stampedAt: null }), true);
  assert.equal(runIsLive({ status: 'awaiting_input', stampedAt: null }), true);
  assert.equal(
    runIsLive({ status: 'running', stampedAt: '2026-09-01T09:00:00.000Z' }),
    false,
    'a copy taken days ago cannot be evidence of what is happening now',
  );
  assert.equal(runIsLive({ status: 'completed', stampedAt: null }), false);
  assert.equal(runIsLive({ status: undefined, stampedAt: null }), false);
});

test('an elapsed clock needs an end point, and says nothing without one', () => {
  const started = Date.parse('2026-09-06T12:00:00.000Z');
  const now = started + 125_000;
  assert.equal(runElapsedLabel({ startedAt: started, lastEventAt: null, live: true, nowMs: now }), '2m 5s');
  assert.equal(
    runElapsedLabel({ startedAt: started, lastEventAt: started + 30_000, live: false, nowMs: now }),
    '30s',
    'a settled run measures to its last event, not to the clock',
  );
  // The remembered running run: not live, and no last event to measure to.
  assert.equal(
    runElapsedLabel({ startedAt: started, lastEventAt: null, live: false, nowMs: now + 86_400_000 }),
    null,
    'no honest end point means no number at all — never a clock ticking from days ago',
  );
  assert.equal(runElapsedLabel({ startedAt: null, lastEventAt: 1, live: false, nowMs: now }), null);
});

test('the stamp is keyed by the SAME path the fetch used', () => {
  // `background:task-1` — exactly the run a push addresses — was stored under
  // the encoded path and looked up raw, so the banner never rendered.
  forgetLastGoodStamps();
  const sessionId = 'background:task-1';
  noteLastGood(runDetailPath(sessionId), '2026-09-06T06:00:00.000Z');
  assert.equal(runDetailPath(sessionId), '/m/api/runs/background%3Atask-1');
  assert.equal(lastGoodAt(runDetailPath(sessionId)), '2026-09-06T06:00:00.000Z');
  assert.equal(
    lastGoodAt(`/m/api/runs/${sessionId}`),
    null,
    'the raw spelling is a different key — which is why nobody may write it by hand',
  );
  forgetLastGoodStamps();
});

test('the run screen derives liveness, and offers Stop only on a live run', () => {
  const run = read('../screens/Run.tsx');
  assert.match(run, /const stampedAt = lastGoodAt\(runDetailPath\(sessionId\)\);/,
    'one spelling of the path, shared with getRun');
  assert.match(run, /const live = runIsLive\(\{ status: run\?\.status, stampedAt \}\);/,
    'status alone must not certify liveness');
  assert.doesNotMatch(run, /isActiveRunStatus\(run\.status\)/,
    'the status-only derivation must not come back');
  assert.match(run, /const elapsedLabel = run\s*\n?\s*\? runElapsedLabel\(/);
  assert.match(run, /\{live \? <RunControl target=/, 'Stop is gated on the derived liveness');
  assert.match(run, /lastGood=\{lastGoodNotice\(stampedAt, Date\.now\(\)\)\}/,
    'the banner reads the same stamp the liveness gate does');
});
