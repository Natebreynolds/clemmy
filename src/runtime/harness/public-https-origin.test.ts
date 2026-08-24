import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPublicHttpsOriginTransport,
  isPublicHttpsOriginAddress,
  selectPinnedPublicHttpsOriginAddress,
} from './public-https-origin.js';

test('literal local, metadata, private, documentation, and mapped addresses are not public origins', () => {
  for (const address of [
    '127.0.0.1', '0.0.0.0', '10.0.0.1', '100.64.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.1.1', '192.0.2.1', '198.51.100.1', '203.0.113.1',
    '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1',
  ]) assert.equal(isPublicHttpsOriginAddress(address), false, address);
  assert.equal(isPublicHttpsOriginAddress('8.8.8.8'), true);
  assert.equal(isPublicHttpsOriginAddress('2606:4700:4700::1111'), true);
  for (const url of [
    'https://127.0.0.1/file',
    'https://[::1]/file',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost/file',
    'https://api.localhost/file',
    'http://storage.example/file',
    'https://user:pass@storage.example/file',
  ]) assert.equal(createPublicHttpsOriginTransport(url), null, url);
});

test('mixed DNS observations refuse and all-public observations pin deterministically', () => {
  assert.equal(selectPinnedPublicHttpsOriginAddress([
    { address: '8.8.8.8', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]), null, 'one private answer refuses the whole observation');
  assert.deepEqual(selectPinnedPublicHttpsOriginAddress([
    { address: '2606:4700:4700::1111', family: 6 },
    { address: '8.8.4.4', family: 4 },
    { address: '8.8.8.8', family: 4 },
  ]), { address: '8.8.4.4', family: 4 });
});

test('a public hostname receives one connection-local no-redirect dispatcher', async () => {
  const transport = createPublicHttpsOriginTransport('https://storage.example/file');
  assert.ok(transport);
  assert.equal(typeof transport.dispatcher.dispatch, 'function');
  await transport.close();
});
