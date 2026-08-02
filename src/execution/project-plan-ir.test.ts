/**
 * Run: npx tsx --test src/execution/project-plan-ir.test.ts
 *
 * The IR's job is to reject plans that are unsafe or unrunnable while staying
 * completely incurious about what a plan is FOR. Every fixture is from a
 * different (mostly invented) domain, and no assertion depends on subject
 * matter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalPlanJson,
  canonicalProjectPlan,
  defaultApprovalFor,
  planIdError,
  projectPlanHash,
  topologicalNodeOrder,
  toolIsCanonicalRead,
  validateProjectPlan,
  PROJECT_DISCOVERY_KERNEL,
  PROJECT_DISCOVERY_KERNEL_ERRORS,
  PROJECT_NODE_DEFAULT_MAX_TURNS,
  PROJECT_NODE_TURN_CEILING,
  type ProjectNode,
  type ProjectPlan,
} from './project-plan-ir.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function readNode(id: string, extra: Partial<ProjectNode> = {}): ProjectNode {
  return {
    id,
    executor: { kind: 'model', instruction: `Collect the ${id} evidence for this project.` },
    effect: 'read',
    ...extra,
  };
}

/** A converged two-branch plan: the smallest shape that satisfies topology. */
function joinedPlan(extra: Partial<ProjectNode> = {}): ProjectPlan {
  return {
    objective: 'an objective',
    nodes: [
      readNode('left'),
      readNode('right'),
      readNode('join', { dependsOn: ['left', 'right'], ...extra }),
    ],
  };
}

function plan(nodes: ProjectNode[], extra: Partial<ProjectPlan> = {}): ProjectPlan {
  return { objective: 'an objective', nodes, ...extra };
}

const errorsOf = (candidate: unknown): string => validateProjectPlan(candidate).errors.join(' | ');

// ── kernel ───────────────────────────────────────────────────────────────────

test('the discovery kernel is proven read-only against the canonical registry', () => {
  assert.deepEqual([...PROJECT_DISCOVERY_KERNEL_ERRORS], [],
    'a registry change that widened a kernel tool must fail here, loudly');
  assert.ok(PROJECT_DISCOVERY_KERNEL.length > 0);
  for (const tool of PROJECT_DISCOVERY_KERNEL) {
    assert.equal(toolIsCanonicalRead(tool), true, `${tool} must be read-class`);
  }
  // The kernel cannot dispatch: a generic invoker would be wildcard authority
  // under a smaller name.
  assert.ok(!PROJECT_DISCOVERY_KERNEL.includes('call_tool'));
});

// ── canonical identity ───────────────────────────────────────────────────────

test('every set-like field is canonicalized, especially dependsOn', () => {
  const messy = plan([
    readNode('b'),
    readNode('a'),
    readNode('join', {
      dependsOn: ['b', 'a', 'b'],
      executor: { kind: 'model', instruction: 'Join them.', allowedTools: ['tool_search', 'tool_search', 'recall_tool_result'] },
      evidence: {
        requiredKeys: ['z', 'a', 'z'],
        nonEmpty: ['b', 'a'],
        verify: { pathExists: ['q', 'p'], urlPresent: ['v', 'u'] },
      },
    }),
  ]);
  const canon = canonicalProjectPlan(messy);
  assert.deepEqual(canon.nodes.map((node) => node.id), ['a', 'b', 'join']);
  const join = canon.nodes.find((node) => node.id === 'join')!;
  assert.deepEqual(join.dependsOn, ['a', 'b'], 'deduped and sorted');
  assert.deepEqual((join.executor as { allowedTools?: string[] }).allowedTools,
    ['recall_tool_result', 'tool_search']);
  assert.deepEqual(join.evidence?.requiredKeys, ['a', 'z']);
  assert.deepEqual(join.evidence?.nonEmpty, ['a', 'b']);
  assert.deepEqual(join.evidence?.verify?.pathExists, ['p', 'q']);
  assert.deepEqual(join.evidence?.verify?.urlPresent, ['u', 'v']);
});

