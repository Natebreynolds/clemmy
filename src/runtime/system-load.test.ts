import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  shouldDeferDiscretionaryWork,
  systemUnderContention,
  loadPerCore,
  MAX_CONSECUTIVE_DEFERRALS,
  _resetContentionStateForTest,
} from './system-load.js';

// 2026-09-10: a vault reindex and an embedding backfill ran while Zoom held
// ~80-100% CPU. Neither was urgent; together they blocked the loop long enough
// for the supervisor to kill the daemon as hung.

test('loadPerCore reports a finite ratio or null, never a bogus zero', () => {
  const v = loadPerCore();
  assert.ok(v === null || (Number.isFinite(v) && v > 0), `unexpected loadPerCore: ${v}`);
});

test('an unmeasurable load reads as NOT contended — work must never stop on a platform that cannot measure', () => {
  // Windows reports a load average of 0; that must mean "unknown", not "idle",
  // and critically must not be read as "contended" either.
  _resetContentionStateForTest();
  const contended = systemUnderContention();
  assert.equal(typeof contended, 'boolean');
});

test('deferral is bounded — courtesy must never become starvation', () => {
  _resetContentionStateForTest();
  process.env.CLEMMY_CONTENTION_THRESHOLD = '0.0001'; // force "contended"
  try {
    let deferred = 0;
    for (let i = 0; i < MAX_CONSECUTIVE_DEFERRALS + 5; i++) {
      if (shouldDeferDiscretionaryWork('unit-test-job')) deferred += 1;
      else break;
    }
    assert.equal(deferred, MAX_CONSECUTIVE_DEFERRALS,
      'after the cap the job must run even under sustained load');
  } finally {
    delete process.env.CLEMMY_CONTENTION_THRESHOLD;
    _resetContentionStateForTest();
  }
});

test('an idle machine never defers', () => {
  _resetContentionStateForTest();
  process.env.CLEMMY_CONTENTION_THRESHOLD = '100000'; // unreachable
  try {
    assert.equal(shouldDeferDiscretionaryWork('unit-test-job'), false);
    assert.equal(systemUnderContention(Date.now() + 10_000), false);
  } finally {
    delete process.env.CLEMMY_CONTENTION_THRESHOLD;
    _resetContentionStateForTest();
  }
});

test('the deferral counter resets once load clears', () => {
  _resetContentionStateForTest();
  process.env.CLEMMY_CONTENTION_THRESHOLD = '0.0001';
  assert.equal(shouldDeferDiscretionaryWork('job-a'), true);
  delete process.env.CLEMMY_CONTENTION_THRESHOLD;
  _resetContentionStateForTest();
  process.env.CLEMMY_CONTENTION_THRESHOLD = '100000';
  try {
    assert.equal(shouldDeferDiscretionaryWork('job-a'), false, 'a recovered machine starts fresh');
  } finally {
    delete process.env.CLEMMY_CONTENTION_THRESHOLD;
    _resetContentionStateForTest();
  }
});

test('jobs defer independently — one busy job must not spend another job\'s budget', () => {
  _resetContentionStateForTest();
  process.env.CLEMMY_CONTENTION_THRESHOLD = '0.0001';
  try {
    for (let i = 0; i < MAX_CONSECUTIVE_DEFERRALS; i++) shouldDeferDiscretionaryWork('job-a');
    assert.equal(shouldDeferDiscretionaryWork('job-a'), false, 'job-a exhausted its budget');
    assert.equal(shouldDeferDiscretionaryWork('job-b'), true, 'job-b still has its own');
  } finally {
    delete process.env.CLEMMY_CONTENTION_THRESHOLD;
    _resetContentionStateForTest();
  }
});

// ── The connection pin ──────────────────────────────────────────────────────
// Which work yields matters more than the mechanism. Deferring a reaper on a
// loaded machine would grow the database of a user already struggling — the
// exact opposite of the goal.
test('discretionary maintenance yields, but reaping and settlement never do', () => {
  const source = readFileSync(new URL('../memory/maintenance.ts', import.meta.url), 'utf8');
  const tick = source.slice(source.indexOf('export async function processMemoryMaintenance'));

  for (const job of ['vault-reindex', 'embedding-backfill', 'autoresearch', 'memory-md', 'skill-update']) {
    assert.match(tick, new RegExp(`shouldDeferDiscretionaryWork\\('${job}'\\)`),
      `${job} is discretionary and must yield under contention`);
  }

  // The reaper blocks must be reachable regardless of load.
  for (const reaper of [
    'EVENTLOG_REAPER_EVERY_N_TICKS',
    'EPISODIC_REAPER_EVERY_N_TICKS',
    'RECALL_REAPER_EVERY_N_TICKS',
    'LOCAL_AUDIO_DELETION_EVERY_N_TICKS',
  ]) {
    const guard = new RegExp(`tickCount % ${reaper} === 0[^)]*\\)`);
    const found = tick.match(guard);
    assert.ok(found, `${reaper} block not found`);
    assert.doesNotMatch(found[0], /shouldDeferDiscretionaryWork/,
      `${reaper} keeps the database bounded — deferring it under load makes a struggling machine worse`);
  }
});

test('the shared skill-update gate is evaluated once per tick, not once per call site', () => {
  const source = readFileSync(new URL('../memory/maintenance.ts', import.meta.url), 'utf8');
  const calls = source.match(/shouldDeferDiscretionaryWork\('skill-update'\)/g) ?? [];
  assert.equal(calls.length, 1,
    'three call sites sharing one key would spend three deferrals per tick and hit the cap in a third the time');
});
