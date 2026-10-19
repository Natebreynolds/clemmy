import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

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
  systemOneOriginalWitnessFor, systemOneOriginalWitnessMetadata,
} = await import('./client.js');
const { readUsageEventsForDate, canonicalCacheAccounting, modelUsageAttributionStorage, recordModelUsage } = await import('../usage-log.js');
const { buildSystemOneRequest } = await import('./system-one.js');
const { withModelTransportRecorder } = await import('../harness/model-transport-observation.js');

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

test('Jev captures its original whole owner and sink before asynchronous key resolution', async () => {
  _setTypesafeKeyForTests('private-test-key'); let calls = 0;
  const rows: Readonly<Record<string, unknown>>[] = [], foreign: Readonly<Record<string, unknown>>[] = [];
  const owner = { sessionId: 'jev-entry-owner', sourceUserSeq: 401, attemptId: 'attempt-jev-entry', role: 'brain' as const };
  _setSystemOneFetchForTests(async () => { calls++; return { status: 200, ok: true, text: async () => JSON.stringify({
    model: 'jev-1.13.0', answers: { a: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 2, output_tokens: 1 },
  }) }; });
  const pending = withModelTransportRecorder(row => rows.push(row), () => modelUsageAttributionStorage.run(owner,
    () => evaluateSystemOne({ state: 'PRIVATE_CENSUS_CONTEXT', questions: { a: { type: 'noul', instructions: 'Check.' } }, sessionId: owner.sessionId })));
  owner.sessionId = 'changed-after-key-entry'; owner.sourceUserSeq = 499; owner.attemptId = 'changed-attempt';
  const result = await withModelTransportRecorder(row => foreign.push(row), () => modelUsageAttributionStorage.run({
    sessionId: 'foreign-key-drainer', sourceUserSeq: 450, attemptId: 'foreign-attempt',
  }, () => pending));
  assert.ok(result.ok); assert.equal(calls, 1); assert.deepEqual(foreign, []);
  assert.ok(rows.every(row => row.sourceUserSeq === 401 && row.runAttemptId === 'attempt-jev-entry' && row.purpose === 'router'));
  const local = rows.filter(row => row.phase === 'adapter_attempt_created' || row.phase === 'adapter_attempt_finished');
  assert.equal(local.length, 2); assert.equal(local[1].outcome, 'returned');
  assert.equal(local[1].resultScope, 'owned_systemone_parser'); assert.equal(local[1].usage, 'reported');
  assert.equal(local[1].providerReportedModel, 'jev-1.13.0');
  // The existing usage writer runs under the same original tuple as the
  // diagnostic capture, even when the caller mutates its ambient object.
  const usage = readUsageEventsForDate().filter(row => row.trace?.modelCallId === local[0].modelCallId);
  assert.equal(usage.length, 1); assert.equal(usage[0].source, 'jev-entry-owner');
  assert.equal(usage[0].trace?.acceptedSource, 'jev-entry-owner:401');
  assert.equal(usage[0].trace?.attemptId, 'attempt-jev-entry');
  assert.equal(usage[0].role, 'router'); assert.equal(usage[0].channel, 'jev'); assert.equal(usage[0].account, 'jev');
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_CENSUS_CONTEXT|private-test-key|Bearer|authorization/);
});

