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
const { rememberToolChoice, peekToolChoice, listToolChoices, deleteToolChoice } = await import('./tool-choice-store.js');
const {
  noteRecalledIntent,
  creditMatchingRecall,
  _resetProceduralRecallLinkForTests,
} = await import('./procedural-recall-link.js');

const SID = 'sess-test';
function freshCliMemo(intent: string, identifier: string): void {
  rememberToolChoice({ intent, choice: { kind: 'cli', identifier, invocationTemplate: `${identifier} ...`, testEvidence: 'worked' } });
}

// Isolate BOTH the in-memory recall buffer AND the on-disk store before each
// test — the store now participates in crediting (the store fallback), so a memo
// left over from an earlier test could otherwise legitimately credit and make
// assertions order-dependent.
test.beforeEach(() => {
  _resetProceduralRecallLinkForTests();
  for (const r of listToolChoices()) deleteToolChoice(r.intent);
});

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

test('a recall older than the TTL is not credited (no stale buffer mis-credit)', () => {
  // No store memo here on purpose — this isolates the BUFFER's TTL guard from the
  // store fallback (which would legitimately credit a matching stored memo).
  const t0 = 1_000_000;
  noteRecalledIntent(SID, 'netlify.deploy.ttl', 'netlify', 'cli', t0);
  // ~6 minutes later the buffered recall is pruned, and with no stored memo to
  // match either, nothing is credited.
  const credited = creditMatchingRecall(SID, 'netlify deploy --site x', true, t0 + 6 * 60 * 1000);
  assert.equal(credited, null);
});

// ─── Review fixes: word-boundary matching + same-binary disambiguation ───

test('word-boundary: a 2-char identifier does NOT match inside an unrelated word', () => {
  freshCliMemo('github.pr.create', 'gh');
  noteRecalledIntent(SID, 'github.pr.create', 'gh', 'cli');
  // "gh" appears inside "highlight" but must NOT credit (was a substring false-positive)
  assert.equal(creditMatchingRecall(SID, 'echo debugging highlight', true), null);
  // a real `gh` command DOES credit (whole-token)
  assert.equal(creditMatchingRecall(SID, 'gh pr create', true), 'github.pr.create');
});

test('same binary, two ops: a `netlify status` outcome is NOT credited to the deploy memo', () => {
  freshCliMemo('netlify.deploy.x', 'netlify');
  freshCliMemo('netlify.status.x', 'netlify');
  noteRecalledIntent(SID, 'netlify.status.x', 'netlify', 'cli');
  noteRecalledIntent(SID, 'netlify.deploy.x', 'netlify', 'cli'); // most-recent
  // status command → disambiguated to the STATUS intent by operation overlap, NOT the most-recent deploy
  assert.equal(creditMatchingRecall(SID, 'netlify status', true), 'netlify.status.x');
  assert.equal(peekToolChoice('netlify.deploy.x')!.choice!.successCount ?? 0, 0, 'deploy memo untouched by the status outcome');
});

test('single pending CLI recall still requires the recalled operation, not just its binary', () => {
  rememberToolChoice({
    intent: 'netlify.deploy.single',
    choice: {
      kind: 'cli',
      identifier: 'netlify',
      invocationTemplate: 'netlify deploy --dir {{directory}} --json',
      testEvidence: 'worked',
    },
  });
  noteRecalledIntent(SID, 'netlify.deploy.single', 'netlify', 'cli');
  assert.equal(creditMatchingRecall(SID, 'netlify status', true), null);
  assert.equal(peekToolChoice('netlify.deploy.single')!.choice!.successCount ?? 0, 0);
  assert.equal(
    creditMatchingRecall(SID, 'netlify deploy --dir ./dist --json', true),
    'netlify.deploy.single',
    'the unconsumed recall is credited only when its operation actually runs',
  );
});

test('same binary, genuinely ambiguous (no operation distinction) → credits NOTHING', () => {
  freshCliMemo('netlify.a', 'netlify');
  freshCliMemo('netlify.b', 'netlify');
  noteRecalledIntent(SID, 'netlify.a', 'netlify', 'cli');
  noteRecalledIntent(SID, 'netlify.b', 'netlify', 'cli');
  // bare `netlify` command has no op token to distinguish a from b → skip (no mis-credit)
  assert.equal(creditMatchingRecall(SID, 'netlify', true), null);
});

test('Map does not leak: consuming the last recall deletes the session key', () => {
  _resetProceduralRecallLinkForTests();
  freshCliMemo('sf.q', 'sf');
  noteRecalledIntent(SID, 'sf.q', 'sf', 'cli');
  creditMatchingRecall(SID, 'sf data query --query "x"', true);
  // After consuming the only recall, a credit on a bare binary (no operation to
  // confirm) is a clean no-op — neither the buffer nor the store mis-credits.
  assert.equal(creditMatchingRecall(SID, 'sf', true), null);
});

// ─── STORE FALLBACK: the actual 0%-coverage fix ───
// The dominant path is NOT an explicit tool_choice_recall — proven choices are
// injected into context and used directly, so the recall buffer is empty. The
// store fallback credits the precise, unique memo the executed command
// represents, with NO prior recall noted.