test('dependency permutations produce an identical plan hash', () => {
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
  const fewerDeps = plan([readNode('a'), readNode('b'), readNode('join', { dependsOn: ['a'] })]);
  assert.notEqual(projectPlanHash(forward), projectPlanHash(fewerDeps));
});

test('capability and evidence ordering are sets too, not meaning', () => {
  const one = plan([readNode('a', {
    executor: { kind: 'model', instruction: 'i', allowedTools: ['tool_search', 'recall_tool_result'] },
    evidence: { requiredKeys: ['x', 'y'] },
  })]);
  const two = plan([readNode('a', {
    executor: { kind: 'model', instruction: 'i', allowedTools: ['recall_tool_result', 'tool_search'] },
    evidence: { requiredKeys: ['y', 'x'] },
  })]);
  assert.equal(projectPlanHash(one), projectPlanHash(two));

  const wider = plan([readNode('a', {
    executor: { kind: 'model', instruction: 'i', allowedTools: ['tool_search', 'recall_tool_result', 'list_files'] },
    evidence: { requiredKeys: ['x', 'y'] },
  })]);
  assert.notEqual(projectPlanHash(one), projectPlanHash(wider), 'adding a capability is a real change');
});

test('planId must already be a safe slug', () => {
  assert.equal(planIdError('thrumcap-survey'), null);
  assert.equal(planIdError('a'), null);
  for (const bad of ['', '   ', '...', '---', 'Has Spaces', 'UPPER', '-lead', 'trail-', 'a'.repeat(49), '../escape']) {
    assert.ok(planIdError(bad), `planId "${bad}" must be rejected`);
  }
  assert.match(errorsOf(plan([readNode('a')], { planId: '...' })), /not a safe identity/);
  assert.match(errorsOf(plan([readNode('a')], { planId: '' })), /non-empty string/);
});

// ── tool authority ───────────────────────────────────────────────────────────

test('wildcard tool authority is not expressible', () => {
  assert.match(
    errorsOf(plan([readNode('a', { executor: { kind: 'model', instruction: 'x', allowedTools: ['*'] } })])),
    /may not request wildcard tool authority/,
  );
});

test('a named capability list must be exact and known to the registry', () => {
  assert.match(
    errorsOf(plan([readNode('a', {
      executor: { kind: 'model', instruction: 'x', allowedTools: ['definitely_not_a_tool'] },
    })])),
    /names unknown tool "definitely_not_a_tool"/,
  );
  assert.match(
    errorsOf(plan([readNode('a', { executor: { kind: 'model', instruction: 'x', allowedTools: [] } })])),
    /must be a non-empty list/,
  );
  assert.equal(
    validateProjectPlan(plan([readNode('a', {
      executor: { kind: 'model', instruction: 'x', allowedTools: ['tool_search'] },
    })])).ok,
    true,
  );
});

test('a structured call needs one exact, known, read-class tool', () => {
  const call = (tool: string): ProjectPlan =>
    plan([{ id: 'c', executor: { kind: 'structured_call', tool }, effect: 'read' }]);
  assert.match(errorsOf(call('  ')), /requires an exact tool name/);
  assert.match(errorsOf(call('SOME_*')), /must be an exact name, not a pattern or template/);
  assert.match(errorsOf(call('{{tool}}')), /must be an exact name, not a pattern or template/);
  assert.match(errorsOf(call('definitely_not_a_tool')), /names unknown tool/);
  // A mutating structured call is the family that would need the binding the
  // definition cannot carry, so it is refused at the same boundary.
  assert.match(errorsOf(call('note_create')), /is not a canonical read/);
  assert.equal(validateProjectPlan(call('list_files')).ok, true);
});

// ── budgets ──────────────────────────────────────────────────────────────────

