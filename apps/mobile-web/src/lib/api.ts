/**
 * Minimal fetch wrapper. All requests go same-origin (the PWA is
 * served by the Clementine daemon at /m/), so the session cookie is sent
 * automatically. No Bearer token plumbing.
 *
 * On top of the cookie, every request carries a device proof: a short ES256
 * signature made with a non-extractable key held in IndexedDB. The cookie alone
 * is not sufficient to authenticate, so copying it off the device gets an
 * attacker nothing. See lib/device-key.ts.
 *
 * 401 from any request triggers a global "needs login" event; the App
 * shell listens and bounces the user back to the login screen.
 */
import { signProof, deviceKeySupported, exportPublicJwk } from './device-key.js';

/**
 * The current session's fingerprint, which every proof is signed over.
 *
 * Held in memory only: it is derived from the session token, so it changes
 * whenever the token rotates, and persisting it would just create a staleness
 * bug. It is refreshed from /auth/status, /auth/login, and /auth/pair.
 */
let sessionFingerprint: string | null = null;

export function setSessionFingerprint(value: string | null): void {
  sessionFingerprint = value;
}

export function getSessionFingerprint(): string | null {
  return sessionFingerprint;
}

/** Paths that establish a credential and therefore cannot require a proof. */
function isPreAuthPath(path: string): boolean {
  const clean = path.split('?')[0] ?? '';
  return clean === '/m/auth/status'
    || clean === '/m/auth/login'
    || clean === '/m/auth/pair'
    || clean === '/m/auth/logout'
    || clean === '/m/auth/device-key'
    || clean === '/m/push/vapid-key';
}

async function proofHeader(path: string, method: string): Promise<Record<string, string>> {
  if (!sessionFingerprint || !deviceKeySupported() || isPreAuthPath(path)) return {};
  try {
    return { 'x-clem-device-proof': await signProof(method, path, sessionFingerprint) };
  } catch {
    // A signing failure must not silently downgrade to cookie-only auth; let
    // the request go and be refused by the daemon, which is the honest outcome.
    return {};
  }
}

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
  Object.assign(
    opts.headers as Record<string, string>,
    await proofHeader(path, (init?.method ?? 'GET').toUpperCase()),
  );
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
  binding?: 'key' | 'cookie' | null;
  scope?: 'full' | 'pin-rotation' | null;
  needsDeviceUpgrade?: boolean;
  sessionFingerprint?: string | null;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const status = await api<AuthStatus>('/m/auth/status');
  if (status.sessionFingerprint) setSessionFingerprint(status.sessionFingerprint);
  // A session that predates device binding upgrades itself here, with no user
  // interaction and no re-pair. Best-effort: a failure just leaves it
  // cookie-bound until the next status poll, and it keeps working until its
  // grace window ends.
  if (status.authenticated && status.needsDeviceUpgrade && deviceKeySupported()) {
    await upgradeToDeviceKey().catch(() => undefined);
  }
  return status;
}

export interface LoginResponse {
  deviceId: string;
  deviceLabel?: string;
  expiresAt: string;
  binding?: 'key' | 'cookie';
  sessionFingerprint?: string;
}

/** Captures the fingerprint a credential response hands back. */
function adoptSession(res: LoginResponse): LoginResponse {
  if (res.sessionFingerprint) setSessionFingerprint(res.sessionFingerprint);
  return res;
}

/**
 * The device public key is offered at credential time so a fresh pair is
 * key-bound immediately, with no window in which the cookie alone suffices.
 */
async function devicePublicKeyOrUndefined(): Promise<JsonWebKey | undefined> {
  if (!deviceKeySupported()) return undefined;
  try {
    return await exportPublicJwk();
  } catch {
    return undefined;
  }
}

export async function login(pin: string, deviceLabel?: string): Promise<LoginResponse> {
  const devicePublicKeyJwk = await devicePublicKeyOrUndefined();
  return adoptSession(await api<LoginResponse>('/m/auth/login', {
    method: 'POST',
    body: JSON.stringify({ pin, deviceLabel, devicePublicKeyJwk }),
  }));
}

