/**
 * A search that surfaces nothing new must say so — and must not be a dead end.
 *
 * Live 2026-09-07: "refresh my Facebook trends report" disclosed the correct
 * capability (APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS) on search #1, then ran
 * nine more searches; #7 re-disclosed APIFY_RUN_ACTOR_SYNC, already shown at #4.
 * 14 model round-trips, 36s of provider work in ~960s — 3.8% of the turn on the
 * task. The exact-request digest cannot catch this: it hashes the arguments, so
 * a rephrase is a new subject.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./discovery-governor.ts', import.meta.url), 'utf8');

test('the repeat brake meters disclosed identifiers, not query text', () => {
  const fn = src.slice(src.indexOf('function repeatedDiscoveryAdvisory'));
  assert.ok(fn.length > 0, 'repeatedDiscoveryAdvisory must exist');
  const body = fn.slice(0, 2600);
  assert.ok(
    /capability_discovered/.test(body),
    'it must read what was actually disclosed, not the request digest',
  );
  assert.ok(
    /latest\.some\(\(id\) => !seenBefore\.has\(id\)\)/.test(body),
    'it must fire only when the latest search added no NEW identifier',
  );
});

test('the brake advises an admitted search — it never denies one', () => {
  // A denial terminalizes the turn (discovery-boundary.ts throws
  // DiscoveryBudgetDeniedError and calls terminalizeDiscoveryDenial), so this
  // must ride the advisory channel instead. "No dead ends" is the whole point.
  assert.ok(
    !/reason: 'discovery_added_nothing_new'/.test(src),
    'the repeat brake must not introduce a refusal reason',
  );
  assert.ok(
    /repeatAdvisory/.test(src) && /\[roleAdvisory, repeatAdvisory\]\.filter\(Boolean\)/.test(src),
    'it must be merged into the advisory that rides with an admitted decision',
  );
});

test('an unreadable history never blocks discovery', () => {
  const fn = src.slice(src.indexOf('function repeatedDiscoveryAdvisory'), src.indexOf('export const MAX_TURN_DISCOVERY_ADMISSIONS'));
  assert.ok(/catch \{[\s\S]*return undefined;/.test(fn), 'it must fail open to undefined');
});
