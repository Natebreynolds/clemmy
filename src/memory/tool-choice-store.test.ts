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
 * (/Users/example/.claude/plans/intent-based-tool-dispatch.md).
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
  recallComposioForSearch,
  recallComposioAccountIdentity,
  listToolChoiceAliases,
  listToolProcedures,
  migrateToolChoicesToCanonicalProcedures,
  recordToolProcedureImpression,
  beginToolProcedureUseById,
  completeToolProcedureUse,
} = await import('./tool-choice-store.js');

test('accountIdentity: persists a valid email, rejects a ca_ id and non-email; recalls by slug', () => {
  rememberToolChoice({
    intent: 'send weekly update to the team',
    choice: { kind: 'composio', identifier: 'OUTLOOK_SEND_EMAIL', accountIdentity: 'alex@corp.example' },
  });
  // Stored normalized (lowercased).
  assert.equal(recallComposioAccountIdentity('OUTLOOK_SEND_EMAIL'), 'alex@corp.example');
  // A volatile ca_ id is rejected at write → not learned as an identity.
  rememberToolChoice({
    intent: 'list my drive files',
    choice: { kind: 'composio', identifier: 'GOOGLEDRIVE_LIST', accountIdentity: 'ca_fixture_drive_connection' as unknown as string },
  });
  assert.equal(recallComposioAccountIdentity('GOOGLEDRIVE_LIST'), undefined);
  // A non-email is rejected too.
  rememberToolChoice({
    intent: 'search airtable',
    choice: { kind: 'composio', identifier: 'AIRTABLE_SEARCH', accountIdentity: 'not-an-email' as unknown as string },
  });
  assert.equal(recallComposioAccountIdentity('AIRTABLE_SEARCH'), undefined);
});

test('accountIdentity: re-validating the same slug carries the learned mailbox forward; a new valid email overrides', () => {
  rememberToolChoice({
    intent: 'draft reply to a client',
    choice: { kind: 'composio', identifier: 'OUTLOOK_CREATE_DRAFT', accountIdentity: 'first@site.example' },
  });
  // Re-remember same slug WITHOUT an identity → keeps the learned one.
  rememberToolChoice({
    intent: 'draft reply to a client',
    choice: { kind: 'composio', identifier: 'OUTLOOK_CREATE_DRAFT', invocationTemplate: '{"a":1}' },
  });
  assert.equal(recallComposioAccountIdentity('OUTLOOK_CREATE_DRAFT'), 'first@site.example');
  // A new valid email wins.
  rememberToolChoice({
    intent: 'draft reply to a client',
    choice: { kind: 'composio', identifier: 'OUTLOOK_CREATE_DRAFT', accountIdentity: 'second@personal.example' },
  });
  assert.equal(recallComposioAccountIdentity('OUTLOOK_CREATE_DRAFT'), 'second@personal.example');
});

test('recallComposioAccountIdentity: disagreeing mailboxes across intents for one slug → undefined (must ASK)', () => {
  rememberToolChoice({ intent: 'send invoice reminders', choice: { kind: 'composio', identifier: 'GMAIL_SEND', accountIdentity: 'billing@company.example' } });
  rememberToolChoice({ intent: 'send launch announcement', choice: { kind: 'composio', identifier: 'GMAIL_SEND', accountIdentity: 'press@company.example' } });
  assert.equal(recallComposioAccountIdentity('GMAIL_SEND'), undefined);
});

test('recallToolChoice returns null when there is no record', () => {
  assert.equal(recallToolChoice('something.that.was.never.remembered'), null);
});

// ── Procedural failure teeth (learning-wave item D) ─────────────────────────
// Symmetric to the memory correction-loop teeth: a choice whose failures clearly
// dominate must stop being recalled as authoritative, so the model re-probes a
// working path instead of repeating a known-bad one.

