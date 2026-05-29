import assert from 'node:assert/strict';
import test from 'node:test';
import { isLoopbackWebhookHost, normalizeWebhookHost } from '../config.js';
import {
  isSensitivePath,
  isStrongLocalSecret,
  redactSensitiveText,
  redactSensitiveValue,
  shellCommandTouchesSensitiveData,
} from './security.js';

test('normalizeWebhookHost defaults unsafe or empty values to loopback', () => {
  assert.equal(normalizeWebhookHost(''), '127.0.0.1');
  assert.equal(normalizeWebhookHost('localhost'), '127.0.0.1');
  assert.equal(normalizeWebhookHost('bad host with spaces'), '127.0.0.1');
  assert.equal(normalizeWebhookHost('0.0.0.0'), '0.0.0.0');
  assert.equal(isLoopbackWebhookHost('127.0.0.1'), true);
  assert.equal(isLoopbackWebhookHost('0.0.0.0'), false);
});

test('isStrongLocalSecret rejects placeholders and short values', () => {
  assert.equal(isStrongLocalSecret('changeme'), false);
  assert.equal(isStrongLocalSecret('short-secret'), false);
  assert.equal(isStrongLocalSecret('local-secret-2026_abcdefghijklmnopqrstuvwxyz'), true);
});

test('redactSensitiveText covers API keys, bearer tokens, url tokens, and env assignments', () => {
  const text = [
    'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
    'http://127.0.0.1:8520/console?token=super-secret-token-value',
    '{"headers":{"Authorization":"Bearer should-not-leak-1234567890"}}',
  ].join('\n');
  const redacted = redactSensitiveText(text);
  assert.equal(redacted.includes('abcdefghijklmnopqrstuvwxyz012345'), false);
  assert.equal(redacted.includes('super-secret-token-value'), false);
  assert.match(redacted, /\[REDACTED\]/);
});

test('redactSensitiveValue does not treat ordinary MCP telemetry as a secret', () => {
  const value = redactSensitiveValue({
    mcp: true,
    MCP_HEADERS: { Authorization: 'Bearer should-not-leak-1234567890' },
    mcpTool: 'dataforseo__serp_locations',
  });
  assert.deepEqual(value, {
    mcp: true,
    MCP_HEADERS: '[REDACTED]',
    mcpTool: 'dataforseo__serp_locations',
  });
});

test('sensitive path and shell classifiers flag secret-bearing surfaces', () => {
  assert.equal(isSensitivePath('/Users/me/.clementine-next/state/secrets-vault.json'), true);
  assert.equal(isSensitivePath('/Users/me/.clementine-next/mcp/servers.json'), true);
  assert.equal(isSensitivePath('/Users/me/project/src/index.ts'), false);
  assert.equal(shellCommandTouchesSensitiveData('cat ~/.clementine-next/state/secrets-vault.json'), true);
  assert.equal(shellCommandTouchesSensitiveData('security dump-keychain'), true);
  assert.equal(shellCommandTouchesSensitiveData('ls -la'), false);
});
