/**
 * A model change says what came of it under the control that made it.
 *
 * A refused brain switch leaves the menu on the current model; with the
 * reason printed at the foot of the card, below the advanced section, an
 * owner saw only that "the selection just doesn't stick".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CARD = readFileSync(new URL('./ModelRolesCard.tsx', import.meta.url), 'utf8');
const ACCOUNTS = readFileSync(new URL('./ModelAccountsCard.tsx', import.meta.url), 'utf8');
const HOOK = readFileSync(new URL('../../lib/model-roles.ts', import.meta.url), 'utf8');

test('an error is kept with the control it came from, and the settings are read again', () => {
  assert.match(HOOK, /setErrorKey\(key\);\s*\/\/[^\n]*\n[^\n]*\n\s*refresh\(\);/);
  assert.match(CARD, /r\.error && r\.errorKey === key/);
  assert.match(CARD, /\{note\}\s*\{feedback\(key\)\}/, 'the outcome renders inside the row, under its hint');
  for (const key of ['brain', 'worker', 'writer', 'judge', 'quick']) {
    assert.match(CARD, new RegExp(`, '${key}'\\)\\}`), `${key} row passes its key`);
  }
  assert.match(CARD, /\{feedback\('memory'\)\}/);
  assert.match(CARD, /r\.error && !INLINE_FEEDBACK\.has\(r\.errorKey \?\? ''\)/, 'the foot of the card does not repeat an inline error');
});

test('a switch the saved settings do not confirm says so', () => {
  assert.match(CARD, /setPickedBrain\(e\.target\.value\); void r\.onBrain\(e\.target\.value\);/);
  assert.match(CARD, /That change didn’t take: Clem is still on/);
});

test('an API account added without a usable key stays listed under Not connected with the reason', () => {
  assert.match(ACCOUNTS, /providers\.filter\(\(p\) => \(statusUnknown \|\| !p\.configured\) && !byId\.has\(p\.id\)/);
  assert.match(ACCOUNTS, /no API key is saved, so \$\{models\} can't be used/);
});
