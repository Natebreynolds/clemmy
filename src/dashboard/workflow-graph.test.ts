import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflowGraph } from './workflow-graph.js';
import { buildWorkflowExecutionPlan } from './workflow-execution-plan.js';
import type { WorkflowStepInput } from '../memory/workflow-store.js';

test('maps steps to nodes and dependsOn to edges', () => {
  const g = buildWorkflowGraph([
    { id: 'a', prompt: 'Gather the inputs.' },
    { id: 'b', prompt: 'Analyze them.', dependsOn: ['a'] },
    { id: 'c', prompt: 'Write the report.', dependsOn: ['a', 'b'] },
  ]);
  assert.equal(g.nodes.length, 3);
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['a', 'b', 'c']);
  assert.equal(g.edges.length, 3);
  assert.ok(g.edges.some((e) => e.source === 'a' && e.target === 'b'));
  assert.ok(g.edges.some((e) => e.source === 'b' && e.target === 'c'));
});

test('node label is a short, human first-sentence', () => {
  const g = buildWorkflowGraph([{ id: 's', prompt: 'Pull the SEO data. Then do more stuff that is long.' }]);
  assert.equal(g.nodes[0].label, 'Pull the SEO data.');
});

test('flags forEach / approval / skill / deterministic', () => {
  const g = buildWorkflowGraph([
    { id: 'x', prompt: 'p', forEach: 'items', requiresApproval: true, usesSkill: 'proposal-builder', deterministic: { runner: 'export.py' } },
  ]);
  const f = g.nodes[0].flags;
  assert.equal(f.forEach, true);
  assert.equal(f.approval, true);
  assert.equal(f.skill, 'proposal-builder');
  assert.equal(f.deterministic, true);
});

test('node metadata surfaces tools, executor, side effects, contracts, and approval proof', () => {
  const g = buildWorkflowGraph([
    {
      id: 'send',
      prompt: 'Send the approved account update.',
      allowedTools: ['composio_execute_tool'],
      call: { tool: 'GMAIL_SEND_EMAIL', args: { to: '{{input.email}}' } },
      sideEffect: 'send',
      requiresApproval: true,
      approvalPreview: 'Send one account email',
      inputs: { email: { from: 'input.email', required: true } },
      output: { type: 'object', required_keys: ['messageId'] },
      intent: 'outreach',
      model: 'worker-fast',
    },
  ]);
  const meta = g.nodes[0].meta;
  assert.equal(meta.executor, 'call');
  assert.equal(meta.sideEffect, 'send');
  assert.deepEqual(meta.tools, ['composio_execute_tool', 'GMAIL_SEND_EMAIL']);
  assert.deepEqual(meta.inputKeys, ['email']);
  assert.equal(meta.outputType, 'object');
  assert.equal(meta.approvalPreview, 'Send one account email');
  assert.equal(meta.callTool, 'GMAIL_SEND_EMAIL');
  assert.equal(meta.intent, 'outreach');
  assert.equal(meta.model, 'worker-fast');
});

test('projects readiness items onto graph nodes', () => {
  const g = buildWorkflowGraph([
    { id: 'fetch', prompt: 'Read notes.', allowedTools: ['read_file'] },
    { id: 'merge', prompt: 'Merge evidence.', deterministic: { runner: 'merge.py' }, dependsOn: ['fetch'] },
    { id: 'send', prompt: 'Send report.', allowedTools: ['GMAIL_SEND_EMAIL'], dependsOn: ['merge'] },
  ], {
    readinessItems: [
      { kind: 'local', name: 'read_file', status: 'ready', reason: 'available', stepIds: ['fetch'] },
      { kind: 'script', name: 'merge.py', status: 'missing', reason: 'missing from scripts/', stepIds: ['merge'] },
      { kind: 'composio', name: 'GMAIL_SEND_EMAIL', status: 'unknown', reason: 'connection unconfirmed', stepIds: ['send'] },
    ],
  });

  const byId = new Map(g.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get('fetch')?.readiness.status, 'ready');
  assert.equal(byId.get('fetch')?.readiness.readyCount, 1);
  assert.equal(byId.get('fetch')?.verdict.status, 'trusted');
  assert.equal(byId.get('merge')?.readiness.status, 'missing');
  assert.equal(byId.get('merge')?.readiness.missingCount, 1);
  assert.equal(byId.get('merge')?.verdict.status, 'blocked');
  assert.deepEqual(byId.get('merge')?.verdict.reasons, ['1 missing requirement']);
  assert.equal(byId.get('merge')?.verdict.primaryAction, 'Add workflow script merge.py');
  assert.equal(byId.get('send')?.readiness.status, 'unknown');
  assert.equal(byId.get('send')?.readiness.unknownCount, 1);
  assert.equal(byId.get('send')?.verdict.status, 'attention');
  assert.deepEqual(byId.get('send')?.verdict.reasons, ['1 unconfirmed requirement']);
  assert.equal(byId.get('send')?.verdict.primaryAction, 'Confirm composio GMAIL_SEND_EMAIL');
});

