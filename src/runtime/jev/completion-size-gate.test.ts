/**
 * Run: npx tsx --test src/runtime/jev/completion-size-gate.test.ts
 *
 * Jev's completion screen is skipped only where its own record shows it never
 * settles: the bar is the largest settled call plus a margin, applied once
 * enough larger calls settled none; a few calls above the bar are still made;
 * the late ask (reviewer could not run) is never skipped; every skip is in the
 * decision log with the bar and the count behind it.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-jev-size-gate-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const DECISIONS = path.join(HOME, 'state', 'jev-decisions');
mkdirSync(DECISIONS, { recursive: true });

const {
  COMPLETION_GATE_MIN_OBSERVATIONS,
  COMPLETION_GATE_REPROBE_EVERY,
  decideCompletionCall,
  learnCompletionSizeGate,
} = await import('./completion-size-gate.js');
const { readRecentJevDecisions } = await import('./decision-log.js');
const { _setSystemOneFetchForTests, _setTypesafeKeyForTests } = await import('./client.js');
const { _resetCompletionSizeGateForTests, tryJevCompletionVerdict } = await import('./control-plane.js');

after(() => { rmSync(HOME, { recursive: true, force: true }); });
afterEach(() => {
  _setTypesafeKeyForTests(undefined);
  _setSystemOneFetchForTests(undefined);
  _resetCompletionSizeGateForTests();
  rmSync(DECISIONS, { recursive: true, force: true });
  mkdirSync(DECISIONS, { recursive: true });
});

type Row = { id: string; at: string; lane: string; ok: boolean; inputTokens?: number; context?: Record<string, unknown>; outcome?: string };
let serial = 0;
function call(inputTokens: number, outcome: string, context?: Record<string, unknown>): Row {
  return { id: `c${++serial}`, at: '2026-09-26T10:00:00.000Z', lane: 'jev-completion', ok: true, inputTokens, outcome, ...(context ? { context } : {}) };
}
function history(bigCount: number): Row[] {
  return [
    call(6_000, 'done'), call(9_000, 'done'), call(12_000, 'awaiting'), call(8_000, 'abstained'),
    ...Array.from({ length: bigCount }, (_, i) => call(16_000 + i * 500, 'abstained')),
  ];
}

test('no bar until enough larger calls have settled none; then the bar is the largest settled plus a margin', () => {
  assert.equal(learnCompletionSizeGate([call(20_000, 'abstained'), call(30_000, 'abstained')]).skipAboveTokens, null,
    'nothing settled: no evidence of what Jev can do, ask as before');
  const thin = learnCompletionSizeGate(history(COMPLETION_GATE_MIN_OBSERVATIONS - 1));
  assert.equal(thin.skipAboveTokens, null);
  assert.equal(thin.observedAbove, COMPLETION_GATE_MIN_OBSERVATIONS - 1);
  const gate = learnCompletionSizeGate(history(COMPLETION_GATE_MIN_OBSERVATIONS));
  assert.equal(gate.largestSettledTokens, 12_000);
  assert.equal(gate.skipAboveTokens, 13_800);
  assert.equal(gate.observedAbove, COMPLETION_GATE_MIN_OBSERVATIONS);
});

test('a failed call or a call without tokens teaches nothing', () => {
  const rows = [...history(COMPLETION_GATE_MIN_OBSERVATIONS), { ...call(50_000, 'done'), ok: false }, { id: 'x', at: '', lane: 'jev-completion', ok: true, outcome: 'done' }];
  assert.equal(learnCompletionSizeGate(rows).largestSettledTokens, 12_000);
});

test('the estimate is scaled by the ratio Jev reported for earlier calls', async () => {
  const { REQUEST_CHARS_PER_TOKEN } = await import('./completion-size-gate.js');
  const stale = history(COMPLETION_GATE_MIN_OBSERVATIONS).map((row) => ({ ...row, context: { estimatedTokens: row.inputTokens! / 3 } }));
  assert.equal(learnCompletionSizeGate(stale).calibration, 1, 'estimates made another way never calibrate this one');
  const rows = history(COMPLETION_GATE_MIN_OBSERVATIONS).map((row) => ({
    ...row, context: { estimatedTokens: row.inputTokens! / 2, estimateCharsPerToken: REQUEST_CHARS_PER_TOKEN },
  }));
  const gate = learnCompletionSizeGate(rows);
  assert.equal(gate.calibration, 2);
  const under = decideCompletionCall({ estimatedTokens: 6_000, gate, probeKey: 'a' });
  assert.deepEqual(under, { call: true, expectedTokens: 12_000, reprobe: false });
});

test('above the bar most calls are skipped and about one in eight is still made', () => {
  const gate = learnCompletionSizeGate(history(COMPLETION_GATE_MIN_OBSERVATIONS));
  let made = 0;
  const total = 800;
  for (let i = 0; i < total; i++) {
    const decision = decideCompletionCall({ estimatedTokens: 20_000, gate, probeKey: `key-${i}` });
    if (decision.call) { made++; assert.equal(decision.reprobe, true); }
  }
  const expected = total / COMPLETION_GATE_REPROBE_EVERY;
  assert.ok(made > expected * 0.6 && made < expected * 1.4, `re-probes ${made} of ${total}`);
  assert.deepEqual(decideCompletionCall({ estimatedTokens: 20_000, gate, probeKey: 'same' }),
    decideCompletionCall({ estimatedTokens: 20_000, gate, probeKey: 'same' }), 'the same review decides the same way');
});

test('the reader joins outcomes, keeps its lane, and leaves skips and bad lines out', () => {
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(path.join(DECISIONS, `${day}.ndjson`), [
    JSON.stringify({ id: 'a', at: `${day}T01:00:00.000Z`, lane: 'jev-completion', ok: true, inputTokens: 7_000 }),
    JSON.stringify({ id: 'b', at: `${day}T01:00:01.000Z`, lane: 'jev-turn-start', ok: true, inputTokens: 900 }),
    JSON.stringify({ id: 's', at: `${day}T01:00:02.000Z`, lane: 'jev-completion', skipped: true, reason: 'never_settles_at_size' }),
    'not json',
    JSON.stringify({ id: 'a', at: `${day}T01:00:03.000Z`, outcome: 'done' }),
  ].join('\n'));
  const rows = readRecentJevDecisions('jev-completion');
  assert.deepEqual(rows.map((row) => [row.id, row.inputTokens, row.outcome]), [['a', 7_000, 'done']]);
});

function seedLog(bigCount: number): void {
  const day = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  for (const row of history(bigCount)) {
    lines.push(JSON.stringify({ id: row.id, at: `${day}T02:00:00.000Z`, lane: row.lane, ok: true, inputTokens: row.inputTokens }));
    lines.push(JSON.stringify({ id: row.id, at: `${day}T02:00:01.000Z`, outcome: row.outcome }));
  }
  writeFileSync(path.join(DECISIONS, `${day}.ndjson`), `${lines.join('\n')}\n`);
}

function countingJev(): { calls: () => number } {
  let calls = 0;
  _setTypesafeKeyForTests('ts_test');
  _setSystemOneFetchForTests(async () => {
    calls++;
    return { status: 200, ok: true, text: async () => JSON.stringify({ model: 'jev-1.13.0', answers: {
      delivered: { type: 'noul', noul: 0.5 }, unaddressed: { type: 'noul', noul: 0.5 }, unsupported: { type: 'noul', noul: 0.5 },
      computed: { type: 'noul', noul: 0.1 }, asksUser: { type: 'noul', noul: 0.05 }, cannotFinish: { type: 'noul', noul: 0.05 },
    }, usage: { input_tokens: 20_000, output_tokens: 10 } }) };
  });
  return { calls: () => calls };
}

function skipRows(): Array<Record<string, unknown>> {
  const day = new Date().toISOString().slice(0, 10);
  return readFileSync(path.join(DECISIONS, `${day}.ndjson`), 'utf-8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>).filter((row) => row.skipped === true);
}

// ~100k characters of evidence (clipped to the state budget): estimated well above a 13.8k-token bar.
const BIG_EVIDENCE = Array.from({ length: 3_000 }, (_, i) => `row ${i}: value ${i * 7} status ok`).join('\n');

test('a screen Jev has never settled at this size is not made, and the skip is logged with its reason', async () => {
  seedLog(COMPLETION_GATE_MIN_OBSERVATIONS);
  const jev = countingJev();
  let skipped = 0;
  for (let i = 0; i < 16; i++) {
    const verdict = await tryJevCompletionVerdict(`List every row ${i}`, 'Here are the rows.', {
      screening: true, sessionId: `sess-${i}`, toolCallSummary: BIG_EVIDENCE,
    });
    assert.equal(verdict, null, 'nothing Jev could settle is returned either way');
  }
  skipped = skipRows().length;
  assert.ok(skipped >= 10, `most large screens skipped (${skipped} of 16)`);
  assert.equal(jev.calls() + skipped, 16, 'every screen is either made or logged as skipped');
  const row = skipRows()[0];
  assert.equal(row.reason, 'never_settles_at_size');
  const context = row.context as Record<string, unknown>;
  assert.equal(context.sizeBarTokens, 13_800);
  assert.equal(context.observedAboveBar, COMPLETION_GATE_MIN_OBSERVATIONS);
  assert.equal(context.largestSettledTokens, 12_000);
  assert.ok(Number(context.expectedTokens) > 13_800);
});

test('without the screening flag (the reviewer could not run) Jev is always asked, whatever the size', async () => {
  seedLog(COMPLETION_GATE_MIN_OBSERVATIONS);
  const jev = countingJev();
  for (let i = 0; i < 4; i++) {
    await tryJevCompletionVerdict(`List every row ${i}`, 'Here are the rows.', { sessionId: `late-${i}`, toolCallSummary: BIG_EVIDENCE });
  }
  assert.equal(jev.calls(), 4);
  assert.equal(skipRows().length, 0);
});

test('a small screen is made as before, and records its size estimate for calibration', async () => {
  seedLog(COMPLETION_GATE_MIN_OBSERVATIONS);
  const jev = countingJev();
  await tryJevCompletionVerdict('What time is it in Paris?', 'It is 3 PM in Paris.', { screening: true, sessionId: 'small' });
  assert.equal(jev.calls(), 1);
  const made = readRecentJevDecisions('jev-completion').find((row) => row.context?.estimatedTokens !== undefined);
  assert.ok(made, 'the call records estimatedTokens');
  assert.equal(made!.context!.sizeBarTokens, 13_800);
});

test('a screen at the size cap estimates above a bar set just under what such screens have reported', async () => {
  const { estimateRequestTokens } = await import('./completion-size-gate.js');
  // A request at the state cap (~75k characters) reported ~22.9k tokens live;
  // a chars/4 estimate (18.8k) could never reach a 19.5k bar.
  assert.ok(estimateRequestTokens('x'.repeat(75_000)) > 19_496);
});