export async function pairDevice(pairToken: string, deviceLabel?: string): Promise<LoginResponse> {
  const devicePublicKeyJwk = await devicePublicKeyOrUndefined();
  return adoptSession(await api<LoginResponse>('/m/auth/pair', {
    method: 'POST',
    body: JSON.stringify({ pairToken, deviceLabel, devicePublicKeyJwk }),
  }));
}

/** Binds a device key to an existing cookie-only session and rotates its token. */
export async function upgradeToDeviceKey(): Promise<void> {
  const devicePublicKeyJwk = await exportPublicJwk();
  const res = await api<{ sessionFingerprint?: string }>('/m/auth/device-key', {
    method: 'POST',
    body: JSON.stringify({ devicePublicKeyJwk }),
  });
  if (res.sessionFingerprint) setSessionFingerprint(res.sessionFingerprint);
}

export async function logout(): Promise<void> {
  await api('/m/auth/logout', { method: 'POST' });
  setSessionFingerprint(null);
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
  return api<ApprovalsListResponse>('/m/api/approvals');
}

export async function approveApproval(id: string, modifiedArgs?: string): Promise<unknown> {
  if (modifiedArgs) {
    throw new Error('Mobile approval editing is not supported yet.');
  }
  return api(`/m/api/approvals/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
  });
}
export async function rejectApproval(id: string): Promise<unknown> {
  return api(`/m/api/approvals/${encodeURIComponent(id)}/reject`, {
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

/**
 * EventSource cannot set request headers, so a stream cannot carry the device
 * proof directly. Instead we spend one proof-authenticated POST to mint a
 * single-use 60-second ticket and put only that opaque value in the URL, which
 * keeps signatures out of access logs and browser history.
 */
async function mintStreamTicket(streamPath: string): Promise<string | null> {
  if (!sessionFingerprint || !deviceKeySupported()) return null;
  try {
    const res = await api<{ ticket: string }>('/m/auth/stream-ticket', {
      method: 'POST',
      body: JSON.stringify({ path: streamPath }),
    });
    return res.ticket;
  } catch {
    return null;
  }
}

export function subscribeChatStream(sessionId: string, handlers: ChatStreamHandlers, sinceSeq = 0): () => void {
  const streamPath = `/m/api/chat/sessions/${encodeURIComponent(sessionId)}/stream`;
  let es: EventSource | null = null;
  let closed = false;

  void (async () => {
    const ticket = await mintStreamTicket(streamPath);
    if (closed) return;
    const params = new URLSearchParams();
    if (sinceSeq > 0) params.set('sinceSeq', String(sinceSeq));
    if (ticket) params.set('ticket', ticket);
    const query = params.toString();
    attach(new EventSource(`${streamPath}${query ? `?${query}` : ''}`, { withCredentials: true }));
  })();

  function attach(source: EventSource): void {
    if (closed) { source.close(); return; }
    es = source;
    wire(source);
  }


  function wire(source: EventSource): void {
    if (handlers.onReplay) {
      source.addEventListener('replay', (ev) => {
        try {
          handlers.onReplay?.(JSON.parse((ev as MessageEvent).data));
        } catch { /* ignore */ }
      });
    }
    if (handlers.onEvent) {
      source.addEventListener('event', (ev) => {
        try {
          handlers.onEvent?.(JSON.parse((ev as MessageEvent).data));
        } catch { /* ignore */ }
      });
    }
    if (handlers.onError) source.addEventListener('error', handlers.onError);
  }

  return () => {
    closed = true;
    es?.close();
  };
}

// ─── memory ─

export interface MemoryHit {
  path: string;
  title: string;
  snippet: string;
  score: number;
  ref?: { type: 'fact' | 'entity' | 'resource' | 'episode' | 'note' | 'procedure' | 'policy'; id: string | number };
  confidence?: number;
  evidenceCount?: number;
  whyRecalled?: string[];
}

export interface MemorySearchResult {
  query: string;
  hits: MemoryHit[];
  answerability: 'supported' | 'partial' | 'insufficient';
  diagnostics: { candidates: number; stores: string[]; elapsedMs: number };
}

export async function searchMemory(query: string, limit = 20): Promise<MemorySearchResult> {
  const url = `/m/api/memory/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  return api<MemorySearchResult>(url);
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
  itemKey: string | null;
  error: string | null;
  meta: Record<string, unknown> | null;
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
