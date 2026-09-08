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
      { id: 'greet', prompt: 'Send Alex a notification saying hello.' },
    ],
  };
  const result = validateWorkflowDefinition(wf);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('reviewed promptless transform is valid only as closed read-class computation', () => {
  const transform = {
    version: 1,
    expression: {
      op: 'object',
      fields: [
        { key: 'rows', value: { op: 'get', from: 'steps.pull.output.records' } },
        {
          key: 'count',
          value: { op: 'count', value: { op: 'get', from: 'steps.pull.output.records' } },
        },
      ],
    },
  };
  const valid = validateWorkflowDefinition({
    name: 'closed-transform',
    description: 'Shape exact provider rows.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'pull', prompt: 'Pull records.', sideEffect: 'read' },
      { id: 'shape', prompt: '', dependsOn: ['pull'], sideEffect: 'read', transform },
    ],
  });
  assert.equal(valid.ok, true, valid.errors.join('\n'));

  const effectful = validateWorkflowDefinition({
    name: 'effectful-transform',
    description: 'Reject mixed authority.',
    enabled: true,
    trigger: { manual: true },
    steps: [{
      id: 'shape',
      prompt: '',
      sideEffect: 'write',
      transform: { version: 1, expression: { op: 'literal', value: true } },
      call: { tool: 'FILES_WRITE' },
      allowedTools: ['run_shell_command'],
    }],
  });
  assert.equal(effectful.ok, false);
  assert.match(effectful.errors.join(' '), /must explicitly declare sideEffect: read/);
  assert.match(effectful.errors.join(' '), /cannot combine with.*call.*allowedTools/);
});

test('transform source lineage is dependency- and declared-input-bound', () => {
  const transform = {
    version: 1,
    expression: {
      op: 'array',
      items: [
        { op: 'get', from: 'steps.pull.output' },
        { op: 'get', from: 'input.segment' },
      ],
    },
  };
  const missing = validateWorkflowDefinition({
    name: 'unbound-transform',
    description: 'Reject unbound transform sources.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'pull', prompt: 'Pull records.', sideEffect: 'read' },
      { id: 'shape', prompt: '', sideEffect: 'read', transform },
    ],
  });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(' '), /does not depend on "pull"/);
  assert.match(missing.errors.join(' '), /undeclared workflow input "segment"/);

  const invalidOp = validateWorkflowDefinition({
    name: 'source-code-transform',
    description: 'Reject executable source.',
    enabled: true,
    trigger: { manual: true },
    steps: [{
      id: 'shape',
      prompt: '',
      sideEffect: 'read',
      transform: { version: 1, expression: { op: 'javascript', source: 'return process.env' } },
    }],
  });
  assert.equal(invalidOp.ok, false);
  assert.match(invalidOp.errors.join(' '), /not a reviewed transform operation/);
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

test('invalid timezone → error (would silently misfire at host time)', () => {
  const result = validateWorkflowDefinition({
    name: 'badtz',
    trigger: { schedule: '0 8 * * *', timezone: 'America/Los_Angles' },
    steps: [{ id: 'a', prompt: 'do thing' }],
  });
  assert.ok(result.errors.some((e) => e.includes('Invalid timezone')));
});

test('valid IANA timezone → no timezone error', () => {
  for (const tz of ['America/Los_Angeles', 'Europe/London', 'UTC']) {
    const result = validateWorkflowDefinition({
      name: 'goodtz',
      trigger: { schedule: '0 8 * * *', timezone: tz },
      steps: [{ id: 'a', prompt: 'do thing' }],
    });
    assert.ok(!result.errors.some((e) => e.includes('Invalid timezone')), `${tz} should be valid`);
  }
});

test('valid exact interval recurrence is accepted', () => {
  const result = validateWorkflowDefinition({
    name: 'interval-valid',
    description: 'Runs on one exact fixed-duration recurrence',
    enabled: true,
    trigger: {
      interval: {
        version: 1,
        every: 2,
        unit: 'hour',
        anchorAt: '2026-08-22T19:00:00.000Z',
        overlapPolicy: 'queue_one',
        catchUpPolicy: 'run_once',
      },
    },
    steps: [{ id: 'read', prompt: 'Read the current source.', sideEffect: 'read' }],
  });
  assert.equal(result.errors.some((error) => error.includes('interval')), false, result.errors.join('\n'));
});

