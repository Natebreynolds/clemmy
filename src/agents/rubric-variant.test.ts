import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRubricVariant, DEFAULT_RUBRIC_VARIANT, assignRubricArm } from './rubric-variant.js';
import { selectOrchestratorRubric, RUBRIC_INSTRUCTIONS_BY_VARIANT, ORCHESTRATOR_INSTRUCTIONS } from './orchestrator.js';

function withVariant(value: string | undefined, fn: () => void): void {
  const prev = process.env.CLEMMY_RUBRIC_VARIANT;
  if (value === undefined) delete process.env.CLEMMY_RUBRIC_VARIANT;
  else process.env.CLEMMY_RUBRIC_VARIANT = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_RUBRIC_VARIANT;
    else process.env.CLEMMY_RUBRIC_VARIANT = prev;
  }
}

/** Set the live-A/B env (kill-switch + optional ratio), restoring after. */
function withAb(opts: { on: boolean; ratio?: string }, fn: () => void): void {
  const prevOn = process.env.CLEMMY_RUBRIC_VARIANT_AB;
  const prevRatio = process.env.CLEMMY_RUBRIC_VARIANT_AB_RATIO;
  process.env.CLEMMY_RUBRIC_VARIANT_AB = opts.on ? 'on' : '';
  if (opts.ratio !== undefined) process.env.CLEMMY_RUBRIC_VARIANT_AB_RATIO = opts.ratio;
  try {
    fn();
  } finally {
    if (prevOn === undefined) delete process.env.CLEMMY_RUBRIC_VARIANT_AB; else process.env.CLEMMY_RUBRIC_VARIANT_AB = prevOn;
    if (prevRatio === undefined) delete process.env.CLEMMY_RUBRIC_VARIANT_AB_RATIO; else process.env.CLEMMY_RUBRIC_VARIANT_AB_RATIO = prevRatio;
  }
}

const AVAILABLE = ['legacy'] as const;
const BOTH = ['legacy', 'lean'] as const;

test('resolveRubricVariant: unset → the proven default, no fallback flag', () => {
  withVariant(undefined, () => {
    const r = resolveRubricVariant(AVAILABLE);
    assert.equal(r.variant, DEFAULT_RUBRIC_VARIANT);
    assert.equal(r.requested, DEFAULT_RUBRIC_VARIANT);
    assert.equal(r.fellBack, false);
  });
});

test('resolveRubricVariant: explicit legacy is honored, no fallback', () => {
  withVariant('legacy', () => {
    const r = resolveRubricVariant(AVAILABLE);
    assert.equal(r.variant, 'legacy');
    assert.equal(r.fellBack, false);
  });
});

test('resolveRubricVariant: unknown/unimplemented value falls back to legacy OBSERVABLY', () => {
  withVariant('lean', () => {
    const r = resolveRubricVariant(AVAILABLE); // 'lean' not yet implemented
    assert.equal(r.variant, 'legacy');
    assert.equal(r.requested, 'lean');
    assert.equal(r.fellBack, true, 'a requested-but-missing variant must be observable, never silent');
  });
});

test('resolveRubricVariant: a registered non-default variant is selected', () => {
  withVariant('lean', () => {
    const r = resolveRubricVariant(['legacy', 'lean']);
    assert.equal(r.variant, 'lean');
    assert.equal(r.fellBack, false);
  });
});

test('resolveRubricVariant: case-insensitive + trims whitespace', () => {
  withVariant('  LEGACY  ', () => {
    assert.equal(resolveRubricVariant(AVAILABLE).variant, 'legacy');
  });
});

test('selectOrchestratorRubric: DEFAULT is byte-identical to the legacy rubric (no behavior change)', () => {
  withVariant(undefined, () => {
    const sel = selectOrchestratorRubric();
    assert.equal(sel.variant, 'legacy');
    assert.equal(sel.fellBack, false);
    assert.equal(sel.instructions, ORCHESTRATOR_INSTRUCTIONS, 'default must select the unchanged 34KB rubric');
  });
});

test('selectOrchestratorRubric: an unknown variant still serves the legacy rubric (fail-safe)', () => {
  withVariant('does-not-exist', () => {
    const sel = selectOrchestratorRubric();
    assert.equal(sel.instructions, ORCHESTRATOR_INSTRUCTIONS);
    assert.equal(sel.fellBack, true);
  });
});

