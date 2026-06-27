import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR, getRuntimeEnv } from '../config.js';
import { autonomyRunSlug, listAutonomyRuns } from '../agents/run-tracking.js';
import { peerCommsEnabled } from '../agents/agent-comms.js';
import { listSessions, listEvents, type EventRow } from '../runtime/harness/eventlog.js';
import { readWorkflowEvents, type WorkflowEvent } from '../execution/workflow-events.js';
import { listWorkflows } from '../memory/workflow-store.js';
import { listWorkflowPatterns } from '../memory/workflow-pattern-store.js';
import {
  AGENT_INBOX_DIR,
  AGENT_STATE_DIR,
  TEAM_COMMS_LOG,
  WORKFLOW_RUNS_DIR,
  loadTeamAgents,
} from '../tools/shared.js';

const TOOL_EVENTS_DIR = path.join(BASE_DIR, 'state', 'tool-events');
const AGENT_SYSTEM_TREND_FILE = path.join(BASE_DIR, 'state', 'agent-system-metrics-history.json');

interface RawWorkflowRunRecord {
  id?: string;
  workflow?: string;
  status?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  needsAttention?: boolean;
  error?: string;
  selfHealAttempt?: number;
  goalAttempt?: number;
  goalOutcome?: string;
  goalReason?: string;
}

interface TeamCommsRecord {
  id?: string;
  fromAgent?: string;
  toAgent?: string;
  timestamp?: string;
  protocol?: 'message' | 'request' | 'response';
  requestId?: string;
}

interface AgentStateSnapshot {
  slug?: string;
  lastRunAt?: string;
  lastSummary?: string;
  lastError?: string;
}

interface ToolEventRecord {
  at?: string;
  toolName?: string;
  phase?: string;
  outcome?: string;
  argsSummary?: string;
}

export interface AgentScorecard {
  slug: string;
  name: string;
  role: string | null;
  status: 'healthy' | 'watch' | 'blocked' | 'unproven';
  score: number;
  comms24h: { sent: number; received: number; requests: number; responses: number };
  pendingInbox: number;
  autonomyRuns: { total: number; completed: number; failed: number; active: number; successRatePct: number };
  lastRunAt: string | null;
  lastError: string | null;
  recommendation: string;
}

export type LoopIssueCauseSource = 'contract' | 'item' | 'step' | 'run' | 'goal';

export interface LoopIssueCause {
  key: string;
  label: string;
  count: number;
  sources: LoopIssueCauseSource[];
  examples: string[];
}

export interface SwarmEffectivenessSnapshot {
  sampleSessions: number;
  workerRoutes: number;
  workerCapped: number;
  capRatePct: number;
  policyDecisions: number;
  fanoutOffered: number;
  fanoutBlockedByPolicy: number;
  fanoutSuppressedByPolicyPct: number;
  averageRecommendedWaveSize: number | null;
  postureSpread: Array<{ posture: FanoutPosture | 'unknown'; count: number }>;
  intentRoutes: number;
  intentMatches: number;
  intentMatchRatePct: number;
  modelSpread: Array<{ modelId: string; count: number }>;
  providerSpread: Array<{ provider: string; count: number }>;
  transportSpread: Array<{ transport: string; count: number }>;
  recentCappedItems: string[];
  recommendation: string;
}

export type SwarmTopologyKind = 'none' | 'single' | 'isolated' | 'mesh' | 'hub-and-spoke' | 'partial';

export interface SwarmTopologySnapshot {
  kind: SwarmTopologyKind;
  agentCount: number;
  configuredEdges: number;
  possibleEdges: number;
  densityPct: number;
  reciprocalEdges: number;
  reciprocityPct: number;
  isolatedAgents: string[];
  unknownTargets: Array<{ from: string; to: string }>;
  hubAgents: Array<{ slug: string; outgoing: number; incoming: number; recentComms: number }>;
  recentRequests: number;
  recentResponses: number;
  requestResponsePct: number;
  recommendation: string;
}

export interface SwarmReadinessSnapshot {
  score: number;
  status: 'ready' | 'watch' | 'blocked' | 'unproven';
  strengths: string[];
  risks: string[];
  recommendation: string;
}

export interface LoopInterventionSnapshot {
  score: number;
  status: 'productive' | 'watch' | 'thrashing' | 'unproven';
  retryPressurePct: number;
  retryEvents: number;
  attemptRecords: number;
  selfHeal: { runs: number; clean: number; needsAttention: number; successRatePct: number };
  goalRepursuit: { runs: number; satisfied: number; escalated: number; successRatePct: number };
  forEachRecovery: { completed: number; failed: number; failureRatePct: number };
  strengths: string[];
  risks: string[];
  recommendation: string;
}

export interface WorkflowLearningSnapshot {
  status: 'compounding' | 'watch' | 'stale' | 'unproven';
  patternCount: number;
  totalCleanPatternRuns: number;
  recallHits: number;
  recallMisses: number;
  recallHitRatePct: number;
  remembers: number;
  recentRecallSamples: number;
  topPatterns: Array<{
    workflowName: string;
    workflowSlug: string;
    successCount: number;
    lastSuccessAt: string;
    toolCount: number;
    stepCount: number;
  }>;
  risks: string[];
  strengths: string[];
  recommendation: string;
}

export type CoordinationMode = 'single-orchestrator' | 'bounded-fanout' | 'review-swarm' | 'repair-loop' | 'learning-loop';
export type CoordinationStatus = 'expand' | 'watch' | 'constrain' | 'repair' | 'learn';
export type FanoutPosture = 'allow' | 'soft' | 'constrain' | 'block';

export interface CoordinationPolicySnapshot {
  mode: CoordinationMode;
  status: CoordinationStatus;
  fanoutPosture: FanoutPosture;
  recommendedWorkerWaveSize: number;
  confidence: number;
  reasons: string[];
  guardrails: string[];
  nextAction: string;
}

export interface AgentSystemTrendPoint {
  at: string;
  swarmReadinessScore: number;
  loopEffectivenessScore: number;
  interventionScore: number;
  workflowRecallHitRatePct: number;
  workerCapRatePct: number;
  blockedAgents: number;
  itemFailures: number;
}

export interface AgentSystemTrendSeriesPoint extends AgentSystemTrendPoint {
  healthScore: number;
}

export interface AgentSystemTrendSnapshot {
  status: 'improving' | 'stable' | 'regressing' | 'unproven';
  baselineAt: string | null;
  samples: number;
  recent: AgentSystemTrendSeriesPoint[];
  delta: {
    swarmReadinessScore: number;
    loopEffectivenessScore: number;
    interventionScore: number;
    workflowRecallHitRatePct: number;
    workerCapRatePct: number;
    blockedAgents: number;
    itemFailures: number;
  };
  signals: string[];
  recommendation: string;
}

export interface AgentSystemMetrics {
  generatedAt: string;
  coordination: CoordinationPolicySnapshot;
  trend: AgentSystemTrendSnapshot;
  swarm: {
    agentCount: number;
    v2OptInCount: number;
    peerCommsEnabled: boolean;
    comms24h: { total: number; requests: number; responses: number; messages: number };
    pendingInboxItems: number;
    blockedAgents: number;
    autonomyRuns: { total: number; completed: number; failed: number; active: number; successRatePct: number };
    workerSessions: number;
    workerRoutes: number;
    workerCapped: number;
    effectiveness: SwarmEffectivenessSnapshot;
    topology: SwarmTopologySnapshot;
    readiness: SwarmReadinessSnapshot;
    scorecards: AgentScorecard[];
    recommendation: string;
  };
  loops: {
    workflowRuns: { total: number; clean: number; needsAttention: number; failed: number; successRatePct: number };
    attemptRecords: number;
    retryEvents: number;
    selfHealRuns: number;
    goalRepursuits: number;
    goalSatisfied: number;
    goalEscalated: number;
    forEachItems: { completed: number; failed: number; failureRatePct: number };
    averageRunSeconds: number | null;
    loopEffectivenessScore: number;
    interventions: LoopInterventionSnapshot;
    learning: WorkflowLearningSnapshot;
    issueCauses: LoopIssueCause[];
    recommendation: string;
  };
  recentWarnings: Array<{ kind: 'swarm' | 'loop'; message: string }>;
  recommendations: AgentSystemRecommendation[];
}

export interface AgentSystemRecommendation {
  id: string;
  kind: 'swarm' | 'loop';
  severity: 'info' | 'warn' | 'critical';
  title: string;
  detail: string;
  action: string;
  target: 'agents' | 'workflows' | 'settings' | 'observability';
  href: string;
  cta: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readJsonl<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => {
        try { return JSON.parse(line) as T; } catch { return null; }
      })
      .filter((row): row is T => row !== null);
  } catch {
    return [];
  }
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function hourKey(iso: string): string {
  return iso.slice(0, 13);
}

function readRecentWorkflowPatternEvents(days = 7): ToolEventRecord[] {
  if (!existsSync(TOOL_EVENTS_DIR)) return [];
  const cutoff = Date.now() - Math.max(1, days) * 24 * 60 * 60_000;
  const keys = Array.from({ length: Math.max(1, days + 1) }, (_, index) => dayKey(new Date(Date.now() - index * 24 * 60 * 60_000)));
  const events: ToolEventRecord[] = [];
  for (const key of keys) {
    const filePath = path.join(TOOL_EVENTS_DIR, `${key}.ndjson`);
    for (const row of readJsonl<ToolEventRecord>(filePath)) {
      if (row.toolName !== 'workflow_pattern') continue;
      const t = Date.parse(row.at ?? '');
      if (!Number.isFinite(t) || t < cutoff) continue;
      events.push(row);
    }
  }
  return events;
}

function workflowPatternAction(event: ToolEventRecord): string | null {
  const summary = event.argsSummary ?? '';
  const match = /\baction=([a-z_]+)/i.exec(summary);
  return match?.[1]?.toLowerCase() ?? null;
}

function recentSince(hours: number): number {
  return Date.now() - hours * 60 * 60_000;
}

function countPendingInboxItems(): number {
  if (!existsSync(AGENT_INBOX_DIR)) return 0;
  let total = 0;
  for (const file of readdirSync(AGENT_INBOX_DIR).filter((entry) => entry.endsWith('.json'))) {
    const rows = readJsonFile<Array<{ status?: string }>>(path.join(AGENT_INBOX_DIR, file));
    if (!Array.isArray(rows)) continue;
    total += rows.filter((row) => row.status === 'pending').length;
  }
  return total;
}

function countPendingInboxForAgent(slug: string): number {
  const rows = readJsonFile<Array<{ status?: string }>>(path.join(AGENT_INBOX_DIR, `${slug}.json`));
  if (!Array.isArray(rows)) return 0;
  return rows.filter((row) => row.status === 'pending').length;
}

function loadAgentState(slug: string): AgentStateSnapshot | null {
  return readJsonFile<AgentStateSnapshot>(path.join(AGENT_STATE_DIR, `${slug}.json`));
}

