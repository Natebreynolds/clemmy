import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { __test__ } from './codex-native-oauth.js';

test('Codex OAuth callback accepts both IPv4 and IPv6 localhost resolutions', async () => {
  const servers = await __test__.listenOnLoopbacks(0, (_req, res) => {
    res.statusCode = 200;
    res.end('ok');
  });
  const address = servers[0].address() as AddressInfo;
  try {
    const ipv4 = await fetch(`http://127.0.0.1:${address.port}/auth/callback`);
    assert.equal(ipv4.status, 200);
    assert.equal(await ipv4.text(), 'ok');

    const ipv6Server = servers.find((server) => (server.address() as AddressInfo | null)?.family === 'IPv6');
    if (ipv6Server) {
      const ipv6 = await fetch(`http://[::1]:${address.port}/auth/callback`);
      assert.equal(ipv6.status, 200);
      assert.equal(await ipv6.text(), 'ok');
    }
  } finally {
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
