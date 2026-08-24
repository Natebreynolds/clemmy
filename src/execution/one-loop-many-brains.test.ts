/** Run: node scripts/run-tests-isolated.mjs src/execution/one-loop-many-brains.test.ts
 *
 * ONE LOOP, MANY BRAINS — Track A pins (2026-08-20): the master keeps its own
 * brain; the fleet runs on the model the master chose; each settled window
 * pings the user and wakes the origin session.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-one-loop-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-one-loop\n', 'utf8');

const { dispositionToDurableWork } = await import('./work-disposition.js');

test('the manifest workerModel rides into the durable plan', () => {
  const plan = dispositionToDurableWork({
    kind: 'durable_manifest',
    objective: 'test fleet',
    successCriteria: [],
    missingRequiredInputs: [],
    effectCeiling: 'read',
    estimatedActivations: 3,
    manifest: {
      manifestId: 'm1', contractVersion: 'v1',
      canonicalItems: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      phases: [{ id: 'execute', dependsOn: [] }],
      reducer: { id: 'reduce', requiredPhases: ['execute'], outputContract: 'report@1' },
      workerModel: 'grok-4-fast',
    },
  } as never);
  assert.ok(plan, 'plan expected');
  assert.equal(plan!.workerModel, 'grok-4-fast', 'the fleet model survives disposition');
});

test('grok ids are characterized in the wire registry (no more 128K default)', async () => {
  const { resolveModelCapability } = await import('../runtime/harness/model-wire-registry.js');
  const cap = resolveModelCapability('grok-4-fast');
  assert.equal(cap.family, 'grok');
  assert.equal(cap.contextWindow, 256_000, 'grok budgets against its real window');
});

test('the background surface honors the model the dispatcher chose', async () => {
  const source = (await import('node:fs')).readFileSync(
    new URL('../runtime/harness/respond-bridge.ts', import.meta.url), 'utf8');
  assert.match(source, /background: \{ kind: 'execution', judgeCompletion: false, honorModel: true \}/,
    'createBackgroundTask({model}) must reach the routed run, not be discarded');
});
