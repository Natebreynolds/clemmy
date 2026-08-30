/**
 * Clem's own tools must not be deterministically outranked by the world.
 *
 * The tiering intent, stated at the call site, is:
 *   acquired live read > connected broker membership > her own catalog > the rest.
 *
 * On a planning turn that structure collapsed. PLANNING_PROVIDER_RANK_BOOST (2)
 * was applied to EVERY provider row whether or not its toolkit was connected,
 * while her own catalog got +1 — and both base scores are bounded [0,1]. So
 * providers occupied [2,3] and built-ins [1,2], and no built-in could ever
 * outrank any provider at any relevance.
 *
 * Live 2026-08-28: "I need this to update please and refresh" against a
 * workspace returned twenty SALESFORCE_/ASANA_/SLACK_/APIFY_ rows and ZERO
 * space_* tools. The workspace tools were not mis-ranked — they never entered
 * the window to be ranked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = new URL('./tool-search-tool.ts', import.meta.url);

function constant(src: string, name: string): number {
  const m = src.match(new RegExp(`const ${name} = ([0-9.]+);`));
  assert.ok(m, `${name} must exist`);
  return Number(m![1]);
}

test('her own catalog is not outranked by construction', () => {
  const src = readFileSync(SRC, 'utf8');
  const own = constant(src, 'OWN_CATALOG_RANK_BOOST');
  const planning = constant(src, 'PLANNING_PROVIDER_RANK_BOOST');
  // Both rankers bound base to [0,1], so the boosts alone decide whether a
  // built-in can EVER outrank a provider. If the provider floor sits above the
  // built-in ceiling, relevance stops mattering — that is the regression.
  const BASE_MAX = 1;
  const providerFloor = planning;
  const builtinCeiling = own + BASE_MAX;
  assert.ok(
    builtinCeiling > providerFloor,
    `a highly relevant built-in must be able to outrank a weak provider row (built-in ceiling ${builtinCeiling} must exceed provider floor ${providerFloor})`,
  );
});

test('an acquired live read tops the order ON A PLANNING TURN', () => {
  const src = readFileSync(SRC, 'utf8');
  const own = constant(src, 'OWN_CATALOG_RANK_BOOST');
  const planning = constant(src, 'PLANNING_PROVIDER_RANK_BOOST');
  const acquired = constant(src, 'ACQUIRED_LIVE_READ_RANK_BOOST');
  // Equal footing must not become precedence. This is the mode that matters:
  // citability only exists on a planning turn, so the acquired tier has to
  // clear the built-in ceiling here.
  assert.ok(planning + acquired > own + 1, 'acquired must outrank the built-in ceiling when planning');
  assert.ok(acquired > 0, 'the acquired boost must remain a real tier');
});

test('the tier order does NOT hold on a non-planning turn — pinned as known', () => {
  const src = readFileSync(SRC, 'utf8');
  const own = constant(src, 'OWN_CATALOG_RANK_BOOST');
  const connected = constant(src, 'CONNECTED_TOOLKIT_RANK_BOOST');
  const acquired = constant(src, 'ACQUIRED_LIVE_READ_RANK_BOOST');
  // HONEST PIN, NOT AN ASSERTION THAT ALL IS WELL.
  //
  // Off a planning turn the provider term drops from PLANNING_PROVIDER_RANK_BOOST
  // to CONNECTED_TOOLKIT_RANK_BOOST (or zero), so an acquired live read sits in
  // [2.5] against a built-in ceiling of [2.5] — it ties rather than tops. The
  // documented order ("acquired > membership > her own catalog > the rest") is
  // therefore a PLANNING-TURN order only, and was so before OWN_CATALOG_RANK_BOOST
  // was raised as well; raising it changed an overlap into an exact tie.
  //
  // This is pinned rather than silently fixed because only orchestrator.ts passes
  // a planning identity today; mcp-server.ts and claude-agent-brain.ts do not, and
  // changing their ordering is a behavior change on lanes with no live measurement
  // behind it. If a future change makes acquired top the order here too, this test
  // SHOULD fail and be updated deliberately — that is the point of pinning it.
  const acquiredCeilingNonPlanning = connected + acquired + 1;
  const builtinCeiling = own + 1;
  assert.equal(
    acquiredCeilingNonPlanning > builtinCeiling,
    false,
    'off a planning turn the acquired tier does NOT clear her catalog — known, deliberate, unmeasured elsewhere',
  );
});

test('providers keep their membership boost — visibility is not the fix', () => {
  const src = readFileSync(SRC, 'utf8');
  // An earlier attempt zeroed the boost for unconnected providers, which made
  // them vanish from the window rather than merely outrankable. Two existing
  // tests caught it. Ranking is the lever here, never visibility.
  assert.match(
    src,
    /const planningOrConnected = input\.discloseForPlanning\s*\n\s*\? PLANNING_PROVIDER_RANK_BOOST/,
    'the provider membership boost must remain unconditional on a planning turn',
  );
});