test('projects execution plan batches, fanout, gates, and model routes onto graph nodes', () => {
  const steps: WorkflowStepInput[] = [
    { id: 'fetch', prompt: 'Fetch accounts.', call: { tool: 'SALESFORCE_GET_RECORDS', args: {} }, sideEffect: 'read' },
    { id: 'notes', prompt: 'Read local notes.', allowedTools: ['read_file'], sideEffect: 'read' },
    {
      id: 'process_each',
      prompt: 'Process each account.',
      dependsOn: ['fetch'],
      forEach: 'fetch',
      forEachNewOnly: true,
      intent: 'research',
      output: { type: 'object' },
    },
    {
      id: 'send',
      prompt: 'Send the report.',
      dependsOn: ['process_each', 'notes'],
      model: 'claude-opus-4-8',
      sideEffect: 'send',
      requiresApproval: true,
    },
  ];
  const executionPlan = buildWorkflowExecutionPlan(steps, { stepConcurrency: 2, forEachBatchSize: 25 });
  const g = buildWorkflowGraph(steps, { executionPlan });
  const byId = new Map(g.nodes.map((node) => [node.id, node]));

  assert.equal(byId.get('fetch')?.plan.levelIndex, 0);
  assert.equal(byId.get('fetch')?.plan.parallelWidth, 2);
  assert.equal(byId.get('fetch')?.plan.critical, true);
  assert.equal(byId.get('notes')?.plan.laneIndex, 1);
  assert.equal(byId.get('notes')?.plan.critical, false);
  assert.equal(byId.get('process_each')?.plan.fanout?.concurrency, 2);
  assert.equal(byId.get('process_each')?.plan.fanout?.batchSize, 25);
  assert.equal(byId.get('process_each')?.plan.fanout?.safeToResume, true);
  assert.equal(byId.get('process_each')?.plan.modelRoute?.binding, 'intent');
  assert.ok(byId.get('process_each')?.plan.gates.some((gate) => gate.kind === 'output_contract'));
  assert.equal(byId.get('send')?.plan.modelRoute?.binding, 'explicit_model');
  assert.equal(byId.get('send')?.plan.modelRoute?.portable, false);
  assert.ok(byId.get('send')?.plan.gates.some((gate) => gate.kind === 'approval'));
  assert.ok(byId.get('send')?.plan.gates.some((gate) => gate.kind === 'grounding_judge'));
  assert.equal(byId.get('send')?.verdict.status, 'attention');
  assert.ok(byId.get('send')?.verdict.reasons.includes('pinned model route'));
});

