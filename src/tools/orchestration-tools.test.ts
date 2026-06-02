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

const { registerOrchestrationTools, renderAuthoringAdvisories } = await import('./orchestration-tools.js');
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

  assert.match(text, /Queued workflow "proposal-audit-brief"/);
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
  assert.match(resultText(first), /Queued workflow/);

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
