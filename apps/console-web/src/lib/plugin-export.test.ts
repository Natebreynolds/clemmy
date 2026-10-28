/** Run with scripts/run-tests-isolated.mjs; no daemon, providers, or home needed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartridgeIdFor } from './plugin-export';

test('a cartridge id is reverse-dot and lowercase, from the words the owner typed', () => {
  assert.equal(cartridgeIdFor('Sales Pack!'), 'me.sales-pack');
  assert.equal(cartridgeIdFor('  Q4  Planning ', 'Acme Inc'), 'acme-inc.q4-planning');
  assert.equal(cartridgeIdFor('***'), 'me.cartridge');
});
