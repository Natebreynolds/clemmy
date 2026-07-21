/**
 * Run: npx tsx --test src/agents/harness-context.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-harness-context-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resetMemoryDb } = await import('../memory/db.js');
const { createFocus } = await import('../memory/focus.js');
const { renderHarnessMemoryContext } = await import('./harness-context.js');
const { saveProactivityPolicy } = await import('./proactivity-policy.js');
const { rememberFact } = await import('../memory/facts.js');
const { checkpointWorkingMemory } = await import('../memory/working-memory.js');
const { createSession, appendEvent } = await import('../runtime/harness/eventlog.js');
const { MEMORY_AUTO_SECTION_MARKER, MEMORY_FILE } = await import('../memory/vault.js');

test('query-driven recall: a request-relevant fact is surfaced UP FRONT for a matching message (never knowledge-starve the brain)', () => {
  resetMemoryDb();
  rememberFact({ kind: 'project', content: 'The daily-prospect-outreach workflow targets Salesforce Accounts owned by Alexander Chen where Priority_Account__c is true and a usable website exists.' });
  // The Claude SDK lane passes the user's message → the matching fact is recalled
  // into its own section instead of the model rediscovering the schema via tool thrash.
  const ctx = renderHarnessMemoryContext({ query: 'pull 10 of my priority account accounts I have not touched in 15 days' });
  assert.match(ctx, /## Relevant To Your Request/);
  assert.match(ctx, /Priority_Account__c/);
});

test('query-driven recall: kill-switch off ⇒ no per-request recall section', () => {
  resetMemoryDb();
  rememberFact({ kind: 'project', content: 'Priority_Account__c is the Salesforce field marking priority account accounts.' });
  process.env.CLEMMY_BRAIN_QUERY_RECALL = 'off';
  try {
    assert.doesNotMatch(renderHarnessMemoryContext({ query: 'priority account accounts' }), /## Relevant To Your Request/);
  } finally {
    delete process.env.CLEMMY_BRAIN_QUERY_RECALL;
  }
});

test('query-driven recall: no query ⇒ no per-request recall section (byte-identical to before)', () => {
  resetMemoryDb();
  rememberFact({ kind: 'project', content: 'Priority_Account__c marks priority account accounts.' });
  assert.doesNotMatch(renderHarnessMemoryContext({ sessionId: 's' }), /## Relevant To Your Request/);
});

test('same-session completed external actions are visible in shared harness context', () => {
  const session = createSession({ kind: 'chat', channel: 'test' });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: { shapeKey: 'OUTLOOK_SEND_EMAIL', targets: ['casey@example.com'] },
  });

  const context = renderHarnessMemoryContext({ sessionId: session.id, partition: 'volatile' });
  assert.match(context, /## Completed Actions This Conversation/);
  assert.match(context, /ALREADY DONE in THIS conversation/);
  assert.match(context, /OUTLOOK_SEND_EMAIL/);
  assert.match(context, /casey@example\.com/);
});

test('workflow-step harness context sees completed actions from sibling step sessions', () => {
  const step1 = createSession({
    kind: 'workflow',
    channel: 'workflow',
    title: 'Prompt Action Flow::step-1',
    metadata: { workflowRunId: 'prompt-action-run', workflowName: 'Prompt Action Flow', stepId: 'step-1' },
  });
  appendEvent({
    sessionId: step1.id,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: { shapeKey: 'CRM_UPDATE', targets: ['account:42'] },
  });
  const step2 = createSession({
    kind: 'workflow',
    channel: 'workflow',
    title: 'Prompt Action Flow::step-2',
    metadata: { workflowRunId: 'prompt-action-run', workflowName: 'Prompt Action Flow', stepId: 'step-2' },
  });

  const context = renderHarnessMemoryContext({ sessionId: step2.id, partition: 'volatile' });

  assert.match(context, /## Completed Actions This Conversation/);
  assert.match(context, /ALREADY DONE in THIS workflow run/);
  assert.match(context, /CRM_UPDATE/);
  assert.match(context, /account:42/);
});

test('harness context prefers per-session working-memory checkpoints over global memory', () => {
  checkpointWorkingMemory('sess-harness-wm', {
    turn: 4,
    toolCallsTotal: 9,
    lastText: 'Recovered 12 prospects; next verify the publish queue.',
  });

  const context = renderHarnessMemoryContext({ sessionId: 'sess-harness-wm', partition: 'volatile' });

  assert.match(context, /## Working Memory/);
  assert.match(context, /In-flight Checkpoint/);
  assert.match(context, /Recovered 12 prospects/);
});

test('Autonomy section: YOLO auto-runs reversible work but preserves one irreversible-action gate', () => {
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const context = renderHarnessMemoryContext();
    assert.match(context, /## Autonomy/);
    assert.match(context, /STANDING APPROVAL for reversible work/);
    assert.match(context, /do NOT use ask_user_question to seek sign-off/i);
    assert.match(context, /Irreversible external sends\/posts\/calls and destructive actions remain exceptions/);
    assert.match(context, /one approval card own the pause/);
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'balanced' });
  }
});

test('Autonomy section: legacy "balanced" renders the Supervised line (== strict; two-posture model)', () => {
  saveProactivityPolicy({ autoApproveScope: 'balanced' });
  const context = renderHarnessMemoryContext();
  assert.match(context, /Supervised/);
});

test('stable context carries compact skill discovery while the volatile query gets only relevant skills', () => {
  const skillDir = path.join(TMP_HOME, 'skills', 'proposal-style');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: Proposal Style',
      'description: Brand rules for polished proposal artifacts.',
      '---',
      '',
      'Full body should remain behind skill_read.',
    ].join('\n'),
    'utf-8',
  );

  const stable = renderHarnessMemoryContext({ partition: 'stable' });
  assert.match(stable, /## Skill Discovery/);
  assert.match(stable, /skill_list\(\)/);
  assert.doesNotMatch(stable, /`proposal-style`/, 'installed names do not bloat or churn the stable prefix');

  const relevant = renderHarnessMemoryContext({
    query: 'Create a polished proposal document for a client.',
    partition: 'volatile',
  });
  assert.match(relevant, /## Relevant Skills/);
  assert.equal((relevant.match(/## Relevant Skills/g) ?? []).length, 1, 'canonical volatile context injects one menu');
  assert.doesNotMatch(relevant, /## Skill Discovery/, 'volatile context does not repeat the stable discovery pointer');
  assert.match(relevant, /`proposal-style`: Brand rules for polished proposal artifacts\./);
  assert.doesNotMatch(relevant, /Full body should remain behind skill_read/);
});

test('stale focus is not rendered as active persistent context', () => {
  resetMemoryDb();
  process.env.CLEMMY_FOCUS_CONFIRM_MS = '1';
  try {
    createFocus({
      resourceRef: 'https://docs.google.com/spreadsheets/d/stale-sheet',
      title: 'Priority account sheet',
      summary: 'Old sheet work',
      resourceKind: 'sheet',
    });
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }

    const context = renderHarnessMemoryContext();
    assert.match(context, /No confirmed active focus/);
    assert.match(context, /STALE focus #\d+: Priority account sheet/);
    assert.doesNotMatch(context, /ACTIVE focus #\d+: Priority account sheet/);
  } finally {
    delete process.env.CLEMMY_FOCUS_CONFIRM_MS;
  }
});

test('partition: default ("all") is byte-identical to no partition (regression guard for the cache split)', () => {
  resetMemoryDb();
  rememberFact({ kind: 'project', content: 'Priority_Account__c marks priority account accounts.' });
  const q = 'pull my priority account accounts';
  assert.equal(
    renderHarnessMemoryContext({ sessionId: 's', query: q, partition: 'all' }),
    renderHarnessMemoryContext({ sessionId: 's', query: q }),
  );
});

test('partition: stable EXCLUDES the volatile tail (Now / query recall / Current Focus); volatile holds ONLY those', () => {
  resetMemoryDb();
  rememberFact({ kind: 'project', content: 'Priority_Account__c marks priority account accounts in Salesforce.' });
  const q = 'priority account accounts';

  const stable = renderHarnessMemoryContext({ sessionId: 's', query: q, partition: 'stable' });
  // The big stable memory stays (cacheable); the per-turn-volatile blocks are gone.
  assert.match(stable, /## Persistent Facts/);
  assert.doesNotMatch(stable, /## Now/);
  assert.doesNotMatch(stable, /## Relevant To Your Request/);
  assert.doesNotMatch(stable, /## Relevant Skills/);
  assert.doesNotMatch(stable, /## Current Focus/);

  const volatile = renderHarnessMemoryContext({ sessionId: 's', query: q, partition: 'volatile' });
  // The volatile tail carries the time-sensitive bits and its own light header…
  assert.match(volatile, /# Current State \(refreshed this turn\)/);
  assert.match(volatile, /## Now/);
  assert.match(volatile, /## Relevant To Your Request/);
  // …and NOT the stable memory (so it doesn't duplicate the cached prefix).
  assert.doesNotMatch(volatile, /## Persistent Facts/);
  assert.doesNotMatch(volatile, /# Persistent Context/);
});

test('policy memory is rendered once without the legacy all-constraints duplicate', () => {
  resetMemoryDb();
  rememberFact({ kind: 'constraint', content: 'Always send Outlook email from legal@example.com.' });
  rememberFact({ kind: 'constraint', content: 'Always pause and ask a human before discussing sensitive legal requests.' });
  const ctx = renderHarnessMemoryContext({ sessionId: 's', partition: 'all' });
  assert.match(ctx, /## Persistent Facts/);
  assert.match(ctx, /Dispatch-enforced constraints/);
  assert.match(ctx, /Prompt-only instructions \(context, not deterministic enforcement\)/);
  assert.match(ctx, /1 dispatch-enforced, 1 prompt-only/);
  assert.doesNotMatch(ctx, /## Standing Constraints/);
  assert.equal(ctx.match(/Always send Outlook email from legal@example\.com\./g)?.length, 1);
  assert.equal(ctx.match(/Always pause and ask a human before discussing sensitive legal requests\./g)?.length, 1);
});

test('assembled prompt ignores the generated MEMORY.md projection but preserves curated memory', () => {
  resetMemoryDb();
  rememberFact({ kind: 'project', content: 'Canonical project fact remains available from SQLite.' });
  mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  writeFileSync(
    MEMORY_FILE,
    `# Memory\n\n${MEMORY_AUTO_SECTION_MARKER}\n\n## Projects\n- ${'generated duplicate '.repeat(400)}\n`,
    'utf-8',
  );
  const withGeneratedProjection = renderHarnessMemoryContext({ partition: 'stable' });

  writeFileSync(MEMORY_FILE, '# Memory\n', 'utf-8');
  const withScaffoldOnly = renderHarnessMemoryContext({ partition: 'stable' });
  assert.equal(withGeneratedProjection, withScaffoldOnly, 'generated projection must add zero prompt bytes');
  assert.doesNotMatch(withGeneratedProjection, /generated duplicate/);
  assert.match(withGeneratedProjection, /Canonical project fact remains available from SQLite/);

  writeFileSync(
    MEMORY_FILE,
    `# Memory\n\n## Curated context\n- Keep this compact standing note.\n\n${MEMORY_AUTO_SECTION_MARKER}\n\n- generated duplicate\n`,
    'utf-8',
  );
  const curated = renderHarnessMemoryContext({ partition: 'stable' });
  assert.match(curated, /## Long-Term Memory/);
  assert.match(curated, /Keep this compact standing note/);
  assert.doesNotMatch(curated, /generated duplicate/);
});

process.on('exit', () => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('query-recall lines are bounded: a runaway fact cannot blow the volatile context', () => {
  resetMemoryDb();
  const runaway = `Salesforce priority account schema notes: ${'z'.repeat(5_000)}`;
  rememberFact({ kind: 'project', content: runaway });
  rememberFact({ kind: 'constraint', content: `Always send from the approved sender. ${'c'.repeat(5_000)}` });
  const ctx = renderHarnessMemoryContext({ query: 'salesforce priority account schema notes' });
  // Query recall has its own per-line bound. Policy memory is bounded by the
  // Persistent Facts tier budgets and is not duplicated into another section.
  // (The Persistent Facts primer has its own TOTAL bound and allows longer lines.)
  for (const section of ctx.split(/\n(?=## )/)) {
    const title = section.split('\n', 1)[0] ?? '';
    if (!/Relevant To Your Request/.test(title)) continue;
    for (const line of section.split('\n').filter((l) => l.startsWith('- '))) {
      assert.ok(line.length <= 1060, `injected line bounded (got ${line.length} chars in "${title}")`);
    }
  }
});

test('recall + constraint lines under the bound are byte-identical (no clipping side effects)', () => {
  resetMemoryDb();
  const content = 'The daily-prospect-outreach workflow targets Salesforce Accounts owned by Alexander Chen.';
  rememberFact({ kind: 'project', content });
  const ctx = renderHarnessMemoryContext({ query: 'daily prospect outreach workflow salesforce' });
  assert.ok(ctx.includes(`- ${content}`), 'short fact renders unmodified');
});
