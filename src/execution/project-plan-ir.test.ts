/**
 * Run: npx tsx --test src/execution/project-plan-ir.test.ts
 *
 * The IR's job is to reject plans that are unsafe or unrunnable while staying
 * completely incurious about what a plan is FOR. Every fixture here is
 * deliberately from a different (and mostly invented) domain, and none of the
 * assertions depend on the subject matter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalPlanJson,
  defaultApprovalFor,
  projectPlanHash,
  topologicalNodeOrder,
  validateProjectPlan,
  PROJECT_NODE_DEFAULT_MAX_TURNS,
  PROJECT_NODE_TURN_CEILING,
  type ProjectNode,
  type ProjectPlan,
} from './project-plan-ir.js';

function readNode(id: string, extra: Partial<ProjectNode> = {}): ProjectNode {
  return {
    id,
    executor: { kind: 'model', instruction: `do the ${id} reading` },
    effect: 'read',
    ...extra,
  };
}

function plan(nodes: ProjectNode[], extra: Partial<ProjectPlan> = {}): ProjectPlan {
  return { objective: 'an objective', nodes, ...extra };
}

const errorsOf = (candidate: unknown): string => validateProjectPlan(candidate).errors.join(' | ');

test('a minimal read plan validates', () => {
  const result = validateProjectPlan(plan([readNode('collect')]));
  assert.equal(result.ok, true, result.errors.join(' | '));
});

test('duplicate node ids are rejected', () => {
  assert.match(errorsOf(plan([readNode('a'), readNode('a')])), /Duplicate node id "a"/);
});

test('dangling dependencies are rejected', () => {
  assert.match(
    errorsOf(plan([readNode('a', { dependsOn: ['ghost'] })])),
    /depends on "ghost", which no node declares/,
  );
});

test('cycles are rejected, including self-dependency', () => {
  assert.match(
    errorsOf(plan([
      readNode('a', { dependsOn: ['b'] }),
      readNode('b', { dependsOn: ['a'] }),
    ])),
    /dependency cycle/,
  );
  assert.match(errorsOf(plan([readNode('a', { dependsOn: ['a'] })])), /depends on itself/);
});

test('turn budgets are bounded well under the safety ceiling', () => {
  assert.equal(validateProjectPlan(plan([readNode('a', { maxTurns: 12 })])).ok, true);
  assert.ok(PROJECT_NODE_DEFAULT_MAX_TURNS < PROJECT_NODE_TURN_CEILING / 4,
    'the default must be substantially smaller than the ceiling, not merely under it');

  assert.match(
    errorsOf(plan([readNode('a', { maxTurns: PROJECT_NODE_TURN_CEILING + 1 })])),
    /exceeds the 64-turn safety ceiling/,
  );
  assert.match(errorsOf(plan([readNode('a', { maxTurns: 0 })])), /maxTurns must be a positive integer/);
  assert.match(errorsOf(plan([readNode('a', { maxTurns: 2.5 })])), /maxTurns must be a positive integer/);
  assert.match(errorsOf(plan([readNode('a', { retries: -1 })])), /retries must be a non-negative integer/);
});

test('fan-out must name a declared node that this node depends on', () => {
  assert.match(
    errorsOf(plan([readNode('src'), readNode('each', { fanOut: { fromNode: 'src' } })])),
    /fans out from "src", which is not one of its declared dependencies/,
  );
  assert.match(
    errorsOf(plan([readNode('each', { dependsOn: ['nowhere'], fanOut: { fromNode: 'nowhere' } })])),
    /which no node declares/,
  );
  assert.equal(
    validateProjectPlan(plan([
      readNode('src'),
      readNode('each', { dependsOn: ['src'], fanOut: { fromNode: 'src', path: 'items' } }),
    ])).ok,
    true,
  );
});

test('a structured call needs an exact tool, never a pattern or template', () => {
  const structured = (tool: string): ProjectNode => ({
    id: 'call', executor: { kind: 'structured_call', tool }, effect: 'read',
  });
  assert.match(errorsOf(plan([structured('  ')])), /requires an exact tool name/);
  assert.match(errorsOf(plan([structured('SOME_*')])), /must be an exact name, not a pattern or template/);
  assert.match(errorsOf(plan([structured('{{tool}}')])), /must be an exact name, not a pattern or template/);
  assert.equal(validateProjectPlan(plan([structured('EXACT_TOOL_NAME')])).ok, true);
});

test('wildcard tool authority is not expressible', () => {
  assert.match(
    errorsOf(plan([readNode('a', {
      executor: { kind: 'model', instruction: 'x', allowedTools: ['*'] },
    })])),
    /may not request wildcard tool authority/,
  );
});

test('an external effect without concrete verification fails closed', () => {
  const external = (evidence?: ProjectNode['evidence']): ProjectPlan => plan([{
    id: 'publish',
    executor: { kind: 'model', instruction: 'make the result reachable' },
    effect: 'external_write',
    approvalPreview: 'preview',
    ...(evidence ? { evidence } : {}),
  }]);

  assert.match(errorsOf(external()), /without verification evidence/);
  // Shape alone is not verification: {required_keys:['url']} is satisfied by ''.
  assert.match(errorsOf(external({ requiredKeys: ['url'] })), /without verification evidence/);
  assert.equal(validateProjectPlan(external({ verify: { urlPresent: ['url'] } })).ok, true);
  assert.equal(validateProjectPlan(external({ verify: { pathExists: ['artifact'] } })).ok, true);
});

test('approval and effect may not contradict each other', () => {
  // A plan cannot waive the human on an external effect...
  assert.match(
    errorsOf(plan([{
      id: 'publish',
      executor: { kind: 'model', instruction: 'x' },
      effect: 'external_write',
      approval: 'not_required',
      evidence: { verify: { urlPresent: ['url'] } },
    }])),
    /a plan cannot waive approval/,
  );
  // ...nor demand one where no external boundary is crossed, which would be
  // theatre and would train users to click through.
  assert.match(
    errorsOf(plan([readNode('a', { approval: 'required' })])),
    /crosses no external boundary/,
  );
  assert.match(
    errorsOf(plan([readNode('a', { effect: 'local_write', approval: 'required' })])),
    /crosses no external boundary/,
  );
});

test('the safe approval default is derived from the effect class alone', () => {
  assert.equal(defaultApprovalFor('read'), 'not_required');
  assert.equal(defaultApprovalFor('local_write'), 'not_required');
  assert.equal(defaultApprovalFor('external_write'), 'required');
});

test('structural rejects: not an object, no nodes, bad ids, unknown executor', () => {
  assert.match(errorsOf(null), /must be an object/);
  assert.match(errorsOf(plan([])), /at least one node/);
  assert.match(errorsOf({ objective: '', nodes: [readNode('a')] }), /non-empty objective/);
  assert.match(errorsOf(plan([readNode('has space')])), /needs an id of letters/);
  assert.match(
    errorsOf(plan([{ id: 'x', effect: 'read', executor: { kind: 'nope' } } as never])),
    /unknown executor kind/,
  );
});

test('validation reports every problem, not just the first', () => {
  const result = validateProjectPlan(plan([
    readNode('dup'),
    readNode('dup', { maxTurns: 999 }),
    readNode('c', { dependsOn: ['missing'] }),
  ]));
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 3, `expected several errors, got ${result.errors.length}`);
});

test('canonical JSON is insensitive to key order but not to meaning', () => {
  const a = { objective: 'o', nodes: [{ id: 'n', effect: 'read', executor: { kind: 'model', instruction: 'i' } }] };
  const b = { nodes: [{ executor: { instruction: 'i', kind: 'model' }, effect: 'read', id: 'n' }], objective: 'o' };
  assert.equal(canonicalPlanJson(a), canonicalPlanJson(b));

  const different = { ...a, nodes: [{ ...a.nodes[0], id: 'other' }] };
  assert.notEqual(canonicalPlanJson(a), canonicalPlanJson(different));
});

test('plan hashing is stable across key order and sensitive to real change', () => {
  const ordered = plan([readNode('a'), readNode('b', { dependsOn: ['a'] })]);
  const shuffled: ProjectPlan = {
    nodes: [
      { effect: 'read', id: 'a', executor: { instruction: 'do the a reading', kind: 'model' } },
      { dependsOn: ['a'], effect: 'read', id: 'b', executor: { instruction: 'do the b reading', kind: 'model' } },
    ],
    objective: 'an objective',
  };
  assert.equal(projectPlanHash(ordered), projectPlanHash(shuffled));

  const changed = plan([readNode('a'), readNode('b', { dependsOn: ['a'], maxTurns: 9 })]);
  assert.notEqual(projectPlanHash(ordered), projectPlanHash(changed));
});

test('node order and dependency order are sets, not meaning', () => {
  // A plan's node list is keyed by id and its topology lives in dependsOn, so
  // reordering either must not change the plan's identity. Found by the
  // compiler determinism test: hashing the raw array made two identical plans
  // look different purely because their JSON listed the nodes in a different
  // order.
  const forward = plan([
    readNode('a'),
    readNode('b'),
    readNode('join', { dependsOn: ['a', 'b'] }),
  ]);
  const reversed = plan([
    readNode('join', { dependsOn: ['b', 'a'] }),
    readNode('b'),
    readNode('a'),
  ]);
  assert.equal(projectPlanHash(forward), projectPlanHash(reversed));

  // Set normalization must not blur a real difference.
  const extraDep = plan([
    readNode('a'),
    readNode('b'),
    readNode('join', { dependsOn: ['a'] }),
  ]);
  assert.notEqual(projectPlanHash(forward), projectPlanHash(extraDep));

  // Author-ordered payloads are NOT normalized: reordering them is a change.
  const toolsForward = plan([readNode('a', {
    executor: { kind: 'model', instruction: 'i', allowedTools: ['one', 'two'] },
  })]);
  const toolsReversed = plan([readNode('a', {
    executor: { kind: 'model', instruction: 'i', allowedTools: ['two', 'one'] },
  })]);
  assert.notEqual(projectPlanHash(toolsForward), projectPlanHash(toolsReversed));
});

test('topological order respects dependencies and is stable for independents', () => {
  const nodes = [
    readNode('reduce', { dependsOn: ['c', 'a', 'b'] }),
    readNode('b'),
    readNode('a'),
    readNode('c'),
  ];
  const order = topologicalNodeOrder(nodes).map((node) => node.id);
  assert.deepEqual(order.slice(0, 3), ['a', 'b', 'c'], 'independents sort by id, deterministically');
  assert.equal(order.at(-1), 'reduce');

  // Re-ordering the input array must not change the output.
  const reshuffled = topologicalNodeOrder([nodes[2], nodes[0], nodes[3], nodes[1]]).map((n) => n.id);
  assert.deepEqual(reshuffled, order);
});

test('an entirely unfamiliar objective validates with no special-casing', () => {
  const invented = plan(
    [
      readNode('survey_glarnix_beds'),
      readNode('sample_thrumcap_density', { dependsOn: ['survey_glarnix_beds'] }),
    ],
    { objective: 'Catalogue the thrumcap density of every glarnix bed in the northern quadrant.' },
  );
  assert.equal(validateProjectPlan(invented).ok, true);
});
