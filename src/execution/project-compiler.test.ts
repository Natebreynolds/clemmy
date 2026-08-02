/**
 * Run: npx tsx --test src/execution/project-compiler.test.ts
 *
 * The compiler must produce ordinary workflow steps that the EXISTING runtime
 * already knows how to schedule and persist. So the assertions below go through
 * the real primitives — `compileWorkflowStepsToGraph`, `validateWorkflowGraph`,
 * `getReadyWorkflowGraphNodes`, and `prepareWorkflowForWrite` — rather than
 * re-deriving readiness or runnability here. Output that only looked right to a
 * bespoke checker would prove nothing about how it actually runs.
 *
 * Nothing here reads or writes a stored workflow: every fixture is an in-memory
 * plan, and no test touches CLEMENTINE_HOME.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileProjectPlan,
  compiledProjectDefinitionHash,
  ProjectPlanCompileError,
} from './project-compiler.js';
import {
  PROJECT_DISCOVERY_KERNEL,
  PROJECT_NODE_DEFAULT_MAX_TURNS,
  PROJECT_NODE_TURN_CEILING,
  type ProjectNode,
  type ProjectPlan,
} from './project-plan-ir.js';
import {
  compileWorkflowStepsToGraph,
  getReadyWorkflowGraphNodes,
  validateWorkflowGraph,
} from './workflow-graph.js';
import { prepareWorkflowForWrite } from './workflow-enforce.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function read(id: string, extra: Partial<ProjectNode> = {}): ProjectNode {
  return {
    id,
    executor: { kind: 'model', instruction: `Collect and summarise the ${id} evidence for this project.` },
    effect: 'read',
    ...extra,
  };
}

/** fan-out → reducer → verify, in an invented domain. */
const FANOUT_PLAN: ProjectPlan = {
  planId: 'thrumcap-survey',
  objective: 'Catalogue thrumcap density across the northern glarnix beds.',
  nodes: [
    read('probe_north'),
    read('probe_east'),
    read('probe_west'),
    read('reduce_density', {
      dependsOn: ['probe_north', 'probe_east', 'probe_west'],
      executor: { kind: 'model', instruction: 'Join the three probe results into one density model.' },
      evidence: { type: 'object', requiredKeys: ['density_model'] },
    }),
    read('verify_density', {
      dependsOn: ['reduce_density'],
      executor: { kind: 'model', instruction: 'Confirm the joined density model against the raw probes.' },
      evidence: { type: 'object', requiredKeys: ['verified'], nonEmpty: ['verified'] },
    }),
  ],
};

function graphOf(planInput: ProjectPlan) {
  const compiled = compileProjectPlan(planInput);
  return {
    compiled,
    graph: compileWorkflowStepsToGraph(compiled.definition.steps, {
      id: compiled.workflowName,
      name: compiled.workflowName,
    }),
  };
}

// ── topology through the real graph ──────────────────────────────────────────

test('three independent nodes fan out, then one reducer and one verifier', () => {
  const { compiled, graph } = graphOf(FANOUT_PLAN);
  assert.deepEqual(compiled.stepIds, [
    'probe_east', 'probe_north', 'probe_west', 'reduce_density', 'verify_density',
  ]);
  assert.equal(validateWorkflowGraph(graph).ok, true, validateWorkflowGraph(graph).errors.join(' | '));

  const initiallyReady = getReadyWorkflowGraphNodes(graph, []).map((node) => node.id).sort();
  assert.deepEqual(initiallyReady, ['probe_east', 'probe_north', 'probe_west']);

  assert.deepEqual(getReadyWorkflowGraphNodes(graph, ['probe_north']).map((n) => n.id).sort(),
    ['probe_east', 'probe_west']);
  assert.deepEqual(
    getReadyWorkflowGraphNodes(graph, ['probe_north', 'probe_east', 'probe_west']).map((n) => n.id),
    ['reduce_density'],
  );
  assert.deepEqual(
    getReadyWorkflowGraphNodes(graph, ['probe_north', 'probe_east', 'probe_west', 'reduce_density'])
      .map((n) => n.id),
    ['verify_density'],
  );
});