function countBlockedAgents(): number {
  if (!existsSync(AGENT_STATE_DIR)) return 0;
  let total = 0;
  for (const file of readdirSync(AGENT_STATE_DIR).filter((entry) => entry.endsWith('.json'))) {
    const row = readJsonFile<{ lastError?: string }>(path.join(AGENT_STATE_DIR, file));
    if (row?.lastError) total += 1;
  }
  return total;
}

function readRecentComms(): TeamCommsRecord[] {
  const cutoff = recentSince(24);
  return readJsonl<TeamCommsRecord>(TEAM_COMMS_LOG).filter((row) => {
    const t = Date.parse(row.timestamp ?? '');
    return !Number.isFinite(t) || t >= cutoff;
  });
}

function latestIso(values: Array<string | undefined | null>): string | null {
  const sorted = values
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort((left, right) => right.localeCompare(left));
  return sorted[0] ?? null;
}

function v2OptInCount(): number {
  return (getRuntimeEnv('AUTONOMY_V2_AGENTS', '') || '')
    .split(',')
    .map((slug) => slug.trim())
    .filter(Boolean)
    .length;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function incrementCounter(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topCounts(map: Map<string, number>, keyName: 'modelId' | 'provider' | 'transport'): Array<Record<typeof keyName, string> & { count: number }> {
  return Array.from(map.entries())
    .map(([key, count]) => ({ [keyName]: key, count }) as Record<typeof keyName, string> & { count: number })
    .sort((left, right) => right.count - left.count || String(left[keyName]).localeCompare(String(right[keyName])))
    .slice(0, 8);
}

function topFanoutPostures(map: Map<string, number>): Array<{ posture: FanoutPosture | 'unknown'; count: number }> {
  return Array.from(map.entries())
    .map(([posture, count]) => ({ posture: posture as FanoutPosture | 'unknown', count }))
    .sort((left, right) => right.count - left.count || left.posture.localeCompare(right.posture))
    .slice(0, 8);
}

function swarmEffectivenessRecommendation(input: {
  workerRoutes: number;
  workerCapped: number;
  capRatePct: number;
  policyDecisions: number;
  fanoutBlockedByPolicy: number;
  fanoutSuppressedByPolicyPct: number;
  intentRoutes: number;
  intentMatchRatePct: number;
  modelSpreadSize: number;
}): string {
  if (input.workerRoutes === 0 && input.workerCapped === 0 && input.policyDecisions === 0) {
    return 'No worker fanout samples yet; run an itemized or review-style task before tuning swarm policy.';
  }
  if (input.capRatePct >= 20) {
    return 'Worker fanout is hitting turn caps; split large packets or raise worker turn budget before increasing concurrency.';
  }
  if (input.fanoutBlockedByPolicy > 0) {
    return `Fanout policy is actively constraining multi-item work (${input.fanoutSuppressedByPolicyPct}% blocked); inspect whether those blocked turns were repair/loop risks or missed parallelism.`;
  }
  if (input.intentRoutes >= 2 && input.intentMatchRatePct < 50) {
    return 'Intent routing is being requested but rarely matches; tighten intent labels or add model-role rules for common work types.';
  }
  if (input.modelSpreadSize > 1) {
    return 'Fanout routing is diversified and stable; keep using workers for independent item work and monitor cap rate.';
  }
  return 'Fanout substrate has usable signal; add more routed worker samples before changing swarm defaults.';
}

function collectWorkerHarnessStats(): {
  workerSessions: number;
  workerRoutes: number;
  workerCapped: number;
  effectiveness: SwarmEffectivenessSnapshot;
} {
  const sessions = listSessions({ kind: ['agent', 'workflow', 'chat'], limit: 300 });
  let workerRoutes = 0;
  let workerCapped = 0;
  let workerSessions = 0;
  let intentRoutes = 0;
  let intentMatches = 0;
  let policyDecisions = 0;
  let fanoutOffered = 0;
  let fanoutBlockedByPolicy = 0;
  let waveSizeSum = 0;
  let waveSizeSamples = 0;
  const modelCounts = new Map<string, number>();
  const providerCounts = new Map<string, number>();
  const transportCounts = new Map<string, number>();
  const postureCounts = new Map<string, number>();
  const recentCappedItems: string[] = [];

  function scanRoute(event: EventRow): void {
    workerRoutes += 1;
    incrementCounter(modelCounts, stringValue(event.data.modelId) ?? 'unknown');
    incrementCounter(providerCounts, stringValue(event.data.provider) ?? 'unknown');
    incrementCounter(transportCounts, stringValue(event.data.transport) ?? 'unknown');
    if (stringValue(event.data.attemptedIntent)) intentRoutes += 1;
    if (stringValue(event.data.matchedIntent)) intentMatches += 1;
  }

  function scanCap(event: EventRow): void {
    workerCapped += 1;
    const item = stringValue(event.data.item);
    if (item && recentCappedItems.length < 5) recentCappedItems.push(item);
  }

  function scanPolicyDecision(event: EventRow): void {
    policyDecisions += 1;
    if (event.data.offered === true) fanoutOffered += 1;
    if (event.data.blockedByPolicy === true) fanoutBlockedByPolicy += 1;
    incrementCounter(postureCounts, stringValue(event.data.fanoutPosture) ?? 'unknown');
    const waveSize = numberValue(event.data.recommendedWorkerWaveSize);
    if (waveSize !== null) {
      waveSizeSum += waveSize;
      waveSizeSamples += 1;
    }
  }

  for (const session of sessions) {
    const events = listEvents(session.id, {
      types: ['worker_model_routed', 'worker_capped', 'fanout_policy_decision'],
      limit: 200,
      desc: true,
    });
    if (events.length > 0) workerSessions += 1;
    for (const event of events) {
      if (event.type === 'worker_model_routed') scanRoute(event);
      if (event.type === 'worker_capped') scanCap(event);
      if (event.type === 'fanout_policy_decision') scanPolicyDecision(event);
    }
  }

  const capRatePct = pct(workerCapped, Math.max(workerRoutes, workerCapped));
  const intentMatchRatePct = pct(intentMatches, intentRoutes);
  const fanoutSuppressedByPolicyPct = pct(fanoutBlockedByPolicy, policyDecisions);
  const modelSpread = topCounts(modelCounts, 'modelId') as Array<{ modelId: string; count: number }>;
  const effectiveness: SwarmEffectivenessSnapshot = {
    sampleSessions: workerSessions,
    workerRoutes,
    workerCapped,
    capRatePct,
    policyDecisions,
    fanoutOffered,
    fanoutBlockedByPolicy,
    fanoutSuppressedByPolicyPct,
    averageRecommendedWaveSize: waveSizeSamples > 0 ? Math.round((waveSizeSum / waveSizeSamples) * 10) / 10 : null,
    postureSpread: topFanoutPostures(postureCounts),
    intentRoutes,
    intentMatches,
    intentMatchRatePct,
    modelSpread,
    providerSpread: topCounts(providerCounts, 'provider') as Array<{ provider: string; count: number }>,
    transportSpread: topCounts(transportCounts, 'transport') as Array<{ transport: string; count: number }>,
    recentCappedItems,
    recommendation: swarmEffectivenessRecommendation({
      workerRoutes,
      workerCapped,
      capRatePct,
      policyDecisions,
      fanoutBlockedByPolicy,
      fanoutSuppressedByPolicyPct,
      intentRoutes,
      intentMatchRatePct,
      modelSpreadSize: modelSpread.length,
    }),
  };
  return { workerSessions, workerRoutes, workerCapped, effectiveness };
}

function topologyRecommendation(input: SwarmTopologySnapshot): string {
  if (input.agentCount === 0) return 'Create specialist agents before tuning swarm topology.';
  if (input.agentCount === 1) return 'Add one specialist reviewer or researcher before expecting swarm coordination.';
  if (input.unknownTargets.length > 0) return 'Fix canMessage targets that point at missing agents before relying on delegation.';
  if (input.isolatedAgents.length > 0) return 'Connect isolated agents to the orchestrator or their reviewer before assigning swarm work.';
  if (input.requestResponsePct < 50 && input.recentRequests >= 2) return 'Requests are not receiving enough responses; review inbox load and agent wake cadence.';
  if (input.kind === 'mesh') return 'Topology is mesh-like; use it for review, consensus, and independent specialist debate.';
  if (input.kind === 'hub-and-spoke') return 'Topology is hub-and-spoke; keep the hub load bounded or add peer reviewer links for complex tasks.';
  return 'Topology is partially connected; add deliberate review/delegation edges for the highest-value specialist pairs.';
}

function collectSwarmTopology(input: {
  agents: ReturnType<typeof loadTeamAgents>;
  comms: TeamCommsRecord[];
}): SwarmTopologySnapshot {
  const agentSlugs = new Set(input.agents.map((agent) => agent.slug));
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  const recentComms = new Map<string, number>();
  const validEdges = new Set<string>();
  const unknownTargets: Array<{ from: string; to: string }> = [];

  for (const agent of input.agents) {
    outgoing.set(agent.slug, 0);
    incoming.set(agent.slug, 0);
    recentComms.set(agent.slug, 0);
  }

  for (const agent of input.agents) {
    const uniqueTargets = new Set(agent.canMessage.filter((target) => target && target !== agent.slug));
    for (const target of uniqueTargets) {
      if (!agentSlugs.has(target)) {
        unknownTargets.push({ from: agent.slug, to: target });
        continue;
      }
      const edge = `${agent.slug}->${target}`;
      if (validEdges.has(edge)) continue;
      validEdges.add(edge);
      outgoing.set(agent.slug, (outgoing.get(agent.slug) ?? 0) + 1);
      incoming.set(target, (incoming.get(target) ?? 0) + 1);
    }
  }

  for (const row of input.comms) {
    if (row.fromAgent && recentComms.has(row.fromAgent)) recentComms.set(row.fromAgent, (recentComms.get(row.fromAgent) ?? 0) + 1);
    if (row.toAgent && recentComms.has(row.toAgent)) recentComms.set(row.toAgent, (recentComms.get(row.toAgent) ?? 0) + 1);
  }

  const reciprocalEdges = Array.from(validEdges).filter((edge) => {
    const [from, to] = edge.split('->');
    return validEdges.has(`${to}->${from}`);
  }).length;
  const agentCount = input.agents.length;
  const possibleEdges = Math.max(0, agentCount * Math.max(0, agentCount - 1));
  const isolatedAgents = input.agents
    .filter((agent) => (outgoing.get(agent.slug) ?? 0) === 0 && (incoming.get(agent.slug) ?? 0) === 0)
    .map((agent) => agent.slug);
  const maxDegree = Math.max(0, ...input.agents.map((agent) => (outgoing.get(agent.slug) ?? 0) + (incoming.get(agent.slug) ?? 0)));
  const hubThreshold = agentCount <= 2 ? 2 : Math.max(3, Math.ceil((agentCount - 1) * 0.75));
  const hubAgents = input.agents
    .map((agent) => ({
      slug: agent.slug,
      outgoing: outgoing.get(agent.slug) ?? 0,
      incoming: incoming.get(agent.slug) ?? 0,
      recentComms: recentComms.get(agent.slug) ?? 0,
    }))
    .filter((row) => row.outgoing + row.incoming >= hubThreshold || row.outgoing + row.incoming === maxDegree && maxDegree >= hubThreshold)
    .sort((left, right) => (right.outgoing + right.incoming + right.recentComms) - (left.outgoing + left.incoming + left.recentComms) || left.slug.localeCompare(right.slug))
    .slice(0, 4);
  const densityPct = pct(validEdges.size, possibleEdges);
  const reciprocityPct = pct(reciprocalEdges, validEdges.size);
  const recentRequests = input.comms.filter((row) => row.protocol === 'request').length;
  const recentResponses = input.comms.filter((row) => row.protocol === 'response').length;
  const requestResponsePct = pct(recentResponses, recentRequests);

  let kind: SwarmTopologyKind = 'partial';
  if (agentCount === 0) kind = 'none';
  else if (agentCount === 1) kind = 'single';
  else if (isolatedAgents.length > 0) kind = 'isolated';
  else if (densityPct >= 70 && reciprocityPct >= 70) kind = 'mesh';
  else if (hubAgents.length > 0 && densityPct < 70) kind = 'hub-and-spoke';

  const snapshot: SwarmTopologySnapshot = {
    kind,
    agentCount,
    configuredEdges: validEdges.size,
    possibleEdges,
    densityPct,
    reciprocalEdges,
    reciprocityPct,
    isolatedAgents,
    unknownTargets: unknownTargets.slice(0, 8),
    hubAgents,
    recentRequests,
    recentResponses,
    requestResponsePct,
    recommendation: '',
  };
  return { ...snapshot, recommendation: topologyRecommendation(snapshot) };
}

function collectSwarmReadiness(input: {
  agents: ReturnType<typeof loadTeamAgents>;
  peerComms: boolean;
  pendingInboxItems: number;
  blockedAgents: number;
  topology: SwarmTopologySnapshot;
  effectiveness: SwarmEffectivenessSnapshot;
  scorecards: AgentScorecard[];
  comms24h: number;
}): SwarmReadinessSnapshot {
  const risks: string[] = [];
  const strengths: string[] = [];
  if (input.agents.length === 0) {
    return {
      score: 0,
      status: 'unproven',
      strengths: [],
      risks: ['No team agents are configured.'],
      recommendation: 'Create one narrow specialist and establish a baseline before expecting swarm behavior.',
    };
  }

  let score = input.agents.length === 1 ? 45 : 72;
  if (input.agents.length === 1) {
    risks.push('Only one team agent exists, so collaboration is unproven.');
  } else {
    strengths.push(`${input.agents.length} team agents configured.`);
  }

  if (input.peerComms) {
    strengths.push('Peer comms are enabled.');
  } else if (input.agents.length > 1) {
    score -= 16;
    risks.push('Peer comms are disabled for a multi-agent roster.');
  }

  if (input.blockedAgents > 0) {
    score -= Math.min(24, input.blockedAgents * 12);
    risks.push(`${input.blockedAgents} agent${input.blockedAgents === 1 ? ' is' : 's are'} blocked.`);
  } else {
    strengths.push('No blocked agents detected.');
  }

  if (input.pendingInboxItems > 0) {
    score -= Math.min(12, input.pendingInboxItems * 3);
    risks.push(`${input.pendingInboxItems} pending inbox item${input.pendingInboxItems === 1 ? '' : 's'} need attention.`);
  }

  if (input.topology.unknownTargets.length > 0) {
    score -= Math.min(24, input.topology.unknownTargets.length * 12);
    risks.push(`${input.topology.unknownTargets.length} message edge${input.topology.unknownTargets.length === 1 ? '' : 's'} point to missing agents.`);
  } else if (input.topology.kind === 'mesh') {
    score += 10;
    strengths.push('Message topology is mesh-like.');
  } else if (input.topology.kind === 'hub-and-spoke') {
    score += 3;
    strengths.push('Message topology has a clear hub.');
  }

  if (input.topology.isolatedAgents.length > 0) {
    score -= Math.min(16, input.topology.isolatedAgents.length * 8);
    risks.push(`${input.topology.isolatedAgents.length} agent${input.topology.isolatedAgents.length === 1 ? ' is' : 's are'} isolated.`);
  }

  if (input.topology.recentRequests >= 2 && input.topology.requestResponsePct < 50) {
    score -= 12;
    risks.push('Recent agent requests are not receiving enough responses.');
  } else if (input.topology.recentRequests > 0 && input.topology.requestResponsePct >= 80) {
    score += 4;
    strengths.push('Recent request/response activity is balanced.');
  }

  if (input.effectiveness.workerRoutes === 0) {
    score -= input.agents.length > 1 ? 4 : 0;
    risks.push('No recent worker fanout samples exist.');
  } else if (input.effectiveness.capRatePct >= 20) {
    score -= Math.min(20, Math.ceil(input.effectiveness.capRatePct / 2));
    risks.push(`Worker fanout cap rate is ${input.effectiveness.capRatePct}%.`);
  } else {
    score += 6;
    strengths.push('Worker fanout is not hitting caps heavily.');
  }

  if (input.effectiveness.intentRoutes >= 2 && input.effectiveness.intentMatchRatePct < 50) {
    score -= 8;
    risks.push('Worker intent routing is missing common task types.');
  } else if (input.effectiveness.intentRoutes >= 2) {
    score += 3;
    strengths.push('Worker intent routing has usable match data.');
  }

  const provenScorecards = input.scorecards.filter((scorecard) => scorecard.status !== 'unproven');
  const weakest = input.scorecards[0];
  if (weakest && weakest.status === 'blocked') {
    score -= 12;
    risks.push(`${weakest.name} is the weakest scorecard and is blocked.`);
  } else if (weakest && weakest.score < 60) {
    score -= 8;
    risks.push(`${weakest.name} is the weakest scorecard at ${weakest.score}/100.`);
  }
  if (provenScorecards.length >= Math.min(2, input.agents.length)) {
    score += 4;
    strengths.push('Agent scorecards have runtime evidence.');
  }

  if (input.agents.length > 1 && input.peerComms && input.comms24h === 0) {
    score -= 6;
    risks.push('Agents are configured for collaboration but have no recent comms.');
  }

  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  const status: SwarmReadinessSnapshot['status'] =
    finalScore >= 80 ? 'ready'
      : finalScore >= 60 ? 'watch'
        : risks.some((risk) => /blocked|missing agents|disabled/.test(risk.toLowerCase())) ? 'blocked'
          : 'unproven';
  const recommendation =
    status === 'ready'
      ? 'Use the swarm for bounded review, delegation, and fanout tasks; keep monitoring caps and response balance.'
      : status === 'watch'
        ? 'Use the swarm for bounded work, but resolve the top risk before widening concurrency or autonomy.'
        : status === 'blocked'
          ? 'Fix blocked agents, broken message links, or disabled peer comms before relying on swarm autonomy.'
          : 'Run a small specialist task to establish evidence before treating the roster as a working swarm.';

  return {
    score: finalScore,
    status,
    strengths: strengths.slice(0, 5),
    risks: risks.slice(0, 5),
    recommendation,
  };
}

function scorecardStatus(input: {
  blocked: boolean;
  score: number;
  evidenceCount: number;
}): AgentScorecard['status'] {
  if (input.blocked) return 'blocked';
  if (input.evidenceCount === 0) return 'unproven';
  if (input.score >= 80) return 'healthy';
  return 'watch';
}

function scorecardRecommendation(input: {
  name: string;
  blocked: boolean;
  pendingInbox: number;
  totalRuns: number;
  failedRuns: number;
  completedRuns: number;
  commsTotal: number;
  canMessageCount: number;
}): string {
  if (input.blocked) return `Resolve ${input.name}'s last error before assigning more work.`;
  if (input.pendingInbox > 0) return `Drain ${input.name}'s pending inbox before expanding swarm fanout.`;
  if (input.totalRuns > 0 && input.failedRuns > input.completedRuns) return `Inspect ${input.name}'s failed autonomy runs and narrow its tool/workflow surface.`;
  if (input.commsTotal === 0 && input.canMessageCount > 0) return `Exercise ${input.name}'s message path with a small review or delegation task.`;
  if (input.totalRuns === 0) return `Run one small autonomy cycle for ${input.name} to establish a baseline.`;
  return `Keep ${input.name}'s current role; use it for bounded specialist work.`;
}

function collectAgentScorecards(input: {
  agents: ReturnType<typeof loadTeamAgents>;
  comms: TeamCommsRecord[];
  autonomy: ReturnType<typeof listAutonomyRuns>;
}): AgentScorecard[] {
  const runsBySlug = new Map<string, ReturnType<typeof listAutonomyRuns>>();
  for (const run of input.autonomy) {
    const slug = autonomyRunSlug(run);
    if (!slug) continue;
    const bucket = runsBySlug.get(slug) ?? [];
    bucket.push(run);
    runsBySlug.set(slug, bucket);
  }

  return input.agents.map((agent) => {
    const state = loadAgentState(agent.slug);
    const pendingInbox = countPendingInboxForAgent(agent.slug);
    const runs = runsBySlug.get(agent.slug) ?? [];
    const completed = runs.filter((run) => run.status === 'completed').length;
    const failed = runs.filter((run) => run.status === 'failed' || run.needsAttention).length;
    const active = runs.filter((run) => run.status === 'running' || run.status === 'queued' || run.status === 'received').length;
    const sent = input.comms.filter((row) => row.fromAgent === agent.slug).length;
    const received = input.comms.filter((row) => row.toAgent === agent.slug).length;
    const requests = input.comms.filter((row) => row.fromAgent === agent.slug && row.protocol === 'request').length;
    const responses = input.comms.filter((row) => row.fromAgent === agent.slug && row.protocol === 'response').length;
    const blocked = Boolean(state?.lastError);
    const commsTotal = sent + received;

    let score = 70;
    if (blocked) score -= 35;
    score -= Math.min(20, pendingInbox * 5);
    if (runs.length > 0) {
      score += Math.min(15, completed * 5);
      score -= Math.min(25, failed * 10);
    }
    if (active > 0) score += 5;
    if (commsTotal > 0) score += 10;
    if (commsTotal === 0 && agent.canMessage.length > 0) score -= 5;
    score = Math.max(0, Math.min(100, Math.round(score)));

    const evidenceCount = runs.length + commsTotal + pendingInbox + (state?.lastRunAt ? 1 : 0) + (state?.lastError ? 1 : 0);
    return {
      slug: agent.slug,
      name: agent.name,
      role: agent.role ?? null,
      status: scorecardStatus({ blocked, score, evidenceCount }),
      score,
      comms24h: { sent, received, requests, responses },
      pendingInbox,
      autonomyRuns: {
        total: runs.length,
        completed,
        failed,
        active,
        successRatePct: pct(completed, completed + failed),
      },
      lastRunAt: latestIso([state?.lastRunAt, ...runs.map((run) => run.completedAt ?? run.updatedAt ?? run.createdAt)]),
      lastError: state?.lastError ?? null,
      recommendation: scorecardRecommendation({
        name: agent.name,
        blocked,
        pendingInbox,
        totalRuns: runs.length,
        failedRuns: failed,
        completedRuns: completed,
        commsTotal,
        canMessageCount: agent.canMessage.length,
      }),
    };
  }).sort((left, right) => left.score - right.score || left.slug.localeCompare(right.slug));
}

function readWorkflowRunRecords(limit = 120): RawWorkflowRunRecord[] {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return [];
  return readdirSync(WORKFLOW_RUNS_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => readJsonFile<RawWorkflowRunRecord>(path.join(WORKFLOW_RUNS_DIR, entry)))
    .filter((row): row is RawWorkflowRunRecord => !!row && typeof row.id === 'string')
    .sort((left, right) => String(right.finishedAt ?? right.startedAt ?? right.createdAt ?? '').localeCompare(String(left.finishedAt ?? left.startedAt ?? left.createdAt ?? '')))
    .slice(0, limit);
}

function workflowEventLogNames(): Map<string, string[]> {
  const byRunName = new Map<string, string[]>();
  try {
    for (const workflow of listWorkflows()) {
      const names = Array.from(new Set([workflow.name, workflow.data.name].filter(Boolean)));
      for (const name of names) byRunName.set(name, names);
    }
  } catch {
    // Best-effort resolver; callers fall back to the run's stored workflow.
  }
  return byRunName;
}

function readWorkflowRunEvents(
  workflowName: string,
  runId: string,
  aliases: Map<string, string[]>,
): WorkflowEvent[] {
  const candidates = aliases.get(workflowName) ?? [workflowName];
  for (const candidate of candidates) {
    try {
      const events = readWorkflowEvents(candidate, runId);
      if (events.length > 0) return events;
    } catch {
      // Try the next alias.
    }
  }
  return [];
}

function runDurationSeconds(run: RawWorkflowRunRecord): number | null {
  const start = Date.parse(run.startedAt ?? run.createdAt ?? '');
  const finish = Date.parse(run.finishedAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return null;
  return Math.round((finish - start) / 1000);
}

function workflowRunClean(run: RawWorkflowRunRecord): boolean {
  return run.status === 'completed' && !run.needsAttention && !run.goalOutcome?.includes('repursue');
}

function normalizeCause(raw: string): { key: string; label: string } | null {
  const label = raw.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!label) return null;
  const lower = label.toLowerCase();
  if (lower.includes('min_items') || /minimum items|too few items|min items/.test(lower)) {
    return { key: 'too-few-items', label: 'Too few items returned' };
  }
  if (lower.includes('missing email') || lower.includes('email required')) {
    return { key: 'missing-email', label: 'Missing email' };
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return { key: 'timeout', label: 'Timeout' };
  }
  if (lower.includes('unauthorized') || lower.includes('auth') || lower.includes('permission')) {
    return { key: 'auth-permission', label: 'Authentication or permission failure' };
  }
  const key = lower
    .replace(/https?:\/\/\S+/g, 'url')
    .replace(/['"`][^'"`]+['"`]/g, 'value')
    .replace(/\b\d+\b/g, 'n')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72);
  return { key: key || 'unknown-loop-issue', label };
}

function addLoopCause(
  causes: Map<string, { label: string; count: number; sources: Set<LoopIssueCauseSource>; examples: Set<string> }>,
  source: LoopIssueCauseSource,
  raw: unknown,
  example: string,
): void {
  if (typeof raw !== 'string') return;
  const normalized = normalizeCause(raw);
  if (!normalized) return;
  const bucket = causes.get(normalized.key) ?? {
    label: normalized.label,
    count: 0,
    sources: new Set<LoopIssueCauseSource>(),
    examples: new Set<string>(),
  };
  bucket.count += 1;
  bucket.sources.add(source);
  if (bucket.examples.size < 3) bucket.examples.add(example.slice(0, 180));
  causes.set(normalized.key, bucket);
}

function finalizeLoopCauses(
  causes: Map<string, { label: string; count: number; sources: Set<LoopIssueCauseSource>; examples: Set<string> }>,
): LoopIssueCause[] {
  return Array.from(causes.entries())
    .map(([key, value]) => ({
      key,
      label: value.label,
      count: value.count,
      sources: Array.from(value.sources).sort(),
      examples: Array.from(value.examples),
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, 8);
}

function scanWorkflowEvents(records: RawWorkflowRunRecord[]): {
  attemptRecords: number;
  retryEvents: number;
  itemCompleted: number;
  itemFailed: number;
  issueCauses: LoopIssueCause[];
} {
  let attemptRecords = 0;
  let retryEvents = 0;
  let itemCompleted = 0;
  let itemFailed = 0;
  const aliases = workflowEventLogNames();
  const causes = new Map<string, { label: string; count: number; sources: Set<LoopIssueCauseSource>; examples: Set<string> }>();
  for (const run of records) {
    if (!run.workflow || !run.id) continue;
    if (run.error) addLoopCause(causes, 'run', run.error, `${run.workflow}/${run.id}: ${run.error}`);
    if ((run.goalOutcome === 'escalate' || run.goalOutcome === 'repursue') && run.goalReason) {
      addLoopCause(causes, 'goal', run.goalReason, `${run.workflow}/${run.id}: ${run.goalReason}`);
    }
    const events = readWorkflowRunEvents(run.workflow, run.id, aliases);
    for (const event of events) {
      if (event.kind === 'attempt_record') {
        attemptRecords += 1;
        for (const problem of event.attempt?.failedProblems ?? []) {
          addLoopCause(causes, 'contract', problem, `${run.workflow}/${run.id}/${event.stepId ?? 'step'}: ${problem}`);
        }
      }
      if (event.kind === 'step_retry' || event.kind === 'step_loop_retry') retryEvents += 1;
      if (event.kind === 'item_completed') itemCompleted += 1;
      if (event.kind === 'item_failed') {
        itemFailed += 1;
        addLoopCause(causes, 'item', event.error, `${run.workflow}/${run.id}/${event.stepId ?? 'step'}:${event.itemKey ?? 'item'}: ${event.error ?? 'item failed'}`);
      }
      if (event.kind === 'step_failed') {
        addLoopCause(causes, 'step', event.error, `${run.workflow}/${run.id}/${event.stepId ?? 'step'}: ${event.error ?? 'step failed'}`);
      }
    }
  }
  return { attemptRecords, retryEvents, itemCompleted, itemFailed, issueCauses: finalizeLoopCauses(causes) };
}

function loopScore(input: {
  clean: number;
  total: number;
  failed: number;
  needsAttention: number;
  retryEvents: number;
  attemptRecords: number;
  itemFailed: number;
  itemCompleted: number;
  goalSatisfied: number;
  goalEscalated: number;
}): number {
  if (input.total === 0) return 100;
  let score = pct(input.clean, input.total);
  score += Math.min(12, input.goalSatisfied * 4);
  score -= Math.min(20, input.failed * 7);
  score -= Math.min(18, input.needsAttention * 5);
  score -= Math.min(14, input.retryEvents * 2);
  score -= Math.min(10, Math.max(0, input.attemptRecords - input.goalSatisfied) * 1);
  score -= Math.min(16, pct(input.itemFailed, input.itemCompleted + input.itemFailed) / 4);
  score -= Math.min(12, input.goalEscalated * 6);
  return Math.max(0, Math.min(100, Math.round(score)));
}

function collectLoopInterventions(input: {
  records: RawWorkflowRunRecord[];
  terminalRuns: number;
  cleanRuns: number;
  retryEvents: number;
  attemptRecords: number;
  itemCompleted: number;
  itemFailed: number;
  loopEffectivenessScore: number;
}): LoopInterventionSnapshot {
  const selfHealRuns = input.records.filter((run) => (run.selfHealAttempt ?? 0) > 0);
  const selfHealClean = selfHealRuns.filter(workflowRunClean).length;
  const selfHealNeedsAttention = selfHealRuns.filter((run) =>
    run.needsAttention || run.status === 'completed_with_errors' || run.status === 'error' || run.status === 'cancelled',
  ).length;
  const goalRepursuits = input.records.filter((run) => (run.goalAttempt ?? 0) > 0 || run.goalOutcome === 'repursue');
  const goalSatisfied = goalRepursuits.filter((run) => run.goalOutcome === 'satisfied' && workflowRunClean(run)).length;
  const goalEscalated = goalRepursuits.filter((run) => run.goalOutcome === 'escalate').length;
  const retryPressurePct = pct(input.retryEvents, Math.max(1, input.terminalRuns));
  const strengths: string[] = [];
  const risks: string[] = [];

  if (input.terminalRuns === 0) {
    return {
      score: 0,
      status: 'unproven',
      retryPressurePct: 0,
      retryEvents: input.retryEvents,
      attemptRecords: input.attemptRecords,
      selfHeal: { runs: 0, clean: 0, needsAttention: 0, successRatePct: 0 },
      goalRepursuit: { runs: 0, satisfied: 0, escalated: 0, successRatePct: 0 },
      forEachRecovery: { completed: input.itemCompleted, failed: input.itemFailed, failureRatePct: pct(input.itemFailed, input.itemCompleted + input.itemFailed) },
      strengths: [],
      risks: ['No terminal workflow runs exist yet.'],
      recommendation: 'Run one representative workflow before tuning retry or self-heal policy.',
    };
  }

  let score = input.loopEffectivenessScore;
  if (selfHealRuns.length > 0) {
    if (selfHealClean > 0) {
      score += Math.min(12, selfHealClean * 6);
      strengths.push(`${selfHealClean}/${selfHealRuns.length} self-heal run${selfHealRuns.length === 1 ? '' : 's'} finished cleanly.`);
    }
    if (selfHealNeedsAttention > 0) {
      score -= Math.min(18, selfHealNeedsAttention * 9);
      risks.push(`${selfHealNeedsAttention}/${selfHealRuns.length} self-heal run${selfHealRuns.length === 1 ? '' : 's'} still needed attention.`);
    }
  }

  if (goalRepursuits.length > 0) {
    if (goalSatisfied > 0) {
      score += Math.min(10, goalSatisfied * 5);
      strengths.push(`${goalSatisfied}/${goalRepursuits.length} goal repursuit${goalRepursuits.length === 1 ? '' : 's'} ended satisfied.`);
    }
    if (goalEscalated > 0) {
      score -= Math.min(18, goalEscalated * 9);
      risks.push(`${goalEscalated}/${goalRepursuits.length} goal repursuit${goalRepursuits.length === 1 ? '' : 's'} escalated.`);
    }
  }

  if (input.retryEvents > 0) {
    if (input.attemptRecords >= input.retryEvents) {
      strengths.push('Retry attempts have comparable attempt records.');
    } else {
      risks.push('Some retries lack comparable attempt records.');
      score -= 5;
    }
    if (retryPressurePct >= 150) {
      risks.push(`Retry pressure is high at ${retryPressurePct}% of terminal runs.`);
      score -= 12;
    } else if (retryPressurePct <= 50) {
      strengths.push('Retry pressure is bounded.');
    }
  }

  const failureRatePct = pct(input.itemFailed, input.itemCompleted + input.itemFailed);
  if (input.itemFailed > 0) {
    risks.push(`${input.itemFailed} forEach item${input.itemFailed === 1 ? '' : 's'} remain failed.`);
    score -= Math.min(14, failureRatePct / 4);
  } else if (input.itemCompleted > 0) {
    strengths.push('Recent forEach items completed without final failures.');
  }

  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  const hasIntervention = input.retryEvents > 0 || selfHealRuns.length > 0 || goalRepursuits.length > 0 || input.itemFailed > 0;
  const status: LoopInterventionSnapshot['status'] =
    !hasIntervention ? 'unproven'
      : finalScore < 50 || risks.some((risk) => /escalated|still needed attention|high/.test(risk.toLowerCase())) ? 'thrashing'
        : finalScore < 75 || risks.length > 0 ? 'watch'
          : 'productive';
  const recommendation =
    status === 'productive'
      ? 'Loop interventions are paying off; keep retry/self-heal enabled and monitor for repeated causes.'
      : status === 'watch'
        ? 'Keep interventions bounded, but convert the top retry cause into a stricter verifier or deterministic pre-check.'
        : status === 'thrashing'
          ? 'Stop blind retries for the affected workflow; replan from evidence or require human review before another full rerun.'
          : 'No loop intervention samples yet; establish a baseline with one representative workflow run.';

  return {
    score: finalScore,
    status,
    retryPressurePct,
    retryEvents: input.retryEvents,
    attemptRecords: input.attemptRecords,
    selfHeal: {
      runs: selfHealRuns.length,
      clean: selfHealClean,
      needsAttention: selfHealNeedsAttention,
      successRatePct: pct(selfHealClean, selfHealRuns.length),
    },
    goalRepursuit: {
      runs: goalRepursuits.length,
      satisfied: goalSatisfied,
      escalated: goalEscalated,
      successRatePct: pct(goalSatisfied, goalRepursuits.length),
    },
    forEachRecovery: {
      completed: input.itemCompleted,
      failed: input.itemFailed,
      failureRatePct,
    },
    strengths: strengths.slice(0, 5),
    risks: risks.slice(0, 5),
    recommendation,
  };
}

function collectWorkflowLearning(input: {
  cleanRuns: number;
  terminalRuns: number;
}): WorkflowLearningSnapshot {
  const patterns = listWorkflowPatterns();
  const events = readRecentWorkflowPatternEvents(7);
  const remembers = events.filter((event) => workflowPatternAction(event) === 'remember').length;
  const recallHits = events.filter((event) => workflowPatternAction(event) === 'recall_hit').length;
  const recallMisses = events.filter((event) => workflowPatternAction(event) === 'recall_miss').length;
  const recentRecallSamples = recallHits + recallMisses;
  const recallHitRatePct = pct(recallHits, recentRecallSamples);
  const totalCleanPatternRuns = patterns.reduce((sum, pattern) => sum + pattern.successCount, 0);
  const strengths: string[] = [];
  const risks: string[] = [];

  if (patterns.length > 0) {
    strengths.push(`${patterns.length} learned workflow pattern${patterns.length === 1 ? '' : 's'} available.`);
  } else if (input.cleanRuns > 0) {
    risks.push(`${input.cleanRuns} clean workflow run${input.cleanRuns === 1 ? '' : 's'} exist, but no procedural pattern was recorded.`);
  } else {
    risks.push('No learned workflow patterns yet.');
  }

  if (totalCleanPatternRuns > 0) {
    strengths.push(`${totalCleanPatternRuns} clean pattern-backed run${totalCleanPatternRuns === 1 ? '' : 's'} recorded.`);
  }
  if (remembers > 0) {
    strengths.push(`${remembers} workflow pattern remember event${remembers === 1 ? '' : 's'} in the last 7 days.`);
  }

  if (recentRecallSamples === 0) {
    if (patterns.length > 0) risks.push('No recent workflow pattern recall samples.');
  } else if (recallHitRatePct >= 50) {
    strengths.push(`Workflow pattern recall hit rate is ${recallHitRatePct}%.`);
  } else {
    risks.push(`Workflow pattern recall hit rate is ${recallHitRatePct}%.`);
  }

  const coveragePct = pct(patterns.length, Math.max(1, input.cleanRuns));
  if (input.cleanRuns >= 2 && coveragePct < 50) {
    risks.push(`Pattern coverage is low: ${patterns.length}/${input.cleanRuns} clean recent workflow run${input.cleanRuns === 1 ? '' : 's'}.`);
  }

  let status: WorkflowLearningSnapshot['status'] = 'unproven';
  if (patterns.length === 0) {
    status = input.cleanRuns > 0 ? 'stale' : 'unproven';
  } else if (recentRecallSamples > 0 && recallHitRatePct >= 50) {
    status = 'compounding';
  } else if (recentRecallSamples > 0 || remembers > 0) {
    status = 'watch';
  } else {
    status = 'stale';
  }

  const recommendation =
    status === 'compounding'
      ? 'Workflow learning is compounding; keep using reusable workflows and let clean runs refresh their procedural hints.'
      : status === 'watch'
        ? 'Workflow learning has signal but weak recall; tighten workflow descriptions so future runs match prior clean patterns.'
        : status === 'stale'
          ? 'Run a representative workflow or refresh descriptions so clean runs become reusable procedural patterns.'
          : 'Complete one clean workflow run before expecting procedural recall to help future runs.';

  return {
    status,
    patternCount: patterns.length,
    totalCleanPatternRuns,
    recallHits,
    recallMisses,
    recallHitRatePct,
    remembers,
    recentRecallSamples,
    topPatterns: patterns
      .slice()
      .sort((left, right) => right.successCount - left.successCount || right.lastSuccessAt.localeCompare(left.lastSuccessAt))
      .slice(0, 5)
      .map((pattern) => ({
        workflowName: pattern.workflowName,
        workflowSlug: pattern.workflowSlug,
        successCount: pattern.successCount,
        lastSuccessAt: pattern.lastSuccessAt,
        toolCount: pattern.tools.length,
        stepCount: pattern.steps.length,
      })),
    risks: risks.slice(0, 5),
    strengths: strengths.slice(0, 5),
    recommendation,
  };
}

function validTrendPoint(row: unknown): row is AgentSystemTrendPoint {
  if (!row || typeof row !== 'object') return false;
  const value = row as Partial<AgentSystemTrendPoint>;
  return typeof value.at === 'string' &&
    typeof value.swarmReadinessScore === 'number' &&
    typeof value.loopEffectivenessScore === 'number' &&
    typeof value.interventionScore === 'number' &&
    typeof value.workflowRecallHitRatePct === 'number' &&
    typeof value.workerCapRatePct === 'number' &&
    typeof value.blockedAgents === 'number' &&
    typeof value.itemFailures === 'number';
}

function readAgentSystemTrendHistory(): AgentSystemTrendPoint[] {
  const rows = readJsonFile<unknown>(AGENT_SYSTEM_TREND_FILE);
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(validTrendPoint)
    .sort((left, right) => left.at.localeCompare(right.at))
    .slice(-96);
}

function writeAgentSystemTrendHistory(points: AgentSystemTrendPoint[]): void {
  try {
    mkdirSync(path.dirname(AGENT_SYSTEM_TREND_FILE), { recursive: true });
    writeFileSync(AGENT_SYSTEM_TREND_FILE, JSON.stringify(points, null, 2), 'utf-8');
  } catch {
    // Best-effort telemetry: trend history must never break live metrics.
  }
}

function recordAgentSystemTrendPoint(current: AgentSystemTrendPoint, history: AgentSystemTrendPoint[]): void {
  const currentBucket = hourKey(current.at);
  const next = [
    ...history.filter((point) => hourKey(point.at) !== currentBucket),
    current,
  ]
    .sort((left, right) => left.at.localeCompare(right.at))
    .slice(-96);
  writeAgentSystemTrendHistory(next);
}

function trendHealthScore(point: AgentSystemTrendPoint): number {
  const positive = (
    point.swarmReadinessScore +
    point.loopEffectivenessScore +
    point.interventionScore +
    point.workflowRecallHitRatePct
  ) / 4;
  const penalties =
    point.workerCapRatePct * 0.25 +
    point.blockedAgents * 8 +
    point.itemFailures * 4;
  return Math.max(0, Math.min(100, Math.round(positive - penalties)));
}

function recentTrendSeries(current: AgentSystemTrendPoint, history: AgentSystemTrendPoint[]): AgentSystemTrendSeriesPoint[] {
  const currentBucket = hourKey(current.at);
  return [
    ...history.filter((point) => hourKey(point.at) !== currentBucket),
    current,
  ]
    .sort((left, right) => left.at.localeCompare(right.at))
    .slice(-24)
    .map((point) => ({ ...point, healthScore: trendHealthScore(point) }));
}

function chooseTrendBaseline(current: AgentSystemTrendPoint, history: AgentSystemTrendPoint[]): AgentSystemTrendPoint | null {
  const currentTime = Date.parse(current.at);
  if (!Number.isFinite(currentTime) || history.length === 0) return history[0] ?? null;
  const older = history.filter((point) => {
    const t = Date.parse(point.at);
    return Number.isFinite(t) && t <= currentTime - 6 * 60 * 60_000;
  });
  return older.length > 0 ? older[older.length - 1] : history[0] ?? null;
}

function signedDelta(current: number, baseline: number): number {
  return Math.round(current - baseline);
}

function collectAgentSystemTrend(current: AgentSystemTrendPoint): AgentSystemTrendSnapshot {
  const history = readAgentSystemTrendHistory();
  const baseline = chooseTrendBaseline(current, history);
  const recent = recentTrendSeries(current, history);
  recordAgentSystemTrendPoint(current, history);
  if (!baseline) {
    return {
      status: 'unproven',
      baselineAt: null,
      samples: 1,
      recent,
      delta: {
        swarmReadinessScore: 0,
        loopEffectivenessScore: 0,
        interventionScore: 0,
        workflowRecallHitRatePct: 0,
        workerCapRatePct: 0,
        blockedAgents: 0,
        itemFailures: 0,
      },
      signals: ['No prior agent-system trend baseline exists yet.'],
      recommendation: 'Let this snapshot establish the baseline; future polls will show whether swarm and loop health are improving.',
    };
  }

  const delta = {
    swarmReadinessScore: signedDelta(current.swarmReadinessScore, baseline.swarmReadinessScore),
    loopEffectivenessScore: signedDelta(current.loopEffectivenessScore, baseline.loopEffectivenessScore),
    interventionScore: signedDelta(current.interventionScore, baseline.interventionScore),
    workflowRecallHitRatePct: signedDelta(current.workflowRecallHitRatePct, baseline.workflowRecallHitRatePct),
    workerCapRatePct: signedDelta(current.workerCapRatePct, baseline.workerCapRatePct),
    blockedAgents: signedDelta(current.blockedAgents, baseline.blockedAgents),
    itemFailures: signedDelta(current.itemFailures, baseline.itemFailures),
  };
  const score =
    delta.swarmReadinessScore +
    delta.loopEffectivenessScore +
    Math.round(delta.interventionScore / 2) +
    Math.round(delta.workflowRecallHitRatePct / 2) -
    Math.max(0, delta.workerCapRatePct) -
    Math.max(0, delta.blockedAgents * 8) -
    Math.max(0, delta.itemFailures * 4) +
    Math.max(0, -delta.workerCapRatePct) +
    Math.max(0, -delta.blockedAgents * 8) +
    Math.max(0, -delta.itemFailures * 4);
  const status: AgentSystemTrendSnapshot['status'] =
    score >= 12 ? 'improving'
      : score <= -12 ? 'regressing'
        : 'stable';
  const signals: string[] = [];

  if (delta.swarmReadinessScore !== 0) signals.push(`Swarm readiness ${delta.swarmReadinessScore > 0 ? '+' : ''}${delta.swarmReadinessScore}.`);
  if (delta.loopEffectivenessScore !== 0) signals.push(`Loop effectiveness ${delta.loopEffectivenessScore > 0 ? '+' : ''}${delta.loopEffectivenessScore}.`);
  if (delta.interventionScore !== 0) signals.push(`Intervention score ${delta.interventionScore > 0 ? '+' : ''}${delta.interventionScore}.`);
  if (delta.workflowRecallHitRatePct !== 0) signals.push(`Workflow recall ${delta.workflowRecallHitRatePct > 0 ? '+' : ''}${delta.workflowRecallHitRatePct}%.`);
  if (delta.workerCapRatePct !== 0) signals.push(`Worker cap rate ${delta.workerCapRatePct > 0 ? '+' : ''}${delta.workerCapRatePct}%.`);
  if (delta.blockedAgents !== 0) signals.push(`Blocked agents ${delta.blockedAgents > 0 ? '+' : ''}${delta.blockedAgents}.`);
  if (delta.itemFailures !== 0) signals.push(`Item failures ${delta.itemFailures > 0 ? '+' : ''}${delta.itemFailures}.`);
  if (signals.length === 0) signals.push('No material movement from the prior baseline.');

  const recommendation =
    status === 'improving'
      ? 'Keep the current coordination policy; the agent system trend is improving against the prior baseline.'
      : status === 'regressing'
        ? 'Pause expansion and address the worsening signal before adding more autonomy or concurrency.'
        : 'Trend is stable; run one representative swarm or workflow task to create stronger movement.';

  return {
    status,
    baselineAt: baseline.at,
    samples: Math.max(1, history.length + 1),
    recent,
    delta,
    signals: signals.slice(0, 6),
    recommendation,
  };
}

function collectCoordinationPolicy(input: {
  agentCount: number;
  peerComms: boolean;
  loopEffectivenessScore: number;
  terminalRuns: number;
  itemFailed: number;
  topLoopCause?: LoopIssueCause;
  swarmReadiness: SwarmReadinessSnapshot;
  swarmEffectiveness: SwarmEffectivenessSnapshot;
  loopInterventions: LoopInterventionSnapshot;
  workflowLearning: WorkflowLearningSnapshot;
  trend: AgentSystemTrendSnapshot;
}): CoordinationPolicySnapshot {
  const reasons: string[] = [];
  const guardrails: string[] = [];

  function fanoutPostureFor(mode: CoordinationMode, status: CoordinationStatus): FanoutPosture {
    if (status === 'repair') return 'block';
    if (status === 'constrain') return 'constrain';
    if (mode === 'bounded-fanout' && status === 'expand') return 'allow';
    if (mode === 'review-swarm' && status === 'expand') return 'allow';
    return 'soft';
  }

  function waveSizeFor(posture: FanoutPosture): number {
    if (posture === 'allow') return 8;
    if (posture === 'soft') return 4;
    if (posture === 'constrain') return 2;
    return 0;
  }

  function finish(
    mode: CoordinationMode,
    status: CoordinationStatus,
    confidence: number,
    nextAction: string,
  ): CoordinationPolicySnapshot {
    const fanoutPosture = fanoutPostureFor(mode, status);
    return {
      mode,
      status,
      fanoutPosture,
      recommendedWorkerWaveSize: waveSizeFor(fanoutPosture),
      confidence: Math.max(0, Math.min(100, confidence)),
      reasons: reasons.slice(0, 4),
      guardrails: guardrails.slice(0, 4),
      nextAction,
    };
  }

  if (
    input.terminalRuns > 0 &&
    (input.loopInterventions.status === 'thrashing' || input.loopEffectivenessScore < 60)
  ) {
    reasons.push(`Loop effectiveness is ${input.loopEffectivenessScore}/100.`);
    if (input.loopInterventions.risks[0]) reasons.push(input.loopInterventions.risks[0]);
    if (input.topLoopCause) reasons.push(`Top repeated cause: ${input.topLoopCause.label}.`);
    guardrails.push('Do not full-rerun the workflow until the repeated failure cause is addressed.');
    if (input.itemFailed > 0) guardrails.push('Use failed-item retry for completed forEach work instead of replaying every item.');
    guardrails.push('Convert the top failure into a verifier, pre-check, or tighter step contract before expanding autonomy.');
    return finish(
      'repair-loop',
      'repair',
      input.loopInterventions.status === 'thrashing' ? 94 : 86,
      input.topLoopCause
        ? `Repair "${input.topLoopCause.label}" before another broad rerun.`
        : 'Inspect the latest failed workflow evidence and replan before retrying.',
    );
  }

  if (input.swarmReadiness.status === 'blocked' || (input.agentCount > 0 && input.swarmReadiness.score < 50)) {
    reasons.push(`Swarm readiness is ${input.swarmReadiness.score}/100.`);
    if (input.swarmReadiness.risks[0]) reasons.push(input.swarmReadiness.risks[0]);
    if (input.agentCount > 1 && !input.peerComms) reasons.push('Peer communication is disabled.');
    guardrails.push('Keep orchestration centralized until blocked agents, broken message edges, or inbox backlog are cleared.');
    guardrails.push('Use specialist agents for review only after the top readiness risk is resolved.');
    return finish(
      'single-orchestrator',
      'constrain',
      input.swarmReadiness.status === 'blocked' ? 92 : 82,
      input.swarmReadiness.recommendation,
    );
  }

  if (input.swarmEffectiveness.capRatePct >= 20) {
    reasons.push(`Worker fanout cap rate is ${input.swarmEffectiveness.capRatePct}%.`);
    if (input.swarmEffectiveness.recentCappedItems[0]) reasons.push(`Recent capped item: ${input.swarmEffectiveness.recentCappedItems[0]}.`);
    guardrails.push('Split large item packets or raise worker turn budget before adding more concurrency.');
    guardrails.push('Keep fanout batches small until cap rate drops below 20%.');
    return finish(
      'bounded-fanout',
      'constrain',
      84,
      input.swarmEffectiveness.recommendation,
    );
  }

  if (input.trend.status === 'regressing') {
    reasons.push(input.trend.signals[0] ?? 'Agent-system trend is regressing.');
    reasons.push(`Trend baseline: ${input.trend.baselineAt ?? 'unknown'}.`);
    guardrails.push('Do not widen autonomy or concurrency while trend is regressing.');
    guardrails.push('Stabilize the worsening swarm, loop, or learning signal before adding new background work.');
    return finish(
      'single-orchestrator',
      'constrain',
      78,
      input.trend.recommendation,
    );
  }

  if (input.workflowLearning.status === 'stale' && input.workflowLearning.patternCount > 0) {
    reasons.push(`${input.workflowLearning.patternCount} learned workflow pattern${input.workflowLearning.patternCount === 1 ? '' : 's'} exist.`);
    reasons.push('No recent workflow pattern recall samples.');
    guardrails.push('Refresh workflow descriptions or run a representative workflow before relying on procedural memory.');
    guardrails.push('Prefer existing workflow patterns for similar work, then let clean runs update them.');
    return finish(
      'learning-loop',
      'learn',
      74,
      input.workflowLearning.recommendation,
    );
  }

  if (
    input.swarmReadiness.status === 'ready' &&
    input.swarmEffectiveness.workerRoutes > 0 &&
    input.swarmEffectiveness.capRatePct < 20
  ) {
    reasons.push(`Swarm readiness is ${input.swarmReadiness.score}/100.`);
    reasons.push(`Worker fanout cap rate is ${input.swarmEffectiveness.capRatePct}%.`);
    if (input.workflowLearning.status === 'compounding') reasons.push(`Workflow recall is ${input.workflowLearning.recallHitRatePct}%.`);
    guardrails.push('Use fanout only for independent same-shape items with clear merge criteria.');
    guardrails.push('Keep write/send actions behind explicit approval and aggregate previews.');
    return finish(
      'bounded-fanout',
      'expand',
      88,
      'Use bounded worker fanout for independent item work and keep monitoring cap rate.',
    );
  }

  if (input.agentCount > 1 && input.peerComms && (input.swarmReadiness.status === 'ready' || input.swarmReadiness.status === 'watch')) {
    reasons.push(`${input.agentCount} team agents are configured.`);
    reasons.push(`Swarm readiness is ${input.swarmReadiness.status}.`);
    guardrails.push('Use review or debate swarms for judgment-heavy work, not tightly coupled sequential steps.');
    guardrails.push('Require one clear owner to merge specialist responses into a final answer.');
    return finish(
      'review-swarm',
      input.swarmReadiness.status === 'ready' ? 'expand' : 'watch',
      input.swarmReadiness.status === 'ready' ? 80 : 68,
      input.swarmReadiness.recommendation,
    );
  }

  if (input.workflowLearning.status === 'watch' || input.workflowLearning.status === 'compounding') {
    reasons.push(`Workflow learning is ${input.workflowLearning.status}.`);
    reasons.push(`Workflow recall hit rate is ${input.workflowLearning.recallHitRatePct}%.`);
    guardrails.push('Check learned workflow patterns before drafting a new process from scratch.');
    guardrails.push('Keep clean recurring runs eligible for pattern refresh.');
    return finish(
      'learning-loop',
      input.workflowLearning.status === 'compounding' ? 'expand' : 'watch',
      input.workflowLearning.status === 'compounding' ? 78 : 64,
      input.workflowLearning.recommendation,
    );
  }

  reasons.push(input.agentCount > 0 ? `${input.agentCount} agent${input.agentCount === 1 ? '' : 's'} configured.` : 'No specialist agents configured.');
  if (input.terminalRuns === 0) reasons.push('No terminal workflow baseline exists yet.');
  guardrails.push('Start with one representative workflow or specialist task to establish evidence.');
  guardrails.push('Avoid widening autonomy until readiness and loop baselines have samples.');
  return finish(
    'single-orchestrator',
    'watch',
    58,
    'Run one small representative task to establish baseline swarm and loop evidence.',
  );
}

function buildRecommendations(input: {
  agentCount: number;
  peerComms: boolean;
  comms24h: number;
  pendingInboxItems: number;
  blockedAgents: number;
  workerCapped: number;
  workerRoutes: number;
  swarmEffectiveness: SwarmEffectivenessSnapshot;
  swarmTopology: SwarmTopologySnapshot;
  swarmReadiness: SwarmReadinessSnapshot;
  terminalRuns: number;
  cleanRuns: number;
  needsAttention: number;
  retryEvents: number;
  itemFailed: number;
  itemCompleted: number;
  goalEscalated: number;
  loopEffectivenessScore: number;
  loopInterventions: LoopInterventionSnapshot;
  workflowLearning: WorkflowLearningSnapshot;
  trend: AgentSystemTrendSnapshot;
  weakestAgent?: AgentScorecard;
  topLoopCause?: LoopIssueCause;
}): AgentSystemRecommendation[] {
  const recs: AgentSystemRecommendation[] = [];

  if (input.agentCount === 0) {
    recs.push({
      id: 'swarm-create-specialists',
      kind: 'swarm',
      severity: 'info',
      title: 'Create specialist agents before expecting swarm behavior',
      detail: 'No team agents are configured, so Clementine can only run single-orchestrator work.',
      action: 'Create one narrow specialist for a recurring task, then give it a small tool and workflow surface.',
      target: 'agents',
      href: '/agents',
      cta: 'Open agents',
    });
  } else if (input.agentCount > 1 && !input.peerComms) {
    recs.push({
      id: 'swarm-enable-peer-comms',
      kind: 'swarm',
      severity: 'warn',
      title: 'Enable peer comms for multi-agent work',
      detail: `${input.agentCount} agents exist, but they cannot request or answer each other directly.`,
      action: 'Turn on peer comms before relying on review/debate/delegation swarms.',
      target: 'settings',
      href: '/advanced/developer',
      cta: 'Open flags',
    });
  }

  if (input.weakestAgent && (input.weakestAgent.status === 'blocked' || input.weakestAgent.score < 60)) {
    recs.push({
      id: 'swarm-agent-scorecard-risk',
      kind: 'swarm',
      severity: input.weakestAgent.status === 'blocked' ? 'warn' : 'info',
      title: `${input.weakestAgent.name} needs swarm attention`,
      detail: `${input.weakestAgent.name} scorecard is ${input.weakestAgent.score}/100 with status ${input.weakestAgent.status}.`,
      action: input.weakestAgent.recommendation,
      target: 'agents',
      href: '/agents',
      cta: 'Open agents',
    });
  }

  if (input.swarmReadiness.status === 'blocked' || input.swarmReadiness.score < 50) {
    recs.push({
      id: 'swarm-readiness-low',
      kind: 'swarm',
      severity: input.swarmReadiness.status === 'blocked' ? 'critical' : 'warn',
      title: `Swarm readiness is ${input.swarmReadiness.score}/100`,
      detail: input.swarmReadiness.risks[0] ?? 'Swarm evidence is too thin for broad autonomous coordination.',
      action: input.swarmReadiness.recommendation,
      target: 'agents',
      href: '/agents',
      cta: 'Open agents',
    });
  }

  if (input.workerCapped > 0) {
    recs.push({
      id: 'swarm-worker-cap',
      kind: 'swarm',
      severity: 'critical',
      title: 'Worker runs are hitting their turn cap',
      detail: `${input.workerCapped} recent worker run(s) capped out before completion.`,
      action: 'Split large worker prompts into smaller packets or raise the worker turn budget.',
      target: 'settings',
      href: '/advanced/budgets',
      cta: 'Open budgets',
    });
  }

  if (input.swarmEffectiveness.fanoutBlockedByPolicy > 0) {
    recs.push({
      id: 'swarm-fanout-policy-constrained',
      kind: 'swarm',
      severity: input.swarmEffectiveness.fanoutSuppressedByPolicyPct >= 50 ? 'warn' : 'info',
      title: 'Fanout policy is constraining multi-item work',
      detail: `${input.swarmEffectiveness.fanoutBlockedByPolicy}/${input.swarmEffectiveness.policyDecisions} recent fanout decision(s) were blocked by coordination policy.`,
      action: 'Review whether blocked turns were repair-loop risks or safe independent batches that need a smaller wave size.',
      target: 'observability',
      href: '/advanced/evolution',
      cta: 'Open evolution',
    });
  }

  if (
    input.swarmEffectiveness.intentRoutes >= 2 &&
    input.swarmEffectiveness.intentMatchRatePct < 50
  ) {
    recs.push({
      id: 'swarm-intent-routing-miss',
      kind: 'swarm',
      severity: 'warn',
      title: 'Worker intent routing is missing too often',
      detail: `${input.swarmEffectiveness.intentMatches}/${input.swarmEffectiveness.intentRoutes} recent worker route(s) matched an intent rule.`,
      action: 'Tighten worker intent labels or add model-role mappings for common specialist work.',
      target: 'observability',
      href: '/advanced/evolution',
      cta: 'Open evolution',
    });
  }

  if (input.swarmTopology.unknownTargets.length > 0) {
    const first = input.swarmTopology.unknownTargets[0];
    recs.push({
      id: 'swarm-fix-unknown-message-targets',
      kind: 'swarm',
      severity: 'warn',
      title: 'Some agent message links point nowhere',
      detail: `${input.swarmTopology.unknownTargets.length} canMessage target(s) reference missing agents; first: ${first.from} -> ${first.to}.`,
      action: 'Update the affected agent canMessage lists or recreate the missing specialist.',
      target: 'agents',
      href: '/agents',
      cta: 'Open agents',
    });
  } else if (input.swarmTopology.isolatedAgents.length > 0) {
    recs.push({
      id: 'swarm-connect-isolated-agents',
      kind: 'swarm',
      severity: 'info',
      title: 'Some agents are isolated from swarm coordination',
      detail: `${input.swarmTopology.isolatedAgents.slice(0, 3).join(', ')} ${input.swarmTopology.isolatedAgents.length === 1 ? 'has' : 'have'} no message edges.`,
      action: 'Connect isolated agents to Clementine or to the specialist that should review their work.',
      target: 'agents',
      href: '/agents',
      cta: 'Open agents',
    });
  } else if (input.swarmTopology.requestResponsePct < 50 && input.swarmTopology.recentRequests >= 2) {
    recs.push({
      id: 'swarm-low-response-rate',
      kind: 'swarm',
      severity: 'warn',
      title: 'Agent requests are not getting enough responses',
      detail: `${input.swarmTopology.recentResponses}/${input.swarmTopology.recentRequests} recent request(s) have matching response activity.`,
      action: 'Drain pending inboxes or shorten wake cadence before adding more request-heavy swarm work.',
      target: 'agents',
      href: '/agents',
      cta: 'Open agents',
    });
  }

  if (input.agentCount > 1 && input.peerComms && input.comms24h === 0) {
    recs.push({
      id: 'swarm-no-recent-comms',
      kind: 'swarm',
      severity: 'info',
      title: 'Agents are configured but not collaborating yet',
      detail: 'Peer comms are enabled, but no team messages were recorded in the last 24 hours.',
      action: 'Use a review or delegation prompt on the next multi-part task to exercise the team graph.',
      target: 'agents',
      href: '/agents',
      cta: 'Open agents',
    });
  }

  if (input.pendingInboxItems > 0 || input.blockedAgents > 0) {
    recs.push({
      id: 'swarm-drain-inbox',
      kind: 'swarm',
      severity: input.blockedAgents > 0 ? 'warn' : 'info',
      title: 'Clear team-agent backlog before adding more work',
      detail: `${input.pendingInboxItems} pending inbox item(s), ${input.blockedAgents} blocked agent(s).`,
      action: 'Open the affected agent trace, resolve the blocker, then resume or dismiss stale inbox items.',
      target: 'agents',
      href: '/agents',
      cta: 'Open agents',
    });
  }

  if (input.terminalRuns === 0) {
    recs.push({
      id: 'loop-establish-baseline',
      kind: 'loop',
      severity: 'info',
      title: 'Run workflows to establish loop baselines',
      detail: 'No terminal workflow runs were found in the recent window.',
      action: 'Run one representative workflow so retries, self-heal, and goal validation have baseline data.',
      target: 'workflows',
      href: '/automate',
      cta: 'Open workflows',
    });
  } else if (input.loopEffectivenessScore < 60) {
    recs.push({
      id: 'loop-replan-before-retry',
      kind: 'loop',
      severity: 'critical',
      title: 'Replan instead of retrying blindly',
      detail: `Loop effectiveness is ${input.loopEffectivenessScore}/100 with ${input.needsAttention} attention-needed run(s).`,
      action: 'Use current evidence to revise the workflow step or goal criteria before another full rerun.',
      target: 'workflows',
      href: '/automate',
      cta: 'Open workflows',
    });
  }

  if (input.itemFailed > 0) {
    recs.push({
      id: 'loop-rerun-failed-items',
      kind: 'loop',
      severity: 'warn',
      title: 'Retry only failed forEach items',
      detail: `${input.itemFailed} item failure(s) across ${input.itemCompleted + input.itemFailed} recent forEach item(s).`,
      action: 'Use failed-item retry so completed items are not rerun or re-sent.',
      target: 'workflows',
      href: '/automate',
      cta: 'Open workflows',
    });
  }

  if (input.loopInterventions.status === 'thrashing') {
    recs.push({
      id: 'loop-interventions-thrashing',
      kind: 'loop',
      severity: 'critical',
      title: `Loop interventions are thrashing (${input.loopInterventions.score}/100)`,
      detail: input.loopInterventions.risks[0] ?? 'Retries or self-heal attempts are not producing clean outcomes.',
      action: input.loopInterventions.recommendation,
      target: 'workflows',
      href: '/automate',
      cta: 'Open workflows',
    });
  } else if (input.loopInterventions.status === 'watch') {
    recs.push({
      id: 'loop-interventions-watch',
      kind: 'loop',
      severity: 'warn',
      title: `Loop interventions need review (${input.loopInterventions.score}/100)`,
      detail: input.loopInterventions.risks[0] ?? 'Loop interventions have mixed evidence.',
      action: input.loopInterventions.recommendation,
      target: 'observability',
      href: '/advanced/evolution',
      cta: 'Open evolution',
    });
  }

  if (input.topLoopCause && input.topLoopCause.count >= 2) {
    recs.push({
      id: 'loop-fix-top-cause',
      kind: 'loop',
      severity: 'warn',
      title: `Fix repeated loop cause: ${input.topLoopCause.label}`,
      detail: `${input.topLoopCause.count} recent loop signal(s) share this cause across ${input.topLoopCause.sources.join(', ')} evidence.`,
      action: 'Convert this repeated failure into a stricter verifier, clearer step prompt, or deterministic pre-check before rerunning.',
      target: 'observability',
      href: '/advanced/evolution',
      cta: 'Open evolution',
    });
  }

  if (input.retryEvents >= 3) {
    recs.push({
      id: 'loop-review-retry-causes',
      kind: 'loop',
      severity: 'warn',
      title: 'Review repeated retry causes',
      detail: `${input.retryEvents} retry event(s) were recorded recently.`,
      action: 'Inspect attempt records and convert repeated verifier failures into deterministic validation or a tighter step prompt.',
      target: 'observability',
      href: '/advanced/evolution',
      cta: 'Open evolution',
    });
  }

  if (input.trend.status === 'regressing') {
    recs.push({
      id: 'system-trend-regressing',
      kind: 'loop',
      severity: 'warn',
      title: 'Agent-system trend is regressing',
      detail: input.trend.signals[0] ?? 'Recent swarm and workflow-loop signals are worse than the prior baseline.',
      action: input.trend.recommendation,
      target: 'observability',
      href: '/advanced/evolution',
      cta: 'Open evolution',
    });
  }

  if (input.workflowLearning.status === 'stale') {
    recs.push({
      id: 'loop-workflow-learning-stale',
      kind: 'loop',
      severity: 'warn',
      title: 'Workflow learning is stale',
      detail: input.workflowLearning.risks[0] ?? 'Workflow pattern memory is not refreshing or being recalled.',
      action: input.workflowLearning.recommendation,
      target: 'observability',
      href: '/advanced/evolution',
      cta: 'Open evolution',
    });
  } else if (input.workflowLearning.status === 'watch') {
    recs.push({
      id: 'loop-workflow-learning-watch',
      kind: 'loop',
      severity: 'info',
      title: 'Workflow learning needs better recall',
      detail: input.workflowLearning.risks[0] ?? `${input.workflowLearning.recallHitRatePct}% workflow pattern recall hit rate.`,
      action: input.workflowLearning.recommendation,
      target: 'workflows',
      href: '/automate',
      cta: 'Open workflows',
    });
  }

  if (input.goalEscalated > 0) {
    recs.push({
      id: 'loop-goal-escalations',
      kind: 'loop',
      severity: 'warn',
      title: 'Goal validation is escalating',
      detail: `${input.goalEscalated} recent workflow goal validation(s) escalated instead of self-correcting.`,
      action: 'Tighten the workflow goal objective and acceptance criteria so the runner can self-correct earlier.',
      target: 'workflows',
      href: '/automate',
      cta: 'Open workflows',
    });
  }

  if (recs.length === 0) {
    recs.push({
      id: 'system-healthy-expand-carefully',
      kind: 'loop',
      severity: 'info',
      title: 'System signals are healthy',
      detail: `${input.cleanRuns}/${input.terminalRuns} recent workflow run(s) completed cleanly, with no major swarm warnings.`,
      action: 'Expand adaptive replanning or fanout usage behind a flag on the next recurring workflow.',
      target: 'workflows',
      href: '/advanced/evolution',
      cta: 'Open evolution',
    });
  }

  return recs.slice(0, 12);
}

export function collectAgentSystemMetrics(): AgentSystemMetrics {
  const agents = loadTeamAgents();
  const comms = readRecentComms();
  const autonomy = listAutonomyRuns({ limit: 80 });
  const autonomyCompleted = autonomy.filter((run) => run.status === 'completed').length;
  const autonomyFailed = autonomy.filter((run) => run.status === 'failed' || run.needsAttention).length;
  const autonomyActive = autonomy.filter((run) => run.status === 'running' || run.status === 'queued' || run.status === 'received').length;
  const worker = collectWorkerHarnessStats();
  const peerComms = peerCommsEnabled();
  const pendingInboxItems = countPendingInboxItems();
  const blockedAgents = countBlockedAgents();
  const scorecards = collectAgentScorecards({ agents, comms, autonomy });
  const topology = collectSwarmTopology({ agents, comms });
  const readiness = collectSwarmReadiness({
    agents,
    peerComms,
    pendingInboxItems,
    blockedAgents,
    topology,
    effectiveness: worker.effectiveness,
    scorecards,
    comms24h: comms.length,
  });

  const workflowRuns = readWorkflowRunRecords(120);
  const terminal = workflowRuns.filter((run) => run.status === 'completed' || run.status === 'completed_with_errors' || run.status === 'error' || run.status === 'cancelled');
  const failed = workflowRuns.filter((run) => run.status === 'error' || run.status === 'cancelled').length;
  const needsAttention = workflowRuns.filter((run) => run.needsAttention || run.status === 'completed_with_errors').length;
  const clean = terminal.filter(workflowRunClean).length;
  const eventStats = scanWorkflowEvents(workflowRuns);
  const durations = workflowRuns.map(runDurationSeconds).filter((value): value is number => value !== null);
  const goalSatisfied = workflowRuns.filter((run) => run.goalOutcome === 'satisfied').length;
  const goalEscalated = workflowRuns.filter((run) => run.goalOutcome === 'escalate').length;
  const selfHealRuns = workflowRuns.filter((run) => (run.selfHealAttempt ?? 0) > 0).length;
  const goalRepursuits = workflowRuns.filter((run) => (run.goalAttempt ?? 0) > 0 || run.goalOutcome === 'repursue').length;
  const loopEffectivenessScore = loopScore({
    clean,
    total: terminal.length,
    failed,
    needsAttention,
    retryEvents: eventStats.retryEvents,
    attemptRecords: eventStats.attemptRecords,
    itemCompleted: eventStats.itemCompleted,
    itemFailed: eventStats.itemFailed,
    goalSatisfied,
    goalEscalated,
  });
  const loopInterventions = collectLoopInterventions({
    records: workflowRuns,
    terminalRuns: terminal.length,
    cleanRuns: clean,
    retryEvents: eventStats.retryEvents,
    attemptRecords: eventStats.attemptRecords,
    itemCompleted: eventStats.itemCompleted,
    itemFailed: eventStats.itemFailed,
    loopEffectivenessScore,
  });
  const workflowLearning = collectWorkflowLearning({
    cleanRuns: clean,
    terminalRuns: terminal.length,
  });
  const trend = collectAgentSystemTrend({
    at: nowIso(),
    swarmReadinessScore: readiness.score,
    loopEffectivenessScore,
    interventionScore: loopInterventions.score,
    workflowRecallHitRatePct: workflowLearning.recallHitRatePct,
    workerCapRatePct: worker.effectiveness.capRatePct,
    blockedAgents,
    itemFailures: eventStats.itemFailed,
  });
  const coordination = collectCoordinationPolicy({
    agentCount: agents.length,
    peerComms,
    loopEffectivenessScore,
    terminalRuns: terminal.length,
    itemFailed: eventStats.itemFailed,
    topLoopCause: eventStats.issueCauses[0],
    swarmReadiness: readiness,
    swarmEffectiveness: worker.effectiveness,
    loopInterventions,
    workflowLearning,
    trend,
  });

  const recentWarnings: AgentSystemMetrics['recentWarnings'] = [];
  if (worker.workerCapped > 0) recentWarnings.push({ kind: 'swarm', message: `${worker.workerCapped} worker run(s) hit their turn cap recently.` });
  if (!peerComms && agents.length > 1) recentWarnings.push({ kind: 'swarm', message: 'Multiple agents exist, but peer comms are disabled.' });
  if (eventStats.itemFailed > 0) recentWarnings.push({ kind: 'loop', message: `${eventStats.itemFailed} forEach item failure(s) remain in recent workflow logs.` });
  if (goalEscalated > 0) recentWarnings.push({ kind: 'loop', message: `${goalEscalated} workflow goal validation(s) escalated instead of self-correcting.` });
  if (loopEffectivenessScore < 60 && terminal.length > 0) recentWarnings.push({ kind: 'loop', message: `Loop effectiveness score is ${loopEffectivenessScore}/100; repeated attempts may not be improving outcomes.` });
  const recommendations = buildRecommendations({
    agentCount: agents.length,
    peerComms,
    comms24h: comms.length,
    pendingInboxItems,
    blockedAgents,
    workerCapped: worker.workerCapped,
    workerRoutes: worker.workerRoutes,
    swarmEffectiveness: worker.effectiveness,
    swarmTopology: topology,
    swarmReadiness: readiness,
    terminalRuns: terminal.length,
    cleanRuns: clean,
    needsAttention,
    retryEvents: eventStats.retryEvents,
    itemFailed: eventStats.itemFailed,
    itemCompleted: eventStats.itemCompleted,
    goalEscalated,
    loopEffectivenessScore,
    loopInterventions,
    workflowLearning,
    trend,
    weakestAgent: scorecards[0],
    topLoopCause: eventStats.issueCauses[0],
  });

  return {
    generatedAt: nowIso(),
    coordination,
    trend,
    swarm: {
      agentCount: agents.length,
      v2OptInCount: v2OptInCount(),
      peerCommsEnabled: peerComms,
      comms24h: {
        total: comms.length,
        requests: comms.filter((row) => row.protocol === 'request').length,
        responses: comms.filter((row) => row.protocol === 'response').length,
        messages: comms.filter((row) => !row.protocol || row.protocol === 'message').length,
      },
      pendingInboxItems,
      blockedAgents,
      autonomyRuns: {
        total: autonomy.length,
        completed: autonomyCompleted,
        failed: autonomyFailed,
        active: autonomyActive,
        successRatePct: pct(autonomyCompleted, autonomyCompleted + autonomyFailed),
      },
      ...worker,
      topology,
      readiness,
      scorecards,
      recommendation: worker.workerCapped > 0
        ? 'Raise worker budget or split capped worker prompts into smaller job packets.'
        : agents.length > 1 && !peerComms
          ? 'Enable peer comms before relying on multi-agent collaboration.'
          : 'Use fanout/review swarms for independent item work; keep single-orchestrator mode for tightly coupled tasks.',
    },
    loops: {
      workflowRuns: {
        total: terminal.length,
        clean,
        needsAttention,
        failed,
        successRatePct: pct(clean, terminal.length),
      },
      attemptRecords: eventStats.attemptRecords,
      retryEvents: eventStats.retryEvents,
      selfHealRuns,
      goalRepursuits,
      goalSatisfied,
      goalEscalated,
      forEachItems: {
        completed: eventStats.itemCompleted,
        failed: eventStats.itemFailed,
        failureRatePct: pct(eventStats.itemFailed, eventStats.itemCompleted + eventStats.itemFailed),
      },
      averageRunSeconds: durations.length > 0
        ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
        : null,
      loopEffectivenessScore,
      interventions: loopInterventions,
      learning: workflowLearning,
      issueCauses: eventStats.issueCauses,
      recommendation: loopEffectivenessScore < 60
        ? 'Stop blind retries after weak progress; replan from current evidence or escalate with the failed criteria.'
        : eventStats.itemFailed > 0
          ? 'Use failed-item retry for forEach runs instead of rerunning already-completed items.'
          : 'Loop telemetry is healthy enough to expand adaptive replanning behind a flag.',
    },
    recentWarnings: recentWarnings.slice(0, 8),
    recommendations,
  };
}
