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
  jevAvailable,
  jevEnabled,
  _setSystemOneFetchForTests,
  _setTypesafeKeyForTests,
} = await import('./client.js');
const { readUsageEventsForDate, canonicalCacheAccounting } = await import('../usage-log.js');

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

test('jevAvailable is false when Jev is turned off or has no key, and true only with both', async () => {
  _setTypesafeKeyForTests(null);
  assert.equal(await jevAvailable(), false, 'no key');
  _setTypesafeKeyForTests('ts_test');
  assert.equal(await jevAvailable(), true);
  process.env.CLEMMY_JEV = 'off';
  assert.equal(await jevAvailable(), false, 'turned off, even with a key');
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

test('successful Jev decisions with missing or partial usage remain visible and uncertified', async () => {
  _setTypesafeKeyForTests('ts_test');
  const cases = [
    { suffix: 'missing', usage: undefined, input: 0, output: 0 },
    { suffix: 'input-only', usage: { input_tokens: 12 }, input: 12, output: 0 },
    { suffix: 'output-only', usage: { output_tokens: 3 }, input: 0, output: 3 },
    { suffix: 'invalid', usage: { input_tokens: -1, output_tokens: 3 }, input: 0, output: 3 },
  ];
  for (const entry of cases) {
    _setSystemOneFetchForTests(async () => ({ status: 200, ok: true, text: async () => JSON.stringify({
      answers: { a: { type: 'noul', noul: 0.4 } }, ...(entry.usage ? { usage: entry.usage } : {}),
    }) }));
    const sessionId = `sess-jev-usage-${entry.suffix}`;
    const result = await evaluateSystemOne({ state: 'PRIVATE_STATE',
      questions: { a: { type: 'noul', instructions: 'y' } }, sessionId });
    assert.ok(result.ok, 'measurement gaps do not change valid decisions');
    if (result.ok) assert.equal(result.answers.a.type, 'noul');
    const rows = readUsageEventsForDate().filter((row) => row.source === sessionId);
    assert.equal(rows.length, 1, 'unknown usage does not erase the observed call');
    const row = rows[0]!;
    assert.equal(row.inputTokens, entry.input);
    assert.equal(row.outputTokens, entry.output);
    assert.equal(row.cacheDialect, 'unknown');
    assert.equal(row.canonical?.certified, false);
    assert.equal(canonicalCacheAccounting(row).certified, false);
    assert.equal(row.requestModel, 'jev-1.13.0');
    assert.equal(row.providerReportedModel, undefined, 'missing response model cannot inherit the request pin');
    assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_STATE/);
  }
});

test('explicit Jev zero usage is represented as reported arithmetic without inventing response ownership', async () => {
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async () => ({ status: 200, ok: true, text: async () => JSON.stringify({
    model: 'jev-1.13.0', answers: { a: { type: 'noul', noul: 0.4 } },
    usage: { input_tokens: 0, output_tokens: 0 },
  }) }));
  const sessionId = 'sess-jev-explicit-zero';
  const result = await evaluateSystemOne({ state: 'x',
    questions: { a: { type: 'noul', instructions: 'y' } }, sessionId });
  assert.ok(result.ok);
  const row = readUsageEventsForDate().find((entry) => entry.source === sessionId)!;
  assert.equal(row.cacheDialect, 'none');
  assert.equal(canonicalCacheAccounting(row).certified, true, 'only the explicit reported arithmetic is certified');
  assert.equal(row.providerReportedModel, 'jev-1.13.0');
  assert.equal(row.trace?.modelCallId, undefined, 'a token receipt alone is not an exact completed-response join');
});
