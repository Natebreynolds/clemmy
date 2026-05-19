/**
 * Run: npx tsx --test src/memory/tool-choice-store.test.ts
 *
 * Contracts the tool-choice store must keep:
 *   - recall returns null when there's no record
 *   - remember + recall round-trips by exact slug
 *   - recall does a fuzzy match when no exact slug hits
 *   - fuzzy recall returns null when the best candidate is too weak
 *   - invalidate moves the active choice into fallbacks and clears it
 *   - fallbacks dedupe by (kind, identifier, reason)
 *   - per-machine isolation: machine A writes, machine B can't recall
 *
 * Phase A of the intent-based tool dispatch plan
 * (/Users/nathan.reynolds/.claude/plans/intent-based-tool-dispatch.md).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-tool-choice-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

// Pin the machine-id for tests that don't care about per-machine
// scoping. Some tests rewrite this file and reset the cache to
// simulate moving between machines.
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resetMachineIdCacheForTests } = await import('../runtime/machine-id.js');
const {
  recallToolChoice,
  rememberToolChoice,
  invalidateToolChoice,
  listToolChoices,
  slugifyIntent,
} = await import('./tool-choice-store.js');

test('recallToolChoice returns null when there is no record', () => {
  assert.equal(recallToolChoice('something.that.was.never.remembered'), null);
});

test('rememberToolChoice + recallToolChoice round-trip by exact slug', () => {
  const intent = 'salesforce.accounts.list_stale';
  rememberToolChoice({
    intent,
    description: 'List Salesforce accounts older than N days.',
    choice: {
      kind: 'cli',
      identifier: 'sf',
      invocationTemplate: 'sf data query --json --query "{{query}}"',
      testEvidence: 'sf --version exit 0',
    },
  });
  const got = recallToolChoice(intent);
  assert.ok(got, 'expected a record to be recalled');
  assert.equal(got!.intent, intent);
  assert.equal(got!.choice?.kind, 'cli');
  assert.equal(got!.choice?.identifier, 'sf');
  assert.equal(got!.choice?.invocationTemplate, 'sf data query --json --query "{{query}}"');
  assert.equal(got!.fallbacks.length, 0);
});

test('rememberToolChoice updates an existing record without losing fallbacks', () => {
  const intent = 'composio.discovery.example';
  rememberToolChoice({
    intent,
    choice: { kind: 'cli', identifier: 'foo' },
    fallbacks: [{ kind: 'composio', identifier: 'FOO_OLD', failedAt: '2026-01-01T00:00:00Z', reason: 'not connected' }],
  });
  rememberToolChoice({
    intent,
    choice: { kind: 'cli', identifier: 'bar' },
    fallbacks: [{ kind: 'composio', identifier: 'FOO_OLD', failedAt: '2026-01-01T00:00:00Z', reason: 'not connected' }],
  });
  const got = recallToolChoice(intent);
  assert.equal(got!.choice?.identifier, 'bar', 'choice should be replaced on update');
  assert.equal(got!.fallbacks.length, 1, 'fallbacks should dedupe on (kind, identifier, reason)');
});

test('recallToolChoice fuzzy-matches when slug is close', () => {
  // Pre-existing slug: salesforce.accounts.list_stale (from earlier test).
  // Query "salesforce accounts list" tokenizes to {salesforce, accounts, list}
  // vs {salesforce, accounts, list_stale} → 2/4 overlap, just under threshold.
  // But "salesforce accounts list stale" → {salesforce, accounts, list, stale}
  // against {salesforce, accounts, list_stale} would be 2/5 — still weak.
  // Need a closer paraphrase to hit the 0.5 threshold:
  const got = recallToolChoice('Salesforce accounts list_stale');
  assert.ok(got, 'a slug with identical tokens (just different case + whitespace) should fuzzy-match');
  assert.equal(got!.choice?.identifier, 'sf');
});

test('recallToolChoice returns null when fuzzy candidate is too weak', () => {
  // Wildly different intent should miss
  assert.equal(recallToolChoice('weather.forecast.tomorrow'), null);
});

test('invalidateToolChoice moves the active choice into fallbacks and clears choice', () => {
  const intent = 'invalidation.test';
  rememberToolChoice({
    intent,
    choice: { kind: 'cli', identifier: 'broken-tool', testEvidence: 'worked at the time' },
  });
  const updated = invalidateToolChoice(intent, 'returned EPERM on every invocation since 2026-05-19');
  assert.ok(updated, 'invalidate should return the updated record');
  assert.equal(updated!.choice, null, 'choice should be cleared after invalidation');
  assert.equal(updated!.fallbacks.length, 1);
  assert.equal(updated!.fallbacks[0].kind, 'cli');
  assert.equal(updated!.fallbacks[0].identifier, 'broken-tool');
  assert.match(updated!.fallbacks[0].reason, /EPERM/);

  const reRecalled = recallToolChoice(intent);
  assert.equal(reRecalled!.choice, null, 'subsequent recall should still see choice=null');
  assert.equal(reRecalled!.fallbacks.length, 1, 'fallback history should persist across reads');
});

test('invalidateToolChoice on a missing record returns null', () => {
  assert.equal(invalidateToolChoice('never.recorded.intent', 'whatever'), null);
});

test('slugifyIntent is conservative — preserves dots and lowercases', () => {
  assert.equal(slugifyIntent('Salesforce.Accounts.List Stale'), 'salesforce.accounts.list-stale');
  assert.equal(slugifyIntent('   weird///chars'), 'weirdchars');
  assert.equal(slugifyIntent(''), '');
});

test('per-machine isolation: machine A writes, machine B does not see it', () => {
  const intent = 'machine.isolation.check';
  rememberToolChoice({
    intent,
    choice: { kind: 'cli', identifier: 'only-on-A' },
  });
  // Recall on the same machine returns the record.
  assert.ok(recallToolChoice(intent), 'machine A should recall its own record');

  // Simulate moving to a different machine.
  writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-B\n');
  resetMachineIdCacheForTests();

  assert.equal(recallToolChoice(intent), null, 'machine B should NOT see machine A\'s record');

  // listToolChoices on machine B should be empty since nothing was written.
  assert.equal(listToolChoices().length, 0);

  // Restore machine A for any subsequent tests in this run.
  writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');
  resetMachineIdCacheForTests();
  assert.ok(recallToolChoice(intent), 'machine A still recalls after switching back');
});

test('listToolChoices returns all records under the current machine', () => {
  // From prior tests on machine A we have at least: salesforce.accounts.list_stale,
  // composio.discovery.example, invalidation.test, machine.isolation.check.
  const all = listToolChoices();
  const intents = new Set(all.map((r) => r.intent));
  assert.ok(intents.has('salesforce.accounts.list_stale'));
  assert.ok(intents.has('composio.discovery.example'));
  assert.ok(intents.has('invalidation.test'));
  assert.ok(intents.has('machine.isolation.check'));
});

// Cleanup
process.on('beforeExit', () => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});
