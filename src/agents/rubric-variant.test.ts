import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRubricVariant, DEFAULT_RUBRIC_VARIANT } from './rubric-variant.js';
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

const AVAILABLE = ['legacy'] as const;

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
