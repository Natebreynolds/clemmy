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
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-workflow-readiness-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

const { partitionWorkflowReadiness, renderWorkflowRunReadinessMessage, renderWorkflowVisualContract } = await import('./workflow-run-readiness.js');
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
