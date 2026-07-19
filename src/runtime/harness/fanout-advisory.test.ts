/**
 * Run: npx tsx --test src/runtime/harness/fanout-advisory.test.ts
 *
 * The GLOBAL fan-out trigger. Verifies the behavioral serial-batch detector
 * fires on observed runtime shape-repetition (any tool name, language- and
 * domain-independent), the data-flow independence guard suppresses dependent
 * chains in CODE (not advisory prose), the workflow-step variant, and
 * robustness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFanoutAdvisory, coarseArgShape } from './fanout-advisory.js';

test('fires on the 3rd distinct same-shape call for an ARBITRARY tool name (not just composio)', () => {
  const sessionId = 'sess-fa-generic';
  const tool = 'dataforseo__serp_organic_live_advanced'; // a native MCP namespaced name
  assert.equal(appendFanoutAdvisory({ toolName: tool, args: { target: 'alpha.example' }, sessionId }), null, 'item 1');
  assert.equal(appendFanoutAdvisory({ toolName: tool, args: { target: 'beta.example' }, sessionId }), null, 'item 2');
  const advice = appendFanoutAdvisory({ toolName: tool, args: { target: 'gamma.example' }, sessionId });
  assert.ok(advice && /run_worker/.test(advice), 'item 3 fires with run_worker advice');
  assert.ok(advice && advice.includes(tool), 'advice names the tool');
});

test('re-emits at the 3rd and 6th distinct items, hard-capped at 2 per bucket', () => {
  const sessionId = 'sess-fa-rearm';
  const tool = 'X_TOOL';
  const fires: number[] = [];
  for (let i = 1; i <= 12; i++) {
    if (appendFanoutAdvisory({ toolName: tool, args: { q: `item${i}` }, sessionId })) fires.push(i);
  }
  assert.deepEqual(fires, [3, 6], 'fires at 3 and 6, then capped');
});

test('keeps SEPARATE buckets per toolName+arg-shape', () => {
  const sessionId = 'sess-fa-buckets';
  // bucket A: TOOL_A with {url}
  appendFanoutAdvisory({ toolName: 'TOOL_A', args: { url: 'p1' }, sessionId });
  appendFanoutAdvisory({ toolName: 'TOOL_A', args: { url: 'p2' }, sessionId });
  assert.ok(appendFanoutAdvisory({ toolName: 'TOOL_A', args: { url: 'p3' }, sessionId }), 'bucket A fires on its 3rd');
  // bucket B: different tool — fresh bucket, not suppressed by A having advised
  appendFanoutAdvisory({ toolName: 'TOOL_B', args: { id: 'a1' }, sessionId });
  appendFanoutAdvisory({ toolName: 'TOOL_B', args: { id: 'a2' }, sessionId });
  assert.ok(appendFanoutAdvisory({ toolName: 'TOOL_B', args: { id: 'a3' }, sessionId }), 'bucket B fires independently');
});

test('INDEPENDENCE GUARD: a dependent chain (each arg derived from prior result) NEVER fires', () => {
  const sessionId = 'sess-fa-chain';
  const tool = 'SALESFORCE_GET';
  // Each call's id appears in the PRIOR call's result → dependent sequence.
  let advice = appendFanoutAdvisory({ toolName: tool, args: { id: 'parent-000000001' }, sessionId, resultText: 'top contact id: contact-00000002' });
  assert.equal(advice, null, 'call 1 counted, no advice yet');
  advice = appendFanoutAdvisory({ toolName: tool, args: { id: 'contact-00000002' }, sessionId, resultText: 'open case id: case-000000003x' });
  assert.equal(advice, null, 'call 2 is dependent → skipped');
  advice = appendFanoutAdvisory({ toolName: tool, args: { id: 'case-000000003x' }, sessionId, resultText: 'related: case-000000004y' });
  assert.equal(advice, null, 'call 3 is dependent → skipped');
  advice = appendFanoutAdvisory({ toolName: tool, args: { id: 'case-000000004y' }, sessionId, resultText: 'end' });
  assert.equal(advice, null, 'still no fan-out advice on a pure dependent chain');
});

test('INDEPENDENCE GUARD: an independent batch still fires (results do NOT contain the next item)', () => {
  const sessionId = 'sess-fa-batch';
  const tool = 'dataforseo__serp_organic_live_advanced';
  assert.equal(appendFanoutAdvisory({ toolName: tool, args: { target: 'alpha-firm.example' }, sessionId, resultText: 'rank 4, volume 200' }), null);
  assert.equal(appendFanoutAdvisory({ toolName: tool, args: { target: 'beta-firm.example' }, sessionId, resultText: 'rank 9, volume 80' }), null);
  const advice = appendFanoutAdvisory({ toolName: tool, args: { target: 'gamma-firm.example' }, sessionId, resultText: 'rank 2, volume 500' });
  assert.ok(advice && /run_worker/.test(advice), 'independent 3-firm batch fires normally despite resultText present');
});

test('INDEPENDENCE GUARD self-corrects: a coincidental match only delays the advisory by one item', () => {
  const sessionId = 'sess-fa-coincidence';
  const tool = 'firecrawl__scrape';
  // call 1's RESULT coincidentally mentions firm 2's domain (e.g. competitor list).
  assert.equal(appendFanoutAdvisory({ toolName: tool, args: { url: 'alpha-firm.example' }, sessionId, resultText: 'competitors: beta-firm.example, competitor.example' }), null, 'item 1 counted (size 1)');
  // call 2's url appears in call 1's result → flagged dependent → skipped (size stays 1).
  assert.equal(appendFanoutAdvisory({ toolName: tool, args: { url: 'beta-firm.example' }, sessionId, resultText: 'rank 9' }), null, 'item 2 skipped (coincidental match)');
  // call 3 not in call 2 result → counted (size 2).
  assert.equal(appendFanoutAdvisory({ toolName: tool, args: { url: 'gamma-firm.example' }, sessionId, resultText: 'rank 2' }), null, 'item 3 counted (size 2)');
  // call 4 → size 3 → fires (delayed by exactly one vs the no-coincidence case).
  const advice = appendFanoutAdvisory({ toolName: tool, args: { url: 'delta-firm.example' }, sessionId, resultText: 'rank 1' });
  assert.ok(advice && /run_worker/.test(advice), 'real batch still fires, just one item later');
});

test('workflow-step session uses the forEach variant, never run_worker', () => {
  const sessionId = 'workflow:run-123:step-enrich';
  const tool = 'AIRTABLE_UPDATE_RECORD';
  appendFanoutAdvisory({ toolName: tool, args: { rec: 'r1' }, sessionId });
  appendFanoutAdvisory({ toolName: tool, args: { rec: 'r2' }, sessionId });
  const advice = appendFanoutAdvisory({ toolName: tool, args: { rec: 'r3' }, sessionId });
  assert.ok(advice, 'workflow step fires on its 3rd item');
  assert.ok(advice && /forEach/.test(advice), 'uses the forEach mechanism');
  // It is the forEach variant, not the run_worker-imperative variant. (The text
  // legitimately names run_worker only to say it is NOT available here.)
  assert.ok(advice && !/FAN-OUT NOW/.test(advice), 'not the run_worker imperative variant');
  assert.ok(advice && /not run_worker/.test(advice), 'explicitly steers away from run_worker in workflows');
});

test('never throws on null / circular / missing args, and no sessionId is a no-op', () => {
  assert.equal(appendFanoutAdvisory({ toolName: 'T', args: {}, sessionId: undefined }), null, 'no sessionId → null');
  assert.equal(appendFanoutAdvisory({ toolName: '', args: {}, sessionId: 'sess-fa-empty' }), null, 'empty toolName → null');
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  // Should not throw even though JSON.stringify(args) and the deep scan hit a cycle.
  assert.doesNotThrow(() => {
    appendFanoutAdvisory({ toolName: 'T', args: circular, sessionId: 'sess-fa-circular', resultText: 'x' });
  });
});

test('coarseArgShape is stable regardless of key order and tolerates junk', () => {
  assert.equal(coarseArgShape({ b: 1, a: 2 }), 'a,b');
  assert.equal(coarseArgShape({} as Record<string, unknown>), '');
  assert.equal(coarseArgShape(null as unknown as Record<string, unknown>), '');
});
