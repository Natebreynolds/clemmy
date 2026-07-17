import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflowRunGraphOverlay } from './workflow-run-overlay.js';
import { buildWorkflowExecutionPlan } from './workflow-execution-plan.js';
import type { WorkflowEvent } from '../execution/workflow-events.js';
import type { WorkflowStepInput } from '../memory/workflow-store.js';

test('buildWorkflowRunGraphOverlay replays durable events into per-step graph state', () => {
  const events: WorkflowEvent[] = [
    { t: '2026-07-04T10:00:00.000Z', kind: 'run_started' },
    { t: '2026-07-04T10:00:01.000Z', kind: 'step_started', stepId: 'pull' },
    { t: '2026-07-04T10:00:02.000Z', kind: 'tool_called', stepId: 'pull', meta: { tool: 'SALESFORCE_GET_RECORDS' } },
    { t: '2026-07-04T10:00:04.000Z', kind: 'step_completed', stepId: 'pull', output: ['a', 'b'] },
    { t: '2026-07-04T10:00:05.000Z', kind: 'step_started', stepId: 'send' },
    { t: '2026-07-04T10:00:06.000Z', kind: 'approval_requested', stepId: 'send' },
    { t: '2026-07-04T10:00:07.000Z', kind: 'approval_granted', stepId: 'send' },
    { t: '2026-07-04T10:00:08.000Z', kind: 'item_started', stepId: 'send', itemKey: 'a' },
    { t: '2026-07-04T10:00:09.000Z', kind: 'item_started', stepId: 'send', itemKey: 'b' },
    { t: '2026-07-04T10:00:10.000Z', kind: 'item_completed', stepId: 'send', itemKey: 'a', output: 'sent-a' },
    { t: '2026-07-04T10:00:11.000Z', kind: 'item_failed', stepId: 'send', itemKey: 'b', error: 'smtp timeout' },
    { t: '2026-07-04T10:00:12.000Z', kind: 'item_retry', stepId: 'send', itemKey: 'b', error: 'smtp timeout' },
    {
      t: '2026-07-04T10:00:13.000Z',
      kind: 'attempt_record',
      stepId: 'send',
      attempt: {
        attemptIndex: 1,
        maxAttempts: 3,
        failedProblems: ['smtp timeout'],
        changeSummary: 'retry after smtp timeout',
        metrics: { toolCalls: 2, durationMs: 500 },
      },
    },
    { t: '2026-07-04T10:00:14.000Z', kind: 'step_advisory', stepId: 'send', meta: { reason: 'goal_validation_unavailable', judge: 'offline' } },
    { t: '2026-07-04T10:00:20.000Z', kind: 'step_failed', stepId: 'send', error: 'smtp timeout' },
    { t: '2026-07-04T10:00:21.000Z', kind: 'run_failed' },
  ];

  const overlay = buildWorkflowRunGraphOverlay(events, { stepIds: ['pull', 'send', 'summary'] });
  assert.equal(overlay.runStatus, 'failed');
  assert.equal(overlay.terminal, true);
  assert.equal(overlay.runStartedAt, '2026-07-04T10:00:00.000Z');
  assert.equal(overlay.runFinishedAt, '2026-07-04T10:00:21.000Z');
  assert.equal(overlay.summary.totalSteps, 3);
  assert.equal(overlay.summary.failedSteps, 1);
  assert.equal(overlay.summary.attentionSteps, 1);
  assert.equal(overlay.summary.bottleneckStepId, 'send');
  assert.equal(overlay.summary.bottleneck, 'failed step');

  const by = Object.fromEntries(overlay.steps.map((step) => [step.stepId, step]));
  assert.equal(by.pull.status, 'done');
  assert.equal(by.pull.runVerdict.status, 'completed');
  assert.equal(by.pull.runVerdict.label, 'Completed');
  assert.equal(by.pull.durationMs, 3000);
  assert.equal(by.pull.toolCalls, 1);
  assert.deepEqual(by.pull.tools, ['SALESFORCE_GET_RECORDS']);
  assert.equal(by.send.status, 'failed');
  assert.equal(by.send.durationMs, 15000);
  assert.equal(by.send.retries, 1);
  assert.equal(by.send.attempts, 1);
  assert.equal(by.send.toolCalls, 2);
  assert.equal(by.send.itemsStarted, 2);
  assert.equal(by.send.itemsCompleted, 1);
  assert.equal(by.send.itemsFailed, 1);
  assert.equal(by.send.approvalsRequested, 1);
  assert.equal(by.send.approvalsResolved, 1);
  assert.equal(by.send.advisories, 1);
  assert.equal(by.send.judgeVerdicts, 1);
  assert.equal(by.send.error, 'smtp timeout');
  assert.equal(by.send.attentionLevel, 'failed');
  assert.equal(by.send.runVerdict.status, 'failed');
  assert.equal(by.send.runVerdict.primaryAction, 'Retry failed items');
  assert.deepEqual(by.send.runVerdict.reasons, [
    'failed: smtp timeout',
    '1 failed item',
    '1 retry',
    '1 advisory',
  ]);
  assert.deepEqual(by.send.attentionReasons, [
    'failed: smtp timeout',
    '1 failed item',
    '1 retry',
    '1 advisory',
  ]);
  assert.deepEqual(by.send.riskSignals, ['1 judge verdict', 'approval gate', '2 tool calls']);
  assert.deepEqual(by.send.throughput, { itemsTotal: 2, itemsCompleted: 1, itemsFailed: 1, completionPct: 50 });
  assert.equal(by.summary.status, 'pending');
  assert.equal(by.summary.runVerdict.status, 'pending');
});

