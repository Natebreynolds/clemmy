import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FORM = readFileSync(new URL('./JevConnectForm.tsx', import.meta.url), 'utf8');
const ACCOUNTS = readFileSync(new URL('./ModelAccountsCard.tsx', import.meta.url), 'utf8');
const SETTINGS = readFileSync(new URL('../../lib/settings.ts', import.meta.url), 'utf8');
const ROUTES = readFileSync(new URL('../../../../../src/dashboard/console-routes.ts', import.meta.url), 'utf8');
const SYSTEM_ONE = readFileSync(new URL('../../../../../src/runtime/jev/system-one.ts', import.meta.url), 'utf8');

test('Settings › Models › Accounts pastes a TypeSafe key and verifies /v1/systemone', () => {
  assert.match(FORM, /get one at console\.typesafe\.ai/);
  assert.match(FORM, /console\.typesafe\.ai\/keys/);
  assert.match(FORM, /connectJev/);
  assert.match(FORM, /disconnectJev/);
  assert.match(FORM, /type="password"/);
  assert.match(FORM, /api\.typesafe\.ai/);
  assert.match(FORM, /session snippets/);
  assert.match(ACCOUNTS, /<JevConnectForm /);
  assert.match(ACCOUNTS, /id: 'jev', label: 'Jev'/, 'Jev has a row even before it is connected');
  assert.match(SETTINGS, /\/api\/console\/jev/);
  assert.match(ROUTES, /app\.post\('\/api\/console\/jev'/);
  assert.match(ROUTES, /app\.delete\('\/api\/console\/jev'/);
  assert.match(SYSTEM_ONE, /https:\/\/api\.typesafe\.ai\/v1\/systemone/);
  assert.doesNotMatch(SYSTEM_ONE, /chat\/completions/);
});

test('every place that asks for a key links to where the key is made', () => {
  const REGISTRY = readFileSync(new URL('../../../../../src/runtime/secrets/registry.ts', import.meta.url), 'utf8');
  const CONNECT = readFileSync(new URL('../Connect.tsx', import.meta.url), 'utf8');
  const FORMS = readFileSync(new URL('./ModelProviderForms.tsx', import.meta.url), 'utf8');
  const PRESETS = readFileSync(new URL('../../lib/model-provider-presets.ts', import.meta.url), 'utf8');
  // The Jev form and the credential registry name the same key page.
  const jevUrl = /JEV_KEY_URL = '([^']+)'/.exec(FORM)?.[1];
  assert.ok(jevUrl);
  assert.match(REGISTRY, new RegExp(`name: 'typesafe_api_key'[\\s\\S]*?keyUrl: '${jevUrl.replace(/[.]/g, '\\.')}'`));
  // Keys & accounts rows and the add-a-model form render the descriptor's
  // and the preset's key page.
  assert.match(CONNECT, /descriptor\?\.keyUrl/);
  assert.match(CONNECT, /href=\{keyUrl\}/);
  assert.match(FORMS, /href=\{preset\.keyUrl\}/);
  assert.match(ACCOUNTS, /platform\.openai\.com\/api-keys/, 'the OpenAI key row links to where the key is made');
  for (const id of ['deepseek', 'minimax', 'together', 'glm', 'kimi-code', 'moonshot', 'xai']) {
    assert.match(PRESETS, new RegExp(`id: '${id}'[^\\n]*keyUrl: 'https://`), `${id} has a key page`);
  }
});

test('model accounts live in one place, and each links straight to its billing page', () => {
  const SETTINGS_SCREEN = readFileSync(new URL('../Settings.tsx', import.meta.url), 'utf8');
  const SECTION = readFileSync(new URL('./ModelsRoutingSection.tsx', import.meta.url), 'utf8');
  const CONNECT = readFileSync(new URL('../Connect.tsx', import.meta.url), 'utf8');
  const CHIPS = readFileSync(new URL('../../components/ModelStatusChips.tsx', import.meta.url), 'utf8');
  // No second "Connected" section: accounts and roles share the Models section.
  assert.doesNotMatch(SETTINGS_SCREEN, /ConnectedSection|id: 'connected'/);
  assert.match(SECTION, /<ModelAccountsCard \/>[\s\S]*<ModelRolesCard/);
  // Connect does not repeat model keys; it points at the one place.
  assert.match(CONNECT, /'codex_oauth_access_token', 'codex_oauth_refresh_token', 'openai_api_key', 'typesafe_api_key'/);
  assert.match(CONNECT, /to="\/settings#accounts"/);
  // The billing page opens from the account row and from the top-bar chip.
  assert.match(ACCOUNTS, /href=\{meter\.billing\.url\}/);
  assert.match(CHIPS, /meter\.outOfCredit[\s\S]*href=\{meter\.billing\.url\}/);
});

test('Settings › Models has no Second opinion control; a switched-on one keeps a way off', () => {
  const ROLES = readFileSync(new URL('./ModelRolesCard.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(ROLES, /row\('Second opinion'/);
  assert.doesNotMatch(ROLES, /'Judge only'/);
  assert.match(ROLES, /secondOpinionOn && \([\s\S]*onFusion\('off'\)[\s\S]*Turn off/);
});