test('recallToolChoice suppresses a choice whose failures dominate (re-probe, not repeat)', () => {
  try {
    rememberToolChoice({ intent: 'flaky.sf.team.pull', choice: { kind: 'cli', identifier: 'sf' } });
    assert.ok(recallToolChoice('flaky.sf.team.pull'), 'healthy choice recalls before failures accrue');
    // Accrue clear negative evidence: 2 failures, 0 successes → score below floor.
    updateToolChoiceOutcome('flaky.sf.team.pull', 'failure');
    updateToolChoiceOutcome('flaky.sf.team.pull', 'failure');
    assert.equal(recallToolChoice('flaky.sf.team.pull'), null, 'failing choice is suppressed → re-probe');
  } finally {
    deleteToolChoice('flaky.sf.team.pull');
  }
});

test('recallToolChoice does NOT suppress a fresh choice or a single stray failure', () => {
  try {
    rememberToolChoice({ intent: 'fresh.choice.one', choice: { kind: 'cli', identifier: 'sf' } });
    updateToolChoiceOutcome('fresh.choice.one', 'failure'); // only one negative
    assert.ok(recallToolChoice('fresh.choice.one'), 'a single failure never suppresses (accumulation-gated)');
  } finally {
    deleteToolChoice('fresh.choice.one');
  }
});

test('recallToolChoice keeps a mostly-successful choice despite some failures', () => {
  try {
    rememberToolChoice({ intent: 'reliable.choice.two', choice: { kind: 'cli', identifier: 'sf' } });
    for (let i = 0; i < 5; i++) updateToolChoiceOutcome('reliable.choice.two', 'success');
    updateToolChoiceOutcome('reliable.choice.two', 'failure');
    updateToolChoiceOutcome('reliable.choice.two', 'failure');
    assert.ok(recallToolChoice('reliable.choice.two'), 'successes still dominate → recalled');
  } finally {
    deleteToolChoice('reliable.choice.two');
  }
});

test('stripBakedConnectionId: a saved choice never pins a (rot-prone) composio connection id', () => {
  // A representative stale Airtable connection shape.
  const dirty = 'composio_execute_tool(tool_slug="AIRTABLE_LIST_RECORDS", connected_account_id="ca_fixture_airtable_removed", arguments="{...}")';
  const clean = stripBakedConnectionId(dirty);
  assert.doesNotMatch(clean ?? '', /connected_account_id/);
  assert.doesNotMatch(clean ?? '', /ca_fixture_airtable_removed/);
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
    choice: { kind: 'composio', identifier: 'AIRTABLE_LIST_RECORDS', invocationTemplate: 'composio_execute_tool(tool_slug="AIRTABLE_LIST_RECORDS", connected_account_id="ca_fixture_stale", arguments="{}")' },
  });
  const rec = recallToolChoice('airtable.records.list');
  assert.ok(rec?.choice?.invocationTemplate);
  assert.doesNotMatch(rec.choice.invocationTemplate ?? '', /connected_account_id|ca_fixture_stale/);
});

