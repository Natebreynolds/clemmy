import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSurvivableSocketError } from './process.js';

// 2026-07-08: a Slack socket-mode reconnect emitted an unhandled 'error' on a
// raw ws WebSocket ("Opening handshake has timed out") and the uncaughtException
// killed the daemon (exit 1) mid-conversation. The guard must swallow exactly
// that transport class and nothing else.
test('isSurvivableSocketError: the observed ws handshake-timeout crash is survivable', () => {
  const err = new Error('Opening handshake has timed out');
  err.stack = `Error: Opening handshake has timed out
    at ClientRequest.<anonymous> (/Applications/Clementine.app/Contents/Resources/daemon/node_modules/ws/lib/websocket.js:890:7)
    at ClientRequest.emit (node:events:509:28)`;
  assert.equal(isSurvivableSocketError(err), true);
});

test('isSurvivableSocketError: any error surfaced from ws/lib/websocket.js is survivable (reconnect machinery owns it)', () => {
  const err = new Error('read ECONNRESET');
  err.stack = `Error: read ECONNRESET
    at emitErrorAndClose (/app/node_modules/ws/lib/websocket.js:1060:13)`;
  assert.equal(isSurvivableSocketError(err), true);
});

test('isSurvivableSocketError: ordinary errors are NOT survivable — the daemon must still crash on real bugs', () => {
  assert.equal(isSurvivableSocketError(new Error('Cannot read properties of undefined')), false);
  assert.equal(isSurvivableSocketError(new TypeError('x is not a function')), false);
  assert.equal(isSurvivableSocketError('string reason'), false);
  assert.equal(isSurvivableSocketError(undefined), false);
});