test('buildWorkflowRunGraphOverlay joins harness evidence for tools, models, workers, writes, and judges', () => {
  const events: WorkflowEvent[] = [
    { t: '2026-07-04T10:00:00.000Z', kind: 'run_started' },
    { t: '2026-07-04T10:00:01.000Z', kind: 'step_started', stepId: 'fanout' },
    { t: '2026-07-04T10:00:20.000Z', kind: 'step_completed', stepId: 'fanout', output: 'done' },
    { t: '2026-07-04T10:00:21.000Z', kind: 'run_completed' },
  ];

  const overlay = buildWorkflowRunGraphOverlay(events, {
    stepIds: ['fanout'],
    harnessSessions: [{
      sessionId: 'workflow:run-1:fanout',
      stepId: 'fanout',
      status: 'completed',
      events: [
        { type: 'worker_model_routed', data: { modelId: 'claude-opus-4-8', provider: 'claude', routeKind: 'intent' } },
        { type: 'tool_called', data: { tool: 'GITHUB_CREATE_PULL_REQUEST', callId: 'toolu-pr', accounting: 'top_level' } },
        { type: 'tool_called', data: { tool: 'GITHUB_CREATE_PULL_REQUEST', callId: 'mcp-pr', accounting: 'transport_mirror' } },
        { type: 'worker_result', data: { ok: true, model: 'claude-opus-4-8', toolUses: 3 } },
        { type: 'worker_result', data: { ok: false, model: 'gpt-5-codex', toolUses: 1 } },
        { type: 'worker_capped', data: { maxTurns: 12 } },
        { type: 'external_write', data: { tool: 'GITHUB_CREATE_PULL_REQUEST' } },
        { type: 'external_write_failed', data: { tool: 'SLACK_SEND_MESSAGE' } },
        { type: 'goal_alignment_judged', data: { fulfills: true } },
        { type: 'output_grounding_judged', data: { verdict: 'pass' } },
      ],
    }],
  });

  const fanout = overlay.steps.find((step) => step.stepId === 'fanout');
  assert.ok(fanout);
  assert.deepEqual(fanout.sessionIds, ['workflow:run-1:fanout']);
  assert.equal(fanout.toolCalls, 1);
  assert.deepEqual(fanout.tools, ['GITHUB_CREATE_PULL_REQUEST']);
  assert.deepEqual(fanout.models, ['claude-opus-4-8', 'gpt-5-codex']);
  assert.deepEqual(fanout.routes, ['intent:claude']);
  assert.equal(fanout.workerBranches, 2);
  assert.equal(fanout.workerFailures, 1);
  assert.equal(fanout.workerCapped, 1);
  assert.equal(fanout.externalWrites, 1);
  assert.equal(fanout.externalWriteFailures, 1);
  assert.equal(fanout.judgeVerdicts, 2);
  assert.equal(fanout.attentionLevel, 'watch');
  assert.equal(fanout.runVerdict.status, 'attention');
  assert.equal(fanout.runVerdict.primaryAction, 'Review run evidence');
  assert.ok(fanout.runVerdict.reasons.includes('1 external write failure'));
  assert.deepEqual(fanout.attentionReasons, ['1 external write failure', '1 worker failure', '1 worker capped']);
  assert.deepEqual(fanout.riskSignals, ['2 judge verdicts', '1 external write', '2 worker branches', '1 tool call']);
  assert.equal(overlay.summary.workerBranches, 2);
  assert.equal(overlay.summary.externalWrites, 1);
  assert.equal(overlay.summary.judgeVerdicts, 2);
  assert.equal(overlay.summary.bottleneckStepId, 'fanout');
  assert.equal(overlay.summary.bottleneck, 'external write failure');
});