test('turn budgets are per node, bounded, and validated independently', () => {
  assert.ok(PROJECT_NODE_DEFAULT_MAX_TURNS < PROJECT_NODE_TURN_CEILING / 4,
    'the default must be substantially smaller than the ceiling');

  // Several nodes may each sit AT the ceiling: it bounds a node, not a project.
  const manyAtCeiling = plan([
    readNode('a', { maxTurns: PROJECT_NODE_TURN_CEILING }),
    readNode('b', { maxTurns: PROJECT_NODE_TURN_CEILING }),
    readNode('join', { dependsOn: ['a', 'b'], maxTurns: PROJECT_NODE_TURN_CEILING }),
  ]);
  assert.equal(validateProjectPlan(manyAtCeiling).ok, true, errorsOf(manyAtCeiling));

  assert.match(
    errorsOf(plan([readNode('a', { maxTurns: PROJECT_NODE_TURN_CEILING + 1 })])),
    /exceeds the 64-turn per-node ceiling/,
  );
  assert.match(errorsOf(plan([readNode('a', { maxTurns: 0 })])), /maxTurns must be a positive integer/);
  assert.match(errorsOf(plan([readNode('a', { maxTurns: 2.5 })])), /maxTurns must be a positive integer/);
  assert.match(errorsOf(plan([readNode('a', { retries: -1 })])), /retries must be a non-negative integer/);

  // One bad node is reported without excusing the others.
  const mixed = plan([
    readNode('ok_one', { maxTurns: 4 }),
    readNode('bad', { maxTurns: 900 }),
    readNode('join', { dependsOn: ['ok_one', 'bad'] }),
  ]);
  assert.match(errorsOf(mixed), /node "bad" maxTurns 900 exceeds/);
});

// ── topology ─────────────────────────────────────────────────────────────────

test('a multi-branch project must converge on exactly one terminal sink', () => {
  // Two open branches: which one is the answer?
  assert.match(
    errorsOf(plan([readNode('a'), readNode('b')])),
    /must converge on exactly one terminal node; found 2/,
  );
  // An orphan branch is the same failure: nothing consumes its result.
  assert.match(
    errorsOf(plan([readNode('a'), readNode('b'), readNode('c', { dependsOn: ['a'] })])),
    /must converge on exactly one terminal node/,
  );
  assert.equal(validateProjectPlan(joinedPlan()).ok, true);
});

test('a genuinely single-node project is still allowed', () => {
  assert.equal(validateProjectPlan(plan([readNode('only')])).ok, true);
});

test('static fan-out must have a downstream fan-in', () => {
  // Three branches from one source, each terminating separately.
  const unjoined = plan([
    readNode('src'),
    readNode('x', { dependsOn: ['src'] }),
    readNode('y', { dependsOn: ['src'] }),
    readNode('tail', { dependsOn: ['x'] }),
  ]);
  const errors = errorsOf(unjoined);
  assert.match(errors, /Fan-out from "src" into 2 branches \(x, y\) has no fan-in/);

  const joined = plan([
    readNode('src'),
    readNode('x', { dependsOn: ['src'] }),
    readNode('y', { dependsOn: ['src'] }),
    readNode('reduce', { dependsOn: ['x', 'y'] }),
  ]);
  assert.equal(validateProjectPlan(joined).ok, true, errorsOf(joined));
});

test('fan-out → reducer → verify is the canonical accepted shape', () => {
  const shaped = plan([
    readNode('probe_a'),
    readNode('probe_b'),
    readNode('probe_c'),
    readNode('reduce', { dependsOn: ['probe_a', 'probe_b', 'probe_c'] }),
    readNode('verify', { dependsOn: ['reduce'] }),
  ]);
  assert.equal(validateProjectPlan(shaped).ok, true, errorsOf(shaped));
});

test('a dynamic node releases exactly one aggregate downstream', () => {
  const base = (dependents: number): ProjectPlan => plan([
    readNode('collect', { evidence: { type: 'object', requiredKeys: ['items'] } }),
    readNode('each', { dependsOn: ['collect'], fanOut: { fromNode: 'collect', path: 'items' } }),
    ...Array.from({ length: dependents }, (_, i) => readNode(`sink_${i}`, { dependsOn: ['each'] })),
  ]);
  assert.match(errorsOf(base(0)), /must release its aggregate to exactly one downstream reducer; found 0/);
  assert.match(errorsOf(base(2)), /must release its aggregate to exactly one downstream reducer; found 2/);
  assert.equal(validateProjectPlan(base(1)).ok, true, errorsOf(base(1)));
});

