import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestHeaders } from './api.js';

test('a JSON content-type is added once, whatever spelling the caller used', () => {
  assert.deepEqual(requestHeaders({ method: 'POST', body: '{}' }), { accept: 'application/json', 'content-type': 'application/json' });
  const capitalised = requestHeaders({ method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(Object.keys(capitalised).filter((k) => k.toLowerCase() === 'content-type').length, 1, 'never two spellings of one header');
  const file = requestHeaders({ method: 'POST', body: 'bytes', headers: { 'content-type': 'image/png' } });
  assert.equal(file['content-type'], 'image/png');
  assert.deepEqual(requestHeaders({ method: 'GET' }), { accept: 'application/json' });
});
