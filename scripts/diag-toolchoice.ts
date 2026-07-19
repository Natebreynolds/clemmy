/**
 * What DataForSEO tool choice does a WORKER actually receive? Inspect Alexander's
 * live tool-choice store + what renderToolChoicesForContext injects for an
 * SEO-pull objective. Read-only.
 * Run: CLEMENTINE_HOME=~/.clementine-next npx tsx scripts/diag-toolchoice.ts
 */
import { renderToolChoicesForContext, listToolChoices } from '../src/memory/tool-choice-store.js';

const OBJECTIVE = 'pull recent organic search performance, ranked keywords and estimated traffic for a client domain via DataForSEO';

console.log('=== ALL stored DataForSEO tool choices (identifier · testedAt · raw) ===');
let all: ReturnType<typeof listToolChoices> = [];
try { all = listToolChoices(); } catch (e) { console.log('listToolChoices threw:', (e as Error).message); }
const dfs = all.filter((r) => JSON.stringify(r).toLowerCase().includes('dataforseo'));
for (const r of dfs) {
  console.log(`\n  intent: ${r.intent}`);
  console.log(`  choice: ${JSON.stringify(r.choice)}`);
}
console.log(`\n(${dfs.length} DataForSEO records of ${all.length} total)`);

console.log('\n\n=== WHAT A WORKER WOULD BE INJECTED for the SEO-pull objective ===');
const injected = renderToolChoicesForContext(12, undefined, OBJECTIVE);
console.log(injected || '(EMPTY — nothing injected; either contextInject disabled or no relevant match)');
