/**
 * Run: npx tsx --test src/runtime/harness/fallback-model-telemetry.test.ts
 *
 * WS2 correlation fix: a model_fallover must carry the session/workflow-run it
 * happened in, so the dashboard can attribute a brain switch to the run that
 * triggered it. Isolated CLEMENTINE_HOME so the operational write lands in temp
 * (this file is separate from fallback-model.test.ts precisely so the env is set
 * BEFORE the module — and thus BASE_DIR — is imported).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-fallover-tel-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { withModelFallback } = await import('./fallback-model.js');
const { listOperationalEvents } = await import('../operational-telemetry.js');
type FallbackTarget = import('./fallback-model.js').FallbackTarget;

function req(): ModelRequest {
  return { input: 'hi', modelSettings: {}, tools: [], handoffs: [] } as unknown as ModelRequest;
}
function resp(text: string): ModelResponse {
  return { output: [{ type: 'message', content: text }], usage: {} } as unknown as ModelResponse;
}
function model(impl: Partial<Model>): Model {
  return {
    getResponse: impl.getResponse ?? (async () => resp('ok')),
    getStreamedResponse: impl.getStreamedResponse ?? (async function* () {
      yield { type: 'response_done', response: { output: [{ type: 'message' }] } } as never;
    }),
  } as Model;
}
function target(label: string, m: Model): FallbackTarget {
  return { label, getModel: () => m };
}

test('model_fallover telemetry carries sessionId + workflowRunId + stage=router', async () => {
  const overloaded = model({ getResponse: async () => { throw { statusCode: 529, message: 'overloaded_error' }; } });
  const healthy = model({ getResponse: async () => resp('recovered') });
  const chain = [target('primary', overloaded), target('backup', healthy)];

  const fb = withModelFallback(chain, { sessionId: 'sess-fb-1', workflowRunId: 'run-fb-1' });
  const out = await fb.getResponse(req());
  assert.ok(out, 'the chain recovered on the healthy backup');

  const rows = listOperationalEvents({ sessionId: 'sess-fb-1', limit: 20 }).filter((e) => e.type === 'model_fallover');
  assert.equal(rows.length, 1, 'exactly one model_fallover emitted for the single switch');
  assert.equal(rows[0].source, 'model');
  assert.equal(rows[0].sessionId, 'sess-fb-1');
  assert.equal(rows[0].workflowRunId, 'run-fb-1');
  assert.equal((rows[0].payload as { stage?: string }).stage, 'router');
  assert.equal((rows[0].payload as { from?: string }).from, 'primary');
  assert.equal((rows[0].payload as { to?: string }).to, 'backup');
});
