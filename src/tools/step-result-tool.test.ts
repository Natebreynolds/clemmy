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
import { recordStepResult, takeStepResult, clearStepResult, registerStepResultTool } from './step-result-tool.js';
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
