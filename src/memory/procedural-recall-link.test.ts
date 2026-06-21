/**
 * Run: npx tsx --test src/memory/procedural-recall-link.test.ts
 *
 * The 2026-06-21 keystone: per-recalled-intent outcome correlation that closes
 * the MEASURED 0% CLI/MCP outcome-coverage gap. A CLI/MCP recall, then a matching
 * tool result, must credit THAT specific intent (per-operation, not per-binary)
 * — and composio recalls must NOT be double-credited here.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-recall-link-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_PROCEDURAL_OUTCOMES = 'on';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resetMachineIdCacheForTests } = await import('../runtime/machine-id.js');
resetMachineIdCacheForTests?.();
const { rememberToolChoice, peekToolChoice } = await import('./tool-choice-store.js');
const {
  noteRecalledIntent,
  creditMatchingRecall,
  _resetProceduralRecallLinkForTests,
} = await import('./procedural-recall-link.js');

const SID = 'sess-test';
function freshCliMemo(intent: string, identifier: string): void {
  rememberToolChoice({ intent, choice: { kind: 'cli', identifier, invocationTemplate: `${identifier} ...`, testEvidence: 'worked' } });
}

test.beforeEach(() => _resetProceduralRecallLinkForTests());

test('a CLI recall + matching shell result credits THAT intent success (closes the 0% gap)', () => {
  freshCliMemo('netlify.deploy.local_site', 'netlify');
  noteRecalledIntent(SID, 'netlify.deploy.local_site', 'netlify', 'cli');
  const credited = creditMatchingRecall(SID, 'cd site && netlify deploy --prod --site x', true);
  assert.equal(credited, 'netlify.deploy.local_site');
  assert.equal(peekToolChoice('netlify.deploy.local_site')!.choice!.successCount, 1, 'CLI memo now has an observed success (was permanently 0)');
});

test('a failure on the recalled operation is credited as failure', () => {
  freshCliMemo('sf.query.accounts', 'sf');
  noteRecalledIntent(SID, 'sf.query.accounts', 'sf', 'cli');
  creditMatchingRecall(SID, 'sf data query --query "SELECT Id FROM Account"', false);
  assert.equal(peekToolChoice('sf.query.accounts')!.choice!.failureCount, 1);
});

test('recall is CONSUMED on first match — a later unrelated call cannot re-credit it', () => {
  freshCliMemo('netlify.deploy.consume', 'netlify');
  noteRecalledIntent(SID, 'netlify.deploy.consume', 'netlify', 'cli');
  assert.equal(creditMatchingRecall(SID, 'netlify deploy --site x', true), 'netlify.deploy.consume');
  // a second netlify call (e.g. status) finds no buffered recall → no extra credit
  assert.equal(creditMatchingRecall(SID, 'netlify status', true), null);
  assert.equal(peekToolChoice('netlify.deploy.consume')!.choice!.successCount, 1, 'credited exactly once');
});

test('composio recalls are NOT correlated here (their slug path credits them — no double-count)', () => {
  noteRecalledIntent(SID, 'salesforce.query', 'SALESFORCE_QUERY', 'composio');
  assert.equal(creditMatchingRecall(SID, 'SALESFORCE_QUERY', true), null);
});

test('an MCP tool result credits its recalled identifier (tool-name match)', () => {
  rememberToolChoice({ intent: 'seo.rank_overview', choice: { kind: 'mcp', identifier: 'dataforseo__rank_overview', testEvidence: 'worked' } });
  noteRecalledIntent(SID, 'seo.rank_overview', 'dataforseo__rank_overview', 'mcp');
  assert.equal(creditMatchingRecall(SID, 'dataforseo__rank_overview', true), 'seo.rank_overview');
  assert.equal(peekToolChoice('seo.rank_overview')!.choice!.successCount, 1);
});

test('no matching recall → no credit (a tool result with no prior recall is ignored)', () => {
  assert.equal(creditMatchingRecall(SID, 'gh pr create', true), null);
});

test('a recall older than the TTL is not credited (no stale mis-credit)', () => {
  freshCliMemo('netlify.deploy.ttl', 'netlify');
  const t0 = 1_000_000;
  noteRecalledIntent(SID, 'netlify.deploy.ttl', 'netlify', 'cli', t0);
  // ~6 minutes later
  const credited = creditMatchingRecall(SID, 'netlify deploy --site x', true, t0 + 6 * 60 * 1000);
  assert.equal(credited, null);
});
