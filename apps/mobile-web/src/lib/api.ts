/**
 * Minimal fetch wrapper. All requests go same-origin (the PWA is
 * served by the Clementine daemon at /m/), so the PIN cookie set by
 * /m/auth/login is sent automatically. No Bearer token plumbing.
 *
 * 401 from any request triggers a global "needs login" event; the App
 * shell listens and bounces the user back to the login screen.
 */

export interface ApiError extends Error {
  status: number;
  body?: unknown;
}

function makeError(status: number, body?: unknown, message?: string): ApiError {
  const error = new Error(message ?? `HTTP ${status}`) as ApiError;
  error.status = status;
  error.body = body;
  return error;
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const opts: RequestInit = {
    credentials: 'same-origin',
    ...init,
    headers: {
      'accept': 'application/json',
      ...(init?.body && !(init.headers as Record<string, string> | undefined)?.['content-type']
        ? { 'content-type': 'application/json' }
        : {}),
      ...(init?.headers ?? {}),
    },
  };
  const res = await fetch(path, opts);
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (res.status === 401) {
    window.dispatchEvent(new Event('clem:needs-login'));
    throw makeError(401, body, 'Not authenticated');
  }
  if (!res.ok) {
    const message =
      (body && typeof body === 'object' && body !== null && 'error' in body && typeof (body as Record<string, unknown>).error === 'string')
        ? String((body as Record<string, unknown>).error)
        : `HTTP ${res.status}`;
    throw makeError(res.status, body, message);
  }
  return body as T;
}

export interface AuthStatus {
  pinConfigured: boolean;
  pinUpdatedAt: string | null;
  authenticated: boolean;
  deviceId: string | null;
  deviceLabel: string | null;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  return api<AuthStatus>('/m/auth/status');
}

export interface LoginResponse {
  deviceId: string;
  deviceLabel?: string;
  expiresAt: string;
}

export async function login(pin: string, deviceLabel?: string): Promise<LoginResponse> {
  return api<LoginResponse>('/m/auth/login', {
    method: 'POST',
    body: JSON.stringify({ pin, deviceLabel }),
  });
}

export async function pairDevice(pairToken: string, deviceLabel?: string): Promise<LoginResponse> {
  return api<LoginResponse>('/m/auth/pair', {
    method: 'POST',
    body: JSON.stringify({ pairToken, deviceLabel }),
  });
}

export async function logout(): Promise<void> {
  await api('/m/auth/logout', { method: 'POST' });
}

// ─── inbox shape (shape mirrors src/runtime/harness/approval-registry.ts) ─

export interface ApprovalRow {
  approvalId: string;
  sessionId: string;
  channel: string | null;
  channelId: string | null;
  requestedAt: string;
  expiresAt: string;
  subject: string;
  tool: string | null;
  args: unknown;
  status: 'pending' | 'resolved' | 'expired' | 'cancelled';
  resolution: 'approved' | 'rejected' | 'expired' | 'cancelled_by_user' | null;
  kind?: 'harness' | 'runtime';
  resourceFingerprint?: { warning?: string };
}

export interface ApprovalsListResponse {
  approvals: ApprovalRow[];
  count: number;
}

export async function listApprovals(): Promise<ApprovalsListResponse> {
  return api<ApprovalsListResponse>('/api/console/approvals/list');
}

export async function approveApproval(id: string, modifiedArgs?: string): Promise<unknown> {
  return api(`/api/console/harness-approvals/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body: modifiedArgs ? JSON.stringify({ modifiedArgs }) : undefined,
  });
}
export async function rejectApproval(id: string): Promise<unknown> {
  return api(`/api/console/harness-approvals/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
  });
}

// ─── plan approvals ─

export interface PlanProposalRow {
  id: string;
  proposedAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  objective: string;
  context: string | null;
  complexity: 'trivial' | 'moderate' | 'significant' | 'large';
  steps: Array<{ n: number; action: string; rationale: string; verification: string | null }>;
  successCriteria: string[];
  risks: string[];
  needsUserInput: string[];
  appliedInstructions: string[];
}

