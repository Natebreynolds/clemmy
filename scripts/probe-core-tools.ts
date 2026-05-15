/**
 * Smoke: what tools does getCoreToolsAsync({ includeDynamicComposioTools: true })
 * actually return on this daemon's current state?
 *
 * Run: npx tsx scripts/probe-core-tools.ts
 */
import { getCoreToolsAsync } from '../src/tools/registry.js';

async function main() {
  const tools = await getCoreToolsAsync({ includeDynamicComposioTools: true });
  console.log(`total tools: ${tools.length}`);
  const byPrefix = new Map<string, number>();
  for (const t of tools) {
    const name = (t as any).name as string;
    const prefix = name.startsWith('cx_') ? 'cx_*' : name.split('_')[0];
    byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
  }
  console.log('grouped by prefix:');
  for (const [k, v] of [...byPrefix.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
  // List googlesheets specifically
  const gs = tools.filter((t) => ((t as any).name as string).startsWith('cx_googlesheets_'));
  console.log(`\ncx_googlesheets_* tools (${gs.length}):`);
  for (const t of gs) console.log(`  - ${(t as any).name}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
