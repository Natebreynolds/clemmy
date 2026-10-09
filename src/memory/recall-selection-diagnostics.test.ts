import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UnifiedHit, UnifiedRecallResult } from './unified-recall.js';
import type { RecallSelectionDiagnostic, RecallSelectionRow, RecallSelectionStage } from './recall-trace.js';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-recall-selection-diagnostics-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_EMBEDDINGS = 'off';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
delete process.env.OPENAI_API_KEY;
const { resetMemoryDb } = await import('./db.js');
const { rememberFact } = await import('./facts.js');
const { recallMemory } = await import('./recall-memory.js');
const { recallEverything, unifiedPrimerLines, visibleUnifiedPrimerHits } = await import('./unified-recall.js');
const { buildUnifiedTurnPrimer, selectRankedTailHits, _setUnifiedTurnPrimerRecallForTest } = await import('./turn-primer.js');
const { RECALL_SELECTION_TRACE_CAP, recallSelectionRef, recallSelectionDiagnostic,
  retainRecallSelectionDiagnostic, retainRecallSelectionRow, appendFactRecallTrace, readFactRecallTrace } = await import('./recall-trace.js');

beforeEach(() => { resetMemoryDb(); _setUnifiedTurnPrimerRecallForTest(null); });
after(() => { _setUnifiedTurnPrimerRecallForTest(null); rmSync(testHome, { recursive: true, force: true }); });

function hit(type: UnifiedHit['type'], ref: string, score = .6): UnifiedHit {
  return { type, ref, title: type, snippet: `Evidence for ${ref}`, score, evidence: [], truncated: false };
}
function sizedHit(type: UnifiedHit['type'], ref: string, chars: number): UnifiedHit {
  const result = hit(type, ref);
  result.snippet = 'x'.repeat(chars - unifiedPrimerLines([{ ...result, snippet: '' }])[0].length - 2);
  assert.equal(unifiedPrimerLines([result])[0].length, chars);
  return result;
}
function diagnostic(): RecallSelectionDiagnostic {
  return { version: 1, asOf: '2026-10-09T06:34:18.737Z', admitted: 3,
    stages: [{ stage: 'topK', candidates: 3, selected: 3, rowsOmitted: 0, limit: 10,
      rows: [{ ref: recallSelectionRef('fact', '2'), rank: 1, reason: 'selected', score: .76,
        scoreBeforeDistinctiveness: .6, scoreAfterDistinctiveness: .76, distinctiveCueApplied: true }] }] };
}

test('real admitted recall records actual topK/duplicate decisions and distinct score phases privately', async () => {
  const first = rememberFact({ kind: 'reference', content: 'orchard evidence marker alpha?' });
  const duplicate = rememberFact({ kind: 'reference', content: 'orchard evidence marker alpha!' });
  const third = rememberFact({ kind: 'reference', content: 'orchard evidence marker beta.' });
  assert.notEqual(first.id, duplicate.id);
  for (let i = 0; i < 5; i++) rememberFact({ kind: 'reference', content: `orchard evidence unique symbol${i}.` });
  const recalled = await recallMemory('orchard evidence marker alpha', { stores: ['fact'], graphDepth: 0, perStore: 30, limit: 2 });
  const trace = recallSelectionDiagnostic(recalled)!;
  assert.ok(trace);
  const stage = trace.stages[0];
  assert.equal(stage.stage, 'topK');
  assert.equal(stage.selected, recalled.hits.length);
  assert.equal(stage.rows.some(row => row.reason === 'similarity_duplicate'), true, JSON.stringify(stage));
  assert.equal(stage.rows.some(row => row.reason === 'topK'), true, JSON.stringify(stage));
  for (const row of stage.rows.filter(row => row.reason === 'selected')) {
    assert.ok(recalled.hits.some(h => String(h.ref.id) === row.ref.id));
    assert.equal(typeof row.scoreBeforeDistinctiveness, 'number');
    assert.equal(typeof row.scoreAfterDistinctiveness, 'number');
    assert.equal(row.distinctiveCueApplied, row.scoreAfterDistinctiveness! > row.scoreBeforeDistinctiveness!);
  }
  assert.equal(JSON.stringify(recalled).includes('scoreBeforeDistinctiveness'), false, 'sidecar is not added to an API/model result');
  const unified = await recallEverything('orchard evidence marker alpha', { stores: ['fact'], graphDepth: 0, perStore: 30, limit: 2 });
  assert.ok(recallSelectionDiagnostic(unified), 'facade keeps the exact sidecar');
  assert.equal(JSON.stringify(unified).includes('scoreBeforeDistinctiveness'), false);
  assert.ok([first.id, duplicate.id, third.id].some(id => recalled.hits.some(h => String(h.ref.id) === String(id))));
});

test('tail observer explains core exclusion, floor and policy reservation without changing order', () => {
  const hits = [hit('fact', '1', .9), hit('policy', '2', .2), hit('fact', '3', .3), hit('episode', 'episode:private/path', .99), hit('fact', '4', .7)];
  const selection = { relativeFloor: .5, reservedPolicySlots: 1, excludeRefKeys: new Set(['fact:4']) };
  const baseline = selectRankedTailHits(hits, selection); let observed: RecallSelectionStage | undefined;
  assert.deepEqual(selectRankedTailHits(hits, selection, value => { observed = value; }), baseline);
  assert.deepEqual(baseline.map(h => h.ref), ['2', '1', 'episode:private/path']);
  assert.equal(observed!.rows.find(r => r.ref.id === '2')?.reason, 'reserved_policy');
  assert.equal(observed!.rows.find(r => r.ref.id === '3')?.reason, 'relative_floor');
  assert.equal(observed!.rows.find(r => r.ref.id === '4')?.reason, 'core_already_visible');
  assert.equal(observed!.rows.find(r => r.ref.type === 'episode')?.ref.id, undefined);
  assert.match(observed!.rows.find(r => r.ref.type === 'episode')!.ref.digest!, /^[a-f0-9]{64}$/);
  assert.deepEqual(selectRankedTailHits(hits, selection, () => { throw Error('unavailable observer'); }), baseline);
});

