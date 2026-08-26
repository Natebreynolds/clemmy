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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('required Salesforce account fails closed without provider or CLI execution authority', () => {
  const readiness = checkWorkflowRunReadiness(
    workflowWithResources({ salesforce_org: requiredSalesforceAccount() }),
    FRIDAY_SHAPE_SLUG,
  );

  assert.equal(readiness.ok, false);
  assert.equal(readiness.blockers.length, 1);
  assert.equal(readiness.blockers[0]?.kind, 'cli');
  assert.equal(readiness.blockers[0]?.name, 'sf:salesforce_org');
  assert.equal(readiness.blockers[0]?.status, 'unknown');
  assert.match(readiness.blockers[0]?.reason ?? '', /admitted exact-account read/i);
  assert.match(readiness.blockers[0]?.reason ?? '', /no provider or CLI execution authority/i);
  assert.match(readiness.blockers[0]?.evidence?.[0]?.detail ?? '', /zero provider or CLI process calls/i);
  assert.match(readiness.message, /was not queued/);
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

  assert.equal(readiness.ok, false);
  assert.equal(readiness.blockers[0]?.name, 'sf:salesforce_org');
  assert.equal(readiness.blockers[0]?.status, 'unknown');
  assert.match(readiness.blockers[0]?.reason ?? '', /cannot be verified/i);
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
  assert.match(readiness.warnings[0]?.reason ?? '', /no authoritative local account snapshot/i);
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

  assert.equal(readiness.ok, false);
  assert.equal(readiness.blockers[0]?.name, 'sf:salesforce_org');
  assert.equal(JSON.stringify(resource), before);
});
