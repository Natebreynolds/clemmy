import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AgentSystemMetrics,
  AgentSystemRecommendation,
  CoordinationPolicySnapshot,
} from '../dashboard/agent-system-metrics.js';
import {
  __setAgentSystemGuidanceCollectorForTests,
  renderAgentSystemGuidance,
} from './agent-system-guidance.js';
import { buildAgentContextPacket } from './harness/context-packet.js';
import { closeProspectiveIntentionsDbForTest } from './prospective-intentions.js';

const NO_MEMORY = { enabled: false, hitCount: 0, injected: false };
const recommendations: AgentSystemRecommendation[] = [
  {
    id: 'swarm-fixture', kind: 'swarm', severity: 'warn', title: 'Swarm fixture',
    detail: 'Current swarm state', action: 'Use bounded workers', target: 'agents',
    href: '/agents', cta: 'Inspect',
  },
  {
    id: 'loop-fixture', kind: 'loop', severity: 'critical', title: 'Loop fixture',
    detail: 'Current loop state', action: 'Inspect the failed run', target: 'workflows',
    href: '/workflows', cta: 'Inspect',
  },
];

function metricsFixture(overrides: Partial<CoordinationPolicySnapshot> = {}): AgentSystemMetrics {
  const coordination: CoordinationPolicySnapshot = {
    mode: 'bounded-fanout', status: 'expand', fanoutPosture: 'allow',
    recommendedWorkerWaveSize: 8, confidence: 80, reasons: [], guardrails: [],
    nextAction: 'Use bounded fanout for the current request', ...overrides,
  };
  // This deterministic collector fixture covers every field the renderer reads;
  // metric collection/derivation itself is outside these admission tests.
  return {
    recommendations,
    coordination,
    swarm: {
      readiness: { score: 80, status: 'ready' },
      topology: { kind: 'hub', densityPct: 50 },
      effectiveness: { capRatePct: 25, fanoutOffered: 3, policyDecisions: 4, fanoutBlockedByPolicy: 1 },
    },
    loops: {
      loopEffectivenessScore: 80,
      interventions: { score: 80, status: 'productive' },
      learning: { status: 'compounding', recallHitRatePct: 50 },
    },
    trend: { status: 'stable' },
  } as unknown as AgentSystemMetrics;
}

test.afterEach(() => __setAgentSystemGuidanceCollectorForTests(null));
test.after(() => closeProspectiveIntentionsDbForTest());

test('irrelevant single-item guidance never invokes or seeds the metrics collector', () => {
  let calls = 0;
  __setAgentSystemGuidanceCollectorForTests(() => {
    calls += 1;
    return metricsFixture();
  });
  for (const input of [
    'Compute the SHA256 of the literal HELLO.',
    'What is the capital of France?',
    'Run the existing workflow.',
    'Do not retry the failed workflow or delegate to another agent. Compute SHA256 of HELLO.',
  ]) {
    const result = renderAgentSystemGuidance(input, 'chat', { needsCoordinationPolicy: false });
    assert.deepEqual(result, {
      injected: false, recommendationCount: 0, recommendations: [], policy: null, summary: '', text: '',
    });
  }
  assert.equal(calls, 0);
  const relevant = renderAgentSystemGuidance('Use a specialist to review this response.', 'chat', {
    needsCoordinationPolicy: false,
  });
  assert.equal(calls, 1, 'irrelevant requests did not populate a cached empty snapshot');
  assert.deepEqual(relevant.recommendations.map((rec) => rec.kind), ['swarm']);
});

test('each existing recommendation family loads once without a fanout-policy requirement', () => {
  const cases: Array<[string, AgentSystemRecommendation['kind']]> = [
    ['Use a specialist to review this response.', 'swarm'],
    ['Debug the failed workflow run.', 'loop'],
  ];
  for (const [input, expectedKind] of cases) {
    let calls = 0;
    __setAgentSystemGuidanceCollectorForTests(() => {
      calls += 1;
      return metricsFixture();
    });
    const result = renderAgentSystemGuidance(input, 'agent', { needsCoordinationPolicy: false });
    assert.equal(calls, 1);
    assert.equal(result.injected, true);
    assert.deepEqual(result.recommendations.map((rec) => rec.kind), [expectedKind]);
    assert.equal(result.policy?.mode, 'bounded-fanout');
  }
});

test('an explicit policy need still collects for a batch with no recommendation vocabulary', () => {
  let calls = 0;
  __setAgentSystemGuidanceCollectorForTests(() => {
    calls += 1;
    return metricsFixture();
  });
  const result = renderAgentSystemGuidance('Research these 10 prospects.', 'chat', {
    needsCoordinationPolicy: true,
  });
  assert.equal(calls, 1);
  assert.equal(result.injected, false);
  assert.equal(result.recommendationCount, 0);
  assert.equal(result.policy?.fanoutPosture, 'allow');
  assert.equal(result.policy?.recommendedWorkerWaveSize, 8);
  assert.match(result.summary, /Swarm readiness 80\/100/);
});

