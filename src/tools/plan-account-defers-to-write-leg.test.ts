/** Run: node scripts/run-tests-isolated.mjs src/tools/plan-account-defers-to-write-leg.test.ts
 *
 * An account question belongs to the leg that needs the account, not to the
 * whole plan.
 *
 * Live 2026-09-03 run 21: a five-step chain (Salesforce read -> SEO enrichment
 * -> drafting -> Outlook writes) was refused at plan-freeze because the FINAL
 * leg had two connected mailboxes. A pure read could not start until the user
 * answered where emails go three steps later — read -> work -> write inverted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { citedLegsUnblockedByAccount } from './tool-search-provider-sources.js';

const OUTLOOK_BLOCKER = [{
  name: 'OUTLOOK_CREATE_DRAFT',
  choices: ['a@corp.example', 'b@other.example'],
}];

test('a read leg is not blocked by an ambiguous write leg later in the plan', () => {
  const open = citedLegsUnblockedByAccount({
    citedRefs: ['cap:resolved:salesforce_sf_soql_query', 'cap:resolved:OUTLOOK_CREATE_DRAFT'],
    blockers: OUTLOOK_BLOCKER,
  });
  assert.deepEqual(open, ['cap:resolved:salesforce_sf_soql_query'],
    'the read has nothing to do with which mailbox the drafts land in');
});

// The substitution guard (2026-08-29): a lone cited write with two mailboxes
// has no other work to get on with, so the caller still refuses and ASKS
// rather than silently picking a different write.
test('a lone ambiguous write leaves nothing unblocked, so the plan still refuses', () => {
  const open = citedLegsUnblockedByAccount({
    citedRefs: ['cap:resolved:OUTLOOK_CREATE_DRAFT'],
    blockers: OUTLOOK_BLOCKER,
  });
  assert.deepEqual(open, [], 'nothing to proceed with — the question is the only move');
});