test('buildWorkflowRunGraphOverlay marks completed judged steps as proven', () => {
  const events: WorkflowEvent[] = [
    { t: '2026-07-04T10:00:00.000Z', kind: 'run_started' },
    { t: '2026-07-04T10:00:01.000Z', kind: 'step_started', stepId: 'review' },
    { t: '2026-07-04T10:00:04.000Z', kind: 'step_completed', stepId: 'review', output: 'approved' },
    { t: '2026-07-04T10:00:05.000Z', kind: 'run_completed' },
  ];

  const overlay = buildWorkflowRunGraphOverlay(events, {
    stepIds: ['review'],
    harnessSessions: [{
      sessionId: 'workflow:run-1:review',
      stepId: 'review',
      status: 'completed',
      events: [
        { type: 'output_grounding_judged', data: { verdict: 'pass' } },
      ],
    }],
  });

  const review = overlay.steps.find((step) => step.stepId === 'review');
  assert.ok(review);
  assert.equal(review.status, 'done');
  assert.equal(review.judgeVerdicts, 1);
  assert.equal(review.runVerdict.status, 'proven');
  assert.equal(review.runVerdict.label, 'Proven');
  assert.deepEqual(review.runVerdict.reasons, ['1 judge verdict recorded']);
  assert.equal(review.runVerdict.primaryAction, null);
});

test('buildWorkflowRunGraphOverlay captures node readiness, cap pressure, and queue wait', () => {
  const events: WorkflowEvent[] = [
    { t: '2026-07-04T10:00:00.000Z', kind: 'run_started' },
    { t: '2026-07-04T10:00:01.000Z', kind: 'workflow_node_ready', stepId: 'a', meta: { round: 1, readyWidth: 3, concurrencyCap: 2, scheduled: true, laneIndex: 0, deferredByConcurrency: false } },
    { t: '2026-07-04T10:00:01.000Z', kind: 'workflow_node_ready', stepId: 'b', meta: { round: 1, readyWidth: 3, concurrencyCap: 2, scheduled: true, laneIndex: 1, deferredByConcurrency: false } },
    { t: '2026-07-04T10:00:01.000Z', kind: 'workflow_node_ready', stepId: 'c', meta: { round: 1, readyWidth: 3, concurrencyCap: 2, scheduled: false, laneIndex: null, deferredByConcurrency: true } },
    { t: '2026-07-04T10:00:02.000Z', kind: 'step_started', stepId: 'a' },
    { t: '2026-07-04T10:00:02.000Z', kind: 'step_started', stepId: 'b' },
    { t: '2026-07-04T10:00:03.000Z', kind: 'step_completed', stepId: 'a', output: 'a' },
    { t: '2026-07-04T10:00:03.000Z', kind: 'step_completed', stepId: 'b', output: 'b' },
    { t: '2026-07-04T10:00:04.000Z', kind: 'workflow_node_ready', stepId: 'c', meta: { round: 2, readyWidth: 1, concurrencyCap: 2, scheduled: true, laneIndex: 0, deferredByConcurrency: false } },
    { t: '2026-07-04T10:00:05.000Z', kind: 'step_started', stepId: 'c' },
    { t: '2026-07-04T10:00:06.000Z', kind: 'step_completed', stepId: 'c', output: 'c' },
    { t: '2026-07-04T10:00:07.000Z', kind: 'run_completed' },
  ];

  const overlay = buildWorkflowRunGraphOverlay(events, { stepIds: ['a', 'b', 'c'] });
  const by = Object.fromEntries(overlay.steps.map((step) => [step.stepId, step]));
  assert.equal(by.a.readyAt, '2026-07-04T10:00:01.000Z');
  assert.equal(by.a.queueWaitMs, 1000);
  assert.equal(by.a.readyRound, 1);
  assert.equal(by.a.readyWidth, 3);
  assert.equal(by.a.concurrencyCap, 2);
  assert.equal(by.a.laneIndex, 0);
  assert.equal(by.a.deferredByConcurrency, false);
  assert.ok(by.a.riskSignals.includes('batch width 3 > cap 2'));
  assert.equal(by.c.readyAt, '2026-07-04T10:00:01.000Z');
  assert.equal(by.c.queueWaitMs, 4000);
  assert.equal(by.c.readyRound, 2);
  assert.equal(by.c.readyWidth, 1);
  assert.equal(by.c.deferredByConcurrency, false);
  assert.equal(overlay.summary.concurrencyCapPressureSteps, 2);
  assert.equal(overlay.summary.maxBatchWidth, 3);
  assert.equal(overlay.summary.maxQueueWaitMs, 4000);
});

