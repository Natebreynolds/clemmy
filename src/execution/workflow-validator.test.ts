/**
 * Run: npx tsx --test src/execution/workflow-validator.test.ts
 *
 * Proves the validator catches the workflow-content bugs that bit us
 * in production (daily-prospect-outreach hand-off language + missing
 * post-approval action).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateWorkflowDefinition, type WorkflowFrontmatter } from './workflow-validator.js';

// ── Sanity: a clean workflow has no errors and no warnings ────────────

test('clean workflow → ok=true, no errors, no warnings', () => {
  const wf: WorkflowFrontmatter = {
    name: 'hello-world',
    description: 'A simple workflow that says hello',
    enabled: true,
    steps: [
      { id: 'greet', prompt: 'Send Nate a notification saying hello.' },
    ],
  };
  const result = validateWorkflowDefinition(wf);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

// ── Pre-existing structural checks survived the extract ───────────────

test('missing name → error', () => {
  const result = validateWorkflowDefinition({ steps: [{ id: 'x', prompt: 'do thing' }] });
  assert.ok(result.errors.some((e) => e.includes('has no name')));
});

test('duplicate step ids → error', () => {
  const result = validateWorkflowDefinition({
    name: 'dup',
    steps: [
      { id: 'a', prompt: 'first' },
      { id: 'a', prompt: 'second' },
    ],
  });
  assert.ok(result.errors.some((e) => e.includes('duplicate step id')));
});

test('dependsOn unknown step → error', () => {
  const result = validateWorkflowDefinition({
    name: 'dep',
    steps: [
      { id: 'a', prompt: 'first', dependsOn: ['nonexistent'] },
    ],
  });
  assert.ok(result.errors.some((e) => e.includes('depends on unknown step')));
});

test('cycle in dependsOn → error', () => {
  const result = validateWorkflowDefinition({
    name: 'cyc',
    steps: [
      { id: 'a', prompt: 'first', dependsOn: ['b'] },
      { id: 'b', prompt: 'second', dependsOn: ['a'] },
    ],
  });
  assert.ok(result.errors.some((e) => e.includes('cycle')));
});

test('invalid cron → error', () => {
  const result = validateWorkflowDefinition({
    name: 'badcron',
    trigger: { schedule: 'not a cron' },
    steps: [{ id: 'a', prompt: 'do thing' }],
  });
  assert.ok(result.errors.some((e) => e.includes('Invalid cron expression')));
});

// ── New semantic checks (2026-05-21) ──────────────────────────────────

test('hand-off language "future turn handles" → error', () => {
  // Exact phrase from daily-prospect-outreach's surface_for_approval step.
  const result = validateWorkflowDefinition({
    name: 'wf',
    steps: [{
      id: 'broken',
      prompt: 'Do the thing. After approval (a future turn handles the resume), continue.',
    }],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('future turn handles') || e.includes('hand-off language')),
    `expected hand-off-language error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('hand-off language "another agent will pick up" → error', () => {
  const result = validateWorkflowDefinition({
    name: 'wf',
    steps: [{
      id: 'broken',
      prompt: 'Send the email. Another agent will pick up the response later.',
    }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.toLowerCase().includes('hand-off')));
});

test('hand-off language "deferred to a future turn" → error', () => {
  const result = validateWorkflowDefinition({
    name: 'wf',
    steps: [{
      id: 'broken',
      prompt: 'Mark the records. Final send is deferred to a future turn.',
    }],
  });
  assert.equal(result.ok, false);
});

test('approval without post-approval action → error', () => {
  const result = validateWorkflowDefinition({
    name: 'wf',
    steps: [{
      id: 'gated',
      prompt: 'Surface the drafts to the user and call request_approval. That is all.',
    }],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('request_approval') && e.includes('after approval')),
    `expected approval-coherence error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('approval WITH post-approval action → ok', () => {
  const result = validateWorkflowDefinition({
    name: 'wf',
    description: 'Send 10 outreach emails after Nate approves the batch.',
    steps: [{
      id: 'gated',
      prompt: 'Surface the drafts. Call request_approval with the batch summary. '
        + 'After approval is granted, immediately call OUTLOOK_SEND_EMAIL for each draft '
        + 'in the same turn — do not defer to a separate run.',
    }],
  });
  // Should NOT have the approval-coherence error.
  assert.ok(
    !result.errors.some((e) => e.includes('request_approval') && e.includes('after approval')),
    `unexpected error: ${JSON.stringify(result.errors)}`,
  );
});

test('unresolved {{steps.X.output}} reference → error', () => {
  const result = validateWorkflowDefinition({
    name: 'wf',
    steps: [
      { id: 'a', prompt: 'first step output here' },
      { id: 'b', prompt: 'use the data from {{steps.nonexistent.output}} please' },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('nonexistent')),
    `expected unresolved ref error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('resolved {{steps.X.output}} reference → ok', () => {
  const result = validateWorkflowDefinition({
    name: 'wf',
    description: 'Two-step workflow with valid output ref',
    steps: [
      { id: 'fetch', prompt: 'fetch records and return a list' },
      { id: 'use', prompt: 'process {{steps.fetch.output}} please', dependsOn: ['fetch'] },
    ],
  });
  assert.ok(
    !result.errors.some((e) => e.includes('steps.fetch.output')),
    `unexpected error: ${JSON.stringify(result.errors)}`,
  );
});

test('tool slug catalog check — unknown slug → warning', () => {
  const knownToolNames = new Set(['notify_user', 'run_shell_command', 'memory_remember']);
  const result = validateWorkflowDefinition({
    name: 'wf',
    description: 'Workflow that references a hallucinated tool slug',
    steps: [{
      id: 'gated',
      prompt: 'Call HALLUCINATED_TOOL_SLUG to do the thing. '
        + 'After Approved, immediately invoke `HALLUCINATED_TOOL_SLUG` for each item.',
    }],
  }, { knownToolNames });
  assert.ok(
    result.warnings.some((w) => w.includes('HALLUCINATED_TOOL_SLUG')),
    `expected slug warning, got warnings: ${JSON.stringify(result.warnings)}`,
  );
});

// ── Regression: the EXACT daily-prospect-outreach surface_for_approval prompt ──
// If this test passes (with errors), the validator catches the bug
// that broke the workflow in production tonight.

test('REGRESSION: daily-prospect-outreach surface_for_approval prompt is rejected', () => {
  const prompt = `
    Surface the drafts to Nate with \`notify_user\`. Do NOT call \`OUTLOOK_SEND_EMAIL\` yet — that's gated behind explicit approval.

    Format:
    - Title: "Today's 10 prospect drafts ready for review"
    - Body: A short summary.

    Then call \`request_approval\` with:
    - subject: "Send the 10 cold-prospect emails"
    - reason: "..."

    After approval (a future turn handles the resume): for each draft, call \`cx_outlook_send_email\`.
  `;
  const result = validateWorkflowDefinition({
    name: 'daily-prospect-outreach',
    description: 'The exact prompt that broke production on 2026-05-21.',
    steps: [
      { id: 'fetch_stale_accounts', prompt: 'fetch them' },
      { id: 'draft_emails', prompt: 'draft them' },
      { id: 'surface_for_approval', prompt, dependsOn: ['fetch_stale_accounts', 'draft_emails'] },
    ],
  });
  assert.equal(result.ok, false, 'expected REJECTED — this prompt broke production');
  // Specifically: hand-off language should fire.
  assert.ok(
    result.errors.some((e) => e.toLowerCase().includes('hand-off') || e.includes('future turn')),
    `expected hand-off error from "future turn handles the resume", got: ${JSON.stringify(result.errors)}`,
  );
});
