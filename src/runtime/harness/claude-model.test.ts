import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyClaudeEnvelope, withIdentityPrefix, ClaudeModelProvider } from './claude-model.js';

const ID = "You are Claude Code, Anthropic's official CLI for Claude.".replace('Claude', 'Claude'); // exact identity
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

test('envelope: x-api-key is STRIPPED and OAuth Bearer is set (the billing guard)', () => {
  const { headers } = applyClaudeEnvelope({ headers: { 'x-api-key': 'sk-ant-api03-would-bill-api', 'content-type': 'application/json' } }, 'sk-ant-oat01-good');
  assert.equal(headers.has('x-api-key'), false, 'x-api-key must be removed → never API-bill');
  assert.equal(headers.get('authorization'), 'Bearer sk-ant-oat01-good');
  assert.match(headers.get('anthropic-beta') || '', /oauth-2025-04-20/);
  assert.equal(headers.get('content-type'), 'application/json', 'other headers preserved');
});

test('envelope: an existing anthropic-beta (e.g. thinking) is preserved alongside the oauth beta', () => {
  const { headers } = applyClaudeEnvelope({ headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } }, 'sk-ant-oat01-x');
  const beta = headers.get('anthropic-beta') || '';
  assert.match(beta, /oauth-2025-04-20/);
  assert.match(beta, /interleaved-thinking/);
});

test('envelope: the Claude-Code identity is injected into the request body system', () => {
  const { body } = applyClaudeEnvelope({ body: JSON.stringify({ model: 'claude-opus-4-8', system: 'Be helpful.', messages: [] }) }, 'sk-ant-oat01-x');
  const parsed = JSON.parse(body as string);
  assert.ok(Array.isArray(parsed.system));
  assert.equal(parsed.system[0].text, IDENTITY);
});

test('envelope: a missing max_tokens is filled (Anthropic requires it); a present one is left alone', () => {
  const filled = JSON.parse(applyClaudeEnvelope({ body: JSON.stringify({ model: 'x', messages: [] }) }, 'sk-ant-oat01-x').body as string);
  assert.equal(typeof filled.max_tokens, 'number');
  assert.ok(filled.max_tokens > 0);
  const kept = JSON.parse(applyClaudeEnvelope({ body: JSON.stringify({ model: 'x', messages: [], max_tokens: 512 }) }, 'sk-ant-oat01-x').body as string);
  assert.equal(kept.max_tokens, 512, 'harness-set max_tokens is not overridden');
});

test('withIdentityPrefix: string / empty / array / already-prefixed', () => {
  assert.deepEqual(withIdentityPrefix(''), [{ type: 'text', text: IDENTITY }]);
  assert.deepEqual(withIdentityPrefix('hi'), [{ type: 'text', text: IDENTITY }, { type: 'text', text: 'hi' }]);
  const already = [{ type: 'text', text: IDENTITY + ' extra' }];
  assert.equal(withIdentityPrefix(already), already, 'not double-prefixed');
  const arr = [{ type: 'text', text: 'sys' }];
  const out = withIdentityPrefix(arr) as Array<{ text: string }>;
  assert.equal(out[0].text, IDENTITY);
  assert.equal(out[1].text, 'sys');
});

test('ClaudeModelProvider: constructs a Model; non-claude ids map to the brain model', () => {
  const p = new ClaudeModelProvider();
  const m1 = p.getModel('claude-opus-4-8');
  assert.equal(typeof (m1 as { getStreamedResponse?: unknown }).getStreamedResponse, 'function');
  // a gpt-5* tier name still yields a (Claude) Model — the whole harness runs on Claude
  const m2 = p.getModel('gpt-5.4');
  assert.equal(typeof (m2 as { getStreamedResponse?: unknown }).getStreamedResponse, 'function');
});

void ID;
