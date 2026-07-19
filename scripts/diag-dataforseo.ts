/**
 * Diagnostic: call the exact DataForSEO endpoint Clementine uses, via the real
 * execution path (executeComposioTool), for caller-supplied domains. This can
 * distinguish quota/global failure from domain-specific behavior.
 * Read-only. Run with positional domains or:
 * CLEMMY_DATAFORSEO_TARGETS="DOMAIN_A,DOMAIN_B" npx tsx scripts/diag-dataforseo.ts
 */
import { executeComposioTool } from '../src/integrations/composio/client.js';
import { readLiveDomains } from './lib/live-domain-input.js';

const SLUG = 'DATAFORSEO_GET_GOOGLE_HIST_BULK_TRAFFIC_EST_LIVE';
const targets = readLiveDomains({
  envName: 'CLEMMY_DATAFORSEO_TARGETS',
  usage: 'Usage: npx tsx scripts/diag-dataforseo.ts DOMAIN [DOMAIN ...]',
});

function summarize(label: string, r: unknown): void {
  const s = typeof r === 'string' ? r : JSON.stringify(r);
  // Pull the status_code / status_message / error shape Composio/DataForSEO returns.
  const statusCode = s.match(/"status_code":\s*(\d+)/)?.[1];
  const statusMsg = s.match(/"status_message":\s*"([^"]{0,120})"/)?.[1];
  const errorField = s.match(/"error[^"]*":\s*"?([^",}]{0,160})/)?.[1];
  const successful = s.includes('"value"') && /"etv":/.test(s);
  console.log(`\n=== ${label} ===`);
  console.log(`  len=${s.length} hasETV=${successful} status_code=${statusCode ?? '?'} status_message=${statusMsg ?? '?'}`);
  if (errorField) console.log(`  error=${errorField}`);
  console.log(`  head: ${s.slice(0, 300)}`);
}

for (const target of targets) {
  const args = {
    targets: [target],
    item_types: ['organic', 'paid', 'featured_snippet', 'local_pack'],
    language_code: 'en',
    location_code: 2840,
  };
  try {
    const r = await executeComposioTool(SLUG, args);
    summarize(`${target} (returned)`, r);
  } catch (e) {
    const err = e as Error;
    console.log(`\n=== ${target} (THREW) ===`);
    console.log(`  message: ${err?.message?.slice(0, 400)}`);
    console.log(`  stack: ${err?.stack?.split('\n').slice(0, 3).join(' | ').slice(0, 400)}`);
  }
}
console.log('\ndone.');