test('buildWorkflowRunGraphOverlay diagnoses planned-vs-live execution drift', () => {
  const steps: WorkflowStepInput[] = [
    { id: 'fetch_accounts', prompt: 'Fetch accounts.', output: { type: 'array' } },
    { id: 'fetch_notes', prompt: 'Fetch notes.' },
    {
      id: 'process_each',
      prompt: 'Process every account.',
      dependsOn: ['fetch_accounts'],
      forEach: 'fetch_accounts',
      forEachNewOnly: true,
    },
    {
      id: 'send',
      prompt: 'Send the report.',
      dependsOn: ['fetch_notes', 'process_each'],
      sideEffect: 'send',
      requiresApproval: true,
    },
  ];
  const executionPlan = buildWorkflowExecutionPlan(steps, { stepConcurrency: 3, forEachBatchSize: 20 });
  const events: WorkflowEvent[] = [
    { t: '2026-07-04T10:00:00.000Z', kind: 'run_started' },
    { t: '2026-07-04T10:00:01.000Z', kind: 'workflow_node_ready', stepId: 'fetch_accounts', meta: { round: 1, readyWidth: 1, concurrencyCap: 3, laneIndex: 0 } },
    { t: '2026-07-04T10:00:02.000Z', kind: 'step_started', stepId: 'fetch_accounts' },
    { t: '2026-07-04T10:00:03.000Z', kind: 'step_completed', stepId: 'fetch_accounts', output: ['a', 'b', 'c'] },
    { t: '2026-07-04T10:00:04.000Z', kind: 'workflow_node_ready', stepId: 'fetch_notes', meta: { round: 2, readyWidth: 1, concurrencyCap: 3, laneIndex: 0 } },
    { t: '2026-07-04T10:00:05.000Z', kind: 'step_started', stepId: 'fetch_notes' },
    { t: '2026-07-04T10:00:06.000Z', kind: 'step_completed', stepId: 'fetch_notes', output: 'notes' },
    { t: '2026-07-04T10:00:07.000Z', kind: 'workflow_node_ready', stepId: 'process_each', meta: { round: 3, readyWidth: 1, concurrencyCap: 3, laneIndex: 0 } },
    { t: '2026-07-04T10:00:08.000Z', kind: 'step_started', stepId: 'process_each' },
    { t: '2026-07-04T10:00:09.000Z', kind: 'item_started', stepId: 'process_each', itemKey: 'a' },
    { t: '2026-07-04T10:00:10.000Z', kind: 'item_started', stepId: 'process_each', itemKey: 'b' },
    { t: '2026-07-04T10:00:11.000Z', kind: 'item_started', stepId: 'process_each', itemKey: 'c' },
    { t: '2026-07-04T10:00:12.000Z', kind: 'item_completed', stepId: 'process_each', itemKey: 'a', output: 'a done' },
    { t: '2026-07-04T10:00:13.000Z', kind: 'item_completed', stepId: 'process_each', itemKey: 'b', output: 'b done' },
    { t: '2026-07-04T10:00:14.000Z', kind: 'item_completed', stepId: 'process_each', itemKey: 'c', output: 'c done' },
    { t: '2026-07-04T10:00:15.000Z', kind: 'step_completed', stepId: 'process_each', output: ['a done', 'b done', 'c done'] },
    { t: '2026-07-04T10:00:16.000Z', kind: 'workflow_node_ready', stepId: 'send', meta: { round: 4, readyWidth: 1, concurrencyCap: 3, laneIndex: 0 } },
    { t: '2026-07-04T10:00:17.000Z', kind: 'step_started', stepId: 'send' },
    { t: '2026-07-04T10:00:18.000Z', kind: 'approval_requested', stepId: 'send' },
    { t: '2026-07-04T10:00:19.000Z', kind: 'run_paused' },
  ];

  const overlay = buildWorkflowRunGraphOverlay(events, {
    stepIds: steps.map((step) => step.id),
    executionPlan,
  });

  assert.equal(overlay.executionEfficiency?.plannedMaxParallelWidth, 2);
  assert.equal(overlay.executionEfficiency?.runtimeMaxParallelWidth, 1);
  assert.equal(overlay.executionEfficiency?.runtimeReadyRounds, 4);
  assert.equal(overlay.executionEfficiency?.attentionLevel, 'blocked');
  assert.ok(overlay.executionEfficiency?.issues.some((issue) => issue.kind === 'parallel_underused'));
  assert.ok(overlay.executionEfficiency?.issues.some((issue) => issue.kind === 'fanout_underused' && issue.stepId === 'process_each'));
  assert.ok(overlay.executionEfficiency?.issues.some((issue) => issue.kind === 'critical_path_blocked' && issue.stepId === 'send'));
  const by = Object.fromEntries(overlay.steps.map((step) => [step.stepId, step]));
  assert.equal(by.fetch_accounts.executionEfficiency?.plannedParallelWidth, 2);
  assert.equal(by.fetch_accounts.executionEfficiency?.plannedCritical, true);
  assert.equal(by.fetch_notes.executionEfficiency?.plannedCritical, false);
  assert.equal(by.process_each.executionEfficiency?.plannedFanoutConcurrency, 3);
  assert.deepEqual(by.process_each.executionEfficiency?.issueKinds, ['fanout_underused']);
  assert.equal(by.process_each.executionEfficiency?.attentionLevel, 'watch');
  assert.equal(by.process_each.runVerdict.status, 'attention');
  assert.equal(by.process_each.runVerdict.primaryAction, 'Re-run fan-out to plan');
  assert.deepEqual(by.send.executionEfficiency?.issueKinds, ['critical_path_blocked']);
  assert.equal(by.send.executionEfficiency?.attentionLevel, 'blocked');
  assert.equal(by.send.runVerdict.status, 'blocked');
  assert.equal(by.send.runVerdict.primaryAction, 'Resolve approval');
});

