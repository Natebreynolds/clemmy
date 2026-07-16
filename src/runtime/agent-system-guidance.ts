import {
  collectAgentSystemMetrics,
  type AgentSystemRecommendation,
  type AgentSystemMetrics,
  type CoordinationPolicySnapshot,
} from '../dashboard/agent-system-metrics.js';

export interface AgentSystemGuidance {
  injected: boolean;
  recommendationCount: number;
  recommendations: AgentSystemRecommendation[];
  policy: CoordinationPolicySnapshot | null;
  summary: string;
  text: string;
}

const CACHE_MS = 30_000;
let cachedAt = 0;
let cachedRecommendations: AgentSystemRecommendation[] = [];
let cachedPolicy: CoordinationPolicySnapshot | null = null;
let cachedSummary = '';

export function __resetAgentSystemGuidanceCacheForTests(): void {
  cachedAt = 0;
  cachedRecommendations = [];
  cachedPolicy = null;
  cachedSummary = '';
}

function guidanceAllowedForSession(kind?: string): boolean {
  return kind === 'chat' || kind === 'agent';
}

function severityRank(severity: AgentSystemRecommendation['severity']): number {
  switch (severity) {
    case 'critical': return 3;
    case 'warn': return 2;
    case 'info':
    default: return 1;
  }
}

function recommendationRelevantToInput(rec: AgentSystemRecommendation, input: string): boolean {
  const text = input.toLowerCase();
  if (rec.kind === 'swarm') {
    return /\b(agent|agents|swarm|delegate|delegation|review|debate|parallel|worker|fan[- ]?out|specialist|team)\b/.test(text);
  }
  return /\b(workflow|automation|automate|retry|replan|rerun|loop|schedule|foreach|for each|failed items?|run)\b/.test(text);
}

function renderMetricsSummary(metrics: AgentSystemMetrics): string {
  const swarm = metrics.swarm;
  const loops = metrics.loops;
  return [
    `Swarm readiness ${swarm.readiness.score}/100 (${swarm.readiness.status})`,
    `topology ${swarm.topology.kind} ${swarm.topology.densityPct}% density`,
    `fanout cap ${swarm.effectiveness.capRatePct}%`,
    `fanout policy ${swarm.effectiveness.fanoutOffered}/${swarm.effectiveness.policyDecisions} offered, ${swarm.effectiveness.fanoutBlockedByPolicy} blocked`,
    `loop effectiveness ${loops.loopEffectivenessScore}/100`,
    `interventions ${loops.interventions.score}/100 (${loops.interventions.status})`,
    `learning ${loops.learning.status} ${loops.learning.recallHitRatePct}% recall`,
    `trend ${metrics.trend.status}`,
    `mode ${metrics.coordination.mode} (${metrics.coordination.status})`,
  ].join('; ');
}

function loadGuidanceSnapshot(): {
  recommendations: AgentSystemRecommendation[];
  policy: CoordinationPolicySnapshot | null;
  summary: string;
} {
  const now = Date.now();
  if (now - cachedAt < CACHE_MS) {
    return { recommendations: cachedRecommendations, policy: cachedPolicy, summary: cachedSummary };
  }
  try {
    const metrics = collectAgentSystemMetrics();
    cachedRecommendations = metrics.recommendations ?? [];
    cachedPolicy = metrics.coordination ?? null;
    cachedSummary = renderMetricsSummary(metrics);
    cachedAt = now;
  } catch {
    cachedRecommendations = [];
    cachedPolicy = null;
    cachedSummary = '';
    cachedAt = now;
  }
  return { recommendations: cachedRecommendations, policy: cachedPolicy, summary: cachedSummary };
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}...`;
}

export function renderAgentSystemGuidance(input: string, sessionKind?: string): AgentSystemGuidance {
  if (!guidanceAllowedForSession(sessionKind)) {
    return { injected: false, recommendationCount: 0, recommendations: [], policy: null, summary: '', text: '' };
  }

  const { recommendations: all, policy, summary } = loadGuidanceSnapshot();
  const relevant = all.filter((rec) => recommendationRelevantToInput(rec, input));
  const selected = (relevant.length > 0 ? relevant : all)
    .slice()
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id))
    .slice(0, 3);

  if (selected.length === 0) {
    return { injected: false, recommendationCount: 0, recommendations: [], policy, summary, text: '' };
  }

  const lines = [
    '[AGENT SYSTEM GUIDANCE]',
    'Current swarm/workflow-loop signals. Use as run-shaping guidance only; the user request and explicit workflow instructions win.',
    summary ? `State: ${summary}.` : '',
    policy
      ? `Recommended mode: ${policy.mode} (${policy.status}, confidence ${policy.confidence}/100). Fanout posture: ${policy.fanoutPosture}; worker wave size ${policy.recommendedWorkerWaveSize}. ${clip(policy.nextAction, 180)}`
      : '',
    policy?.guardrails.length
      ? `Mode guardrails: ${policy.guardrails.slice(0, 2).map((guardrail) => clip(guardrail, 120)).join(' ')}`
      : '',
    ...selected.map((rec) =>
      `- ${rec.kind}/${rec.severity}: ${clip(rec.title, 90)} — ${clip(rec.action, 160)}`,
    ),
  ].filter(Boolean);

  return {
    injected: true,
    recommendationCount: selected.length,
    recommendations: selected,
    policy,
    summary,
    text: lines.join('\n'),
  };
}
