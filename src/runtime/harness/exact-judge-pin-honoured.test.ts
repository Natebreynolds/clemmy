import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downshiftForBoundary } from './debate-model.js';
import { exactJudgeBoundaryTimeoutMs, boundaryJudgeTimeoutMs } from './judge-family.js';
import type { ResolvedRoleModel } from './model-roles.js';

const role = (over: Partial<ResolvedRoleModel>): ResolvedRoleModel => ({
  modelId: 'claude-opus-5', provider: 'claude', source: 'settings', ...over,
} as ResolvedRoleModel);

// Owner requirement (checkpoint 2026-09-06T03:46Z): Opus 5 must actually judge.
// downshiftForBoundary previously rewrote ANY heavyweight to the cheap boundary
// model, so an explicit pin could never take effect and a role label was not
// evidence of what ran.
test('an explicit owner pin on a flagship judge is honoured exactly', () => {
  for (const source of ['settings', 'chat-rule', 'session', 'policy'] as const) {
    const out = downshiftForBoundary(role({ source }));
    assert.equal(out.modelId, 'claude-opus-5', `${source} pin must not be substituted`);
    assert.equal(out.exactHeavyweightPin, true, `${source} pin must be marked for the extended deadline`);
  }
});

// The 2026-07-07 incident (pinned opus rode every hot-path call -> 80/84
// timeouts -> send-burst gate fail-closed, 10 approved emails parked) is the
// reason the downshift exists. A DEFAULT landing on a flagship is not a
// deliberate choice and must still be downshifted.
test('a DEFAULT resolution to a flagship is still downshifted', () => {
  const out = downshiftForBoundary(role({ source: 'default' }));
  assert.notEqual(out.modelId, 'claude-opus-5', 'default must not ride the hot path on a flagship');
  assert.ok(!out.exactHeavyweightPin);
});

test('a codex flagship default is downshifted; an explicit codex pin is honoured', () => {
  const dflt = downshiftForBoundary(role({ modelId: 'gpt-5.6', provider: 'codex', source: 'default' }));
  assert.notEqual(dflt.modelId, 'gpt-5.6');
  const pinned = downshiftForBoundary(role({ modelId: 'gpt-5.6', provider: 'codex', source: 'settings' }));
  assert.equal(pinned.modelId, 'gpt-5.6');
  assert.equal(pinned.exactHeavyweightPin, true);
});

test('non-heavyweight judges are untouched regardless of source', () => {
  for (const source of ['default', 'settings'] as const) {
    const out = downshiftForBoundary(role({ modelId: 'claude-haiku-4-5', source }));
    assert.equal(out.modelId, 'claude-haiku-4-5');
    assert.ok(!out.exactHeavyweightPin, 'no extended deadline for a cheap judge');
  }
});

// An honoured pin without more time is just a slower way to fail open — the
// exact shape of the original incident.
test('the exact-pin deadline is materially larger than the boundary default', () => {
  assert.ok(
    exactJudgeBoundaryTimeoutMs() > boundaryJudgeTimeoutMs(),
    'a flagship judge needs more than the cheap-checker deadline',
  );
  assert.ok(exactJudgeBoundaryTimeoutMs() >= 60000, 'expected the deliberate-judge-lane order of magnitude');
});