test('Jev snapshots nested accounting parent, detached job and prompt estimates without splicing the child attempt', async () => {
  _setTypesafeKeyForTests('test-key');
  _setSystemOneFetchForTests(async () => ({ status: 200, ok: true, text: async () => JSON.stringify({
    model: 'jev-1.13.0', answers: { a: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 12, output_tokens: 3 },
  }) }));
  const rows: Readonly<Record<string, unknown>>[] = [];
  const parent = { sessionId: 'jev-original-parent', sourceUserSeq: 410, attemptId: 'attempt-original-parent' };
  const components = { instructions: 8, history: 4 };
  const owner = { sessionId: 'unknown', sourceUserSeq: 0, attemptId: 'detached-child-attempt',
    usageParentTurn: parent, usageJobId: 'job-jev-original', channel: 'memory:reflect',
    role: 'memory' as const, ownRequest: true, promptComponents: components };
  const pending = withModelTransportRecorder(row => rows.push(row), () => modelUsageAttributionStorage.run(owner,
    () => evaluateSystemOne({ state: 'x', questions: { a: { type: 'noul', instructions: 'Check.' } }, sessionId: 'unknown' })));
  parent.sessionId = 'changed-parent'; parent.sourceUserSeq = 499; parent.attemptId = 'changed-parent-attempt';
  owner.usageJobId = 'changed-job'; owner.attemptId = 'changed-child-attempt'; components.instructions = 999;
  const result = await pending; assert.ok(result.ok);
  assert.ok(rows.length > 0); assert.ok(rows.every(row => row.sourceUserSeq === 410
    && row.runAttemptId === 'attempt-original-parent' && row.ownerKind === 'accounting_parent'
    && row.usageJobId === 'job-jev-original'));
  const usage = readUsageEventsForDate().find(row => row.trace?.modelCallId === rows[0].modelCallId)!;
  assert.equal(usage.source, 'job-jev-original'); assert.equal(usage.trace?.acceptedSource, 'jev-original-parent:410');
  assert.equal(usage.trace?.attemptId, 'attempt-original-parent'); assert.equal(usage.role, 'router');
  assert.equal(usage.channel, 'jev'); assert.deepEqual(usage.promptComponents, { instructions: 8, history: 4 });
});

test('host call stage is captured before key resolution and remains aligned with its usage record', async () => {
  _setTypesafeKeyForTests('test-key'); let calls = 0;
  const rows: Readonly<Record<string, unknown>>[] = [];
  _setSystemOneFetchForTests(async () => { calls++; return { status: 200, ok: true, text: async () => JSON.stringify({
    model: 'jev-1.13.0', answers: { a: { type: 'noul', noul: 0.7 } }, usage: { input_tokens: 5, output_tokens: 2 },
  }) }; });
  const input: Parameters<typeof evaluateSystemOne>[0] = { state: 'PRIVATE_STAGE_STATE',
    questions: { a: { type: 'noul', instructions: 'Check.' } }, channel: 'jev-turn-start', sessionId: 'jev-stage-owner' };
  const pending = withModelTransportRecorder(row => rows.push(row), () => modelUsageAttributionStorage.run({
    sessionId: input.sessionId!, sourceUserSeq: 470, attemptId: 'attempt-stage-owner',
  }, () => evaluateSystemOne(input)));
  input.channel = 'jev-completion';
  const result = await pending;
  assert.ok(result.ok); assert.equal(calls, 1);
  assert.ok(rows.length > 0 && rows.every(row => row.callPurpose === 'jev-turn-start'
    && row.sourceUserSeq === 470 && row.runAttemptId === 'attempt-stage-owner'));
  const usage = readUsageEventsForDate().filter(row => row.trace?.modelCallId === rows[0].modelCallId);
  assert.equal(usage.length, 1); assert.equal(usage[0].channel, 'jev-turn-start');
  assert.equal(usage[0].role, 'router'); assert.equal(usage[0].inputTokens, 5); assert.equal(usage[0].outputTokens, 2);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_STAGE_STATE|test-key/);
});

test('unknown stage text stays absent and a known stage cannot give an unowned call a source', async () => {
  _setTypesafeKeyForTests('test-key'); let calls = 0;
  _setSystemOneFetchForTests(async () => { calls++; return { status: 200, ok: true, text: async () => JSON.stringify({
    answers: { a: { type: 'noul', noul: 0.7 } }, usage: { input_tokens: 2, output_tokens: 1 },
  }) }; });
  const owned: Readonly<Record<string, unknown>>[] = [], unowned: Readonly<Record<string, unknown>>[] = [];
  const result = await withModelTransportRecorder(row => owned.push(row), () => modelUsageAttributionStorage.run({
    sessionId: 'jev-unknown-stage-owner', sourceUserSeq: 471, attemptId: 'attempt-unknown-stage-owner',
  }, () => evaluateSystemOne({ state: 'x', questions: { a: { type: 'noul', instructions: 'Check.' } },
    channel: 'PRIVATE_UNKNOWN_STAGE', sessionId: 'jev-unknown-stage-owner' })));
  assert.ok(result.ok); assert.ok(owned.length > 0);
  assert.ok(owned.every(row => !Object.hasOwn(row, 'callPurpose')));
  assert.doesNotMatch(JSON.stringify(owned), /PRIVATE_UNKNOWN_STAGE/);
  await withModelTransportRecorder(row => unowned.push(row), () => modelUsageAttributionStorage.run({
    sessionId: 'unknown', sourceUserSeq: 0,
  }, () => evaluateSystemOne({ state: 'x', questions: { a: { type: 'noul', instructions: 'Check.' } }, channel: 'jev-completion' })));
  assert.equal(calls, 2); assert.deepEqual(unowned, []);
});

