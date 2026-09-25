import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-jev-decisions-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { _setSystemOneFetchForTests, _setTypesafeKeyForTests, evaluateSystemOne } = await import('./client.js');
const { noteJevDecisionOutcome } = await import('./decision-log.js');

after(() => {
  _setTypesafeKeyForTests(undefined);
  _setSystemOneFetchForTests(undefined);
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function loggedRows(): Array<Record<string, any>> {
  const dir = path.join(HOME, 'state', 'jev-decisions');
  return readdirSync(dir).flatMap((file) => readFileSync(path.join(dir, file), 'utf-8')
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>));
}

// Every Jev call leaves a row a later measurement can join to the host's
// outcome: the pinned model asked for, the model that answered, the typed
// answers and the host's candidate ids. Never the state Jev was shown.
test('every Jev call is recorded with its answers and outcome, never its state', async () => {
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        select: { type: 'choice', choice: 'op_1', confidence: 0.91, probabilities: { op_1: 0.91, none: 0.09 } },
        fit_1: { type: 'noul', noul: 0.88 },
      },
      usage: { input_tokens: 120, output_tokens: 6 },
    }),
  }));
  const result = await evaluateSystemOne({
    state: { request: 'PRIVATE REQUEST TEXT' },
    questions: {
      select: { type: 'choice', instructions: 'pick', criteria: { op_1: 'a', none: 'b' } },
      fit_1: { type: 'noul', instructions: 'fits?' },
    },
    channel: 'jev-operation-route',
    sessionId: 'sess-decision-log',
    decisionContext: { candidates: ['workflow_get', 'workflow_create'] },
  });
  assert.ok(result.ok && result.decisionId);
  noteJevDecisionOutcome(result.decisionId, 'picked', { pick: 'workflow_create' });

  _setSystemOneFetchForTests(async () => ({ status: 504, ok: false, text: async () => '' }));
  const failed = await evaluateSystemOne({ state: { request: 'x' }, questions: {}, channel: 'jev-completion' });
  assert.equal(failed.ok, false);

  const rows = loggedRows();
  const decision = rows.find((row) => row.id === result.decisionId && row.lane);
  assert.equal(decision?.lane, 'jev-operation-route');
  assert.equal(decision?.requestedModel, 'jev-1.13.0');
  assert.equal(decision?.servedModel, 'jev-1.13.0');
  assert.deepEqual(decision?.answers, { select: { choice: 'op_1', confidence: 0.91 }, fit_1: { noul: 0.88 } });
  assert.deepEqual(decision?.context, { candidates: ['workflow_get', 'workflow_create'] });
  assert.equal(decision?.sessionId, 'sess-decision-log');
  const outcome = rows.find((row) => row.id === result.decisionId && row.outcome);
  assert.deepEqual({ outcome: outcome?.outcome, detail: outcome?.detail }, { outcome: 'picked', detail: { pick: 'workflow_create' } });
  const failure = rows.find((row) => row.lane === 'jev-completion');
  assert.equal(failure?.ok, false);
  assert.equal(failure?.failReason, 'http_error');
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE REQUEST TEXT/, 'the state Jev read is never logged');
});
