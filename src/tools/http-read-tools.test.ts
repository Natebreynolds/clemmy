/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/http-read-tools.test.ts
 *
 * An image URL read through the host tool adapter reaches the model as the
 * image itself, never as base64 text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RunContext } from '@openai/agents';
import { getLocalRuntimeTools } from './local-runtime-tools.js';
import { HostLocalExecutionFailureResult } from '../runtime/harness/attempt-settlement.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9N8AAAAASUVORK5CYII=';

test('http_read hands the model the pixels of an image URL, and text pages stay text', async () => {
  const read = getLocalRuntimeTools().find(row => row.name === 'http_read');
  assert.ok(read && read.type === 'function');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => String(url).endsWith('/thumb')
    ? new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } })
    : new Response('<h1>Pricing</h1>', { headers: { 'content-type': 'text/html' } })) as typeof fetch;
  try {
    const context = new RunContext({ sessionId: 'http-read-fixture' });
    const image = await read.invoke(context, JSON.stringify({ url: 'https://images.example.test/thumb' }));
    assert.ok(Array.isArray(image), 'an image result is media content');
    assert.ok(image.some((row: any) => row.type === 'image' && row.data === png && row.mimeType === 'image/png'));
    assert.equal(JSON.stringify(image).split(png).length - 1, 1, 'the pixels appear once, as an image');
    assert.ok(image.some((row: any) => row.type === 'text' && /"status":200/.test(row.text)));
    const page = await read.invoke(context, JSON.stringify({ url: 'https://docs.example.test/pricing' }));
    assert.equal(typeof page, 'string');
    assert.match(String(page), /Pricing/);
    globalThis.fetch = (async () => { throw new Error('fetch failed'); }) as typeof fetch;
    const failed = await read.invoke(context, JSON.stringify({ url: 'https://images.example.test/thumb' }));
    assert.ok(failed instanceof HostLocalExecutionFailureResult);
  } finally {
    globalThis.fetch = realFetch;
  }
});
