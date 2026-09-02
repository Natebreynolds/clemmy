/**
 * Run: npx tsx --test src/execution/workflow-run-readiness.test.ts
 *
 * The readiness check is a GATE on every queue path (chat / scheduler / webhook
 * / mobile). These cover the blocker/warning partition directly so the gate
 * only hard-blocks on authoritatively-missing capabilities and never on the
 * incomplete local tool catalog — otherwise a plain `allowedTools: ['*']` or a
 * tool outside LOCAL_MCP_TOOL_NAMES would refuse a runnable (or scheduled) run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { WorkflowDefinition, WorkflowResourceBinding } from '../memory/workflow-store.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-workflow-readiness-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

const {
  buildWorkflowReadinessInventory,
  checkWorkflowRunReadiness,
  partitionWorkflowReadiness,
  renderWorkflowRunReadinessMessage,
  renderWorkflowVisualContract,
} = await import('./workflow-run-readiness.js');
const { provisionReviewedCliReadDescriptor } = await import('../runtime/harness/reviewed-cli-read-config.js');
type ReadinessItem = Parameters<typeof partitionWorkflowReadiness>[0][number];

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function item(partial: Partial<ReadinessItem> & { kind: ReadinessItem['kind']; name: string; status: ReadinessItem['status'] }): ReadinessItem {
  return {
    reason: partial.reason ?? '',
    stepIds: partial.stepIds ?? ['s1'],
    kind: partial.kind,
    name: partial.name,
    status: partial.status,
    sources: partial.sources,
    evidence: partial.evidence,
  };
}

const FRIDAY_SHAPE_SLUG = 'daily-dashboard-refresh-shape';
const fridayShapeScriptsDir = path.join(
  TMP_HOME,
  'vault',
  '00-System',
  'workflows',
  FRIDAY_SHAPE_SLUG,
  'scripts',
);
mkdirSync(fridayShapeScriptsDir, { recursive: true });
writeFileSync(path.join(fridayShapeScriptsDir, 'refresh.mjs'), 'process.stdout.write("{}\\n");\n', 'utf8');

function workflowWithResources(resources: Record<string, WorkflowResourceBinding>): WorkflowDefinition {
  return {
    name: FRIDAY_SHAPE_SLUG,
    description: 'Refresh a dashboard from a required source account.',
    enabled: true,
    trigger: { type: 'schedule', schedule: '0 7 * * *' },
    resources,
    steps: [{
      id: 'refresh',
      prompt: 'Refresh the dashboard.',
      sideEffect: 'read',
    }],
  };
}

function requiredSalesforceAccount(account = 'ops@example.test'): WorkflowResourceBinding {
  return {
    id: 'salesforce_org',
    kind: 'account',
    cli: 'sf',
    account,
    required: true,
  };
}

test('a missing plain tool (incl. the "*" grant) is a WARNING, never a blocker', () => {
  const { blockers, warnings } = partitionWorkflowReadiness([
    item({ kind: 'tool', name: '*', status: 'missing' }),
    item({ kind: 'tool', name: 'web_search', status: 'missing' }),
  ]);
  assert.equal(blockers.length, 0);
  assert.equal(warnings.length, 2);
});

test('missing CLI / MCP / composio inform but do not block', () => {
  const { blockers, warnings } = partitionWorkflowReadiness([
    item({ kind: 'cli', name: 'gh', status: 'missing' }),
    item({ kind: 'mcp', name: 'mcp__foo__bar', status: 'missing' }),
    item({ kind: 'composio', name: 'SALESFORCE_GET_RECORDS', status: 'unknown' }),
  ]);
  assert.equal(blockers.length, 0);
  assert.equal(warnings.length, 3);
});

test('a missing skill, workflow-local script, or local project IS an authoritative blocker', () => {
  const { blockers, warnings } = partitionWorkflowReadiness([
    item({ kind: 'skill', name: 'outreach-writer', status: 'missing' }),
    item({ kind: 'script', name: 'merge.py', status: 'missing' }),
    item({ kind: 'project', name: 'client-portal', status: 'missing' }),
    item({ kind: 'tool', name: 'web_search', status: 'missing' }),
  ]);
  assert.deepEqual(blockers.map((b) => b.name).sort(), ['client-portal', 'merge.py', 'outreach-writer']);
  assert.deepEqual(warnings.map((w) => w.name), ['web_search']);
});

test('ready items are neither blockers nor warnings', () => {
  const { blockers, warnings } = partitionWorkflowReadiness([
    item({ kind: 'tool', name: 'read_file', status: 'ready' }),
    item({ kind: 'skill', name: 'installed-skill', status: 'ready' }),
  ]);
  assert.equal(blockers.length, 0);
  assert.equal(warnings.length, 0);
});

// A script's presence certifies stored bytes, not the filesystem/network/CLI
// authority of the body it would launch. Legacy declarations therefore remain
// inspectable but are never queue-ready, whether or not the file exists.
test('deterministic.runner readiness is the script\'s presence: present is ready, missing names the file', () => {
  const slug = 'owner-deterministic-readiness-shape';
  const scriptsDir = path.join(TMP_HOME, 'vault', '00-System', 'workflows', slug, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(path.join(scriptsDir, 'refresh.mjs'), 'process.stdout.write("{}\\n");\n', 'utf8');

  const withScript: WorkflowDefinition = {
    name: slug,
    description: 'Refresh the dashboard from the existing script.',
    enabled: true,
    trigger: { type: 'schedule', schedule: '0 7 * * *' },
    steps: [{ id: 'refresh', prompt: '', sideEffect: 'read', deterministic: { runner: 'refresh.mjs' } }],
  };
  const present = checkWorkflowRunReadiness(withScript, slug);
  assert.equal(present.ok, true, JSON.stringify(present.blockers));

  const missingScript: WorkflowDefinition = {
    ...withScript,
    steps: [{ id: 'refresh', prompt: '', sideEffect: 'read', deterministic: { runner: 'does-not-exist.mjs' } }],
  };
  const blocked = checkWorkflowRunReadiness(missingScript, slug);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blockers.length, 1);
  assert.equal(blocked.blockers[0]?.kind, 'script');
  assert.equal(blocked.blockers[0]?.name, 'does-not-exist.mjs');
  assert.doesNotMatch(blocked.blockers[0]?.reason ?? '', /raw_subprocess|migrat/i);
});

test('workflow readiness does not advertise the removed program executor', () => {
  const inventory = buildWorkflowReadinessInventory();
  assert.ok(!inventory.availableTools?.includes('run_tool_program'), 'the subtracted program surface is not advertised');
});

test('targetStepId scopes the partition to that step only', () => {
  const items = [
    item({ kind: 'skill', name: 'skill-a', status: 'missing', stepIds: ['a'] }),
    item({ kind: 'skill', name: 'skill-b', status: 'missing', stepIds: ['b'] }),
  ];
  const { blockers } = partitionWorkflowReadiness(items, 'b');
  assert.deepEqual(blockers.map((b) => b.name), ['skill-b']);
});

test('message reads as PASSED when there are no blockers and no warnings', () => {
  const msg = renderWorkflowRunReadinessMessage('wf', [], []);
  assert.match(msg, /readiness preflight passed/);
});

test('message surfaces warnings without refusing the run', () => {
  const msg = renderWorkflowRunReadinessMessage('wf', [], [item({ kind: 'tool', name: 'web_search', status: 'missing', reason: 'not in catalog' })]);
  assert.match(msg, /unconfirmed capabilit/);
  assert.doesNotMatch(msg, /was not queued/);
});

test('message explains the block when an authoritative capability is missing', () => {
  const msg = renderWorkflowRunReadinessMessage('wf', [item({ kind: 'skill', name: 'outreach-writer', status: 'missing', reason: 'not installed' })]);
  assert.match(msg, /was not queued/);
  assert.match(msg, /outreach-writer/);
});

test('message includes requirement source and local evidence when available', () => {
  const msg = renderWorkflowRunReadinessMessage('wf', [], [item({
    kind: 'cli',
    name: 'cli:gh',
    status: 'missing',
    reason: 'CLI "gh" was not found in the local CLI inventory.',
    sources: ['step_allowed_tool'],
    evidence: [{ kind: 'cli_command', name: 'gh', status: 'missing', detail: 'not found in local CLI inventory' }],
  })]);
  assert.match(msg, /via step tools/);
  assert.match(msg, /cli_command:gh=missing/);
});

test('renderWorkflowVisualContract summarizes blocking and warning checks for authoring', () => {
  const msg = renderWorkflowVisualContract({
    status: 'blocked',
    summary: '1 contract blocker must be fixed before this workflow is reliable.',
    passCount: 2,
    warningCount: 1,
    blockedCount: 1,
    checks: [
      {
        kind: 'structure',
        status: 'pass',
        label: 'Graph structure',
        detail: 'DAG has 2 execution levels across 2 steps.',
        stepIds: [],
        evidence: [],
      },
      {
        kind: 'tool_readiness',
        status: 'block',
        label: 'Tool readiness',
        detail: '1 missing and 0 unknown tool surface items.',
        stepIds: ['render'],
        evidence: ['missing: script render.py'],
      },
      {
        kind: 'model_portability',
        status: 'warn',
        label: 'Model portability',
        detail: '1 step pins exact models.',
        stepIds: ['draft'],
        evidence: ['Step "draft" pins model "gpt-5-codex".'],
      },
    ],
    remediations: [
      {
        kind: 'add_workflow_script',
        status: 'block',
        title: 'Add workflow script render.py',
        detail: 'Add render.py under scripts/.',
        stepIds: ['render'],
        evidence: ['missing: script render.py'],
      },
      {
        kind: 'make_models_portable',
        status: 'warn',
        title: 'Remove exact model pins',
        detail: 'Use workflow_update with portable_models=true.',
        stepIds: ['draft'],
        evidence: ['Step "draft" pins model "gpt-5-codex".'],
      },
    ],
  });
  assert.match(msg, /Workflow visual contract: BLOCKED \(1 block, 1 warning, 2 pass\)/);
  assert.match(msg, /\[BLOCK\] Tool readiness/);
  assert.match(msg, /Steps: render/);
  assert.match(msg, /missing: script render.py/);
  assert.match(msg, /\[WARN\] Model portability/);
  assert.match(msg, /Recommended contract fixes:/);
  assert.match(msg, /\[BLOCK\] Add workflow script render.py/);
  assert.match(msg, /\[WARN\] Remove exact model pins/);
  assert.doesNotMatch(msg, /\[PASS\] Graph structure/);
});

test('required Salesforce account warns and admits without provider or CLI execution authority', () => {
  const readiness = checkWorkflowRunReadiness(
    workflowWithResources({ salesforce_org: requiredSalesforceAccount() }),
    FRIDAY_SHAPE_SLUG,
  );

  assert.equal(readiness.ok, true);
  assert.equal(readiness.blockers.length, 0);
  assert.equal(readiness.warnings.length, 1);
  assert.equal(readiness.warnings[0]?.kind, 'cli');
  assert.equal(readiness.warnings[0]?.name, 'sf:salesforce_org');
  assert.equal(readiness.warnings[0]?.status, 'unknown');
  assert.match(readiness.warnings[0]?.reason ?? '', /admitted exact-account read/i);
  assert.match(readiness.warnings[0]?.reason ?? '', /no provider or CLI execution authority/i);
  assert.match(readiness.warnings[0]?.evidence?.[0]?.detail ?? '', /zero provider or CLI process calls/i);
  assert.doesNotMatch(readiness.message, /was not queued/);
});

test('binary registration and generic auth-health cache do not attest an exact Salesforce org', () => {
  const stateDir = path.join(TMP_HOME, 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'connected-clis.json'), JSON.stringify({
    version: 'v1',
    entries: {
      salesforce: {
        id: 'salesforce',
        command: 'sf',
        vendor: 'Salesforce',
        name: 'Salesforce CLI',
        installedAt: '2026-08-25T09:00:00.000Z',
        authDocsUrl: 'https://example.test/salesforce-auth',
      },
    },
  }), 'utf8');
  writeFileSync(path.join(stateDir, 'cli-auth-health.json'), JSON.stringify({
    version: 'v1',
    entries: {
      salesforce: {
        id: 'salesforce',
        command: 'sf',
        installed: true,
        authStatus: 'ok',
        username: 'ops@example.test',
        checkedAt: '2026-08-25T09:00:00.000Z',
      },
    },
  }), 'utf8');

  const readiness = checkWorkflowRunReadiness(
    workflowWithResources({ salesforce_org: requiredSalesforceAccount() }),
    FRIDAY_SHAPE_SLUG,
  );

  assert.equal(readiness.ok, true);
  assert.equal(readiness.blockers.length, 0);
  assert.equal(readiness.warnings[0]?.name, 'sf:salesforce_org');
  assert.equal(readiness.warnings[0]?.status, 'unknown');
  assert.match(readiness.warnings[0]?.reason ?? '', /cannot be verified/i);
});

test('unsupported required account CLI is an informative warning, not a blocker', () => {
  const readiness = checkWorkflowRunReadiness(
    workflowWithResources({
      source_account: {
        id: 'source_account',
        kind: 'account',
        cli: 'future-crm',
        account: 'ops@example.test',
        required: true,
      },
    }),
    FRIDAY_SHAPE_SLUG,
  );

  assert.equal(readiness.ok, true);
  assert.equal(readiness.blockers.length, 0);
  assert.equal(readiness.warnings.length, 1);
  assert.match(readiness.warnings[0]?.reason ?? '', /admitted exact-account read/i);
});

test('non-required account resources do not participate in readiness', () => {
  const account = requiredSalesforceAccount();
  account.required = false;
  const readiness = checkWorkflowRunReadiness(
    workflowWithResources({ salesforce_org: account }),
    FRIDAY_SHAPE_SLUG,
  );

  assert.equal(readiness.ok, true);
  assert.equal(readiness.blockers.length, 0);
  assert.equal(readiness.warnings.length, 0);
});

test('an invalid required Salesforce selector is a typed blocker, never a command argument', () => {
  const readiness = checkWorkflowRunReadiness(
    workflowWithResources({
      salesforce_org: requiredSalesforceAccount('--json; touch /tmp/not-allowed'),
    }),
    FRIDAY_SHAPE_SLUG,
  );

  assert.equal(readiness.ok, false);
  assert.equal(readiness.blockers.length, 1);
  assert.equal(readiness.blockers[0]?.status, 'unknown');
  assert.match(readiness.blockers[0]?.reason ?? '', /selector is missing or invalid/i);
});

test('Salesforce readiness is local-only and does not mutate the binding', () => {
  const resource = Object.freeze(requiredSalesforceAccount('alias-1'));
  const before = JSON.stringify(resource);
  const readiness = checkWorkflowRunReadiness(
    workflowWithResources({ salesforce_org: resource }),
    FRIDAY_SHAPE_SLUG,
  );

  assert.equal(readiness.ok, true);
  assert.equal(readiness.warnings[0]?.name, 'sf:salesforce_org');
  assert.equal(JSON.stringify(resource), before);
});

// ── Inventory = the executor's own registries ───────────────────────────────
// Certification said READY while the execution plan called the very same call
// steps "missing": readiness was reading the CLI-lane registry projection, not
// the registries the workflow call carrier dispatches from. The connection
// pinned here is "what the carrier can dispatch == what readiness counts as
// present" for BOTH carriers: a reviewed-CLI read descriptor (durable file)
// and a registry tool with a reviewed in-process execution contract.

test('reviewed CLI read operations and reviewed-local registry tools are ready in the inventory', async () => {
  const executable = path.join(TMP_HOME, 'reviewed-cli-readiness-bin');
  writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write('{}');\n`, 'utf8');
  chmodSync(executable, 0o700);
  await provisionReviewedCliReadDescriptor({
    version: 1,
    descriptorId: 'salesforce-soql-readiness',
    operationId: 'salesforce_sf_soql_query',
    displayName: 'SOQL query',
    description: 'Run a read-only SOQL query against the default org.',
    effect: 'read',
    accountId: 'reviewed_cli:host',
    executablePath: executable,
    argvPrefix: ['data', 'query', '--json'],
    arguments: [{ name: 'query', kind: 'option', token: '--query', valueType: 'string', required: true }],
    limits: { timeoutMs: 2_000, maxStdoutBytes: 16_384, maxStderrBytes: 4_096, maxArgumentBytes: 4_096 },
  });

  const inventory = buildWorkflowReadinessInventory();
  assert.ok(inventory.availableTools?.includes('salesforce_sf_soql_query'),
    'a sealed reviewed-CLI read descriptor is a dispatchable operation, so it is present');
  assert.ok(inventory.availableTools?.includes('space_set_data'),
    'a registry tool with localExecution is dispatched by the call carrier regardless of lane, so it is present');

  const def: WorkflowDefinition = {
    name: 'crm-dashboard-refresh-shape',
    description: 'Query the CRM and commit the dataset to a workspace.',
    enabled: true,
    trigger: { type: 'manual' },
    steps: [
      {
        id: 'query',
        prompt: 'Query open opportunities.',
        sideEffect: 'read',
        call: { tool: 'salesforce_sf_soql_query', args: { query: 'SELECT Id FROM Opportunity' } },
      },
      {
        id: 'publish',
        prompt: 'Commit the dataset.',
        sideEffect: 'write',
        dependsOn: ['query'],
        call: { tool: 'space_set_data', args: { slug: 'crm-dashboard', source: 'open', data_json: '{{steps.query.output}}' } },
      },
    ],
  };
  const readiness = checkWorkflowRunReadiness(def, 'crm-dashboard-refresh-shape');
  const byName = new Map(readiness.plan.toolReadiness.items.map((item) => [item.name, item]));
  assert.equal(byName.get('salesforce_sf_soql_query')?.status, 'ready');
  assert.deepEqual(byName.get('salesforce_sf_soql_query')?.sources, ['step_call']);
  assert.equal(byName.get('space_set_data')?.status, 'ready');
  assert.deepEqual(byName.get('space_set_data')?.sources, ['step_call']);
  assert.equal(readiness.plan.toolReadiness.missingCount, 0);
  assert.equal(readiness.plan.toolReadiness.ready, true);
  assert.equal(readiness.plan.visualContract.checks.find((check) => check.kind === 'tool_readiness')?.status, 'pass');
  assert.equal(readiness.ok, true);
  assert.deepEqual(readiness.blockers, []);
  assert.deepEqual(readiness.warnings, []);
});

test('a malformed reviewed-CLI descriptor registry contributes nothing and never fails the preflight', () => {
  const file = path.join(TMP_HOME, 'state', 'reviewed-cli-read-descriptors.json');
  const original = readFileSync(file, 'utf8');
  try {
    writeFileSync(file, '{not json', 'utf8');
    const inventory = buildWorkflowReadinessInventory();
    assert.equal(inventory.availableTools?.includes('salesforce_sf_soql_query'), false);
    assert.ok(inventory.availableTools?.includes('space_set_data'),
      'the registry-derived names do not depend on the descriptor file');
  } finally {
    writeFileSync(file, original, 'utf8');
  }
});
