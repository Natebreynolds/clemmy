/**
 * Run: npx tsx --test src/agents/subagent-runs.test.ts
 *
 * CLEMENTINE_HOME is redirected to a temp dir BEFORE importing the module, so the
 * store writes never touch the real ~/.clementine-next (BASE_DIR is frozen at import).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-subagent-'));
const { recordSubagentRun, listSubagentRuns, readSubagentOutput, providerClassForModel } = await import('./subagent-runs.js');

test('providerClassForModel classifies all three fan-out lanes', () => {
  assert.equal(providerClassForModel('claude-opus-4-8'), 'claude');
  assert.equal(providerClassForModel('claude-sonnet-4-6'), 'claude');
  assert.equal(providerClassForModel('gpt-5.5'), 'codex');
  assert.equal(providerClassForModel('o3'), 'codex');
  assert.equal(providerClassForModel('glm-5.2'), 'glm');
  assert.equal(providerClassForModel('zai-org/GLM-5.2'), 'glm');
  assert.equal(providerClassForModel(''), 'unknown');
  assert.equal(providerClassForModel('some-unknown-model'), 'unknown');
});

test('recordSubagentRun persists record + full work-product; list + readOutput round-trip', () => {
  const runId = 'wfrun-123';
  const rec = recordSubagentRun({
    id: 'w-1', parentRunId: runId, parentKind: 'workflow', workflowName: 'SEO Audit', stepId: 'audit',
    role: 'research', provider: 'glm', model: 'glm-5.2', task: 'example.com', status: 'ok',
    output: 'full detailed work product here', startedAt: '2026-07-07T00:00:00Z', finishedAt: '2026-07-07T00:01:00Z',
  });
  assert.ok(rec);
  assert.equal(rec!.provider, 'glm');
  assert.equal(rec!.workflowName, 'SEO Audit');
  assert.equal(rec!.outputPreview, 'full detailed work product here');
  assert.ok(rec!.outputRef, 'a non-empty output persists a work-product file');

  const list = listSubagentRuns(runId);
  assert.equal(list.length, 1);
  assert.equal(list[0].task, 'example.com');
  assert.equal(list[0].role, 'research');
  assert.equal(readSubagentOutput(runId, 'w-1'), 'full detailed work product here');
});

test('a run captures ALL providers together (the unified cross-brain view)', () => {
  const runId = 'wfrun-multi';
  recordSubagentRun({ id: 'a', parentRunId: runId, parentKind: 'workflow', provider: 'claude', model: 'claude-sonnet-4-6', task: 'item-a', status: 'ok', output: 'A did the design', startedAt: 't', finishedAt: 't' });
  recordSubagentRun({ id: 'b', parentRunId: runId, parentKind: 'workflow', provider: 'codex', model: 'gpt-5.5', task: 'item-b', status: 'error', output: 'ERROR: failed', startedAt: 't', finishedAt: 't' });
  recordSubagentRun({ id: 'c', parentRunId: runId, parentKind: 'workflow', provider: 'glm', model: 'glm-5.2', task: 'item-c', status: 'capped', output: '', startedAt: 't', finishedAt: 't' });

  const list = listSubagentRuns(runId);
  assert.equal(list.length, 3, 'Claude + Codex + GLM workers all recorded under the one run');
  assert.deepEqual(list.map((r) => r.provider).sort(), ['claude', 'codex', 'glm']);
  assert.deepEqual(list.map((r) => r.status).sort(), ['capped', 'error', 'ok']);
  assert.equal(list.find((r) => r.id === 'c')!.outputRef, undefined, 'an empty output records NO work-product file');
});

test('listSubagentRuns is empty (not a throw) for an unknown run', () => {
  assert.deepEqual(listSubagentRuns('never-existed'), []);
  assert.equal(readSubagentOutput('never-existed', 'nope'), null);
});