test('dependencies stay a DAG and are never implicitly serialized', () => {
  const { compiled, graph } = graphOf(FANOUT_PLAN);
  for (const id of ['probe_north', 'probe_east', 'probe_west']) {
    assert.equal(compiled.definition.steps.find((s) => s.id === id)?.dependsOn, undefined);
  }
  assert.equal(graph.edges.filter((edge) => edge.target.startsWith('probe_')).length, 0);
});

// ── canonical identity ───────────────────────────────────────────────────────

test('dependency permutations yield identical hash, bytes, and definition hash', () => {
  const forward: ProjectPlan = {
    planId: 'stable-plan',
    objective: 'Do the thing.',
    nodes: [
      read('x'),
      read('y'),
      read('join', { dependsOn: ['x', 'y'] }),
    ],
  };
  // Same meaning: node order reversed, dependsOn reversed, keys reordered.
  const permuted: ProjectPlan = {
    nodes: [
      { effect: 'read', dependsOn: ['y', 'x'], id: 'join', executor: { instruction: 'Collect and summarise the join evidence for this project.', kind: 'model' } },
      { effect: 'read', id: 'y', executor: { instruction: 'Collect and summarise the y evidence for this project.', kind: 'model' } },
      { effect: 'read', id: 'x', executor: { instruction: 'Collect and summarise the x evidence for this project.', kind: 'model' } },
    ],
    objective: 'Do the thing.',
    planId: 'stable-plan',
  };

  const a = compileProjectPlan(forward);
  const b = compileProjectPlan(permuted);
  assert.equal(a.planHash, b.planHash);
  assert.equal(a.workflowName, b.workflowName);
  assert.deepEqual(a.stepIds, b.stepIds);
  assert.equal(compiledProjectDefinitionHash(a.definition), compiledProjectDefinitionHash(b.definition));
  // Byte-for-byte, not merely equivalent.
  assert.equal(JSON.stringify(a.definition), JSON.stringify(b.definition));
});

test('the workflow name is stable and derived, never random', () => {
  assert.equal(compileProjectPlan(FANOUT_PLAN).workflowName, 'thrumcap-survey');

  const anonymous = compileProjectPlan({ objective: 'o', nodes: [read('a')] });
  assert.match(anonymous.workflowName, /^project-[0-9a-f]{12}$/);
  assert.equal(compileProjectPlan({ objective: 'o', nodes: [read('a')] }).workflowName, anonymous.workflowName);
  assert.notEqual(compileProjectPlan({ objective: 'different', nodes: [read('a')] }).workflowName,
    anonymous.workflowName);
});

test('an unsafe or empty planId fails compilation rather than being slugified away', () => {
  for (const planId of ['...', '---', '   ', 'Has Spaces', '../escape']) {
    assert.throws(
      () => compileProjectPlan({ planId, objective: 'o', nodes: [read('a')] }),
      (err: unknown) => err instanceof ProjectPlanCompileError && /not a safe identity|non-empty string/.test(err.message),
      `planId "${planId}" must be refused`,
    );
  }
});

// ── tool authority ───────────────────────────────────────────────────────────

test('every compiled step carries an explicit, non-empty, non-wildcard capability list', () => {
  const { compiled } = graphOf(FANOUT_PLAN);
  for (const step of compiled.definition.steps) {
    assert.ok(Array.isArray(step.allowedTools) && step.allowedTools.length > 0,
      `${step.id} must name its capabilities; omission is legacy wildcard authority`);
    assert.ok(!step.allowedTools!.includes('*'));
  }
});

test('a node that names no tools gets the read-only discovery kernel, not a wildcard', () => {
  const { compiled } = graphOf({ objective: 'o', nodes: [read('lonely')] });
  assert.deepEqual(compiled.definition.steps[0].allowedTools, [...PROJECT_DISCOVERY_KERNEL]);
});

