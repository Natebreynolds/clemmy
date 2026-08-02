/**
 * Run: npx tsx --test src/execution/project-compiler.test.ts
 *
 * The compiler must produce ordinary workflow steps that the EXISTING runtime
 * graph already knows how to schedule. So the parallelism and DAG assertions
 * below deliberately go through `compileWorkflowStepsToGraph`,
 * `validateWorkflowGraph`, and `getReadyWorkflowGraphNodes` rather than
 * re-deriving readiness here — if this compiler's output only looked right to a
 * bespoke checker, that would prove nothing about how it actually runs.
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
import { PROJECT_NODE_DEFAULT_MAX_TURNS, type ProjectNode, type ProjectPlan } from './project-plan-ir.js';
import {
  compileWorkflowStepsToGraph,
  getReadyWorkflowGraphNodes,
  validateWorkflowGraph,
} from './workflow-graph.js';

function read(id: string, extra: Partial<ProjectNode> = {}): ProjectNode {
  return { id, executor: { kind: 'model', instruction: `gather ${id}` }, effect: 'read', ...extra };
}

/**
 * A fan-out → reduce → verify shape, stated in an invented domain so no
 * assertion can accidentally lean on a familiar one.
 */
const FANOUT_PLAN: ProjectPlan = {
  planId: 'thrumcap-survey',
  objective: 'Catalogue thrumcap density across the northern glarnix beds.',
  nodes: [
    read('probe_north'),
    read('probe_east'),
    read('probe_west'),
    {
      id: 'reduce_density',
      dependsOn: ['probe_north', 'probe_east', 'probe_west'],
      executor: { kind: 'model', instruction: 'Join the three probes into one density model.' },
      effect: 'read',
      evidence: { type: 'object', requiredKeys: ['density_model'] },
    },
    {
      id: 'verify_density',
      dependsOn: ['reduce_density'],
      executor: { kind: 'model', instruction: 'Confirm the joined model against the raw probes.' },
      effect: 'read',
      evidence: { type: 'object', requiredKeys: ['verified'], nonEmpty: ['verified'] },
    },
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

test('three independent nodes fan out, then one reducer and one verifier', () => {
  const { compiled, graph } = graphOf(FANOUT_PLAN);
  assert.deepEqual(compiled.stepIds, [
    'probe_east', 'probe_north', 'probe_west', 'reduce_density', 'verify_density',
  ]);

  const validation = validateWorkflowGraph(graph);
  assert.equal(validation.ok, true, validation.errors.join(' | '));

  // The three probes are ready together at the start — the JSON order they
  // happen to sit in does not sequence them.
  const initiallyReady = getReadyWorkflowGraphNodes(graph, []).map((node) => node.id).sort();
  assert.deepEqual(initiallyReady, ['probe_east', 'probe_north', 'probe_west']);

  // The reducer waits for all three, then the verifier waits for the reducer.
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
  // No probe depends on another probe, even though they are adjacent in the
  // emitted list. Emission order is presentation; dependsOn is the constraint.
  for (const id of ['probe_north', 'probe_east', 'probe_west']) {
    const step = compiled.definition.steps.find((candidate) => candidate.id === id);
    assert.equal(step?.dependsOn, undefined, `${id} must carry no dependencies`);
  }
  const probeEdges = graph.edges.filter((edge) => edge.target.startsWith('probe_'));
  assert.equal(probeEdges.length, 0, 'no edge may point at an independent probe');
});

test('a dynamic per-item node compiles through the existing forEach primitive', () => {
  const { compiled } = graphOf({
    objective: 'Assay each collected sample.',
    nodes: [
      read('collect_samples', { evidence: { type: 'object', requiredKeys: ['samples'] } }),
      {
        id: 'assay_sample',
        dependsOn: ['collect_samples'],
        executor: { kind: 'model', instruction: 'Assay one sample.' },
        effect: 'read',
        fanOut: { fromNode: 'collect_samples', path: 'samples', newOnly: true },
      },
    ],
  });
  const step = compiled.definition.steps.find((candidate) => candidate.id === 'assay_sample');
  assert.equal(step?.forEach, '{{steps.collect_samples.output.samples}}');
  assert.equal(step?.forEachNewOnly, true);

  // Without a path, the whole upstream output is the item source.
  const { compiled: bare } = graphOf({
    objective: 'Assay everything returned.',
    nodes: [
      read('collect'),
      {
        id: 'assay',
        dependsOn: ['collect'],
        executor: { kind: 'model', instruction: 'Assay one item.' },
        effect: 'read',
        fanOut: { fromNode: 'collect' },
      },
    ],
  });
  assert.equal(
    bare.definition.steps.find((s) => s.id === 'assay')?.forEach,
    '{{steps.collect.output}}',
  );
});

test('effect classes map to the right workflow effect and approval contracts', () => {
  const { compiled } = graphOf({
    objective: 'Produce and publish a survey record.',
    nodes: [
      read('gather'),
      {
        id: 'write_local',
        dependsOn: ['gather'],
        executor: { kind: 'model', instruction: 'Write the local record.' },
        effect: 'local_write',
        evidence: { verify: { pathExists: ['record_path'] } },
      },
      {
        id: 'publish_record',
        dependsOn: ['write_local'],
        executor: { kind: 'model', instruction: 'Make the record reachable.' },
        effect: 'external_write',
        evidence: { verify: { urlPresent: ['record_url'] } },
      },
    ],
  });
  const byId = new Map(compiled.definition.steps.map((step) => [step.id, step]));

  assert.equal(byId.get('gather')?.sideEffect, 'read');
  assert.equal(byId.get('gather')?.requiresApproval, undefined);

  // A local write is a write, but crosses no external boundary, so it does not
  // manufacture an approval pause.
  assert.equal(byId.get('write_local')?.sideEffect, 'write');
  assert.equal(byId.get('write_local')?.requiresApproval, undefined);

  // An external write compiles conservatively: approval-bearing, with a preview.
  const publish = byId.get('publish_record');
  assert.equal(publish?.sideEffect, 'write');
  assert.equal(publish?.requiresApproval, true);
  assert.ok((publish?.approvalPreview ?? '').length > 0);
  // Never 'send': a plan cannot know an effect is irreversible, and claiming so
  // would weaken the runtime's own send classification.
  assert.notEqual(publish?.sideEffect, 'send');
  assert.deepEqual(publish?.output?.verify?.url_present, ['record_url']);
});

test('an authored approval preview is preserved verbatim', () => {
  const { compiled } = graphOf({
    objective: 'Publish once.',
    nodes: [{
      id: 'publish',
      executor: { kind: 'model', instruction: 'publish' },
      effect: 'external_write',
      approvalPreview: 'Create one new destination and publish build 1234 to it.',
      evidence: { verify: { urlPresent: ['url'] } },
    }],
  });
  assert.equal(
    compiled.definition.steps[0].approvalPreview,
    'Create one new destination and publish build 1234 to it.',
  );
});

test('a structured call compiles to an exact call with frozen args and no wildcard surface', () => {
  const { compiled } = graphOf({
    objective: 'Fetch the exact record set.',
    nodes: [{
      id: 'fetch',
      executor: { kind: 'structured_call', tool: 'EXACT_READ_TOOL', args: { limit: 25 } },
      effect: 'read',
    }],
  });
  const step = compiled.definition.steps[0];
  assert.deepEqual(step.call, { tool: 'EXACT_READ_TOOL', args: { limit: 25 } });
  assert.equal(step.allowedTools, undefined);
  assert.ok(step.prompt.length > 0, 'a structured node still records its assignment');
});

test('every node is bounded by a small default budget', () => {
  const { compiled } = graphOf(FANOUT_PLAN);
  for (const step of compiled.definition.steps) {
    assert.equal(step.maxTurns, PROJECT_NODE_DEFAULT_MAX_TURNS);
    assert.ok((step.maxTurns ?? 0) < 64, 'no node may reach the safety ceiling');
  }
  const { compiled: explicit } = graphOf({
    objective: 'o',
    nodes: [read('a', { maxTurns: 12, retries: 2 })],
  });
  assert.equal(explicit.definition.steps[0].maxTurns, 12);
  assert.equal(explicit.definition.steps[0].retryBudget, 2);
});

test('invalid plans fail closed with every reason, emitting nothing partial', () => {
  const cases: Array<[ProjectPlan, RegExp]> = [
    [{ objective: 'o', nodes: [read('a'), read('a')] }, /Duplicate node id/],
    [{ objective: 'o', nodes: [read('a', { dependsOn: ['ghost'] })] }, /no node declares/],
    [{
      objective: 'o',
      nodes: [read('a', { dependsOn: ['b'] }), read('b', { dependsOn: ['a'] })],
    }, /dependency cycle/],
    [{ objective: 'o', nodes: [read('a', { maxTurns: 65 })] }, /safety ceiling/],
    [{
      objective: 'o',
      nodes: [read('src'), read('each', { fanOut: { fromNode: 'src' } })],
    }, /not one of its declared dependencies/],
    [{
      objective: 'o',
      nodes: [read('a', { executor: { kind: 'model', instruction: 'x', allowedTools: ['*'] } })],
    }, /wildcard tool authority/],
    [{
      objective: 'o',
      nodes: [{
        id: 'publish',
        executor: { kind: 'model', instruction: 'x' },
        effect: 'external_write',
      }],
    }, /without verification evidence/],
  ];

  for (const [badPlan, expected] of cases) {
    assert.throws(
      () => compileProjectPlan(badPlan),
      (err: unknown) => err instanceof ProjectPlanCompileError && expected.test(err.message),
      `expected ${expected} for ${JSON.stringify(badPlan.nodes.map((n) => n.id))}`,
    );
  }
});

test('compilation is deterministic across object key order', () => {
  const a: ProjectPlan = {
    planId: 'stable-plan',
    objective: 'Do the thing.',
    nodes: [
      { id: 'x', executor: { kind: 'model', instruction: 'i' }, effect: 'read' },
      { id: 'y', dependsOn: ['x'], executor: { kind: 'model', instruction: 'j' }, effect: 'read' },
    ],
  };
  const b: ProjectPlan = {
    nodes: [
      { effect: 'read', dependsOn: ['x'], id: 'y', executor: { instruction: 'j', kind: 'model' } },
      { effect: 'read', id: 'x', executor: { instruction: 'i', kind: 'model' } },
    ],
    objective: 'Do the thing.',
    planId: 'stable-plan',
  };

  const first = compileProjectPlan(a);
  const second = compileProjectPlan(b);
  assert.equal(first.planHash, second.planHash);
  assert.equal(first.workflowName, second.workflowName);
  assert.deepEqual(first.stepIds, second.stepIds);
  assert.equal(
    compiledProjectDefinitionHash(first.definition),
    compiledProjectDefinitionHash(second.definition),
  );
});

test('the workflow name is stable and derived, never random', () => {
  const named = compileProjectPlan(FANOUT_PLAN);
  assert.equal(named.workflowName, 'thrumcap-survey');
  assert.equal(compileProjectPlan(FANOUT_PLAN).workflowName, named.workflowName);

  // With no planId the name is derived from the plan hash, so it is still
  // stable for identical meaning and different for different meaning.
  const anonymous = compileProjectPlan({ objective: 'o', nodes: [read('a')] });
  assert.match(anonymous.workflowName, /^project-[0-9a-f]{12}$/);
  assert.equal(compileProjectPlan({ objective: 'o', nodes: [read('a')] }).workflowName,
    anonymous.workflowName);
  assert.notEqual(compileProjectPlan({ objective: 'different', nodes: [read('a')] }).workflowName,
    anonymous.workflowName);
});

test('the compiler makes defensive copies of plan-owned data', () => {
  const tools = ['tool_one'];
  const args = { limit: 1 };
  const deps = ['a'];
  const compiled = compileProjectPlan({
    objective: 'o',
    nodes: [
      read('a', { executor: { kind: 'model', instruction: 'i', allowedTools: tools } }),
      { id: 'b', dependsOn: deps, executor: { kind: 'structured_call', tool: 'T', args }, effect: 'read' },
    ],
  });
  tools.push('smuggled');
  args.limit = 999;
  deps.push('ghost');

  const byId = new Map(compiled.definition.steps.map((step) => [step.id, step]));
  assert.deepEqual(byId.get('a')?.allowedTools, ['tool_one']);
  assert.deepEqual(byId.get('b')?.call?.args, { limit: 1 });
  assert.deepEqual(byId.get('b')?.dependsOn, ['a']);
});

test('a completely unfamiliar objective compiles with no domain-specific branch', () => {
  const invented: ProjectPlan = {
    objective: 'Reconcile the quorn ledger against every zolat manifest before the tide turns.',
    nodes: [
      read('read_quorn_ledger'),
      read('read_zolat_manifests'),
      {
        id: 'reconcile',
        dependsOn: ['read_quorn_ledger', 'read_zolat_manifests'],
        executor: { kind: 'model', instruction: 'Reconcile the two sources.' },
        effect: 'local_write',
        evidence: { verify: { pathExists: ['reconciliation_path'] } },
      },
    ],
  };
  const { compiled, graph } = graphOf(invented);
  assert.equal(validateWorkflowGraph(graph).ok, true);
  assert.deepEqual(
    getReadyWorkflowGraphNodes(graph, []).map((n) => n.id).sort(),
    ['read_quorn_ledger', 'read_zolat_manifests'],
  );
  assert.equal(compiled.definition.description, invented.objective);
  // The compiled definition never arms its own schedule; dispatch belongs to
  // whoever owns admission.
  assert.deepEqual(compiled.definition.trigger, { manual: true });
});

test('compiling never reads or mutates a stored workflow', async () => {
  // The compiler is a pure function of its argument. If it ever reached the
  // workflow store, importing the store here and asserting its directory is
  // untouched would be the wrong shape of test — so instead assert the module
  // graph itself: project-compiler must not depend on the store's reader.
  const source = await import('node:fs').then(({ readFileSync }) =>
    readFileSync(new URL('./project-compiler.ts', import.meta.url), 'utf-8'));
  assert.ok(!/readWorkflow|listWorkflows|writeWorkflow|WORKFLOWS_DIR/.test(source),
    'the compiler must not reach the workflow store');
  assert.ok(!/CLEMENTINE_HOME/.test(source), 'the compiler must not resolve a home directory');
});
