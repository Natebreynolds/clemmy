/**
 * Live replay of the 2026-06-11 wrong-mailbox incident send shape.
 *
 * Runs the REAL gate against the LIVE memory.db, the REAL connected-account
 * list, and REAL OUTLOOK_GET_PROFILE lookups — exactly what
 * runComposioExecute now does before any send dispatches. No send occurs.
 *
 * Expected with the user's topology (multiple Outlook accounts connected,
 * only Scorpion allowed to send): the gate ROUTES the send to the verified
 * Scorpion connection instead of letting `user_id:'me'` pick a default.
 *
 * Run: npx tsx scripts/replay-wrong-mailbox-send.ts
 */
import { findEmailSendConstraint } from '../src/runtime/harness/constraint-guard.js';
import { resolveCompliantSenderConnection } from '../src/runtime/harness/sender-verify.js';
import { executeComposioTool, listConnectedToolkits } from '../src/integrations/composio/client.js';

const INCIDENT_ARGS = {
  user_id: 'me',
  to_email: 'jeff@gnlaw.nyc',
  to_name: 'Jeffery L. Greco',
  subject: 'Albany PI search visibility',
  body: '(replay — never dispatched)',
  is_html: false,
  save_to_sent_items: true,
};

const rule = findEmailSendConstraint('OUTLOOK_OUTLOOK_SEND_EMAIL', INCIDENT_ARGS);
if (!rule) {
  console.error('✗ NO constraint matched — the gate would NOT protect this send');
  process.exit(1);
}
console.log(`✓ constraint #${rule.constraint.id} applies — required sender: ${rule.allowedAccount}`);

const connections = (await listConnectedToolkits())
  .filter((c) => c.slug.toLowerCase() === 'outlook')
  .map((c) => ({ connectionId: c.connectionId, accountEmail: c.accountEmail, status: c.status }));
console.log(`✓ outlook connections found: ${connections.length}`);

const resolution = await resolveCompliantSenderConnection({
  rule,
  toolSlug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
  userId: 'me',
  connections,
  fetchProfile: (slug, args, connectionId) => executeComposioTool(slug, args, connectionId),
});

if (resolution.ok && resolution.routeConnectionId) {
  console.log(`✓ VERDICT: send PROCEEDS, ROUTED to connection ${resolution.routeConnectionId} — its mailbox verified as ${rule.allowedAccount}.`);
} else if (resolution.ok) {
  console.log('✓ VERDICT: send proceeds on the caller-chosen connection (verified compliant).');
} else {
  console.log('🛑 VERDICT: send would be BLOCKED. Model-facing message:');
  console.log('---');
  console.log(resolution.message);
  console.log('---');
}