test('initially unowned or unavailable capture cannot borrow a later source while ordinary Jev work continues', async () => {
  _setTypesafeKeyForTests('test-key'); let calls = 0, getterCalls = 0;
  _setSystemOneFetchForTests(async () => { calls++; return { status: 200, ok: true, text: async () => JSON.stringify({
    answers: { a: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 2, output_tokens: 1 },
  }) }; });
  for (const mode of ['missing', 'mutated-unowned', 'unavailable'] as const) {
    const rows: Readonly<Record<string, unknown>>[] = [];
    const owner = { sessionId: 'unknown', sourceUserSeq: 0, attemptId: 'original-unowned-attempt' };
    if (mode === 'unavailable') Object.defineProperty(owner, 'promptComponents', {
      enumerable: true, get() { getterCalls++; throw new Error('PRIVATE_CAPTURE_FAILURE'); },
    });
    const label = `jev-unowned-${mode}`;
    const work = () => evaluateSystemOne({ state: 'x', questions: { a: { type: 'noul', instructions: 'Check.' } }, sessionId: label });
    const pending = withModelTransportRecorder(row => rows.push(row), () => mode === 'missing'
      ? work() : modelUsageAttributionStorage.run(owner, work));
    owner.sessionId = 'later-foreign-owner'; owner.sourceUserSeq = 420; owner.attemptId = 'later-attempt';
    const result = await modelUsageAttributionStorage.run({ sessionId: 'foreign-drainer', sourceUserSeq: 421,
      attemptId: 'foreign-drainer-attempt' }, () => pending);
    assert.ok(result.ok); assert.deepEqual(rows, []);
    const usage = readUsageEventsForDate().find(row => row.source === label)!;
    assert.ok(usage); assert.equal(usage.trace?.acceptedSource, undefined); assert.equal(usage.trace?.attemptId, undefined);
    assert.equal(usage.trace?.modelCallId, undefined);
    assert.doesNotMatch(JSON.stringify(usage), /PRIVATE_CAPTURE_FAILURE|later-foreign-owner|later-attempt|foreign-drainer/);
  }
  assert.equal(calls, 3); assert.equal(getterCalls, 0, 'diagnostics never evaluate attribution accessors');
});

test('Jev usage under an ordinary immutable context retains the existing recorder contract exactly', async () => {
  _setTypesafeKeyForTests('test-key');
  _setSystemOneFetchForTests(async () => ({ status: 200, ok: true, text: async () => JSON.stringify({
    model: 'jev-1.13.0', answers: { a: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 12, output_tokens: 3 },
  }) }));
  const owner = { sessionId: 'jev-ordinary-ledger', sourceUserSeq: 430, attemptId: 'attempt-ordinary-ledger',
    role: 'brain' as const, channel: 'desktop', ownRequest: true, promptComponents: { instructions: 8, history: 4 } };
  await modelUsageAttributionStorage.run(owner, async () => {
    // Exercise the unchanged writer directly as the exogenous ledger contract.
    recordModelUsage({ sessionId: owner.sessionId, channel: 'jev-ordinary', role: 'router', account: 'jev',
      model: 'jev-1.13.0', requestModel: 'jev-1.13.0', providerReportedModel: 'jev-1.13.0',
      cacheDialect: 'none', inputTokens: 12, outputTokens: 3, ok: true });
    const expected = readUsageEventsForDate().filter(row => row.source === owner.sessionId).at(-1)!;
    const result = await evaluateSystemOne({ state: 'x', questions: { a: { type: 'noul', instructions: 'Check.' } },
      sessionId: owner.sessionId, channel: 'jev-ordinary' }); assert.ok(result.ok);
    const actual = readUsageEventsForDate().filter(row => row.source === owner.sessionId).at(-1)!;
    const stable = (row: typeof actual) => {
      const { at: _at, durationMs: _duration, trace, ...fields } = row;
      const { modelCallId: _call, ...stableTrace } = trace!;
      return { ...fields, trace: stableTrace };
    };
    assert.deepEqual(stable(actual), stable(expected)); assert.ok(actual.trace?.modelCallId);
  });
});