test('actual byte observer distinguishes the captured policy/target contention and forced oversized first hit', () => {
  const policy = sizedHit('policy', '1', 365), target = sizedHit('fact', '2', 394), short = sizedHit('fact', '3', 299);
  const recalled: UnifiedRecallResult = { objective: 'fixture', hits: [policy, target, short], perStore: {}, purpose: 'ambient' };
  const baseline = visibleUnifiedPrimerHits(recalled, 740, { header: false });let stage: RecallSelectionStage | undefined;
  assert.deepEqual(visibleUnifiedPrimerHits(recalled, 740, { header: false, observeSelection: value => { stage = value; } }), baseline);
  assert.deepEqual(baseline.map(h => h.ref), ['1', '3']);
  assert.equal(stage!.rows.find(r => r.ref.id === '2')?.reason, 'byte_budget');
  assert.equal(stage!.rows.find(r => r.ref.id === '2')?.lineChars, 394);
  assert.equal(stage!.maxChars, 740);
  visibleUnifiedPrimerHits({ ...recalled, hits: [target] }, 10, { header: false, observeSelection: value => { stage = value; } });
  assert.equal(stage!.rows[0].reason, 'forced_first_oversize');
  assert.equal(stage!.selected, 1);
  assert.deepEqual(visibleUnifiedPrimerHits(recalled, 740, { header: false, observeSelection: () => { throw Error('unavailable'); } }), baseline);
});

test('end-to-end primer bytes stay identical while private trace binds the recorded run and explains omission', async () => {
  const policy = sizedHit('policy', '1', 365), target = sizedHit('fact', '2', 394), short = sizedHit('fact', '3', 299);
  let enable = false;
  _setUnifiedTurnPrimerRecallForTest(async () => {
    const result: UnifiedRecallResult = { objective: 'fixture', purpose: 'ambient', answerability: 'partial',
      hits: [target, policy, short].map(h => ({...h})), perStore: {fact:2,policy:1} };
    if (enable) retainRecallSelectionDiagnostic(result, diagnostic());
    return result;
  });
  const input = { query: 'fixture explanation', surface: 'automatic_primer' as const, format: 'tail' as const,
    maxChars: 1013, sessionId: 'selection-fixture-session', selection: { relativeFloor: .5, reservedPolicySlots: 1 } };
  const baseline = await buildUnifiedTurnPrimer(input);enable = true;
  const observed = await buildUnifiedTurnPrimer(input);
  assert.equal(observed.text, baseline.text, 'diagnostics add no model-visible bytes');
  assert.deepEqual(observed.visibleRefs, baseline.visibleRefs);
  const trace = readFactRecallTrace(1)[0];
  assert.equal(trace.selection?.recallId, observed.recallId);
  assert.equal(trace.selection?.sessionId, input.sessionId);
  assert.deepEqual(trace.selection?.stages.map(s => s.stage), ['topK','tail_selection','primer_bytes']);
  assert.equal(trace.selection?.stages[2].rows.find(r => r.ref.id === '2')?.reason, 'byte_budget');
  assert.equal(trace.selection?.stages[2].maxChars, 740);
  assert.equal(trace.selection?.stages[1].rows.find(r => r.ref.id === '1')?.reason, 'reserved_policy');
});

test('bounded telemetry retains late selected rows, marks truncation and whitelists away private payloads', () => {
  const rows: RecallSelectionRow[] = [];
  for (let i=0;i<300;i++) retainRecallSelectionRow(rows, {ref:recallSelectionRef('fact',i),rank:i+1,reason:i===250?'selected':'topK',score:.6});
  assert.equal(rows.length, RECALL_SELECTION_TRACE_CAP);
  assert.ok(rows.some(r=>r.rank===251), 'actual selected ref survives cap');
  const trace = diagnostic();trace.stages[0].rows = rows;trace.stages[0].candidates = 300;trace.stages[0].rowsOmitted=172;
  trace.stages.push({ stage:'primer_bytes', candidates:1,selected:0,rowsOmitted:0, rows:[{
    ref: {type:'note',id:'/PRIVATE-PAYLOAD/secret.md'}, rank:1,reason:'byte_budget',lineChars:999,
    sourceUri:'PRIVATE-PAYLOAD',snippet:'PRIVATE-PAYLOAD',
  } as RecallSelectionRow] });
  (trace as unknown as Record<string,unknown>).query='PRIVATE-PAYLOAD';
  appendFactRecallTrace({surface:'turn_memory_primer',facts:[],includedCount:0,selection:trace});
  const persisted=readFactRecallTrace(1)[0].selection!;
  assert.equal(persisted.stages[0].rowsOmitted,172);
  assert.equal(persisted.stages[0].rows.length,128);
  assert.equal(JSON.stringify(persisted).includes('PRIVATE-PAYLOAD'),false);
  assert.match(persisted.stages[1].rows[0].ref.digest!,/^[a-f0-9]{64}$/);
});
