import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseClaudeClientVersion } from './claude-client-version.js';
import { applyClaudeEnvelope } from './claude-model.js';

test('Claude wire identity uses the supplied installed client version, not a fixed historical version', () => {
  const version = parseClaudeClientVersion('9.12.345 (Claude Code)\n');
  assert.equal(applyClaudeEnvelope({}, 'test-token', version).headers.get('user-agent'), 'claude-cli/9.12.345 (external, clementine)');
  assert.throws(() => parseClaudeClientVersion('unknown'), /valid version/);
  assert.throws(() => parseClaudeClientVersion('version 1.0.0'), /valid version/);
});
