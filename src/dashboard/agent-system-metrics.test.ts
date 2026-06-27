import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-agent-system-metrics-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_V2_PEER_COMMS = 'off';

const { appendWorkflowEvent } = await import('../execution/workflow-events.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');
const { recallWorkflowPatterns, recordSuccessfulWorkflowPattern } = await import('../memory/workflow-pattern-store.js');
const { collectAgentSystemMetrics } = await import('./agent-system-metrics.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function writeAgent(slug: string, frontmatter: string): void {
  const dir = path.join(TMP_HOME, 'vault', '00-System', 'agents', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'agent.md'), `---\n${frontmatter}\n---\n`, 'utf-8');
}

function writeWorkflowRun(record: Record<string, unknown>): void {
  const dir = path.join(TMP_HOME, 'workflows', 'runs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record, null, 2), 'utf-8');
}

test('collectAgentSystemMetrics summarizes swarm and loop effectiveness from durable logs', () => {
  resetEventLog();
  const metricWorkflow = {
    name: 'Metric Workflow',
    description: 'Audit law firm SEO visibility and draft report',
    enabled: true,
    trigger: { manual: true },
    allowedTools: ['read_file'],
    steps: [
      { id: 'research', prompt: 'Research SEO visibility', sideEffect: 'read' },
      { id: 'draft', prompt: 'Draft report', sideEffect: 'write', usesSkill: 'proposal-builder' },
    ],
  };
  writeWorkflow('metric-wf', metricWorkflow as never);
  writeAgent('clementine', 'name: Clementine\ndescription: primary\nrole: orchestrator');
  writeAgent('researcher', 'name: Researcher\ndescription: researches\ncanMessage:\n  - clementine\nautonomyEnabled: true');
  writeAgent('writer', 'name: Writer\ndescription: drafts\ncanMessage:\n  - ghost');

  mkdirSync(path.join(TMP_HOME, 'logs'), { recursive: true });
  appendFileSync(path.join(TMP_HOME, 'logs', 'team-comms.jsonl'), [
    JSON.stringify({ id: 'm1', fromAgent: 'researcher', toAgent: 'clementine', timestamp: new Date().toISOString(), protocol: 'request' }),
    JSON.stringify({ id: 'm2', fromAgent: 'clementine', toAgent: 'researcher', timestamp: new Date().toISOString(), protocol: 'response' }),
  ].join('\n') + '\n');

  mkdirSync(path.join(TMP_HOME, 'agents-state'), { recursive: true });
  writeFileSync(path.join(TMP_HOME, 'agents-state', 'researcher.json'), JSON.stringify({ slug: 'researcher', lastError: 'tool auth expired' }), 'utf-8');

  writeWorkflowRun({
    id: 'run-clean',
    workflow: 'Metric Workflow',
    status: 'completed',
    createdAt: '2026-06-26T10:00:00.000Z',
    startedAt: '2026-06-26T10:00:10.000Z',
    finishedAt: '2026-06-26T10:01:10.000Z',
    goalOutcome: 'satisfied',
  });
  writeWorkflowRun({
    id: 'run-bad',
    workflow: 'Metric Workflow',
    status: 'completed_with_errors',
    createdAt: '2026-06-26T11:00:00.000Z',
    startedAt: '2026-06-26T11:00:10.000Z',
    finishedAt: '2026-06-26T11:02:10.000Z',
    needsAttention: true,
    goalOutcome: 'escalate',
    selfHealAttempt: 1,
    goalAttempt: 1,
  });

  appendWorkflowEvent('metric-wf', 'run-bad', {
    kind: 'attempt_record',
    stepId: 'scrape',
    attempt: {
      attemptIndex: 1,
      maxAttempts: 3,
      failedProblems: ['min_items'],
      changeSummary: 'attempt 1: 1 contract problem',
      metrics: { durationMs: 100, tokens: 50, toolCalls: 1 },
    },
  });
  appendWorkflowEvent('metric-wf', 'run-bad', { kind: 'step_loop_retry', stepId: 'scrape', meta: { attempt: 1 } });
  appendWorkflowEvent('metric-wf', 'run-bad', { kind: 'step_failed', stepId: 'scrape', error: 'min_items contract failed after retry' });
  appendWorkflowEvent('metric-wf', 'run-bad', { kind: 'item_completed', stepId: 'send', itemKey: 'a', output: 'ok' });
  appendWorkflowEvent('metric-wf', 'run-bad', { kind: 'item_failed', stepId: 'send', itemKey: 'b', error: 'missing email' });

  recordSuccessfulWorkflowPattern({
    workflow: metricWorkflow as never,
    workflowSlug: 'metric-wf',
    runId: 'run-clean',
    finalOutput: 'Saved SEO report with 8 opportunities.',
  });
  assert.equal(recallWorkflowPatterns('law firm SEO audit report', 2).length, 1);
  assert.equal(recallWorkflowPatterns('book dinner reservation', 2).length, 0);

  const workerSession = createSession({ kind: 'chat', title: 'fanout sample' });
  appendEvent({
    sessionId: workerSession.id,
    turn: 1,
    role: 'system',
    type: 'worker_model_routed',
    data: {
      toolCallId: 'call-a',
      attemptedIntent: 'research',
      matchedIntent: 'research',
      modelId: 'gpt-5.5',
      provider: 'openai',
      transport: 'nested_worker',
      item: 'Firm A',
    },
  });
  appendEvent({
    sessionId: workerSession.id,
    turn: 1,
    role: 'system',
    type: 'worker_model_routed',
    data: {
      toolCallId: 'call-b',
      attemptedIntent: 'design',
      matchedIntent: null,
      modelId: 'claude-sonnet-4-6',
      provider: 'claude',
      transport: 'claude_agent_sdk_worker',
      item: 'Firm B',
    },
  });
  appendEvent({
    sessionId: workerSession.id,
    turn: 1,
    role: 'system',
    type: 'worker_capped',
    data: { callId: 'call-b', item: 'Firm B' },
  });
  appendEvent({
    sessionId: workerSession.id,
    turn: 1,
    role: 'system',
    type: 'fanout_policy_decision',
    data: {
      inputPreview: 'Research these 10 prospects.',
      sessionKind: 'chat',
      complexity: 'moderate',
      detected: true,
      itemCount: 10,
      offered: true,
      blockedByPolicy: false,
      fanoutPosture: 'soft',
      recommendedWorkerWaveSize: 4,
      policyMode: 'review-swarm',
      policyStatus: 'watch',
      policyConfidence: 68,
    },
  });
  appendEvent({
    sessionId: workerSession.id,
    turn: 2,
    role: 'system',
    type: 'fanout_policy_decision',
    data: {
      inputPreview: 'Research these 10 prospects.',
      sessionKind: 'chat',
      complexity: 'moderate',
      detected: true,
      itemCount: 10,
      offered: false,
      blockedByPolicy: true,
      fanoutPosture: 'block',
      recommendedWorkerWaveSize: 0,
      policyMode: 'repair-loop',
      policyStatus: 'repair',
      policyConfidence: 94,
    },
  });

  mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
  writeFileSync(path.join(TMP_HOME, 'state', 'agent-system-metrics-history.json'), JSON.stringify([
    {
      at: '2026-06-25T00:00:00.000Z',
      swarmReadinessScore: 80,
      loopEffectivenessScore: 90,
      interventionScore: 85,
      workflowRecallHitRatePct: 100,
      workerCapRatePct: 0,
      blockedAgents: 0,
      itemFailures: 0,
    },
  ], null, 2), 'utf-8');

  const metrics = collectAgentSystemMetrics();

  assert.equal(metrics.swarm.agentCount, 3);
  assert.equal(metrics.swarm.peerCommsEnabled, false);
  assert.equal(metrics.swarm.comms24h.requests, 1);
  assert.equal(metrics.swarm.comms24h.responses, 1);
  assert.equal(metrics.swarm.blockedAgents, 1);
  assert.equal(metrics.swarm.topology.kind, 'isolated');
  assert.equal(metrics.swarm.topology.configuredEdges, 1);
  assert.equal(metrics.swarm.topology.possibleEdges, 6);
  assert.equal(metrics.swarm.topology.densityPct, 17);
  assert.equal(metrics.swarm.topology.reciprocityPct, 0);
  assert.deepEqual(metrics.swarm.topology.unknownTargets, [{ from: 'writer', to: 'ghost' }]);
  assert.ok(metrics.swarm.topology.isolatedAgents.includes('writer'));
  assert.equal(metrics.swarm.topology.recentRequests, 1);
  assert.equal(metrics.swarm.topology.recentResponses, 1);
  assert.equal(metrics.swarm.topology.requestResponsePct, 100);
  assert.ok(metrics.swarm.readiness.score < 10);
  assert.equal(metrics.swarm.readiness.status, 'blocked');
  assert.ok(metrics.swarm.readiness.risks.some((risk) => /peer comms/i.test(risk)));
  assert.ok(metrics.swarm.readiness.risks.some((risk) => /blocked/i.test(risk)));
  assert.ok(metrics.swarm.readiness.risks.some((risk) => /missing agents/i.test(risk)));
  assert.ok(metrics.swarm.readiness.strengths.some((strength) => /3 team agents/i.test(strength)));
  assert.equal(metrics.swarm.workerSessions, 1);
  assert.equal(metrics.swarm.workerRoutes, 2);
  assert.equal(metrics.swarm.workerCapped, 1);
  assert.equal(metrics.swarm.effectiveness.sampleSessions, 1);
  assert.equal(metrics.swarm.effectiveness.workerRoutes, 2);
  assert.equal(metrics.swarm.effectiveness.workerCapped, 1);
  assert.equal(metrics.swarm.effectiveness.capRatePct, 50);
  assert.equal(metrics.swarm.effectiveness.policyDecisions, 2);
  assert.equal(metrics.swarm.effectiveness.fanoutOffered, 1);
  assert.equal(metrics.swarm.effectiveness.fanoutBlockedByPolicy, 1);
  assert.equal(metrics.swarm.effectiveness.fanoutSuppressedByPolicyPct, 50);
  assert.equal(metrics.swarm.effectiveness.averageRecommendedWaveSize, 2);
  assert.ok(metrics.swarm.effectiveness.postureSpread.some((row) => row.posture === 'block' && row.count === 1));
  assert.ok(metrics.swarm.effectiveness.postureSpread.some((row) => row.posture === 'soft' && row.count === 1));
  assert.equal(metrics.swarm.effectiveness.intentRoutes, 2);
  assert.equal(metrics.swarm.effectiveness.intentMatches, 1);
  assert.equal(metrics.swarm.effectiveness.intentMatchRatePct, 50);
  assert.ok(metrics.swarm.effectiveness.modelSpread.some((row) => row.modelId === 'gpt-5.5' && row.count === 1));
  assert.ok(metrics.swarm.effectiveness.modelSpread.some((row) => row.modelId === 'claude-sonnet-4-6' && row.count === 1));
  assert.ok(metrics.swarm.effectiveness.recentCappedItems.includes('Firm B'));
  assert.match(metrics.swarm.effectiveness.recommendation, /turn caps|budget|fanout/i);
  assert.match(metrics.swarm.recommendation, /worker budget|capped worker/i);
  assert.equal(metrics.swarm.scorecards.length, 3);
  const researcher = metrics.swarm.scorecards.find((scorecard) => scorecard.slug === 'researcher');
  assert.equal(researcher?.status, 'blocked');
  assert.ok((researcher?.score ?? 100) < 60);
  assert.equal(researcher?.comms24h.sent, 1);
  assert.equal(researcher?.comms24h.received, 1);
  assert.match(researcher?.recommendation ?? '', /last error/i);

  assert.equal(metrics.loops.workflowRuns.total, 2);
  assert.equal(metrics.loops.workflowRuns.clean, 1);
  assert.equal(metrics.loops.workflowRuns.needsAttention, 1);
  assert.equal(metrics.loops.attemptRecords, 1);
  assert.equal(metrics.loops.retryEvents, 1);
  assert.equal(metrics.loops.forEachItems.completed, 1);
  assert.equal(metrics.loops.forEachItems.failed, 1);
  assert.equal(metrics.loops.goalSatisfied, 1);
  assert.equal(metrics.loops.goalEscalated, 1);
  assert.equal(metrics.loops.selfHealRuns, 1);
  assert.equal(metrics.loops.goalRepursuits, 1);
  assert.ok(metrics.loops.loopEffectivenessScore < 80);
  assert.equal(metrics.loops.interventions.status, 'thrashing');
  assert.ok(metrics.loops.interventions.score < 20);
  assert.equal(metrics.loops.interventions.retryPressurePct, 50);
  assert.equal(metrics.loops.interventions.retryEvents, 1);
  assert.equal(metrics.loops.interventions.attemptRecords, 1);
  assert.deepEqual(metrics.loops.interventions.selfHeal, { runs: 1, clean: 0, needsAttention: 1, successRatePct: 0 });
  assert.deepEqual(metrics.loops.interventions.goalRepursuit, { runs: 1, satisfied: 0, escalated: 1, successRatePct: 0 });
  assert.equal(metrics.loops.interventions.forEachRecovery.failed, 1);
  assert.ok(metrics.loops.interventions.risks.some((risk) => /self-heal/i.test(risk)));
  assert.ok(metrics.loops.interventions.risks.some((risk) => /escalated/i.test(risk)));
  assert.equal(metrics.loops.learning.status, 'compounding');
  assert.equal(metrics.loops.learning.patternCount, 1);
  assert.equal(metrics.loops.learning.totalCleanPatternRuns, 1);
  assert.equal(metrics.loops.learning.remembers, 1);
  assert.equal(metrics.loops.learning.recallHits, 1);
  assert.equal(metrics.loops.learning.recallMisses, 1);
  assert.equal(metrics.loops.learning.recallHitRatePct, 50);
  assert.equal(metrics.loops.learning.topPatterns[0]?.workflowName, 'Metric Workflow');
  assert.equal(metrics.trend.status, 'regressing');
  assert.equal(metrics.trend.baselineAt, '2026-06-25T00:00:00.000Z');
  assert.equal(metrics.trend.samples, 2);
  assert.ok(metrics.trend.delta.swarmReadinessScore < 0);
  assert.ok(metrics.trend.delta.loopEffectivenessScore < 0);
  assert.equal(metrics.trend.delta.workerCapRatePct, 50);
  assert.equal(metrics.trend.delta.blockedAgents, 1);
  assert.equal(metrics.trend.delta.itemFailures, 1);
  assert.equal(metrics.trend.recent.length, 2);
  assert.equal(metrics.trend.recent[0]?.at, '2026-06-25T00:00:00.000Z');
  assert.equal(typeof metrics.trend.recent[0]?.healthScore, 'number');
  assert.ok((metrics.trend.recent[0]?.healthScore ?? 0) > (metrics.trend.recent[1]?.healthScore ?? 100));
  assert.ok(metrics.trend.signals.some((signal) => /Swarm readiness|Loop effectiveness|Worker cap rate/.test(signal)));
  assert.equal(metrics.coordination.mode, 'repair-loop');
  assert.equal(metrics.coordination.status, 'repair');
  assert.equal(metrics.coordination.fanoutPosture, 'block');
  assert.equal(metrics.coordination.recommendedWorkerWaveSize, 0);
  assert.equal(metrics.coordination.confidence, 94);
  assert.ok(metrics.coordination.reasons.some((reason) => /loop effectiveness/i.test(reason)));
  assert.ok(metrics.coordination.guardrails.some((guardrail) => /full-rerun|failed-item retry/i.test(guardrail)));
  const tooFewItems = metrics.loops.issueCauses.find((cause) => cause.key === 'too-few-items');
  assert.equal(tooFewItems?.count, 2);
  assert.deepEqual(tooFewItems?.sources.sort(), ['contract', 'step']);
  assert.ok(metrics.recentWarnings.some((warning) => warning.kind === 'loop'));
  assert.ok(metrics.recommendations.some((rec) => rec.id === 'swarm-enable-peer-comms'));
  assert.ok(metrics.recommendations.some((rec) => rec.id === 'swarm-agent-scorecard-risk'));
  assert.ok(metrics.recommendations.some((rec) => rec.id === 'swarm-readiness-low'));
  assert.ok(metrics.recommendations.some((rec) => rec.id === 'swarm-fix-unknown-message-targets'));
  assert.ok(metrics.recommendations.some((rec) => rec.id === 'swarm-fanout-policy-constrained'));
  assert.ok(metrics.recommendations.some((rec) => rec.id === 'loop-rerun-failed-items'));
  assert.ok(metrics.recommendations.some((rec) => rec.id === 'loop-interventions-thrashing'));
  assert.ok(metrics.recommendations.some((rec) => rec.id === 'loop-fix-top-cause'));
  assert.ok(metrics.recommendations.some((rec) => rec.id === 'system-trend-regressing'));
  assert.ok(metrics.recommendations.every((rec) => rec.title && rec.action && rec.href && rec.cta));
  assert.ok(metrics.recommendations.some((rec) => rec.id === 'swarm-enable-peer-comms' && rec.href === '/advanced/developer'));
  assert.ok(metrics.recommendations.some((rec) => rec.id === 'loop-rerun-failed-items' && rec.href === '/automate'));
});
