/**
 * One-off cleanup: invalidate the cross-service / async-task-post mis-bindings in
 * the tool-choice store that caused workers to "hard-error" on DataForSEO
 * (2026-06-22). Uses the SAME guard logic shipped in composio-tools so the
 * cleanup matches what the guard now prevents. invalidateToolChoice is
 * RECOVERABLE (moves the choice to fallbacks, record kept, re-learnable).
 * Run: CLEMENTINE_HOME=~/.clementine-next npx tsx scripts/clean-polluted-toolchoices.ts
 */
import { listToolChoices, invalidateToolChoice } from '../src/memory/tool-choice-store.js';
import { isCrossServiceToolkitMismatch } from '../src/tools/composio-tools.js';
import { listConnectedToolkits } from '../src/integrations/composio/client.js';

const known = (await listConnectedToolkits()).map((t) => t.slug).filter((s): s is string => Boolean(s));
console.log('connected toolkits:', JSON.stringify(known));

const all = listToolChoices().filter((r) => r.choice && r.choice.kind === 'composio');
type Hit = { intent: string; identifier: string; reason: string };
const hits: Hit[] = [];

for (const r of all) {
  const id = r.choice!.identifier;
  const intent = r.intent;
  // (1) cross-service mismatch — query about toolkit X bound to slug from toolkit Y
  if (isCrossServiceToolkitMismatch(intent, id, known)) {
    hits.push({ intent, identifier: id, reason: 'cross_service_mismatch' });
    continue;
  }
  // (2) async task-post bound to a "live" data intent — returns a task id, not data
  if (/_TASK_POST$/i.test(id) && /\blive\b/i.test(intent)) {
    hits.push({ intent, identifier: id, reason: 'async_taskpost_for_live_intent' });
  }
}

console.log(`\nFound ${hits.length} polluted binding(s) to invalidate (recoverable):`);
for (const h of hits) {
  console.log(`  - [${h.reason}] "${h.intent.slice(0, 70)}" → ${h.identifier}`);
}

let done = 0;
for (const h of hits) {
  const res = invalidateToolChoice(h.intent, `cleanup:${h.reason}`, { automatic: true });
  if (res && !res.choice) done++;
}
console.log(`\nInvalidated ${done}/${hits.length}. (Records kept + recoverable; the new auto-remember guard prevents recurrence.)`);
