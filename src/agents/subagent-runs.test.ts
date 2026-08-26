/**
 * Run: npx tsx --test src/agents/subagent-runs.test.ts
 *
 * CLEMENTINE_HOME is redirected to a temp dir BEFORE importing the module, so the
 * store writes never touch the real ~/.clementine-next (BASE_DIR is frozen at import).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-subagent-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
const {
  SUBAGENT_OUTPUT_MAX_BYTES,
  recordSubagentRun,
  listSubagentRuns,
  readSubagentOutput,
  providerClassForModel,
  findCompletedSubagentOutput,
} = await import('./subagent-runs.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

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

test('successful outputs are lossless at 65,536 and 65,537 bytes, including after a fresh process import', () => {
  const sentinel = 'FINAL_TAIL_SENTINEL=accepted-65537';
  for (const size of [65_536, 65_537]) {
    const runId = `wfrun-boundary-${size}`;
    const output = `${'x'.repeat(size - sentinel.length)}${sentinel}`;
    const rec = recordSubagentRun({
      id: `big-${size}`, parentRunId: runId, parentKind: 'workflow', provider: 'claude', model: 'claude-sonnet-4-6',
      task: 'boundary', packetKey: `pk-${size}`, status: 'ok', output, startedAt: 't', finishedAt: 't',
    });
    assert.ok(rec);
    assert.equal(rec!.outputBytes, size, 'ledger records the exact UTF-8 byte count');
    assert.equal(rec!.outputSha256, createHash('sha256').update(output, 'utf8').digest('hex'));
    assert.equal(rec!.outputComplete, true);
    assert.equal(readSubagentOutput(runId, `big-${size}`), output);
    assert.equal(findCompletedSubagentOutput(runId, 'boundary', `pk-${size}`), output);
  }

  // Process-like reopen: a new module graph/process must validate and recover the
  // same 65,537-byte payload from disk, including its load-bearing final field.
  const moduleUrl = new URL('./subagent-runs.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, [
    '--import=tsx',
    '--input-type=module',
    '--eval',
    [
      `const { findCompletedSubagentOutput } = await import(${JSON.stringify(moduleUrl)});`,
      `const output = findCompletedSubagentOutput('wfrun-boundary-65537', 'boundary', 'pk-65537');`,
      `process.stdout.write(JSON.stringify({ bytes: Buffer.byteLength(output ?? '', 'utf8'), tail: output?.endsWith(${JSON.stringify(sentinel)}) ?? false }));`,
    ].join('\n'),
  ], {
    cwd: process.cwd(),
    env: { ...process.env, CLEMENTINE_HOME: TMP_HOME },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr || 'fresh-process read failed');
  assert.deepEqual(JSON.parse(child.stdout), { bytes: 65_537, tail: true });
});

test('integrity metadata rejects a corrupted payload instead of reusing a successful prefix', () => {
  const runId = 'wfrun-corrupt';
  const rec = recordSubagentRun({
    id: 'corrupt-me', parentRunId: runId, parentKind: 'session', provider: 'codex', model: 'gpt-5.5',
    task: 'integrity item', packetKey: 'pk-integrity', status: 'ok', output: 'complete result\nFINAL=42', startedAt: 't', finishedAt: 't',
  });
  assert.ok(rec?.outputRef);
  writeFileSync(path.join(TMP_HOME, 'state', 'subagents', runId, rec!.outputRef!), 'complete result\n', 'utf8');
  assert.equal(readSubagentOutput(runId, 'corrupt-me'), null, 'byte/hash mismatch is typed unavailable');
  assert.equal(findCompletedSubagentOutput(runId, 'integrity item', 'pk-integrity'), null, 'resume re-executes instead of accepting the prefix');
});

test('a pathological output above the durable ceiling is typed incomplete and stores no successful prefix', () => {
  const runId = 'wfrun-over-durable-ceiling';
  const output = `${'z'.repeat(SUBAGENT_OUTPUT_MAX_BYTES)}!`;
  const rec = recordSubagentRun({
    id: 'too-large', parentRunId: runId, parentKind: 'session', provider: 'glm', model: 'glm-5.2',
    task: 'oversize item', packetKey: 'pk-oversize', status: 'ok', output, startedAt: 't', finishedAt: 't',
  });
  assert.ok(rec);
  assert.equal(rec!.outputBytes, SUBAGENT_OUTPUT_MAX_BYTES + 1);
  assert.equal(rec!.outputSha256, createHash('sha256').update(output, 'utf8').digest('hex'));
  assert.equal(rec!.outputComplete, false);
  assert.equal(rec!.outputRef, undefined, 'no prefix file is advertised as a result handle');
  assert.equal(readSubagentOutput(runId, 'too-large'), null);
  assert.equal(findCompletedSubagentOutput(runId, 'oversize item', 'pk-oversize'), null, 'resume gets typed unavailable/reexecution, never a prefix');
});

test('legacy 64KiB truncation markers are never promoted to a completed resume result', () => {
  const runId = 'wfrun-legacy-truncated';
  const dir = path.join(TMP_HOME, 'state', 'subagents', runId);
  mkdirSync(path.join(dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(dir, 'outputs', 'legacy.txt'), `${'x'.repeat(65_536)}\n…(truncated)`, 'utf8');
  writeFileSync(path.join(dir, 'runs.jsonl'), `${JSON.stringify({
    id: 'legacy', parentRunId: runId, parentKind: 'session', provider: 'claude', model: 'm',
    task: 'legacy item', packetKey: 'pk-legacy', status: 'ok', outputPreview: 'xxx',
    outputRef: 'outputs/legacy.txt', startedAt: 't', finishedAt: 't',
  })}\n`, 'utf8');
  assert.equal(readSubagentOutput(runId, 'legacy'), null);
  assert.equal(findCompletedSubagentOutput(runId, 'legacy item', 'pk-legacy'), null);
});

test('listSubagentRuns is empty (not a throw) for an unknown run', () => {
  assert.deepEqual(listSubagentRuns('never-existed'), []);
  assert.equal(readSubagentOutput('never-existed', 'nope'), null);
});

// ── Wave 4 Stage 1: reuse a completed worker's output on resume ──────────────

test('findCompletedSubagentOutput returns the most-recent OK output for an item; null for none/failed', () => {
  const runId = 'wfrun-resume';
  recordSubagentRun({
    id: 'r1', parentRunId: runId, parentKind: 'session', provider: 'claude', model: 'claude-opus-4-8',
    task: 'Firm A — firm-a.example', status: 'ok', output: 'RESULT A: contact found alice@firm-a.example', startedAt: 't', finishedAt: 't',
  });
  recordSubagentRun({
    id: 'r2', parentRunId: runId, parentKind: 'session', provider: 'codex', model: 'gpt-5.5',
    task: 'Firm B — firm-b.example', status: 'error', output: 'ERROR: no email', startedAt: 't', finishedAt: 't',
  });

  // Exact-match retrieval of the completed item's full work-product.
  assert.equal(findCompletedSubagentOutput(runId, 'Firm A — firm-a.example'), 'RESULT A: contact found alice@firm-a.example');
  // Case/space-folded match (resumed label round-trips, but be robust).
  assert.equal(findCompletedSubagentOutput(runId, 'firm a — firm-a.example'), 'RESULT A: contact found alice@firm-a.example');
  // A FAILED item has no reusable output → null (it must be retried on resume).
  assert.equal(findCompletedSubagentOutput(runId, 'Firm B — firm-b.example'), null);
  // Unknown item / unknown run → null, never a throw.
  assert.equal(findCompletedSubagentOutput(runId, 'Firm Z'), null);
  assert.equal(findCompletedSubagentOutput('never-existed', 'Firm A — firm-a.example'), null);
});

test('findCompletedSubagentOutput returns the LATEST ok run when an item completed more than once', () => {
  const runId = 'wfrun-resume-2';
  recordSubagentRun({
    id: 's1', parentRunId: runId, parentKind: 'session', provider: 'claude', model: 'm',
    task: 'X', status: 'ok', output: 'first', startedAt: 't', finishedAt: 't',
  });
  recordSubagentRun({
    id: 's2', parentRunId: runId, parentKind: 'session', provider: 'claude', model: 'm',
    task: 'X', status: 'ok', output: 'second', startedAt: 't', finishedAt: 't',
  });
  assert.equal(findCompletedSubagentOutput(runId, 'X'), 'second');
});

test('findCompletedSubagentOutput: matches by PACKET KEY so two distinct packets sharing an item label never cross-contaminate (Defect 1)', () => {
  const runId = 'wfrun-multiphase';
  // Multi-phase over the same entity: research acme.example, then draft outreach for
  // acme.example — same item label, DIFFERENT packet keys.
  recordSubagentRun({
    id: 'ph1', parentRunId: runId, parentKind: 'session', provider: 'claude', model: 'm',
    task: 'acme.example', packetKey: 'pk_research', status: 'ok', output: 'RESEARCH: 40 employees, Series B', startedAt: 't', finishedAt: 't',
  });
  recordSubagentRun({
    id: 'ph2', parentRunId: runId, parentKind: 'session', provider: 'claude', model: 'm',
    task: 'acme.example', packetKey: 'pk_outreach', status: 'ok', output: 'DRAFT EMAIL: Hi Acme team...', startedAt: 't', finishedAt: 't',
  });
  // Resuming phase 1 must reuse the RESEARCH output, not the later outreach draft.
  assert.equal(findCompletedSubagentOutput(runId, 'acme.example', 'pk_research'), 'RESEARCH: 40 employees, Series B');
  assert.equal(findCompletedSubagentOutput(runId, 'acme.example', 'pk_outreach'), 'DRAFT EMAIL: Hi Acme team...');
  // A packet key with no matching record → null (re-execute), never a wrong-phase reuse.
  assert.equal(findCompletedSubagentOutput(runId, 'acme.example', 'pk_unknown'), null);
});

test('findCompletedSubagentOutput: an ok run with NO persisted output → null (re-execute, never a placeholder/preview) (F4/Defect 3)', () => {
  const runId = 'wfrun-nooutput';
  recordSubagentRun({
    id: 'e1', parentRunId: runId, parentKind: 'session', provider: 'claude', model: 'm',
    task: 'Empty', packetKey: 'pk_empty', status: 'ok', output: '', startedAt: 't', finishedAt: 't',
  });
  assert.equal(findCompletedSubagentOutput(runId, 'Empty', 'pk_empty'), null, 'no work-product → caller re-executes');
});
