import assert from 'node:assert/strict';
import test from 'node:test';
import { isTrustedDashboardMediaUrl } from './media-permissions.js';

const origins = new Set(['http://127.0.0.1:43123']);

test('trusted dashboard pages may request audio capture', () => {
  assert.equal(isTrustedDashboardMediaUrl('http://127.0.0.1:43123/console/meetings', origins), true);
  assert.equal(isTrustedDashboardMediaUrl('http://127.0.0.1:43123/console/chat?voice=1', origins), true);
});

test('same-origin agent-authored workspace views cannot request media', () => {
  assert.equal(isTrustedDashboardMediaUrl('http://127.0.0.1:43123/console/spaces/abc/view', origins), false);
  assert.equal(isTrustedDashboardMediaUrl('http://127.0.0.1:43123/console/spaces/abc/view/', origins), false);
  assert.equal(isTrustedDashboardMediaUrl('http://127.0.0.1:43123/console/spaces/abc/view?top=1', origins), false);
  assert.equal(isTrustedDashboardMediaUrl('http://127.0.0.1:43123/CONSOLE/SPACES/abc/%76iew', origins), false);
});

test('the trusted Clementine notch may request audio capture', () => {
  assert.equal(isTrustedDashboardMediaUrl('http://127.0.0.1:43123/console/notch', origins), true);
  assert.equal(isTrustedDashboardMediaUrl('http://127.0.0.1:43123/console/notch/', origins), true);
  assert.equal(isTrustedDashboardMediaUrl('http://127.0.0.1:43123/CONSOLE/%6eotch?voice=1', origins), true);
});

test('untrusted origins and malformed URLs fail closed', () => {
  assert.equal(isTrustedDashboardMediaUrl('https://evil.example/console/meetings', origins), false);
  assert.equal(isTrustedDashboardMediaUrl('not a url', origins), false);
});