test('registry: legacy is always present and maps to the canonical rubric', () => {
  assert.equal(RUBRIC_INSTRUCTIONS_BY_VARIANT.legacy, ORCHESTRATOR_INSTRUCTIONS);
});

// ─── Live A/B: per-session arm bucketing (CLEMMY_RUBRIC_VARIANT_AB) ───

test('assignRubricArm: deterministic + stable for the same session', () => {
  withAb({ on: true }, () => {
    assert.equal(assignRubricArm('sess-abc'), assignRubricArm('sess-abc'), 'same session → same arm');
  });
});

test('assignRubricArm: ratio extremes route every session one way', () => {
  withAb({ on: true, ratio: '1' }, () => {
    for (const s of ['a', 'b', 'c', 'd']) assert.equal(assignRubricArm(s), 'lean', 'ratio 1 → all lean');
  });
  withAb({ on: true, ratio: '0' }, () => {
    for (const s of ['a', 'b', 'c', 'd']) assert.equal(assignRubricArm(s), 'legacy', 'ratio 0 → all legacy');
  });
});

test('assignRubricArm: ~50/50 split over many sessions at the default ratio', () => {
  withAb({ on: true }, () => {
    let lean = 0;
    const N = 400;
    for (let i = 0; i < N; i++) if (assignRubricArm(`session-${i}`) === 'lean') lean++;
    const frac = lean / N;
    assert.ok(frac > 0.4 && frac < 0.6, `expected ~50/50, got ${(frac * 100).toFixed(0)}% lean`);
  });
});

test('resolveRubricVariant: A/B on + session governs and OVERRIDES the global flag', () => {
  // Global flag says legacy, but a session bucketed to lean must serve lean.
  withVariant('legacy', () => {
    withAb({ on: true, ratio: '1' }, () => {
      const r = resolveRubricVariant(BOTH, 'sess-x');
      assert.equal(r.variant, 'lean');
      assert.equal(r.experiment, true);
      assert.equal(r.arm, 'lean');
      assert.equal(r.fellBack, false);
    });
  });
});

test('resolveRubricVariant: A/B on but NO session → the global flag governs (no experiment)', () => {
  withVariant('legacy', () => {
    withAb({ on: true, ratio: '1' }, () => {
      const r = resolveRubricVariant(BOTH); // no sessionId
      assert.equal(r.experiment, false);
      assert.equal(r.arm, null);
      assert.equal(r.variant, 'legacy');
    });
  });
});

test('resolveRubricVariant: A/B never buckets into an UNAVAILABLE arm', () => {
  // 'lean' not registered → experiment must NOT activate (no broken arm), global governs.
  withAb({ on: true, ratio: '1' }, () => {
    const r = resolveRubricVariant(AVAILABLE, 'sess-x');
    assert.equal(r.experiment, false);
    assert.equal(r.variant, 'legacy');
  });
});

test('resolveRubricVariant: A/B OFF → byte-identical to the global-flag path', () => {
  withVariant('legacy', () => {
    withAb({ on: false }, () => {
      const r = resolveRubricVariant(BOTH, 'sess-x');
      assert.equal(r.experiment, false);
      assert.equal(r.arm, null);
      assert.equal(r.variant, 'legacy');
    });
  });
});

test('selectOrchestratorRubric: under the A/B, the session arm picks the instructions', () => {
  withAb({ on: true, ratio: '1' }, () => {
    const sel = selectOrchestratorRubric('sess-x');
    assert.equal(sel.arm, 'lean');
    assert.equal(sel.experiment, true);
    assert.equal(sel.variant, 'lean');
    assert.notEqual(sel.instructions, ORCHESTRATOR_INSTRUCTIONS, 'lean arm serves the lean rubric, not the 34KB legacy one');
  });
  withAb({ on: true, ratio: '0' }, () => {
    const sel = selectOrchestratorRubric('sess-x');
    assert.equal(sel.arm, 'legacy');
    assert.equal(sel.instructions, ORCHESTRATOR_INSTRUCTIONS, 'legacy arm serves the proven rubric');
  });
});