test('an authored capability list is used verbatim, canonicalized', () => {
  const { compiled } = graphOf({
    objective: 'o',
    nodes: [read('a', {
      executor: { kind: 'model', instruction: 'Read the files that matter.', allowedTools: ['read_file', 'list_files', 'read_file'] },
    })],
  });
  assert.deepEqual(compiled.definition.steps[0].allowedTools, ['list_files', 'read_file']);
});

test('a structured call pins exactly one tool, frozen args, and that tool as its authority', () => {
  const { compiled } = graphOf({
    objective: 'o',
    nodes: [{
      id: 'fetch',
      executor: { kind: 'structured_call', tool: 'list_files', args: { limit: 25 } },
      effect: 'read',
    }],
  });
  const step = compiled.definition.steps[0];
  assert.deepEqual(step.call, { tool: 'list_files', args: { limit: 25 } });
  assert.deepEqual(step.allowedTools, ['list_files']);
  assert.ok(step.prompt.length > 0);
});

// ── real WorkflowDefinition compatibility ────────────────────────────────────

test('compiler output is accepted by the canonical write contract with zero repairs', () => {
  const { compiled } = graphOf(FANOUT_PLAN);
  const prep = prepareWorkflowForWrite(compiled.definition);
  assert.equal(prep.ok, true, prep.errors.join(' | '));
  assert.deepEqual(prep.repairs, [], 'a repair means the compiler emitted something non-canonical');
  assert.equal(JSON.stringify(prep.def), JSON.stringify(compiled.definition),
    'the writer must persist exactly what the compiler emitted');
});

test('a definition the canonical writer would reject fails compilation, not admission', () => {
  // An insubstantial prompt is a real runnability failure the canonical
  // contract catches. The compiler must surface it, not pass it downstream.
  assert.throws(
    () => compileProjectPlan({
      objective: 'o',
      nodes: [{ id: 'a', executor: { kind: 'model', instruction: 'x' }, effect: 'read' }],
    }),
    (err: unknown) => err instanceof ProjectPlanCompileError
      && /canonical workflow contract/.test(err.message),
  );
});

// ── budgets ──────────────────────────────────────────────────────────────────

test('per-node budgets are emitted exactly, and 64 bounds a NODE not a project', () => {
  const { compiled } = graphOf(FANOUT_PLAN);
  for (const step of compiled.definition.steps) {
    assert.equal(step.maxTurns, PROJECT_NODE_DEFAULT_MAX_TURNS);
  }

  // Several nodes may each sit at the ceiling in one DAG: the ceiling is per
  // node, never a whole-project horizon.
  const { compiled: heavy } = graphOf({
    objective: 'o',
    nodes: [
      read('a', { maxTurns: PROJECT_NODE_TURN_CEILING }),
      read('b', { maxTurns: PROJECT_NODE_TURN_CEILING }),
      read('c', { maxTurns: PROJECT_NODE_TURN_CEILING }),
      read('join', { dependsOn: ['a', 'b', 'c'], maxTurns: PROJECT_NODE_TURN_CEILING }),
    ],
  });
  assert.deepEqual(heavy.definition.steps.map((s) => s.maxTurns), [64, 64, 64, 64]);
  const total = heavy.definition.steps.reduce((sum, s) => sum + (s.maxTurns ?? 0), 0);
  assert.ok(total > PROJECT_NODE_TURN_CEILING, 'a project may budget far more than one node may');

  const { compiled: explicit } = graphOf({ objective: 'o', nodes: [read('a', { maxTurns: 12, retries: 2 })] });
  assert.equal(explicit.definition.steps[0].maxTurns, 12);
  assert.equal(explicit.definition.steps[0].retryBudget, 2);
});

// ── dynamic fan-out ──────────────────────────────────────────────────────────

