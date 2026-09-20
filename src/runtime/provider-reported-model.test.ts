import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { withTracelessStep, providerReportedModel } from './harness/traceless-step-model.js';
import { MODEL_ROUTE_METRICS_SCHEMA_SQL, withModelRouteMetrics } from './model-route-metrics.js';

// Transport fixture only: no network/model calls, home switching or resets.
const served = 'fixture-served-model';
const leaf = {
  async getResponse() { throw new Error('Traceless path must stream'); },
  async *getStreamedResponse() {
    yield { type: 'response_started', providerData: { model: served } };
    yield { type: 'response_done', response: { id: 'fixture-response', output: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } };
  },
};

test('traceless adapter retains provider-reported model from stream metadata', async () => {
  const response = await withTracelessStep(leaf as any).getResponse({} as any);
  assert.equal(providerReportedModel(response), served);
  assert.equal(providerReportedModel({ output: [{ text: 'model: made-up-model' }] }), undefined);
  assert.equal(providerReportedModel({ providerData: { model: '  ' } }), undefined);
});

for (const streaming of [false, true]) test(`route receipt records served model (${streaming ? 'stream' : 'response'})`, async () => {
  const db = new Database(':memory:');
  try {
    db.exec(MODEL_ROUTE_METRICS_SCHEMA_SQL);
    const model = withModelRouteMetrics(withTracelessStep(leaf as any), {
      role: 'worker', requestedModel: 'fixture-requested-model', resolvedModel: 'fixture-requested-model', provider: 'byo', source: 'explicit',
    }, db);
    if (streaming) for await (const _event of model.getStreamedResponse({} as any)) { /* consume completion */ }
    else await model.getResponse({} as any);
    const row = db.prepare('SELECT metadata_json FROM model_route_outcomes').get() as { metadata_json: string };
    const metadata = JSON.parse(row.metadata_json);
    assert.equal(metadata.actualModel, served);
    assert.equal(metadata.providerReportedModel, served);
  } finally { db.close(); }
});