test('disabled and missing-key Jev requests preserve hostile channel access order and perform no work', async () => {
  let channelReads = 0, calls = 0;
  _setSystemOneFetchForTests(async () => { calls++; throw new Error('unexpected request'); });
  const input = { state: 'x', questions: { a: { type: 'noul' as const, instructions: 'Check.' } },
    get channel(): string { channelReads++; throw new Error('PRIVATE_DISABLED_CHANNEL'); } };
  for (const mode of ['disabled', 'missing_key'] as const) {
    process.env.CLEMMY_JEV = mode === 'disabled' ? 'off' : 'on';
    _setTypesafeKeyForTests(mode === 'disabled' ? 'test-key' : null);
    const rows: Readonly<Record<string, unknown>>[] = [];
    const result = await withModelTransportRecorder(row => rows.push(row), () => evaluateSystemOne(input));
    assert.deepEqual(result, { ok: false, reason: mode }); assert.deepEqual(rows, []);
  }
  assert.equal(channelReads, 0); assert.equal(calls, 0);
});

test('Jev preflight declines mint no adapter attempts; a post-key throw closes locally without replacing the error', async () => {
  const rows: Readonly<Record<string, unknown>>[] = []; let calls = 0;
  _setSystemOneFetchForTests(async () => { calls++; throw new Error('unexpected model request'); });
  await withModelTransportRecorder(row => rows.push(row), () => modelUsageAttributionStorage.run({
    sessionId: 'jev-preflight-owner', sourceUserSeq: 402, attemptId: 'attempt-jev-preflight',
  }, async () => {
    _setTypesafeKeyForTests(null);
    const missing = await evaluateSystemOne({ state: 'x', questions: { a: { type: 'noul', instructions: 'Check.' } } });
    assert.equal(missing.ok, false); if (!missing.ok) assert.equal(missing.reason, 'missing_key');
    process.env.CLEMMY_JEV = 'off'; _setTypesafeKeyForTests('test-key');
    const disabled = await evaluateSystemOne({ state: 'x', questions: { a: { type: 'noul', instructions: 'Check.' } } });
    assert.equal(disabled.ok, false); if (!disabled.ok) assert.equal(disabled.reason, 'disabled');
    assert.deepEqual(rows, []); delete process.env.CLEMMY_JEV;
    const original = new Error('PRIVATE_THROW_CONTEXT');
    await assert.rejects(evaluateSystemOne({ get state() { throw original; },
      questions: { a: { type: 'noul', instructions: 'Check.' } } }), error => error === original);
  }));
  assert.equal(calls, 0); assert.deepEqual(rows.map(row => row.phase), ['adapter_attempt_created', 'adapter_attempt_finished']);
  assert.equal(rows[1].outcome, 'failed'); assert.equal(rows[1].usage, 'unknown');
  assert.deepEqual(rows[1].dispatchIds, []); assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_THROW_CONTEXT|test-key/);
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

test('completion witness binds actual body and original parsed return without certifying account or cloned results', async () => {
  const owner = { sessionId: 'sess-jev-original', sourceUserSeq: 1, attemptId: 'attempt:jev-original' };
  const state = { value: 'PRIVATE_WITNESS_DATA' }, questions = { a: { type: 'noul' as const, instructions: 'Check value.' } };
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  const expected = { owner, requestBodySha256: hash(JSON.stringify(buildSystemOneRequest(state, questions))),
    questionnaireSha256: hash(JSON.stringify(questions)) };
  let calls = 0;
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async (_url, init) => {
    calls++; assert.equal(hash(init.body), expected.requestBodySha256);
    return { status: 200, ok: true, text: async () => JSON.stringify({ answers: { a: { type: 'noul', noul: 0.9 } } }) };
  });
  await modelUsageAttributionStorage.run(owner, async () => {
    const result = await evaluateSystemOne({ state, questions, sessionId: owner.sessionId,
      channel: 'jev-completion', captureOriginalWitness: true });
    const witness = systemOneOriginalWitnessFor(result, expected)!;
    assert.ok(witness);
    const metadata = systemOneOriginalWitnessMetadata(witness)!;
    assert.equal(metadata.requestBodySha256, expected.requestBodySha256);
    assert.equal(metadata.providerReportedModel, undefined, 'request pin is not reported identity');
    assert.equal(metadata.accountBackend, 'unknown');
    assert.equal(metadata.providerResponseIdentity, 'unknown');
    assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE_WITNESS_DATA|ts_test/);
    assert.equal(systemOneOriginalWitnessFor({ ...result }, expected), undefined);
    assert.equal(systemOneOriginalWitnessMetadata({ ...witness }), undefined);
    for (const change of [ { requestBodySha256: '0'.repeat(64) }, { questionnaireSha256: '0'.repeat(64) },
      { owner: { ...owner, attemptId: 'attempt:other' } } ]) {
      assert.equal(systemOneOriginalWitnessFor(result, { ...expected, ...change }), undefined);
    }
    await modelUsageAttributionStorage.run({ ...owner, sourceUserSeq: 2 }, async () => {
      assert.equal(systemOneOriginalWitnessMetadata(witness), undefined, 'foreign owner cannot borrow a witness');
    });
    if (result.ok) result.answers.a = { type: 'noul', noul: 0.1 };
    assert.equal(systemOneOriginalWitnessMetadata(witness), undefined, 'original/shared result mutation invalidates proof');
  });
  assert.equal(calls, 1);
});

