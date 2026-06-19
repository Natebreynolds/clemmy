/**
 * Smoke: the CLEMENTINE_MCP_ALLOWED_TOOLS filter actually shrinks the tools the
 * in-process MCP server ADVERTISES (which is what the Claude Agent SDK sends to the
 * model as schemas → fewer input tokens). Proves the token-saving mechanism behind
 * JIT for the Claude SDK brain.
 *
 * Run: npx tsx scripts/smoke-mcp-allowlist.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(REPO, 'src', 'tools', 'mcp-server.ts');

async function listTools(allowlist?: string): Promise<string[]> {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mcp-allow-'));
  mkdirSync(path.join(home, 'state'), { recursive: true });
  writeFileSync(path.join(home, 'state', 'machine-id'), 'm\n');
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', ENTRY],
    env: {
      ...process.env,
      CLEMENTINE_HOME: home,
      ...(allowlist ? { CLEMENTINE_MCP_ALLOWED_TOOLS: allowlist } : {}),
    } as Record<string, string>,
  });
  const client = new Client({ name: 'smoke', version: '0.0.1' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const res = await client.listTools();
    return res.tools.map((t) => t.name).sort();
  } finally {
    await client.close().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
}

const ALLOW = 'memory_recall,memory_search,ping';
const [all, filtered] = await Promise.all([listTools(), listTools(ALLOW)]);

console.log(`\n  full surface:     ${all.length} tools`);
console.log(`  with allowlist:   ${filtered.length} tools  (CLEMENTINE_MCP_ALLOWED_TOOLS=${ALLOW})`);
console.log(`  filtered set:     ${filtered.join(', ')}`);

const checks: Array<[string, boolean]> = [
  ['filtered surface is strictly smaller', filtered.length < all.length],
  ['allowed tool memory_recall survived', filtered.includes('memory_recall')],
  ['floor tool ping survived', filtered.includes('ping')],
  ['a non-allowed tool (workflow_create) was dropped', all.includes('workflow_create') && !filtered.includes('workflow_create')],
  ['filtered ⊆ {memory_recall, memory_search, ping}', filtered.every((n) => ALLOW.split(',').includes(n))],
];
let ok = true;
for (const [label, pass] of checks) { console.log(`  ${pass ? '✅' : '❌'} ${label}`); ok = ok && pass; }
console.log(ok ? '\n✅ MCP allow-list filter works — schema surface shrinks.' : '\n❌ allow-list filter FAILED.');
process.exit(ok ? 0 : 1);
