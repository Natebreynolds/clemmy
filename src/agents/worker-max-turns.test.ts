/**
 * Run: npx tsx --test src/agents/worker-max-turns.test.ts
 *
 * Intent-aware worker turn cap (the fix for the 2026-06-22 N=3 fan-out respawn
 * loop where every per-client research worker hit the turn cap). Pure unit on
 * resolveWorkerMaxTurns — deterministic, no agent build. The crux: `intent` is
 * FREE-FORM (z.string().min(1).nullable()), so the bump is a case-insensitive
 * substring match, NEVER an enum; widening only ever RAISES (the env base floors
 * it); unknown/null intents keep the base.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkerMaxTurns } from './worker-job-packet.js';

test('heavy intents get headroom above the base (finish on first attempt)', () => {
  assert.equal(resolveWorkerMaxTurns('research', 12), 18);
  assert.equal(resolveWorkerMaxTurns('analysis', 12), 18);
  assert.equal(resolveWorkerMaxTurns('analyze', 8), 18);
  assert.equal(resolveWorkerMaxTurns('code', 8), 18);
  assert.equal(resolveWorkerMaxTurns('design', 8), 18);
});

test('the env base FLOORS the value — widening never lowers it', () => {
  // base already >= the heavy ceiling → base wins (no lowering)
  assert.equal(resolveWorkerMaxTurns('research', 20), 20);
  assert.equal(resolveWorkerMaxTurns('research', 18), 18);
});

test('null / unknown free-form intents keep the base (NOT an enum)', () => {
  assert.equal(resolveWorkerMaxTurns(null, 12), 12);
  assert.equal(resolveWorkerMaxTurns(undefined, 8), 8);
  assert.equal(resolveWorkerMaxTurns('', 12), 12);
  assert.equal(resolveWorkerMaxTurns('classify', 12), 12);
  assert.equal(resolveWorkerMaxTurns('fetch', 8), 8);
  assert.equal(resolveWorkerMaxTurns('seo', 12), 12, 'an unconventional word falls to base; widening is additive');
});

test('case-insensitive + substring match (free-form phrasing)', () => {
  assert.equal(resolveWorkerMaxTurns('Research', 12), resolveWorkerMaxTurns('research', 12));
  assert.equal(resolveWorkerMaxTurns('  RESEARCH ', 12), 18);
  assert.equal(resolveWorkerMaxTurns('competitive analysis', 12), 18, 'substring match on "analysis"');
  assert.equal(resolveWorkerMaxTurns('deep research task', 8), 18);
});
