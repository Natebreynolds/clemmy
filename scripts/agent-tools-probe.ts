import { setDefaultOpenAIKey } from '@openai/agents';
import { getOpenAiApiKey } from '/Users/nathan.reynolds/clementine-next/src/config.ts';
import { createConfiguredMcpServers } from '/Users/nathan.reynolds/clementine-next/src/runtime/mcp-servers.ts';

async function main() {
  const key = getOpenAiApiKey();
  if (key) setDefaultOpenAIKey(key);
  const servers = createConfiguredMcpServers();
  console.log('Configured MCP servers:', servers.length);
  for (const server of servers) {
    const name = (server as any).name || '(unnamed)';
    process.stdout.write(`  ${name}: `);
    try {
      if (typeof (server as any).connect === 'function') {
        await (server as any).connect();
      }
      const tools = typeof (server as any).listTools === 'function'
        ? await (server as any).listTools()
        : null;
      if (Array.isArray(tools)) {
        console.log(`✓ connected · ${tools.length} tools`);
        for (const t of tools.slice(0, 4)) console.log(`     · ${t.name || '(no name)'}`);
        if (tools.length > 4) console.log(`     · ... and ${tools.length - 4} more`);
      } else {
        console.log('✓ connected (no listTools method)');
      }
    } catch (err: any) {
      console.log('✗ FAILED:', (err.message || String(err)).slice(0, 200));
    }
  }
  for (const server of servers) {
    if (typeof (server as any).close === 'function') {
      try { await (server as any).close(); } catch {}
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
