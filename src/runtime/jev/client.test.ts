import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-jev-client-'));
process.env.CLEMENTINE_HOME = HOME;
delete process.env.TYPESAFE_API_KEY;
delete process.env.CLEMMY_JEV;

const {
  evaluateSystemOne,
  jevEnabled,
  _setSystemOneFetchForTests,
  _setTypesafeKeyForTests,
} = await import('./client.js');

afterEach(() => {
  _setTypesafeKeyForTests(undefined);
  _setSystemOneFetchForTests(undefined);
  delete process.env.CLEMMY_JEV;
  delete process.env.TYPESAFE_API_KEY;
});

test.after(() => rmSync(HOME, { recursive: true, force: true }));

test('evaluateSystemOne fail-opens when the key is missing or Jev is killed', async () => {
  _setTypesafeKeyForTests(null);
  const missing = await evaluateSystemOne({
    state: 'x',
    questions: { a: { type: 'noul', instructions: 'y' } },
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'missing_key');

  process.env.CLEMMY_JEV = 'off';
  _setTypesafeKeyForTests('ts_test');
  assert.equal(jevEnabled(), false);
  const disabled = await evaluateSystemOne({
    state: 'x',
    questions: { a: { type: 'noul', instructions: 'y' } },
  });
  assert.equal(disabled.ok, false);
  if (!disabled.ok) assert.equal(disabled.reason, 'disabled');
});

test('evaluateSystemOne records a typed answer when the transport returns System One JSON', async () => {
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async (url) => {
    assert.match(url, /\/v1\/systemone$/);
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({
        model: 'jev-1.13.0',
        answers: { a: { type: 'noul', noul: 0.4 } },
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
    };
  });
  const result = await evaluateSystemOne({
    state: 'x',
    questions: { a: { type: 'noul', instructions: 'y' } },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.model, 'jev-1.13.0');
    assert.equal(result.answers.a.type, 'noul');
  }
});
