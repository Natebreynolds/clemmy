import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { boundedHttpRead, HTTP_READ_MAX_BYTES } from './bounded-http-read.js';

test('HTTP read follows bounded redirects and preserves exact response evidence', async () => {
  const urls: string[] = [];
  const body = '{"price":0.01,"label":"café"}';
  const result = await boundedHttpRead('https://example.com/start', async (url, init) => {
    urls.push(String(url));
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.headers, undefined);
    assert.equal(init?.body, undefined);
    assert.ok(init?.signal);
    return urls.length === 1
      ? new Response(null, { status: 302, headers: { location: '/schema' } })
      : new Response(body, { headers: { 'content-type': 'application/json' } });
  });
  assert.deepEqual(urls, ['https://example.com/start', 'https://example.com/schema']);
  assert.equal(result.body, body);
  assert.equal(result.bytes, Buffer.byteLength(body));
  assert.equal(result.sha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
});

test('HTTP read rejects credentials and non-HTTP redirects before dispatch', async () => {
  let calls = 0;
  const impl: typeof fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }); };
  for (const url of ['file:///tmp/read', 'https://user:secret@example.com/']) {
    await assert.rejects(boundedHttpRead(url, impl), /without embedded credentials/);
  }
  assert.equal(calls, 0);
  await assert.rejects(boundedHttpRead('https://example.com/', impl), /without embedded credentials/);
  assert.equal(calls, 1);
});

test('HTTP read retains HTTP failure status, bounds redirect loops and oversized bodies', async () => {
  const failed = await boundedHttpRead('https://example.com/', async () => new Response('missing', { status: 404 }));
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 404);
  assert.equal(failed.body, 'missing');
  let calls = 0;
  await assert.rejects(boundedHttpRead('https://example.com/', async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: '/again' } });
  }), /five redirects/);
  assert.equal(calls, 6);
  let cancelled = false;
  await assert.rejects(boundedHttpRead('https://example.com/', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(HTTP_READ_MAX_BYTES + 1)); },
    cancel() { cancelled = true; },
  }))), /1 MiB/);
  assert.equal(cancelled, true);
});
