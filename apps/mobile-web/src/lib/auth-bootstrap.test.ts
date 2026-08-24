import assert from 'node:assert/strict';
import test from 'node:test';
import { authBootstrapMode } from './auth-bootstrap.js';

test('credential boot has exactly one auth owner', () => {
  assert.equal(authBootstrapMode(''), 'status');
  assert.equal(authBootstrapMode('?tab=chats'), 'status');
  assert.equal(authBootstrapMode('?pair=one-time-token&fp=pin'), 'pair');
  assert.equal(authBootstrapMode('?adopt=one-time-handoff'), 'adopt');
});

test('pairing wins rather than racing adoption when both parameters exist', () => {
  assert.equal(authBootstrapMode('?adopt=handoff&pair=pairing-code'), 'pair');
});

test('empty credential parameters do not suppress the ordinary status boot', () => {
  assert.equal(authBootstrapMode('?pair='), 'status');
  assert.equal(authBootstrapMode('?adopt='), 'status');
});
