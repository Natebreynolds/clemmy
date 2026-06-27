import { apiGet, apiPost } from './api';

export interface UsageRollup {
  date?: string;
  totalTokens?: number;
  totalCalls?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  bySource?: Array<{ source: string; tokens: number; calls: number; kind?: string }>;
  byModel?: Record<string, { tokens: number; calls: number }>;
  byKind?: Record<string, { tokens: number; calls: number }>;
  [k: string]: unknown;
}

export interface ToolRow { name: string; description?: string; category?: string; needsApproval?: boolean }

export const getUsage = () => apiGet<UsageRollup>('/api/console/usage');
export const getTools = () => apiGet<{ tools?: ToolRow[] }>('/api/console/tools');
export const getDiagnostics = () => apiGet<Record<string, unknown>>('/api/console/diagnostics');
export const getSettings = () => apiGet<Record<string, unknown>>('/api/console/settings');
export const getBuildInfo = () => apiGet<{ version?: string; name?: string }>('/api/console/build-info');
// ─── Evolution / autoresearch ──────────────────────────────────────────────
export interface ToolHealth {
  toolName: string; calls: number; successes: number; errors: number;
  emptyResults: number; wrongPickHints: number; avgDurationMs?: number; sampleError?: string;
}
export interface WorkflowRunSummary {
  id: string; workflow: string; status: string; startedAt?: string; finishedAt?: string;
  stepCount: number; stepErrors: number;
}
export interface BrainHealth {
  reflectionCounts: {
    success: number; cancelledTooShort: number; cancelledLowImportance: number;
    cancelledAlreadyReflected: number; cancelledDisabled: number; extractorFailed: number; error: number;
  };
  recursiveReflection: { runs: number; lastOutcome?: string; patternsWrittenTotal: number };
  factImportance: { sample: number; avg?: number; p50?: number; p90?: number };
  factDepth: { atomic: number; depthOne: number; depthTwo: number };
}
export interface ToolChoiceHealth {
  recalls: number; hits: number; fuzzyHits: number; misses: number;
  hitRatePct: number; remembers: number; invalidations: number;
}
export interface ObservatoryReport {
  generatedAt: string; windowStart: string; windowEnd: string;
  toolHealth: ToolHealth[]; workflowRuns: WorkflowRunSummary[];
  sessionCount: number; totalToolCalls: number; suggestions: string[];
  brainHealth?: BrainHealth; toolChoiceHealth?: ToolChoiceHealth;
}
export interface RefinementCandidate { id: number; kind: string; content: string; importance: number | null; meta?: string }
export interface DuplicatePair { kind: string; keepId: number; dropId: number; similarity: number; keep: string; drop: string }
export interface MemoryRefinements {
  duplicates: { count: number; capped: boolean; pairs: DuplicatePair[] };
  internalNoise: { count: number; byTool: Array<{ tool: string; count: number }>; examples: RefinementCandidate[] };
  syntheticJunk: { count: number; examples: RefinementCandidate[] };
  stale: { count: number; examples: RefinementCandidate[] };
  recallGaps: { count: number; examples: RefinementCandidate[] };
  totalCandidates: number;
  generatedAt: string;
}
export interface AutoCleanResult {
  ran: boolean;
  pruned: number;
  ids: number[];
  examples: Array<{ id: number; content: string; signature: string }>;
  cap: number;
  dryRun: boolean;
  reason?: string;
}
export interface AutoresearchReportResponse {
  report: ObservatoryReport | null;
  memoryRefinements?: MemoryRefinements | null;
  latest?: { path: string; date: string; content: string } | null;
  history: Array<{ date: string; path: string }>;
}
export interface AutoresearchRunResponse {
  written?: boolean; reason?: string; report: ObservatoryReport; content?: string;
  improvementProposals?: { ran: boolean; added: number; total: number } | null;
}

