/**
 * Run: npx tsx --test src/runtime/harness/discovery-advisory.test.ts
 *
 * The redundant-discovery detector (P1-D). Verifies it fires on a toolkit
 * search-loop (the 2026-06-04 Google Sheets ×4 thrash), clusters reformulations
 * by Jaccard overlap while leaving genuinely-different intents alone, folds
 * `list` into the toolkit find lane, keeps describe separate, re-arms at 3/6
 * capped at 2, honors the kill-switch, and never throws.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maybeDiscoveryAdvisory,
  isDescribeSlug,
  toolkitOfSlug,
  describeSignature,
} from './discovery-advisory.js';

test('fires on the 3rd overlapping find-lane search; names the toolkit, no run_worker', () => {
  const sessionId = 'sess-da-basic';
  const toolkit = 'googlesheets';
  assert.equal(maybeDiscoveryAdvisory({ kind: 'search', toolkit, signature: 'create spreadsheet now', sessionId }), null, 'search 1');
  assert.equal(maybeDiscoveryAdvisory({ kind: 'search', toolkit, signature: 'create new spreadsheet', sessionId }), null, 'search 2');
  const advice = maybeDiscoveryAdvisory({ kind: 'search', toolkit, signature: 'create spreadsheet', sessionId });
  assert.ok(advice && /DISCOVERY LOOP/.test(advice), 'search 3 fires');
  assert.ok(advice && advice.includes(toolkit), 'advice names the toolkit');
  assert.ok(advice && !/run_worker/.test(advice), 'discovery advice does NOT recommend run_worker');
});

test('the literal 2026-06-04 Google Sheets reformulations cluster and fire on the 3rd', () => {
  const sessionId = 'sess-da-incident';
  const toolkit = 'googlesheets';
  const q = [
    'google sheets create spreadsheet update values batch',
    'google sheets create new spreadsheet with sheets',
    'google sheets create spreadsheet',
    'create spreadsheet',
  ];
  assert.equal(maybeDiscoveryAdvisory({ kind: 'search', toolkit, signature: q[0], sessionId }), null);
  assert.equal(maybeDiscoveryAdvisory({ kind: 'search', toolkit, signature: q[1], sessionId }), null);
  const advice = maybeDiscoveryAdvisory({ kind: 'search', toolkit, signature: q[2], sessionId });
  assert.ok(advice && /DISCOVERY LOOP/.test(advice), 'the broadening-query loop fires on the 3rd');
});

test('two genuinely-different intents in one toolkit never fire (distinctness guard)', () => {
  const sessionId = 'sess-da-distinct';
  const toolkit = 'gmail';
  const fires: string[] = [];
  // Two distinct goals, each issued twice — share only "gmail" (Jaccard < 0.3).
  for (const sig of [
    'gmail fetch unread inbox',
    'gmail compose outbound message',
    'gmail fetch unread inbox',
    'gmail compose outbound message',
  ]) {
    const a = maybeDiscoveryAdvisory({ kind: 'search', toolkit, signature: sig, sessionId });
    if (a) fires.push(sig);
  }
  assert.deepEqual(fires, [], 'no advisory — neither distinct cluster reaches the threshold');
});

test('per-toolkit total-find thrash fires even when NO single cluster clusters (2026-07-10 outlook unread-count loop)', () => {
  const sessionId = 'sess-da-bucket';
  const toolkit = 'outlook';
  // The live 6-search loop: one goal (unread count) but each query so divergent it
  // never clusters — the per-cluster threshold never fires. The per-toolkit total
  // must catch it. Distinct token sets (Jaccard < 0.3 pairwise).
  const q = [
    'list unread messages inbox',
    'count messages folder',
    'get folder unread item count metadata',
    'custom graph api raw http call',
    'mail folder details inbox properties',
  ];
  assert.equal(maybeDiscoveryAdvisory({ kind: 'search', toolkit, signature: q[0], sessionId }), null, '1');
  assert.equal(maybeDiscoveryAdvisory({ kind: 'search', toolkit, signature: q[1], sessionId }), null, '2');
  assert.equal(maybeDiscoveryAdvisory({ kind: 'search', toolkit, signature: q[2], sessionId }), null, '3');
  assert.equal(maybeDiscoveryAdvisory({ kind: 'search', toolkit, signature: q[3], sessionId }), null, '4 (<=4 distinct still ok)');
  const advice = maybeDiscoveryAdvisory({ kind: 'search', toolkit, signature: q[4], sessionId });
  assert.ok(advice && /DISCOVERY LOOP/.test(advice), 'the 5th divergent search on one toolkit fires the per-toolkit total');
  assert.ok(advice && /NOT converging|different queries/i.test(advice), 'advice names the divergent-thrash shape');
  assert.ok(advice && advice.includes(toolkit), 'names the toolkit');
});

test('a list folds into the toolkit find lane (search ×2 then list → fires)', () => {
  const sessionId = 'sess-da-list';
  const toolkit = 'googlesheets';
  assert.equal(maybeDiscoveryAdvisory({ kind: 'search', toolkit, signature: 'create new spreadsheet', sessionId }), null, 'search 1');
  assert.equal(maybeDiscoveryAdvisory({ kind: 'search', toolkit, signature: 'make a new spreadsheet', sessionId }), null, 'search 2');
  const advice = maybeDiscoveryAdvisory({ kind: 'list', toolkit, signature: `list ${toolkit}`, sessionId });
  assert.ok(advice && /DISCOVERY LOOP/.test(advice), 'list is the 3rd find-lane call and fires');
});

test('describe lane fires on 3 overlapping describes and is SEPARATE from the find lane', () => {
  const sessionId = 'sess-da-describe';
  const toolkit = 'salesforce';
  // A find-lane search on the same toolkit must NOT bleed into the describe lane.
  maybeDiscoveryAdvisory({ kind: 'search', toolkit, signature: 'salesforce query records', sessionId });
  assert.equal(maybeDiscoveryAdvisory({ kind: 'describe', toolkit, signature: 'EmailMessage Task', sessionId }), null, 'describe 1');
  assert.equal(maybeDiscoveryAdvisory({ kind: 'describe', toolkit, signature: 'EmailMessage Task', sessionId }), null, 'describe 2');
  const advice = maybeDiscoveryAdvisory({ kind: 'describe', toolkit, signature: 'EmailMessage Task', sessionId });
  assert.ok(advice && /described the 'salesforce' schema/.test(advice), 'describe lane fires on the 3rd');
});

test('different toolkits keep separate buckets', () => {
  const sessionId = 'sess-da-buckets';
  const a = 'googlesheets';
  maybeDiscoveryAdvisory({ kind: 'search', toolkit: a, signature: 'create spreadsheet', sessionId });
  maybeDiscoveryAdvisory({ kind: 'search', toolkit: a, signature: 'create new spreadsheet', sessionId });
  assert.ok(maybeDiscoveryAdvisory({ kind: 'search', toolkit: a, signature: 'create a spreadsheet', sessionId }), 'sheets fires on its 3rd');
  // gmail untouched — a single search must not fire.
  assert.equal(maybeDiscoveryAdvisory({ kind: 'search', toolkit: 'gmail', signature: 'gmail search unread', sessionId }), null, 'unrelated toolkit unaffected');
});

test('re-emits at the 3rd and 6th, hard-capped at 2 per cluster', () => {
  const sessionId = 'sess-da-rearm';
  const toolkit = 'notion';
  const fires: number[] = [];
  for (let i = 1; i <= 12; i++) {
    if (maybeDiscoveryAdvisory({ kind: 'search', toolkit, signature: `create page item${i}`, sessionId })) fires.push(i);
  }
  assert.deepEqual(fires, [3, 6], 'fires at 3 and 6, then capped');
});

test('CLEMMY_DISCOVERY_DIRECTIVE=off suppresses the advisory entirely', () => {
  const prev = process.env.CLEMMY_DISCOVERY_DIRECTIVE;
  process.env.CLEMMY_DISCOVERY_DIRECTIVE = 'off';
  try {
    const sessionId = 'sess-da-off';
    const fires: number[] = [];
    for (let i = 1; i <= 6; i++) {
      if (maybeDiscoveryAdvisory({ kind: 'search', toolkit: 'slack', signature: `post message item${i}`, sessionId })) fires.push(i);
    }
    assert.deepEqual(fires, [], 'flag off → never fires');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_DISCOVERY_DIRECTIVE;
    else process.env.CLEMMY_DISCOVERY_DIRECTIVE = prev;
  }
});

test('no sessionId / empty toolkit / empty signature are no-ops and it never throws', () => {
  assert.equal(maybeDiscoveryAdvisory({ kind: 'search', toolkit: 'x', signature: 'q', sessionId: undefined }), null, 'no sessionId → null');
  assert.equal(maybeDiscoveryAdvisory({ kind: 'search', toolkit: '', signature: 'q', sessionId: 'sess-da-empty' }), null, 'empty toolkit → null');
  assert.equal(maybeDiscoveryAdvisory({ kind: 'search', toolkit: 'x', signature: '', sessionId: 'sess-da-empty' }), null, 'empty signature → null');
  assert.doesNotThrow(() => maybeDiscoveryAdvisory({ kind: 'list', toolkit: 'x', signature: 'list x', sessionId: 'sess-da-nothrow' }));
});

test('describe-slug helpers classify and parse composio slugs', () => {
  assert.equal(isDescribeSlug('SALESFORCE_DESCRIBE_SOBJECT'), true);
  assert.equal(isDescribeSlug('AIRTABLE_GET_BASE_SCHEMA'), true);
  assert.equal(isDescribeSlug('GOOGLESHEETS_CREATE_GOOGLE_SHEET1'), false);
  assert.equal(toolkitOfSlug('SALESFORCE_DESCRIBE_SOBJECT'), 'salesforce');
  assert.equal(toolkitOfSlug('AIRTABLE_GET_BASE_SCHEMA'), 'airtable');
  assert.equal(describeSignature('SALESFORCE_DESCRIBE_SOBJECT', { sobject: 'EmailMessage' }), 'EmailMessage');
  assert.equal(describeSignature('SALESFORCE_DESCRIBE_SOBJECT', {}), 'SALESFORCE_DESCRIBE_SOBJECT', 'falls back to the slug');
});
