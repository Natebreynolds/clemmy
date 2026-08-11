import assert from 'node:assert/strict';
import test from 'node:test';

import { DIRTY_DEV_EVIDENCE_BANNER, decideProofSourceGuard } from './source-guard.js';

test('clean source remains release evidence without an override', () => {
  assert.deepEqual(decideProofSourceGuard('', false), {
    allowed: true,
    sourceClean: true,
    devEvidence: false,
  });
});

test('dirty source remains fail-closed by default', () => {
  const decision = decideProofSourceGuard(' M src/runtime/example.ts', false);
  assert.equal(decision.allowed, false);
  assert.equal(decision.sourceClean, false);
  assert.equal(decision.devEvidence, false);
  if (decision.allowed) assert.fail('dirty source must not be allowed without the development flag');
  assert.match(decision.error, /requires one reproducible candidate commit/);
  assert.match(decision.error, /src\/runtime\/example\.ts/);
});

test('explicit dirty development mode is allowed but cannot become release evidence', () => {
  const decision = decideProofSourceGuard(' M scripts/proof/run-proof.ts', true);
  assert.equal(decision.allowed, true);
  assert.equal(decision.sourceClean, false);
  assert.equal(decision.devEvidence, true);
  if (!decision.allowed || !decision.devEvidence) assert.fail('dirty development mode must carry its warning');
  assert.equal(decision.warning, DIRTY_DEV_EVIDENCE_BANNER);
  assert.match(decision.warning, /DEV EVIDENCE ONLY/);
  assert.match(decision.warning, /sourceClean=false/);
});

test('development flag does not downgrade clean source evidence', () => {
  assert.deepEqual(decideProofSourceGuard('\n  ', true), {
    allowed: true,
    sourceClean: true,
    devEvidence: false,
  });
});
