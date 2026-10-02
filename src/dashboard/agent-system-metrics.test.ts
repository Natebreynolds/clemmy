import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-agent-system-metrics-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_V2_PEER_COMMS = 'off';
// The owner has one worker routing rule, so worker intent labels can match.
process.env.CLEMMY_MODEL_ROLES = JSON.stringify([{ role: 'worker', modelId: 'gpt-5.6-terra', whenIntent: 'research' }]);

const { appendWorkflowEvent } = await import('../execution/workflow-events.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');
const { recallWorkflowPatterns, recordSuccessfulWorkflowPattern } = await import('../memory/workflow-pattern-store.js');
const { evaluateLearningCandidate } = await import('../memory/learning-receipt.js');
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
  writeWorkflowRun({
    id: 'run-parked',
    workflow: 'Metric Workflow',
    status: 'parked',
    createdAt: '2026-06-26T12:00:00.000Z',
    startedAt: '2026-06-26T12:00:10.000Z',
    needsAttention: true,
  });
  // Finished, writes landed, goal review found a gap: terminal, not clean.
  writeWorkflowRun({
    id: 'run-gap',
    workflow: 'Metric Workflow',
    status: 'completed',
    createdAt: '2026-06-26T13:00:00.000Z',
    startedAt: '2026-06-26T13:00:10.000Z',
    finishedAt: '2026-06-26T13:01:10.000Z',
    goalOutcome: 'gap',
    goalReason: 'the run\'s writes landed; the goal review still found a gap',
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
  appendWorkflowEvent('metric-wf', 'run-parked', {
    kind: 'step_failed',
    stepId: 'publish',
    error: 'Workflow run parked on approval.',
  });

  recordSuccessfulWorkflowPattern({
    workflow: metricWorkflow as never,
    workflowSlug: 'metric-wf',
    runId: 'run-clean',
    finalOutput: 'Saved SEO report with 8 opportunities.',
    learningReceipt: evaluateLearningCandidate({
      target: 'workflow_pattern',
      authority: 'workflow_terminal',
      sessionId: 'workflow:run-clean:step',
      sourceId: 'run-clean',
      terminalSuccess: true,
      controllerValidation: true,
    }).receipt!,
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

  assert.equal(metrics.loops.workflowRuns.total, 3, 'only terminal runs enter the loop-effectiveness denominator');
  assert.equal(metrics.loops.workflowRuns.clean, 1, 'a finished run with a goal gap is terminal but never clean');
  assert.ok(
    metrics.loops.issueCauses.some((cause) => /goal review still found a gap/.test(cause.label) || cause.examples.some((example) => /goal review still found a gap/.test(example))),
    `a goal gap is a visible loop cause: ${JSON.stringify(metrics.loops.issueCauses).slice(0, 600)}`,
  );
  assert.equal(metrics.loops.workflowRuns.needsAttention, 1, 'an expected non-terminal approval park is not an attention-needed outcome');
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
  // One retry across three terminal runs: the finished-with-a-gap run is a
  // terminal run like any other.
  assert.equal(metrics.loops.interventions.retryPressurePct, 33);
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
  assert.equal(
    metrics.loops.issueCauses.some((cause) => /parked on approval/i.test(cause.label)),
    false,
    'approval parking remains durable control flow but never becomes a learned failure cause',
  );
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

test('old team-agent errors and inbox items, hub-only rosters and unset routing rules are not reported as current risks', () => {
  // Live 10-02: an autonomy-loop error from 08-13 and four inbox items from
  // August held readiness at 21/100 for seven weeks, with peer comms counted
  // as missing for a roster whose agents only talk through the host and
  // intent routing counted as missing with no routing rules set. Clem then
  // reported all of it as current.
  const homeAgents = path.join(TMP_HOME, 'vault', '00-System', 'agents');
  rmSync(homeAgents, { recursive: true, force: true });
  rmSync(path.join(TMP_HOME, 'agents-state'), { recursive: true, force: true });
  rmSync(path.join(TMP_HOME, 'agents-inbox'), { recursive: true, force: true });
  rmSync(path.join(TMP_HOME, 'logs', 'team-comms.jsonl'), { force: true });
  const priorRoles = process.env.CLEMMY_MODEL_ROLES;
  delete process.env.CLEMMY_MODEL_ROLES;
  try {
    writeAgent('clementine', 'name: Clementine\ndescription: primary\nrole: orchestrator\ncanMessage:\n  - designer');
    writeAgent('designer', 'name: Designer\ndescription: designs\ncanMessage:\n  - clementine');
    writeAgent('auditor', 'name: Auditor\ndescription: audits\ncanMessage:\n  - clementine');
    const old = new Date(Date.now() - 50 * 24 * 60 * 60_000).toISOString();
    mkdirSync(path.join(TMP_HOME, 'agents-state'), { recursive: true });
    writeFileSync(path.join(TMP_HOME, 'agents-state', 'clementine.json'), JSON.stringify({
      slug: 'clementine', lastRunAt: old, lastWakeAt: old, lastError: 'Autonomy decision rejected: too many commitments',
    }), 'utf-8');
    mkdirSync(path.join(TMP_HOME, 'agents-inbox'), { recursive: true });
    writeFileSync(path.join(TMP_HOME, 'agents-inbox', 'clementine.json'), JSON.stringify([
      { id: 'i1', createdAt: old, status: 'pending', content: 'daily review' },
      { id: 'i2', createdAt: old, status: 'pending', content: 'uncommitted changes' },
    ]), 'utf-8');

    const stale = collectAgentSystemMetrics();
    assert.equal(stale.swarm.blockedAgents, 0, 'a 50-day-old error does not block an agent');
    assert.equal(stale.swarm.pendingInboxItems, 0, '50-day-old inbox items are not pending work');
    assert.equal(stale.swarm.effectiveness.intentRoutes, 0, 'no routing rules, so no intent can miss');
    assert.notEqual(stale.swarm.readiness.status, 'blocked');
    // What remains is only this home's current worker evidence.
    assert.deepEqual(stale.swarm.readiness.risks.filter((risk) => !/fanout cap rate/i.test(risk)), []);
    assert.ok(!stale.swarm.readiness.risks.some((risk) => /peer comms|blocked|inbox|intent routing/i.test(risk)),
      stale.swarm.readiness.risks.join(' | '));
    for (const id of ['swarm-enable-peer-comms', 'swarm-readiness-low', 'swarm-drain-inbox', 'swarm-intent-routing-miss', 'swarm-agent-scorecard-risk']) {
      assert.ok(!stale.recommendations.some((rec) => rec.id === id), id);
    }

    // The same signals, recent, still count.
    const now = new Date().toISOString();
    writeFileSync(path.join(TMP_HOME, 'agents-state', 'clementine.json'), JSON.stringify({
      slug: 'clementine', lastRunAt: now, lastError: 'tool auth expired',
    }), 'utf-8');
    writeFileSync(path.join(TMP_HOME, 'agents-inbox', 'clementine.json'), JSON.stringify([
      { id: 'i3', createdAt: now, status: 'pending', content: 'review the draft' },
    ]), 'utf-8');
    const current = collectAgentSystemMetrics();
    assert.equal(current.swarm.blockedAgents, 1);
    assert.equal(current.swarm.pendingInboxItems, 1);
    assert.ok(current.swarm.readiness.risks.some((risk) => /blocked/i.test(risk)));

    // An agent set to message another agent directly does need peer comms.
    writeAgent('designer', 'name: Designer\ndescription: designs\ncanMessage:\n  - auditor');
    const peers = collectAgentSystemMetrics();
    assert.ok(peers.swarm.readiness.risks.some((risk) => /peer comms/i.test(risk)));
    assert.ok(peers.recommendations.some((rec) => rec.id === 'swarm-enable-peer-comms'));
  } finally {
    if (priorRoles === undefined) delete process.env.CLEMMY_MODEL_ROLES;
    else process.env.CLEMMY_MODEL_ROLES = priorRoles;
  }
});
