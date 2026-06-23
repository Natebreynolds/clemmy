/**
 * Run: npx tsx --test src/runtime/harness/output-grounding-gate.test.ts
 *
 * Output-grounding gate — NUMERIC integrity at the deliverable boundary
 * (the trust-layer P1, 2026-06-23). Verifies the load-bearing FIGURES in a
 * report trace to the session's captured tool results, or bounce/advisory.
 * Deterministic-first: the rounding/scaling/aggregation pre-pass clears the
 * common derived cases with ZERO judge calls; the cross-family judge only
 * sees the residual. Contradiction → bounce; no-source → advisory; fail-open.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-output-grounding-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resetEventLog, createSession, writeToolOutput } = await import('./eventlog.js');
const {
  extractNumericClaims,
  extractNumbersFromText,
  deterministicallyVerify,
  evaluateOutputGrounding,
  buildOutputGroundingPrompt,
  buildOutputGroundingChatRetry,
  OutputGroundingCheckFailedError,
  _setOutputGroundingJudgeForTests,
  _resetOutputGroundingStateForTests,
} = await import('./output-grounding-gate.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

// ─── extractNumericClaims (pure) ──────────────────────────────────

test('extractNumericClaims: pulls currency, percent, count; normalizes K/M scaling', () => {
  const claims = extractNumericClaims('Ad spend was $24.5K and organic traffic rose 18% across 50 sessions.');
  const byUnit = (u: string) => claims.find((c) => c.unit === u);
  assert.equal(byUnit('currency')?.value, 24500, '$24.5K → 24500');
  assert.equal(byUnit('percent')?.value, 18, '18% → 18');
  assert.equal(byUnit('count')?.value, 50, '50 sessions → 50 count');
});

test('extractNumericClaims: ignores years, versions, ordinals, bare small ints, code', () => {
  const claims = extractNumericClaims('In 2026 we shipped v0.5.20 as the 3rd release; step 2 done. `port 8080`. Pick 5.');
  assert.equal(claims.length, 0, 'no load-bearing figures — all are noise');
});

test('extractNumericClaims: dedups identical (value,unit) and caps', () => {
  const claims = extractNumericClaims('Revenue $1,000 then again $1,000 and $1,000.');
  assert.equal(claims.filter((c) => c.unit === 'currency' && c.value === 1000).length, 1, 'deduped');
});

test('extractNumbersFromText: scales K/M/B and strips commas', () => {
  const ns = extractNumbersFromText('rows: 6,460.78, 12K, 1.2M and 11,000');
  assert.ok(ns.includes(6460.78));
  assert.ok(ns.includes(12000));
  assert.ok(ns.includes(1_200_000));
  assert.ok(ns.includes(11000));
});

// ─── deterministicallyVerify (pure: rounding / scaling / aggregation) ──

test('deterministicallyVerify: clears verbatim, rounded, scaled, and percent-as-fraction figures (no judge needed)', () => {
  const sources = [
    { callId: 'c1', tool: 'dataforseo', excerpt: 'monthly_traffic: 6460.78; growth_ratio: 0.18', createdAt: 'now' },
    { callId: 'c2', tool: 'dataforseo', excerpt: 'sessions: 12000; total_spend: 11000', createdAt: 'now' },
  ];
  const claims = extractNumericClaims('Traffic 6,461; growth 18%; total spend $11,000; 12K sessions.');
  const { residual } = deterministicallyVerify(claims, sources);
  assert.equal(residual.length, 0, `all figures derivable verbatim/rounded/scaled; residual=${residual.map((r) => r.raw)}`);
});

test('deterministicallyVerify: aggregation-only and invented figures stay residual (judge territory)', () => {
  // 11,000 is NOT present as a number; it is only the SUM of the rows → residual
  // (aggregation is the judge's job). 24,500 has no plausible source at all.
  const aggSources = [{ callId: 'c1', tool: 'x', excerpt: 'spend rows: 4000, 4000, 3000', createdAt: 'now' }];
  const agg = deterministicallyVerify(extractNumericClaims('Total spend was $11,000.'), aggSources);
  assert.equal(agg.residual.length, 1, 'a summed total is not deterministically cleared');

  const inventedSources = [{ callId: 'c1', tool: 'x', excerpt: 'spend rows: 4000, 4000, 3000 (total 11000)', createdAt: 'now' }];
  const invented = deterministicallyVerify(extractNumericClaims('Total ad spend was $24.5K this quarter.'), inventedSources);
  assert.equal(invented.residual.length, 1, '24500 ≠ any source number → residual');
  assert.equal(invented.residual[0].value, 24500);
});

// ─── prompt assembly ──────────────────────────────────────────────

test('buildOutputGroundingPrompt: states derived-numbers rule + lists figures and sources', () => {
  const p = buildOutputGroundingPrompt(
    extractNumericClaims('spend $24.5K'),
    [{ callId: 'c1', tool: 'x', excerpt: 'spend 11000', createdAt: 'now' }],
  );
  assert.match(p, /\$24\.5K/);
  assert.match(p, /11000/);
  assert.match(p, /DERIVED/, 'tells the judge derived/rounded numbers are grounded');
  assert.match(p, /CONTRADICTED only when/);
});

// ─── evaluateOutputGrounding (decision paths) ─────────────────────

test('evaluateOutputGrounding: contradiction BOUNCES, escalates on repeat; no judge when all verified', async () => {
  resetEventLog();
  _resetOutputGroundingStateForTests();
  const sess = createSession({ kind: 'chat' });
  // Source: spend by campaign sums to $11,000 (and labels include "spend"/"campaign").
  writeToolOutput({
    sessionId: sess.id,
    callId: 'call_spend',
    tool: 'composio_execute_tool',
    output: 'Ad spend by campaign: Alpha $4,000; Bravo $4,000; Charlie $3,000. Total $11,000.',
  });
  // Judge: contradicted iff the deliverable claims 24.5(K); else grounded.
  _setOutputGroundingJudgeForTests(async (claims) => {
    const has245 = claims.some((c) => Math.abs(c.value - 24500) < 1);
    return has245
      ? { verdict: 'contradicted', offending: [{ figure: '$24.5K', kind: 'contradicted', note: 'spend rows sum to $11,000' }], reason: 'Reported $24.5K spend contradicts the $11,000 campaign total.' }
      : { verdict: 'grounded', offending: [], reason: 'consistent' };
  });
  try {
    const bounced = await evaluateOutputGrounding(sess.id, 'Total ad spend across campaigns was $24.5K this quarter.', { kind: 'chat' });
    assert.equal(bounced.action, 'bounce');
    assert.equal(bounced.failureCount, 1);
    assert.match(bounced.reason, /\$11,000|11,000|11000/);
    assert.ok(bounced.figures.includes('$24.5K'));

    const bounced2 = await evaluateOutputGrounding(sess.id, 'Total ad spend across campaigns was $24.5K this quarter.', { kind: 'chat' });
    assert.equal(bounced2.failureCount, 2, 'same figure escalates');
    const err = new OutputGroundingCheckFailedError({ toolName: 'composio_execute_tool', reason: bounced2.reason, figures: bounced2.figures, sourceCallIds: bounced2.sourceCallIds, failureCount: bounced2.failureCount! });
    assert.match(err.message, /ask_user_question/, 'repeated contradiction instructs a user check-in');

    // A faithful report whose total equals the source sum verifies
    // deterministically → NO judge call.
    let judged = false;
    _setOutputGroundingJudgeForTests(async () => { judged = true; return { verdict: 'contradicted', offending: [], reason: 'should not run' }; });
    const allowed = await evaluateOutputGrounding(sess.id, 'Total ad spend across campaigns was $11,000.', { kind: 'chat' });
    assert.equal(allowed.action, 'allow');
    assert.equal(judged, false, 'all figures verified deterministically → judge never consulted');
  } finally {
    _setOutputGroundingJudgeForTests(null);
  }
});

test('evaluateOutputGrounding: no-plausible-source figure is ADVISORY, not a block', async () => {
  resetEventLog();
  _resetOutputGroundingStateForTests();
  const sess = createSession({ kind: 'chat' });
  writeToolOutput({ sessionId: sess.id, callId: 'c1', tool: 'dataforseo', output: 'organic traffic estimate for the domain: 8,000 sessions/mo' });
  _setOutputGroundingJudgeForTests(async () => ({
    verdict: 'unverifiable',
    offending: [{ figure: '47%', kind: 'no_source', note: 'no conversion-rate source' }],
    reason: 'Reported a 47% conversion rate with no supporting source.',
  }));
  try {
    const r = await evaluateOutputGrounding(sess.id, 'Traffic looks healthy and the conversion rate is 47%.', { kind: 'chat' });
    assert.equal(r.action, 'advisory', 'no-source → inform, do not wedge');
    assert.ok(r.figures.includes('47%'));
  } finally {
    _setOutputGroundingJudgeForTests(null);
  }
});

test('evaluateOutputGrounding: fail-open — no figures, no sources, and judge error all ALLOW', async () => {
  resetEventLog();
  _resetOutputGroundingStateForTests();
  const sess = createSession({ kind: 'chat' });

  // No figures at all.
  const noFigs = await evaluateOutputGrounding(sess.id, 'All done — the report is attached.', { kind: 'chat' });
  assert.equal(noFigs.action, 'allow');

  // Figures but zero captured tool results → nothing to verify against.
  let judged = false;
  _setOutputGroundingJudgeForTests(async () => { judged = true; return { verdict: 'contradicted', offending: [], reason: 'x' }; });
  const noSources = await evaluateOutputGrounding(sess.id, 'Spend was $24.5K.', { kind: 'chat' });
  assert.equal(noSources.action, 'allow');
  assert.equal(judged, false, 'no sources → no judge call');

  // Judge infra error → fail open.
  writeToolOutput({ sessionId: sess.id, callId: 'c1', tool: 'x', output: 'spend campaign data totalling 11000' });
  _setOutputGroundingJudgeForTests(async () => { throw new Error('model down'); });
  const judgeErr = await evaluateOutputGrounding(sess.id, 'Spend was $24.5K across campaigns.', { kind: 'chat' });
  assert.equal(judgeErr.action, 'allow');
  assert.match(judgeErr.reason, /fail open/);
  _setOutputGroundingJudgeForTests(null);
});

test('buildOutputGroundingChatRetry: names the figures + recompute instruction; escalates on repeat', () => {
  const first = buildOutputGroundingChatRetry({ action: 'bounce', reason: 'spend mismatch', figures: ['$24.5K'], sourceCallIds: ['c1'], failureCount: 1 });
  assert.match(first, /\$24\.5K/);
  assert.match(first, /recall_tool_result/);
  const repeat = buildOutputGroundingChatRetry({ action: 'bounce', reason: 'spend mismatch', figures: ['$24.5K'], sourceCallIds: ['c1'], failureCount: 2 });
  assert.match(repeat, /ask_user_question/);
});
