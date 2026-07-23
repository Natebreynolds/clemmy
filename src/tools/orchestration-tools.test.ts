/**
 * Run: npx tsx --test src/tools/orchestration-tools.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
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
const schemas = new Map<string, Record<string, { parse?: (value: unknown) => unknown }>>();
registerOrchestrationTools({
  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    handlers.set(name, handler);
    schemas.set(name, _schema as Record<string, { parse?: (value: unknown) => unknown }>);
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

function workflowGet(): ToolHandler {
  const handler = handlers.get('workflow_get');
  assert.ok(handler, 'workflow_get registered');
  return handler;
}

function workflowApplyContractFixes(): ToolHandler {
  const handler = handlers.get('workflow_apply_contract_fixes');
  assert.ok(handler, 'workflow_apply_contract_fixes registered');
  return handler;
}

function workflowSetEnabled(): ToolHandler {
  const handler = handlers.get('workflow_set_enabled');
  assert.ok(handler, 'workflow_set_enabled registered');
  return handler;
}

function workflowCertify(): ToolHandler {
  const handler = handlers.get('workflow_certify');
  assert.ok(handler, 'workflow_certify registered');
  return handler;
}

function workflowResourceProposals(): ToolHandler {
  const handler = handlers.get('workflow_resource_proposals');
  assert.ok(handler, 'workflow_resource_proposals registered');
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

function workflowRunFiles(): string[] {
  return existsSync(WORKFLOW_RUNS_DIR)
    ? readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json'))
    : [];
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
    inputs: JSON.stringify({ website: ' https://www.redwood-law.example/ ' }),
  });
  const text = resultText(result);

  assert.match(text, /Queued "proposal-audit-brief"/);
  const files = readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json'));
  assert.equal(files.length, 1);
  const run = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, files[0]), 'utf-8')) as {
    inputs: Record<string, string>;
  };
  assert.equal(run.inputs.url, 'https://www.redwood-law.example/');
  assert.equal(run.inputs.website, 'https://www.redwood-law.example/');
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

test('workflow_create/update tool schemas accept step input contracts for codification', () => {
  const step = {
    id: 'pull',
    prompt: 'Fetch the domain rank overview.',
    allowedTools: ['dataforseo_domain_rank_overview'],
    inputs: { target: { from: 'input.domain', type: 'string' } },
    output: { type: 'object', required_keys: ['metrics'] },
    sideEffect: 'read',
  };

  const createSchema = schemas.get('workflow_create');
  const updateSchema = schemas.get('workflow_update');
  assert.ok(createSchema?.steps?.parse, 'workflow_create steps schema registered');
  assert.ok(updateSchema?.steps?.parse, 'workflow_update steps schema registered');
  assert.doesNotThrow(() => createSchema.steps.parse([step]));
  assert.doesNotThrow(() => updateSchema.steps.parse([step]));
});

test('workflow_create saves authored step input contracts as direct call nodes when codifiable', async () => {
  const result = await workflowCreate()({
    name: 'codified-create-flow',
    description: 'Pull domain rank metrics with a direct tool call.',
    steps: [{
      id: 'pull',
      prompt: 'Fetch the domain rank overview.',
      allowedTools: ['dataforseo_domain_rank_overview'],
      inputs: { target: { from: 'input.domain', type: 'string' } },
      output: { type: 'object', required_keys: ['metrics'] },
      sideEffect: 'read',
    }],
    inputs: JSON.stringify({ domain: { type: 'string', description: 'Target domain' } }),
  });

  assert.match(resultText(result), /Created workflow "codified-create-flow"/);
  const saved = readWorkflow('codified-create-flow')!.data.steps[0];
  assert.equal(saved.call?.tool, 'dataforseo_domain_rank_overview');
  assert.deepEqual(saved.call?.args, { target: '{{input.domain}}' });
  assert.equal(saved.codifiedFrom?.prompt, 'Fetch the domain rank overview.');
});

test('workflow_create accepts durable resources separately from run inputs and workflow_get surfaces them', async () => {
  const resources = {
    lead_sheet: {
      kind: 'sheet',
      label: 'Lead sheet',
      toolkit: 'googlesheets',
      resourceId: 'sheet-123',
      name: 'Daily leads',
    },
  };
  const result = await workflowCreate()({
    name: 'resource-wf',
    description: 'Summarize a bound lead sheet.',
    steps: [{ id: 'summarize', prompt: 'Summarize the bound lead sheet.', sideEffect: 'read' }],
    resources: JSON.stringify(resources),
  });
  assert.match(resultText(result), /Created workflow "resource-wf"/);

  const entry = readWorkflow('resource-wf');
  assert.ok(entry, 'workflow persisted');
  assert.equal(entry!.data.resources?.lead_sheet.resourceId, 'sheet-123');
  assert.equal(entry!.data.resources?.lead_sheet.toolkit, 'googlesheets');
  assert.equal(entry!.data.inputs, undefined);

  const text = resultText(await workflowGet()({ name: 'resource-wf' }));
  assert.match(text, /Resources:/);
  assert.match(text, /lead_sheet: sheet/);
  assert.match(text, /googlesheets -> sheet-123/);
  assert.match(text, /Inputs:\n  \(none\)/);
});

test('workflow_run rejects incomplete required resource bindings without queueing', async () => {
  writeWorkflow('resource-gap-wf', {
    name: 'resource-gap-wf',
    description: 'Summarize a bound lead sheet.',
    enabled: true,
    trigger: { manual: true },
    resources: {
      lead_sheet: {
        id: 'lead_sheet',
        kind: 'sheet',
        label: 'Lead sheet',
        toolkit: 'googlesheets',
      },
    },
    steps: [{ id: 'summarize', prompt: 'Summarize the bound lead sheet.', sideEffect: 'read' }],
  });

  const text = resultText(await workflowRun()({ name: 'resource-gap-wf', inputs: '{}' }));

  assert.match(text, /Workflow certification: NEEDS RESOURCE BINDING/);
  assert.match(text, /Lead sheet: bind a concrete spreadsheet/);
  assert.match(text, /Next command: workflow_update name="resource-gap-wf" resources=/);
  assert.deepEqual(workflowRunFiles(), []);
});

test('workflow_resource_proposals reports binding next actions for durable resources', async () => {
  writeWorkflow('resource-proposal-wf', {
    name: 'resource-proposal-wf',
    description: 'Summarize a lead sheet.',
    enabled: false,
    trigger: { manual: true },
    resources: {
      lead_sheet: {
        id: 'lead_sheet',
        kind: 'sheet',
        label: 'Lead sheet',
      },
    },
    steps: [{ id: 'summarize', prompt: 'Summarize the bound lead sheet.', sideEffect: 'read' }],
  });

  const text = resultText(await workflowResourceProposals()({ name: 'resource-proposal-wf' }));

  assert.match(text, /Workflow resource binding: resource-proposal-wf/);
  assert.match(text, /Lead sheet \(sheet\) — needs_surface/);
  assert.match(text, /Recommended: Google Sheets/);
  assert.match(text, /Next: workflow_update name=<workflow> resources=/);
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

test('workflow_create accepts a call-only read step and queues a creation test', async () => {
  const result = await workflowCreate()({
    name: 'call-grounded-wf',
    description: 'List contacts from HubSpot.',
    steps: [{ id: 'list_contacts', call: { tool: 'composio_hubspot_list_contacts', args: {} } }],
  });
  const text = resultText(result);
  assert.match(text, /Created workflow "call-grounded-wf" \(saved DISABLED while I test it\)/);
  assert.match(text, /creation test/i);

  const saved = readWorkflow('call-grounded-wf')!.data;
  assert.equal(saved.enabled, false);
  assert.equal(saved.steps[0].prompt, '');
  assert.equal(saved.steps[0].call?.tool, 'composio_hubspot_list_contacts');

  const files = readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json'));
  assert.equal(files.length, 1);
  const run = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, files[0]), 'utf-8')) as {
    workflow: string;
    status: string;
  };
  assert.equal(run.workflow, 'call-grounded-wf');
  assert.equal(run.status, 'creation_test');
});

test('workflow_create tolerates model-emitted null optionals on authored steps', async () => {
  const soql = 'SELECT Id, Name, StageName, Amount, CloseDate FROM Opportunity WHERE IsClosed = false ORDER BY CloseDate ASC LIMIT 50';
  const result = await workflowCreate()({
    name: 'Monday Salesforce Opportunity Report',
    description: 'Every Monday at 8 AM PT, read open Salesforce opportunities and produce a report.',
    trigger_schedule: '0 8 * * 1',
    trigger_timezone: 'America/Los_Angeles',
    steps: [
      {
        id: 'pull_open_opportunities',
        prompt: null,
        project: null,
        dependsOn: null,
        model: null,
        intent: null,
        maxTurns: null,
        forEach: null,
        call: { tool: 'SALESFORCE_RUN_SOQL_QUERY', args: { query: soql } },
        deterministic: null,
        allowedTools: ['composio_execute_tool'],
        sideEffect: 'read',
        requiresApproval: false,
        approvalPreview: null,
        inputs: null,
        output: { type: 'object', required_keys: ['records'] },
      },
      {
        id: 'summarize_opportunity_report',
        prompt: 'Summarize total pipeline, overdue close dates, next-step gaps, largest opportunities, stage mix, owner mix, and recommended follow-up priorities.',
        dependsOn: ['pull_open_opportunities'],
        call: null,
        deterministic: null,
        allowedTools: [],
        sideEffect: 'read',
        requiresApproval: false,
        approvalPreview: null,
        output: { type: 'object', required_keys: ['summary', 'priorities'] },
      },
    ],
    synthesis_prompt: 'Return the final Salesforce opportunity report for the workflow activity/results view.',
  });
  const text = resultText(result);
  assert.match(text, /Created workflow "Monday Salesforce Opportunity Report"/);
  assert.doesNotMatch(text, /declares call but no tool/);

  const saved = readWorkflow('monday-salesforce-opportunity-report')!.data;
  assert.equal(saved.enabled, false);
  assert.equal(saved.trigger.schedule, '0 8 * * 1');
  assert.equal(saved.trigger.timezone, 'America/Los_Angeles');
  assert.equal(saved.steps[0].prompt, '');
  assert.deepEqual(saved.steps[0].call?.args, { query: soql });
  assert.equal(saved.steps[1].call, undefined);
  assert.equal(saved.steps[1].allowedTools, undefined);
});

test('workflow_create keeps external-read workflows disabled when smoke inputs are missing', async () => {
  const result = await workflowCreate()({
    name: 'missing-smoke-input-wf',
    description: 'Scrape a supplied URL with Apify.',
    inputs: JSON.stringify({ url: { type: 'string', description: 'URL to scrape' } }),
    steps: [{ id: 'scrape', prompt: 'Scrape {{input.url}} with Apify.', allowedTools: ['composio_apify_*'] }],
  });
  const text = resultText(result);
  assert.match(text, /saved DISABLED pending verification/);
  assert.match(text, /missing `url`/);
  assert.match(text, /cannot run blind/);

  const saved = readWorkflow('missing-smoke-input-wf')!.data;
  assert.equal(saved.enabled, false);
  assert.throws(() => readdirSync(WORKFLOW_RUNS_DIR), /ENOENT/);
});

test('workflow_create uses test_inputs to queue an external-read creation test without default inputs', async () => {
  const result = await workflowCreate()({
    name: 'provided-smoke-input-wf',
    description: 'Fetch a supplied URL with Apify.',
    inputs: JSON.stringify({ url: { type: 'string', description: 'URL to fetch' } }),
    test_inputs: JSON.stringify({ url: 'https://example.com' }),
    steps: [{ id: 'fetch', prompt: 'Fetch {{input.url}} with Apify.', allowedTools: ['composio_apify_*'] }],
  });
  const text = resultText(result);
  assert.match(text, /saved DISABLED while I test it/);
  assert.match(text, /creation test/i);

  const files = readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json'));
  assert.equal(files.length, 1);
  const run = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, files[0]), 'utf-8')) as {
    workflow: string;
    status: string;
    inputs: Record<string, string>;
  };
  assert.equal(run.workflow, 'provided-smoke-input-wf');
  assert.equal(run.status, 'creation_test');
  assert.equal(run.inputs.url, 'https://example.com');
});

test('workflow_set_enabled requires smoke inputs before approving external-read workflows', async () => {
  writeWorkflow('enable-smoke-input-wf', {
    name: 'enable-smoke-input-wf',
    description: 'Fetch a supplied URL with Apify.',
    enabled: false,
    trigger: { manual: true },
    inputs: { url: { type: 'string', description: 'URL to fetch' } },
    steps: [{ id: 'fetch', prompt: 'Fetch {{input.url}} with Apify.', allowedTools: ['composio_apify_*'] }],
  } as never);

  const missing = await workflowSetEnabled()({ name: 'enable-smoke-input-wf', enabled: true });
  assert.match(resultText(missing), /was NOT enabled/);
  assert.match(resultText(missing), /missing `url`/);
  assert.equal(readWorkflow('enable-smoke-input-wf')!.data.enabled, false);
  assert.throws(() => readdirSync(WORKFLOW_RUNS_DIR), /ENOENT/);

  const queued = await workflowSetEnabled()({
    name: 'enable-smoke-input-wf',
    enabled: true,
    test_inputs: JSON.stringify({ url: 'https://example.com' }),
  });
  assert.match(resultText(queued), /Verifying "enable-smoke-input-wf" before it goes live/);
  assert.match(resultText(queued), /creation test/i);
  assert.equal(readWorkflow('enable-smoke-input-wf')!.data.enabled, false);
  assert.equal(readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json')).length, 1);
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

test('workflow_create persists workflow and step local project bindings', async () => {
  const result = await workflowCreate()({
    name: 'project-bound-wf',
    description: 'Work across local repos.',
    project: 'clementine-next',
    steps: [
      { id: 'inspect', prompt: 'Inspect {{project.path}}.' },
      { id: 'patch_other', prompt: 'Patch the sibling repo.', project: 'sibling-app', dependsOn: ['inspect'] },
    ],
  });

  assert.match(resultText(result), /Created workflow "project-bound-wf"/);
  const saved = readWorkflow('project-bound-wf')!.data;
  assert.equal(saved.project, 'clementine-next');
  assert.equal(saved.steps[0].project, undefined);
  assert.equal(saved.steps[1].project, 'sibling-app');
});

test('workflow_create portable_models strips exact model pins and keeps intents', async () => {
  const result = await workflowCreate()({
    name: 'portable-create-wf',
    description: 'Draft a portable memo.',
    portable_models: true,
    steps: [{ id: 'draft', prompt: 'Draft the memo.', model: 'claude-opus-4-8', intent: 'writing' }],
  });
  assert.match(resultText(result), /portable intent routing `?"?writing"?`?|portable intent routing "writing"/);
  const step = readWorkflow('portable-create-wf')!.data.steps[0];
  assert.equal(step.model, undefined);
  assert.equal(step.intent, 'writing');
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

test('workflow_create keeps workflows with readiness gaps disabled', async () => {
  const result = await workflowCreate()({
    name: 'gapful-send-wf',
    description: 'Send outreach.',
    steps: [{ id: 'send', prompt: 'Send the emails to the outside prospect list.' }],
  });
  const text = resultText(result);
  assert.match(text, /saved DISABLED pending readiness answers/);
  assert.match(text, /readiness gap test/i);
  assert.equal(readWorkflow('gapful-send-wf')!.data.enabled, false);
});

test('workflow_create and workflow_update surface the visual contract to authoring agents', async () => {
  const created = await workflowCreate()({
    name: 'visual-contract-authoring-wf',
    description: 'Render a client report with a missing local skill.',
    steps: [{ id: 'render', prompt: 'Render the client report.', usesSkill: 'missing-report-skill' }],
  });
  const createText = resultText(created);
  assert.match(createText, /Workflow visual contract: BLOCKED/);
  assert.match(createText, /\[BLOCK\] Tool readiness/);
  assert.match(createText, /Recommended contract fixes:/);
  assert.match(createText, /Install or replace skill missing-report-skill/);
  assert.match(createText, /missing-report-skill/);
  assert.equal(readWorkflow('visual-contract-authoring-wf')?.data.steps[0].usesSkill, 'missing-report-skill');

  writeWorkflow('visual-contract-update-wf', {
    name: 'visual-contract-update-wf',
    description: 'Draft a note.',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'draft', prompt: 'Draft an internal note.' }],
  });

  const updated = await workflowUpdate()({
    name: 'visual-contract-update-wf',
    steps: [{ id: 'render', prompt: 'Render the client report.', usesSkill: 'missing-report-skill' }],
  });
  const updateText = resultText(updated);
  assert.match(updateText, /Workflow visual contract: BLOCKED/);
  assert.match(updateText, /\[BLOCK\] Tool readiness/);
  assert.match(updateText, /Recommended contract fixes:/);
  assert.match(updateText, /Install or replace skill missing-report-skill/);
  assert.match(updateText, /missing-report-skill/);
});

test('workflow_apply_contract_fixes applies safe model-portability and judge-gate remediations', async () => {
  writeWorkflow('visual-fix-wf', {
    name: 'visual-fix-wf',
    description: 'Draft a weekly client memo.',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'draft', prompt: 'Draft the weekly client memo.', model: 'claude-opus-4-8' }],
  });

  const result = await workflowApplyContractFixes()({ name: 'visual fix' });
  const text = resultText(result);

  assert.match(text, /visual contract fixes applied/);
  assert.match(text, /Replaced pinned model "claude-opus-4-8"/);
  assert.match(text, /Pinned workflow goal/);
  assert.match(text, /Workflow visual contract: TRUSTED/);

  const saved = readWorkflow('visual-fix-wf')!.data;
  assert.equal(saved.steps[0].model, undefined);
  assert.equal(saved.goal?.objective, 'Draft a weekly client memo.');
});

test('workflow_apply_contract_fixes reports manual-only missing skill blockers without masking them', async () => {
  writeWorkflow('missing-skill-contract-fix-wf', {
    name: 'missing-skill-contract-fix-wf',
    description: 'Render a report with a missing skill.',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'render', prompt: 'Render the report.', usesSkill: 'missing-report-skill' }],
  });

  const result = await workflowApplyContractFixes()({
    name: 'missing skill contract',
    fixes: ['install_skill'],
  });
  const text = resultText(result);

  assert.match(text, /no automatic visual contract fixes/i);
  assert.match(text, /Install or replace skill missing-report-skill/);
  assert.match(text, /Missing skills must be installed locally/);
  assert.match(text, /Workflow visual contract: BLOCKED/);
  assert.equal(readWorkflow('missing-skill-contract-fix-wf')!.data.steps[0].usesSkill, 'missing-report-skill');
});

test('workflow_apply_contract_fixes requires explicit stable keys before making write fan-out resumable', async () => {
  writeWorkflow('fanout-contract-fix-wf', {
    name: 'fanout-contract-fix-wf',
    description: 'Process each record.',
    enabled: false,
    trigger: { manual: true },
    steps: [
      {
        id: 'list',
        prompt: 'Return records to update.',
        sideEffect: 'read',
        output: { type: 'array', min_items: { '': 1 } },
      },
      {
        id: 'upsert',
        prompt: 'Update each record.',
        dependsOn: ['list'],
        forEach: 'list',
        sideEffect: 'write',
      },
    ],
  });

  const skipped = await workflowApplyContractFixes()({
    name: 'fanout contract fix',
    fixes: ['make_fanout_resumable'],
  });
  assert.match(resultText(skipped), /assume_stable_item_keys=true/);
  assert.equal(readWorkflow('fanout-contract-fix-wf')!.data.steps[1].forEachNewOnly, undefined);

  const applied = await workflowApplyContractFixes()({
    name: 'fanout contract fix',
    fixes: ['make_fanout_resumable'],
    assume_stable_item_keys: true,
  });
  const text = resultText(applied);
  assert.match(text, /visual contract fixes applied/);
  assert.match(text, /Marked write fan-out step "upsert" as forEachNewOnly/);
  assert.equal(readWorkflow('fanout-contract-fix-wf')!.data.steps[1].forEachNewOnly, true);
});

test('workflow_set_enabled refuses unresolved readiness gaps', async () => {
  writeWorkflow('gapful-enable-wf', {
    name: 'gapful-enable-wf',
    description: 'Send outreach.',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'send', prompt: 'Send the emails to the outside prospect list.' }],
  } as never);

  const result = await workflowSetEnabled()({ name: 'gapful-enable-wf', enabled: true });
  const text = resultText(result);
  assert.match(text, /was NOT enabled/);
  assert.match(text, /readiness gap test/i);
  assert.equal(readWorkflow('gapful-enable-wf')!.data.enabled, false);
});

test('workflow_update saves enabled workflows DISABLED when readiness gaps are introduced', async () => {
  writeWorkflow('gapful-update-wf', {
    name: 'gapful-update-wf',
    description: 'Draft internal notes.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'draft', prompt: 'Draft a short internal note.' }],
  } as never);

  const result = await workflowUpdate()({
    name: 'gapful-update-wf',
    steps: [{ id: 'send', prompt: 'Send the emails to the outside prospect list.' }],
  });
  const text = resultText(result);
  assert.match(text, /stayed DISABLED/);
  assert.match(text, /readiness gap test/i);
  assert.equal(readWorkflow('gapful-update-wf')!.data.enabled, false);
});

test('workflow lifecycle routes create/update/enable/run through shared workflow paths', async () => {
  const trigger = [{ type: 'crm.lifecycle.created', dedupeKey: 'lead-{{payload.leadId}}' }];
  const inputs = JSON.stringify({ leadId: { type: 'string', description: 'Lead id to process' } });
  const created = await workflowCreate()({
    name: 'lifecycle-shared-wf',
    description: 'Prepare outreach for a CRM lead.',
    inputs,
    trigger_events: trigger,
    steps: [{ id: 'send', prompt: 'Send the emails to the outside prospect list for {{input.leadId}}.' }],
  });
  assert.match(resultText(created), /saved DISABLED pending readiness answers/);
  assert.equal(readWorkflow('lifecycle-shared-wf')!.data.enabled, false);
  assert.deepEqual(fireWorkflowSystemEvent('crm.lifecycle.created', { leadId: 'pre-enable' }), []);

  const updated = await workflowUpdate()({
    name: 'lifecycle-shared-wf',
    steps: [{ id: 'draft', prompt: 'Draft an internal note for {{input.leadId}}.' }],
  });
  assert.match(resultText(updated), /Workflow "lifecycle-shared-wf" updated/);
  assert.equal(readWorkflow('lifecycle-shared-wf')!.data.enabled, false);

  const enabled = await workflowSetEnabled()({ name: 'lifecycle-shared-wf', enabled: true });
  assert.match(resultText(enabled), /now approved/);
  assert.equal(readWorkflow('lifecycle-shared-wf')!.data.enabled, true);

  const manual = await workflowRun()({
    name: 'lifecycle-shared-wf',
    inputs: JSON.stringify({ leadId: 'manual-1' }),
  });
  assert.match(resultText(manual), /Queued "lifecycle-shared-wf"/);

  const fired = fireWorkflowSystemEvent('crm.lifecycle.created', { leadId: 'event-1' })
    .filter((r) => r.workflowName === 'lifecycle-shared-wf');
  assert.equal(fired.length, 1);
  assert.equal(fired[0].status, 'queued');

  const runs = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, entry), 'utf-8')) as {
      workflow: string;
      status: string;
      inputs: Record<string, string>;
    })
    .filter((run) => run.workflow === 'lifecycle-shared-wf')
    .sort((a, b) => a.inputs.leadId.localeCompare(b.inputs.leadId));
  assert.deepEqual(
    runs.map((run) => ({ status: run.status, leadId: run.inputs.leadId })),
    [
      { status: 'queued', leadId: 'event-1' },
      { status: 'queued', leadId: 'manual-1' },
    ],
  );
});

test('workflow_certify gives one-door next action for creation-test input gaps', async () => {
  writeWorkflow('certify-inputs-wf', {
    name: 'certify-inputs-wf',
    description: 'Inspect a website.',
    enabled: false,
    trigger: { manual: true },
    inputs: { url: { type: 'string', description: 'URL to inspect' } },
    steps: [{ id: 'fetch', prompt: 'Fetch the website data for {{input.url}}.', allowedTools: ['web_search'] }],
  });

  const result = await workflowCertify()({ name: 'certify-inputs-wf' });
  const text = resultText(result);

  assert.match(text, /Workflow certification: NEEDS CREATION INPUTS/);
  assert.match(text, /Missing creation-test inputs:\n- url/);
  assert.match(text, /Next command: workflow_certify name="certify-inputs-wf" test_inputs=/);
  assert.equal(readWorkflow('certify-inputs-wf')!.data.enabled, false);
  assert.deepEqual(workflowRunFiles(), []);
});

test('workflow_certify points creation-test-ready drafts at workflow_set_enabled', async () => {
  writeWorkflow('certify-test-wf', {
    name: 'certify-test-wf',
    description: 'Inspect a website.',
    enabled: false,
    trigger: { manual: true },
    inputs: { url: { type: 'string', description: 'URL to inspect' } },
    steps: [{ id: 'fetch', prompt: 'Fetch the website data for {{input.url}}.', allowedTools: ['web_search'] }],
  });

  const result = await workflowCertify()({
    name: 'certify-test-wf',
    test_inputs: JSON.stringify({ url: 'https://example.com' }),
  });
  const text = resultText(result);

  assert.match(text, /Workflow certification: NEEDS CREATION TEST/);
  assert.match(text, /Can start creation test: yes/);
  assert.match(text, /Next command: workflow_set_enabled name="certify-test-wf" enabled=true test_inputs=/);
  assert.deepEqual(workflowRunFiles(), []);
});

test('workflow_certify points live workflows with inputs at workflow_run', async () => {
  writeWorkflow('certify-run-wf', {
    name: 'certify-run-wf',
    description: 'Draft lead note.',
    enabled: true,
    trigger: { manual: true },
    inputs: { leadId: { type: 'string', description: 'Lead id' } },
    steps: [{ id: 'draft', prompt: 'Draft an internal note for {{input.leadId}}.' }],
  });

  const result = await workflowCertify()({
    name: 'certify-run-wf',
    inputs: JSON.stringify({ leadId: 'L-1' }),
  });
  const text = resultText(result);

  assert.match(text, /Workflow certification: READY TO RUN/);
  assert.match(text, /Can run now: yes/);
  assert.match(text, /Next command: workflow_run name="certify-run-wf"/);
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

test('workflow_update portable_models strips existing exact model pins without replacing steps', async () => {
  writeWorkflow('portable-update-wf', {
    name: 'portable-update-wf',
    description: 'Portable update test.',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'draft', prompt: 'Draft the memo.', model: 'gpt-5-codex', intent: 'writing' }],
  });

  const result = await workflowUpdate()({ name: 'portable-update-wf', portable_models: true });
  assert.match(resultText(result), /portable intent routing "writing"/);
  const step = readWorkflow('portable-update-wf')!.data.steps[0];
  assert.equal(step.model, undefined);
  assert.equal(step.intent, 'writing');
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

test('workflow_update can set full loopUntil probe/until config', async () => {
  await workflowCreate()({
    name: 'loop-probe-update-wf',
    description: 'Poll an export until it is done.',
    steps: [{ id: 'poll', prompt: 'Start or check the export job.', sideEffect: 'read' }],
  });

  const loopUntil = {
    maxAttempts: 8,
    probe: { runner: 'check-export-status.mjs' },
    until: { type: 'object' as const, required_keys: ['done'], non_empty: ['done'] },
  };
  const result = await workflowUpdate()({
    name: 'loop-probe-update-wf',
    steps: [{ id: 'poll', prompt: 'Start or check the export job.', sideEffect: 'read', loopUntil }],
  });

  assert.match(resultText(result), /updated/);
  assert.deepEqual(readWorkflow('loop-probe-update-wf')!.data.steps[0].loopUntil, loopUntil);
});

test('workflow_update can set webhook and event triggers, and syncs the trigger registry', async () => {
  await workflowCreate()({
    name: 'trigger-update-wf',
    description: 'Handle new lead events.',
    steps: [{ id: 'handle', prompt: 'Handle the lead.' }],
  });

  const result = await workflowUpdate()({
    name: 'trigger-update-wf',
    trigger_webhook_path: 'lead-created',
    trigger_events: [{ type: 'crm.lead.created', dedupeKey: 'lead-{{payload.id}}' }],
  });
  assert.match(resultText(result), /updated/);

  const saved = readWorkflow('trigger-update-wf')!.data;
  assert.equal(saved.trigger.webhookPath, 'lead-created');
  assert.deepEqual(saved.trigger.events, [{ type: 'crm.lead.created', dedupeKey: 'lead-{{payload.id}}' }]);

  const fired = fireWorkflowSystemEvent('crm.lead.created', { id: 'L-1' })
    .filter((r) => r.workflowName === 'trigger-update-wf');
  assert.equal(fired.length, 1);
  assert.equal(fired[0].status, 'queued');
});

test('workflow_run does not queue duplicate active runs for identical inputs', async () => {
  writeAuditWorkflow();

  const first = await workflowRun()({
    name: 'proposal-audit-brief',
    inputs: JSON.stringify({ url: 'https://www.redwood-law.example/' }),
  });
  assert.match(resultText(first), /Queued "/);

  const second = await workflowRun()({
    name: 'proposal-audit-brief',
    inputs: JSON.stringify({ url: 'https://www.redwood-law.example/' }),
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
      invocationTemplate: 'sf data query --target-org alex@corp.example --json --query "{{soql}}"',
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
    { tool: 'composio_execute_tool', slug: 'DATAFORSEO_RANKED_KEYWORDS', args: '{"tool":"DATAFORSEO_RANKED_KEYWORDS","arguments":{"target":"site.example"}}', callId: 'a' },
    { tool: 'run_shell_command', args: '{"command":"python report.py"}', callId: 'b' },
  ]);
  const def = draftToDefinition('zz-promote-test', draft);
  const built = commitAuthoredWorkflow(def, 'zz-promote-test');
  assert.equal(built.ok, true, built.errors.join('; '));
  assert.equal(built.savedDef.enabled, false);
  assert.equal(readWorkflow('zz-promote-test')!.data.steps.length, 2);
});

test('commitAuthoredWorkflow applies the shared create readiness gate', () => {
  const built = commitAuthoredWorkflow({
    name: 'Shared Gate Commit',
    description: 'Send outreach.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'send', prompt: 'Send the emails to the outside prospect list.' }],
  }, 'shared-gate-commit');

  assert.equal(built.ok, true, built.errors.join('; '));
  assert.ok(built.gaps.length > 0, 'readiness gaps are returned to the caller');
  assert.equal(built.savedDef.enabled, false);
  assert.equal(readWorkflow('shared-gate-commit')!.data.enabled, false);
});

test('draftToDefinition preserves inferred forEach loops and list output contracts', () => {
  const draft = traceToWorkflowDraft([
    { tool: 'composio_execute_tool', slug: 'DATAFORSEO_RANKED_KEYWORDS', args: '{"tool":"DATAFORSEO_RANKED_KEYWORDS","arguments":{"target":"alpha.example"}}', callId: 'a' },
    { tool: 'composio_execute_tool', slug: 'DATAFORSEO_RANKED_KEYWORDS', args: '{"tool":"DATAFORSEO_RANKED_KEYWORDS","arguments":{"target":"beta.example"}}', callId: 'b' },
    { tool: 'composio_execute_tool', slug: 'DATAFORSEO_RANKED_KEYWORDS', args: '{"tool":"DATAFORSEO_RANKED_KEYWORDS","arguments":{"target":"gamma.example"}}', callId: 'c' },
  ]);
  const def = draftToDefinition('Fanout Draft', draft);

  assert.equal(def.steps.length, 2);
  assert.equal(def.steps[0].output?.type, 'array');
  assert.deepEqual(def.steps[0].output?.min_items, { '': 1 });
  assert.equal(def.steps[1].forEach, `{{steps.${def.steps[0].id}.output}}`);
  assert.deepEqual(def.steps[1].dependsOn, [def.steps[0].id]);
});

// ─── chat-aware toolkit binding (the acme-facebook-trends fix) ──────────

test('bindDiscussedToolkitsIntoSteps: binds the scrape step to the discussed TOOL (Apify), not the TARGET (Facebook)', () => {
  const steps: any = [
    { id: 'fetch', prompt: 'Find the official Facebook page for corp.example and verify it.', allowedTools: ['composio_*', 'run_shell_command'] },
    { id: 'scrape', prompt: 'Prefer a reliable Apify public Facebook page/posts scraper if configured; otherwise use public web scraping only.', allowedTools: ['composio_*', 'run_shell_command'] },
    { id: 'notify', prompt: 'Notify Alex with the summary.', allowedTools: ['notify_user'] },
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
  assert.equal(steps[0].prompt, 'Find the official Facebook page for corp.example and verify it.');
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

// ─── Cross-turn confirmation journey (the 2026-07-23 live incident, pinned at
// the handler seam) ─────────────────────────────────────────────────────────
// The deleted workflow-run-guard refused a user-CONFIRMED run: the assistant
// proposed "team-activity-slack-updates" BY NAME, the user said "yes please",
// and the guard grepped only USER text for the slug. Its handler wiring was
// never tested with session context, so the refusal path was unreachable in
// tests and seven weeks of green trees hid it. These tests run the REAL
// handler inside withToolOutputContext over a REAL session carrying the real
// conversation — if anyone reintroduces a conversation-text gate on the run
// path, they fail.
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { createSession: createJourneySession, appendEvent: appendJourneyEvent } = await import('../runtime/harness/eventlog.js');

function writeSlackUpdatesWorkflow(): void {
  writeWorkflow('team-activity-slack-updates', {
    name: 'team-activity-slack-updates',
    description: 'Post the daily team activity update to Slack.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'post_update', prompt: 'Compose and post the team activity update.' }],
  });
}

test('journey: assistant proposes by name → user says "yes please" → the run QUEUES', async () => {
  writeSlackUpdatesWorkflow();
  const session = createJourneySession({ kind: 'chat', channel: 'desktop', title: 'confirmation journey' });
  appendJourneyEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'can we run the slack activiy update please' } });
  appendJourneyEvent({ sessionId: session.id, turn: 1, role: 'Clem', type: 'awaiting_user_input', data: { question: 'Should I run the team-activity-slack-updates workflow now?' } });
  appendJourneyEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'yes please' } });

  const result = await withToolOutputContext({ sessionId: session.id, callId: 'journey-confirm-1' }, () =>
    workflowRun()({ name: 'team-activity-slack-updates', inputs: '{}' }));
  const text = resultText(result);
  assert.match(text, /Queued "team-activity-slack-updates"/, `confirmed run must queue, got: ${text.slice(0, 200)}`);
});

// Note: the informed confirm-ONCE beat lives at the BRAIN level (clem-rubric
// WORKFLOW MATCHING) — by the time the brain calls workflow_run the user has
// already confirmed, so the TOOL must queue without re-gating on phrasing.
test('journey: a clear paraphrase with a typo queues directly — no name-confirmation quiz', async () => {
  writeSlackUpdatesWorkflow();
  const session = createJourneySession({ kind: 'chat', channel: 'desktop', title: 'paraphrase journey' });
  appendJourneyEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'can we run the slack activiy update please' } });

  const result = await withToolOutputContext({ sessionId: session.id, callId: 'journey-confirm-2' }, () =>
    workflowRun()({ name: 'team-activity-slack-updates', inputs: '{}' }));
  const text = resultText(result);
  assert.match(text, /Queued "team-activity-slack-updates"/, `paraphrased ask must queue, got: ${text.slice(0, 200)}`);
});
