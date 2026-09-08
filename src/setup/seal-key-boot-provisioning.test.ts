/**
 * The seal key is minted FIRST and at EVERY boot, on its own.
 *
 * Live 2026-09-08: a desktop user's every first message ended "Something went
 * wrong" — observability showed "model request provenance refused:
 * provenance_record_unavailable" on each turn. The seal key that every model
 * request depends on was minted only inside initHome(), after the scaffold
 * steps, and the service boot swallowed any scaffold failure. A home could
 * come up with no key and no way to get one. Two restarts changed nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const INIT = readFileSync(new URL('./init-home.ts', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const PROV = readFileSync(new URL('../runtime/harness/model-request-provenance.ts', import.meta.url), 'utf8');
const LOOP = readFileSync(new URL('../runtime/harness/loop.ts', import.meta.url), 'utf8');

test('initHome mints the seal key before any scaffold step that can fail', () => {
  const mint = INIT.indexOf('provisionAuthoritySealKey();');
  const scaffold = INIT.indexOf('ensureVaultScaffold();');
  const skills = INIT.indexOf('provisionBuiltinSkills();');
  assert.ok(mint > 0 && scaffold > 0 && skills > 0);
  assert.ok(mint < scaffold && mint < skills, 'the key is minted first');
});

test('both daemon boot paths provision the key on their own and log loudly if that fails', () => {
  const guards = INDEX.split('provisionAuthoritySealKey();').length - 1;
  assert.ok(guards >= 2, `service and daemon --foreground both provision (found ${guards})`);
  assert.match(INDEX, /authority seal key could not be provisioned/);
});

test('a provenance refusal names its cause and the user is told about the vault, not "something went wrong"', () => {
  assert.match(PROV, /causeSuffix\(options\?\.cause\)/);
  assert.match(LOOP, /authority_seal_key_missing[^\n]*\n\s*\? PUBLIC_VAULT_NOT_READY_TEXT/);
});