test('interval recurrence rejects malformed anchors and competing cron authority', () => {
  const base = {
    version: 1,
    every: 2,
    unit: 'hour',
    anchorAt: '2026-08-22T19:00:30.000Z',
    overlapPolicy: 'queue_one',
    catchUpPolicy: 'run_once',
  };
  const malformed = validateWorkflowDefinition({
    name: 'interval-malformed',
    description: 'Malformed interval should stay inert',
    trigger: { interval: base },
    steps: [{ id: 'read', prompt: 'Read the current source.', sideEffect: 'read' }],
  });
  assert.ok(malformed.errors.some((error) => error.includes('canonical UTC minute')));

  const competing = validateWorkflowDefinition({
    name: 'interval-competing',
    description: 'Two time authorities must not coexist',
    trigger: {
      schedule: '0 * * * *',
      timezone: 'UTC',
      interval: { ...base, anchorAt: '2026-08-22T19:00:00.000Z' },
    },
    steps: [{ id: 'read', prompt: 'Read the current source.', sideEffect: 'read' }],
  });
  assert.ok(competing.errors.some((error) => error.includes('mutually exclusive time authorities')));
  assert.ok(competing.errors.some((error) => error.includes('timezone cannot accompany')));
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
    description: 'Send 10 outreach emails after Alex approves the batch.',
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

test('forEachNewOnly without forEach → error', () => {
  const result = validateWorkflowDefinition({
    name: 'new-only-orphan',
    description: 'Invalid new-only workflow with no fan-out source',
    steps: [
      { id: 'send', prompt: 'Send each new lead.', forEachNewOnly: true },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('forEachNewOnly') && e.includes('no forEach source')),
    `expected forEachNewOnly/forEach error, got: ${JSON.stringify(result.errors)}`,
  );
  assert.equal(result.errors.filter((e) => e.includes('forEachNewOnly')).length, 1);
});

test('for_each_new_only with a valid forEach dependency → ok', () => {
  const result = validateWorkflowDefinition({
    name: 'new-only-good',
    description: 'Valid new-only workflow with an upstream list dependency',
    steps: [
      { id: 'pull', prompt: 'Pull latest leads.' },
      {
        id: 'send',
        prompt: 'Send each new lead.',
        dependsOn: ['pull'],
        forEach: 'pull',
        for_each_new_only: true,
      },
    ],
  });
  assert.ok(
    !result.errors.some((e) => e.includes('forEachNewOnly') || e.includes('for_each_new_only')),
    `unexpected new-only error: ${JSON.stringify(result.errors)}`,
  );
});

test('orderingOnlyDeps is deprecated warning, not error', () => {
  const result = validateWorkflowDefinition({
    name: 'legacy-ordering',
    description: 'Workflow with a legacy ordering-only dependency marker',
    steps: [
      { id: 'fetch', prompt: 'Fetch data.' },
      {
        id: 'summarize',
        prompt: 'Summarize the fetched data.',
        dependsOn: ['fetch'],
        orderingOnlyDeps: ['fetch'],
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.ok(
    result.warnings.some((warning) => /orderingOnlyDeps/.test(warning) && /deprecated/i.test(warning)),
    `expected orderingOnlyDeps deprecation warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('missing usesSkill reference → warning', () => {
  const result = validateWorkflowDefinition({
    name: 'wf',
    description: 'Workflow with a skill binding',
    steps: [
      { id: 'build', prompt: 'Build the proposal.', usesSkill: 'proposal-builder' },
    ],
  }, { installedSkillNames: new Set(['other-skill']) });

  assert.ok(
    result.warnings.some((warning) => warning.includes('missing skill "proposal-builder"')),
    `expected missing-skill warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('multi-item prose does not invent a required forEach rewrite', () => {
  const result = validateWorkflowDefinition({
    name: 'wf',
    description: 'Workflow that should fan out',
    steps: [
      { id: 'enrich', prompt: 'For each of the 20 sites, scrape and audit the SEO signals.' },
    ],
  });

  assert.ok(
    !result.warnings.some((warning) => warning.includes('has no forEach')),
    `unexpected inferred forEach warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('parallelism hint: top-N summaries and row bookkeeping are not fanout advisories', () => {
  const result = validateWorkflowDefinition({
    name: 'wf',
    description: 'Workflow with ordinary summary/setup work',
    steps: [
      {
        id: 'brief',
        prompt: 'Summarize the top 1-3 active goals and their next actions, then write a concise morning briefing.',
      },
      {
        id: 'tracker',
        prompt: 'Read only the header row, then read existing data rows in small batches. For each returned data row, compute and preserve its actual Google Sheet row number.',
      },
    ],
  });

  assert.ok(
    !result.warnings.some((warning) => warning.includes('has no forEach')),
    `expected no forEach warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('parallelism hint: aggregate draft artifacts are not fanout advisories', () => {
  const result = validateWorkflowDefinition({
    name: 'wf',
    description: 'Workflow that drafts a batch artifact',
    steps: [
      {
        id: 'draft_outreach',
        prompt: 'Draft prospect outreach for each selected account and return a single artifact path and URL for review.',
        output: {
          type: 'object',
          required_keys: ['url', 'path'],
          verify: { url_present: ['url'], path_exists: ['path'] },
        },
      },
    ],
  });

  assert.ok(
    !result.warnings.some((warning) => warning.includes('has no forEach')),
    `expected no forEach warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('parallelism hint: shared tracker batch writes with aggregate outputs are not fanout advisories', () => {
  const result = validateWorkflowDefinition({
    name: 'wf',
    description: 'Workflow that updates the shared tracker in one batch',
    steps: [
      {
        id: 'write_drafts_to_sheet',
        prompt: 'Write each draft back into that account\'s existing tracker row. If test_mode is true, return a preview of the exact row updates that would be made.',
        output: {
          type: 'object',
          required_keys: ['url', 'path', 'accounts'],
          non_empty: ['accounts'],
          min_items: { accounts: 1 },
          verify: { url_present: ['url'], path_exists: ['path'] },
        },
        sideEffect: 'write',
      },
    ],
  });

  assert.ok(
    !result.warnings.some((warning) => warning.includes('has no forEach')),
    `expected no forEach warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('routine validation does not prescribe topology or output contracts from prose', () => {
  for (const prompt of [
    'For each of the 20 sites, scrape and audit the SEO signals.',
    'Generate the competitive SEO brief and save it to an HTML file.',
    'Draft a short status summary. Do not send, publish, or take any other action.',
  ]) {
    const definition: WorkflowFrontmatter = { name: 'authored-job', steps: [{ id: 'work', prompt, sideEffect: 'read' }] };
    const before = JSON.stringify(definition);
    const result = validateWorkflowDefinition(definition);
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.doesNotMatch(result.warnings.join('\n'), /forEach rewrite|has no forEach|run_worker is not|output contract|path_exists|url_present|no pinned `goal`/);
    assert.equal(JSON.stringify(definition), before);
  }
});

test('deliverable step WITH an output contract → no advisory', () => {
  const result = validateWorkflowDefinition({
    name: 'wf',
    description: 'Workflow that builds a report with a declared contract',
    steps: [
      {
        id: 'build',
        prompt: 'Generate the competitive SEO brief and save it to an HTML file.',
        output: { verify: { path_exists: ['path'] } },
      },
    ],
  });
  assert.ok(
    !result.warnings.some((w) => /output contract/i.test(w)),
    `expected NO output-contract advisory once declared, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('non-deliverable step → no output-contract advisory (precision guard)', () => {
  const result = validateWorkflowDefinition({
    name: 'wf',
    description: 'Workflow that just reads',
    steps: [
      { id: 'check', prompt: 'Summarize how many unread messages are in the inbox.' },
    ],
  });
  assert.ok(
    !result.warnings.some((w) => /output contract/i.test(w)),
    `a pure read should not be nudged, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('forEach + deterministic steps are exempt from the output-contract advisory', () => {
  const forEach = validateWorkflowDefinition({
    name: 'wf',
    description: 'fan-out',
    steps: [
      { id: 'list', prompt: 'List the prospects.' },
      { id: 'each', prompt: 'Generate and save a brief file.', forEach: 'list' },
    ],
  });
  assert.ok(!forEach.warnings.some((w) => /output contract/i.test(w)), 'forEach wrapper exempt');
  const det = validateWorkflowDefinition({
    name: 'wf2',
    description: 'deterministic',
    steps: [
      { id: 'gen', prompt: 'Generate and save the report file.', deterministic: { runner: 'scripts/gen.py' } },
    ],
  });
  assert.ok(!det.warnings.some((w) => /output contract/i.test(w)), 'deterministic step exempt');
});

test('routine validation leaves output cardinality and goal selection with the author', () => {
  for (const prompt of [
    'Build an HTML file, deploy it, and return the live URL and saved path.',
    'Generate the list of overdue meetings and output the rows.',
    'Return the final report URL and saved HTML path.',
  ]) {
    const result = validateWorkflowDefinition({ name: 'optional-contracts',
      synthesis: { prompt }, steps: [{ id: 'work', prompt }] });
    assert.doesNotMatch(result.warnings.join('\n'), /url_present|path_exists|non_empty|min_items|no pinned `goal`/);
  }
});

test('deliverable workflow with a pinned goal suppresses goal-loop advisory', () => {
  const result = validateWorkflowDefinition({
    name: 'wf',
    description: 'Workflow that builds a report',
    goal: { objective: 'Publish a verified client audit report.' },
    steps: [
      { id: 'build', prompt: 'Generate the client audit report and save it to an HTML file.' },
    ],
  });
  assert.ok(
    !result.warnings.some((w) => /no pinned `goal`/.test(w)),
    `expected no pinned goal advisory, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('deterministic config without runner → warning', () => {
  const result = validateWorkflowDefinition({
    name: 'wf',
    description: 'Workflow with bad deterministic config',
    steps: [
      { id: 'script', prompt: 'Run the helper.', deterministic: {} },
    ],
  });

  assert.ok(
    result.warnings.some((warning) => warning.includes('deterministic config but no runner')),
    `expected deterministic warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('owner-authored deterministic runners and loop probes validate (reinstated 2026-09-01)', () => {
  const deterministic = validateWorkflowDefinition({
    name: 'owner-deterministic-shape',
    description: 'Run the local helper.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'run_script', prompt: '', sideEffect: 'read', deterministic: { runner: 'scripts/run.mjs' } }],
  });
  assert.deepEqual(deterministic.errors, [], deterministic.errors.join('\n'));
  const loopProbe = validateWorkflowDefinition({
    name: 'owner-loop-probe-shape',
    description: 'Poll the current job state.',
    enabled: true,
    trigger: { manual: true },
    steps: [{
      id: 'poll',
      prompt: 'Read the current job state.',
      sideEffect: 'read',
      loopUntil: { probe: { runner: 'probe.mjs' }, until: { type: 'object', required_keys: ['done'] } },
    }],
  });
  assert.deepEqual(loopProbe.errors.filter((error) => /raw_subprocess|retired/i.test(error)), []);
  // The path rules still hold: outside scripts/ or with inline arguments is an error.
  const escape = validateWorkflowDefinition({
    name: 'escape-shape', description: 'x', enabled: true, trigger: { manual: true },
    steps: [{ id: 'run_script', prompt: '', sideEffect: 'read', deterministic: { runner: '../run.mjs' } }],
  });
  assert.equal(escape.ok, false);
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
    Surface the drafts to Alex with \`notify_user\`. Do NOT call \`OUTLOOK_SEND_EMAIL\` yet — that's gated behind explicit approval.

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

// ── Autonomous-by-default model: declarative approval gate ────────────

test('in-step request_approval (no gate) → warns to use requiresApproval', () => {
  const result = validateWorkflowDefinition({
    name: 'legacy-approval',
    steps: [
      { id: 'send', prompt: 'Draft the emails then call request_approval. After approval, call OUTLOOK_SEND for each row.' },
    ],
  });
  assert.ok(
    result.warnings.some((w) => /requiresApproval/i.test(w) && /declarative gate/i.test(w)),
    `expected a nudge toward requiresApproval; got: ${JSON.stringify(result.warnings)}`,
  );
});

test('declarative gate (requiresApproval) suppresses the request_approval error/nudge', () => {
  const result = validateWorkflowDefinition({
    name: 'gated',
    steps: [
      {
        id: 'send',
        prompt: 'This step is gated by the runner; you do not request_approval yourself. Send the approved emails.',
        requiresApproval: true,
      },
    ],
  });
  assert.equal(result.ok, true, `expected ok; errors: ${JSON.stringify(result.errors)}`);
  assert.ok(!result.warnings.some((w) => /requiresApproval/i.test(w)), 'gated step must not be nudged');
});

test('snake_case requires_approval is honored too', () => {
  const result = validateWorkflowDefinition({
    name: 'gated-snake',
    steps: [
      { id: 'send', prompt: 'Gated send; runner owns request_approval.', requires_approval: true },
    ],
  });
  assert.deepEqual(result.errors, []);
});

// ── Typed-contract template-token checks (P1) ─────────────────────────

test('unrecognized bare token {{url}} is flagged (the missing-artifact-audit bug)', () => {
  const result = validateWorkflowDefinition({
    name: 'typo',
    steps: [{ id: 'normalize', prompt: 'Normalize the prospect URL {{url}}.' }],
  });
  assert.ok(
    result.errors.some((e) => /\{\{url\}\}/.test(e) && /input\.url/.test(e)),
    `expected a malformed-token error suggesting {{input.url}}; got ${JSON.stringify(result.errors)}`,
  );
});

test('a known token {{input.url}} with a common key validates clean', () => {
  const result = validateWorkflowDefinition({
    name: 'ok',
    steps: [{ id: 'normalize', prompt: 'Normalize the prospect URL {{input.url}}.' }],
  });
  assert.ok(!result.errors.some((e) => /template token|input\./.test(e)), JSON.stringify(result.errors));
});

test('common input {{input.url}} without workflow input declaration gets metadata advisory', () => {
  const result = validateWorkflowDefinition({
    name: 'implicit-url',
    description: 'Workflow that audits a site',
    steps: [{ id: 'audit', prompt: 'Run the site audit for {{input.url}}.' }],
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.ok(
    result.warnings.some((w) => /common input \{\{input\.url\}\}/.test(w) && /dashboard/.test(w)),
    `expected declaration advisory, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('{{input.X}} with no declared/common binding is flagged', () => {
  const result = validateWorkflowDefinition({
    name: 'unbound',
    steps: [{ id: 's', prompt: 'Use {{input.spreadsheetId}} to write rows.' }],
  });
  assert.ok(result.errors.some((e) => /spreadsheetId/.test(e) && /declare/i.test(e)), JSON.stringify(result.errors));
});

test('{{input.X}} declared in workflow inputs validates clean', () => {
  const result = validateWorkflowDefinition({
    name: 'declared',
    inputs: { spreadsheetId: { type: 'string' } },
    steps: [{ id: 's', prompt: 'Use {{input.spreadsheetId}}.' }],
  });
  assert.ok(!result.errors.some((e) => /spreadsheetId/.test(e)), JSON.stringify(result.errors));
});

test('{{input.X}} declared on the STEP validates clean', () => {
  const result = validateWorkflowDefinition({
    name: 'step-declared',
    steps: [{ id: 's', prompt: 'Use {{input.sheet}}.', inputs: { sheet: { type: 'string' } } }],
  });
  assert.ok(!result.errors.some((e) => /sheet/.test(e)), JSON.stringify(result.errors));
});

test('synthesis {{input.X}} with no declared/common binding is flagged', () => {
  const result = validateWorkflowDefinition({
    name: 'synth-unbound',
    description: 'Workflow with synthesis',
    steps: [{ id: 's', prompt: 'Produce source data.' }],
    synthesis: { prompt: 'Summarize the run for {{input.spreadsheetId}}.' },
  });
  assert.ok(
    result.errors.some((e) => /Synthesis prompt/.test(e) && /spreadsheetId/.test(e)),
    JSON.stringify(result.errors),
  );
});

test('synthesis common input {{input.url}} gets declaration advisory', () => {
  const result = validateWorkflowDefinition({
    name: 'synth-url',
    description: 'Workflow with synthesis',
    steps: [{ id: 's', prompt: 'Produce source data.' }],
    synthesis: { prompt: 'Summarize the audit for {{input.url}}.' },
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.ok(
    result.warnings.some((w) => /Synthesis prompt/.test(w) && /input\.url/.test(w)),
    `expected synthesis input advisory, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('{{steps.X.output}} and {{item}} tokens are not flagged as malformed', () => {
  const result = validateWorkflowDefinition({
    name: 'tokens',
    steps: [
      { id: 'a', prompt: 'produce data' },
      { id: 'b', prompt: 'consume {{steps.a.output}} and {{item}} and {{item.id}} and {{date}}', dependsOn: ['a'] },
    ],
  });
  assert.ok(!result.errors.some((e) => /unrecognized template token/.test(e)), JSON.stringify(result.errors));
});

test('literal {{...}} ellipsis in prompt documentation is NOT flagged (no false positive)', () => {
  const result = validateWorkflowDefinition({
    name: 'doc',
    steps: [{ id: 'validate', prompt: 'Reject placeholder tokens like {{...}}, TODO, or [insert].' }],
  });
  assert.ok(!result.errors.some((e) => /unrecognized template token/.test(e)), JSON.stringify(result.errors));
});

// ── Feature A: remembered tool-choice binding WARNING (advisory, never blocks) ──

import type { ToolChoiceRecord } from '../memory/tool-choice-store.js';

function sfCliChoice(): ToolChoiceRecord {
  return {
    intent: 'salesforce.cli.query',
    description: 'Run a SOQL query against Salesforce via the sf CLI',
    choice: { kind: 'cli', identifier: 'sf', invocationTemplate: 'sf data query --json --query "{{soql}}"', testedAt: '2026-06-01T00:00:00Z' },
    fallbacks: [],
    body: '',
    filePath: '/tmp/sf.md',
  };
}

test('validation cannot upgrade remembered capability overlap into required binding', () => {
  const wf: WorkflowFrontmatter = {
    name: 'sf-flow',
    description: 'Query Salesforce and add prospects to Airtable.',
    enabled: true,
    steps: [
      { id: 'find', prompt: 'Query Salesforce for new prospect accounts via a SOQL query.', allowedTools: ['composio_execute_tool'] },
    ],
  };
  const result = validateWorkflowDefinition(wf, { rememberedToolChoices: [sfCliChoice()] });
  assert.equal(result.ok, true, 'binding mismatch is advisory — never blocks the write');
  assert.equal(result.warnings.some((w) => /proven .*sf data query|Bake|set allowedTools/.test(w)), false, 'memory overlap is not a validation requirement');
});

test('binding warning: a step already bound (or locked off composio) does NOT warn', () => {
  const bound: WorkflowFrontmatter = {
    name: 'sf-flow',
    description: 'Query Salesforce.',
    enabled: true,
    steps: [
      { id: 'find', prompt: 'Query Salesforce: run `sf data query --json --query "SELECT Id FROM Account"`.', allowedTools: ['run_shell_command'] },
    ],
  };
  const r1 = validateWorkflowDefinition(bound, { rememberedToolChoices: [sfCliChoice()] });
  assert.ok(!r1.warnings.some((w) => /proven .*sf data query/.test(w)));

  const lockedOff: WorkflowFrontmatter = {
    name: 'sf-flow',
    description: 'Query Salesforce.',
    enabled: true,
    steps: [
      { id: 'find', prompt: 'Query Salesforce for new prospect accounts via a SOQL query.', allowedTools: ['run_shell_command'] },
    ],
  };
  const r2 = validateWorkflowDefinition(lockedOff, { rememberedToolChoices: [sfCliChoice()] });
  assert.ok(!r2.warnings.some((w) => /proven .*sf data query/.test(w)), 'no composio in scope → no drift → no warning');
});

test('binding warning: no remembered choices → no binding warning (byte-identical)', () => {
  const wf: WorkflowFrontmatter = {
    name: 'sf-flow',
    description: 'Query Salesforce for prospects.',
    enabled: true,
    steps: [{ id: 'find', prompt: 'Query Salesforce for new prospect accounts via a SOQL query.', allowedTools: ['composio_execute_tool'] }],
  };
  const result = validateWorkflowDefinition(wf);
  assert.ok(!result.warnings.some((w) => /proven/.test(w)));
});

test('binding warning: placeholder remembered choices never render Bake `null` guidance', () => {
  const wf: WorkflowFrontmatter = {
    name: 'airtable-flow',
    description: 'List Airtable records for prospects.',
    enabled: true,
    steps: [{ id: 'list', prompt: 'List Airtable records for the prospects table.', allowedTools: ['composio_execute_tool'] }],
  };
  const placeholder: ToolChoiceRecord = {
    intent: 'airtable.records.list',
    description: 'List Airtable records for a table',
    choice: { kind: 'mcp', identifier: 'null', invocationTemplate: 'null', testedAt: '2026-06-01T00:00:00Z' },
    fallbacks: [],
    body: '',
    filePath: '/tmp/null-choice.md',
  };
  const result = validateWorkflowDefinition(wf, { rememberedToolChoices: [placeholder] });
  assert.equal(result.ok, true);
  assert.ok(!result.warnings.some((w) => /Bake `null`|proven mcp `null`/.test(w)), result.warnings.join('\n'));
});

test('binding warning: mixed Composio step may keep native MCP when family is already scoped and named', () => {
  const wf: WorkflowFrontmatter = {
    name: 'seo-airtable-flow',
    description: 'Enrich prospect and update Airtable.',
    enabled: true,
    steps: [{
      id: 'enrich',
      prompt: 'Use DataForSEO for ranked keywords, then update the Airtable record with the findings.',
      allowedTools: ['composio_execute_tool', 'dataforseo__dataforseo_labs_google_ranked_keywords'],
    }],
  };
  const mcpChoice: ToolChoiceRecord = {
    intent: 'dataforseo ranked keywords domain',
    description: 'Use native DataForSEO ranked keywords.',
    choice: { kind: 'mcp', identifier: 'dataforseo__dataforseo_labs_google_ranked_keywords', testedAt: '2026-06-01T00:00:00Z' },
    fallbacks: [],
    body: '',
    filePath: '/tmp/dataforseo.md',
  };
  const result = validateWorkflowDefinition(wf, { rememberedToolChoices: [mcpChoice] });
  assert.equal(result.ok, true);
  assert.ok(!result.warnings.some((w) => /drift onto a stale path/.test(w)), result.warnings.join('\n'));
});

test('sideEffect coherence: warns when declared class is weaker than the prompt', () => {
  const readDeclaredSend = validateWorkflowDefinition({
    name: 'side-effect-read-send',
    description: 'Bad side effect declaration.',
    enabled: true,
    steps: [{ id: 'send', prompt: 'Send the email summary to Alex.', sideEffect: 'read' }],
  });
  assert.ok(readDeclaredSend.warnings.some((w) => /declares sideEffect: read/.test(w) && /SEND/.test(w)), readDeclaredSend.warnings.join('\n'));

  const writeDeclaredSendSnake = validateWorkflowDefinition({
    name: 'side-effect-write-send',
    description: 'Snake case side effect declaration.',
    enabled: true,
    steps: [{ id: 'post', prompt: 'Publish the Instagram post for the firm.', side_effect: 'write' }],
  });
  assert.ok(writeDeclaredSendSnake.warnings.some((w) => /declares sideEffect: write/.test(w) && /SEND/.test(w)), writeDeclaredSendSnake.warnings.join('\n'));
});

test('sideEffect coherence: configured OWNER_NAME aliases identify direct sends', () => {
  const originalOwnerName = process.env.OWNER_NAME;
  process.env.OWNER_NAME = 'Jordan Kim';
  try {
    const result = validateWorkflowDefinition({
      name: 'configured-owner-send',
      description: 'Deliver a report to the configured user.',
      enabled: true,
      steps: [{ id: 'send', prompt: 'Email Jordan the completed report.', sideEffect: 'read' }],
    });
    assert.ok(
      result.warnings.some((warning) => /declares sideEffect: read/.test(warning) && /SEND/.test(warning)),
      result.warnings.join('\n'),
    );
  } finally {
    if (originalOwnerName === undefined) delete process.env.OWNER_NAME;
    else process.env.OWNER_NAME = originalOwnerName;
  }
});

test('sideEffect coherence: clear imperative sends to external named recipients are SEND', () => {
  for (const prompt of [
    'Email Riley the completed report.',
    'Email Riley Morgan the completed report.',
    'Send Riley the completed report.',
    'Message the completed report to Riley.',
  ]) {
    const result = validateWorkflowDefinition({
      name: 'external-named-send',
      description: 'Deliver a report to an external recipient.',
      enabled: true,
      steps: [{ id: 'send', prompt, sideEffect: 'read' }],
    });
    assert.ok(
      result.warnings.some((warning) => /declares sideEffect: read/.test(warning) && /SEND/.test(warning)),
      `${prompt}: ${result.warnings.join('\n')}`,
    );
  }
});

test('sideEffect coherence: email/message analysis remains read-only', () => {
  const result = validateWorkflowDefinition({
    name: 'communication-analysis',
    description: 'Analyze communication patterns.',
    enabled: true,
    steps: [{
      id: 'analyze',
      prompt: 'Analyze email trends and message frequency, then summarize the findings.',
      sideEffect: 'read',
    }],
  });
  assert.ok(!result.warnings.some((warning) => /declares sideEffect/.test(warning)), result.warnings.join('\n'));
});

test('sideEffect coherence: read-only social post analysis is not mistaken for publishing', () => {
  const result = validateWorkflowDefinition({
    name: 'post-analysis',
    description: 'Analyze public social posts.',
    enabled: true,
    steps: [{
      id: 'analyze',
      prompt: 'Scrape recent public posts from the Acme Facebook page and analyze the post themes.',
      sideEffect: 'read',
    }],
  });
  assert.ok(!result.warnings.some((w) => /declares sideEffect/.test(w)), result.warnings.join('\n'));
  assert.ok(!result.warnings.some((w) => /has no forEach/.test(w)), result.warnings.join('\n'));
});

test('sideEffect coherence: explicit do-not-send boundaries are not treated as SEND actions', () => {
  const result = validateWorkflowDefinition({
    name: 'draft-only-digest',
    description: 'Draft a digest without sending.',
    enabled: true,
    steps: [{
      id: 'draft_summary',
      prompt: 'Compose a digest draft. This is a DRAFT only — do NOT send, post, email, or call any external tool. Output the digest text only.',
      sideEffect: 'read',
    }],
  });
  assert.ok(!result.warnings.some((w) => /declares sideEffect/.test(w)), result.warnings.join('\n'));
});

test('sideEffect coherence: email/contact data fields are not mistaken for SEND actions', () => {
  const result = validateWorkflowDefinition({
    name: 'contact-selection',
    description: 'Select outreach candidates.',
    enabled: true,
    steps: [{
      id: 'select_candidates',
      prompt: 'Select accounts eligible to email today. Return accountId, bestContactEmail, Last Email Sent At, Email Status, and skip reasons. If no rows qualify, there is nothing to send.',
      sideEffect: 'read',
    }],
  });
  assert.ok(!result.warnings.some((w) => /declares sideEffect/.test(w)), result.warnings.join('\n'));
});

test('sideEffect coherence: downstream send/write planning language is not the current step action', () => {
  const result = validateWorkflowDefinition({
    name: 'tracker-read',
    description: 'Read state and mark downstream mode.',
    enabled: true,
    steps: [{
      id: 'read_tracker',
      prompt: 'Read the tracker rows and return current state. If input.test_mode is true, explicitly mark all downstream write/send/draft steps as preview-only unless the user separately approves live writes.',
      sideEffect: 'read',
    }],
  });
  assert.ok(!result.warnings.some((w) => /declares sideEffect/.test(w)), result.warnings.join('\n'));
});

test('sideEffect coherence: risk-class planning labels do not make a READ planning step look mutating', () => {
  const result = validateWorkflowDefinition({
    name: 'objective-planner',
    description: 'Plan work safely.',
    enabled: true,
    steps: [{
      id: 'operating_plan',
      prompt: 'Classify each item: risk_class "read" for research. risk_class "write" for internal drafts, files, records, or task updates. risk_class "send" for externally visible messaging. Return JSON only with work_items.',
      sideEffect: 'read',
    }],
  });
  assert.ok(!result.warnings.some((w) => /declares sideEffect/.test(w)), result.warnings.join('\n'));
});

// ── forEach target validation (2026-06-03: silent zero-work fan-out) ──

test('forEach pointing at an unknown step → error', () => {
  const result = validateWorkflowDefinition({
    name: 'fe-unknown',
    description: 'Fan out over a missing step.',
    enabled: true,
    steps: [{ id: 'enrich', prompt: 'Enrich each item.', forEach: 'nope' }],
  });
  assert.ok(result.errors.some((e) => /forEach/.test(e) && /no such step/.test(e)));
});

test('forEach on a step that does not depend on the source → error', () => {
  const result = validateWorkflowDefinition({
    name: 'fe-nodep',
    description: 'Fan out over a non-dependency.',
    enabled: true,
    steps: [
      { id: 'pull', prompt: 'Pull the list of prospects.' },
      { id: 'enrich', prompt: 'Enrich each item.', forEach: 'pull' },
    ],
  });
  assert.ok(result.errors.some((e) => /fans out over "pull"/.test(e) && /does not depend/.test(e)));
});

test('forEach over a declared dependency → ok', () => {
  const result = validateWorkflowDefinition({
    name: 'fe-ok',
    description: 'Fan out over a dependency.',
    enabled: true,
    steps: [
      { id: 'pull', prompt: 'Pull the list of prospects.' },
      { id: 'enrich', prompt: 'Enrich each item.', dependsOn: ['pull'], forEach: 'pull' },
    ],
  });
  assert.ok(!result.errors.some((e) => /forEach|fans out/.test(e)));
});

test('forEach over a declared dependency output path → ok', () => {
  const result = validateWorkflowDefinition({
    name: 'fe-path-ok',
    description: 'Fan out over a dependency output path.',
    enabled: true,
    steps: [
      { id: 'pull', prompt: 'Pull the list of prospects.' },
      { id: 'enrich', prompt: 'Enrich each item.', dependsOn: ['pull'], forEach: '{{steps.pull.output.prospects}}' },
    ],
  });
  assert.ok(!result.errors.some((e) => /forEach|fans out/.test(e)), result.errors.join('\n'));
});

// ── {{steps.X.output}} must reference a dependency ───────────────────

test('forEach over a declared JSON-list workflow input → ok; undeclared input refuses', () => {
  const valid = validateWorkflowDefinition({
    name: 'fe-input-ok',
    description: 'Fan out over a declared workflow input.',
    enabled: true,
    inputs: { competitors: { type: 'string', default: '[{"name":"A"}]' } },
    steps: [{ id: 'research', prompt: 'Research each competitor.', forEach: 'input.competitors' }],
  });
  assert.ok(!valid.errors.some((error) => /forEach/.test(error)), valid.errors.join('\n'));

  const missing = validateWorkflowDefinition({
    name: 'fe-input-missing',
    description: 'Reject undeclared workflow input.',
    enabled: true,
    steps: [{ id: 'research', prompt: 'Research each competitor.', forEach: '{{input.competitors}}' }],
  });
  assert.match(missing.errors.join(' '), /workflow input "competitors" is not declared/);

  const promptlessExactRead = validateWorkflowDefinition({
    name: 'fe-input-call-missing',
    description: 'Promptless exact reads use the same fan-out source contract.',
    enabled: true,
    steps: [{
      id: 'lookup',
      prompt: '',
      sideEffect: 'read',
      forEach: 'input.ids',
      call: { tool: 'CRM_GET_RECORD', args: { id: '{{item.id}}' } },
    }],
  });
  assert.match(promptlessExactRead.errors.join(' '), /workflow input "ids" is not declared/);
});

test('steps.X.output referencing a non-dependency step → error', () => {
  const result = validateWorkflowDefinition({
    name: 'ref-nodep',
    description: 'Reference a step that is not a dependency.',
    enabled: true,
    steps: [
      { id: 'a', prompt: 'Produce some data.' },
      { id: 'b', prompt: 'Use {{steps.a.output}} to do work.' },
    ],
  });
  assert.ok(result.errors.some((e) => /steps\.a\.output/.test(e) && /not one of its dependencies/.test(e)));
});

test('steps.X.output referencing a declared dependency → ok', () => {
  const result = validateWorkflowDefinition({
    name: 'ref-dep',
    description: 'Reference a declared dependency.',
    enabled: true,
    steps: [
      { id: 'a', prompt: 'Produce some data.' },
      { id: 'b', prompt: 'Use {{steps.a.output}} to do work.', dependsOn: ['a'] },
    ],
  });
  assert.ok(!result.errors.some((e) => /steps\.a\.output/.test(e)));
});

test('steps.X.output referencing a nonexistent step → error (distinct message)', () => {
  const result = validateWorkflowDefinition({
    name: 'ref-missing',
    description: 'Reference a step that does not exist.',
    enabled: true,
    steps: [
      { id: 'b', prompt: 'Use {{steps.ghost.output}} to do work.' },
    ],
  });
  assert.ok(result.errors.some((e) => /steps\.ghost\.output/.test(e) && /no step has that id/.test(e)));
});

test('steps.X.output via transitive dependency → ok', () => {
  const result = validateWorkflowDefinition({
    name: 'ref-transitive',
    description: 'Reference a transitive dependency.',
    enabled: true,
    steps: [
      { id: 'a', prompt: 'Produce some data.' },
      { id: 'b', prompt: 'Process it.', dependsOn: ['a'] },
      { id: 'c', prompt: 'Use {{steps.a.output}} again.', dependsOn: ['b'] },
    ],
  });
  assert.ok(!result.errors.some((e) => /steps\.a\.output/.test(e)));
});

// ---------------------------------------------------------------------------
// CALL-3 (2026-07-20 attorney-bar audit A1): the "internal builder error"
// class — a call node that saves green and fails on first dispatch.
// ---------------------------------------------------------------------------
import { checkCallNode } from './workflow-validator.js';
import { rememberToolSchema, resetToolSchemaCache } from '../tools/composio-schema-cache.js';

test('CALL-3: a malformed call.tool is a hard ERROR (deterministic evidence)', () => {
  const bad = checkCallNode({ id: 's1', call: { tool: 'send the email please', args: {} } }, undefined);
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /not a valid tool reference/);
  const empty = checkCallNode({ id: 's1', call: { tool: '', args: {} } }, undefined);
  assert.deepEqual(empty.errors, [], 'CALL-1 owns the missing-tool error');
});

test('CALL-3: missing required args vs the REAL cached schema is a hard ERROR', () => {
  resetToolSchemaCache();
  rememberToolSchema('GMAIL_SEND_EMAIL', { type: 'object', required: ['recipient_email', 'body'], properties: {} });
  try {
    const bad = checkCallNode({ id: 's1', call: { tool: 'GMAIL_SEND_EMAIL', args: { body: 'hi' } } }, undefined);
    assert.equal(bad.errors.length, 1);
    assert.match(bad.errors[0], /recipient_email/);
    const good = checkCallNode({ id: 's1', call: { tool: 'GMAIL_SEND_EMAIL', args: { recipient_email: '{{item.email}}', body: 'hi' } } }, undefined);
    assert.deepEqual(good.errors, [], 'templated args count as present — presence-only check');
  } finally {
    resetToolSchemaCache();
  }
});

test('CALL-3: an unverifiable Composio slug only WARNS (fail-open when the cache has no evidence)', () => {
  resetToolSchemaCache();
  const res = checkCallNode({ id: 's1', call: { tool: 'GMAIL_SEND_MAIL_TYPO', args: {} } }, new Set(['memory_read']));
  assert.deepEqual(res.errors, [], 'absence of evidence never hard-blocks');
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /can't be verified/);
});

test('CALL-3: a known local tool passes clean; cx_ aliases pass shape', () => {
  const local = checkCallNode({ id: 's1', call: { tool: 'run_shell_command', args: {} } }, new Set(['run_shell_command']));
  assert.deepEqual([local.errors, local.warnings], [[], []]);
  const cx = checkCallNode({ id: 's1', call: { tool: 'cx_gmail_send_email', args: {} } }, undefined);
  assert.deepEqual(cx.errors, []);
});

test('CALL-3 is wired into validateWorkflowDefinition (the agent save path)', () => {
  resetToolSchemaCache();
  const def = {
    name: 'call3-wire', description: 'x', trigger: {},
    steps: [{ id: 'a', prompt: 'do it', call: { tool: 'total nonsense slug', args: {} } }],
  } as unknown as WorkflowFrontmatter;
  const res = validateWorkflowDefinition(def, {});
  assert.ok(res.errors.some((e) => /not a valid tool reference/.test(e)), 'the builder-error class is now un-saveable');
});

test('read_parallel_v1 accepts 2-6 explicit read-only specialists', () => {
  const res = validateWorkflowDefinition({
    name: 'parallel-read',
    description: 'Analyze evidence with independent specialist branches.',
    enabled: true,
    steps: [{
      id: 'analyze',
      prompt: 'Reduce all specialist evidence into one concise result.',
      sideEffect: 'read',
      subgraph: {
        mode: 'read_parallel_v1',
        specialists: [
          { id: 'facts', prompt: 'Check factual support.' },
          { id: 'risks', prompt: 'Check risks and contradictions.', maxTurns: 6 },
        ],
      },
    }],
  });
  assert.equal(res.ok, true, res.errors.join('; '));
});

test('read_parallel_v1 refuses write/send authority and incompatible executors', () => {
  const res = validateWorkflowDefinition({
    name: 'unsafe-parallel',
    description: 'An invalid mutating specialist graph.',
    enabled: true,
    steps: [{
      id: 'send',
      prompt: 'Send the joined result.',
      sideEffect: 'send',
      requiresApproval: true,
      subgraph: {
        mode: 'read_parallel_v1',
        specialists: [
          { id: 'same', prompt: 'First branch.' },
          { id: 'same', prompt: 'Second branch.' },
        ],
      },
    }],
  });
  assert.ok(res.errors.some((error) => /must explicitly declare sideEffect: read/i.test(error)));
  assert.ok(res.errors.some((error) => /cannot combine with requiresApproval/i.test(error)));
  assert.ok(res.errors.some((error) => /duplicate subgraph specialist id/i.test(error)));
});
