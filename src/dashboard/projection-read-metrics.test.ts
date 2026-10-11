import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import express from 'express';
import {
  catalogProjectionMetricsForRequest, measureProjectionRead, ProjectionReadMetrics,
  sendCatalogProjectionJson,
} from './projection-read-metrics.js';

test('observation cannot change identity, calls or the exact thrown error', () => {
  const result = { secretFixtureText: 'not a metric' };
  let calls = 0;
  const throwingObserver = () => { throw new Error('observer must not escape'); };
  assert.equal(measureProjectionRead(throwingObserver, 'catalog_pages', () => { calls++; return result; }), result);
  assert.equal(calls, 1);
  const error = new Error('original operation');
  assert.throws(() => measureProjectionRead(throwingObserver, 'catalog_pages', () => { throw error; }), (actual) => actual === error);
  assert.equal(measureProjectionRead(undefined, 'catalog_pages', () => result), result);
  assert.equal(measureProjectionRead(throwingObserver, 'catalog_pages', () => result, () => { throw new Error('counter'); }), result);
});

test('opt-in requires authentication and the actual loopback peer', () => {
  for (const peerAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.ok(catalogProjectionMetricsForRequest({ authorized: true, peerAddress, optIn: '1' }));
    assert.equal(catalogProjectionMetricsForRequest({ authorized: false, peerAddress, optIn: '1' }), undefined);
  }
  for (const peerAddress of ['192.0.2.9', '127.0.0.1.evil', undefined]) {
    assert.equal(catalogProjectionMetricsForRequest({ authorized: true, peerAddress, optIn: '1' }), undefined);
  }
  for (const optIn of [undefined, ['1'], 'true', '1;fixture-secret']) {
    assert.equal(catalogProjectionMetricsForRequest({ authorized: true, peerAddress: '127.0.0.1', optIn }), undefined);
  }
});

test('inclusive overlapping phases retain separate values; missing proof is unobserved or unknown', () => {
  const metrics = new ProjectionReadMetrics();
  metrics.observe('catalog_build', { durationMs: 10, failed: false });
  metrics.observe('catalog_collect', { durationMs: 7, failed: false });
  metrics.observe('catalog_pages', { durationMs: 5, failed: false, items: 2 });
  metrics.observe('catalog_pages', { durationMs: 2, failed: true });
  metrics.observe('private fixture content' as never, { durationMs: 100, failed: false });
  metrics.observe('catalog_preview', { durationMs: NaN, failed: false, items: -1 });
  const headers = metrics.headers();
  assert.match(headers['Server-Timing']!, /catalog_build;dur=10\.000;desc="inclusive"/);
  assert.match(headers['Server-Timing']!, /catalog_collect;dur=7\.000;desc="inclusive"/);
  assert.match(headers['Server-Timing']!, /catalog_pages;dur=7\.000;desc="inclusive"/);
  assert.match(headers['Server-Timing']!, /catalog_preview;desc="unobserved"/);
  assert.match(headers['Server-Timing']!, /catalog_queue;desc="unknown"/);
  assert.match(headers['X-Clementine-Projection-Counts']!, /catalog_pages_calls=2/);
  assert.match(headers['X-Clementine-Projection-Counts']!, /catalog_pages_failures=1/);
  assert.doesNotMatch(JSON.stringify(headers), /private|fixture|dur=24\.000|NaN/);
});

/** Real Express JSON/send methods with an in-memory terminal; no server. */
function responseFor(app = express()) {
  const headers = new Map<string, string>();
  let body = '';
  const response = Object.create(express.response) as express.Response;
  response.app = app;
  response.req = { method: 'GET', fresh: false } as express.Request;
  response.statusCode = 200;
  response.setHeader = ((key: string, value: string) => { headers.set(key.toLowerCase(), String(value)); return response; }) as never;
  response.getHeader = ((key: string) => headers.get(key.toLowerCase())) as never;
  response.removeHeader = ((key: string) => { headers.delete(key.toLowerCase()); }) as never;
  response.end = ((value: string | Buffer) => { body = value.toString(); return response; }) as never;
  return { response, headers, body: () => body };
}

test('send boundary preserves Express JSON bytes/settings and restores send', () => {
  const app = express();
  app.set('json spaces', 2);
  app.set('json escape', true);
  app.set('json replacer', (key: string, value: unknown) => key === 'hidden' ? undefined : value);
  const fixture = { text: '<fixture & private>', hidden: 'not serialized', list: [1, null] };
  const normal = responseFor(app);
  const observed = responseFor(app);
  const originalSend = observed.response.send;
  normal.response.json(fixture);
  sendCatalogProjectionJson(observed.response, fixture, new ProjectionReadMetrics(), performance.now());
  assert.equal(observed.body(), normal.body());
  assert.equal(observed.response.send, originalSend);
  assert.equal(observed.headers.get('content-type'), normal.headers.get('content-type'));
  assert.match(observed.headers.get('server-timing')!, /catalog_serialize;dur=[\d.]+/);
  assert.doesNotMatch(JSON.stringify([...observed.headers]), /fixture|private|hidden/);
  assert.equal(normal.headers.has('server-timing'), false);
});

test('serialization errors remain errors and telemetry/header failures do not suppress a response', () => {
  const metrics = new ProjectionReadMetrics();
  const response = responseFor();
  const originalSend = response.response.send;
  const error = new Error('exact serializer failure');
  response.response.json = (() => { throw error; }) as never;
  assert.throws(() => sendCatalogProjectionJson(response.response, {}, metrics, performance.now()), (actual) => actual === error);
  assert.equal(response.response.send, originalSend);
  assert.match(metrics.headers()['X-Clementine-Projection-Counts']!, /catalog_serialize_failures=1/);
  const headersFailure = responseFor();
  metrics.headers = () => { throw new Error('telemetry headers'); };
  sendCatalogProjectionJson(headersFailure.response, { unchanged: true }, metrics, performance.now());
  assert.equal(headersFailure.body(), '{"unchanged":true}');
  assert.equal(headersFailure.response.send, originalSend);
});