test('store fallback: an injected CLI proven path is credited on use with NO explicit recall', () => {
  rememberToolChoice({
    intent: 'netlify.deploy.local_site',
    choice: { kind: 'cli', identifier: 'netlify', invocationTemplate: 'netlify deploy --prod --site {{site}}', testEvidence: 'worked' },
  });
  // NOTE: no noteRecalledIntent — this is the injected-context path that produced 0% coverage
  const credited = creditMatchingRecall(SID, 'cd site && netlify deploy --prod --site x', true);
  assert.equal(credited, 'netlify.deploy.local_site');
  assert.equal(peekToolChoice('netlify.deploy.local_site')!.choice!.successCount, 1, 'CLI memo now scores from ordinary use, not just explicit recall');
});

test('store fallback: an MCP tool-name match credits with no recall', () => {
  rememberToolChoice({ intent: 'seo.rank_overview', choice: { kind: 'mcp', identifier: 'dataforseo__rank_overview', testEvidence: 'worked' } });
  assert.equal(creditMatchingRecall(SID, 'dataforseo__rank_overview', false), 'seo.rank_overview');
  assert.equal(peekToolChoice('seo.rank_overview')!.choice!.failureCount, 1);
});

test('store fallback: binary-only brush (no operation token) credits NOTHING', () => {
  rememberToolChoice({
    intent: 'netlify.deploy.x',
    choice: { kind: 'cli', identifier: 'netlify', invocationTemplate: 'netlify deploy --site {{site}}', testEvidence: 'worked' },
  });
  // `netlify status` shares the binary but not the deploy operation → must not penalize the deploy memo
  assert.equal(creditMatchingRecall(SID, 'netlify status', false), null);
  assert.equal(peekToolChoice('netlify.deploy.x')!.choice!.failureCount ?? 0, 0, 'deploy memo untouched by an unrelated netlify command');
});

test('store fallback: two same-binary memos the command cannot disambiguate → NOTHING', () => {
  rememberToolChoice({ intent: 'netlify.deploy.x', choice: { kind: 'cli', identifier: 'netlify', invocationTemplate: 'netlify deploy --site {{site}}', testEvidence: 'worked' } });
  rememberToolChoice({ intent: 'netlify.rollback.x', choice: { kind: 'cli', identifier: 'netlify', invocationTemplate: 'netlify rollback --site {{site}}', testEvidence: 'worked' } });
  // bare `netlify` has no operation token to pick deploy vs rollback → ambiguous → skip
  assert.equal(creditMatchingRecall(SID, 'netlify', true), null);
});

test('store fallback: a vague intent slug is rescued by the invocation-template operation token', () => {
  rememberToolChoice({ intent: 'my netlify thing', choice: { kind: 'cli', identifier: 'netlify', invocationTemplate: 'netlify deploy --prod', testEvidence: 'worked' } });
  // intent slug has no operation word, but the invocation template contributes `deploy`
  assert.equal(creditMatchingRecall(SID, 'netlify deploy --prod --site x', true), 'my netlify thing');
});

test('store fallback: an explicit pending recall takes PRIORITY (no double-credit)', () => {
  freshCliMemo('netlify.deploy.a', 'netlify');
  noteRecalledIntent(SID, 'netlify.deploy.a', 'netlify', 'cli');
  assert.equal(creditMatchingRecall(SID, 'netlify deploy --site x', true), 'netlify.deploy.a');
  assert.equal(peekToolChoice('netlify.deploy.a')!.choice!.successCount, 1, 'credited exactly once via the buffer, not also via the store');
});

test('store fallback: composio store memos are never credited here (slug path owns them)', () => {
  rememberToolChoice({ intent: 'salesforce.query', choice: { kind: 'composio', identifier: 'SALESFORCE_QUERY', testEvidence: 'worked' } });
  assert.equal(creditMatchingRecall(SID, 'SALESFORCE_QUERY', true), null);
});

test('store fallback: kill-switch off → no store crediting', () => {
  rememberToolChoice({ intent: 'netlify.deploy.k', choice: { kind: 'cli', identifier: 'netlify', invocationTemplate: 'netlify deploy --prod', testEvidence: 'worked' } });
  process.env.CLEMMY_PROCEDURAL_OUTCOMES = 'off';
  try {
    assert.equal(creditMatchingRecall(SID, 'netlify deploy --prod', true), null);
  } finally {
    process.env.CLEMMY_PROCEDURAL_OUTCOMES = 'on';
  }
});

test('store fallback: filenames mentioning netlify/json never credit a deploy procedure', () => {
  rememberToolChoice({
    intent: 'netlify.deploy.site',
    choice: {
      kind: 'cli',
      identifier: 'netlify',
      invocationTemplate: 'netlify deploy --dir {{directory}} --json',
      testEvidence: 'worked',
    },
  });
  const inspection = "find . -type f \\( -name package.json -o -name netlify.toml \\)";
  assert.equal(creditMatchingRecall(SID, inspection, true), null);
  assert.equal(peekToolChoice('netlify.deploy.site')!.choice!.successCount ?? 0, 0);
  assert.equal(
    creditMatchingRecall(SID, 'netlify deploy --dir ./dist --json', true),
    'netlify.deploy.site',
    'the deterministic executable + operation prefix still earns credit',
  );
});

test('explicit recall still requires the CLI to be causally invoked', () => {
  freshCliMemo('netlify.deploy.explicit', 'netlify');
  noteRecalledIntent(SID, 'netlify.deploy.explicit', 'netlify', 'cli');
  assert.equal(creditMatchingRecall(SID, 'find . -name netlify.toml -o -name package.json', true), null);
  assert.equal(peekToolChoice('netlify.deploy.explicit')!.choice!.successCount ?? 0, 0);
  assert.equal(creditMatchingRecall(SID, 'netlify deploy --site x', true), 'netlify.deploy.explicit');
});
