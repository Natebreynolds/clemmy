import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const GOAL = readFileSync(new URL('./goal-fidelity-gate.ts', import.meta.url), 'utf8');
const GROUND = readFileSync(new URL('./output-grounding-gate.ts', import.meta.url), 'utf8');

// C11 exposed BoundaryJudgeRouting.timeoutMs for an honoured exact pin, but both
// gates called withJudgeHedge(primary, hedge) with NO options, so the hedge fell
// back to boundaryJudgeTimeoutMs() (25s, sized for a cheap checker). A pinned
// flagship judge therefore still raced the short deadline and timed out into
// fail-open — indistinguishable to the owner from "the flagship judged and
// agreed". Naming the model without granting the time is not an exact-model fix.
for (const [name, src] of [['goal-fidelity-gate', GOAL], ['output-grounding-gate', GROUND]] as const) {
  test(`${name} passes the routing deadline to withJudgeHedge`, () => {
    assert.match(
      src,
      /withJudgeHedge\(\s*attempt\(routing\),\s*hedgeRouting \? attempt\(hedgeRouting\) : null,\s*routing\.timeoutMs \? \{ timeoutMs: routing\.timeoutMs \} : \{\},\s*\)/,
      'the honoured exact-pin deadline must reach the hedge',
    );
  });

  test(`${name} no longer calls withJudgeHedge with no options`, () => {
    assert.ok(
      !/withJudgeHedge\(attempt\(routing\), hedgeRouting \? attempt\(hedgeRouting\) : null\);/.test(src),
      'the two-argument call would silently reinstate the 25s default',
    );
  });

  test(`${name} falls back to the default when no exact pin is present`, () => {
    // routing.timeoutMs is only set for an honoured pin; absent it we must pass
    // {} so withJudgeHedge keeps boundaryJudgeTimeoutMs() for ordinary judges.
    assert.match(src, /routing\.timeoutMs \? \{ timeoutMs: routing\.timeoutMs \} : \{\}/);
  });
}