test('standalone renderer preserves policy collection when the new option is omitted', () => {
  let calls = 0;
  __setAgentSystemGuidanceCollectorForTests(() => {
    calls += 1;
    return metricsFixture();
  });
  const result = renderAgentSystemGuidance('Compute the SHA256 of HELLO.', 'chat');
  assert.equal(calls, 1);
  assert.equal(result.injected, false);
  assert.equal(result.policy?.mode, 'bounded-fanout');
  assert.match(result.summary, /Swarm readiness 80\/100/);
});

test('relevant requests reuse the current snapshot once and refresh at the existing expiry', (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  __setAgentSystemGuidanceCollectorForTests(() => {
    calls += 1;
    return metricsFixture({ recommendedWorkerWaveSize: calls === 1 ? 2 : 6 });
  });
  const render = () => renderAgentSystemGuidance('Delegate this task to specialists.', 'chat', {
    needsCoordinationPolicy: false,
  });
  assert.equal(render().policy?.recommendedWorkerWaveSize, 2);
  assert.equal(calls, 1);
  now += 29_999;
  assert.equal(render().policy?.recommendedWorkerWaveSize, 2);
  assert.equal(calls, 1);
  now += 1;
  const fresh = render();
  assert.equal(calls, 2);
  assert.equal(fresh.policy?.recommendedWorkerWaveSize, 6);
  assert.match(fresh.text, /worker wave size 6/);
});

test('repair and learning policy remain scoped to the actual request after collection', () => {
  for (const mode of ['repair-loop', 'learning-loop'] as const) {
    let calls = 0;
    __setAgentSystemGuidanceCollectorForTests(() => {
      calls += 1;
      return metricsFixture({ mode, status: mode === 'repair-loop' ? 'repair' : 'learn', fanoutPosture: 'block' });
    });
    const batch = renderAgentSystemGuidance('Research these 10 prospects.', 'chat', {
      needsCoordinationPolicy: true,
    });
    assert.equal(calls, 1);
    assert.equal(batch.policy, null, 'another workflow loop cannot block unrelated batch work');
    const diagnostic = renderAgentSystemGuidance('Debug the failed workflow run.', 'chat', {
      needsCoordinationPolicy: false,
    });
    assert.equal(calls, 1, 'the diagnostic uses the same current cached snapshot');
    assert.equal(diagnostic.policy?.mode, mode);
    assert.equal(diagnostic.policy?.fanoutPosture, 'block');
    assert.deepEqual(diagnostic.recommendations.map((rec) => rec.kind), ['loop']);
  }
});

test('unsupported session kinds never load even when policy is requested', () => {
  let calls = 0;
  __setAgentSystemGuidanceCollectorForTests(() => {
    calls += 1;
    return metricsFixture();
  });
  for (const sessionKind of ['workflow', 'review', undefined]) {
    const result = renderAgentSystemGuidance('Review the failed workflow with agents.', sessionKind, {
      needsCoordinationPolicy: true,
    });
    assert.equal(result.policy, null);
    assert.equal(result.injected, false);
  }
  assert.equal(calls, 0);
});

test('context caller skips metrics for single work but retains policy for real fanout', () => {
  let calls = 0;
  __setAgentSystemGuidanceCollectorForTests(() => {
    calls += 1;
    return metricsFixture({ fanoutPosture: 'constrain', recommendedWorkerWaveSize: 2 });
  });
  const simple = buildAgentContextPacket('Compute the SHA256 of the literal HELLO.', NO_MEMORY, {
    sessionKind: 'chat', sessionId: 'guidance-single-work',
  });
  assert.equal(simple.multiItem.detected, false);
  assert.equal(simple.agentSystem.policy, null);
  assert.equal(calls, 0);
  const batch = buildAgentContextPacket('Research these 10 prospects.', NO_MEMORY, {
    sessionKind: 'chat', sessionId: 'guidance-batch-work',
  });
  assert.equal(batch.multiItem.detected, true);
  assert.equal(calls, 1);
  assert.equal(batch.agentSystem.policy?.fanoutPosture, 'constrain');
  assert.equal(batch.multiItem.blockedByPolicy, true);
  assert.equal(batch.multiItem.offered, false);
  assert.equal(batch.multiItem.recommendedWorkerWaveSize, 2);
});

test('context admission uses literal authority rather than retrieval text', () => {
  let calls = 0;
  __setAgentSystemGuidanceCollectorForTests(() => {
    calls += 1;
    return metricsFixture();
  });
  const unrelatedRetrieval = buildAgentContextPacket('Debug a failed workflow with a specialist.', NO_MEMORY, {
    sessionKind: 'chat', sessionId: 'guidance-authority-single',
    authorityInput: 'Compute the SHA256 of the literal HELLO.',
  });
  assert.equal(unrelatedRetrieval.multiItem.detected, false);
  assert.equal(unrelatedRetrieval.agentSystem.policy, null);
  assert.equal(calls, 0);
  const actualDiagnostic = buildAgentContextPacket('Compute the SHA256 of the literal HELLO.', NO_MEMORY, {
    sessionKind: 'chat', sessionId: 'guidance-authority-diagnostic',
    authorityInput: 'Debug the failed workflow run.',
  });
  assert.equal(calls, 1);
  assert.equal(actualDiagnostic.multiItem.detected, false);
  assert.equal(actualDiagnostic.agentSystem.injected, true);
  assert.match(actualDiagnostic.text, /loop\/critical/);
});
