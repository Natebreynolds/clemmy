import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browserSelectionNotice } from './BrowserConnection';

const card = readFileSync(new URL('./BrowserConnection.tsx', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../screens/Settings.tsx', import.meta.url), 'utf8');

test('phone Settings offers every cloud provider and the choice, like the desktop Browser card', () => {
  assert.match(settings, /<BrowserConnection \/>/);
  assert.match(card, /CLOUD_BROWSER_PROVIDERS\.map/, 'each provider gets a row, not one hard-wired provider');
  assert.match(card, /cloudBrowser\.select\(/, 'the phone can choose which browser Clem uses');
  assert.match(card, /cloudBrowser\.configure\(editing,/, 'the key form saves for the provider being connected');
  assert.doesNotMatch(card, /configure\('browserbase'/);
});


test('saved browser choices do not claim to replace effective computer control or prove readiness', () => {
  const notice = browserSelectionNotice({ configured: true, effectiveBackend: 'computer', choice: 'browserbase' }, 'browserbase');
  assert.match(notice, /Browser fallback saved/);
  assert.match(notice, /Computer control is still selected/);
  assert.doesNotMatch(notice, /ready|permissions|Browserbase is the browser now/i);
  assert.equal(browserSelectionNotice({ configured: false, effectiveBackend: 'local', choice: 'local' }, 'browserbase'), "The computer's Chrome is the browser now.");
  assert.equal(browserSelectionNotice({ configured: true, effectiveBackend: 'cloud', choice: 'kernel' }, 'browserbase'), 'Kernel is the browser now.');
});
