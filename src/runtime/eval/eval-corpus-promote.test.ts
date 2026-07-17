/**
 * Run: npx tsx --test src/runtime/eval/eval-corpus-promote.test.ts
 *
 * Lane A Phase 4b — production failures → eval cases. A real failure (guardrail
 * block, stall, run_failed) becomes a pending case; a clean run or an
 * advisory-only nudge (fanout_nudge) does NOT (no false corpus growth).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFailureCase, buildJudgeCandidateCases, listJudgeCandidates } from './eval-corpus-promote.js';
import type { EventRow } from '../harness/eventlog.js';

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, createdAt = '2026-06-21T00:00:00.000Z'): EventRow => ({
  seq: seq++, id: `e${seq}`, sessionId: 's', turn: 0, role: 'system', type: type as EventRow['type'],
  parentEventId: null, data, createdAt,
});

test('a guardrail block → a pending case carrying the gate kind + a trace', () => {
  const c = buildFailureCase('sess-1', [
    ev('turn_started', {}),
    ev('tool_called', { tool: 'composio_execute_tool', callId: 'c1', accounting: 'top_level' }),
    ev('tool_called', { tool: 'composio_execute_tool', callId: 'mcp-c1', accounting: 'transport_mirror' }),
    ev('guardrail_tripped', { kind: 'confirm_first_required', toolName: 'composio_execute_tool' }, '2026-06-21T00:00:09.000Z'),
  ]);
  assert.ok(c);
  assert.equal(c!.sessionId, 'sess-1');
  assert.deepEqual(c!.failureKinds, ['guardrail:confirm_first_required']);
  assert.equal(c!.capturedAt, '2026-06-21T00:00:09.000Z', 'capturedAt is the last event time (deterministic)');
  assert.equal(c!.toolCount, 1);
  assert.ok(c!.spans.length >= 1);
  assert.equal(c!.promoted, false);
});

test('stuck_detected / run_failed are real failures → a case', () => {
  assert.ok(buildFailureCase('s', [ev('stuck_detected', { reason: 'A_zero_tools' })]));
  assert.ok(buildFailureCase('s', [ev('run_failed', { reason: 'boom' })]));
});

test('a clean run → null (no false corpus growth)', () => {
  assert.equal(buildFailureCase('s', [ev('turn_started', {}), ev('tool_called', { tool: 'x', callId: 'c' }), ev('conversation_completed', {})]), null);
});

test('an ADVISORY-only nudge (fanout_nudge) is NOT a failure → null', () => {
  assert.equal(buildFailureCase('s', [ev('guardrail_tripped', { kind: 'fanout_nudge' })]), null);
});

test('mixed advisory + real → only the real kind is kept', () => {
  const c = buildFailureCase('s', [
    ev('guardrail_tripped', { kind: 'fanout_nudge' }),
    ev('guardrail_tripped', { kind: 'grounding_blocked' }),
  ]);
  assert.deepEqual(c?.failureKinds, ['guardrail:grounding_blocked']);
});

// ── Judge-corpus baking (4B) ──────────────────────────────────────────────────
test('buildJudgeCandidateCases: harvests goal-fidelity + numeric-grounding verdicts (pass + fail)', () => {
  const cases = buildJudgeCandidateCases('sess-j', [
    ev('turn_started', {}),
    ev('goal_alignment_judged', { toolName: 'composio_execute_tool', fulfills: false, advisory: true, targets: ['acme.com'], reason: 'does not advance the goal' }, '2026-06-27T00:00:01.000Z'),
    ev('output_grounding_judged', { source: 'chat', grounded: true, advisory: true, figures: ['$11K'], reason: 'all figures trace' }, '2026-06-27T00:00:02.000Z'),
    ev('conversation_completed', {}),
  ]);
  assert.equal(cases.length, 2);
  const gf = cases.find((c) => c.judge === 'goal_fidelity')!;
  assert.equal(gf.verdict, 'fail');
  assert.equal(gf.advisory, true);
  assert.deepEqual(gf.input.targets, ['acme.com']);
  assert.equal(gf.capturedAt, '2026-06-27T00:00:01.000Z', 'capturedAt is the event time (deterministic)');
  assert.equal(gf.promoted, false);
  const ng = cases.find((c) => c.judge === 'numeric_grounding')!;
  assert.equal(ng.verdict, 'pass');
  assert.deepEqual(ng.input.figures, ['$11K']);
});

test('buildJudgeCandidateCases: a fulfills:true verdict with no advisory field → pass + advisory:false', () => {
  const [c] = buildJudgeCandidateCases('s', [ev('goal_alignment_judged', { toolName: 't', fulfills: true, targets: [], reason: 'aligned' })]);
  assert.equal(c.verdict, 'pass');
  assert.equal(c.advisory, false);
});

test('buildJudgeCandidateCases: no judge events → empty (no false corpus growth)', () => {
  assert.deepEqual(buildJudgeCandidateCases('s', [ev('turn_started', {}), ev('tool_called', { tool: 'x', callId: 'c' })]), []);
});

test('buildJudgeCandidateCases: identical repeated verdicts dedup to one stable id', () => {
  const cases = buildJudgeCandidateCases('s', [
    ev('output_grounding_judged', { source: 'chat', grounded: false, advisory: true, figures: ['$5'], reason: 'fabricated' }),
    ev('output_grounding_judged', { source: 'chat', grounded: false, advisory: true, figures: ['$5'], reason: 'fabricated' }),
  ]);
  assert.equal(cases.length, 1, 'same verdict harvested twice → one record');
});

test('snapshotJudgeCandidates + listJudgeCandidates round-trip (temp dir, off any real store)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-judge-cand-'));
  try {
    const events: EventRow[] = [
      ev('goal_alignment_judged', { toolName: 't', fulfills: false, advisory: true, targets: ['x'], reason: 'r1' }),
      ev('output_grounding_judged', { source: 'chat', grounded: false, advisory: true, figures: ['$1'], reason: 'r2' }),
    ];
    // snapshot reads listEvents(sessionId) internally, so exercise the pure builder + the persistence directly:
    const built = buildJudgeCandidateCases('sess-rt', events);
    assert.equal(built.length, 2);
    // persist the same way snapshotJudgeCandidates does, then list them back
    mkdirSync(dir, { recursive: true });
    for (const c of built) writeFileSync(path.join(dir, `${c.id}.json`), JSON.stringify(c), 'utf-8');
    const listed = listJudgeCandidates({ dir });
    assert.equal(listed.length, 2);
    assert.deepEqual(listed.map((c) => c.judge).sort(), ['goal_fidelity', 'numeric_grounding']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
