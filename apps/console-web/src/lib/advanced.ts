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
  stale: { count: number; examples: RefinementCandidate[] };
  recallGaps: { count: number; examples: RefinementCandidate[] };
  totalCandidates: number;
  generatedAt: string;
}
export interface AutoresearchReportResponse {
  report: ObservatoryReport | null;
  memoryRefinements?: MemoryRefinements | null;
  latest?: { path: string; date: string; content: string } | null;
  history: Array<{ date: string; path: string }>;
}
export interface AutoresearchRunResponse {
  written?: boolean; reason?: string; report: ObservatoryReport; content?: string;
}

export const getAutoresearchReport = () => apiGet<AutoresearchReportResponse>('/api/console/autoresearch/report');
export const runAutoresearch = () => apiPost<AutoresearchRunResponse>('/api/console/autoresearch/run');

export const fmtNum = (n?: number) => (typeof n === 'number' ? n.toLocaleString() : '—');
export const fmtPct = (n?: number) => (typeof n === 'number' ? `${Math.round(n)}%` : '—');
export const fmtWhen = (iso?: string) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
