/**
 * Run: npx tsx --test src/tools/orchestration-tools.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-orchestration-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

import type { ToolChoiceRecord } from '../memory/tool-choice-store.js';
const { registerOrchestrationTools, renderAuthoringAdvisories, bindStepsToToolChoices, draftToDefinition, commitAuthoredWorkflow } = await import('./orchestration-tools.js');
const { traceToWorkflowDraft } = await import('../execution/trace-to-workflow.js');
const { writeWorkflow, readWorkflow } = await import('../memory/workflow-store.js');
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

function resultText(result: ToolResult): string {
  return result.content.map((item) => item.text).join('\n');
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

test('workflow_create without an output contract leaves step.output undefined (no-regression)', async () => {
  await workflowCreate()({
    name: 'plain-wf',
    description: 'x',
    steps: [{ id: 's', prompt: 'Fetch and summarize the prospect site.' }],
  });
  assert.equal(readWorkflow('plain-wf')!.data.steps[0].output, undefined);
});

test('workflow_update can add an output contract to an existing step', async () => {
  await workflowCreate()({
    name: 'upc-wf',
    description: 'x',
    steps: [{ id: 's', prompt: 'Fetch and summarize the prospect site.' }],
  });
  const contract = { type: 'object' as const, required_keys: ['summary'] };
  await workflowUpdate()({
    name: 'upc-wf',
    steps: [{ id: 's', prompt: 'Fetch and summarize the prospect site.', output: contract }],
  });
  assert.deepEqual(readWorkflow('upc-wf')!.data.steps[0].output, contract);
});

test('workflow_create rejects malformed inputs schema JSON without creating', async () => {
  const result = await workflowCreate()({
    name: 'bad-wf',
    description: 'x',
    steps: [{ id: 's', prompt: 'Fetch and summarize the prospect site.' }],
    inputs: '{url: not json}',
  });
  assert.match(resultText(result), /invalid workflow inputs schema json/i);
  assert.equal(readWorkflow('bad-wf'), null);
});

test('workflow_update accepts an inputs SCHEMA JSON string and updates def.inputs', async () => {
  await workflowCreate()({
    name: 'up-wf',
    description: 'x',
    steps: [{ id: 's', prompt: 'Fetch and summarize the prospect site.' }],
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
