/**
 * Run: npx tsx --test src/agents/surface-decision.test.ts
 *
 * Lane E Phase 1 — the "when to stay silent" scorer. Deterministic: the same
 * signal always yields the same decision. The make-or-break behaviors: a
 * low-salience promo is IGNORED (anti-firehose); a confident, safe, worthwhile
 * signal is ACTed; a worthwhile but risky/uncertain one is ASKed; a high-risk
 * time-critical clash is ESCALATEd; the moderate middle is WATCHed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideSurface, shouldSurface, type SurfaceSignal } from './surface-decision.js';

const sig = (p: Partial<SurfaceSignal>): SurfaceSignal => ({
  urgency: 0, impact: 0, novelty: 0, risk: 0, confidence: 0, specificity: 0, conflict: 0, ...p,
});

test('low salience (a promo) → ignore (anti-firehose), and does NOT surface', () => {
  const v = decideSurface(sig({ urgency: 0.1, impact: 0.1, novelty: 0.1 }));
  assert.equal(v.decision, 'ignore');
  assert.equal(shouldSurface(v.decision), false);
});

test('confident + low-risk + worthwhile → act (done silently, reported)', () => {
  const v = decideSurface(sig({ urgency: 0.6, impact: 0.7, specificity: 0.8, confidence: 0.9, risk: 0.1 }));
  assert.equal(v.decision, 'act');
  assert.equal(shouldSurface(v.decision), false, 'act is silent + reported, not an interrupt');
});

test('worthwhile but RISKY (irreversible) → ask (surfaces)', () => {
  const v = decideSurface(sig({ urgency: 0.6, impact: 0.7, specificity: 0.8, confidence: 0.9, risk: 0.6 }));
  assert.equal(v.decision, 'ask');
  assert.equal(shouldSurface(v.decision), true);
});

test('worthwhile but LOW-confidence → ask (not act)', () => {
  const v = decideSurface(sig({ urgency: 0.6, impact: 0.7, specificity: 0.8, confidence: 0.3, risk: 0.1 }));
  assert.equal(v.decision, 'ask');
});

test('high-risk AND time-critical → escalate (surface now)', () => {
  const v = decideSurface(sig({ urgency: 0.9, impact: 0.8, risk: 0.8, confidence: 0.6 }));
  assert.equal(v.decision, 'escalate');
  assert.equal(shouldSurface(v.decision), true);
});

test('moderate salience (in [0.25,0.40)) → watch (not surfaced yet)', () => {
  // salience = .30*.5 + .30*.4 + .10*.1 = 0.28 — above the ignore floor, below
  // the act/ask line, low risk + low confidence so neither escalate nor act.
  const v = decideSurface(sig({ urgency: 0.5, impact: 0.4, novelty: 0.1 }));
  assert.equal(v.decision, 'watch');
  assert.equal(shouldSurface(v.decision), false);
});

test('deterministic: same signal → same decision', () => {
  const s = sig({ urgency: 0.6, impact: 0.7, specificity: 0.8, confidence: 0.9, risk: 0.1 });
  assert.equal(decideSurface(s).decision, decideSurface(s).decision);
});

test('out-of-range axes are clamped (no NaN/overflow decision)', () => {
  const v = decideSurface(sig({ urgency: 5, impact: -2, confidence: 99, risk: -1 }));
  assert.ok(['act', 'ask', 'watch', 'ignore', 'escalate'].includes(v.decision));
  assert.ok(v.salience >= 0 && v.salience <= 1);
});
