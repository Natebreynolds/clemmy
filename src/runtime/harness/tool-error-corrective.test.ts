/**
 * Run: npx tsx --test src/runtime/harness/tool-error-corrective.test.ts
 *
 * The general MCP-parity corrective: classify any tool failure and emit a
 * self-correcting next move, vendor-agnostically (no curated toolkit list).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyToolError,
  toolFailureCorrective,
  detectStructuredToolFailure,
  mcpErrorCorrectiveEnabled,
} from './tool-error-corrective.js';

test('classifyToolError: maps the common failure shapes vendor-agnostically', () => {
  assert.equal(classifyToolError('ElevenLabs: invalid voice_id "abc"'), 'not_found');
  assert.equal(classifyToolError('Airtable 404: table not found'), 'not_found');
  assert.equal(classifyToolError('403 Forbidden — insufficient scope'), 'permission_denied');
  assert.equal(classifyToolError('401 Unauthorized'), 'permission_denied');
  assert.equal(classifyToolError('429 Too Many Requests'), 'rate_limit');
  assert.equal(classifyToolError('request timed out after 30s'), 'timeout');
  assert.equal(classifyToolError('invalid offset token'), 'pagination');
  assert.equal(classifyToolError('the server did something weird'), 'unknown');
});

test('toolFailureCorrective: not-found tells the model to DISCOVER, not guess', () => {
  const out = toolFailureCorrective('invalid voice_id', { toolName: 'elevenlabs__text_to_speech' });
  assert.match(out, /NOT FOUND/i);
  assert.match(out, /discover/i);
  assert.match(out, /do not guess/i);
  assert.match(out, /elevenlabs__text_to_speech/);
});

test('toolFailureCorrective: transient/rate-limit says retry ONCE (the one productive repeat)', () => {
  const out = toolFailureCorrective('429 rate limit', { toolName: 'x__y' });
  assert.match(out, /TRANSIENT/i);
  assert.match(out, /retry this exact call once/i);
  assert.match(out, /do not retry more than once/i);
});

test('toolFailureCorrective: permission says fix auth, not the id', () => {
  const out = toolFailureCorrective('403 forbidden', { toolName: 'airtable__list_records' });
  assert.match(out, /DENIED/i);
  assert.match(out, /auth|scope|account/i);
  assert.match(out, /do not repeat the identical call/i);
});

test('toolFailureCorrective: a hard/unknown failure says fix-args or switch or stop — never repeat', () => {
  const out = toolFailureCorrective('malformed request body', { toolName: 'n8n__run' });
  assert.match(out, /HARD failure/i);
  assert.match(out, /do not repeat this identical call/i);
});

test('detectStructuredToolFailure: fires on a parseable error envelope, ignores success + prose', () => {
  // Real failure envelopes (MCP servers emit these as the result text).
  assert.equal(detectStructuredToolFailure('{"isError":true,"error":"invalid voice_id"}').failed, true);
  assert.equal(detectStructuredToolFailure('{"successful":false,"error":"404 not found"}').failed, true);
  assert.equal(detectStructuredToolFailure('{"error":{"message":"bad field"}}').failed, true);
  assert.equal(detectStructuredToolFailure('{"success":false}').failed, true);
  // notFound is derived from the summary.
  assert.equal(detectStructuredToolFailure('{"error":"no such record"}').notFound, true);
  // Success / explicit-success-wins / prose must NOT be flagged.
  assert.equal(detectStructuredToolFailure('{"successful":true,"data":{"note":"no error here"}}').failed, false);
  assert.equal(detectStructuredToolFailure('{"isError":false,"content":"done"}').failed, false);
  assert.equal(detectStructuredToolFailure('Operation completed, no errors found.').failed, false);
  assert.equal(detectStructuredToolFailure('').failed, false);
  // A plain success payload with data is not a failure.
  assert.equal(detectStructuredToolFailure('{"data":[{"id":1}]}').failed, false);
});

test('mcpErrorCorrectiveEnabled: default-on, kill-switch off', () => {
  const prev = process.env.CLEMMY_MCP_ERROR_CORRECTIVE;
  try {
    delete process.env.CLEMMY_MCP_ERROR_CORRECTIVE;
    assert.equal(mcpErrorCorrectiveEnabled(), true, 'default on');
    process.env.CLEMMY_MCP_ERROR_CORRECTIVE = 'off';
    assert.equal(mcpErrorCorrectiveEnabled(), false, 'kill-switch off');
    process.env.CLEMMY_MCP_ERROR_CORRECTIVE = 'on';
    assert.equal(mcpErrorCorrectiveEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_MCP_ERROR_CORRECTIVE;
    else process.env.CLEMMY_MCP_ERROR_CORRECTIVE = prev;
  }
});
