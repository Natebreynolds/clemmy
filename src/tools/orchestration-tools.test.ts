/**
 * Run: npx tsx --test src/tools/orchestration-tools.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-orchestration-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

import type { ToolChoiceRecord } from '../memory/tool-choice-store.js';
const { registerOrchestrationTools, renderAuthoringAdvisories, bindStepsToToolChoices, draftToDefinition, commitAuthoredWorkflow, bindDiscussedToolkitsIntoSteps, autoTagStepsWithModelRoleIntents } = await import('./orchestration-tools.js');
const { traceToWorkflowDraft } = await import('../execution/trace-to-workflow.js');
const { writeWorkflow, readWorkflow } = await import('../memory/workflow-store.js');
const { fireWorkflowSystemEvent } = await import('../execution/workflow-trigger-engine.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('./shared.js');

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const handlers = new Map<string, ToolHandler>();
registerOrchestrationTools({
  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    handlers.set(name, handler);
  },
} as never);

function resetState(): void {
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
}

function workflowRun(): ToolHandler {
  const handler = handlers.get('workflow_run');
  assert.ok(handler, 'workflow_run registered');
  return handler;
}

function workflowCreate(): ToolHandler {
  const handler = handlers.get('workflow_create');
  assert.ok(handler, 'workflow_create registered');
  return handler;
}

function workflowUpdate(): ToolHandler {
  const handler = handlers.get('workflow_update');
  assert.ok(handler, 'workflow_update registered');
  return handler;
}

function workflowContractProposals(): ToolHandler {
  const handler = handlers.get('workflow_contract_proposals');
  assert.ok(handler, 'workflow_contract_proposals registered');
  return handler;
}

function resultText(result: ToolResult): string {
  return result.content.map((item) => item.text).join('\n');
}

function withEnv(over: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> | void {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(over)) {
    prev[key] = process.env[key];
    if (over[key] === undefined) delete process.env[key];
    else process.env[key] = over[key];
  }
  const restore = (): void => {
    for (const key of Object.keys(over)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  };
  try {
    const out = fn();
    if (out && typeof (out as Promise<void>).then === 'function') return (out as Promise<void>).finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

function writeAuditWorkflow(): void {
  writeWorkflow('proposal-audit-brief', {
    name: 'proposal-audit-brief',
    description: 'Generate an audit brief from a URL.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      {
        id: 'normalize_input',
        prompt: 'Normalize the prospect. Required input: {{url}}. If missing, stop with status=blocked.',
      },
    ],
  });
}

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  resetState();
});

test('workflow_run rejects missing required legacy template inputs without queueing', async () => {
  writeAuditWorkflow();

  // New contract: inputs is a JSON STRING (mirrors composio arguments).
  const result = await workflowRun()({ name: 'proposal-audit-brief', inputs: '{}' });
  const text = resultText(result);

  assert.match(text, /was not queued/);
  assert.match(text, /"url"/);
  assert.throws(() => readdirSync(WORKFLOW_RUNS_DIR), /ENOENT/);
});

test('workflow_run rejects malformed inputs JSON without queueing', async () => {
  writeAuditWorkflow();

  const result = await workflowRun()({ name: 'proposal-audit-brief', inputs: '{url: not json}' });
  const text = resultText(result);

  assert.match(text, /invalid workflow inputs json/i);
  assert.throws(() => readdirSync(WORKFLOW_RUNS_DIR), /ENOENT/);
});

test('workflow_run queues with normalized URL aliases', async () => {
  writeAuditWorkflow();

  const result = await workflowRun()({
    name: 'proposal-audit-brief',
    inputs: JSON.stringify({ website: ' https://www.aldouslaw.com/ ' }),
  });
  const text = resultText(result);

  assert.match(text, /Queued "proposal-audit-brief"/);
  const files = readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json'));
  assert.equal(files.length, 1);
  const run = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, files[0]), 'utf-8')) as {
    inputs: Record<string, string>;
  };
  assert.equal(run.inputs.url, 'https://www.aldouslaw.com/');
  assert.equal(run.inputs.website, 'https://www.aldouslaw.com/');
});

test('workflow_create accepts an inputs SCHEMA as a JSON string and persists it', async () => {
  // New contract: workflow_create/_update `inputs` is a JSON STRING (the open
  // z.record map filled {} under strict mode). The model authors the schema as
  // a JSON object string; the handler parses it into def.inputs.
  const result = await workflowCreate()({
    name: 'audit-wf',
    description: 'Audit a site.',
    steps: [{ id: 'normalize', prompt: 'Normalize {{input.url}}.' }],
    inputs: JSON.stringify({ url: { type: 'string', description: 'Site to audit' } }),
  });
  assert.match(resultText(result), /Created workflow "audit-wf"/);

  const entry = readWorkflow('audit-wf');
  assert.ok(entry, 'workflow persisted');
  assert.deepEqual(entry!.data.inputs, { url: { type: 'string', description: 'Site to audit' } });
});

test('workflow_create syncs event triggers immediately after saving', async () => {
  const result = await workflowCreate()({
    name: 'instant-event-wf',
    description: 'Run immediately when a test event arrives.',
    trigger_events: [{ type: 'clem.test.instant', dedupeKey: 'event-{{payload.id}}' }],
    steps: [{ id: 'handle', prompt: 'Handle the event.' }],
  });
  assert.match(resultText(result), /Created workflow "instant-event-wf"/);

  const fired = fireWorkflowSystemEvent('clem.test.instant', { id: 'I-1' })
    .filter((r) => r.workflowName === 'instant-event-wf');
  assert.equal(fired.length, 1);
  assert.equal(fired[0].status, 'queued');
});

test('workflow_create persists a step OUTPUT contract (declarable verification unlock)', async () => {
  const contract = { type: 'object' as const, required_keys: ['url'], verify: { url_present: ['url'] }, description: 'the created sheet' };
  const result = await workflowCreate()({
    name: 'contract-wf',
    description: 'Build a sheet and return its URL.',
    steps: [{ id: 'deliver', prompt: 'Create the sheet and return its URL.', output: contract }],
  });
  assert.match(resultText(result), /Created workflow "contract-wf"/);
  assert.deepEqual(readWorkflow('contract-wf')!.data.steps[0].output, contract);
});

test('workflow_contract_proposals reports upgrades without mutating workflow files', async () => {
  writeWorkflow('legacy-contract-wf', {
    name: 'legacy-contract-wf',
    description: 'Audit {{input.url}} and publish a report.',
    enabled: false,
    trigger: { manual: true },
    synthesis: { prompt: 'Return the live report URL.' },
    steps: [
      { id: 'deploy', prompt: 'Deploy the audit page and return the URL for {{input.url}}.' },
    ],
  });

  const before = readWorkflow('legacy-contract-wf')!.data;
  const result = await workflowContractProposals()({ name: 'legacy contract' });
  const text = resultText(result);

  assert.match(text, /Workflow Contract Proposals/);
  assert.match(text, /Suggested inputs/);
  assert.match(text, /Suggested pinned goal/);
  assert.match(text, /url_present: \["url"\]/);

  const after = readWorkflow('legacy-contract-wf')!.data;
  assert.deepEqual(after.goal, before.goal);
  assert.deepEqual(after.inputs, before.inputs);
  assert.deepEqual(after.steps[0].output, before.steps[0].output);
});

test('workflow_contract_proposals apply=true persists safe metadata-only upgrades', async () => {
  writeWorkflow('legacy-apply-wf', {
    name: 'legacy-apply-wf',
    description: 'Audit {{input.url}} and publish a report.',
    enabled: false,
    trigger: { manual: true },
    synthesis: { prompt: 'Return the live report URL.' },
    steps: [
      { id: 'deploy', prompt: 'Deploy the audit page and return the URL for {{input.url}}.' },
    ],
  });

  const result = await workflowContractProposals()({ name: 'legacy apply', apply: true });
  const text = resultText(result);

  assert.match(text, /Applied workflow contract upgrades/);
  assert.match(text, /legacy-apply-wf/);

  const after = readWorkflow('legacy-apply-wf')!.data;
  assert.ok(after.inputs?.url);
  assert.ok(after.goal?.objective);
  assert.deepEqual(after.steps[0].output?.required_keys, ['url']);
  assert.deepEqual(after.steps[0].output?.verify?.url_present, ['url']);
});

test('workflow_create persists step intent for intent-routed worker models', async () => {
  const result = await workflowCreate()({
    name: 'intent-wf',
    description: 'Create a design artifact.',
    steps: [{ id: 'design', prompt: 'Design the hero.', intent: 'design' }],
  });
  assert.match(resultText(result), /Created workflow "intent-wf"/);
  assert.equal(readWorkflow('intent-wf')!.data.steps[0].intent, 'design');
});

test('autoTagStepsWithModelRoleIntents fills blank step intents from worker rules only', () => {
  const steps = [
    { id: 'design', prompt: 'Design the hero section.' },
    { id: 'research', prompt: 'Research the market.', intent: 'research' },
    { id: 'copy', prompt: 'Design the ad copy.', model: 'gpt-5.5' },
    { id: 'judge', prompt: 'Judge the design.' },
  ];
  const notes = autoTagStepsWithModelRoleIntents(steps, [
    { role: 'worker', modelId: 'claude-opus-4-8', whenIntent: 'design', scope: 'durable', source: 'chat-rule' },
    { role: 'judge', modelId: 'claude-sonnet-4-6', whenIntent: 'design', scope: 'durable', source: 'chat-rule' },
  ]);
  assert.equal(steps[0].intent, 'design');
  assert.equal(steps[1].intent, 'research', 'explicit intent is preserved');
  assert.equal(steps[2].intent, undefined, 'explicit model wins, so auto-tagging skips it');
  assert.equal(steps[3].intent, 'design');
  assert.deepEqual(notes, [
    'Step `design` auto-tagged intent `design` → worker model claude-opus-4-8.',
    'Step `judge` auto-tagged intent `design` → worker model claude-opus-4-8.',
  ]);
});

test('autoTagStepsWithModelRoleIntents matches multi-word user categories conservatively', () => {
  const steps = [
    { id: 'hero', prompt: 'Design the product hero for the homepage.' },
    { id: 'redesign', prompt: 'Polish the existing redesign notes.' },
  ];
  autoTagStepsWithModelRoleIntents(steps, [
    { role: 'worker', modelId: 'claude-opus-4-8', whenIntent: 'product design', scope: 'durable', source: 'chat-rule' },
  ]);
  assert.equal(steps[0].intent, 'product-design');
  assert.equal(steps[1].intent, undefined, 'single-token substring accidents are not enough');
});

test('workflow_create auto-tags steps from durable intent-scoped worker rules', async () => {
  await withEnv({
    CLEMMY_MODEL_ROLES_REGISTRY: 'on',
    CLEMMY_MODEL_ROLES: JSON.stringify([
      { role: 'worker', modelId: 'claude-opus-4-8', whenIntent: 'design', scope: 'durable', source: 'chat-rule' },
    ]),
  }, async () => {
    const result = await workflowCreate()({
      name: 'auto-intent-wf',
      description: 'Create a design artifact.',
      steps: [{ id: 'hero', prompt: 'Design the hero.' }],
    });
    assert.match(resultText(result), /auto-tagged intent `design`/);
    assert.equal(readWorkflow('auto-intent-wf')!.data.steps[0].intent, 'design');
  });
});

test('workflow_create simple mode generates a design step intent when the description says design', async () => {
  await withEnv({
    CLEMMY_MODEL_ROLES_REGISTRY: 'on',
    CLEMMY_MODEL_ROLES: JSON.stringify([
      { role: 'worker', modelId: 'claude-opus-4-8', whenIntent: 'design', scope: 'durable', source: 'chat-rule' },
    ]),
  }, async () => {
    const result = await workflowCreate()({
      name: 'simple-design-wf',
      description: 'Design a polished landing page hero.',
    });
    assert.match(resultText(result), /Created workflow "simple-design-wf"/);
    const step = readWorkflow('simple-design-wf')!.data.steps.find((s) => s.id === 'design');
    assert.equal(step?.intent, 'design');
  });
});

test('workflow_create auto-repairs a missing summary output contract and pinned goal', async () => {
  const result = await workflowCreate()({
    name: 'plain-wf',
    description: 'x',
    steps: [{ id: 's', prompt: 'Fetch the prospect site and return a summary.' }],
  });
  const text = resultText(result);
  assert.match(text, /Created workflow "plain-wf"/);
  assert.match(text, /Added output contract/);
  assert.match(text, /Pinned a workflow goal/);

  const saved = readWorkflow('plain-wf')!.data;
  assert.deepEqual(saved.steps[0].output?.required_keys, ['summary']);
  assert.deepEqual(saved.steps[0].output?.non_empty, ['summary']);
  assert.equal(saved.goal?.objective, 'Fetch the prospect site and return a summary.');
});

test('workflow_update can add an output contract to an existing step', async () => {
  await workflowCreate()({
    name: 'upc-wf',
    description: 'x',
    steps: [{ id: 's', prompt: 'Fetch the prospect site and return a summary.' }],
  });
  const contract = { type: 'object' as const, required_keys: ['summary'] };
  await workflowUpdate()({
    name: 'upc-wf',
    steps: [{ id: 's', prompt: 'Fetch the prospect site and return a summary.', output: contract }],
  });
  assert.deepEqual(readWorkflow('upc-wf')!.data.steps[0].output, contract);
});

test('workflow_update can set step intent for intent-routed worker models', async () => {
  await workflowCreate()({
    name: 'intent-update-wf',
    description: 'x',
    steps: [{ id: 'design', prompt: 'Design the hero.' }],
  });
  await workflowUpdate()({
    name: 'intent-update-wf',
    steps: [{ id: 'design', prompt: 'Design the hero.', intent: 'design' }],
  });
  assert.equal(readWorkflow('intent-update-wf')!.data.steps[0].intent, 'design');
});

test('workflow_update auto-tags edited steps from durable intent-scoped worker rules', async () => {
  await workflowCreate()({
    name: 'auto-intent-update-wf',
    description: 'x',
    steps: [{ id: 'hero', prompt: 'Build the hero.' }],
  });
  await withEnv({
    CLEMMY_MODEL_ROLES_REGISTRY: 'on',
    CLEMMY_MODEL_ROLES: JSON.stringify([
      { role: 'worker', modelId: 'claude-opus-4-8', whenIntent: 'design', scope: 'durable', source: 'chat-rule' },
    ]),
  }, async () => {
    const result = await workflowUpdate()({
      name: 'auto-intent-update-wf',
      steps: [{ id: 'hero', prompt: 'Design the hero.' }],
    });
    assert.match(resultText(result), /auto-tagged intent `design`/);
    assert.equal(readWorkflow('auto-intent-update-wf')!.data.steps[0].intent, 'design');
  });
});

test('workflow_update refuses to save an ENABLED workflow that becomes invalid — P0-4 gate', async () => {
  // Seed an enabled, valid single-step workflow.
  writeWorkflow('p04-wf', {
    name: 'p04-wf',
    description: 'x',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'only', prompt: 'Do the thing.' }],
  });
  // Update it into a dependency CYCLE (not auto-repairable) — would fail at the
  // next fire. The gate must refuse and leave the live definition untouched.
  const result = await workflowUpdate()({
    name: 'p04-wf',
    steps: [
      { id: 'a', prompt: 'A', dependsOn: ['b'] },
      { id: 'b', prompt: 'B', dependsOn: ['a'] },
    ],
  });
  assert.match(resultText(result), /NOT updated/i);
  const after = readWorkflow('p04-wf')!.data;
  assert.equal(after.steps.length, 1, 'invalid update did not persist');
  assert.equal(after.steps[0].id, 'only');
});

test('workflow_create rejects malformed inputs schema JSON without creating', async () => {
  const result = await workflowCreate()({
    name: 'bad-wf',
    description: 'x',
    steps: [{ id: 's', prompt: 'Fetch the prospect site and return a summary.' }],
    inputs: '{url: not json}',
  });
  assert.match(resultText(result), /invalid workflow inputs schema json/i);
  assert.equal(readWorkflow('bad-wf'), null);
});

test('workflow_update accepts an inputs SCHEMA JSON string and updates def.inputs', async () => {
  await workflowCreate()({
    name: 'up-wf',
    description: 'x',
    steps: [{ id: 's', prompt: 'Fetch the prospect site and return a summary.' }],
  });
  const result = await workflowUpdate()({
    name: 'up-wf',
    inputs: JSON.stringify({ domain: { type: 'string' } }),
  });
  assert.match(resultText(result), /updated/);
  assert.deepEqual(readWorkflow('up-wf')!.data.inputs, { domain: { type: 'string' } });
});

test('workflow_run does not queue duplicate active runs for identical inputs', async () => {
  writeAuditWorkflow();

  const first = await workflowRun()({
    name: 'proposal-audit-brief',
    inputs: JSON.stringify({ url: 'https://www.aldouslaw.com/' }),
  });
  assert.match(resultText(first), /Queued "/);

  const second = await workflowRun()({
    name: 'proposal-audit-brief',
    inputs: JSON.stringify({ url: 'https://www.aldouslaw.com/' }),
  });
  assert.match(resultText(second), /already queued/);
  assert.match(resultText(second), /No duplicate was queued/);

  const files = readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json'));
  assert.equal(files.length, 1);
});

// ── Gap C: authoring advisories render into the tool result ───────────────

test('renderAuthoringAdvisories: empty when there are no warnings (byte-identical clean authoring)', () => {
  assert.equal(renderAuthoringAdvisories([]), '');
  assert.equal(renderAuthoringAdvisories(undefined), '');
});

test('renderAuthoringAdvisories: surfaces warnings as a non-blocking heads-up', () => {
  const out = renderAuthoringAdvisories(['declare an output contract', 'use forEach']);
  assert.match(out, /advisory/i);
  assert.match(out, /saved/i, 'must make clear the workflow was still saved');
  assert.match(out, /declare an output contract/);
  assert.match(out, /use forEach/);
});

// ── Feature A: hybrid author-time tool-choice binding ─────────────────────

function cliChoice(): ToolChoiceRecord {
  return {
    intent: 'salesforce.cli.query',
    description: 'Run a SOQL query against Salesforce via the sf CLI',
    choice: {
      kind: 'cli',
      identifier: 'sf',
      invocationTemplate: 'sf data query --target-org nathan@scorpion.co --json --query "{{soql}}"',
      testedAt: '2026-06-01T00:00:00Z',
    },
    fallbacks: [],
    body: '',
    filePath: '/tmp/sf.md',
  };
}

test('bindStepsToToolChoices: HIGH cli match → bakes the command + locks allowedTools (drops composio)', () => {
  const steps = [
    { id: 'find', prompt: 'Query Salesforce for new prospect accounts via a SOQL query.', allowedTools: ['composio_execute_tool', 'run_shell_command'] },
  ];
  const res = bindStepsToToolChoices(steps, { choices: [cliChoice()] });
  assert.equal(res.boundNotes.length, 1);
  assert.match(steps[0].prompt, /sf data query/, 'command baked into the prompt');
  assert.deepEqual(steps[0].allowedTools, ['run_shell_command'], 'locked to family, composio dropped');
});

test('bindStepsToToolChoices: a wildcard/undefined allowedTools is locked to the family on auto-bind', () => {
  const steps = [{ id: 'find', prompt: 'Query Salesforce for new prospect accounts via a SOQL query.' }];
  const res = bindStepsToToolChoices(steps, { choices: [cliChoice()] });
  assert.equal(res.boundNotes.length, 1);
  assert.deepEqual((steps[0] as { allowedTools?: string[] }).allowedTools, ['run_shell_command']);
});

test('bindStepsToToolChoices: composio match → ADVISE only, never mutates the step', () => {
  const composio: ToolChoiceRecord = {
    intent: 'salesforce.query.soql',
    description: 'Run a Salesforce SOQL query',
    choice: { kind: 'composio', identifier: 'SALESFORCE_RUN_SOQL_QUERY', testedAt: '2026-06-01T00:00:00Z' },
    fallbacks: [],
    body: '',
    filePath: '/tmp/c.md',
  };
  const steps = [{ id: 'find', prompt: 'Query Salesforce with a SOQL query for prospects.', allowedTools: ['composio_execute_tool'] }];
  const before = steps[0].prompt;
  const res = bindStepsToToolChoices(steps, { choices: [composio] });
  assert.equal(res.boundNotes.length, 0);
  assert.equal(res.advisories.length, 1);
  assert.equal(steps[0].prompt, before, 'composio match must not mutate the prompt');
});

test('bindStepsToToolChoices: an already-bound step is left untouched (no note, no advisory)', () => {
  const steps = [{ id: 'find', prompt: 'Query Salesforce: run `sf data query --json --query "SELECT Id FROM Account"`.', allowedTools: ['run_shell_command'] }];
  const res = bindStepsToToolChoices(steps, { choices: [cliChoice()] });
  assert.equal(res.boundNotes.length, 0);
  assert.equal(res.advisories.length, 0);
});

test('bindStepsToToolChoices: a usesSkill step is never re-bound (the skill owns its tools)', () => {
  const steps = [{ id: 'find', prompt: 'Query Salesforce for new prospects via SOQL.', usesSkill: 'analyze-deals' }];
  const res = bindStepsToToolChoices(steps, { choices: [cliChoice()] });
  assert.equal(res.boundNotes.length, 0);
  assert.equal(res.advisories.length, 0);
});

// ── Feature D: chat recall of running workflows ───────────────────────────

import { mkdirSync as _mkdirSync, writeFileSync as _writeFileSync } from 'node:fs';
const { renderWorkflowRunsOverview } = await import('./orchestration-tools.js');

function writeRunRecord(rec: Record<string, unknown>): void {
  _mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  _writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${rec.id}.json`), JSON.stringify(rec), 'utf-8');
}

test('renderWorkflowRunsOverview lists in-flight + needs-attention runs, and recent finished', () => {
  resetState();
  writeRunRecord({ id: 'r-run', workflow: 'sf-to-airtable', status: 'running', createdAt: new Date().toISOString() });
  writeRunRecord({ id: 'r-queued', workflow: 'daily-brief', status: 'queued', createdAt: new Date().toISOString() });
  writeRunRecord({ id: 'r-attn', workflow: 'enrich', status: 'completed', needsAttention: true, createdAt: new Date().toISOString() });
  writeRunRecord({ id: 'r-done', workflow: 'old-flow', status: 'completed', createdAt: new Date(Date.now() - 3_600_000).toISOString() });

  const out = renderWorkflowRunsOverview();
  assert.match(out, /3 active runs/);
  assert.match(out, /sf-to-airtable · running · run r-run/);
  assert.match(out, /daily-brief · queued/);
  assert.match(out, /enrich · completed · NEEDS ATTENTION/);
  assert.match(out, /Recently finished:/);
  assert.match(out, /old-flow · completed · run r-done/);
});

test('renderWorkflowRunsOverview: nothing active → says so (still lists recent)', () => {
  resetState();
  writeRunRecord({ id: 'r-old', workflow: 'x', status: 'completed', createdAt: new Date().toISOString() });
  const out = renderWorkflowRunsOverview();
  assert.match(out, /No workflows are running right now/);
});

// ── Feature A: adversarial-review regression fixes ────────────────────────

test('bindStepsToToolChoices: a {{template}} command is neutralized to <var> (workflow_create no longer rejects its own injected token)', () => {
  const steps = [{ id: 'find', prompt: 'Query Salesforce for new prospect accounts via a SOQL query.', allowedTools: ['composio_execute_tool', 'run_shell_command'] }];
  const res = bindStepsToToolChoices(steps, { choices: [cliChoice()] });
  assert.equal(res.boundNotes.length, 1);
  assert.ok(!steps[0].prompt.includes('{{'), 'no raw {{template}} token survives into the saved prompt');
  assert.match(steps[0].prompt, /<soql>/, 'placeholder rendered as guidance');
  assert.match(steps[0].prompt, /sf data query/);
});

test('bindStepsToToolChoices: re-binding an already engine-bound step is a no-op (no double-append, no drift to a 2nd choice)', () => {
  const steps: Array<{ id: string; prompt: string; allowedTools?: string[] }> = [
    { id: 'find', prompt: 'Query Salesforce for new prospect accounts via a SOQL query.' },
  ];
  const first = bindStepsToToolChoices(steps, { choices: [cliChoice()] });
  assert.equal(first.boundNotes.length, 1);
  const afterFirst = steps[0].prompt;
  // A second authoring pass (e.g. workflow_update resending steps) must not touch it.
  const second = bindStepsToToolChoices(steps, { choices: [cliChoice()] });
  assert.equal(second.boundNotes.length, 0);
  assert.equal(second.advisories.length, 0);
  assert.equal(steps[0].prompt, afterFirst, 'prompt unchanged on the second pass');
});

test('bindStepsToToolChoices: a deliberately read-only step is ADVISED, never auto-bound (no privilege escalation)', () => {
  const steps = [{ id: 'find', prompt: 'Query Salesforce for new prospect accounts via a SOQL query.', allowedTools: ['read_file', 'tool_output_query'] }];
  const before = steps[0].prompt;
  const res = bindStepsToToolChoices(steps, { choices: [cliChoice()] });
  assert.equal(res.boundNotes.length, 0, 'not auto-bound — would have added run_shell_command the author excluded');
  assert.equal(res.advisories.length, 1, 'advised instead');
  assert.equal(steps[0].prompt, before, 'prompt not mutated');
  assert.deepEqual(steps[0].allowedTools, ['read_file', 'tool_output_query'], 'scope untouched');
});

test('workflow_create: a generic salesforce step is auto-bound AND saved (the flagship case, end to end)', async () => {
  resetState();
  const { rememberToolChoice } = await import('../memory/tool-choice-store.js');
  rememberToolChoice({
    intent: 'salesforce.cli.query',
    description: 'Run a SOQL query against Salesforce via the sf CLI',
    choice: { kind: 'cli', identifier: 'sf', invocationTemplate: 'sf data query --json --query "{{soql}}"' },
  });
  const result = await workflowCreate()({
    name: 'sf-airtable-flow',
    description: 'Pull Salesforce prospects and add them to Airtable.',
    steps: [{ id: 'find', prompt: 'Query Salesforce for new prospect accounts via a SOQL query.', allowedTools: ['composio_execute_tool', 'run_shell_command'] }],
  });
  const text = resultText(result);
  assert.match(text, /Created workflow "sf-airtable-flow"/, 'workflow saved (NOT rejected on an injected {{token}})');
  assert.match(text, /Bound step `find`/, 'reports the auto-bind');
  const saved = readWorkflow('sf-airtable-flow')!.data.steps[0];
  assert.match(saved.prompt, /sf data query/, 'command baked into the saved prompt');
  assert.ok(!saved.prompt.includes('{{'), 'no raw template token saved');
  assert.deepEqual(saved.allowedTools, ['run_shell_command'], 'locked off composio');
});

// ─── J2b: chat → workflow promotion (draftToDefinition + canonical author) ──

test('draftToDefinition: maps a trace draft to a DISABLED, manual-trigger workflow', () => {
  const draft = traceToWorkflowDraft([
    { tool: 'composio_execute_tool', slug: 'SALESFORCE_GET_RECORDS', args: '{"tool":"SALESFORCE_GET_RECORDS","arguments":{}}', callId: 'a' },
    { tool: 'request_approval', args: '{"preview":"Send 5 emails"}', callId: 'b' },
    { tool: 'composio_execute_tool', slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL', args: '{"tool":"OUTLOOK_OUTLOOK_SEND_EMAIL","arguments":{}}', callId: 'c' },
  ]);
  const def = draftToDefinition('My Prospect Flow', draft);
  assert.equal(def.enabled, false);                 // saved disabled for review
  assert.equal(def.trigger.manual, true);
  assert.equal(def.steps.length, 2);                 // approval is a gate, not a step
  assert.deepEqual(def.steps[0].allowedTools, ['composio_execute_tool']);
  assert.deepEqual(def.steps[1].dependsOn, [def.steps[0].id]);  // linear chain
  assert.equal(def.steps[1].requiresApproval, true);            // gate preserved
  assert.equal(def.steps[1].approvalPreview, 'Send 5 emails');
});

test('draftToDefinition + commitAuthoredWorkflow: a promoted draft authors + validates cleanly', () => {
  const draft = traceToWorkflowDraft([
    { tool: 'composio_execute_tool', slug: 'DATAFORSEO_RANKED_KEYWORDS', args: '{"tool":"DATAFORSEO_RANKED_KEYWORDS","arguments":{"target":"x.com"}}', callId: 'a' },
    { tool: 'run_shell_command', args: '{"command":"python report.py"}', callId: 'b' },
  ]);
  const def = draftToDefinition('zz-promote-test', draft);
  const built = commitAuthoredWorkflow(def, 'zz-promote-test');
  assert.equal(built.ok, true, built.errors.join('; '));
  assert.equal(built.savedDef.enabled, false);
  assert.equal(readWorkflow('zz-promote-test')!.data.steps.length, 2);
});

test('draftToDefinition preserves inferred forEach loops and list output contracts', () => {
  const draft = traceToWorkflowDraft([
    { tool: 'composio_execute_tool', slug: 'DATAFORSEO_RANKED_KEYWORDS', args: '{"tool":"DATAFORSEO_RANKED_KEYWORDS","arguments":{"target":"a.com"}}', callId: 'a' },
    { tool: 'composio_execute_tool', slug: 'DATAFORSEO_RANKED_KEYWORDS', args: '{"tool":"DATAFORSEO_RANKED_KEYWORDS","arguments":{"target":"b.com"}}', callId: 'b' },
    { tool: 'composio_execute_tool', slug: 'DATAFORSEO_RANKED_KEYWORDS', args: '{"tool":"DATAFORSEO_RANKED_KEYWORDS","arguments":{"target":"c.com"}}', callId: 'c' },
  ]);
  const def = draftToDefinition('Fanout Draft', draft);

  assert.equal(def.steps.length, 2);
  assert.equal(def.steps[0].output?.type, 'array');
  assert.deepEqual(def.steps[0].output?.min_items, { '': 1 });
  assert.equal(def.steps[1].forEach, `{{steps.${def.steps[0].id}.output}}`);
  assert.deepEqual(def.steps[1].dependsOn, [def.steps[0].id]);
});

// ─── chat-aware toolkit binding (the scorpion-facebook-trends fix) ──────────

test('bindDiscussedToolkitsIntoSteps: binds the scrape step to the discussed TOOL (Apify), not the TARGET (Facebook)', () => {
  const steps: any = [
    { id: 'fetch', prompt: 'Find the official Facebook page for scorpion.co and verify it.', allowedTools: ['composio_*', 'run_shell_command'] },
    { id: 'scrape', prompt: 'Prefer a reliable Apify public Facebook page/posts scraper if configured; otherwise use public web scraping only.', allowedTools: ['composio_*', 'run_shell_command'] },
    { id: 'notify', prompt: 'Notify Nate with the summary.', allowedTools: ['notify_user'] },
  ];
  const discussed = [{ slug: 'apify', name: 'Apify' }, { slug: 'facebook', name: 'Facebook' }];
  const r = bindDiscussedToolkitsIntoSteps(steps, discussed);
  // Only the scrape step binds, and to Apify.
  assert.equal(r.boundNotes.length, 1);
  assert.match(r.boundNotes[0], /scrape.*Apify/);
  assert.match(steps[1].prompt, /use the Apify toolkit via composio/);
  assert.match(steps[1].prompt, /Do NOT improvise raw HTTP/);
  assert.ok(steps[1].allowedTools.includes('composio_execute_tool') && !steps[1].allowedTools.includes('composio_*'));
  // The find-page step (Facebook = TARGET) is untouched; notify is untouched.
  assert.equal(steps[0].prompt, 'Find the official Facebook page for scorpion.co and verify it.');
  assert.equal(steps[2].allowedTools.length, 1);
});

test('bindDiscussedToolkitsIntoSteps: a platform named only as a TARGET is never bound', () => {
  const steps: any = [{ id: 's', prompt: 'Summarize the latest Facebook posts for the team.', allowedTools: [] }];
  const r = bindDiscussedToolkitsIntoSteps(steps, [{ slug: 'facebook', name: 'Facebook' }]);
  assert.equal(r.boundNotes.length, 0); // "Facebook posts" = target, no tool intent
});

test('bindDiscussedToolkitsIntoSteps: requires tool intent (a bare mention does not bind)', () => {
  const steps: any = [{ id: 's', prompt: 'Write a friendly note mentioning Apify to the team.', allowedTools: [] }];
  const r = bindDiscussedToolkitsIntoSteps(steps, [{ slug: 'apify', name: 'Apify' }]);
  assert.equal(r.boundNotes.length, 0); // no scraper/actor/use-Apify cue
});

test('bindDiscussedToolkitsIntoSteps: idempotent (a second pass does not double-bind)', () => {
  const steps: any = [{ id: 's', prompt: 'Use the Apify scraper to pull data.', allowedTools: [] }];
  const first = bindDiscussedToolkitsIntoSteps(steps, [{ slug: 'apify', name: 'Apify' }]);
  const second = bindDiscussedToolkitsIntoSteps(steps, [{ slug: 'apify', name: 'Apify' }]);
  assert.equal(first.boundNotes.length, 1);
  assert.equal(second.boundNotes.length, 0); // marker present → skipped
});

// ─── Wave 1.3: workflow_get surfaces a deterministic step's RUNNER provenance ──

function workflowGet(): ToolHandler {
  const handler = handlers.get('workflow_get');
  assert.ok(handler, 'workflow_get registered');
  return handler;
}

test('workflow_get reads a deterministic step\'s runner SOURCE and surfaces what it reaches (Salesforce, not guessed)', async () => {
  resetState();
  writeWorkflow('det-prov-test', {
    name: 'Det Prov Test',
    description: 'A deterministic pull from Salesforce.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'pull_sf', prompt: 'Run the bundled puller.', deterministic: { runner: 'pull.mjs' } } as any,
    ],
  });
  // The runner that BACKS the step — its source reveals the real connector.
  const scriptsDir = path.join(WORKFLOWS_DIR, 'det-prov-test', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'pull.mjs'),
    'import { execFileSync } from "node:child_process";\nconst out = execFileSync("sf", ["data","query","-q","SELECT Id FROM Opportunity"]);\nprocess.stdout.write(out);\n',
    'utf-8',
  );

  const text = resultText(await workflowGet()({ name: 'Det Prov Test' }));
  assert.match(text, /runner data:/, 'shows a runner-data provenance line');
  assert.match(text, /shells: sf/, 'names the sf CLI it shells out to');
  assert.match(text, /Salesforce/, 'reveals the real system behind the script');
});

test('workflow_get REFUSES to read a traversal runner path (no arbitrary-file read)', async () => {
  resetState();
  // A hand-edited / corrupt definition could carry a traversal runner; the parse
  // path does not run the validator, so workflow_get must guard the read itself.
  writeWorkflow('det-traversal-test', {
    name: 'Det Traversal Test',
    description: 'Deterministic step with a malicious runner path.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'pull', prompt: 'Run it.', deterministic: { runner: '../../../../etc/passwd' } } as any,
    ],
  });
  const text = resultText(await workflowGet()({ name: 'Det Traversal Test' }));
  assert.match(text, /runner data:.*invalid runner path/i, 'rejects the traversal path instead of reading it');
  assert.doesNotMatch(text, /root:.*:0:0:/, 'never surfaces content derived from an escaped file');
});

test('workflow_get notes a deterministic step whose runner file is missing (does not crash)', async () => {
  resetState();
  writeWorkflow('det-missing-test', {
    name: 'Det Missing Test',
    description: 'Deterministic step with no script file on disk.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'pull', prompt: 'Run it.', deterministic: { runner: 'gone.mjs' } } as any,
    ],
  });
  const text = resultText(await workflowGet()({ name: 'Det Missing Test' }));
  assert.match(text, /runner data:.*missing/i, 'flags the missing script rather than throwing');
});