test('a dynamic per-item node compiles through the existing forEach primitive', () => {
  const { compiled } = graphOf({
    objective: 'Assay each collected sample.',
    nodes: [
      read('collect_samples', { evidence: { type: 'object', requiredKeys: ['samples'] } }),
      read('assay_sample', {
        dependsOn: ['collect_samples'],
        executor: { kind: 'model', instruction: 'Assay one sample and report its reading.' },
        fanOut: { fromNode: 'collect_samples', path: 'samples', newOnly: true },
      }),
      read('reduce_assays', {
        dependsOn: ['assay_sample'],
        executor: { kind: 'model', instruction: 'Reduce every per-sample reading into one table.' },
      }),
    ],
  });
  const step = compiled.definition.steps.find((s) => s.id === 'assay_sample');
  assert.equal(step?.forEach, '{{steps.collect_samples.output.samples}}');
  assert.equal(step?.forEachNewOnly, true);
  // Exactly one downstream consumer receives the aggregate.
  const consumers = compiled.definition.steps.filter((s) => (s.dependsOn ?? []).includes('assay_sample'));
  assert.deepEqual(consumers.map((s) => s.id), ['reduce_assays']);
});

// ── unsupported shapes fail closed ───────────────────────────────────────────

test('an external write cannot compile — the definition cannot carry its binding', () => {
  // Even a FULLY specified binding is refused: WorkflowStepInput has no field
  // for a prior approval bound to operation/account/target/digests, so
  // compiling one would put authority in an approvalPreview string.
  const fullyBound: ProjectPlan = {
    objective: 'Publish the reconciled record.',
    nodes: [{
      id: 'publish',
      executor: { kind: 'structured_call', tool: 'note_create', args: { title: 't' } },
      effect: 'external_write',
      approval: 'required',
      approvalPreview: 'Publish once to the named target.',
      externalWrite: {
        operation: 'PROVIDER_CREATE',
        accountRef: 'acct-1',
        target: 'target-1',
        argumentsDigest: DIGEST_A,
        planDigest: DIGEST_B,
        priorApprovalId: 'apr-1',
        readback: { operation: 'PROVIDER_GET', expect: { requiredKeys: ['id'], nonEmpty: ['id'] } },
      },
    }],
  };
  assert.throws(
    () => compileProjectPlan(fullyBound),
    (err: unknown) => err instanceof ProjectPlanCompileError,
    'external writes must fail closed until the definition can carry the binding',
  );

  // No compiled step anywhere may claim an external effect through prose.
  const { compiled } = graphOf(FANOUT_PLAN);
  for (const step of compiled.definition.steps) {
    assert.notEqual(step.sideEffect, 'send');
    assert.equal(step.requiresApproval, undefined);
    assert.equal(step.approvalPreview, undefined);
  }
});

test('unsupported and malformed shapes fail closed with every reason', () => {
  const cases: Array<[ProjectPlan, RegExp]> = [
    [{ objective: 'o', nodes: [read('a'), read('a')] }, /Duplicate node id/],
    [{ objective: 'o', nodes: [read('a', { dependsOn: ['ghost'] })] }, /no node declares/],
    [{ objective: 'o', nodes: [read('a', { dependsOn: ['b'] }), read('b', { dependsOn: ['a'] })] }, /dependency cycle/],
    [{ objective: 'o', nodes: [read('a', { maxTurns: 65 })] }, /per-node ceiling/],
    [{ objective: 'o', nodes: [read('src'), read('each', { fanOut: { fromNode: 'src' } })] },
      /not one of its declared dependencies/],
    [{ objective: 'o', nodes: [read('a', { executor: { kind: 'model', instruction: 'x', allowedTools: ['*'] } })] },
      /wildcard tool authority/],
    // A mutating structured call is refused at the same boundary as external_write.
    [{ objective: 'o', nodes: [{ id: 'c', executor: { kind: 'structured_call', tool: 'note_create' }, effect: 'read' }] },
      /is not a canonical read/],
    // Mutating per-item fan-out.
    [{
      objective: 'o',
      nodes: [
        read('collect'),
        read('each', { dependsOn: ['collect'], effect: 'local_write', fanOut: { fromNode: 'collect' } }),
        read('reduce', { dependsOn: ['each'] }),
      ],
    }, /only read-class per-item work is supported/],
    // Two ambiguous sinks.
    [{ objective: 'o', nodes: [read('a'), read('b')] }, /converge on exactly one terminal node/],
    // Unjoined static fan-out.
    [{
      objective: 'o',
      nodes: [read('src'), read('x', { dependsOn: ['src'] }), read('y', { dependsOn: ['src'] }), read('t', { dependsOn: ['x'] })],
    }, /has no fan-in/],
    // Evidence that only looks like evidence.
    [{ objective: 'o', nodes: [read('a', { evidence: { requiredKeys: [null] } as never })] },
      /non-string or empty entry/],
  ];

  for (const [badPlan, expected] of cases) {
    assert.throws(
      () => compileProjectPlan(badPlan),
      (err: unknown) => err instanceof ProjectPlanCompileError && expected.test(err.message),
      `expected ${expected} for ${JSON.stringify(badPlan.nodes.map((n) => n.id))}`,
    );
  }
});

