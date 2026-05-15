/**
 * Smoke test: prove the MCP namespace shim works end-to-end against
 * a real MCP server (DataForSEO).
 *
 * Pass criteria:
 *   1. The shim connects without throwing the SDK's duplicate-name UserError.
 *   2. listTools() returns >0 tools and >=1 of them is dataforseo__<...>.
 *   3. We can pick one DataForSEO tool, callTool() through the shim
 *      with the namespaced name, and get a structured response back.
 *
 * Run: npx tsx scripts/smoke-dataforseo-shim.ts
 */
import { setDefaultOpenAIKey } from '@openai/agents';
import { getOpenAiApiKey } from '../src/config.js';
import { createConfiguredMcpServers } from '../src/runtime/mcp-servers.js';

function summarizeResult(value: unknown, limit = 400): string {
  try {
    const s = JSON.stringify(value, null, 2);
    return s.length > limit ? `${s.slice(0, limit)}…` : s;
  } catch {
    return String(value).slice(0, limit);
  }
}

async function main() {
  const key = getOpenAiApiKey();
  if (key) setDefaultOpenAIKey(key);

  console.log('▸ creating shim');
  const shim = createConfiguredMcpServers();
  console.log(`  shim.name = ${shim.name}`);

  console.log('▸ connecting shim (parallel fan-out to every configured server)');
  if (typeof shim.connect === 'function') {
    await shim.connect();
  }

  console.log('▸ listing tools through shim');
  const tools = await shim.listTools();
  console.log(`  total tools across all servers: ${tools.length}`);

  // Group by server prefix so we see at a glance what registered.
  const byServer = new Map<string, string[]>();
  for (const t of tools) {
    const sep = t.name.indexOf('__');
    const server = sep > 0 ? t.name.slice(0, sep) : '(unprefixed)';
    const local = sep > 0 ? t.name.slice(sep + 2) : t.name;
    if (!byServer.has(server)) byServer.set(server, []);
    byServer.get(server)!.push(local);
  }
  for (const [server, list] of [...byServer.entries()].sort()) {
    console.log(`  • ${server}: ${list.length} tools`);
  }

  const dataforseoTools = tools.filter((t) => t.name.startsWith('dataforseo__'));
  if (dataforseoTools.length === 0) {
    console.error('✗ no DataForSEO tools registered through the shim');
    process.exit(2);
  }
  console.log(`▸ ${dataforseoTools.length} DataForSEO tools available through shim`);

  // Pick the cheapest deterministic call we can: kw_data_google_ads_locations
  // takes no required args. Falls back to whatever tool we can find if the
  // exact tool name isn't present (DataForSEO occasionally rotates).
  const pickedFromList = (preferred: string[]) =>
    dataforseoTools.find((t) => preferred.includes(t.name)) ?? dataforseoTools[0];
  // Build a (toolName, args) pair we can actually expect to succeed.
  // serp_locations needs a country_iso_code; the other two take no
  // required args. We pick whichever exists, with a matching arg shape.
  const callPlan: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: 'dataforseo__serp_locations', args: { country_iso_code: 'US' } },
    { name: 'dataforseo__dataforseo_labs_available_filters', args: {} },
    { name: 'dataforseo__kw_data_google_ads_locations', args: {} },
  ];
  const plan =
    callPlan.find((p) => dataforseoTools.some((t) => t.name === p.name)) ??
    { name: dataforseoTools[0].name, args: {} };
  console.log(`▸ invoking ${plan.name} through the shim with args ${JSON.stringify(plan.args)}`);

  const t0 = Date.now();
  let result: unknown;
  try {
    result = await shim.callTool(plan.name, plan.args);
  } catch (err) {
    console.error(`✗ shim.callTool threw: ${err instanceof Error ? err.message : String(err)}`);
    if (typeof shim.close === 'function') await shim.close();
    process.exit(3);
  }
  const dt = Date.now() - t0;
  console.log(`  ✓ call returned in ${dt}ms`);
  console.log(`  response (truncated): ${summarizeResult(result)}`);

  console.log('▸ closing shim');
  if (typeof shim.close === 'function') {
    await shim.close();
  }
  console.log('✓ smoke test passed');
  process.exit(0);
}

main().catch((e) => { console.error('uncaught:', e); process.exit(1); });
