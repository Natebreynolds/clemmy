import test from 'node:test';
import assert from 'node:assert/strict';

import { isSuccessfulHygieneReturn } from './scenarios/gated-mutation.js';

const successfulOutput = [
  'Task ledger hygiene (apply)',
  'Pending before: 1',
  'Repaired: 1 (0 completed-owner, 1 stale-unowned)',
  'Compacted rows out of Pending: 1',
].join('\n');

test('gated mutation accepts bounded event output from Codex and BYO', () => {
  assert.equal(isSuccessfulHygieneReturn({
    data_json: JSON.stringify({ ok: true, preview: successfulOutput }),
    output_full: null,
  }), true);
});

test('gated mutation accepts Claude output from the lossless recall store', () => {
  assert.equal(isSuccessfulHygieneReturn({
    data_json: JSON.stringify({ ok: true }),
    output_full: successfulOutput,
  }), true);
});

test('gated mutation rejects an unproven or failed return', () => {
  assert.equal(isSuccessfulHygieneReturn({
    data_json: JSON.stringify({ ok: true }),
    output_full: null,
  }), false);
  assert.equal(isSuccessfulHygieneReturn({
    data_json: JSON.stringify({ error: 'Task ledger hygiene failed: write denied' }),
    output_full: null,
  }), false);
});
