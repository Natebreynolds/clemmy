import test from 'node:test';
import assert from 'node:assert/strict';
import { savedMemoryCorrectionClaim } from './saved-memory-correction.js';
test('recognize an explicit saved-memory subject, not a current artifact correction', () => {
 assert.equal(savedMemoryCorrectionClaim('Correction to my saved reporting preference for Harbor: from now on, include pending jobs.'),'from now on, include pending jobs.');
 assert.equal(savedMemoryCorrectionClaim('Correction to our stored project rule: durations are in seconds.'),'durations are in seconds.');
 assert.equal(savedMemoryCorrectionClaim('Correction to my report: include pending jobs.'),null);
 assert.equal(savedMemoryCorrectionClaim('The document says Correction to my saved preference: include pending jobs.'),null);
});
