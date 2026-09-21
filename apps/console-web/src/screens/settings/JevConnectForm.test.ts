import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FORM = readFileSync(new URL('./JevConnectForm.tsx', import.meta.url), 'utf8');
const SECTION = readFileSync(new URL('./ModelsRoutingSection.tsx', import.meta.url), 'utf8');
const SETTINGS = readFileSync(new URL('../../lib/settings.ts', import.meta.url), 'utf8');
const ROUTES = readFileSync(new URL('../../../../../src/dashboard/console-routes.ts', import.meta.url), 'utf8');
const SYSTEM_ONE = readFileSync(new URL('../../../../../src/runtime/jev/system-one.ts', import.meta.url), 'utf8');

test('Settings › Connected pastes a TypeSafe key and verifies /v1/systemone', () => {
  assert.match(FORM, /Get a TypeSafe API key/);
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
