import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { boundedHttpRead, HTTP_READ_IMAGE_MAX_BYTES, HTTP_READ_MAX_BYTES } from './bounded-http-read.js';

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

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);

test('an image URL comes back as the image itself, when the bytes agree with the declared type', async () => {
  const shown = await boundedHttpRead('https://example.com/thumb', async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
  assert.deepEqual(shown.image, { data: PNG.toString('base64'), mimeType: 'image/png' });
  assert.equal(shown.body, undefined, 'the pixels are not also sent as text');
  assert.equal(shown.sha256, createHash('sha256').update(PNG).digest('hex'));
  // The bytes decide the type, not the header.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  assert.equal((await boundedHttpRead('https://example.com/a', async () => new Response(jpeg, { headers: { 'content-type': 'image/png' } }))).image?.mimeType, 'image/jpeg');
  // A page that only claims to be an image is text.
  const claimed = await boundedHttpRead('https://example.com/b', async () => new Response('<html>no</html>', { headers: { 'content-type': 'image/png' } }));
  assert.equal(claimed.image, undefined);
  assert.equal(claimed.body, '<html>no</html>');
  // An unsupported image type and a failed request stay text evidence.
  assert.equal((await boundedHttpRead('https://example.com/c', async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }))).body, '<svg/>');
  const missing = await boundedHttpRead('https://example.com/d', async () => new Response(PNG, { status: 404, headers: { 'content-type': 'image/png' } }));
  assert.equal(missing.image, undefined);
  assert.equal(missing.ok, false);
});

test('an image may be larger than text, up to the viewing limit', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(HTTP_READ_MAX_BYTES + 10)]);
  assert.equal((await boundedHttpRead('https://example.com/big', async () => new Response(big, { headers: { 'content-type': 'image/png' } }))).image?.mimeType, 'image/png');
  const tooBig = Buffer.concat([PNG, Buffer.alloc(HTTP_READ_IMAGE_MAX_BYTES)]);
  await assert.rejects(boundedHttpRead('https://example.com/huge', async () => new Response(tooBig, { headers: { 'content-type': 'image/png' } })), /viewing limit/);
});
