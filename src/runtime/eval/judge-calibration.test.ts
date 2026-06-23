/**
 * Run: npx tsx --test src/runtime/eval/judge-calibration.test.ts
 *
 * Judge calibration (Lane A trust-layer P3): the PURE deterministic core —
 * Cohen's κ math + the gold-set's structural integrity + a byte-stable snapshot
 * guard so any edit to the human labels is a reviewable diff (no silent gold-set
 * drift / eval over-fitting). The LIVE cross-family κ measurement itself runs in
 * scripts/measure-judge-calibration.ts (needs model creds).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { cohensKappa, kappaBand, KAPPA_GATE, type GoldSet, type Label } from './judge-calibration.js';

// ─── Cohen's κ ────────────────────────────────────────────────────

const rows = (a: number, b: number, c: number, d: number): Array<{ human: Label; judge: Label }> => [
  ...Array(a).fill({ human: 'pass', judge: 'pass' }),
  ...Array(b).fill({ human: 'pass', judge: 'fail' }),
  ...Array(c).fill({ human: 'fail', judge: 'pass' }),
  ...Array(d).fill({ human: 'fail', judge: 'fail' }),
];

test('cohensKappa: perfect agreement → κ=1', () => {
  assert.equal(cohensKappa(rows(10, 0, 0, 10)).kappa, 1);
});

test('cohensKappa: chance-level agreement → κ=0', () => {
  const r = cohensKappa(rows(5, 5, 5, 5));
  assert.equal(r.po, 0.5);
  assert.equal(r.pe, 0.5);
  assert.equal(r.kappa, 0);
});

test('cohensKappa: 80% agreement on a balanced set → κ=0.6 (the gate floor)', () => {
  const r = cohensKappa(rows(8, 2, 2, 8));
  assert.equal(r.po, 0.8);
  assert.ok(Math.abs(r.kappa - 0.6) < 1e-9, `κ=${r.kappa}`);
  assert.ok(r.kappa >= KAPPA_GATE);
});

test('cohensKappa: degenerate single-category → κ=1 only on perfect agreement', () => {
  assert.equal(cohensKappa(rows(10, 0, 0, 0)).kappa, 1, 'all pass/pass → perfect');
  // human all-pass, judge all-fail: po=0, pe=0 → not perfect → 0
  assert.equal(cohensKappa(rows(0, 10, 0, 0)).kappa, 0);
});

test('cohensKappa: empty → NaN; kappaBand labels the ranges', () => {
  assert.ok(Number.isNaN(cohensKappa([]).kappa));
  assert.equal(kappaBand(1), 'almost-perfect');
  assert.equal(kappaBand(0.7), 'substantial');
  assert.equal(kappaBand(0.5), 'moderate');
  assert.equal(kappaBand(-0.1), 'worse-than-chance');
});

// ─── Gold set: structure + byte-stable snapshot guard ─────────────

const GOLD_PATH = fileURLToPath(new URL('./gold/judge-gold-set.json', import.meta.url));
const GOLD_RAW = readFileSync(GOLD_PATH, 'utf8');
const sha16 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

// Edit the gold set deliberately? Update these two numbers — the diff IS the review.
const GOLDEN = { len: 4827, sha16: '302dba7dc6cb6575' };

test('gold set: byte-stable snapshot (a label edit must be an intentional, reviewed diff)', () => {
  assert.equal(GOLD_RAW.length, GOLDEN.len, `gold-set length changed (now ${GOLD_RAW.length})`);
  assert.equal(sha16(GOLD_RAW), GOLDEN.sha16, `gold-set content changed (now sha16 ${sha16(GOLD_RAW)})`);
});

test('gold set: every case is well-formed and labels are balanced enough to compute κ', () => {
  const gold = JSON.parse(GOLD_RAW) as GoldSet;
  assert.ok(gold.version >= 1 && Array.isArray(gold.cases) && gold.cases.length >= 5);
  const judges = new Set(['grounding', 'goal_fidelity', 'numeric_grounding']);
  const ids = new Set<string>();
  for (const c of gold.cases) {
    assert.ok(c.id && !ids.has(c.id), `duplicate/missing id: ${c.id}`);
    ids.add(c.id);
    assert.ok(judges.has(c.judge), `bad judge kind: ${c.judge}`);
    assert.ok(c.humanLabel === 'pass' || c.humanLabel === 'fail', `bad label: ${c.humanLabel}`);
    assert.ok(c.input && typeof c.input === 'object', `case ${c.id} missing input`);
  }
  const passes = gold.cases.filter((c) => c.humanLabel === 'pass').length;
  const fails = gold.cases.length - passes;
  assert.ok(passes > 0 && fails > 0, 'need both labels present to measure agreement');
});
