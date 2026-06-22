/**
 * Confirm the concurrency hypothesis: DataForSEO works sequentially but fails
 * under the parallel worker fan-out. Fire N calls AT ONCE (Promise.all, like the
 * fan-out) and report each one's status. Read-only.
 * Run: CLEMENTINE_HOME=~/.clementine-next npx tsx scripts/diag-dataforseo-concurrency.ts
 */
import { executeComposioTool } from '../src/integrations/composio/client.js';

const SLUG = 'DATAFORSEO_GET_GOOGLE_HIST_BULK_TRAFFIC_EST_LIVE';
const targets = ['ramoslaw.com', 'coloradolaw.net', 'zanerhardenlaw.com', 'adlergiersch.com', 'damorelaw.com'];

function classify(r: unknown): string {
  const s = typeof r === 'string' ? r : JSON.stringify(r);
  const code = s.match(/"status_code":\s*(\d+)/)?.[1];
  if (code === '20000') return `OK (20000, len=${s.length})`;
  return `NON-OK status_code=${code ?? '?'} :: ${s.slice(0, 180)}`;
}

console.log(`\n--- BURST: ${targets.length} DataForSEO calls IN PARALLEL (mimics the worker fan-out) ---`);
const results = await Promise.allSettled(
  targets.map((t) =>
    executeComposioTool(SLUG, {
      targets: [t], item_types: ['organic', 'paid', 'featured_snippet', 'local_pack'],
      language_code: 'en', location_code: 2840,
    }),
  ),
);
results.forEach((res, i) => {
  if (res.status === 'fulfilled') console.log(`  [${targets[i]}] ${classify(res.value)}`);
  else console.log(`  [${targets[i]}] THREW: ${(res.reason as Error)?.message?.slice(0, 220)}`);
});

const ok = results.filter((r) => r.status === 'fulfilled' && JSON.stringify(r.value).includes('"status_code":20000')).length;
const threw = results.filter((r) => r.status === 'rejected').length;
console.log(`\nSUMMARY: ${ok}/${targets.length} OK, ${threw} threw, ${targets.length - ok - threw} non-OK. ${threw > 0 || ok < targets.length ? 'CONCURRENCY FAILURE CONFIRMED' : 'all parallel calls succeeded'}`);