test('buildWorkflowRunGraphOverlay carries launch readiness beside replayed runtime evidence', () => {
  const events: WorkflowEvent[] = [
    { t: '2026-07-04T10:00:00.000Z', kind: 'run_started' },
    { t: '2026-07-04T10:00:01.000Z', kind: 'step_started', stepId: 'fetch' },
    { t: '2026-07-04T10:00:02.000Z', kind: 'tool_called', stepId: 'fetch', meta: { tool: 'SALESFORCE_GET_RECORDS' } },
    { t: '2026-07-04T10:00:04.000Z', kind: 'step_completed', stepId: 'fetch', output: 'done' },
    { t: '2026-07-04T10:00:05.000Z', kind: 'step_started', stepId: 'send' },
    { t: '2026-07-04T10:00:06.000Z', kind: 'step_failed', stepId: 'send', error: 'gmail rejected' },
    { t: '2026-07-04T10:00:07.000Z', kind: 'run_failed' },
  ];

  const overlay = buildWorkflowRunGraphOverlay(events, {
    stepIds: ['fetch', 'send'],
    harnessSessions: [{
      sessionId: 'workflow:launch-runtime:send',
      stepId: 'send',
      events: [
        { type: 'tool_called', data: { tool: 'composio_execute_tool', args: { tool_slug: 'GMAIL_SEND', arguments: { to: 'a@example.com' } } } },
        { type: 'external_write_failed', data: { tool: 'composio_execute_tool', arguments: '{"tool":"GMAIL_SEND","arguments":{"to":"a@example.com"}}' } },
      ],
    }],
    recoveryIntent: {
      kind: 'failed_items',
      createdAt: '2026-07-04T10:01:00.000Z',
      sourceRunId: 'run-source',
      sourceStepId: 'send',
      requestedFrom: 'graph',
      reason: 'graph node retry failed forEach items',
    },
    recoveryLineage: [
      { runId: 'run-source', status: 'completed_with_errors', isCurrent: false },
      {
        runId: 'run-retry',
        sourceRunId: 'run-source',
        sourceStepId: 'send',
        status: 'queued',
        kind: 'failed_items',
        requestedFrom: 'graph',
        isCurrent: true,
      },
    ],
    launchReadiness: {
      ok: true,
      checkedAt: '2026-07-04T09:59:59.000Z',
      scope: 'run',
      blockers: [],
      warnings: [
        {
          kind: 'composio',
          name: 'SALESFORCE_GET_RECORDS',
          status: 'unknown',
          reason: 'broker available; exact tool unresolved',
          stepIds: ['fetch'],
          sources: ['step_call'],
          evidence: [{ kind: 'composio_broker', name: 'composio_execute_tool', status: 'ready' }],
        },
        {
          kind: 'composio',
          name: 'GMAIL_SEND',
          status: 'unknown',
          reason: 'broker available; exact tool unresolved',
          stepIds: ['send'],
          sources: ['step_call'],
          evidence: [{ kind: 'composio_broker', name: 'composio_execute_tool', status: 'ready' }],
        },
      ],
      toolReadiness: {
        ready: false,
        readyCount: 0,
        missingCount: 0,
        unknownCount: 2,
        items: [],
      },
    },
  });

  assert.equal(overlay.launchReadiness?.ok, true);
  assert.equal(overlay.launchReadiness?.checkedAt, '2026-07-04T09:59:59.000Z');
  assert.equal(overlay.launchReadiness?.scope, 'run');
  assert.equal(overlay.recoveryIntent?.kind, 'failed_items');
  assert.equal(overlay.recoveryIntent?.sourceRunId, 'run-source');
  assert.equal(overlay.recoveryIntent?.sourceStepId, 'send');
  assert.equal(overlay.recoveryIntent?.requestedFrom, 'graph');
  assert.deepEqual(overlay.recoveryLineage.map((entry) => entry.runId), ['run-source', 'run-retry']);
  assert.equal(overlay.recoveryLineage[1]?.isCurrent, true);
  assert.equal(overlay.recoveryLineage[1]?.kind, 'failed_items');
  assert.equal(overlay.launchReadiness?.warnings[0]?.name, 'SALESFORCE_GET_RECORDS');
  assert.equal(overlay.launchReadiness?.warnings[0]?.evidence?.[0]?.kind, 'composio_broker');
  assert.equal(overlay.steps[0].stepId, 'fetch');
  const fetch = overlay.steps.find((step) => step.stepId === 'fetch');
  const send = overlay.steps.find((step) => step.stepId === 'send');
  assert.deepEqual(send?.tools, ['GMAIL_SEND']);
  assert.deepEqual(send?.failedTools, ['GMAIL_SEND']);
  assert.deepEqual(fetch?.launchComparison?.confirmedLaunchTools, ['SALESFORCE_GET_RECORDS']);
  assert.equal(fetch?.launchComparison?.attentionLevel, 'none');
  assert.deepEqual(send?.launchComparison?.confirmedLaunchTools, ['GMAIL_SEND']);
  assert.deepEqual(send?.launchComparison?.preflightRiskHits, ['GMAIL_SEND']);
  assert.equal(send?.launchComparison?.attentionLevel, 'failed');
  assert.equal(fetch?.runVerdict.status, 'completed');
  assert.equal(send?.runVerdict.status, 'failed');
  assert.equal(send?.runVerdict.primaryAction, 'Repair failed tool connection');
  assert.ok(send?.runVerdict.reasons.some((reason) => reason.includes('preflight risk')));
  assert.equal(overlay.launchComparison?.launchToolCount, 2);
  assert.equal(overlay.launchComparison?.launchIssueCount, 2);
  assert.equal(overlay.launchComparison?.runtimeToolCount, 2);
  assert.deepEqual(overlay.launchComparison?.confirmedLaunchTools, ['SALESFORCE_GET_RECORDS', 'GMAIL_SEND']);
  assert.deepEqual(overlay.launchComparison?.failedTools, ['GMAIL_SEND']);
  assert.deepEqual(overlay.launchComparison?.preflightRiskHits, ['GMAIL_SEND']);
  assert.equal(overlay.launchComparison?.attentionLevel, 'failed');
});

