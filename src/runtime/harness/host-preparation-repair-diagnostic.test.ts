/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/host-preparation-repair-diagnostic.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-preparation-repair-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const {
  aggregateHostPreparationRefusalProgress,
  boundedHostPreparationRepairDiagnostic,
  hostPreparationRefusalProgress,
} = await import('./host-turn-runner.js');
const {
  buildHostToolDispositionResult,
} = await import('./host-model-result-receipt.js');

test.after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function resultText(item: unknown): string {
  const output = (item as { output?: unknown }).output;
  assert.ok(output && typeof output === 'object');
  const text = (output as { text?: unknown }).text;
  assert.equal(typeof text, 'string');
  return text as string;
}

test('a host preparation refusal keeps one bounded actionable repair in the model disposition', () => {
  const actionable = JSON.stringify({
    error: 'work_cardinality_mismatch',
    dispatch_state: 'not_started',
    detail: 'once cardinality accepts neither an item nor universe selector',
    repair: 'Omit the each-only universe controls and retry this same frozen requirement.',
  });
  const diagnostic = boundedHostPreparationRepairDiagnostic(actionable);
  assert.equal(diagnostic, actionable);
  assert.ok(diagnostic);

  const item = buildHostToolDispositionResult({
    callId: 'live-shaped-work-call',
    toolName: 'work_call',
    disposition: 'refused_pre_dispatch',
    frameDigest: 'a'.repeat(64),
    frameIndex: 0,
    frameSize: 1,
    countsRefusal: false,
    diagnostic,
  });
  const visible = JSON.parse(resultText(item)) as {
    protocol?: string;
    message?: string;
    diagnostic?: string;
    countsRefusal?: true;
    retry?: string;
  };
  assert.equal(visible.protocol, 'host_tool_disposition_v1');
  assert.equal(visible.diagnostic, actionable,
    'the next model step sees the exact host repair, not only a generic refusal');
  assert.match(visible.diagnostic ?? '', /Omit the each-only universe controls/);
  assert.equal(visible.countsRefusal, undefined,
    'repairable arguments do not spend the capability-refusal retirement marker');
  assert.equal(visible.retry, 'replan');
});

test('host preparation diagnostics are value-opaque and bounded while retaining both repair ends', () => {
  const prefix = 'ERROR-PREFIX:';
  const suffix = ':REPAIR-SUFFIX';
  const oversized = `${prefix}${'x'.repeat(20_000)}${suffix}`;
  const bounded = boundedHostPreparationRepairDiagnostic(oversized);
  assert.ok(bounded);
  assert.equal(bounded?.length, 8_192);
  assert.equal(bounded?.startsWith(prefix), true);
  assert.equal(bounded?.endsWith(suffix), true);
  assert.match(bounded ?? '', /host preparation diagnostic truncated/);
});

test('repeated argument repairs remain current-capability work and never retire as unavailable', () => {
  for (const _attempt of [1, 2]) {
    assert.deepEqual(hostPreparationRefusalProgress('repair_arguments'), {
      countsCapabilityRefusal: false,
      retireSemanticFrame: false,
    });
  }
  assert.deepEqual(hostPreparationRefusalProgress('stop_and_explain'), {
    countsCapabilityRefusal: true,
    retireSemanticFrame: true,
  }, 'the bounded work-attempt owner can still terminate a genuinely spent/non-repairable call');
});

test('mixed preparation recovery aggregation is sibling-order independent', () => {
  const repair = { callId: 'repair-call', recovery: 'repair_arguments' as const };
  const stop = { callId: 'stop-call', recovery: 'stop_and_explain' as const };
  const forward = aggregateHostPreparationRefusalProgress([repair, stop]);
  const reversed = aggregateHostPreparationRefusalProgress([stop, repair]);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward, {
    hasTypedRefusal: true,
    countingCallIds: ['stop-call'],
    retireSemanticFrame: true,
  });
  assert.deepEqual(aggregateHostPreparationRefusalProgress([repair]), {
    hasTypedRefusal: true,
    countingCallIds: [],
    retireSemanticFrame: false,
  });
});