test('mutating per-item fan-out is refused', () => {
  const mutating = plan([
    readNode('collect'),
    readNode('each', {
      dependsOn: ['collect'],
      effect: 'local_write',
      fanOut: { fromNode: 'collect' },
    }),
    readNode('reduce', { dependsOn: ['each'] }),
  ]);
  assert.match(errorsOf(mutating), /fans out with effect "local_write"; only read-class per-item work is supported/);
});

test('fan-out must name a declared node that this node depends on', () => {
  assert.match(
    errorsOf(joinedPlan({ fanOut: { fromNode: 'left' } })),
    /fans out from "left", which is not one of its declared dependencies|/,
  );
  assert.match(
    errorsOf(plan([readNode('each', { dependsOn: ['nowhere'], fanOut: { fromNode: 'nowhere' } })])),
    /which no node declares/,
  );
  assert.match(
    errorsOf(plan([
      readNode('src'),
      readNode('each', { dependsOn: ['src'], fanOut: { fromNode: 'src', path: 'a..b' } }),
    ])),
    /is not a valid dot-path/,
  );
});

// ── graph soundness ──────────────────────────────────────────────────────────

test('duplicate ids, dangling edges and cycles are rejected', () => {
  assert.match(errorsOf(plan([readNode('a'), readNode('a')])), /Duplicate node id "a"/);
  assert.match(errorsOf(plan([readNode('a', { dependsOn: ['ghost'] })])), /depends on "ghost", which no node declares/);
  assert.match(
    errorsOf(plan([readNode('a', { dependsOn: ['b'] }), readNode('b', { dependsOn: ['a'] })])),
    /dependency cycle/,
  );
  assert.match(errorsOf(plan([readNode('a', { dependsOn: ['a'] })])), /depends on itself/);
});

// ── evidence ─────────────────────────────────────────────────────────────────

test('evidence is validated deeply — nulls, empties and bad paths cannot pass', () => {
  const withEvidence = (evidence: unknown): ProjectPlan =>
    plan([readNode('a', { evidence: evidence as never })]);

  assert.match(errorsOf(withEvidence({ requiredKeys: [null] })), /contains a non-string or empty entry/);
  assert.match(errorsOf(withEvidence({ requiredKeys: [''] })), /contains a non-string or empty entry/);
  assert.match(errorsOf(withEvidence({ requiredKeys: [] })), /must be a non-empty array of dot-paths/);
  assert.match(errorsOf(withEvidence({ nonEmpty: ['a..b'] })), /is not a valid dot-path/);
  assert.match(errorsOf(withEvidence({ nonEmpty: ['../escape'] })), /is not a valid dot-path/);
  assert.match(errorsOf(withEvidence({ verify: { urlPresent: [42] } })), /contains a non-string or empty entry/);
  // Canonicalization must never launder bad input into valid-looking input:
  // an earlier version coerced [null] to ["null"], a perfectly good dot-path.
  assert.match(errorsOf(withEvidence({ nonEmpty: [null] })), /contains a non-string or empty entry/);
  assert.match(errorsOf(plan([readNode('a', { dependsOn: [null] as never })])), /dependsOn must be a list of node ids/);
  assert.match(errorsOf(withEvidence({ verify: 'yes' })), /evidence.verify must be an object/);
  assert.match(errorsOf(withEvidence({ minItems: { 'a..b': 1 } })), /is not a valid dot-path/);
  assert.match(errorsOf(withEvidence({ minItems: { rows: -1 } })), /must be a non-negative integer/);
  assert.match(errorsOf(withEvidence({ type: 'blob' })), /not a supported contract type/);
  assert.match(errorsOf(withEvidence('nope')), /evidence must be an object/);

  assert.equal(validateProjectPlan(withEvidence({
    type: 'object', requiredKeys: ['rows'], nonEmpty: ['rows'], minItems: { rows: 1 },
  })).ok, true);
});

// ── external write ───────────────────────────────────────────────────────────