export type HarnessAuditStatus = 'pass' | 'warn' | 'fail';
export interface HarnessAuditCheck {
  id: string;
  title: string;
  status: HarnessAuditStatus;
  detail: string;
  impact: 'low' | 'medium' | 'high';
}
export interface HarnessAuditSection {
  id: 'tools' | 'workflows' | 'approvals' | 'agents' | 'learning';
  title: string;
  score: number;
  checks: HarnessAuditCheck[];
}
export interface HarnessAuditSnapshot {
  generatedAt: string;
  score: number;
  summary: { pass: number; warn: number; fail: number };
  sections: HarnessAuditSection[];
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
export interface AgentSystemTrendSeriesPoint {
  at: string;
  swarmReadinessScore: number;
  loopEffectivenessScore: number;
  interventionScore: number;
  workflowRecallHitRatePct: number;
  workerCapRatePct: number;
  blockedAgents: number;
  itemFailures: number;
  healthScore: number;
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
  strengths: string[];
  risks: string[];
  recommendation: string;
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

export const getAutoresearchReport = () => apiGet<AutoresearchReportResponse>('/api/console/autoresearch/report');
export const runAutoresearch = () => apiPost<AutoresearchRunResponse>('/api/console/autoresearch/run');
export const runMemoryCleanup = () => apiPost<AutoCleanResult>('/api/console/autoresearch/memory-cleanup');
export const getHarnessAudit = () => apiGet<HarnessAuditSnapshot>('/api/console/harness/audit');
export const getAgentSystemMetrics = () => apiGet<AgentSystemMetrics>('/api/console/agent-system/metrics');

// ─── Human-gated self-improvement proposals ────────────────────────────────
export type ImprovementKind = 'tool_desc' | 'skill_pitfall' | 'retire_fact' | 'workflow_step';
export type ImprovementStatus = 'pending' | 'approved' | 'applied' | 'dismissed';
export type ImprovementApplyMode = 'auto' | 'manual';
export interface ImprovementProposal {
  id: string;
  kind: ImprovementKind;
  target: string;
  proposedText: string;
  rationale: string;
  evidence: string;
  applyMode: ImprovementApplyMode;
  status: ImprovementStatus;
  proposedAt: string;
  appliedAt?: string;
}
export interface ImprovementProposalResponse {
  enabled: boolean;
  proposals: ImprovementProposal[];
}
export interface ApplyImprovementResult {
  ok: boolean;
  status: ImprovementStatus;
  applied: number;
  dryRun: boolean;
  reason?: 'disabled' | 'not-found' | 'already' | 'manual-acknowledged' | 'apply-failed';
}
export interface DismissImprovementResult { ok: boolean; status?: ImprovementStatus; reason?: 'not-found' | 'already' }

export const getImprovementProposals = () =>
  apiGet<ImprovementProposalResponse>('/api/console/autoresearch/improvements');
export const approveImprovementProposal = (id: string) =>
  apiPost<ApplyImprovementResult>('/api/console/autoresearch/improvements/approve', { id });
export const dismissImprovementProposal = (id: string) =>
  apiPost<DismissImprovementResult>('/api/console/autoresearch/improvements/dismiss', { id });

// ─── P2 — one-click approvals for knowledge-touching refinements ────────────
export interface ApproveResult {
  ran: boolean;
  applied: number;
  ids: number[];
  skipped: Array<{ id: number; reason: string }>;
  examples: Array<{ id: number; content: string; note?: string }>;
  cap: number;
  remaining: number;
  dryRun: boolean;
  class: string;
  reason?: string;
}
export const approveDuplicates = (pairs: Array<{ keepId: number; dropId: number }>) =>
  apiPost<ApproveResult>('/api/console/autoresearch/memory-approve/duplicates', { pairs });
export const liftRecallGaps = () =>
  apiPost<ApproveResult>('/api/console/autoresearch/memory-approve/recall-gaps');
export const retireInternalNoise = () =>
  apiPost<ApproveResult>('/api/console/autoresearch/memory-approve/internal-noise');

export const fmtNum = (n?: number) => (typeof n === 'number' ? n.toLocaleString() : '—');
export const fmtPct = (n?: number) => (typeof n === 'number' ? `${Math.round(n)}%` : '—');
export const fmtWhen = (iso?: string) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
