import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_BODY_TIMEOUT_MS,
  CODEX_HEADERS_TIMEOUT_MS,
  buildTransportTimeoutError,
  detectCodexTransportFailure,
} from './codex-dispatcher.js';
import { BoundaryError } from './boundary-error.js';

test('the body timeout is a dead-socket guard sized above a legitimate reasoning gap; headers stay a short liveness check', () => {
  // The owner-visible pace is owned by the harness walls (first-content
  // fallover, stream-stall watchdog), never by this socket timeout. A body
  // window below a real reasoning pause fires falsely and re-pays the prefill.
  assert.equal(CODEX_BODY_TIMEOUT_MS, 120_000);
  assert.equal(CODEX_HEADERS_TIMEOUT_MS, 15_000);
  assert.ok(CODEX_BODY_TIMEOUT_MS > CODEX_HEADERS_TIMEOUT_MS);
});

test('a transport timeout carries the undici code and the budget it spent so the retry budget and ledger can name the class', () => {
  const body = buildTransportTimeoutError('UND_ERR_BODY_TIMEOUT', { phase: 'body' });
  assert.ok(body instanceof BoundaryError);
  assert.equal(body.kind, 'codex.transport_timeout');
  assert.equal(body.retryable, true);
  assert.equal(body.context.undiciCode, 'UND_ERR_BODY_TIMEOUT');
  assert.equal(body.context.budgetMs, CODEX_BODY_TIMEOUT_MS);
  assert.equal(body.context.phase, 'body');

  const headers = buildTransportTimeoutError('UND_ERR_HEADERS_TIMEOUT', { phase: 'headers' });
  assert.equal(headers.context.undiciCode, 'UND_ERR_HEADERS_TIMEOUT');
  assert.equal(headers.context.budgetMs, CODEX_HEADERS_TIMEOUT_MS);

  const terminated = buildTransportTimeoutError('FETCH_TERMINATED', {}, new TypeError('terminated'));
  assert.equal(terminated.context.undiciCode, 'FETCH_TERMINATED');
  assert.equal(terminated.context.budgetMs, null);
});

test('detectCodexTransportFailure reads the undici code from the error or its cause', () => {
  assert.equal(detectCodexTransportFailure(Object.assign(new Error('x'), { code: 'UND_ERR_BODY_TIMEOUT' })), 'UND_ERR_BODY_TIMEOUT');
  assert.equal(
    detectCodexTransportFailure(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) })),
    'UND_ERR_HEADERS_TIMEOUT',
  );
  assert.equal(detectCodexTransportFailure(new TypeError('terminated')), 'FETCH_TERMINATED');
  assert.equal(detectCodexTransportFailure(new Error('invalid model configuration')), null);
});
