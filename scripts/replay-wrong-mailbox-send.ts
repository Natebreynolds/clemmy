/**
 * Live replay of the 2026-06-11 wrong-mailbox incident send shape.
 *
 * Runs the REAL gate against the LIVE memory.db and a REAL composio
 * OUTLOOK_GET_PROFILE call — exactly what runComposioExecute now does before
 * any send dispatches. Proves the gate's verdict for:
 *   OUTLOOK_OUTLOOK_SEND_EMAIL { user_id: 'me', ... }   (no send occurs)
 *
 * Run: npx tsx scripts/replay-wrong-mailbox-send.ts
 */
import { findEmailSendConstraint } from '../src/runtime/harness/constraint-guard.js';
import { verifyOutlookSender } from '../src/runtime/harness/sender-verify.js';
import { executeComposioTool } from '../src/integrations/composio/client.js';

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

const verdict = await verifyOutlookSender({
  rule,
  toolSlug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
  userId: 'me',
  fetchProfile: (slug, args) => executeComposioTool(slug, args, undefined),
});

if (verdict.ok) {
  console.log('✓ VERDICT: send would PROCEED — the connected Outlook mailbox verified as the required Scorpion account.');
} else {
  console.log('🛑 VERDICT: send would be BLOCKED. Model-facing message:');
  console.log('---');
  console.log(verdict.message);
  console.log('---');
}
