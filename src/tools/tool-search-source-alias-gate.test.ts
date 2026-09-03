/** Run: node scripts/run-tests-isolated.mjs src/tools/tool-search-source-alias-gate.test.ts
 *
 * An unrecognized source-account alias must not gate a toolkit that has no
 * account identity to get wrong.
 *
 * Live 2026-09-03: "draft me all the emails using my outbound email skill"
 * matched `using my <phrase>` terminated by the resource word `email`, so the
 * grammar extracted the labelish "outbound" — a description of a SKILL read as
 * an account name. No alias by that name exists, and the unrecognized-label
 * rule then stamped EVERY toolkit in the turn account_selection_required,
 * including DataForSEO and Airtable, neither of which has a mailbox. The run
 * reached no business call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planningConnectionForOperation } from './tool-search-provider-sources.js';

const SENTENCE = 'I need you to find 5 prospects in Salesforce, scrape their SEO data using '
  + 'DataForSEO, then draft me all the emails using my outbound email skill and add them to '
  + 'Outlook as drafts.';

const keyed = [{
  slug: 'dataforseo', connectionId: 'ca_keyed', status: 'ACTIVE', accountEmail: null,
}] as unknown as Parameters<typeof planningConnectionForOperation>[2];

const mailboxes = [
  { slug: 'outlook', connectionId: 'ca_a', status: 'ACTIVE', accountEmail: 'a@corp.example' },
  { slug: 'outlook', connectionId: 'ca_b', status: 'ACTIVE', accountEmail: 'b@other.example' },
] as unknown as Parameters<typeof planningConnectionForOperation>[2];

test('a keyed toolkit is not gated by an alias that names no account', () => {
  const out = planningConnectionForOperation(
    'DATAFORSEO_GET_DATAFORSEO_LABS_GOOGLE_TOP_SEARCHES_LIVE', SENTENCE, keyed,
  );
  assert.notEqual(out.kind, 'account_selection_required',
    'a toolkit with no account email has no source account to choose');
  assert.equal(out.kind, 'resolved');
});

// The protection this must not weaken: two real mailboxes and an alias naming
// neither is exactly when a wrong pick sends as the wrong identity.
test('a mailbox toolkit with two identities still asks', () => {
  const out = planningConnectionForOperation('OUTLOOK_CREATE_DRAFT', SENTENCE, mailboxes);
  assert.equal(out.kind, 'account_selection_required');
});
