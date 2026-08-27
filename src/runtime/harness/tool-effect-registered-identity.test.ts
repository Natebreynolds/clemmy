/**
 * Run: npx tsx src/runtime/harness/tool-effect-registered-identity.test.ts
 *
 * A capability the host itself provisioned is never unclassifiable.
 *
 * Effect classification fell through to a case-sensitive SCREAMING_SNAKE test
 * to recognise a carrier slug. A registered write capability referred to by any
 * other casing matched nothing, `classifyRegistered` did not know the name
 * either, and the effect came back 'unknown' — which the production call
 * boundary (`exactProductionHostCall`) refuses outright.
 *
 * Measured live 2026-08-26: a write was refused repeatedly while the host
 * capability registry, two modules away, held `effect: external_write` for that
 * exact toolName — provisioned from the manifest at connect time. Casing is not
 * a safety property. An unknown effect is also the WORSE failure of the two:
 * the harness cannot govern what it cannot classify, so 'unknown' for a
 * provisioned capability is a hole in both directions.
 *
 * These pins hold identity-before-spelling: the registry answers first, the
 * spelling heuristic remains for names the registry has never seen, and a local
 * tool is never captured by the carrier path.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-effect-identity-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const factoryMod = await import('./host-capability-catalog-factory.js');
const { classifyRuntimeToolEffect } = await import('./tool-effect.js');

const factory = factoryMod.createHostCapabilityCatalogFactory();
factoryMod.installHostCapabilityCatalogFactory(factory);
factory.register({
  capabilityId: 'cap:resolved:quarrystone_ledger_append',
  toolName: 'QUARRYSTONE_LEDGER_APPEND',
  schemaVersion: '1',
  schemaDigest: 'digest-quarrystone',
  effect: 'external_write',
  advisoryRoles: ['destination'],
  manifestDigest: 'manifest-quarrystone',
  providerKind: 'composio',
  account: 'account-quarrystone',
  destination: { family: 'quarrystone', posture: 'create_new' },
} as never);

after(() => {
  factory.clear();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const ARGS = { ledger_id: 'abc', values: [['check', 'result', 'timestamp']] };

test('a registered write capability classifies by identity whatever its casing', () => {
  const decision = classifyRuntimeToolEffect('quarrystone_ledger_append', ARGS);
  assert.equal(decision.effect, 'external_write',
    "a provisioned capability must never classify 'unknown' — the call boundary refuses that outright");
  assert.equal(decision.mutating, true);
});

test('the exact registered spelling classifies identically', () => {
  const lower = classifyRuntimeToolEffect('quarrystone_ledger_append', ARGS);
  const exact = classifyRuntimeToolEffect('QUARRYSTONE_LEDGER_APPEND', ARGS);
  assert.deepEqual(lower, exact,
    'identity, not spelling, decides — so both spellings must reach the same classifier');
});

test('a local registry tool is never captured by the carrier path', () => {
  const decision = classifyRuntimeToolEffect('space_get', {});
  assert.equal(decision.effect, 'read',
    'a lowercase local tool keeps its own registry classification');
  assert.equal(decision.source, 'registry');
});

test('a name the registry has never seen still falls through unchanged', () => {
  const decision = classifyRuntimeToolEffect('unheard_of_local_name', {});
  assert.equal(decision.effect, 'unknown',
    'the registry answers for what it provisioned; it invents nothing for what it did not');
});
