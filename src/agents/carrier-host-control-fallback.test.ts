/** Run: node scripts/run-tests-isolated.mjs src/agents/carrier-host-control-fallback.test.ts
 *
 * On a carrier turn the dispatcher's first-class set was emptied wholesale,
 * which removed the "first-class-wrap fallback" the comment beside it promises.
 * A host-local control that IS on the turn's surface then read as unreachable,
 * so a wrapped call to it looped on not_reachable. Live 2026-09-03 runs 23 and
 * 25 both wrapped the planning control, were told "call it directly", wrapped
 * it again, and hit the refusal ceiling carrying a correct plan.
 *
 * The filter reads the ACTUAL surface, not the registry: a dormant control that
 * was deliberately subtracted stays excluded and keeps its own authority
 * checks (an earlier registry-keyed attempt let one dispatch without
 * continuation authority, caught by action-control-surface.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./orchestrator.ts', import.meta.url), 'utf8');

test('a carrier turn keeps host-local controls that are on the surface', () => {
  const i = SRC.indexOf('firstClassNames: carrierWork');
  assert.ok(i > 0, 'the carrier-turn first-class set must exist');
  const block = SRC.slice(i, i + 400);
  assert.doesNotMatch(block, /carrierWork \? new Set<string>\(\) :/,
    'emptying it wholesale removes the documented wrap fallback');
  assert.match(block, /isHostOnlyActionControl/, 'only host-local controls survive the filter');
  // The filter must read the actual surface AND the structural names. Filtering
  // `firstClassNames` alone was INERT: that set comes from the discovery surface
  // (deriveOrchestratorDiscoveryNames -> lanes includes 'orchestrator') and
  // plan_task declares `lanes: []`, entering as a STRUCTURAL tool. Verified live
  // on cbbd573c — Sonnet still hit "available, but not through this carrier",
  // wrapped twice, and the frame-refusal ceiling ended the turn while the
  // governor was still reporting retry_available.
  assert.match(block, /\.\.\.firstClassNames/,
    'the actual surface is still read, so dormant controls stay excluded');
  assert.match(block, /structuralControlNames/,
    'and structural controls are unioned in, or the filter has an empty intersection');
});

test('business tools are not admitted to the control dispatcher', () => {
  const i = SRC.indexOf('firstClassNames: carrierWork');
  const block = SRC.slice(i, i + 400);
  // isHostOnlyActionControl excludes provider carriers by runtimeEffect, which
  // is what keeps work_call the only door for business writes.
  assert.doesNotMatch(block, /isRegisteredActionControl/,
    'the broader control predicate would admit provider carriers');
});