test('rememberToolChoice rejects placeholder identifiers instead of poisoning active choice recall', () => {
  const intent = 'placeholder.choice.poison';
  rememberToolChoice({
    intent,
    description: 'bad remembered path',
    choice: { kind: 'mcp', identifier: 'null', invocationTemplate: 'null' },
  });
  const rec = recallToolChoice(intent);
  assert.ok(rec, 'record is kept so fallbacks/history can survive');
  assert.equal(rec!.choice, null, 'placeholder is not an active proven choice');
  assert.deepEqual(
    matchToolChoicesForStep('List Airtable records for prospects.', { choices: [rec!] }),
    [],
    'inactive placeholder choices cannot match workflow authoring',
  );
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
      '  invocationTemplate: composio_execute_tool(tool_slug="GOOGLESHEETS_VALUES_UPDATE", connected_account_id="ca_fixture_sheets_removed", arguments="{}")',
      '  testedAt: 2026-05-25T00:00:00Z',
      '---',
      'notes',
    ].join('\n'), 'utf-8');

  const rec = recallToolChoice('googlesheets.values.update');
  assert.ok(rec?.choice, 'choice recalled');
  assert.doesNotMatch(rec!.choice!.invocationTemplate ?? '', /connected_account_id|ca_fixture_sheets_removed/, 'read path strips the baked id');

  const ctx = renderToolChoicesForContext();
  assert.doesNotMatch(ctx, /connected_account_id|ca_fixture_sheets_removed/, 'context injection never exposes a baked id to the model');
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
    intent: 'salesforce.accounts.query_owner_owned_non_priority_account',
    description: 'Query Alex-owned Salesforce accounts not on the Priority Account list.',
    choice: { kind: 'cli', identifier: 'sf', invocationTemplate: 'sf data query --json --query "{{q}}"', testedAt: '2026-01-01T00:00:00.000Z' },
  });
  rememberToolChoice({
    intent: 'airtable.create.base',
    description: 'Create a new Airtable base.',
    choice: { kind: 'composio', identifier: 'AIRTABLE_CREATE_BASE', testedAt: '2026-06-01T00:00:00.000Z' },
  });

  const objective = 'salesforce email reply audit query pre-discovery last 90 days';
  const ranked = renderToolChoicesForContext(12, undefined, objective);
  assert.ok(ranked.includes('★ salesforce.accounts.query_owner_owned_non_priority_account'), 'the relevant Salesforce choice is starred');
  assert.ok(!ranked.includes('★ airtable.create.base'), 'the unrelated Airtable choice is NOT starred');
  assert.ok(
    ranked.indexOf('salesforce.accounts.query_owner_owned_non_priority_account') < ranked.indexOf('airtable.create.base'),
    'the relevant (older) choice is promoted above the newer irrelevant one',
  );

  // No objective → pure recency, byte-identical behavior: no stars, newer first.
  const recencyOnly = renderToolChoicesForContext(12);
  assert.ok(!recencyOnly.includes('★'), 'no objective → nothing is starred');
  assert.ok(
    recencyOnly.indexOf('airtable.create.base') < recencyOnly.indexOf('salesforce.accounts.query_owner_owned_non_priority_account'),
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

test('WS5: gated age decay pulls a STALE win toward the prior (flag off = byte-identical)', () => {
  const stale = { kind: 'mcp' as const, identifier: 'x', testedAt: new Date(Date.now() - 180 * 86_400_000).toISOString(), successCount: 5 };
  // Flag OFF → no decay, raw Laplace score (back-compat).
  delete process.env.CLEMMY_TOOL_CHOICE_DECAY;
  assert.ok(Math.abs(computeChoiceScore(stale) - 6 / 7) < 1e-9, 'flag off: undecayed');
  // Flag ON → 180 days ≈ 2 half-lives (90d) → keep 0.25 → pulled toward 0.5.
  process.env.CLEMMY_TOOL_CHOICE_DECAY = 'on';
  try {
    const decayed = computeChoiceScore(stale);
    assert.ok(decayed < 6 / 7 && decayed > 0.5, 'decayed below raw, still above prior');
    assert.ok(Math.abs(decayed - (0.5 + (6 / 7 - 0.5) * 0.25)) < 1e-6, 'matches 2-half-life decay');
    // A fresh win of the same strength is barely touched.
    const fresh = computeChoiceScore({ kind: 'mcp', identifier: 'x', testedAt: new Date().toISOString(), successCount: 5 });
    assert.ok(fresh > decayed, 'fresh outranks stale under decay');
  } finally {
    delete process.env.CLEMMY_TOOL_CHOICE_DECAY;
  }
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

test('updateToolChoiceOutcomeForIdentifier credits one canonical procedure, not every intent alias', () => {
  process.env.CLEMMY_PROCEDURAL_OUTCOMES = 'on';
  try {
    rememberToolChoice({ intent: 't2 slug one', choice: { kind: 'composio', identifier: 'SALESFORCE_QUERY' } });
    rememberToolChoice({ intent: 't2 slug two', choice: { kind: 'composio', identifier: 'SALESFORCE_QUERY' } });
    const n = updateToolChoiceOutcomeForIdentifier('SALESFORCE_QUERY', 'success');
    assert.equal(n, 1, 'one canonical procedure is credited exactly once');
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
// Regression for the live "acme-facebook-trends" bug: a Facebook-scrape
// step got told to use a Salesforce SOQL choice because `LAST_N_DAYS:15` in the
// SOQL collided with "the last 14 days" in the prompt. Core identity must be the
// command head (sf data query), not argument values.

const sfSoqlChoice = {
  intent: 'pull priority account accounts needing follow-up',
  description: 'Query Salesforce for priority-account accounts via the sf CLI',
  choice: {
    kind: 'cli' as const,
    identifier: `sf data query --query "SELECT Id, Name, Website, LastActivityDate, Owner.Name FROM Account WHERE Owner.Name = 'Alexander Chen' AND Priority_Account__c = TRUE AND (LastActivityDate = NULL OR LastActivityDate < LAST_N_DAYS:15) ORDER BY LastActivityDate ASC NULLS FIRST LIMIT 50"`,
    testedAt: '2026-01-01',
  },
  fallbacks: [], body: '', filePath: '/x',
} as never;

test('matchToolChoicesForStep: a Facebook-scrape step does NOT match a Salesforce SOQL choice (argument-value collision)', () => {
  const fbPrompt = 'Scrape Acme\'s public Facebook page: pull recent public posts from the last 14 days and summarize posting trends.';
  assert.equal(matchToolChoicesForStep(fbPrompt, { choices: [sfSoqlChoice] }).length, 0);
});

test('matchToolChoicesForStep: a genuine Salesforce step STILL matches the SOQL choice (no regression)', () => {
  const sfPrompt = 'Query Salesforce for my priority-account accounts that need follow-up and list their names and websites.';
  assert.ok(matchToolChoicesForStep(sfPrompt, { choices: [sfSoqlChoice] }).length >= 1);
});

// ─── Write-back guard: a gate-blocked / failed attempt must never become a proven choice ───

test('evidenceLooksFailedOrBlocked: recognizes gate refusals + manual-fallback + failure phrasing', () => {
  assert.equal(evidenceLooksFailedOrBlocked('netlify deploy refused by harness UNVERIFIED_DESTINATION gate; must run manually'), true);
  assert.equal(evidenceLooksFailedOrBlocked('Blocked by the destination gate on every path; deploy it manually'), true);
  assert.equal(evidenceLooksFailedOrBlocked('could not deploy — token not readable for raw API upload'), true);
  assert.equal(evidenceLooksFailedOrBlocked('the write was refused by the grounding gate'), true);
  // …but a genuinely-working memo (even one that MENTIONS handling failures) is NOT dropped.
  assert.equal(evidenceLooksFailedOrBlocked('netlify deploy returned production url https://fixture-success.netlify.app for site id site_fixture_success'), false);
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
  // Representative poisoned-choice shape: the model tries to remember a deploy
  // that the destination gate hard-blocked.
  rememberToolChoice({
    intent,
    description: 'Deploy fixture-onepager — blocked by UNVERIFIED_DESTINATION gate; must run manually.',
    choice: { kind: 'cli', identifier: 'netlify', invocationTemplate: 'netlify deploy --prod --dir . --site fixture-onepager.netlify.app', testEvidence: 'refused by harness UNVERIFIED_DESTINATION gate' },
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
    choice: { kind: 'cli', identifier: 'npx', invocationTemplate: 'npx netlify-cli deploy --dir "{{dir}}" --prod --site {{site_id}}', testEvidence: 'returned production url https://fixture-success.netlify.app' },
  });
  // A later gate-blocked attempt must leave the proven choice intact.
  rememberToolChoice({
    intent,
    choice: { kind: 'cli', identifier: 'netlify', invocationTemplate: 'netlify deploy --prod --site fixture-blocked.netlify.app', testEvidence: 'blocked by the gate; run it manually' },
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

test('matchToolChoicesForStep drops a NET-NEGATIVE remembered choice so a broken tool stops resurfacing on steps', () => {
  // A healthy choice keeps the pool non-empty; a broken (net-negative) choice that
  // matches the step must NOT be bound — it should be dropped so the step rediscovers.
  rememberToolChoice({ intent: 'query salesforce accounts records healthy', description: 'x',
    choice: { kind: 'composio', identifier: 'SALESFORCE_QUERY_RECORDS' } });
  rememberToolChoice({ intent: 'list airtable records for prospects', description: 'x',
    choice: { kind: 'composio', identifier: 'AIRTABLE_LIST_RECORDS' } });
  // Net-negative: 2 failures / 0 wins → score 0.25 < TOOL_CHOICE_SCORE_FLOOR (0.34).
  updateToolChoiceOutcome('list airtable records for prospects', 'failure');
  updateToolChoiceOutcome('list airtable records for prospects', 'failure');

  const matches = matchToolChoicesForStep('List Airtable records for prospects.');
  assert.equal(matches.find((m) => m.identifier === 'AIRTABLE_LIST_RECORDS'), undefined,
    'the net-negative airtable choice is not bound to the step (dropped by the outcome floor)');
});

// ─── recallComposioForSearch — the discovery-tax killer ───────────────────────
// The store fragments one slug across many auto-remembered search-query intents;
// jaccard recall misses a prose query. recallComposioForSearch aggregates by slug
// and matches the query against INTENT tokens (which carry the domain words).

function rememberComposio(intent: string, slug: string, successCount: number): void {
  rememberToolChoice({
    intent,
    description: 'Auto-remembered: this Composio slug satisfied the searched intent.',
    choice: { kind: 'composio', identifier: slug, invocationTemplate: '{"a":1}' },
  });
  // Bump success outcomes so the choice is net-positive + carries a count.
  for (let i = 0; i < successCount; i += 1) updateToolChoiceOutcomeForIdentifier(slug, 'success');
}

test('recallComposioForSearch: fragmented intents for ONE slug aggregate and match a prose query (jaccard recall misses)', () => {
  // Three near-duplicate auto-remembered phrasings, all → the same slug.
  rememberComposio('apify run actor facebook page posts scraper public page url', 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS', 30);
  rememberComposio('apify facebook posts scraper actor search', 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS', 29);
  rememberComposio('apify search actors facebook page posts scraper run actor', 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS', 28);

  const q = 'facebook public page latest posts scrape'; // the exact incident phrasing
  // Old narrow recall misses (jaccard < 0.5 + fragment tie).
  assert.equal(recallToolChoice(q), null, 'jaccard recall misses the prose query (the incident)');
  // New matcher hits, aggregating success across all three fragments.
  const hits = recallComposioForSearch(q);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].slug, 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS');
  assert.ok(hits[0].successCount >= 87, `aggregate success across fragments (got ${hits[0].successCount})`);
});

test('recallComposioForSearch: a toolkit-named query matches on a single strong anchor', () => {
  rememberComposio('firecrawl.search', 'FIRECRAWL_SEARCH', 6);
  const hits = recallComposioForSearch('use firecrawl to search the web');
  assert.ok(hits.some((h) => h.slug === 'FIRECRAWL_SEARCH'), 'the toolkit name (firecrawl) is a confident anchor');
});

test('recallComposioForSearch: an unrelated query does NOT match (search still runs)', () => {
  rememberComposio('apify run actor facebook page posts scraper', 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS', 30);
  assert.deepEqual(recallComposioForSearch('scrape linkedin company employee directory'), [], 'no shared domain anchor → miss');
  // A lone generic verb overlap must not anchor either.
  assert.deepEqual(recallComposioForSearch('search for something'), [], 'generic-only overlap → miss');
});

test('recallComposioForSearch: excludes a net-negative (broken) remembered path', () => {
  rememberToolChoice({ intent: 'brokenapp export the widgets report', choice: { kind: 'composio', identifier: 'BROKENAPP_EXPORT_WIDGETS' } });
  for (let i = 0; i < 5; i += 1) updateToolChoiceOutcomeForIdentifier('BROKENAPP_EXPORT_WIDGETS', 'failure');
  assert.deepEqual(recallComposioForSearch('brokenapp export widgets report'), [], 'a net-negative path is never short-circuited onto');
});

// ─── Canonical procedural memory ────────────────────────────────────────────

function switchTestMachine(machineId: string): void {
  writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), `${machineId}\n`);
  resetMachineIdCacheForTests();
}

test('canonical procedures collapse intent aliases without multiplying historical broadcast counters', () => {
  switchTestMachine('machine-canonical-migration');
  const legacyDir = path.join(TMP_HOME, 'memory', 'tool-choices', 'machine-canonical-migration');
  mkdirSync(legacyDir, { recursive: true });
  const legacy = (intent: string) => [
    '---',
    `intent: ${intent}`,
    'choice:',
    '  kind: composio',
    '  identifier: GOOGLESHEETS_BATCH_UPDATE',
    '  testedAt: 2026-07-01T00:00:00.000Z',
    '  successCount: 7',
    'fallbacks: []',
    '---',
    '# legacy alias',
    '',
  ].join('\n');
  writeFileSync(path.join(legacyDir, 'update-weekly-sheet.md'), legacy('update weekly sheet'));
  writeFileSync(path.join(legacyDir, 'write-campaign-rows.md'), legacy('write campaign rows'));

  const report = migrateToolChoicesToCanonicalProcedures();
  assert.equal(report.aliasesLinked, 2);
  assert.equal(report.proceduresCreated, 1);
  assert.equal(listToolChoiceAliases().length, 2, 'both original evidence files remain');
  const procedures = listToolProcedures();
  assert.equal(procedures.length, 1, 'one reusable physical procedure');
  assert.equal(procedures[0].aliases.length, 2);
  assert.equal(procedures[0].evidence.length, 2);
  assert.equal(procedures[0].choice?.successCount, 7, 'duplicate broadcast counters are max-merged, not summed to 14');
});

test('legacy native-MCP objective prose is quarantined while a compact operation alias remains recallable', () => {
  switchTestMachine('machine-native-objective-quarantine');
  const legacyDir = path.join(TMP_HOME, 'memory', 'tool-choices', 'machine-native-objective-quarantine');
  mkdirSync(legacyDir, { recursive: true });
  const identifier = 'notion__search_pages';
  const objective = `Prepare the Q3 client audit summary — ${identifier}`;
  writeFileSync(path.join(legacyDir, 'objective.md'), [
    '---',
    `intent: ${objective}`,
    'description: "Auto-remembered: this native MCP tool satisfied the active objective."',
    'choice:',
    '  kind: mcp',
    `  identifier: ${identifier}`,
    '  testedAt: 2026-07-01T00:00:00.000Z',
    'fallbacks: []',
    '---',
    '# legacy objective',
    '',
  ].join('\n'));

  const report = migrateToolChoicesToCanonicalProcedures();
  assert.equal(report.quarantinedAliases, 1);
  const procedure = listToolProcedures()[0];
  assert.ok(procedure.aliases.some((alias) => alias.intent === objective && alias.status === 'quarantined'));
  assert.ok(procedure.aliases.some((alias) => alias.intent === 'notion.search_pages' && alias.status === 'active'));
  assert.equal(recallToolChoice(objective), null, 'broad project prose cannot be replayed as a procedure key');
  assert.equal(recallToolChoice('notion search pages')?.choice?.identifier, identifier, 'the operation remains recallable');
  assert.deepEqual(matchToolChoicesForStep('Prepare the Q3 client audit summary.'), [], 'quarantined prose cannot auto-bind a workflow');
});

test('impressions are diagnostic only and never improve procedure score', () => {
  switchTestMachine('machine-procedure-impressions');
  const record = rememberToolChoice({
    intent: 'outlook.list.messages',
    choice: { kind: 'composio', identifier: 'OUTLOOK_LIST_MESSAGES' },
  });
  assert.ok(record.procedureId);
  const before = computeChoiceScore(record.choice);
  for (let i = 0; i < 12; i += 1) recordToolProcedureImpression(record.procedureId!);
  const procedure = listToolProcedures()[0];
  assert.equal(procedure.impressionCount, 12);
  assert.equal(computeChoiceScore(procedure.choice), before, 'exposure does not masquerade as utility');
});

test('identifier-only outcomes abstain when two canonical operations share a CLI binary', () => {
  switchTestMachine('machine-ambiguous-cli-outcomes');
  rememberToolChoice({
    intent: 'netlify.deploy.site',
    choice: { kind: 'cli', identifier: 'netlify', invocationTemplate: 'netlify deploy --prod' },
  });
  rememberToolChoice({
    intent: 'netlify.status.site',
    choice: { kind: 'cli', identifier: 'netlify', invocationTemplate: 'netlify status' },
  });
  assert.equal(updateToolChoiceOutcomeForIdentifier('netlify', 'success'), 0, 'ambiguous bare identifier credits nothing');
  assert.ok(listToolProcedures().every((procedure) => (procedure.choice?.successCount ?? 0) === 0));
});

test('one-shot procedure use IDs credit only the selected procedure and cannot be replayed', () => {
  switchTestMachine('machine-procedure-use-id');
  const selected = rememberToolChoice({
    intent: 'salesforce.query.accounts',
    choice: { kind: 'composio', identifier: 'SALESFORCE_QUERY_RECORDS' },
  });
  assert.ok(selected.procedureId);
  const use = beginToolProcedureUseById(selected.procedureId!, selected.intent, 'session-use-id');
  assert.ok(use);
  assert.ok(completeToolProcedureUse(use!.useId, 'success'));
  assert.equal(completeToolProcedureUse(use!.useId, 'success'), null, 'the same execution cannot be credited twice');
  assert.equal(peekToolChoice(selected.intent)?.choice?.successCount, 1);
});

test('a corrupt legacy alias file is skipped — migration and recall of healthy intents survive', () => {
  switchTestMachine('machine-corrupt-legacy-alias');
  const legacyDir = path.join(TMP_HOME, 'memory', 'tool-choices', 'machine-corrupt-legacy-alias');
  mkdirSync(legacyDir, { recursive: true });
  // Torn write / hand-edit: frontmatter YAML that gray-matter cannot parse.
  writeFileSync(path.join(legacyDir, 'broken-intent.md'), '---\nintent: [unclosed\nchoice: {{{\n---\nbody\n');
  writeFileSync(
    path.join(legacyDir, 'healthy-intent.md'),
    [
      '---',
      'intent: healthy intent',
      'choice:',
      '  kind: composio',
      '  identifier: GMAIL_SEND_EMAIL',
      '  successCount: 2',
      'fallbacks: []',
      '---',
      '# legacy alias',
      '',
    ].join('\n'),
  );

  assert.doesNotThrow(() => migrateToolChoicesToCanonicalProcedures());
  const recalled = recallToolChoice('healthy intent');
  assert.equal(recalled?.choice?.identifier, 'GMAIL_SEND_EMAIL', 'healthy intents stay recallable');
  assert.ok(
    listToolProcedures().some((procedure) => procedure.choice?.identifier === 'GMAIL_SEND_EMAIL'),
    'migration completed for the healthy file',
  );
});

test('renderToolChoicesForContext: C6 — a choice bound to an account shows @identity; one without is unchanged', () => {
  const previous = process.env.TOOL_CHOICE_CONTEXT_INJECT;
  process.env.TOOL_CHOICE_CONTEXT_INJECT = 'on';
  try {
    rememberToolChoice({
      intent: 'c6.render.with-identity',
      choice: {
        kind: 'composio',
        identifier: 'OUTLOOK_LIST_MESSAGES',
        accountIdentity: 'alex@corp.example',
        testedAt: '2099-05-01T00:00:00.000Z',
      },
    });
    rememberToolChoice({
      intent: 'c6.render.without-identity',
      choice: { kind: 'composio', identifier: 'DATAFORSEO_SERP_GOOGLE_ORGANIC_LIVE_ADVANCED', testedAt: '2099-05-02T00:00:00.000Z' },
    });
    const rendered = renderToolChoicesForContext(4);
    const withIdentity = rendered.split('\n').find((l) => l.includes('c6.render.with-identity'));
    const withoutIdentity = rendered.split('\n').find((l) => l.includes('c6.render.without-identity'));
    assert.ok(withIdentity, 'identity-bound line rendered');
    assert.match(withIdentity!, /OUTLOOK_LIST_MESSAGES @alex@corp\.example/);
    assert.ok(withoutIdentity, 'identity-free line rendered');
    assert.doesNotMatch(withoutIdentity!, / @/, 'no identity marker when the choice has no accountIdentity');
  } finally {
    if (previous === undefined) delete process.env.TOOL_CHOICE_CONTEXT_INJECT;
    else process.env.TOOL_CHOICE_CONTEXT_INJECT = previous;
  }
});
