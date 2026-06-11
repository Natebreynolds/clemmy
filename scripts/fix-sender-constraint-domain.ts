/**
 * Correct the seeded sender rule to the GROUND-TRUTH Scorpion mailbox.
 * The dictated facts said nathan.reynolds@scorpion.com, but the actual
 * connected mailbox (ca_T9pDCuTalAI3) is Nathan.Reynolds@scorpion.co —
 * a .com rule would block even the correct account. Prints the connection's
 * full alias list first so the decision is evidence-based.
 *
 * Run: npx tsx scripts/fix-sender-constraint-domain.ts
 */
import { openMemoryDb } from '../src/memory/db.js';
import { rememberFact, listConstraints } from '../src/memory/facts.js';
import { executeComposioTool } from '../src/integrations/composio/client.js';
import { extractMailboxEmails } from '../src/runtime/harness/sender-verify.js';

const SCORPION_CONNECTION = 'ca_T9pDCuTalAI3';
const profile = await executeComposioTool('OUTLOOK_GET_PROFILE', { user_id: 'me', include_proxy_addresses: true }, SCORPION_CONNECTION);
const emails = extractMailboxEmails(profile);
console.log(`Scorpion connection identities: ${emails.join(', ')}`);
if (!emails.includes('nathan.reynolds@scorpion.co')) {
  throw new Error('expected scorpion.co mailbox not found — aborting, no change made');
}

const NEW_RULE =
  'Email sending constraint: ALWAYS send email via the Scorpion Outlook mailbox nathan.reynolds@scorpion.co. ' +
  'Multiple Outlook accounts are connected on purpose (read/scrape all of them) — but sends go ONLY from the ' +
  'Scorpion mailbox unless Nate explicitly directs otherwise in the current conversation. The dispatch gate ' +
  'verifies the actual connected mailbox and routes to the compliant connection automatically.';

const db = openMemoryDb();
db.prepare(`UPDATE consolidated_facts SET active = 0, updated_at = ? WHERE id = 1144`).run(new Date().toISOString());
const fact = rememberFact({ kind: 'constraint', content: NEW_RULE, importance: 9, trustLevel: 1.0 });
db.prepare('UPDATE consolidated_facts SET pinned = 1 WHERE id = ?').run(fact.id);
console.log(`✓ #1144 retired; new constraint #${fact.id} stored + pinned (scorpion.co)`);

const active = listConstraints();
console.log(`✓ active constraints: ${active.map((c) => `#${c.id}`).join(', ')}`);
