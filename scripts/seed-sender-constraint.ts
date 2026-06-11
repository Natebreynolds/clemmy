/**
 * One-time live seed for the 2026-06-11 wrong-mailbox fix.
 * Runs migration 12 against the live memory.db (widened kind CHECK), stores
 * the sender-identity rule as a kind='constraint' fact, pins it, and proves
 * the gate now sees it. Idempotent — rememberFact dedups on (kind, content).
 *
 * Run: npx tsx scripts/seed-sender-constraint.ts
 */
import { openMemoryDb, MEMORY_DB_PATH } from '../src/memory/db.js';
import { rememberFact, listConstraints } from '../src/memory/facts.js';
import { findEmailSendConstraint } from '../src/runtime/harness/constraint-guard.js';

const SENDER_RULE =
  'Email sending constraint: ALWAYS send email via the Scorpion Outlook mailbox nathan.reynolds@scorpion.com. ' +
  'Never send from any other connected mailbox (e.g. the Breakthrough Coaching account) unless Nate explicitly ' +
  'directs it in the current conversation. Verify the actual connected Outlook profile before any send.';

const db = openMemoryDb(); // runs migration 12 if pending

const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='consolidated_facts'`).get() as { sql: string }).sql;
if (!ddl.includes("'constraint'")) throw new Error('migration 12 did not apply — CHECK still narrow');
console.log(`✓ ${MEMORY_DB_PATH} schema admits kind='constraint' (migration 12 applied)`);

const fact = rememberFact({ kind: 'constraint', content: SENDER_RULE, importance: 9, trustLevel: 1.0 });
db.prepare('UPDATE consolidated_facts SET pinned = 1 WHERE id = ?').run(fact.id);
console.log(`✓ constraint fact stored + pinned: #${fact.id}`);

const constraints = listConstraints();
if (constraints.length === 0) throw new Error('listConstraints() still empty');
console.log(`✓ listConstraints() returns ${constraints.length} active constraint(s)`);

const rule = findEmailSendConstraint('OUTLOOK_OUTLOOK_SEND_EMAIL', { user_id: 'me' });
if (!rule) throw new Error('gate does not match the incident send shape');
console.log(`✓ gate applies to OUTLOOK_OUTLOOK_SEND_EMAIL — required sender: ${rule.allowedAccount}`);
