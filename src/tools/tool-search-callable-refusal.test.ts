/**
 * A tool the model can call on this turn is never described to it as a result
 * to walk away from.
 *
 * Live 2026-08-27 (seq 90427): tool_search handed the model space_get,
 * space_get_runner and space_edit_runner WITH their full schemas and a
 * call_tool carrier, then stamped every one of them
 * `unsupported_unmaterialized` and closed the page with "Do not cite these
 * results in plan_task; refine discovery". The model believed the label over
 * the carrier: it re-searched five times, never called a tool it was already
 * holding, fabricated four capability refs by pattern-matching the two real
 * ones, and the turn blocked.
 *
 * The distinction the harness lost: failing the plan-citation gate is PRECISELY
 * what leaves a control or registry read reachable through call_tool. Not
 * citable is not not usable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SEARCH = new URL('./tool-search-tool.ts', import.meta.url);
const GATE = new URL('../runtime/harness/local-planning-capability.ts', import.meta.url);

test('the refusal reason survives the disclosure boundary', () => {
  const src = readFileSync(GATE, 'utf8');
  // The reason was computed and thrown away. Bare null must remain ONLY for a
  // name that is absent from the surface — a different fact from "present and
  // not citable" — so both branches have to exist.
  assert.match(src, /return \{ refused: observed\.reason \}/);
  assert.match(src, /if \(!name \|\| !input\.configuredNames\.has\(name\)\) return null;/);
  assert.doesNotMatch(
    src,
    /if \(!observed\.ok\) return null;/,
    'a computed refusal reason must not be discarded at the disclosure boundary',
  );
});

test('a ref-less row is not flatly stamped unsupported', () => {
  const src = readFileSync(SEARCH, 'utf8');
  // The single hardcoded literal is what mis-described every callable row.
  assert.doesNotMatch(
    src,
    /\? \{ planningRefStatus: 'unsupported_unmaterialized' as const \}\n\s*: \{\}\),/,
    'the ref-less branch must consult the refusal reason and the carrier, not stamp one literal',
  );
  assert.match(src, /const localPlanningRowStatus/);
  assert.match(src, /planningRefStatus: 'dispatch_now'/);
});

test('a destructive row is named but never invited', () => {
  const src = readFileSync(SEARCH, 'utf8');
  // The reason a plan will not carry it is the same reason the page must not
  // nudge the model to fire it. It must be reachable in the status branch and
  // absent from the callable list.
  assert.match(src, /refused === 'destructive' \|\| refused === 'irreversible_or_unknown'/);
  assert.match(src, /planningRefStatus: 'not_plannable_destructive'/);
  const hint = src.slice(src.indexOf('const callableNow'), src.indexOf('const callableNow') + 700);
  assert.match(
    hint,
    /status\.planningRefStatus === 'dispatch_now'/,
    'the invitation list must be built from dispatch_now only, so destructive rows can never enter it',
  );
});

test('the walk-away hint is conditional on there being no door', () => {
  const src = readFileSync(SEARCH, 'utf8');
  const idx = src.indexOf('No returned candidate was materialized');
  assert.ok(idx > 0, 'the original hint must still exist for the genuinely-doorless case');
  // It must be guarded: the callable branch returns before it.
  const before = src.slice(Math.max(0, idx - 900), idx);
  assert.match(
    before,
    /if \(callableNow\.length > 0\) \{[\s\S]*return `None of these can be CITED/,
    'the "refine discovery" line must be unreachable while a callable row exists',
  );
});
