/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/runtime/semantic-boundary/provider-changed-before-freeze.red.test.ts
 *
 * OPEN-THE-GATES Slice 6. Stage-2 still refused
 * "disclosed provider capability changed before plan freeze" and
 * "selected capability was not current at plan freeze" after G14 converted
 * the selected-absent case to an advisory. That churn is host-internal
 * (readiness recompute, successor id). The write seam re-proves.
 *
 * Re-break two ways:
 *   (i)  restore the plan refusal for provider-changed
 *   (ii) restore the plan refusal for selected-not-current
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const ADMIT = new URL('./admit-and-compile-accepted-source.ts', import.meta.url);

test('NEGATIVE: a disclosed provider that changed before freeze is annotated, not refused', () => {
  const src = readFileSync(ADMIT, 'utf8');
  assert.doesNotMatch(
    src,
    /return \{ ok: false, reason: 'disclosed provider capability changed before plan freeze' \}/,
  );
  assert.match(
    src,
    /changed_shape_between_disclosure_and_admission/,
  );
});

test('NEGATIVE: a selected capability missing from canonicalCapabilities is kept, not refused', () => {
  const src = readFileSync(ADMIT, 'utf8');
  assert.doesNotMatch(
    src,
    /return \{ ok: false, reason: 'selected capability was not current at plan freeze' \}/,
  );
  assert.match(
    src,
    /for \(const ref of selectedPrimaryCapabilityRefs\)/,
  );
});

test('re-break (i): the old provider-changed branch was a plan refusal', () => {
  const src = readFileSync(ADMIT, 'utf8');
  assert.match(
    src,
    /Host-internal churn/,
  );
  assert.match(
    src,
    /canonicalCapabilities\.push\(current \?\? descriptor\)/,
  );
});

test('re-break (ii): selected-not-current keeps the disclosed descriptor', () => {
  const src = readFileSync(ADMIT, 'utf8');
  assert.match(
    src,
    /canonicalCapabilities\.push\(disclosed\)/,
  );
});

test('NEGATIVE: missing staged Composio definition is skipped, not a plan refusal', () => {
  const src = readFileSync(ADMIT, 'utf8');
  assert.doesNotMatch(
    src,
    /return \{ ok: false, reason: 'selected Composio capability lacks its exact staged provider definition' \}/,
  );
  assert.match(src, /if \(!definition\) return \[\]/);
});

test('NEGATIVE: local planning definition lost or changed is annotated, not refused', () => {
  const src = readFileSync(ADMIT, 'utf8');
  assert.doesNotMatch(
    src,
    /return \{ ok: false, reason: 'selected local capability lost its sealed planning definition' \}/,
  );
  assert.doesNotMatch(
    src,
    /return \{ ok: false, reason: 'disclosed local capability changed before plan freeze' \}/,
  );
});
