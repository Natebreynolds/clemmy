import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const card = readFileSync(new URL('./BrowserConnection.tsx', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../screens/Settings.tsx', import.meta.url), 'utf8');

test('phone Settings offers every cloud provider and the choice, like the desktop Browser card', () => {
  assert.match(settings, /<BrowserConnection \/>/);
  assert.match(card, /CLOUD_BROWSER_PROVIDERS\.map/, 'each provider gets a row, not one hard-wired provider');
  assert.match(card, /cloudBrowser\.select\(/, 'the phone can choose which browser Clem uses');
  assert.match(card, /cloudBrowser\.configure\(editing,/, 'the key form saves for the provider being connected');
  assert.doesNotMatch(card, /configure\('browserbase'/);
});
