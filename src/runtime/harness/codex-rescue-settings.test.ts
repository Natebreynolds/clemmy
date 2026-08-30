/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/codex-rescue-settings.test.ts
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRoleOptionCatalogSnapshot } from './model-role-options.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-codex-rescue-settings-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const {
  CodexRescueSettingsError,
  codexRescueSettingsSnapshot,
  persistCodexRescueModel,
} = await import('./codex-rescue-settings.js');

const catalog: ModelRoleOptionCatalogSnapshot = {
  available: [{
    provider: 'codex',
    label: 'Codex',
    models: [
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    ],
  }],
  roleOptions: { worker: [], judge: [] },
  brainOptions: [],
  providerSnapshots: [],
};

test('settings reports a truthful Codex default when the primary slot belongs to BYO', () => {
  const originalPrimary = process.env.OPENAI_MODEL_PRIMARY;
  const originalRescue = process.env.OPENAI_MODEL_RESCUE;
  try {
    process.env.OPENAI_MODEL_PRIMARY = 'glm-5.3';
    delete process.env.OPENAI_MODEL_RESCUE;

    const inherited = codexRescueSettingsSnapshot(catalog);
    assert.equal(inherited.configured, false);
    assert.equal(inherited.modelId, 'gpt-5.4');
    assert.equal(inherited.inheritedModelId, 'gpt-5.4');

    process.env.OPENAI_MODEL_RESCUE = 'gpt-5.6-luna';
    const explicit = codexRescueSettingsSnapshot(catalog);
    assert.equal(explicit.configured, true);
    assert.equal(explicit.modelId, 'gpt-5.6-luna');
    assert.equal(explicit.inheritedModelId, 'gpt-5.4');

    assert.throws(
      () => persistCodexRescueModel('glm-5.3', catalog),
      (error: unknown) => error instanceof CodexRescueSettingsError
        && error.code === 'INVALID_CODEX_RESCUE_MODEL',
      'explicit saved choices remain exact Codex-only catalog entries',
    );
  } finally {
    if (originalPrimary === undefined) delete process.env.OPENAI_MODEL_PRIMARY;
    else process.env.OPENAI_MODEL_PRIMARY = originalPrimary;
    if (originalRescue === undefined) delete process.env.OPENAI_MODEL_RESCUE;
    else process.env.OPENAI_MODEL_RESCUE = originalRescue;
  }
});