export interface PlanProposalsListResponse {
  proposals: PlanProposalRow[];
  count: number;
}

export async function listPlanProposals(): Promise<PlanProposalsListResponse> {
  return api<PlanProposalsListResponse>('/m/api/plan-proposals');
}

export async function approvePlanProposal(id: string): Promise<unknown> {
  return api(`/m/api/plan-proposals/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
  });
}

export async function rejectPlanProposal(id: string): Promise<unknown> {
  return api(`/m/api/plan-proposals/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'Rejected from mobile.' }),
  });
}

// ─── recent runs ─

export interface RunSummary {
  id: string;
  sessionId: string;
  title: string;
  status: 'received' | 'running' | 'queued' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

// ─── push subscription ─

export interface VapidKey { publicKey: string }
export async function getVapidPublicKey(): Promise<string> {
  const result = await api<VapidKey>('/m/push/vapid-key');
  return result.publicKey;
}

export async function registerPushSubscription(subscription: PushSubscription): Promise<{ destinationId: string }> {
  const json = subscription.toJSON();
  return api<{ ok: true; destinationId: string }>('/m/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: json.keys,
      expirationTime: json.expirationTime ?? null,
    }),
  });
}

export async function unregisterPushSubscription(endpoint?: string): Promise<{ removed: number }> {
  return api<{ ok: true; removed: number }>('/m/push/unsubscribe', {
    method: 'POST',
    body: endpoint ? JSON.stringify({ endpoint }) : '{}',
  });
}

// ─── chat (read-only) ─

export type SessionStatus = 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface ChatSession {
  id: string;
  title: string;
  kind: 'chat' | 'execution' | 'workflow' | 'agent';
  channel: string | null;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
}

export interface ChatEvent {
  seq: number;
  id: string;
  turn: number;
  role: string;
  type: string;
  createdAt: number;
  data: Record<string, unknown>;
}

export async function listChatSessions(): Promise<{ sessions: ChatSession[] }> {
  return api<{ sessions: ChatSession[] }>('/m/api/chat/sessions');
}

export async function getChatSession(id: string): Promise<{ session: ChatSession; events: ChatEvent[]; latestSeq: number }> {
  return api<{ session: ChatSession; events: ChatEvent[]; latestSeq: number }>(`/m/api/chat/sessions/${encodeURIComponent(id)}`);
}

export interface ChatSendResult {
  sessionId: string;
  runId?: string;
  reply: string;
  pendingApprovalId?: string;
  queuedTaskId?: string;
  stoppedReason?: string;
  turnsUsed?: number;
}

/**
 * Generate an idempotency key for a single send. The PWA stores the
 * key with the in-flight message so a network retry / app reopen sends
 * the same key and the daemon replays the cached response instead of
 * re-running the tool calls.
 */
export function freshIdempotencyKey(): string {
  // Use crypto.randomUUID where available (modern browsers).
  if ('crypto' in globalThis && 'randomUUID' in globalThis.crypto) {
    return globalThis.crypto.randomUUID();
  }
  // Fallback: timestamp + random bytes hex.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function sendChatMessage(
  input: { message: string; sessionId?: string; idempotencyKey: string },
): Promise<ChatSendResult> {
  return api<ChatSendResult>('/m/api/chat/send', {
    method: 'POST',
    headers: { 'idempotency-key': input.idempotencyKey },
    body: JSON.stringify({
      message: input.message,
      sessionId: input.sessionId,
    }),
  });
}

/** Wrap EventSource so callers get an unsubscribe and typed event payloads. */
export interface ChatStreamHandlers {
  onReplay?: (payload: { sessionId: string; sessionStatus: SessionStatus; events: ChatEvent[] }) => void;
  onEvent?: (event: ChatEvent) => void;
  onError?: (err: Event) => void;
}