test('unowned, cancelled and mutated completion requests never acquire an original witness', async () => {
  const owner = { sessionId: 'sess-jev-unqualified', sourceUserSeq: 1, attemptId: 'attempt:jev-unqualified' };
  const questions = { a: { type: 'noul' as const, instructions: 'Check value.' } };
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async () => ({ status: 200, ok: true,
    text: async () => JSON.stringify({ answers: { a: { type: 'noul', noul: 0.5 } } }) }));
  const state = { value: 'before' };
  const expected = { owner, requestBodySha256: hash(JSON.stringify(buildSystemOneRequest(state, questions))),
    questionnaireSha256: hash(JSON.stringify(questions)) };
  const unowned = await evaluateSystemOne({ state, questions, sessionId: owner.sessionId,
    channel: 'jev-completion', captureOriginalWitness: true });
  await modelUsageAttributionStorage.run(owner, async () => {
    assert.equal(systemOneOriginalWitnessFor(unowned, expected), undefined);
    const controller = new AbortController();
    _setSystemOneFetchForTests(async () => { controller.abort(); return { status: 200, ok: true,
      text: async () => JSON.stringify({ answers: { a: { type: 'noul', noul: 0.5 } } }) }; });
    const cancelled = await evaluateSystemOne({ state, questions, sessionId: owner.sessionId,
      channel: 'jev-completion', captureOriginalWitness: true, assessmentSignal: controller.signal });
    assert.ok(cancelled.ok, 'diagnostics do not change the existing completed parser result');
    assert.equal(systemOneOriginalWitnessFor(cancelled, expected), undefined);
    _setSystemOneFetchForTests(async () => { state.value = 'after'; return { status: 200, ok: true,
      text: async () => JSON.stringify({ answers: { a: { type: 'noul', noul: 0.5 } } }) }; });
    const mutated = await evaluateSystemOne({ state, questions, sessionId: owner.sessionId,
      channel: 'jev-completion', captureOriginalWitness: true });
    assert.ok(mutated.ok);
    assert.equal(systemOneOriginalWitnessFor(mutated, expected), undefined);
  });
});
