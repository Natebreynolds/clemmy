/**
 * One-off / on-demand cleanup of cross-service & async-task-post mis-bindings in
 * the tool-choice store (the 2026-06-22 DataForSEO "hard-error" pollution). This
 * is now a thin wrapper over the SAME logic the daemon runs automatically every
 * ~6h (src/memory/tool-choice-audit.ts) — kept for manual runs / verification.
 * invalidateToolChoice is RECOVERABLE (moves the choice to fallbacks; the record
 * is kept and re-learnable).
 *
 * Run: CLEMENTINE_HOME=~/.clementine-next npx tsx scripts/clean-polluted-toolchoices.ts [--dry-run]
 */
import { listConnectedToolkits } from '../src/integrations/composio/client.js';
import { auditAndHealToolChoices } from '../src/memory/tool-choice-audit.js';

const dryRun = process.argv.includes('--dry-run');
const known = (await listConnectedToolkits()).map((t) => t.slug).filter((s): s is string => Boolean(s));
console.log('connected toolkits:', JSON.stringify(known));

const hits = await auditAndHealToolChoices({ knownToolkits: known, dryRun });
console.log(`\n${dryRun ? 'Would invalidate' : 'Invalidated'} ${hits.length} polluted binding(s) (recoverable):`);
for (const h of hits) {
  console.log(`  - [${h.reason}] "${h.intent.slice(0, 70)}" → ${h.identifier}`);
}
if (!dryRun) console.log('\n(Records kept + recoverable; the write-time guard + the ~6h audit prevent recurrence.)');
