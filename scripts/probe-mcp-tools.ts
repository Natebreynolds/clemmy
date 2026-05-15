/**
 * Probe each configured MCP server individually (NOT the namespace
 * shim — for that, run `scripts/smoke-dataforseo-shim.ts`).
 *
 * Useful when one server is failing and you need to figure out which
 * one. Iterates the RAW per-server list, connects to each, and
 * counts tools.
 *
 * Run: npx tsx scripts/probe-mcp-tools.ts
 */
import { setDefaultOpenAIKey } from '@openai/agents';
import { getOpenAiApiKey } from '../src/config.js';
import { listRawMcpServers } from '../src/runtime/mcp-servers.js';

async function main() {
  const key = getOpenAiApiKey();
  if (key) setDefaultOpenAIKey(key);

  // listRawMcpServers() — the escape hatch that still returns the
  // per-server array. createConfiguredMcpServers() returns a single
  // namespace-shim MCPServer; that's not what we want to inspect here.
  const servers = listRawMcpServers();
  console.log(`Configured MCP servers: ${servers.length}`);
  for (const server of servers) {
    const name = (server as { name?: string }).name || '(unnamed)';
    process.stdout.write(`  ${name}: `);
    try {
      if (typeof server.connect === 'function') {
        await server.connect();
      }
      const tools = typeof server.listTools === 'function'
        ? await server.listTools()
        : null;
      if (Array.isArray(tools)) {
        console.log(`OK · ${tools.length} tools`);
        for (const t of tools.slice(0, 4)) console.log(`     - ${t.name || '(no name)'}`);
        if (tools.length > 4) console.log(`     ... and ${tools.length - 4} more`);
      } else {
        console.log('OK (no listTools method)');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log('FAILED:', msg.slice(0, 200));
    }
  }
  for (const server of servers) {
    if (typeof server.close === 'function') {
      try { await server.close(); } catch { /* ignore */ }
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