test('an external write must be a structured call with a full prior-approval binding', () => {
  const external = (node: Partial<ProjectNode>): ProjectPlan => plan([{
    id: 'publish',
    executor: { kind: 'structured_call', tool: 'list_files' },
    effect: 'external_write',
    ...node,
  } as ProjectNode]);

  // No binding at all.
  assert.match(errorsOf(external({})), /without an externalWrite binding/);

  // A model executor can never be an external write.
  assert.match(
    errorsOf(external({ executor: { kind: 'model', instruction: 'publish it' } })),
    /must be an exact structured call/,
  );

  // Every binding field is required, and digests must be digests.
  const partial = external({
    externalWrite: {
      operation: 'op', accountRef: 'acct', target: 'tgt',
      argumentsDigest: 'not-a-digest', planDigest: DIGEST_B,
      priorApprovalId: 'apr-1',
      readback: { operation: 'read_back', expect: { requiredKeys: ['id'] } },
    },
  });
  assert.match(errorsOf(partial), /argumentsDigest must be a sha256 digest/);

  // A readback that asserts nothing about content is not proof.
  const shapeOnly = external({
    externalWrite: {
      operation: 'op', accountRef: 'acct', target: 'tgt',
      argumentsDigest: DIGEST_A, planDigest: DIGEST_B, priorApprovalId: 'apr-1',
      readback: { operation: 'read_back', expect: { minItems: { rows: 1 } } },
    },
  });
  assert.match(errorsOf(shapeOnly), /must assert content, not merely a shape or a count/);

  // A local path or URL is not a provider readback either — the binding demands
  // an operation, and expect must assert content.
  const missingReadbackOp = external({
    externalWrite: {
      operation: 'op', accountRef: 'acct', target: 'tgt',
      argumentsDigest: DIGEST_A, planDigest: DIGEST_B, priorApprovalId: 'apr-1',
      readback: { operation: '', expect: { verify: { urlPresent: ['url'] } } } as never,
    },
  });
  assert.match(errorsOf(missingReadbackOp), /readback.operation is required — a provider observation/);
});

test('a plan may not waive approval, nor demand one where nothing external happens', () => {
  assert.match(
    errorsOf(plan([{
      id: 'publish',
      executor: { kind: 'structured_call', tool: 'list_files' },
      effect: 'external_write',
      approval: 'not_required',
    } as ProjectNode])),
    /a plan cannot waive approval/,
  );
  assert.match(errorsOf(plan([readNode('a', { approval: 'required' })])), /crosses no external boundary/);
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

// ── structure + determinism ──────────────────────────────────────────────────

test('structural rejects: not an object, no nodes, bad ids, unknown executor', () => {
  assert.match(errorsOf(null), /must be an object/);
  assert.match(errorsOf(plan([])), /at least one node/);
  assert.match(errorsOf({ objective: '', nodes: [readNode('a')] }), /non-empty objective/);
  assert.match(errorsOf(plan([readNode('has space')])), /needs an id of letters/);
  assert.match(errorsOf({ objective: 'o', nodes: ['nope'] }), /must be an object/);
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
  assert.notEqual(canonicalPlanJson(a), canonicalPlanJson({ ...a, nodes: [{ ...a.nodes[0], id: 'other' }] }));
});

test('topological order respects dependencies and is stable for independents', () => {
  const nodes = [
    readNode('reduce', { dependsOn: ['c', 'a', 'b'] }),
    readNode('b'), readNode('a'), readNode('c'),
  ];
  const order = topologicalNodeOrder(nodes).map((node) => node.id);
  assert.deepEqual(order.slice(0, 3), ['a', 'b', 'c']);
  assert.equal(order.at(-1), 'reduce');
  assert.deepEqual(topologicalNodeOrder([nodes[2], nodes[0], nodes[3], nodes[1]]).map((n) => n.id), order);
});

test('an entirely unfamiliar objective validates with no special-casing', () => {
  const invented = plan(
    [
      readNode('survey_glarnix_beds'),
      readNode('sample_thrumcap_density'),
      readNode('reconcile', { dependsOn: ['survey_glarnix_beds', 'sample_thrumcap_density'] }),
    ],
    { objective: 'Catalogue the thrumcap density of every glarnix bed in the northern quadrant.' },
  );
  assert.equal(validateProjectPlan(invented).ok, true, errorsOf(invented));
});
