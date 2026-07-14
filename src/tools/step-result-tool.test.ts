/**
 * Run: npx tsx --test src/tools/step-result-tool.test.ts
 *
 * The workflow_step_result store: record/take semantics, JSON coercion,
 * and the registered tool's capture behavior under a session context.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { recordStepResult, takeStepResult, peekStepResult, clearStepResult, recordStepResultFromTranscript, registerStepResultTool } from './step-result-tool.js';
import { withToolOutputContext } from '../runtime/harness/tool-output-context.js';

test('recordStepResult / takeStepResult: take returns once then clears', () => {
  recordStepResult('sess-A', { accounts: [1, 2, 3] });
  const first = takeStepResult('sess-A');
  assert.equal(first.found, true);
  assert.deepEqual(first.value, { accounts: [1, 2, 3] });
  const second = takeStepResult('sess-A');
  assert.equal(second.found, false, 'second take is empty (cleared)');
});

test('takeStepResult distinguishes "no result" from a falsy result', () => {
  assert.equal(takeStepResult('never-set').found, false);
  recordStepResult('sess-empty', '');
  const r = takeStepResult('sess-empty');
  assert.equal(r.found, true);
  assert.equal(r.value, '');
});

test('peekStepResult reads without consuming the workflow result', () => {
  clearStepResult('sess-peek');
  recordStepResult('sess-peek', { ok: true });
  assert.deepEqual(peekStepResult('sess-peek'), { found: true, value: { ok: true } });
  assert.deepEqual(takeStepResult('sess-peek'), { found: true, value: { ok: true } });
  assert.equal(takeStepResult('sess-peek').found, false);
});

test('recordStepResultFromTranscript materializes function-style workflow_step_result text', () => {
  clearStepResult('sess-transcript-fn');
  const ok = recordStepResultFromTranscript(
    'sess-transcript-fn',
    'workflow_step_result({"report":"ok","count":2})',
  );
  assert.equal(ok, true);
  assert.deepEqual(takeStepResult('sess-transcript-fn'), { found: true, value: { report: 'ok', count: 2 } });
});

test('recordStepResultFromTranscript materializes Claude XML workflow_step_result text', () => {
  clearStepResult('sess-transcript-xml');
  const ok = recordStepResultFromTranscript('sess-transcript-xml', [
    'Calling `workflow_step_result` with the required payload now.',
    '<function_calls>',
    '<invoke name="workflow_step_result">',
    '<parameter name="report">ok</parameter>',
    '<parameter name="ok">true</parameter>',
    '</invoke>',
    '</function_calls>',
  ].join('\n'));
  assert.equal(ok, true);
  assert.deepEqual(takeStepResult('sess-transcript-xml'), { found: true, value: { report: 'ok', ok: true } });
});

test('recordStepResultFromTranscript ignores non-structural fake tool calls', () => {
  clearStepResult('sess-transcript-shell');
  const ok = recordStepResultFromTranscript('sess-transcript-shell', [
    '<function_calls>',
    '<invoke name="run_shell_command">',
    '<parameter name="command">rm -rf /tmp/nope</parameter>',
    '</invoke>',
    '</function_calls>',
  ].join('\n'));
  assert.equal(ok, false);
  assert.equal(takeStepResult('sess-transcript-shell').found, false);
});

test('results are isolated per session (concurrency safety)', () => {
  recordStepResult('s1', { v: 1 });
  recordStepResult('s2', { v: 2 });
  assert.deepEqual(takeStepResult('s2').value, { v: 2 });
  assert.deepEqual(takeStepResult('s1').value, { v: 1 });
});

// ── the registered tool (capture path) ──────────────────────────────

function captureTool() {
  let captured: { handler: (a: { data: string }) => Promise<unknown> } | undefined;
  const fakeServer = {
    tool(_name: string, _desc: string, _params: z.ZodRawShape, handler: (a: { data: string }) => Promise<unknown>) {
      captured = { handler };
    },
  } as unknown as McpServer;
  registerStepResultTool(fakeServer);
  if (!captured) throw new Error('tool not registered');
  return captured;
}

test('tool coerces a JSON-string payload into a structured object', async () => {
  const { handler } = captureTool();
  clearStepResult('sess-json');
  await withToolOutputContext({ sessionId: 'sess-json', toolName: 'workflow_step_result' }, () =>
    handler({ data: JSON.stringify({ rows: [{ id: 1 }], total: 1 }) }),
  );
  const r = takeStepResult('sess-json');
  assert.equal(r.found, true);
  assert.deepEqual(r.value, { rows: [{ id: 1 }], total: 1 });
});

test('tool keeps a plain-text payload as a string (narrative steps)', async () => {
  const { handler } = captureTool();
  clearStepResult('sess-text');
  await withToolOutputContext({ sessionId: 'sess-text', toolName: 'workflow_step_result' }, () =>
    handler({ data: 'Drafted 10 emails; all held for review.' }),
  );
  const r = takeStepResult('sess-text');
  assert.equal(r.value, 'Drafted 10 emails; all held for review.');
});

test('tool without a session context does not record (runner falls back to prose)', async () => {
  const { handler } = captureTool();
  const res = await handler({ data: '{"x":1}' }); // no withToolOutputContext
  assert.match(String((res as { content?: { text?: string }[] }).content?.[0]?.text ?? res), /no step context/i);
});

// ── Self-heal move 2: submission-time contract gate (2026-07-14) ─────────────
test('submission gate: wrong-shape result is refused with the exact problems, then bounded-accepted', async () => {
  const { registerStepContract, clearStepContract, recordStepResult, takeStepResult } = await import('./step-result-tool.js');
  const { verifyStepOutput } = await import('../execution/step-output-verify.js');
  const contract = {
    type: 'object' as const,
    required_keys: ['key_findings', 'sources'],
    min_items: { key_findings: 1, sources: 1 },
  };
  // The live failure shapes: a stringified JSON (unparsed) and an object-not-array.
  assert.equal(verifyStepOutput(contract, '{"key_findings": bad json').ok, false);
  assert.equal(verifyStepOutput(contract, { key_findings: { summary: 'x' }, sources: ['a'] }).ok, false);
  assert.equal(verifyStepOutput(contract, { key_findings: ['finding'], sources: ['url'] }).ok, true);
  // Registry lifecycle is exercised through the exported surface.
  registerStepContract('sess-gate', contract);
  clearStepContract('sess-gate');
  recordStepResult('sess-gate', { ok: true });
  assert.equal(takeStepResult('sess-gate').found, true);
});

test('classifyContractProblems: shape-under-min_items is output_contract, true emptiness is empty_output', async () => {
  const { classifyContractProblems } = await import('../execution/step-output-verify.js');
  // The live misdiagnosis: real data present, wrong shape → must be Doctor-routable.
  assert.equal(classifyContractProblems(['min_items: output "key_findings" is not an array (cannot count items)']), 'output_contract');
  assert.equal(classifyContractProblems(['min_items: output "sources" has 0 item(s), needs at least 1']), 'empty_output');
  assert.equal(classifyContractProblems(['non_empty: output "sources" is empty (no data produced)']), 'empty_output');
  assert.equal(classifyContractProblems(['expected output of type "object" but got string']), 'output_contract');
});

test('renderOutputContractSpec names every gated key with its type — the anti-drift injection', async () => {
  const { renderOutputContractSpec } = await import('../execution/step-output-verify.js');
  const spec = renderOutputContractSpec({
    type: 'object',
    required_keys: ['scraper_used', 'key_findings', 'sources', 'source_errors'],
    non_empty: ['sources', 'key_findings'],
    min_items: { sources: 1, key_findings: 1 },
    verify: { url_present: ['source_page_url'] },
  });
  for (const must of ['JSON OBJECT', 'scraper_used', 'key_findings', 'sources', 'source_errors', 'ARRAY with at least 1', 'http(s) URL', 'blocked']) {
    assert.ok(spec.includes(must), `spec must mention ${must}`);
  }
});