// ── purity ───────────────────────────────────────────────────────────────────

test('the compiler makes defensive copies of plan-owned data', () => {
  const tools = ['list_files'];
  const args = { limit: 1 };
  const deps = ['a'];
  const compiled = compileProjectPlan({
    objective: 'o',
    nodes: [
      read('a', { executor: { kind: 'model', instruction: 'Read the listed files.', allowedTools: tools } }),
      { id: 'b', dependsOn: deps, executor: { kind: 'structured_call', tool: 'list_files', args }, effect: 'read' },
    ],
  });
  tools.push('smuggled');
  args.limit = 999;
  deps.push('ghost');

  const byId = new Map(compiled.definition.steps.map((step) => [step.id, step]));
  assert.deepEqual(byId.get('a')?.allowedTools, ['list_files']);
  assert.deepEqual(byId.get('b')?.call?.args, { limit: 1 });
  assert.deepEqual(byId.get('b')?.dependsOn, ['a']);
});

test('a completely unfamiliar objective compiles with no domain-specific branch', () => {
  const invented: ProjectPlan = {
    objective: 'Reconcile the quorn ledger against every zolat manifest before the tide turns.',
    nodes: [
      read('read_quorn_ledger'),
      read('read_zolat_manifests'),
      read('reconcile', {
        dependsOn: ['read_quorn_ledger', 'read_zolat_manifests'],
        executor: { kind: 'model', instruction: 'Reconcile the two sources and record the differences.' },
        effect: 'local_write',
        evidence: { verify: { pathExists: ['reconciliation_path'] } },
      }),
    ],
  };
  const { compiled, graph } = graphOf(invented);
  assert.equal(validateWorkflowGraph(graph).ok, true);
  assert.deepEqual(getReadyWorkflowGraphNodes(graph, []).map((n) => n.id).sort(),
    ['read_quorn_ledger', 'read_zolat_manifests']);
  assert.equal(compiled.definition.description, invented.objective);
  assert.deepEqual(compiled.definition.trigger, { manual: true });
  // local_write is a write with no approval theatre attached.
  const reconcile = compiled.definition.steps.find((s) => s.id === 'reconcile');
  assert.equal(reconcile?.sideEffect, 'write');
  assert.equal(reconcile?.requiresApproval, undefined);
});

test('compiling never reads or mutates a stored workflow', async () => {
  const source = await import('node:fs').then(({ readFileSync }) =>
    readFileSync(new URL('./project-compiler.ts', import.meta.url), 'utf-8'));
  assert.ok(!/readWorkflow|listWorkflows|writeWorkflow|WORKFLOWS_DIR/.test(source),
    'the compiler must not reach the workflow store');
  assert.ok(!/CLEMENTINE_HOME/.test(source), 'the compiler must not resolve a home directory');
});
