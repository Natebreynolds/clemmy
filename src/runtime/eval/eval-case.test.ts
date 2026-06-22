/**
 * Run: npx tsx --test src/runtime/eval/eval-case.test.ts
 *
 * pass^k runner semantics (Lane A Phase 2). The honest distinction the runner
 * must encode: a case that passes 2/3 trials is pass@k TRUE but pass^k FALSE —
 * that 1/3 inconsistency is exactly the demo-to-prod gap pass@1 averaging hides.
 * A trial that THROWS is a failed trial (a crash is never a pass).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEvalSuite, type EvalCase } from './eval-case.js';

test('all-pass case → pass@k and pass^k both true', async () => {
  const cases: EvalCase[] = [{ id: 'always', run: async () => ({ pass: true, detail: 'ok' }) }];
  const r = await runEvalSuite(cases, { k: 5 });
  assert.equal(r.cases[0].passes, 5);
  assert.equal(r.cases[0].passAtK, true);
  assert.equal(r.cases[0].passHatK, true);
  assert.equal(r.passHatKRate, 1);
});

test('flaky case (passes only on even trials) → pass@k true but pass^k FALSE', async () => {
  let i = 0;
  const cases: EvalCase[] = [{
    id: 'flaky',
    run: async () => {
      const pass = i % 2 === 0; // trial 0,2,4 pass; 1,3 fail
      i += 1;
      return { pass, detail: pass ? 'ok' : 'flaked this trial' };
    },
  }];
  const r = await runEvalSuite(cases, { k: 5 });
  assert.equal(r.cases[0].passes, 3);
  assert.equal(r.cases[0].passAtK, true, 'pass@k credits the partial success');
  assert.equal(r.cases[0].passHatK, false, 'pass^k exposes the inconsistency');
  assert.equal(r.cases[0].firstFailDetail, 'flaked this trial');
});

test('throwing trial counts as a failed trial (crash is never a pass)', async () => {
  const cases: EvalCase[] = [{
    id: 'boom',
    run: async () => { throw new Error('kaboom'); },
  }];
  const r = await runEvalSuite(cases, { k: 3 });
  assert.equal(r.cases[0].passes, 0);
  assert.equal(r.cases[0].crashed, 3);
  assert.equal(r.cases[0].passHatK, false);
  assert.match(r.cases[0].firstFailDetail || '', /threw: kaboom/);
});

test('aggregate rates: mixed suite reports the fraction passing ALL trials', async () => {
  const cases: EvalCase[] = [
    { id: 'a', run: async () => ({ pass: true, detail: '' }) },
    { id: 'b', run: async () => ({ pass: true, detail: '' }) },
    { id: 'c', run: async () => ({ pass: false, detail: 'nope' }) },
    { id: 'd', run: async () => ({ pass: false, detail: 'nope' }) },
  ];
  const r = await runEvalSuite(cases, { k: 2 });
  assert.equal(r.passHatKRate, 0.5); // a,b pass all; c,d never
  assert.equal(r.passAtKRate, 0.5);
});
