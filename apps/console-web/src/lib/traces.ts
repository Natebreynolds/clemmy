import { apiGet, apiPost } from './api';

export type TraceNodeCategory =
  | 'user'
  | 'model'
  | 'tool'
  | 'external_write'
  | 'guardrail'
  | 'approval'
  | 'handoff'
  | 'memory'
  | 'plan'
  | 'workflow'
  | 'system';

export type TraceSeverity = 'debug' | 'info' | 'warn' | 'error';
export type TraceRiskLevel = 'none' | 'low' | 'medium' | 'high';
export type TraceKind = 'chat' | 'execution' | 'workflow' | 'agent';
export type TraceStatus = 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface TraceMetrics {
  events: number;
  turns: number;
  toolCalls: number;
  toolReturns: number;
  guardrails: number;
  approvalsRequested: number;
  approvalsResolved: number;
  handoffs: number;
  externalWrites: number;
  modelRoutes: number;
  memoryWrites: number;
  failures: number;
  durationMs?: number;
}

export interface TraceReplayStatus {
  ready: boolean;
  mode: 'safe_prompt';
  riskLevel: TraceRiskLevel;
  risks: string[];
}

export interface TraceSummary {
  sessionId: string;
  kind: TraceKind;
  status: TraceStatus;
  title?: string;
  objective?: string;
  startedAt: string;
  updatedAt: string;
  firstEventAt?: string;
  lastEventAt?: string;
  metrics: TraceMetrics;
  replay: TraceReplayStatus;
}

export interface TraceNode {
  id: string;
  seq: number;
  eventId: string;
  sessionId: string;
  turn: number;
  type: string;
  category: TraceNodeCategory;
  severity: TraceSeverity;
  label: string;
  detail: string;
  createdAt: string;
  parentId?: string;
  tool?: string;
  callId?: string;
  target?: string;
  dataPreview: string;
}

export interface TraceEdge {
  id: string;
  from: string;
  to: string;
  kind: 'temporal' | 'parent' | 'tool_result' | 'approval_resolution' | 'turn';
  label: string;
}

export interface TraceDetail extends TraceSummary {
  nodes: TraceNode[];
  edges: TraceEdge[];
  truncated: boolean;
}

export interface TraceReplayPreview {
  sessionId: string;
  generatedAt: string;
  mode: 'safe_prompt';
  ready: boolean;
  riskLevel: TraceRiskLevel;
  risks: string[];
  prompt: string;
  source: {
    events: number;
    nodesIncluded: number;
    truncated: boolean;
  };
}

export interface TraceQuery {
  limit?: number;
  kind?: TraceKind;
  status?: TraceStatus | 'any';
}

export function listTraces(opts: TraceQuery = {}) {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.kind) params.set('kind', opts.kind);
  if (opts.status) params.set('status', opts.status);
  const qs = params.toString();
  return apiGet<{ traces: TraceSummary[] }>(`/api/console/traces${qs ? `?${qs}` : ''}`);
}

export const getTrace = (sessionId: string) =>
  apiGet<{ trace: TraceDetail }>(`/api/console/traces/${encodeURIComponent(sessionId)}`);

export const getReplayPreview = (sessionId: string) =>
  apiPost<{ replay: TraceReplayPreview }>(`/api/console/traces/${encodeURIComponent(sessionId)}/replay-preview`);
