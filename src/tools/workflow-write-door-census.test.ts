/**
 * Run: npx tsx --test src/tools/workflow-write-door-census.test.ts
 *
 * THE FAILURE THIS EXISTS FOR. A second user asked Clem to turn a workflow on.
 * `workflow_set_enabled` is tier "discoverable" and sits in the orchestrator
 * lane, so tool_search kept handing it back — but it carried no `localPlanning`
 * declaration, so `deriveLocalPlanningDefinition` answered `not_declared`, no
 * `cap:local:workflow_set_enabled:*` was ever minted, and the work_call door
 * had nothing to bind. A direct `call_tool` on a write refuses `coverage_missing`.
 * The tool was therefore VISIBLE AND UNCALLABLE: the user said "just turn it
 * on" over and over, and the only thing that always works — `workflow_create`,
 * whose create_new posture is unconditionally admitted — is what she reached
 * for instead. He got a duplicate workflow instead of an enabled one.
 * (This home's eventlog agrees: the last `workflow_set_enabled` that actually
 * executed was 2026-08-06, while tool_search kept returning it through 09-09.)
 *
 * A missing door is silent in every other test: the registry row is valid, the
 * handler works, the unit tests pass. Only the census is loud. Each doorless
 * row below must therefore state WHY it is doorless — a new one has to come
 * here and say so out loud rather than ship as a dead end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_REGISTRY } from './tool-registry.js';
import { isRegistryDeclaredLocalPlanningMutation } from '../runtime/harness/local-planning-capability.js';

/** Lanes the model itself calls from. A cli-only tool is a human's door. */
const MODEL_LANES = new Set(['orchestrator', 'sdk-brain']);

/**
 * The ONLY model-reachable workflow writes allowed to have no local-planning
 * door, each with the reason it is not a dead end.
 */
const DOORLESS_BY_DESIGN: Record<string, string> = {
  // host_only never crosses, so consent proceeds on `no_effect` — no coverage needed.
  workflow_capability_resolve: 'runtimeEffect host_only takes the no-effect path',
  // Destructive + irreversible is refused by derive on purpose; deletion is a
  // human-approved act, not ordinary accepted work.
  workflow_delete: 'destructive and irreversible by declaration',
  // Operate on an ACTIVE RUN from inside it; the run's own authority governs
  // them, not a chat turn's local-planning capability.
  workflow_reshape: 'in-run authority (workflow-step lane), not a chat-turn door',
  workflow_state: 'in-run durable memory (workflow-step lane), not a chat-turn door',
  // Pulls package content from a folder or GitHub — not a local reversible write.
  workflow_import_framework: 'imports external package content, not a local write',
  // TODO(owner): both are plausible one-line declarations, unproven in the
  // field. Named here so they are a decision, not an oversight.
  workflow_from_session: 'UNRESOLVED — authors a new workflow, no field evidence yet',
  workflow_rerun_failed_items: 'UNRESOLVED — dispatch-shaped, no field evidence yet',
};

const modelReachableWorkflowWrites = TOOL_REGISTRY
  .filter((row) => row.name.startsWith('workflow_')
    && row.sideEffect !== 'read'
    && (row.lanes ?? []).some((lane) => MODEL_LANES.has(lane)))
  .map((row) => row.name);

test('every model-reachable workflow write either has a door or says why not', () => {
  assert.ok(modelReachableWorkflowWrites.length >= 10, 'the census actually found the workflow surface');
  const dead: string[] = [];
  for (const name of modelReachableWorkflowWrites) {
    if (isRegistryDeclaredLocalPlanningMutation(name)) continue;
    if (Object.hasOwn(DOORLESS_BY_DESIGN, name)) continue;
    dead.push(name);
  }
  assert.deepEqual(
    dead,
    [],
    `${dead.join(', ')} is model-reachable, writes, and has no callable door: tool_search will `
    + 'offer it and every call will refuse. Declare localPlanning, or add it to DOORLESS_BY_DESIGN '
    + 'with the reason it is not a dead end.',
  );
});

test('turning a workflow on is a callable, reversible, named-existing act', () => {
  assert.equal(
    isRegistryDeclaredLocalPlanningMutation('workflow_set_enabled'),
    true,
    '"just turn it on" must bind a door — this is the exact call the second user could not get',
  );
  const row = TOOL_REGISTRY.find((entry) => entry.name === 'workflow_set_enabled');
  assert.ok(row?.localPlanning, 'declared');
  // Enable/disable is the twin of workflow_unschedule: same consequence, same
  // deliverable, same posture. Drift between the two is a bug in one of them.
  const twin = TOOL_REGISTRY.find((entry) => entry.name === 'workflow_unschedule')?.localPlanning;
  assert.ok(twin, 'workflow_unschedule still declares its planning semantics');
  assert.equal(row!.localPlanning!.consequence, twin!.consequence);
  assert.equal(row!.localPlanning!.deliverableKind, twin!.deliverableKind);
  assert.equal(row!.localPlanning!.destinationPosture, 'named_existing', 'it acts on a workflow that exists');
  assert.equal(row!.localPlanning!.reversibility, 'reversible', 'toggling back off restores the prior state');
  assert.equal(row!.localPlanning!.destructive, false);
});

test('the exception list stays honest — no stale entry for a tool that has a door', () => {
  const stale = Object.keys(DOORLESS_BY_DESIGN)
    .filter((name) => isRegistryDeclaredLocalPlanningMutation(name));
  assert.deepEqual(stale, [], `${stale.join(', ')} now has a door; drop it from DOORLESS_BY_DESIGN`);
  const gone = Object.keys(DOORLESS_BY_DESIGN)
    .filter((name) => !TOOL_REGISTRY.some((row) => row.name === name));
  assert.deepEqual(gone, [], `${gone.join(', ')} is no longer a registry row`);
});
