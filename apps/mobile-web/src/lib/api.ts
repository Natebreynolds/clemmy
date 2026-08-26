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
import { connectionDoor, reportConnectionLost, setConnectionDoor } from './native-bridge.js';

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
    // Adoption establishes the credential at a new origin — there is nothing
    // to sign with yet, exactly like pairing.
    || clean === '/m/auth/origin-adopt'
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
  /** True when the request never reached the daemon (radio off, out of
   *  range, Mac asleep). status is 0 — the caller can say "offline" instead
   *  of surfacing a raw TypeError as if it were a bug. */
  offline?: boolean;
}

function makeError(status: number, body?: unknown, message?: string): ApiError {
  const error = new Error(message ?? `HTTP ${status}`) as ApiError;
  error.status = status;
  error.body = body;
  return error;
}

export function isOfflineError(err: unknown): boolean {
  return Boolean((err as ApiError | undefined)?.offline);
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
  let res: Response;
  try {
    res = await fetch(path, opts);
  } catch {
    // A transport failure is a fact about the network, not about the request.
    // Reaching the daemon again is the recovery, so say so and let the shell
    // and the UI show one honest "can't reach your Mac" state.
    setConnectionDoor('offline');
    reportConnectionLost();
    const err = makeError(0, null, "Can't reach your Mac right now");
    err.offline = true;
    throw err;
  }
  // Any answer at all means the door is open again.
  if (connectionDoor() === 'offline') setConnectionDoor('direct');
  // Session tokens rotate every ~12h and the proof signs over a fingerprint
  // derived from the token. The rotation sets a new HttpOnly cookie the page
  // can't read, so the daemon also announces the new fingerprint in a
  // response header — fold it in or every later proof 401s (live: a paired
  // phone bounced to the login screen every 12 hours).
  const rotatedFp = res.headers.get('x-clem-session-fp');
  if (rotatedFp) sessionFingerprint = rotatedFp;
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (res.status === 401) {
    // ONE 401 IS NOT A SIGN-OUT (live 2026-08-26: a single rotation-race 401
    // among six healthy same-second requests bounced a paired phone to the
    // pairing screen). Verify before bouncing: ask /auth/status once — only a
    // confirmed dead session flips the app to the gate; a transient race
    // self-heals invisibly. Pre-auth paths keep the immediate signal (their
    // 401 IS the status).
    if (isPreAuthPath(path)) {
      window.dispatchEvent(new Event('clem:needs-login'));
    } else {
      void fetch('/m/auth/status', { credentials: 'include' })
        .then((probe) => (probe.ok ? probe.json() : { authenticated: false }))
        .then((status: { authenticated?: boolean }) => {
          if (!status?.authenticated) window.dispatchEvent(new Event('clem:needs-login'));
        })
        .catch(() => { /* unreachable daemon reads as offline, not sign-out */ });
    }
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

/**
 * Ask this (LAN) origin for a handoff token that the app can spend at the
 * relay origin. Cheap, single-use, short-lived — minted on every LAN visit so
 * a fresh one is always waiting when the phone leaves the house.
 */
export async function mintOriginHandoff(): Promise<{ token: string; expiresAt: number }> {
  return api('/m/auth/origin-handoff', { method: 'POST' });
}

/**
 * Spend a handoff token at THIS origin (the relay door) to establish the
 * session the browser cannot carry across origins. Same device identity, so
 * the phone stays one row in the desktop's device list.
 */
export async function adoptOriginSession(token: string): Promise<LoginResponse> {
  const devicePublicKeyJwk = await devicePublicKeyOrUndefined();
  return adoptSession(await api<LoginResponse>('/m/auth/origin-adopt', {
    method: 'POST',
    body: JSON.stringify({ token, devicePublicKeyJwk }),
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
  resolution: 'approved' | 'rejected' | 'expired' | 'cancelled_by_user' | 'cancelled_by_system' | null;
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

export interface WorkspaceDestinationChoice {
  choiceId: string;
  kind: 'existing' | 'create_new';
  label: string;
  workspaceId: string;
}

export interface WorkspaceDestinationChooser {
  version: 1;
  chooserId: string;
  advancementId: string;
  chooserRevision: number;
  chooserDigest: string;
  createdAt: string;
  choices: WorkspaceDestinationChoice[];
}

export async function listWorkspaceDestinationChoosers(): Promise<{
  choosers: WorkspaceDestinationChooser[];
  count: number;
}> {
  return api('/m/api/automation-pilot/workspace-choosers');
}

export async function resolveWorkspaceDestinationChooser(
  chooser: WorkspaceDestinationChooser,
  choiceId: string,
): Promise<unknown> {
  return api(`/m/api/automation-pilot/workspace-choosers/${encodeURIComponent(chooser.chooserId)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({
      chooserRevision: chooser.chooserRevision,
      chooserDigest: chooser.chooserDigest,
      choiceId,
    }),
  });
}

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
  status: 'received' | 'running' | 'queued' | 'awaiting_approval' | 'awaiting_input' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

/** One run as a readable object: what it did, what it touched, what it left. */
export interface RunDetail {
  id: string;
  title: string;
  status: string;
  kind: string;
  createdAt: string;
  updatedAt: string;
  startedAt: number | null;
  lastEventAt: number | null;
  events: ChatEvent[];
  /** External writes — what changed outside this machine. */
  receipts: Array<{
    at: number;
    kind: string;
    tool: string | null;
    shapeKey: string | null;
    targets: string[];
    irreversible: boolean | null;
  }>;
  /** Files the run produced. */
  deliverables: Array<{ at: number; name: string; dir: string | null; excerpt: string | null }>;
}

export async function getRun(sessionId: string): Promise<RunDetail> {
  return api(`/m/api/runs/${encodeURIComponent(sessionId)}`);
}

// ─── server-owned running work ─────────────────────────────────────────────
//
// This is the mobile-authenticated spelling of /api/console/activity/v2. The
// daemon owns membership, liveness, lifecycle, and all denominators; the phone
// only renders these bounded fields and never folds raw events into task truth.

export type ActivityKind = 'chat' | 'background' | 'workflow' | 'fanout';

export interface ActivityEntry {
  schemaVersion: number;
  runKey: string;
  attemptId: string;
  kind: ActivityKind;
  lifecycle: string;
  liveness: 'live' | 'stale' | 'unknown';
  needsAttention: boolean;
  headline: string;
  activity?: { phase: string; text: string; completed?: number; total?: number };
  progress?: { completed: number; total: number };
  children?: { running: number; completed: number; failed: number; total: number };
  startedAt: string;
  lastEvidenceAt: string;
  revision: number;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  planId?: string;
}

export interface ActivityResponse {
  schemaVersion: number;
  observedAt: string;
  entries?: ActivityEntry[];
  snapshots?: ActivityEntry[];
}

export function workingNowSnapshotFromResponse(
  body: ActivityResponse,
): { observedAt: string; entries: ActivityEntry[] } {
  return { observedAt: body.observedAt, entries: body.entries ?? body.snapshots ?? [] };
}

export async function listWorkingNow(): Promise<{ observedAt: string; entries: ActivityEntry[] }> {
  const body = await api<ActivityResponse>('/m/api/activity/v2?workingNow=1');
  // The daemon already bounds this projection. Preserve that full set so the
  // quiet foreground count cannot disagree with the rows the server returned;
  // the sheet applies its own, separate render cap.
  return workingNowSnapshotFromResponse(body);
}

/** One shared mobile classification so Home and Activity cannot drift. */
export const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'queued',
  'received',
  'awaiting_approval',
  'awaiting_input',
]);

export function isActiveRunStatus(status: string): boolean {
  return ACTIVE_RUN_STATUSES.has(status);
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

/** Native shell only: registers the iOS APNs device token over this session. */
export async function registerApnsToken(deviceToken: string): Promise<{ destinationId: string }> {
  return api<{ ok: true; destinationId: string }>('/m/push/apns', {
    method: 'POST',
    body: JSON.stringify({ deviceToken }),
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

/**
 * Async-accepted send: resolves on the durable claim (202) and lets the reply
 * ride the event stream. A phone must never hold a fetch open across a whole
 * turn — the webview suspends on lock and the connection dies with it while
 * the accepted run keeps going.
 */
export async function sendChatMessageAsync(
  input: { message: string; sessionId?: string | null; idempotencyKey: string },
): Promise<{ accepted: boolean; sessionId: string; runId: string; sinceSeq: number }> {
  return api('/m/api/chat/send', {
    method: 'POST',
    headers: { 'idempotency-key': input.idempotencyKey },
    body: JSON.stringify({
      message: input.message,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      async: true,
    }),
  });
}

/** Cursor catch-up over plain fetch auth — the stream-death recovery path. */
export async function fetchRecentChatEvents(
  sessionId: string,
  sinceSeq: number,
): Promise<{ sessionId: string; sessionStatus: string; events: ChatEvent[]; latestSeq: number }> {
  const params = sinceSeq > 0 ? `?sinceSeq=${sinceSeq}` : '';
  return api(`/m/api/chat/sessions/${encodeURIComponent(sessionId)}/events/recent${params}`);
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

/**
 * The chat-engine's stream transport.
 *
 * Every connect() mints a FRESH single-use ticket — the class this kills:
 * EventSource's built-in retry re-uses the original URL, and a spent ticket
 * 401s, so the browser's own reconnection was guaranteed dead after the
 * first drop. The engine owns all retrying; this layer opens exactly one
 * connection per call and reports the first error.
 */
export function createChatStreamTransport(): {
  connect(opts: {
    sessionId: string;
    sinceSeq: number;
    onReplay(payload: { events: ChatEvent[]; latestSeq?: number }): void;
    onEvent(event: ChatEvent): void;
    onError(): void;
  }): Promise<{ close(): void }>;
  fetchRecent(sessionId: string, sinceSeq: number): Promise<{ events: ChatEvent[]; latestSeq?: number }>;
} {
  return {
    async connect(opts) {
      const streamPath = `/m/api/chat/sessions/${encodeURIComponent(opts.sessionId)}/stream`;
      const ticket = await mintStreamTicket(streamPath);
      const params = new URLSearchParams();
      if (opts.sinceSeq > 0) params.set('sinceSeq', String(opts.sinceSeq));
      if (ticket) params.set('ticket', ticket);
      const query = params.toString();
      const source = new EventSource(`${streamPath}${query ? `?${query}` : ''}`, { withCredentials: true });
      let settled = false;
      source.addEventListener('replay', (ev) => {
        try { opts.onReplay(JSON.parse((ev as MessageEvent).data)); } catch { /* ignore */ }
      });
      source.addEventListener('event', (ev) => {
        try { opts.onEvent(JSON.parse((ev as MessageEvent).data)); } catch { /* ignore */ }
      });
      source.addEventListener('error', () => {
        // Close immediately: letting EventSource retry its (now spent-ticket)
        // URL just burns a 401 before dying anyway.
        if (settled) return;
        settled = true;
        source.close();
        opts.onError();
      });
      return {
        close: () => {
          settled = true;
          source.close();
        },
      };
    },
    fetchRecent: (sessionId, sinceSeq) => fetchRecentChatEvents(sessionId, sinceSeq),
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

/** Full fact detail — evidence, validity history, policy. Mirrors the
 *  desktop fact card's data. */
export interface MemoryFactDetail extends MemoryFact {
  active?: boolean;
  confidence?: number | null;
  trustLevel?: number | null;
  derivedFrom?: string | null;
  supersededByFactId?: number | null;
  utilityCount?: number | null;
  impressionCount?: number | null;
  evidence?: Array<{ id?: number; sourceUri?: string | null; snippet?: string | null; observedAt?: string | null; [k: string]: unknown }>;
  validityIntervals?: Array<{ validFrom?: string | null; validTo?: string | null; content?: string | null; [k: string]: unknown }>;
}

export async function getFactDetail(id: number): Promise<{ fact: MemoryFactDetail; policy: Record<string, unknown> | null }> {
  return api(`/m/api/memory/facts/${id}`);
}

export async function pinFact(id: number, pinned: boolean): Promise<{ ok: boolean; pinned: boolean }> {
  return api(`/m/api/memory/facts/${id}/pin`, { method: 'POST', body: JSON.stringify({ pinned }) });
}

export async function forgetFact(id: number): Promise<{ ok: boolean }> {
  return api(`/m/api/memory/facts/${id}/forget`, { method: 'POST' });
}

export async function restoreFact(id: number): Promise<{ ok: boolean }> {
  return api(`/m/api/memory/facts/${id}/restore`, { method: 'POST' });
}

/** A content change SUPERSEDES the fact (new id, history preserved). */
export async function correctFact(id: number, patch: { content?: string; importance?: number }): Promise<{ ok: boolean; fact: MemoryFact; supersededFactId: number | null }> {
  return api(`/m/api/memory/facts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function addFact(input: { kind: MemoryFact['kind']; content: string }): Promise<{ fact: MemoryFact | null; consolidation: { action: string; supersededFactId: number | null } }> {
  return api('/m/api/memory/facts', { method: 'POST', body: JSON.stringify(input) });
}

export interface MemoryEntity {
  id: number;
  entityType: string;
  canonicalName: string;
  aliases: string[];
  lastSeenAt: string;
  mentionCount: number;
  factCount: number;
  groundedFactCount: number;
  observationCount: number;
}

export async function listEntities(options?: { type?: string; q?: string; limit?: number }): Promise<{ entities: MemoryEntity[]; total: number }> {
  const params = new URLSearchParams();
  if (options?.type) params.set('type', options.type);
  if (options?.q) params.set('q', options.q);
  params.set('limit', String(options?.limit ?? 100));
  return api(`/m/api/memory/entities?${params.toString()}`);
}

export async function getEntityDetail(id: number): Promise<Record<string, unknown>> {
  return api(`/m/api/memory/entities/${id}`);
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
  lastRunOutcome: 'succeeded' | 'partial' | 'blocked' | 'failed' | 'cancelled' | null;
  lastRunAt: string | null;
}

export async function listWorkflows(): Promise<{ workflows: MobileWorkflow[] }> {
  return api<{ workflows: MobileWorkflow[] }>('/m/api/workflows');
}

export interface WorkflowRunSummary {
  id: string;
  workflow: string;
  status: string;
  terminalOutcome?: 'succeeded' | 'partial' | 'blocked' | 'failed' | 'cancelled';
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  source: string | null;
  error: string | null;
}

export async function listWorkflowRuns(name: string, limit = 20): Promise<{ runs: WorkflowRunSummary[] }> {
  return api<{ runs: WorkflowRunSummary[] }>(`/m/api/workflows/${encodeURIComponent(name)}/runs?limit=${limit}`);
}

export async function runWorkflow(name: string, inputs?: Record<string, string>): Promise<{ ok: true; runId: string; status: string }> {
  return api<{ ok: true; runId: string; status: string }>(`/m/api/workflows/${encodeURIComponent(name)}/run`, {
    method: 'POST',
    body: JSON.stringify(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
  });
}

/** The FULL workflow: plain-English summary, certified steps, inputs schema. */
export interface WorkflowDetailInfo {
  name: string;
  description: string;
  enabled: boolean;
  schedule: string | null;
  stepCount: number;
  inputs: Array<{ key: string; description: string; required: boolean; example: string | null }>;
  summary: string;
  steps: Array<{ stepId: string; label: string; executor: string | null; effect: string | null; gated: boolean }>;
  certification: { verdict: unknown; missingInputs: unknown } | null;
  /** What this flow touches — the question behind "is it safe to run". */
  effects?: { reads: number; writes: number; sends: number; approvals: string[]; tools: string[] };
  /** The bar every run is judged against, in the workflow's own words. */
  qualityCriteria?: string[];
  /** How the last few runs actually went. */
  trackRecord?: { succeeded: number; of: number } | null;
}

export async function getWorkflowDetail(name: string): Promise<WorkflowDetailInfo> {
  return api(`/m/api/workflows/${encodeURIComponent(name)}`);
}

export interface WorkflowEventSummary {
  t: string;
  kind: string;
  stepId: string | null;
  itemKey: string | null;
  error: string | null;
  meta: Record<string, unknown> | null;
  outputPreview: string | null;
  /** Present only when the events were fetched with { full: true }. */
  output?: string | null;
}

export async function getWorkflowRunEventsFull(name: string, runId: string, limit = 500): Promise<{
  runId: string;
  workflow: string;
  status: string | null;
  terminalOutcome: string | null;
  events: WorkflowEventSummary[];
}> {
  return api(
    `/m/api/workflows/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/events?limit=${limit}&full=1`,
  );
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
  return api<{ runs: RunSummary[] }>(`/m/api/runs?limit=${limit}`);
}

// ─── memory graph (the constellation) ─

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  /** Optional PCA seed positions from the daemon's semantic layout. */
  fx?: number;
  fy?: number;
  fz?: number;
  data?: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
  weight?: number;
}

export interface MemoryGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export async function getMemoryGraph(): Promise<MemoryGraph> {
  return api<MemoryGraph>('/m/api/memory/graph');
}

export async function getMemoryNeighborhood(nodeId: string, depth: 1 | 2 = 1): Promise<MemoryGraph> {
  return api<MemoryGraph>(`/m/api/memory/neighborhood?nodeId=${encodeURIComponent(nodeId)}&depth=${depth}`);
}

// ─── reminders (what Clem has committed to do later) ─

export interface ReminderItem {
  id: string;
  kind: 'reminder' | 'intention';
  text: string;
  at: string | null;
  recurring: boolean;
  status?: string;
}

export async function getReminders(): Promise<{ items: ReminderItem[] }> {
  return api<{ items: ReminderItem[] }>('/m/api/reminders');
}

// ─── run control (away-from-desk) ─
//
// The same daemon verbs the desktop uses. Deliberately no "pause": nothing in
// the system can suspend in-flight work and resume it later, so the phone
// offers Stop (and Resume for work that already stopped) and says so plainly.

export async function cancelWorkflowRun(name: string, runId: string): Promise<{ ok: true; outcome: string }> {
  return api<{ ok: true; outcome: string }>(
    `/m/api/workflows/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST' },
  );
}

export async function cancelRun(runId: string): Promise<{ ok: boolean; message: string }> {
  return api<{ ok: boolean; message: string }>(`/m/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
}

/** Stop the LIVE chat turn for a session — the exact-attempt primitive the
 *  desktop uses. attemptId is required and stale-checked server-side, so a
 *  stale tap can never widen into a session-wide kill. */
export async function cancelChatTurn(sessionId: string, attemptId: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/m/api/chat/sessions/${encodeURIComponent(sessionId)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attemptId }),
  });
}

export async function controlTask(taskId: string, action: 'cancel' | 'resume'): Promise<{ ok: true; status: string }> {
  return api<{ ok: true; status: string }>(`/m/api/tasks/${encodeURIComponent(taskId)}/${action}`, { method: 'POST' });
}

// ─── workspaces ─
//
// The authored workspace view is loopback-only (agent-written JS never leaves
// the Mac), so the phone reads a server-side projection of the same data.

export interface WorkspaceSummary {
  id: string;
  title: string;
  status: 'active' | 'paused' | 'archived';
  objective: string | null;
  updatedAt: string;
  lastRefreshedAt: string | null;
  freshness: string;
  issues: string[];
  /** How many records the phone would show. 0 = nothing to look at yet. */
  rows?: number;
  hasSummary?: boolean;
  /** Whether this belongs on the phone, decided by the daemon. */
  onPhone?: boolean;
  presence?: 'pinned' | 'hidden' | 'has-content' | 'empty-draft';
  /** The owner's explicit answer, when they gave one. */
  showPreference?: boolean | null;
}

/** Keep a workspace on the phone, banish it, or (null) go back to automatic. */
export async function setWorkspaceMobile(id: string, show: boolean | null): Promise<{ ok: true; showPreference: boolean | null }> {
  return api(`/m/api/workspaces/${encodeURIComponent(id)}/mobile`, {
    method: 'POST',
    body: JSON.stringify(show === null ? {} : { show }),
  });
}

export interface WorkspaceField { label: string; value: string }
export interface WorkspaceRecord { key: string; primary: string; fields: WorkspaceField[] }
export interface WorkspaceBreakdown {
  label: string;
  entries: Array<{ label: string; value: string; ratio: number }>;
}

export interface WorkspaceDetail extends WorkspaceSummary {
  successCriteria?: string[];
  invariants?: string[];
  linkedWorkflows?: Array<{ name: string; description: string; enabled: boolean }>;
  sources: Array<{ id: string; ok: boolean; refreshedAt: string | null; error: string | null }>;
  projection: {
    recordPath: string | null;
    recordLabel: string | null;
    total: number;
    shown: number;
    headline: WorkspaceField[];
    breakdowns: WorkspaceBreakdown[];
    records: WorkspaceRecord[];
  };
}

export async function listWorkspaces(): Promise<{ workspaces: WorkspaceSummary[] }> {
  return api<{ workspaces: WorkspaceSummary[] }>('/m/api/workspaces');
}

export async function getWorkspace(id: string): Promise<WorkspaceDetail> {
  return api<WorkspaceDetail>(`/m/api/workspaces/${encodeURIComponent(id)}`);
}

/** Starts the runners; returns immediately (a refresh can take minutes). */
/**
 * Refresh outcome: `done:false` means a long runner is still going (keep
 * polling, the old behavior). `done:true` carries the desktop's triage —
 * including the case that was invisible before: a refresh blocked on an
 * approval (`pendingApprovalIds`), which the UI must say out loud instead of
 * letting the timestamp silently never move.
 */
export interface WorkspaceRefreshOutcome {
  ok: boolean;
  done: boolean;
  started?: boolean;
  results?: Array<{ sourceId?: string; ok?: boolean; error?: string; pendingApprovalId?: string }>;
  pendingApprovalIds?: string[];
  failureMessage?: string | null;
}

export async function refreshWorkspace(id: string, sourceId?: string): Promise<WorkspaceRefreshOutcome> {
  return api<WorkspaceRefreshOutcome>(`/m/api/workspaces/${encodeURIComponent(id)}/refresh`, {
    method: 'POST',
    body: JSON.stringify(sourceId ? { sourceId } : {}),
  });
}

// ── Settings: brain switcher, connections health, devices ───────

/** WHO answers the next message, resolved by the daemon's role registry. */
export interface ResolvedBrain {
  modelId: string;
  provider: string;
  source: string;
  /** Present when a SAVED choice is unavailable — the honest "X is saved but
   *  Y actually answers" line comes straight from the daemon. */
  inactiveBinding?: { modelId: string; provider: string; reason: string };
}

/** One row of the LIVE brain catalog — the same brainOptions the console
 *  renders. Nothing model-shaped is ever hardcoded on the phone. */
export interface BrainOptionRow {
  id: string;
  value: string;
  label: string;
  available: boolean;
  modelId?: string;
  providerId?: string;
}

export interface ModelSettings {
  brain: ResolvedBrain;
  options: BrainOptionRow[];
  effectiveValue: string;
  activeBrain: string;
}

export async function getModelSettings(): Promise<ModelSettings> {
  return api<ModelSettings>('/m/api/settings/models');
}

export async function setBrain(value: string): Promise<{ ok: boolean; brain: ResolvedBrain; effectiveValue: string }> {
  return api('/m/api/settings/models/brain', {
    method: 'POST',
    body: JSON.stringify({ value }),
  });
}

export interface ConnectionHealthRow {
  id: string;
  name: string;
  kind: 'composio' | 'cli';
  state: 'ok' | 'warn' | 'err';
  cause: string | null;
}

export async function getConnectionsHealth(): Promise<{ connections: ConnectionHealthRow[] }> {
  return api('/m/api/settings/connections');
}

export interface DaemonStatus {
  daemon: { version?: string; packaged?: boolean };
}

export async function getDaemonStatus(): Promise<DaemonStatus> {
  return api('/m/api/settings/status');
}

export interface MobileDeviceRow {
  deviceId: string;
  deviceLabel?: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  pushSubscribed: boolean;
  binding: 'key' | 'cookie';
  current: boolean;
}

export async function listDevices(): Promise<{ devices: MobileDeviceRow[] }> {
  return api('/m/api/devices');
}

export async function revokeDevice(deviceId: string): Promise<{ ok: boolean; removed: boolean }> {
  return api(`/m/api/devices/${encodeURIComponent(deviceId)}/revoke`, { method: 'POST', body: '{}' });
}

export async function revokeAllDevices(): Promise<{ ok: boolean; removed: number }> {
  return api('/m/api/devices/revoke-all', { method: 'POST', body: '{}' });
}