test('projects visual contract remediations onto graph nodes', () => {
  const steps: WorkflowStepInput[] = [
    { id: 'draft', prompt: 'Draft the report.', model: 'claude-opus-4-8' },
    { id: 'render', prompt: 'Render the report.', deterministic: { runner: 'missing.py' }, dependsOn: ['draft'] },
  ];
  const executionPlan = buildWorkflowExecutionPlan(steps, {
    readiness: {
      availableTools: [],
      workflowScripts: [],
    },
  });
  const g = buildWorkflowGraph(steps, {
    readinessItems: executionPlan.toolReadiness.items,
    executionPlan,
  });
  const byId = new Map(g.nodes.map((node) => [node.id, node]));

  assert.equal(byId.get('draft')?.contract.status, 'warn');
  assert.equal(byId.get('draft')?.contract.warningCount, 2);
  assert.ok(byId.get('draft')?.contract.fixes.some((fix) => fix.kind === 'make_models_portable'));
  assert.ok(byId.get('draft')?.contract.fixes.some((fix) => fix.kind === 'add_judge_gate'));
  assert.equal(byId.get('draft')?.verdict.status, 'attention');
  assert.ok(byId.get('draft')?.verdict.reasons.includes('2 contract warnings'));
  assert.equal(byId.get('render')?.contract.status, 'block');
  assert.equal(byId.get('render')?.contract.blockCount, 1);
  assert.ok(byId.get('render')?.contract.fixes.some((fix) =>
    fix.kind === 'add_workflow_script'
    && fix.actions?.some((action) => action.kind === 'add_workflow_script')));
  assert.equal(byId.get('render')?.verdict.status, 'blocked');
  assert.ok(byId.get('render')?.verdict.reasons.includes('1 missing requirement'));
  assert.ok(byId.get('render')?.verdict.reasons.includes('1 contract block'));
  assert.equal(byId.get('render')?.verdict.primaryAction, 'Add workflow script');
});

test('node verdict flags plan-only attention for capped or unsafe parallel execution', () => {
  const cappedSteps: WorkflowStepInput[] = [
    { id: 'left', prompt: 'Run left branch.' },
    { id: 'right', prompt: 'Run right branch.' },
    { id: 'join', prompt: 'Join branches.', dependsOn: ['left', 'right'] },
  ];
  const cappedPlan = buildWorkflowExecutionPlan(cappedSteps, { stepConcurrency: 1 });
  const capped = buildWorkflowGraph(cappedSteps, { executionPlan: cappedPlan });
  const cappedById = new Map(capped.nodes.map((node) => [node.id, node]));

  assert.equal(cappedById.get('left')?.verdict.status, 'attention');
  assert.ok(cappedById.get('left')?.verdict.reasons.includes('runner concurrency cap'));
  assert.equal(cappedById.get('left')?.verdict.primaryAction, 'Tune runner concurrency');

  const fanoutSteps: WorkflowStepInput[] = [
    { id: 'source', prompt: 'Collect records.', output: { type: 'array' } },
    { id: 'send_each', prompt: 'Send a message for each record.', dependsOn: ['source'], forEach: 'source', sideEffect: 'send' },
  ];
  const fanoutPlan = buildWorkflowExecutionPlan(fanoutSteps, { stepConcurrency: 4 });
  const fanout = buildWorkflowGraph(fanoutSteps, { executionPlan: fanoutPlan });
  const sendEach = fanout.nodes.find((node) => node.id === 'send_each');

  assert.equal(sendEach?.verdict.status, 'attention');
  assert.ok(sendEach?.verdict.reasons.includes('fan-out resume not proven safe'));
  assert.equal(sendEach?.verdict.primaryAction, 'Mark fan-out resumable');
});

test('drops dangling dependsOn (no half-edges)', () => {
  const g = buildWorkflowGraph([
    { id: 'a', prompt: 'p' },
    { id: 'b', prompt: 'p', dependsOn: ['a', 'ghost'] },
  ]);
  assert.equal(g.edges.length, 1);
  assert.equal(g.nodes.find((n) => n.id === 'b')?.dependsOn.length, 1);
});

test('de-dupes repeated dependsOn entries', () => {
  const g = buildWorkflowGraph([
    { id: 'a', prompt: 'p' },
    { id: 'b', prompt: 'p', dependsOn: ['a', 'a'] },
  ]);
  assert.equal(g.edges.length, 1);
});

test('handles empty / missing steps', () => {
  assert.deepEqual(buildWorkflowGraph([]), { nodes: [], edges: [] });
  assert.deepEqual(buildWorkflowGraph(undefined), { nodes: [], edges: [] });
  assert.deepEqual(buildWorkflowGraph(null), { nodes: [], edges: [] });
});
