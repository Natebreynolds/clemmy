/**
 * Run: node scripts/run-tests-isolated.mjs src/integrations/kernel-mcp.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { registerKernelMcpServer, kernelMcpServerConfig, KERNEL_MCP_URL } = await import('./kernel-mcp.js');

test('connecting Kernel registers its MCP server with the key in the declared environment and the header naming it', () => {
  let saved: Record<string, unknown> | undefined;
  const result = registerKernelMcpServer('kernel-private-key', { load: () => ({ other: { name: 'other', type: 'stdio', command: 'x', enabled: true } }), save: (servers) => { saved = servers; } });
  assert.deepEqual(result, { registered: true, keptExisting: false });
  const kernel = saved?.kernel as ReturnType<typeof kernelMcpServerConfig>;
  assert.equal(kernel.url, KERNEL_MCP_URL); assert.equal(kernel.type, 'http'); assert.equal(kernel.enabled, true);
  assert.deepEqual(kernel.headers, { Authorization: 'Bearer ${KERNEL_API_KEY}' }, 'the header names the value; the value is not written into it');
  assert.deepEqual(kernel.env, { KERNEL_API_KEY: 'kernel-private-key' });
  assert.ok(saved?.other, 'other servers are kept');
  assert.match(kernel.description, /first-party cloud browser/);
});

test('a Kernel server the owner configured by hand, at another URL, is left alone; a disabled registration keeps its disabled state', () => {
  let saved: Record<string, unknown> | undefined;
  const kept = registerKernelMcpServer('k', { load: () => ({ kernel: { name: 'kernel', type: 'http', url: 'https://example.test/mcp', enabled: true } }), save: (servers) => { saved = servers; } });
  assert.deepEqual(kept, { registered: false, keptExisting: true }); assert.equal(saved, undefined);
  const refreshed = registerKernelMcpServer('k2', { load: () => ({ kernel: { name: 'kernel', type: 'http', url: KERNEL_MCP_URL, enabled: false, env: { KERNEL_API_KEY: 'old' } } }), save: (servers) => { saved = servers; } });
  assert.equal(refreshed.registered, true);
  const kernel = saved?.kernel as { enabled: boolean; env: Record<string, string> };
  assert.equal(kernel.enabled, false, 'the owner turned it off; a new key does not turn it on');
  assert.equal(kernel.env.KERNEL_API_KEY, 'k2', 'the key is refreshed');
});
