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
  deleteToolChoice,
  forgetMatching,
  listToolChoices,
  renderToolChoicesForContext,
  slugifyIntent,
  stripBakedConnectionId,
  updateToolChoiceOutcome,
  updateToolChoiceOutcomeForIdentifier,
  computeChoiceScore,
  peekToolChoice,
  matchToolChoicesForStep,
  evidenceLooksFailedOrBlocked,
} = await import('./tool-choice-store.js');

test('recallToolChoice returns null when there is no record', () => {
  assert.equal(recallToolChoice('something.that.was.never.remembered'), null);
});

test('stripBakedConnectionId: a saved choice never pins a (rot-prone) composio connection id', () => {
  // The exact shape from the Airtable incident.
  const dirty = 'composio_execute_tool(tool_slug="AIRTABLE_LIST_RECORDS", connected_account_id="ca_RIVsBNuVxfyI", arguments="{...}")';
  const clean = stripBakedConnectionId(dirty);
  assert.doesNotMatch(clean ?? '', /connected_account_id/);
  assert.doesNotMatch(clean ?? '', /ca_RIVsBNuVxfyI/);
  assert.match(clean ?? '', /tool_slug="AIRTABLE_LIST_RECORDS"/);
  assert.match(clean ?? '', /arguments=/);
  assert.doesNotMatch(clean ?? '', /,\s*\)|\(\s*,/); // no dangling comma artifacts
  // Trailing-position + single-quote variant.
  assert.doesNotMatch(stripBakedConnectionId("foo(tool_slug='X', connected_account_id='ca_z')") ?? '', /connected_account_id/);
  // No-op when absent / undefined.
  assert.equal(stripBakedConnectionId('composio_execute_tool(tool_slug="X", arguments="{}")'), 'composio_execute_tool(tool_slug="X", arguments="{}")');
  assert.equal(stripBakedConnectionId(undefined), undefined);
});

