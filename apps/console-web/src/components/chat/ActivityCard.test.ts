/**
 * The live build log must follow the current step, not bury it under
 * auto-opened excerpts or an unbounded list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('./ActivityCard.tsx', import.meta.url), 'utf8');

test('live steps pin to the newest row and only the current excerpt opens', () => {
  assert.match(SOURCE, /function LiveStepList/);
  assert.match(SOURCE, /max-h-\[min\(22rem,50vh\)\] overflow-y-auto/);
  assert.match(SOURCE, /peek \?\? running/);
  assert.match(SOURCE, /live && !anyRunning/);
});
