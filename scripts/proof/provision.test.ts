/**
 * Run: npx tsx --test scripts/proof/provision.test.ts
 *
 * The live proof matrix must provision the same BYO provider registry the app
 * uses. This catches drift between Settings' BYO_PROVIDERS store and the
 * isolated GLM proof home.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-provision-test-'));
mkdirSync(tmpHome, { recursive: true });
process.env.CLEMENTINE_HOME = tmpHome;

const ENV_KEYS = [
  'BYO_MODEL_ID',
  'BYO_MODEL_BASE_URL',
  'BYO_MODEL_API_KEY',
  'BYO_PROVIDERS',
  'BYO_PROVIDERS_JSON',
  'BYO_PROVIDER_DEEPSEEK_API_KEY',
];
for (const k of ENV_KEYS) delete process.env[k];

const registry = JSON.stringify([
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com', modelIds: ['deepseek-chat'] },
]);
writeFileSync(path.join(tmpHome, '.env'), [
  'BYO_MODEL_ID=glm-5.2',
  'BYO_MODEL_BASE_URL=https://api.z.ai/api/paas/v4',
  'BYO_MODEL_API_KEY=zai-secret',
  `BYO_PROVIDERS=${registry}`,
  'BYO_PROVIDER_DEEPSEEK_API_KEY=deepseek-secret',
  '',
].join('\n'));

const { planBrain } = await import('./provision.js');

test.after(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

test('glm proof plan copies BYO_PROVIDERS and per-provider key slots', () => {
  const plan = planBrain('glm');
  assert.equal(plan.skipReason, undefined);
  assert.equal(plan.env.BYO_MODEL_ID, 'glm-5.2');
  assert.equal(plan.env.BYO_MODEL_API_KEY, 'zai-secret');
  assert.equal(plan.env.BYO_PROVIDERS, registry);
  assert.equal(plan.env.BYO_PROVIDER_DEEPSEEK_API_KEY, 'deepseek-secret');
});