test('rememberToolChoice strips a pinned connection id before persisting', () => {
  rememberToolChoice({
    intent: 'airtable.records.list',
    description: 'list',
    choice: { kind: 'composio', identifier: 'AIRTABLE_LIST_RECORDS', invocationTemplate: 'composio_execute_tool(tool_slug="AIRTABLE_LIST_RECORDS", connected_account_id="ca_STALE123", arguments="{}")' },
  });
  const rec = recallToolChoice('airtable.records.list');
  assert.ok(rec?.choice?.invocationTemplate);
  assert.doesNotMatch(rec.choice.invocationTemplate ?? '', /connected_account_id|ca_STALE123/);
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

test('renderToolChoicesForContext is on by default and can be disabled', () => {
  const previous = process.env.TOOL_CHOICE_CONTEXT_INJECT;
  try {
    delete process.env.TOOL_CHOICE_CONTEXT_INJECT;
    rememberToolChoice({
      intent: 'default.render.enabled',
      choice: { kind: 'cli', identifier: 'default-tool', testedAt: '2099-03-01T00:00:00.000Z' },
    });
    assert.match(renderToolChoicesForContext(1), /default\.render\.enabled/);

    process.env.TOOL_CHOICE_CONTEXT_INJECT = 'off';
    assert.equal(renderToolChoicesForContext(1), '');
  } finally {
    if (previous === undefined) delete process.env.TOOL_CHOICE_CONTEXT_INJECT;
    else process.env.TOOL_CHOICE_CONTEXT_INJECT = previous;
  }
});

test('renderToolChoicesForContext respects per-line and block budgets', () => {
  const previous = process.env.TOOL_CHOICE_CONTEXT_INJECT;
  process.env.TOOL_CHOICE_CONTEXT_INJECT = 'on';
  try {
    const longTemplate = `sf data query --json --query "${'SELECT Id, Name, OwnerId FROM Account WHERE '.repeat(8)}"`;
    for (const n of [1, 2, 3]) {
      rememberToolChoice({
        intent: `budget.render.${n}`,
        choice: {
          kind: 'cli',
          identifier: `sf-${n}`,
          invocationTemplate: longTemplate,
          testedAt: `2099-04-0${n}T00:00:00.000Z`,
        },
      });
    }

    const rendered = renderToolChoicesForContext(3, 420);
    assert.ok(rendered.length <= 420, `rendered block exceeded budget: ${rendered.length}`);
    const lines = rendered.split('\n').slice(1);
    assert.ok(lines.length > 0, 'expected at least one remembered choice');
    assert.ok(lines.length < 3, 'block budget should stop before all records fit');
    assert.ok(lines.every((line) => line.length <= 160), 'every rendered choice line should fit the line budget');
    assert.match(lines[0], /…$/, 'long invocation templates should be clipped, not omitted');
  } finally {
    if (previous === undefined) delete process.env.TOOL_CHOICE_CONTEXT_INJECT;
    else process.env.TOOL_CHOICE_CONTEXT_INJECT = previous;
  }
});

test('renderToolChoicesForContext returns empty when no choice fits the budget', () => {
  const previous = process.env.TOOL_CHOICE_CONTEXT_INJECT;
  process.env.TOOL_CHOICE_CONTEXT_INJECT = 'on';
  try {
    rememberToolChoice({
      intent: 'budget.render.too-small',
      choice: { kind: 'cli', identifier: 'tiny', testedAt: '2099-02-01T00:00:00.000Z' },
    });
    assert.equal(renderToolChoicesForContext(1, 10), '');
  } finally {
    if (previous === undefined) delete process.env.TOOL_CHOICE_CONTEXT_INJECT;
    else process.env.TOOL_CHOICE_CONTEXT_INJECT = previous;
  }
});

// Cleanup
process.on('beforeExit', () => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── G1: baked Composio connection ids are stripped on READ (not just write) ──

test('G1: a legacy tool-choice file with a baked connected_account_id is sanitized on read + in context', async () => {
  const { mkdirSync: mkd, writeFileSync: wf } = await import('node:fs');
  const dir = path.join(TMP_HOME, 'memory', 'tool-choices', 'machine-A');
  mkd(dir, { recursive: true });
  // Raw file written by hand (bypasses rememberToolChoice's write-time strip),
  // simulating the 50 legacy files on the owner's disk.
  wf(path.join(dir, 'googlesheets.values.update.md'),
    [
      '---',
      'intent: googlesheets.values.update',
      'description: Update a Google Sheet range',
      'choice:',
      '  kind: composio',
      '  identifier: GOOGLESHEETS_VALUES_UPDATE',
      '  invocationTemplate: composio_execute_tool(tool_slug="GOOGLESHEETS_VALUES_UPDATE", connected_account_id="ca_GJ_hJWV2Hw7P", arguments="{}")',
      '  testedAt: 2026-05-25T00:00:00Z',
      '---',
      'notes',
    ].join('\n'), 'utf-8');

  const rec = recallToolChoice('googlesheets.values.update');
  assert.ok(rec?.choice, 'choice recalled');
  assert.doesNotMatch(rec!.choice!.invocationTemplate ?? '', /connected_account_id|ca_GJ_hJWV2Hw7P/, 'read path strips the baked id');

  const ctx = renderToolChoicesForContext();
  assert.doesNotMatch(ctx, /connected_account_id|ca_GJ_hJWV2Hw7P/, 'context injection never exposes a baked id to the model');
});

// ─── v0.5.64: hard-delete + cluster forget (self-heal affordance) ──────────
test('deleteToolChoice HARD-removes the record (not recallable, not fuzzy-matchable)', () => {
  rememberToolChoice({ intent: 'outlook send new email message', choice: { kind: 'composio', identifier: 'OUTLOOK_CREATE_DRAFT' } });
  assert.ok(recallToolChoice('outlook send new email message')?.choice, 'precondition: recorded');
  assert.equal(deleteToolChoice('outlook send new email message'), true, 'reports deletion');
  // Unlike invalidate (choice=null, file kept), a delete removes the record
  // entirely — even fuzzy recall must miss it.
  assert.equal(recallToolChoice('outlook send new email message'), null, 'exact recall misses after delete');
  assert.equal(recallToolChoice('outlook send a new email'), null, 'fuzzy recall misses after delete (file gone)');
});

test('deleteToolChoice on a missing intent returns false (no throw)', () => {
  assert.equal(deleteToolChoice('never.recorded.intent'), false);
});

test('forgetMatching clears a whole poisoned cluster and leaves unrelated choices', () => {
  rememberToolChoice({ intent: 'outlook send email', choice: { kind: 'composio', identifier: 'AIRTABLE_LIST_RECORDS' } });
  rememberToolChoice({ intent: 'outlook send message draft', choice: { kind: 'composio', identifier: 'OUTLOOK_LIST_MESSAGES' } });
  rememberToolChoice({ intent: 'salesforce.accounts.count', choice: { kind: 'cli', identifier: 'sf' } });
  const forgotten = forgetMatching('outlook send');
  assert.equal(forgotten.length, 2, 'both outlook-send choices forgotten');
  assert.equal(recallToolChoice('outlook send email'), null);
  assert.equal(recallToolChoice('outlook send message draft'), null);
  assert.ok(recallToolChoice('salesforce.accounts.count')?.choice, 'unrelated choice survives the cluster forget');
});

// ─── P1-E: intent-relevant ranking of remembered tool-choices ────────────────

test('P1-E: renderToolChoicesForContext promotes the objective-relevant choice (★) over a newer irrelevant one', () => {
  // Isolate from choices accumulated by earlier tests so ordering is deterministic.
  for (const r of listToolChoices()) deleteToolChoice(r.intent);

  rememberToolChoice({
    intent: 'salesforce.accounts.query_nate_owned_non_market_leader',
    description: 'Query Nate-owned Salesforce accounts not on the Market Leader list.',
    choice: { kind: 'cli', identifier: 'sf', invocationTemplate: 'sf data query --json --query "{{q}}"', testedAt: '2026-01-01T00:00:00.000Z' },
  });
  rememberToolChoice({
    intent: 'airtable.create.base',
    description: 'Create a new Airtable base.',
    choice: { kind: 'composio', identifier: 'AIRTABLE_CREATE_BASE', testedAt: '2026-06-01T00:00:00.000Z' },
  });

  const objective = 'salesforce email reply audit query pre-discovery last 90 days';
  const ranked = renderToolChoicesForContext(12, undefined, objective);
  assert.ok(ranked.includes('★ salesforce.accounts.query_nate_owned_non_market_leader'), 'the relevant Salesforce choice is starred');
  assert.ok(!ranked.includes('★ airtable.create.base'), 'the unrelated Airtable choice is NOT starred');
  assert.ok(
    ranked.indexOf('salesforce.accounts.query_nate_owned_non_market_leader') < ranked.indexOf('airtable.create.base'),
    'the relevant (older) choice is promoted above the newer irrelevant one',
  );

  // No objective → pure recency, byte-identical behavior: no stars, newer first.
  const recencyOnly = renderToolChoicesForContext(12);
  assert.ok(!recencyOnly.includes('★'), 'no objective → nothing is starred');
  assert.ok(
    recencyOnly.indexOf('airtable.create.base') < recencyOnly.indexOf('salesforce.accounts.query_nate_owned_non_market_leader'),
    'no objective → the newer Airtable choice sorts above the older Salesforce one',
  );
});

// ─────────────────────────────────────────────────────────────────
// Thread 2 — outcome-driven procedural memory.
// ─────────────────────────────────────────────────────────────────

test('computeChoiceScore is a smoothed success rate (prior 0.5)', () => {
  assert.equal(computeChoiceScore(null), 0.5);
  assert.equal(computeChoiceScore({ kind: 'mcp', identifier: 'x', testedAt: 'now' }), 0.5, 'no outcomes → neutral prior');
  assert.ok(Math.abs(computeChoiceScore({ kind: 'mcp', identifier: 'x', testedAt: 'now', successCount: 1 }) - 2 / 3) < 1e-9);
  assert.ok(Math.abs(computeChoiceScore({ kind: 'mcp', identifier: 'x', testedAt: 'now', failureCount: 1 }) - 1 / 3) < 1e-9);
});

test('procedural outcomes is DEFAULT-ON (unset env) — records + shifts score', () => {
  delete process.env.CLEMMY_PROCEDURAL_OUTCOMES; // unset → default on
  try {
    rememberToolChoice({ intent: 't2 default on', choice: { kind: 'mcp', identifier: 'tool_default' } });
    const r = updateToolChoiceOutcome('t2 default on', 'success');
    assert.ok(r, 'records by default (no flag set)');
    assert.equal(peekToolChoice('t2 default on')?.choice?.successCount, 1);
  } finally {
    delete process.env.CLEMMY_PROCEDURAL_OUTCOMES;
  }
});

test('updateToolChoiceOutcome is a no-op when the kill-switch is off', () => {
  process.env.CLEMMY_PROCEDURAL_OUTCOMES = 'off';
  try {
    rememberToolChoice({ intent: 't2 flag off', choice: { kind: 'mcp', identifier: 'tool_a' } });
    const r = updateToolChoiceOutcome('t2 flag off', 'success');
    assert.equal(r, null, 'no-op returns null when kill-switch off');
    const after = peekToolChoice('t2 flag off');
    assert.equal(after?.choice?.successCount ?? 0, 0, 'no counter written when off');
  } finally {
    delete process.env.CLEMMY_PROCEDURAL_OUTCOMES;
  }
});

test('updateToolChoiceOutcome records success/failure and shifts the score', () => {
  process.env.CLEMMY_PROCEDURAL_OUTCOMES = 'on';
  try {
    rememberToolChoice({ intent: 't2 record', choice: { kind: 'mcp', identifier: 'tool_b' } });
    updateToolChoiceOutcome('t2 record', 'success');
    let rec = peekToolChoice('t2 record');
    assert.equal(rec?.choice?.successCount, 1);
    assert.ok(rec?.choice?.lastSuccessAt, 'lastSuccessAt set');
    assert.ok(computeChoiceScore(rec?.choice) > 0.5, 'score above prior after a win');

    updateToolChoiceOutcome('t2 record', 'failure');
    rec = peekToolChoice('t2 record');
    assert.equal(rec?.choice?.failureCount, 1);
    assert.ok(Math.abs(computeChoiceScore(rec?.choice) - 0.5) < 1e-9, '1 win + 1 loss → back to 0.5');
  } finally {
    delete process.env.CLEMMY_PROCEDURAL_OUTCOMES;
  }
});

test('counts carry forward on re-remember of the same identifier, reset on a different one', () => {
  process.env.CLEMMY_PROCEDURAL_OUTCOMES = 'on';
  try {
    rememberToolChoice({ intent: 't2 carry', choice: { kind: 'mcp', identifier: 'same_tool' } });
    updateToolChoiceOutcome('t2 carry', 'success');
    updateToolChoiceOutcome('t2 carry', 'success');
    // Re-remember the SAME tool (a re-validation) — history must survive.
    rememberToolChoice({ intent: 't2 carry', choice: { kind: 'mcp', identifier: 'same_tool' } });
    assert.equal(peekToolChoice('t2 carry')?.choice?.successCount, 2, 'same identifier keeps its record');
    // Swap to a DIFFERENT tool — the new path earns a fresh record.
    rememberToolChoice({ intent: 't2 carry', choice: { kind: 'mcp', identifier: 'other_tool' } });
    assert.equal(peekToolChoice('t2 carry')?.choice?.successCount ?? 0, 0, 'identifier change resets counts');
  } finally {
    delete process.env.CLEMMY_PROCEDURAL_OUTCOMES;
  }
});

test('updateToolChoiceOutcomeForIdentifier credits every active choice on that slug', () => {
  process.env.CLEMMY_PROCEDURAL_OUTCOMES = 'on';
  try {
    rememberToolChoice({ intent: 't2 slug one', choice: { kind: 'composio', identifier: 'SALESFORCE_QUERY' } });
    rememberToolChoice({ intent: 't2 slug two', choice: { kind: 'composio', identifier: 'SALESFORCE_QUERY' } });
    const n = updateToolChoiceOutcomeForIdentifier('SALESFORCE_QUERY', 'success');
    assert.equal(n, 2, 'both intents pointing at the slug are credited');
    assert.equal(peekToolChoice('t2 slug one')?.choice?.successCount, 1);
    assert.equal(peekToolChoice('t2 slug two')?.choice?.successCount, 1);
  } finally {
    delete process.env.CLEMMY_PROCEDURAL_OUTCOMES;
  }
});

test('three failures with no win auto-invalidates the choice (→ rediscovery)', () => {
  process.env.CLEMMY_PROCEDURAL_OUTCOMES = 'on';
  try {
    rememberToolChoice({ intent: 't2 streak', choice: { kind: 'composio', identifier: 'FLAKY_TOOL' } });
    updateToolChoiceOutcome('t2 streak', 'failure');
    updateToolChoiceOutcome('t2 streak', 'failure');
    assert.ok(peekToolChoice('t2 streak')?.choice, 'still active after 2 failures');
    updateToolChoiceOutcome('t2 streak', 'failure');
    const rec = peekToolChoice('t2 streak');
    assert.equal(rec?.choice, null, 'auto-invalidated after the 3rd failure');
    assert.ok(rec?.fallbacks.some((f) => f.identifier === 'FLAKY_TOOL'), 'failed path recorded in fallbacks');
  } finally {
    delete process.env.CLEMMY_PROCEDURAL_OUTCOMES;
  }
});

test('P3 render: with the kill-switch off the block is unchanged (no track annotation)', () => {
  // Fresh machine so listToolChoices only sees this test's choices.
  writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-p3-off\n');
  resetMachineIdCacheForTests();
  process.env.CLEMMY_PROCEDURAL_OUTCOMES = 'off';
  try {
    rememberToolChoice({ intent: 'p3 off intent', choice: { kind: 'mcp', identifier: 'render_tool' } });
    process.env.CLEMMY_PROCEDURAL_OUTCOMES = 'on';
    updateToolChoiceOutcome('p3 off intent', 'success');
    process.env.CLEMMY_PROCEDURAL_OUTCOMES = 'off';
    const block = renderToolChoicesForContext();
    assert.match(block, /p3 off intent/);
    assert.doesNotMatch(block, /✓/, 'no track annotation when off');
  } finally {
    delete process.env.CLEMMY_PROCEDURAL_OUTCOMES;
    writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');
    resetMachineIdCacheForTests();
  }
});

test('P3 render: with outcomes on, net-negative choices are dropped and strong ones annotated', () => {
  writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-p3-on\n');
  resetMachineIdCacheForTests();
  process.env.CLEMMY_PROCEDURAL_OUTCOMES = 'on';
  try {
    rememberToolChoice({ intent: 'p3 strong', choice: { kind: 'mcp', identifier: 'good_tool' } });
    updateToolChoiceOutcome('p3 strong', 'success');
    updateToolChoiceOutcome('p3 strong', 'success');

    rememberToolChoice({ intent: 'p3 weak', choice: { kind: 'mcp', identifier: 'bad_tool' } });
    updateToolChoiceOutcome('p3 weak', 'failure'); // 2 failures, 0 wins → score 0.25 < floor,
    updateToolChoiceOutcome('p3 weak', 'failure'); // but <3 so not auto-invalidated

    const block = renderToolChoicesForContext();
    assert.match(block, /p3 strong/, 'proven choice advertised');
    assert.match(block, /✓2/, 'track record annotated');
    assert.doesNotMatch(block, /p3 weak/, 'net-negative choice dropped from injection');
  } finally {
    delete process.env.CLEMMY_PROCEDURAL_OUTCOMES;
    writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');
    resetMachineIdCacheForTests();
  }
});

// ─── matchToolChoicesForStep precision: identity = command HEAD, not args ──
// Regression for the live "scorpion-facebook-trends" bug: a Facebook-scrape
// step got told to use a Salesforce SOQL choice because `LAST_N_DAYS:15` in the
// SOQL collided with "the last 14 days" in the prompt. Core identity must be the
// command head (sf data query), not argument values.

const sfSoqlChoice = {
  intent: 'pull market leader accounts needing follow-up',
  description: 'Query Salesforce for market-leader accounts via the sf CLI',
  choice: {
    kind: 'cli' as const,
    identifier: `sf data query --query "SELECT Id, Name, Website, LastActivityDate, Owner.Name FROM Account WHERE Owner.Name = 'Nathan Reynolds' AND Market_Leader__c = TRUE AND (LastActivityDate = NULL OR LastActivityDate < LAST_N_DAYS:15) ORDER BY LastActivityDate ASC NULLS FIRST LIMIT 50"`,
    testedAt: '2026-01-01',
  },
  fallbacks: [], body: '', filePath: '/x',
} as never;

test('matchToolChoicesForStep: a Facebook-scrape step does NOT match a Salesforce SOQL choice (argument-value collision)', () => {
  const fbPrompt = 'Scrape Scorpion\'s public Facebook page: pull recent public posts from the last 14 days and summarize posting trends.';
  assert.equal(matchToolChoicesForStep(fbPrompt, { choices: [sfSoqlChoice] }).length, 0);
});

test('matchToolChoicesForStep: a genuine Salesforce step STILL matches the SOQL choice (no regression)', () => {
  const sfPrompt = 'Query Salesforce for my market-leader accounts that need follow-up and list their names and websites.';
  assert.ok(matchToolChoicesForStep(sfPrompt, { choices: [sfSoqlChoice] }).length >= 1);
});

// ─── Write-back guard: a gate-blocked / failed attempt must never become a proven choice ───

test('evidenceLooksFailedOrBlocked: recognizes gate refusals + manual-fallback + failure phrasing', () => {
  assert.equal(evidenceLooksFailedOrBlocked('netlify deploy refused by harness UNVERIFIED_DESTINATION gate; must run manually'), true);
  assert.equal(evidenceLooksFailedOrBlocked('Blocked by the destination gate on every path; deploy it manually'), true);
  assert.equal(evidenceLooksFailedOrBlocked('could not deploy — token not readable for raw API upload'), true);
  assert.equal(evidenceLooksFailedOrBlocked('the write was refused by the grounding gate'), true);
  // …but a genuinely-working memo (even one that MENTIONS handling failures) is NOT dropped.
  assert.equal(evidenceLooksFailedOrBlocked('netlify deploy returned production url https://x.netlify.app for site id 449cd146'), false);
  assert.equal(evidenceLooksFailedOrBlocked('npx netlify-cli deploy succeeded; retries on a transient 5xx'), false);
  assert.equal(evidenceLooksFailedOrBlocked(undefined), false);
  // …and a SUCCESS that merely mentions a manual ALTERNATIVE is not a failure
  // (the review false-positive: "manually" without a necessity/failure cue).
  assert.equal(evidenceLooksFailedOrBlocked('deploy works via CLI; you can also deploy it manually from the UI if needed'), false);
  assert.equal(evidenceLooksFailedOrBlocked('X works, but you can also deploy it manually'), false);
  // …while a genuine manual PUNT (necessity cue near "manual") is still caught.
  assert.equal(evidenceLooksFailedOrBlocked('the CLI was blocked so I had to deploy it manually'), true);
  assert.equal(evidenceLooksFailedOrBlocked('could not authenticate; must run it manually'), true);
});

test('rememberToolChoice: a BLOCKED attempt is NOT persisted as the active choice (poisoned-memo guard)', () => {
  const intent = 'netlify.deploy.guard.fresh';
  // The exact 2026-06-21 poisoning shape: the model tries to remember a deploy
  // that the destination gate hard-blocked.
  rememberToolChoice({
    intent,
    description: 'Deploy clementine-onepager — blocked by UNVERIFIED_DESTINATION gate; must run manually.',
    choice: { kind: 'cli', identifier: 'netlify', invocationTemplate: 'netlify deploy --prod --dir . --site clementine-onepager.netlify.app', testEvidence: 'refused by harness UNVERIFIED_DESTINATION gate' },
  });
  const rec = peekToolChoice(intent);
  assert.ok(rec, 'a record exists (the failed attempt is kept as history)');
  assert.equal(rec!.choice, null, 'the failed attempt must NOT be the active proven choice');
  assert.ok(rec!.fallbacks.some((f) => f.identifier === 'netlify'), 'the failed attempt is recorded as a fallback');
  // …so recall does not serve a poisoned "must run manually" path (no active choice).
  assert.equal(recallToolChoice(intent)?.choice ?? null, null);
});

test('rememberToolChoice: a blocked re-remember NEVER overwrites an existing PROVEN choice', () => {
  const intent = 'netlify.deploy.guard.proven';
  rememberToolChoice({
    intent,
    choice: { kind: 'cli', identifier: 'npx', invocationTemplate: 'npx netlify-cli deploy --dir "{{dir}}" --prod --site {{site_id}}', testEvidence: 'returned production url https://x.netlify.app' },
  });
  // A later gate-blocked attempt must leave the proven choice intact.
  rememberToolChoice({
    intent,
    choice: { kind: 'cli', identifier: 'netlify', invocationTemplate: 'netlify deploy --prod --site x.netlify.app', testEvidence: 'blocked by the gate; run it manually' },
  });
  const rec = peekToolChoice(intent);
  assert.equal(rec!.choice?.identifier, 'npx', 'the proven npx choice survives the blocked re-remember');
});

test('rememberToolChoice: a normal SUCCESSFUL remember still works (no regression)', () => {
  const intent = 'netlify.deploy.guard.ok';
  rememberToolChoice({
    intent,
    choice: { kind: 'cli', identifier: 'npx', invocationTemplate: 'npx netlify-cli deploy --site {{site_id}}', testEvidence: 'deployed; returned production URL' },
  });
  assert.equal(peekToolChoice(intent)!.choice?.identifier, 'npx');
});

test('matchToolChoicesForStep: an embedded command still binds (already-bound short-circuit unaffected)', () => {
  const boundPrompt = 'Run `sf data query --query "SELECT Id FROM Account"` to pull the accounts.';
  assert.ok(matchToolChoicesForStep(boundPrompt, { choices: [sfSoqlChoice] }).length >= 1);
});
