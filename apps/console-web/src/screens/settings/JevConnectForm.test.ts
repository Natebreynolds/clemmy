import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FORM = readFileSync(new URL('./JevConnectForm.tsx', import.meta.url), 'utf8');
const SECTION = readFileSync(new URL('./ModelsRoutingSection.tsx', import.meta.url), 'utf8');
const SETTINGS = readFileSync(new URL('../../lib/settings.ts', import.meta.url), 'utf8');
const ROUTES = readFileSync(new URL('../../../../../src/dashboard/console-routes.ts', import.meta.url), 'utf8');
const SYSTEM_ONE = readFileSync(new URL('../../../../../src/runtime/jev/system-one.ts', import.meta.url), 'utf8');

test('Settings › Connected pastes a TypeSafe key and verifies /v1/systemone', () => {
  assert.match(FORM, /get one at console\.typesafe\.ai/);
  assert.match(FORM, /console\.typesafe\.ai\/keys/);
  assert.match(FORM, /connectJev/);
  assert.match(FORM, /disconnectJev/);
  assert.match(FORM, /type="password"/);
  assert.match(FORM, /api\.typesafe\.ai/);
  assert.match(FORM, /session snippets/);
  assert.match(SECTION, /JevConnectForm/);
  assert.match(SECTION, /label: 'Jev'/);
  assert.match(SETTINGS, /\/api\/console\/jev/);
  assert.match(ROUTES, /app\.post\('\/api\/console\/jev'/);
  assert.match(ROUTES, /app\.delete\('\/api\/console\/jev'/);
  assert.match(SYSTEM_ONE, /https:\/\/api\.typesafe\.ai\/v1\/systemone/);
  assert.doesNotMatch(SYSTEM_ONE, /chat\/completions/);
});

test('every place that asks for a key links to where the key is made', () => {
  const REGISTRY = readFileSync(new URL('../../../../../src/runtime/secrets/registry.ts', import.meta.url), 'utf8');
  const CONNECT = readFileSync(new URL('../Connect.tsx', import.meta.url), 'utf8');
  const STRIP = readFileSync(new URL('./ConnectedModelsStrip.tsx', import.meta.url), 'utf8');
  const PRESETS = readFileSync(new URL('../../lib/model-provider-presets.ts', import.meta.url), 'utf8');
  // Jev is new: the Connected section links the key page without opening
  // anything, and the form and the credential registry name the same page.
  const jevUrl = /JEV_KEY_URL = '([^']+)'/.exec(FORM)?.[1];
  assert.ok(jevUrl);
  assert.match(REGISTRY, new RegExp(`name: 'typesafe_api_key'[\\s\\S]*?keyUrl: '${jevUrl.replace(/[.]/g, '\\.')}'`));
  assert.match(SECTION, /!jev\?\.configured && !open[\s\S]*href=\{JEV_KEY_URL\}/);
  // Keys & accounts rows and the add-a-model form render the descriptor's
  // and the preset's key page.
  assert.match(CONNECT, /descriptor\?\.keyUrl/);
  assert.match(CONNECT, /href=\{keyUrl\}/);
  assert.match(STRIP, /href=\{currentKeyUrl\}/);
  for (const id of ['deepseek', 'minimax', 'together', 'glm', 'kimi-code', 'moonshot', 'xai']) {
    assert.match(PRESETS, new RegExp(`id: '${id}'[^\\n]*keyUrl: 'https://`), `${id} has a key page`);
  }
});

test('Settings › Models has no Second opinion control; a switched-on one keeps a way off', () => {
  const ROLES = readFileSync(new URL('./ModelRolesCard.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(ROLES, /row\('Second opinion'/);
  assert.doesNotMatch(ROLES, /'Judge only'/);
  assert.match(ROLES, /secondOpinionOn && \([\s\S]*onFusion\('off'\)[\s\S]*Turn off/);
});