export function subscribeChatStream(sessionId: string, handlers: ChatStreamHandlers, sinceSeq = 0): () => void {
  const url = `/m/api/chat/sessions/${encodeURIComponent(sessionId)}/stream${sinceSeq > 0 ? `?sinceSeq=${sinceSeq}` : ''}`;
  const es = new EventSource(url, { withCredentials: true });
  if (handlers.onReplay) {
    es.addEventListener('replay', (ev) => {
      try {
        const parsed = JSON.parse((ev as MessageEvent).data);
        handlers.onReplay?.(parsed);
      } catch { /* ignore */ }
    });
  }
  if (handlers.onEvent) {
    es.addEventListener('event', (ev) => {
      try {
        const parsed = JSON.parse((ev as MessageEvent).data);
        handlers.onEvent?.(parsed);
      } catch { /* ignore */ }
    });
  }
  if (handlers.onError) es.addEventListener('error', handlers.onError);
  return () => es.close();
}

// ─── memory ─

export interface MemoryHit {
  path: string;
  title: string;
  snippet: string;
  score: number;
}

export async function searchMemory(query: string, limit = 20): Promise<{ query: string; hits: MemoryHit[] }> {
  const url = `/m/api/memory/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  return api<{ query: string; hits: MemoryHit[] }>(url);
}

export interface MemoryFact {
  id: number;
  kind: 'user' | 'project' | 'feedback' | 'reference';
  content: string;
  importance: number | null;
  updatedAt: string;
  lastAccessedAt: string | null;
  pinned?: boolean;
}

export async function listFacts(kind?: MemoryFact['kind'], limit = 60): Promise<{ facts: MemoryFact[] }> {
  const params = new URLSearchParams();
  if (kind) params.set('kind', kind);
  params.set('limit', String(limit));
  return api<{ facts: MemoryFact[] }>(`/m/api/memory/facts?${params.toString()}`);
}

// ─── workflows ─

export interface MobileWorkflow {
  name: string;
  description: string;
  enabled: boolean;
  stepCount: number;
  schedule: string | null;
  requiresInput: boolean;
  lastRunId: string | null;
  lastRunStatus: string | null;
  lastRunAt: string | null;
}

export async function listWorkflows(): Promise<{ workflows: MobileWorkflow[] }> {
  return api<{ workflows: MobileWorkflow[] }>('/m/api/workflows');
}

export interface WorkflowRunSummary {
  id: string;
  workflow: string;
  status: string;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  source: string | null;
  error: string | null;
}

export async function listWorkflowRuns(name: string, limit = 20): Promise<{ runs: WorkflowRunSummary[] }> {
  return api<{ runs: WorkflowRunSummary[] }>(`/m/api/workflows/${encodeURIComponent(name)}/runs?limit=${limit}`);
}

export async function runWorkflow(name: string): Promise<{ ok: true; runId: string; status: string }> {
  return api<{ ok: true; runId: string; status: string }>(`/m/api/workflows/${encodeURIComponent(name)}/run`, {
    method: 'POST',
    body: '{}',
  });
}

export interface WorkflowEventSummary {
  t: string;
  kind: string;
  stepId: string | null;
  error: string | null;
  outputPreview: string | null;
}

export async function getWorkflowRunEvents(name: string, runId: string, limit = 200): Promise<{
  runId: string;
  workflow: string;
  events: WorkflowEventSummary[];
}> {
  return api<{ runId: string; workflow: string; events: WorkflowEventSummary[] }>(
    `/m/api/workflows/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/events?limit=${limit}`,
  );
}

export async function listRecentRuns(limit = 20): Promise<{ runs: RunSummary[] }> {
  // The dashboard exposes recent runs via /api/runs which webhook.ts
  // serves alongside /api/console/*. Fall back to console/executions
  // if /api/runs is missing on older daemons.
  try {
    return await api<{ runs: RunSummary[] }>(`/api/runs?limit=${limit}`);
  } catch (err) {
    if ((err as ApiError).status === 404) {
      const fallback = await api<{ executions: RunSummary[] }>(`/api/console/executions?limit=${limit}`);
      return { runs: fallback.executions ?? [] };
    }
    throw err;
  }
}
