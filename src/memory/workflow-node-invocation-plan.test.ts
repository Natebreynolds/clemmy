/** Run: npx tsx --test src/memory/workflow-node-invocation-plan.test.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-invocation-plan-'));
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  createWorkflowNodeInvocationPlan,
  parseWorkflowNodeInvocationPlan,
  workflowNodeInvocationBindingDigest,
  workflowNodeReviewedLiteralDigest,
} = await import('./workflow-node-invocation-plan.js');
const {
  compileWorkflowNodeInvocationArguments,
  verifyWorkflowNodeInvocationEvidence,
} = await import('../execution/workflow-node-invocation-admission.js');
const { validateWorkflowDefinition } = await import('../execution/workflow-validator.js');
const { compileWorkflowStepsToGraph, validateWorkflowGraph } = await import('../execution/workflow-graph.js');
const {
  loadWorkflowGraphSnapshotByRunId,
  persistWorkflowGraphSnapshot,
} = await import('../execution/workflow-graph-store.js');
const { writeWorkflow, readWorkflow } = await import('./workflow-store.js');
const { default: Database } = await import('better-sqlite3');

import type {
  WorkflowNodeArgumentBindingV1,
  WorkflowNodeInvocationEffectV1,
  WorkflowNodeInvocationPlanV1,
} from './workflow-node-invocation-plan.js';

test.after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex');
}

function reviewedLiteral(value: unknown, suffix: string): WorkflowNodeArgumentBindingV1 {
  return {
    source: {
      kind: 'reviewed_literal',
      value,
      valueDigest: workflowNodeReviewedLiteralDigest(value),
      reviewRef: `review.${suffix}`,
      reviewDigest: digest(`review:${suffix}`),
    },
    required: true,
    type: typeof value === 'string'
      ? 'string'
      : Array.isArray(value)
        ? 'array'
        : 'object',
  };
}

function plan(input: {
  arguments?: Record<string, WorkflowNodeArgumentBindingV1>;
  continuation?: WorkflowNodeInvocationPlanV1['continuation'];
  completeness?: WorkflowNodeInvocationPlanV1['completeness'];
  effect?: WorkflowNodeInvocationEffectV1;
} = {}): WorkflowNodeInvocationPlanV1 {
  return createWorkflowNodeInvocationPlan({
    requirementId: 'requirement.records',
    logicalCapabilityId: 'capability.records.read',
    binding: {
      capabilityId: 'capability.alpha',
      manifestId: 'manifest.alpha',
      manifestDigest: digest('manifest.alpha'),
      operationId: 'operation.alpha',
      operationVersion: '1',
      schemaDigest: digest('schema.alpha'),
      providerVersion: 'runtime.1',
      liveFingerprint: digest('live.alpha'),
      accountId: 'account.alpha',
      effect: input.effect ?? 'read',
      invokePortId: 'invoke.alpha',
      argumentCompiler: { id: 'compiler.alpha', version: '1' },
    },
    arguments: input.arguments ?? {
      scope: {
        source: { kind: 'workflow_input', key: 'scope' },
        required: true,
        type: 'string',
      },
    },
    evidence: {
      requiredPaths: ['records'],
      nonEmptyPaths: ['records'],
      minItems: { records: 1 },
    },
    completeness: input.completeness ?? {
      kind: 'terminal_result',
      evidencePaths: ['records'],
    },
    continuation: input.continuation ?? { kind: 'none' },
  });
}

function rehash(value: WorkflowNodeInvocationPlanV1): WorkflowNodeInvocationPlanV1 {
  value.bindingDigest = workflowNodeInvocationBindingDigest(value);
  return value;
}

test('closed plan parsing is canonical, replay-stable, and stores sources rather than rendered arguments', () => {
  const first = plan();
  const replay = plan();
  assert.equal(first.bindingDigest, replay.bindingDigest);
  assert.deepEqual(parseWorkflowNodeInvocationPlan(structuredClone(first)), { ok: true, plan: first });
  assert.deepEqual(first.arguments.scope.source, { kind: 'workflow_input', key: 'scope' });
  assert.equal(JSON.stringify(first).includes('runtime-value'), false);

  const open = rehash({ ...structuredClone(first), unexpected: true } as WorkflowNodeInvocationPlanV1);
  const parsed = parseWorkflowNodeInvocationPlan(open);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.errors.join(' '), /closed object/);
});

test('provider-neutral write effects are content-addressed without widening read plan bytes', () => {
  const read = plan();
  const replay = plan();
  assert.equal(
    read.bindingDigest,
    'ee4e79a668259c6cd38c589277411bbaed387280e8a56f7bccfcd77f62a02c19',
    'the established read-v1 canonical bytes must not change',
  );
  assert.equal(read.bindingDigest, replay.bindingDigest);
  assert.deepEqual(JSON.parse(JSON.stringify(read)), JSON.parse(JSON.stringify(replay)));

  for (const effect of ['host_only', 'local_write', 'external_write', 'admin'] as const) {
    const exact = plan({ effect });
    const parsed = parseWorkflowNodeInvocationPlan(exact);
    assert.equal(parsed.ok, true, effect);
    if (parsed.ok) {
      assert.equal(parsed.plan.binding.effect, effect);
      assert.equal(parsed.plan.bindingDigest, exact.bindingDigest);
    }
  }

  for (const effect of ['none', 'unknown']) {
    const unsafe = structuredClone(read) as unknown as Record<string, unknown>;
    (unsafe.binding as Record<string, unknown>).effect = effect;
    unsafe.bindingDigest = workflowNodeInvocationBindingDigest(
      unsafe as unknown as WorkflowNodeInvocationPlanV1,
    );
    const parsed = parseWorkflowNodeInvocationPlan(unsafe);
    assert.equal(parsed.ok, false, effect);
    if (!parsed.ok) assert.match(parsed.errors.join(' '), /supported provider-neutral effect/);
  }
});

test('non-read plans cannot smuggle cursor retry or pagination authority', () => {
  const cursor = plan({
    effect: 'read',
    arguments: {
      cursor: {
        source: { kind: 'continuation_cursor' },
        required: false,
        type: 'string',
      },
    },
    completeness: {
      kind: 'finite_exhaustive',
      exhaustedPath: 'page.exhausted',
      evidencePaths: ['records'],
    },
    continuation: {
      kind: 'cursor',
      cursorArgument: 'cursor',
      nextCursorPath: 'page.next',
      exhaustedPath: 'page.exhausted',
      maxPages: 2,
    },
  });
  const raw = structuredClone(cursor);
  raw.binding.effect = 'external_write';
  raw.bindingDigest = workflowNodeInvocationBindingDigest(raw);
  const parsed = parseWorkflowNodeInvocationPlan(raw);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.errors.join(' '), /Only read invocation plans may declare cursor/);
});

test('raw templates and nested template syntax cannot smuggle a different argument shape', () => {
  const raw = structuredClone(plan()) as unknown as Record<string, unknown>;
  const rawArguments = raw.arguments as Record<string, Record<string, unknown>>;
  rawArguments.scope.source = '{{workflow.input.scope}}';
  raw.bindingDigest = workflowNodeInvocationBindingDigest(raw as unknown as WorkflowNodeInvocationPlanV1);
  const parsedRaw = parseWorkflowNodeInvocationPlan(raw);
  assert.equal(parsedRaw.ok, false);
  if (!parsedRaw.ok) assert.match(parsedRaw.errors.join(' '), /typed argument source/);

  for (const value of [
    { nested: [{ value: '${workflow.input.scope}' }] },
    { nested: { '{{workflow.input.scope}}': 'value' } },
    ['<% runtime.value %>'],
  ]) {
    assert.throws(
      () => plan({ arguments: { literal: reviewedLiteral(value, digest(JSON.stringify(value))) } }),
      /reviewed_literal source lacks exact reviewed bytes/,
    );
  }
});

test('reviewed literals are exact plain JSON and reject prototype-bearing or hazardous shapes', () => {
  class NonJsonValue {
    readonly value = 'hidden';
  }
  let getterReads = 0;
  const accessorArray: unknown[] = ['safe'];
  Object.defineProperty(accessorArray, '0', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'unsafe';
    },
  });
  const hiddenObject = { visible: true } as Record<string, unknown>;
  Object.defineProperty(hiddenObject, 'hidden', { value: 'unsafe', enumerable: false });
  class ArraySubclass extends Array<unknown> {}
  for (const value of [
    new Date(0),
    new Map([['key', 'value']]),
    new NonJsonValue(),
    accessorArray,
    hiddenObject,
    new ArraySubclass('unsafe'),
    [undefined],
    (() => {
      const sparse: unknown[] = [];
      sparse.length = 1;
      return sparse;
    })(),
    JSON.parse('{"__proto__":"unsafe"}') as unknown,
    { constructor: 'unsafe' },
    { prototype: 'unsafe' },
  ]) {
    assert.throws(
      () => workflowNodeReviewedLiteralDigest(value),
      /JSON|unsafe|serializable|sparse|undefined|prototype/i,
    );
  }
  assert.equal(getterReads, 0);

  const safeNullPrototype = Object.create(null) as Record<string, unknown>;
  safeNullPrototype.alpha = { nested: true };
  const exact = plan({
    arguments: { literal: reviewedLiteral(safeNullPrototype, 'null-prototype') },
  });
  assert.equal(parseWorkflowNodeInvocationPlan(exact).ok, true);
});

test('prototype-control names are rejected in argument keys and every traversed path segment', () => {
  for (const argumentName of ['__proto__', 'prototype', 'constructor']) {
    assert.throws(
      () => plan({
        arguments: {
          [argumentName]: {
            source: { kind: 'workflow_input', key: 'scope' },
            required: true,
            type: 'string',
          },
        },
      }),
      /arguments must be a bounded object|argument .* malformed|unsafe key/i,
    );
  }
  for (const unsafePath of [
    'constructor.value',
    'value.prototype.name',
    'value.__proto__.name',
  ]) {
    assert.throws(
      () => plan({
        arguments: {
          value: {
            source: { kind: 'upstream_output', stepId: 'node.prior', path: unsafePath },
            required: true,
            type: 'string',
          },
        },
      }),
      /upstream_output source is malformed/,
    );
  }
});

test('plan evidence has only exact result-shape checks; unsupported kind claims are rejected', () => {
  const raw = structuredClone(plan()) as unknown as Record<string, unknown>;
  (raw.evidence as Record<string, unknown>).kinds = ['unverified-kind'];
  raw.bindingDigest = workflowNodeInvocationBindingDigest(raw as unknown as WorkflowNodeInvocationPlanV1);
  const parsed = parseWorkflowNodeInvocationPlan(raw);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.errors.join(' '), /evidence contract is malformed/);
});

test('closed plan arrays reject accessors without evaluating them', () => {
  const raw = structuredClone(plan()) as unknown as Record<string, unknown>;
  const requiredPaths: string[] = ['records'];
  let getterReads = 0;
  Object.defineProperty(requiredPaths, '0', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'unsafe';
    },
  });
  (raw.evidence as Record<string, unknown>).requiredPaths = requiredPaths;
  const parsed = parseWorkflowNodeInvocationPlan(raw);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.errors.join(' '), /accessor|canonical|digest/i);
  assert.equal(getterReads, 0);
});

test('reviewed literals share one total canonical-byte budget across the plan', () => {
  assert.throws(
    () => plan({
      arguments: {
        first: reviewedLiteral('a'.repeat(9_000), 'first'),
        second: reviewedLiteral('b'.repeat(9_000), 'second'),
      },
    }),
    /reviewed literals exceed the 16384-byte canonical budget/,
  );
});

test('cursor continuation has exactly one optional host-owned overlay binding', () => {
  const completeness: WorkflowNodeInvocationPlanV1['completeness'] = {
    kind: 'finite_exhaustive',
    exhaustedPath: 'page.exhausted',
    evidencePaths: ['records'],
  };
  const continuation: WorkflowNodeInvocationPlanV1['continuation'] = {
    kind: 'cursor',
    cursorArgument: 'cursor',
    nextCursorPath: 'page.next',
    exhaustedPath: 'page.exhausted',
    maxPages: 20,
  };
  assert.throws(
    () => plan({
      arguments: {
        cursor: {
          source: { kind: 'workflow_input', key: 'cursor' },
          required: false,
          type: 'string',
        },
      },
      completeness,
      continuation,
    }),
    /one-to-one to an optional host-owned continuation_cursor source/,
  );
  assert.throws(
    () => plan({
      arguments: {
        cursor: {
          source: { kind: 'continuation_cursor' },
          required: true,
          type: 'string',
        },
      },
      completeness,
      continuation,
    }),
    /one-to-one to an optional host-owned continuation_cursor source/,
  );

  const exact = plan({
    arguments: {
      cursor: {
        source: { kind: 'continuation_cursor' },
        required: false,
        type: 'string',
      },
    },
    completeness,
    continuation,
  });
  assert.equal(parseWorkflowNodeInvocationPlan(exact).ok, true);
  const firstPage = compileWorkflowNodeInvocationArguments(exact, {
    workflowInputs: { cursor: 'caller-controlled' },
    stepOutputs: {},
  });
  assert.deepEqual(firstPage.ok && firstPage.args, {});
  const nextPage = compileWorkflowNodeInvocationArguments(exact, {
    workflowInputs: { cursor: 'caller-controlled' },
    stepOutputs: {},
    continuationCursor: 'host-owned',
  });
  assert.deepEqual(nextPage.ok && nextPage.args, { cursor: 'host-owned' });
});

test('finite completeness refuses a one-page result until exact exhaustion evidence is true', () => {
  const exact = plan({
    arguments: {
      cursor: {
        source: { kind: 'continuation_cursor' },
        required: false,
        type: 'string',
      },
    },
    completeness: {
      kind: 'finite_exhaustive',
      exhaustedPath: 'page.exhausted',
      evidencePaths: ['records'],
    },
    continuation: {
      kind: 'cursor',
      cursorArgument: 'cursor',
      nextCursorPath: 'page.next',
      exhaustedPath: 'page.exhausted',
      maxPages: 20,
    },
  });
  const partial = verifyWorkflowNodeInvocationEvidence({
    records: [{ id: 'record.1' }],
    page: { exhausted: false, next: 'cursor.2' },
  }, exact);
  assert.equal(partial.complete, false);
  assert.equal(partial.continuationRequired, true);
  assert.ok(partial.reasons.includes('exhaustion_not_proven:page.exhausted'));

  const terminal = verifyWorkflowNodeInvocationEvidence({
    records: [{ id: 'record.2' }],
    page: { exhausted: true },
  }, exact);
  assert.deepEqual(terminal, { complete: true, reasons: [], continuationRequired: false });
});

test('workflow validation proves every plan source reference against authored structure', () => {
  const validate = (
    invocationPlan: WorkflowNodeInvocationPlanV1,
    step: Record<string, unknown> = {},
    inputs: Record<string, { type?: string }> = { scope: { type: 'string' } },
  ) => validateWorkflowDefinition({
    name: 'Invocation boundary',
    description: 'A disabled exact invocation boundary.',
    enabled: false,
    trigger: { manual: true },
    inputs,
    steps: [
      { id: 'seed', prompt: 'Return a bounded record collection.', sideEffect: 'read' },
      {
        id: 'bound',
        prompt: '',
        sideEffect: 'read',
        invocationPlan,
        ...step,
      },
    ],
  });

  const missingInput = validate(plan(), {}, {});
  assert.equal(missingInput.ok, false);
  assert.ok(missingInput.errors.some((error) => error.includes('undeclared workflow input "scope"')));

  const upstream = plan({
    arguments: {
      records: {
        source: { kind: 'upstream_output', stepId: 'seed', path: 'records' },
        required: true,
        type: 'array',
      },
    },
  });
  const missingDependency = validate(upstream);
  assert.equal(missingDependency.ok, false);
  assert.ok(missingDependency.errors.some((error) => error.includes('without naming it in dependsOn')));

  const partition = plan({
    arguments: {
      record: {
        source: { kind: 'partition_item' },
        required: true,
        type: 'object',
      },
    },
  });
  const missingPartition = validate(partition);
  assert.equal(missingPartition.ok, false);
  assert.ok(missingPartition.errors.some((error) => error.includes('without a forEach partition')));

  const legal = validate(plan({
    arguments: {
      scope: {
        source: { kind: 'workflow_input', key: 'scope' },
        required: true,
        type: 'string',
      },
      records: {
        source: { kind: 'upstream_output', stepId: 'seed', path: 'records' },
        required: true,
        type: 'array',
      },
      record: {
        source: { kind: 'partition_item' },
        required: true,
        type: 'object',
      },
    },
  }), { dependsOn: ['seed'], forEach: 'seed' });
  assert.equal(legal.ok, true, legal.errors.join(' | '));
});

test('enabled non-interval, name-authorized, and unsafe-effect plan nodes fail closed', () => {
  const enabled = validateWorkflowDefinition({
    name: 'Enabled boundary',
    description: 'An exact invocation boundary.',
    enabled: true,
    inputs: { scope: { type: 'string' } },
    steps: [{ id: 'bound', prompt: '', sideEffect: 'read', invocationPlan: plan() }],
  });
  assert.ok(enabled.errors.some((error) => error.includes('can only be enabled as an interval definition')));

  const widened = validateWorkflowDefinition({
    name: 'Widened boundary',
    description: 'A disabled exact invocation boundary.',
    enabled: false,
    inputs: { scope: { type: 'string' } },
    steps: [{
      id: 'bound',
      prompt: '',
      sideEffect: 'write',
      invocationPlan: plan(),
      allowedTools: ['display-name'],
    }],
  });
  assert.ok(widened.errors.some((error) => error.includes('must declare sideEffect: read')));
  assert.ok(widened.errors.some((error) => error.includes('name-based allowedTools')));

  const compute = validateWorkflowDefinition({
    name: 'Compute boundary',
    description: 'A disabled exact compute boundary.',
    enabled: false,
    steps: [{ id: 'bound', prompt: '', sideEffect: 'read', invocationPlan: plan({ effect: 'compute' }) }],
  });
  assert.ok(compute.errors.some((error) => error.includes('compute purity is not represented')));

  const genericApproval = validateWorkflowDefinition({
    name: 'Generic approval boundary',
    description: 'A disabled exact invocation boundary.',
    enabled: false,
    inputs: { scope: { type: 'string' } },
    steps: [{
      id: 'bound',
      prompt: '',
      sideEffect: 'read',
      invocationPlan: plan(),
      requiresApproval: true,
    }],
  });
  assert.ok(genericApproval.errors.some((error) => error.includes('consent must bind the exact compiled plan lineage')));
});

test('a one-shot run cannot fall through from an exact plan into the prompt executor', async () => {
  const { executeStep, WorkflowHarnessBlockedSignal } = await import('../execution/workflow-runner.js');
  await assert.rejects(
    executeStep(
      { id: 'bound', prompt: '', sideEffect: 'read', invocationPlan: plan() },
      { runId: 'run.one-shot' } as never,
    ),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowHarnessBlockedSignal);
      assert.match(error.reason, /^workflow_activation_lineage_unrepresented:/);
      return true;
    },
  );
});

test('invocation plan survives workflow YAML and graph snapshot restart exactly', () => {
  const exact = plan();
  const entry = writeWorkflow('invocation-plan-round-trip', {
    name: 'Invocation plan round trip',
    description: 'A disabled exact invocation boundary.',
    enabled: false,
    trigger: { manual: true },
    inputs: { scope: { type: 'string', description: 'Bounded scope.' } },
    steps: [{ id: 'bound', prompt: '', sideEffect: 'read', invocationPlan: exact }],
  });
  assert.deepEqual(entry.data.steps[0].invocationPlan, exact);
  assert.deepEqual(readWorkflow('invocation-plan-round-trip')?.data.steps[0].invocationPlan, exact);

  const graph = compileWorkflowStepsToGraph(entry.data.steps, {
    id: 'workflow.snapshot',
    name: 'Invocation plan round trip',
    version: 1,
  });
  assert.equal(validateWorkflowGraph(graph).ok, true);
  assert.deepEqual(graph.nodes[0].invocationPlan, exact);

  const dbPath = path.join(TEST_HOME, 'workflow-plan-snapshot.db');
  const first = new Database(dbPath);
  persistWorkflowGraphSnapshot({
    db: first,
    workflowName: 'invocation-plan-round-trip',
    runId: 'run.snapshot.1',
    graph,
  });
  first.close();

  const restarted = new Database(dbPath);
  try {
    const loaded = loadWorkflowGraphSnapshotByRunId('run.snapshot.1', restarted);
    assert.equal(loaded?.validationOk, true);
    assert.deepEqual(loaded?.graph.nodes[0].invocationPlan, exact);
    assert.equal(parseWorkflowNodeInvocationPlan(loaded?.graph.nodes[0].invocationPlan).ok, true);
  } finally {
    restarted.close();
  }
});