test('buildWorkflowRunGraphOverlay surfaces pinned run-goal judge evidence without adding a graph step', () => {
  const events: WorkflowEvent[] = [
    { t: '2026-07-04T10:00:00.000Z', kind: 'run_started' },
    { t: '2026-07-04T10:00:01.000Z', kind: 'step_started', stepId: 'draft' },
    { t: '2026-07-04T10:00:05.000Z', kind: 'step_completed', stepId: 'draft', output: 'drafted' },
    {
      t: '2026-07-04T10:00:06.000Z',
      kind: 'attempt_record',
      attempt: {
        attemptIndex: 1,
        maxAttempts: 3,
        failedProblems: ['Report contains no send receipt.'],
        changeSummary: 'run attempt 1: 50% (1/2 criteria met)',
        metrics: { tokens: 1200 },
      },
    },
    {
      t: '2026-07-04T10:00:07.000Z',
      kind: 'step_advisory',
      stepId: '(run goal)',
      meta: {
        goal: 'repursue',
        reason: 'goal unmet (attempt 1/3)',
        attempt: 1,
        max: 3,
        successRatePercent: 50,
        criteriaMet: 1,
        criteriaTotal: 2,
        failedCriteria: ['Report contains no send receipt.'],
        requeueRunId: 'run-2',
        feedbackPreview: '- UNMET: Report contains no send receipt.',
      },
    },
    { t: '2026-07-04T10:00:08.000Z', kind: 'run_completed' },
  ];

  const overlay = buildWorkflowRunGraphOverlay(events, { stepIds: ['draft'] });
  assert.equal(overlay.steps.length, 1);
  assert.equal(overlay.summary.totalSteps, 1);
  assert.equal(overlay.summary.judgeVerdicts, 1);
  assert.equal(overlay.summary.goalStatus, 'repursue');
  assert.equal(overlay.summary.goalAttempt, 1);
  assert.equal(overlay.summary.goalMaxAttempts, 3);
  assert.equal(overlay.summary.goalSuccessRatePercent, 50);
  assert.equal(overlay.summary.goalNeedsAttention, true);
  assert.ok(overlay.goal);
  assert.equal(overlay.goal.status, 'repursue');
  assert.equal(overlay.goal.reason, 'goal unmet (attempt 1/3)');
  assert.equal(overlay.goal.successRatePercent, 50);
  assert.equal(overlay.goal.criteriaMet, 1);
  assert.equal(overlay.goal.criteriaTotal, 2);
  assert.deepEqual(overlay.goal.failedCriteria, ['Report contains no send receipt.']);
  assert.equal(overlay.goal.requeueRunId, 'run-2');
  assert.equal(overlay.goal.feedbackPreview, '- UNMET: Report contains no send receipt.');
  assert.equal(overlay.goal.attempts.length, 1);
  assert.equal(overlay.goal.attempts[0].changeSummary, 'run attempt 1: 50% (1/2 criteria met)');
  assert.equal(overlay.goal.attentionLevel, 'watch');
});
