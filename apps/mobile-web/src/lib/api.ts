import { readCompletionReviewResponse, type TaskMode, type ReplayPayload } from '@clem/chat-engine';
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
import { LAST_GOOD_HEADER, clearLastGood, noteLastGood } from './last-good.js';

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
  // A REMEMBERED answer is not an answer from the Mac. The service worker
  // serves a stamped last-good copy when the network fails (lib/last-good.ts),
  // and it arrives here as an ordinary 200 — so the stamp, not the status, is
  // what decides whether the door is open. Without this the app would report
  // "Direct" while showing yesterday's data.
  const lastGoodStamp = res.headers.get(LAST_GOOD_HEADER);
  noteLastGood(path, lastGoodStamp);
  if (lastGoodStamp) {
    setConnectionDoor('offline');
    reportConnectionLost();
  } else if (connectionDoor() === 'offline') {
    // Any live answer at all means the door is open again.
    setConnectionDoor('direct');
  }
  // Session tokens rotate every ~12h and the proof signs over a fingerprint
  // derived from the token. The rotation sets a new HttpOnly cookie the page
  // can't read, so the daemon also announces the new fingerprint in a
  // response header — fold it in or every later proof 401s (live: a paired
  // phone bounced to the login screen every 12 hours).
  //
  // A REMEMBERED copy must never do that. Its fingerprint is whatever the
  // daemon announced when the copy was taken, and adopting it would sign every
  // later proof over a fingerprint that has since rotated — the exact 401 loop
  // this header exists to prevent. (The worker also strips it when storing;
  // this is the second lock on the same door.)
  const rotatedFp = lastGoodStamp ? null : res.headers.get('x-clem-session-fp');
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
      clearLastGood();
      window.dispatchEvent(new Event('clem:needs-login'));
    } else {
      void fetch('/m/auth/status', { credentials: 'include' })
        .then((probe) => (probe.ok ? probe.json() : { authenticated: false }))
        .then((status: { authenticated?: boolean }) => {
          if (status?.authenticated) return;
          // A CONFIRMED dead session, not a rotation race: drop the remembered
          // reads with it. A transient 401 keeps them, which is the point.
          clearLastGood();
          window.dispatchEvent(new Event('clem:needs-login'));
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
 * relay origin. It is generation-fenced and durably leased until the adopted
 * origin proves its cookie arrived, so a dropped response cannot strand the
 * phone. Minted on LAN visits so a fresh one is waiting when the phone leaves.
 */
export interface OriginHandoffResponse {
  version: 2;
  token: string;
  expiresAt: number;
  handoffId: string;
  generation: number;
  deviceId: string;
}

export async function mintOriginHandoff(): Promise<OriginHandoffResponse> {
  return api('/m/auth/origin-handoff', { method: 'POST' });
}

/** Retire older generations only after native confirms this exact lease is in Keychain. */
export async function activateOriginHandoff(
  handoffId: string,
  generation: number,
): Promise<{ ok: true; handoffId: string; generation: number }> {
  return api('/m/auth/origin-handoff/activate', {
    method: 'POST',
    body: JSON.stringify({ handoffId, generation }),
  });
}

/** Retire an adopted lease only after this origin holds its exact session. */
export async function finalizeOriginHandoff(
  handoffId: string,
  generation: number,
): Promise<{ ok: true; handoffId: string; generation: number }> {
  return api('/m/auth/origin-handoff/finalize', {
    method: 'POST',
    body: JSON.stringify({ handoffId, generation }),
  });
}

/**
 * Spend a handoff token at THIS origin (the relay door) to establish the
 * session the browser cannot carry across origins. Same device identity, so
 * the phone stays one row in the desktop's device list.
 */
export interface OriginHandoffAdoption {
  token: string;
  handoffId?: string;
  generation?: number;
}

export async function adoptOriginSession(handoff: OriginHandoffAdoption): Promise<LoginResponse> {
  const devicePublicKeyJwk = await devicePublicKeyOrUndefined();
  const correlated = Boolean(handoff.handoffId && handoff.generation);
  const response = await api<LoginResponse & {
    originHandoff?: { handoffId: string; generation: number };
  }>('/m/auth/origin-adopt', {
    method: 'POST',
    body: JSON.stringify({
      ...(correlated ? { version: 2 } : {}),
      token: handoff.token,
      ...(handoff.handoffId ? { handoffId: handoff.handoffId } : {}),
      ...(handoff.generation ? { generation: handoff.generation } : {}),
      devicePublicKeyJwk,
    }),
  });
  if (
    correlated
    && (
      response.originHandoff?.handoffId !== handoff.handoffId
      || response.originHandoff?.generation !== handoff.generation
    )
  ) {
    throw makeError(502, { error: 'HANDOFF_ACK_MISMATCH' }, 'Origin handoff acknowledgement did not match');
  }
  return adoptSession(response);
}

export function isInvalidOriginHandoffError(error: unknown): boolean {
  const candidate = error as ApiError | undefined;
  const body = candidate?.body as { error?: unknown } | undefined;
  return candidate?.status === 401 && body?.error === 'INVALID_HANDOFF';
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
  // Signing out is a LOCAL act first; telling the daemon is the courtesy.
  // Offline that POST throws, and letting the throw skip what follows left a
  // signed-out phone holding the service worker's remembered reads and its
  // badge — a cached read outliving the credential that earned it. The clear
  // is therefore unconditional, and the caller still learns the daemon was
  // never told.
  try {
    await api('/m/auth/logout', { method: 'POST' });
  } finally {
    setSessionFingerprint(null);
    // Nothing this session could read may survive it — including the service
    // worker's remembered copies of the run list and the inbox summary.
    clearLastGood();
  }
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

// ─── durable mobile inbox ─

export interface InboxNotification {
  id: string;
  kind: 'cron' | 'workflow' | 'system' | 'approval' | 'execution';
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
  needsAttention: boolean;
  deliveredAt: string | null;
  deliveryError: string | null;
  workflowCapability?: WorkflowCapabilityInboxGate | null;
  context: {
    actionItemId: string | null;
    approvalId: string | null;
    planProposalId: string | null;
    trustProposalId: string | null;
    relatedApprovalIds?: string[];
    questionId: string | null;
    /** The originating CONVERSATION — where a reply belongs. */
    sessionId: string | null;
    /** The session the run itself used, when the work had one of its own. */
    runSessionId?: string | null;
    runId: string | null;
    stepId: string | null;
    workflow: string | null;
  };
}

export interface WorkflowCapabilityAccountChoice {
  label: string;
  capabilityId: string;
  accountId: string;
}

export interface WorkflowCapabilityInboxGate {
  notificationId: string;
  workflow: string;
  runId: string;
  stepId: string;
  tool: string;
  toolkit: string;
  reason: string;
  retryAt: string | null;
  provenNoDispatch: true;
  resolution:
    | {
        kind: 'choose_account';
        retryCount: number;
        choiceSetDigest: string;
        candidates: WorkflowCapabilityAccountChoice[];
        choiceTotal: number;
        choicesTruncated: boolean;
      }
    | { kind: 'retry_exact_metadata'; retryCount: number }
    | { kind: 'connect_and_retry'; retryCount: number }
    | { kind: 'review_run'; reason: string };
}

export interface InboxSummary {
  needsYou: number;
  questions: number;
  approvals: number;
  plans: number;
  workspaceChoices: number;
  trustProposals: number;
  notificationNeedsYou: number;
  unreadUpdates: number;
}

export interface InboxQuestion {
  id: string;
  source: 'check_in' | 'background_task' | 'workflow';
  question: string;
  options: string[];
  context: string | null;
  askedAt: string;
  urgency: 'low' | 'normal' | 'high';
  agentLabel: string;
  sessionId: string | null;
  taskId: string | null;
  workflowName: string | null;
  runId: string | null;
  stepId: string | null;
  answerable: boolean;
  unavailableReason: string | null;
}

export interface InboxTrustProposal {
  id: string;
  scopeRevision: 1;
  scopeDigest: string;
  toolkits: string[];
  recipients: string[];
  domains: string[];
  maxRecipients: number;
  rationale: string;
  createdAt: string;
  evidence: {
    cleanSendCount: number;
    distinctDays: number;
    firstAt: string;
    lastAt: string;
  };
}

export interface DeliveredArtifact {
  kind: string;
  title: string;
  target: string;
  createdAt: string;
  openable: boolean;
  stillExists?: boolean;
}

export interface DeliveredGroup {
  id: number;
  createdAt: string;
  title: string;
  why: string;
  artifactCount: number;
  artifacts: DeliveredArtifact[];
  url?: string;
}

export async function listDelivered(limit = 24): Promise<{ groups: DeliveredGroup[] }> {
  return api(`/m/api/delivered?limit=${Math.max(1, Math.min(50, Math.trunc(limit)))}`);
}

export async function listInboxNotifications(limit = 100): Promise<{
  notifications: InboxNotification[];
  count: number;
}> {
  return api(`/m/api/inbox/notifications?limit=${Math.max(1, Math.min(200, Math.trunc(limit)))}`);
}

export async function getInboxNotification(id: string): Promise<{ notification: InboxNotification }> {
  return api(`/m/api/inbox/notifications/${encodeURIComponent(id)}`);
}

export async function markInboxNotificationRead(id: string): Promise<{
  ok: boolean;
  cleared: number;
  notification: InboxNotification;
}> {
  return api(`/m/api/inbox/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
}

/** Why the daemon left one row alone during a bulk clear. */
export type InboxReadHeldReason = 'awaiting_you' | 'capability_gate' | 'not_found';

export interface InboxBulkReadResult {
  ok: boolean;
  /** Exactly the ids that are read now. */
  cleared: string[];
  clearedCount: number;
  /** Rows the daemon refused to clear, and why. Reported, never hidden. */
  held: Array<{ id: string; reason: InboxReadHeldReason }>;
  heldCount: number;
}

/**
 * Clear a named set of updates in one request.
 *
 * The ids are always the exact rows the screen was showing, so the button can
 * say how many it clears. Clearing never decides anything: the daemon holds
 * back any row still awaiting an answer and names it in `held`.
 */
export async function markInboxNotificationsRead(
  ids: readonly string[],
): Promise<InboxBulkReadResult> {
  return api('/m/api/inbox/notifications/read', {
    method: 'POST',
    body: JSON.stringify({ ids: [...ids] }),
  });
}

/** The ONE spelling of the summary path — the stamp registry is keyed by it. */
export const INBOX_SUMMARY_PATH = '/m/api/inbox/summary';

export async function getInboxSummary(): Promise<InboxSummary> {
  return api(INBOX_SUMMARY_PATH);
}

export async function listInboxQuestions(): Promise<{ questions: InboxQuestion[]; count: number }> {
  return api('/m/api/inbox/questions');
}

export async function listInboxTrustProposals(): Promise<{ proposals: InboxTrustProposal[]; count: number }> {
  return api('/m/api/inbox/trust-proposals');
}

export async function resolveInboxTrustProposal(
  proposal: Pick<InboxTrustProposal, 'id' | 'scopeRevision' | 'scopeDigest'>,
  decision: 'approve' | 'decline',
): Promise<{
  ok: boolean;
  status: string;
  nothingGranted: boolean;
  message: string;
  scopeReceipt: Pick<InboxTrustProposal, 'scopeRevision' | 'scopeDigest' | 'toolkits' | 'recipients' | 'domains' | 'maxRecipients'>;
}> {
  return api(`/m/api/inbox/trust-proposals/${encodeURIComponent(proposal.id)}/${decision}`, {
    method: 'POST',
    body: JSON.stringify({
      scopeRevision: proposal.scopeRevision,
      scopeDigest: proposal.scopeDigest,
    }),
  });
}

export async function answerInboxQuestion(id: string, answer: string): Promise<{
  ok: boolean;
  status: 'answered' | 'resuming';
  questionId: string;
  taskId?: string;
  runId?: string;
}> {
  return api(`/m/api/inbox/questions/${encodeURIComponent(id)}/answer`, {
    method: 'POST',
    body: JSON.stringify({ answer }),
  });
}

export async function resolveInboxWorkflowCapability(
  gate: WorkflowCapabilityInboxGate,
  choice?: WorkflowCapabilityAccountChoice,
): Promise<{
  ok: true;
  status: 'selected' | 'already_selected' | 'resumed' | 'already_resumed';
  runId: string;
  stepId: string;
}> {
  return api(`/m/api/inbox/workflow-capabilities/${encodeURIComponent(gate.runId)}/resolve`, {
    method: 'POST',
    body: JSON.stringify(gate.resolution.kind === 'choose_account'
      ? {
          action: 'choose_account',
          stepId: gate.stepId,
          tool: gate.tool,
          retryCount: gate.resolution.retryCount,
          choiceSetDigest: gate.resolution.choiceSetDigest,
          capabilityId: choice?.capabilityId ?? '',
          accountId: choice?.accountId ?? '',
        }
      : {
          action: 'retry',
          stepId: gate.stepId,
          tool: gate.tool,
          retryCount: gate.resolution.kind === 'review_run' ? 0 : gate.resolution.retryCount,
        }),
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
  /** Exact originating conversation; null means mobile cannot safely reply. */
  sessionId: string | null;
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
  // The route already enriches every row through the same formatter the
  // desktop reads (src/runtime/activity-format.ts): a human state label and a
  // one-line preview of what the run produced, is doing, or failed on. The
  // phone printed the raw status token for months because these were simply
  // not declared here. Optional because an older daemon's row has neither.
  /** e.g. "Done", "Waiting for your approval" — never a snake_case token. */
  statusLabel?: string;
  /** The run's output preview, error, or live line. */
  preview?: string;
  /** True when the daemon says this row still wants a person. */
  needsAttention?: boolean;
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

/**
 * The ONE spelling of a run's detail path.
 *
 * The last-good stamp registry is keyed by the path api() was called with, so
 * a screen asking "is what I'm showing remembered?" has to ask with the exact
 * same string. Spelling it twice cost us that: `background:task-1` was stored
 * encoded and looked up raw, the lookup missed, and a stamped copy of exactly
 * the runs a push addresses rendered with no age disclosure at all.
 */
export function runDetailPath(sessionId: string): string {
  return `/m/api/runs/${encodeURIComponent(sessionId)}`;
}

export async function getRun(sessionId: string): Promise<RunDetail> {
  return api(runDetailPath(sessionId));
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
  const initial = await api<{ session: ChatSession; events: ChatEvent[]; latestSeq: number; page?: ReplayPayload['page'] }>(`/m/api/chat/sessions/${encodeURIComponent(id)}`);
  const events = [...initial.events];
  let page = initial.page;
  let latestSeq = page?.scannedThroughSeq ?? initial.latestSeq;
  while (page?.hasMore) {
    const next = await fetchRecentChatEvents(id, page.scannedThroughSeq, page.snapshotSeq);
    if (next.sessionId !== id || next.page?.version !== 1
      || next.page.snapshotSeq !== page.snapshotSeq
      || next.page.scannedThroughSeq <= page.scannedThroughSeq
      || next.page.scannedThroughSeq > page.snapshotSeq
      || (!next.page.hasMore && next.page.scannedThroughSeq !== page.snapshotSeq)) {
      throw new Error('Chat history traversal did not advance within its origin snapshot.');
    }
    events.push(...next.events.filter(event => event.sessionId === id) as ChatEvent[]);
    page = next.page;
    latestSeq = page.scannedThroughSeq;
  }
  return { session: initial.session, events, latestSeq };
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
  input: { message: string; sessionId?: string; idempotencyKey: string; taskMode?: TaskMode },
): Promise<ChatSendResult> {
  return api<ChatSendResult>('/m/api/chat/send', {
    method: 'POST',
    headers: { 'idempotency-key': input.idempotencyKey },
    body: JSON.stringify({
      message: input.message,
      ...(input.taskMode ? { taskMode: input.taskMode } : {}),
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
  input: { message: string; sessionId?: string | null; idempotencyKey: string; steerOnly?: boolean; taskMode?: TaskMode },
): Promise<{ accepted: boolean; sessionId: string; runId?: string; sinceSeq?: number; steered?: boolean }> {
  return api('/m/api/chat/send', {
    method: 'POST',
    headers: { 'idempotency-key': input.idempotencyKey },
    body: JSON.stringify({
      message: input.message,
      ...(input.taskMode ? { taskMode: input.taskMode } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      async: true,
      ...(input.steerOnly ? { steerOnly: true } : {}),
    }),
  });
}

/** Cursor catch-up over plain fetch auth — the stream-death recovery path. */
export async function fetchRecentChatEvents(
  sessionId: string,
  sinceSeq: number,
  throughSeq?: number,
): Promise<ReplayPayload> {
  const params = new URLSearchParams({ sinceSeq: String(sinceSeq) });
  if (throughSeq !== undefined) params.set('throughSeq', String(throughSeq));
  return api(`/m/api/chat/sessions/${encodeURIComponent(sessionId)}/events/recent?${params}`);
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
    throughSeq?: number;
    onReplay(payload: ReplayPayload): void;
    onEvent(event: ChatEvent): void;
    onError(): void;
  }): Promise<{ close(): void }>;
  fetchRecent(sessionId: string, sinceSeq: number, throughSeq?: number): Promise<ReplayPayload>;
} {
  return {
    async connect(opts) {
      const streamPath = `/m/api/chat/sessions/${encodeURIComponent(opts.sessionId)}/stream`;
      const ticket = await mintStreamTicket(streamPath);
      const params = new URLSearchParams();
      params.set('sinceSeq', String(opts.sinceSeq));
      if (opts.throughSeq !== undefined) params.set('throughSeq', String(opts.throughSeq));
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
    fetchRecent: (sessionId, sinceSeq, throughSeq) => fetchRecentChatEvents(sessionId, sinceSeq, throughSeq),
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
  /** Required resources still unbound: the workflow cannot run until these are set. */
  resourceGaps?: string[];
  lastRunId: string | null;
  lastRunStatus: string | null;
  lastRunOutcome: 'succeeded' | 'partial' | 'blocked' | 'failed' | 'cancelled' | null;
  lastRunAt: string | null;
}

export interface MobileAgent {
  id: string;
  name: string;
  description: string;
  skills: string[];
  workflows: string[];
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MobileAgentsResponse {
  agents: MobileAgent[];
  available: { skills: string[]; workflows: string[] };
}

export async function listAgents(): Promise<MobileAgentsResponse> {
  return api<MobileAgentsResponse>('/m/api/agents');
}

export async function createAgent(draft: {
  name: string;
  description?: string;
  skills?: string[];
  workflows?: string[];
  model?: string | null;
}): Promise<{ agent: MobileAgent }> {
  return api<{ agent: MobileAgent }>('/m/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  });
}

export async function updateAgent(id: string, patch: {
  name?: string;
  description?: string;
  skills?: string[];
  workflows?: string[];
  model?: string | null;
}): Promise<{ agent: MobileAgent }> {
  return api<{ agent: MobileAgent }>(`/m/api/agents/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function deleteAgent(id: string): Promise<{ deleted: boolean }> {
  return api<{ deleted: boolean }>(`/m/api/agents/${encodeURIComponent(id)}/delete`, { method: 'POST' });
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

/** Stop an exact workflow occurrence when the chat dispatch has the immutable
 * run id but intentionally exposes no workflow/catalog name. The daemon
 * resolves and re-checks the run's own workflow identity under cancellation. */
export async function cancelWorkflowRunById(runId: string): Promise<{ ok: true; outcome: string; runId: string }> {
  return api<{ ok: true; outcome: string; runId: string }>(
    `/m/api/workflow-runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST' },
  );
}

export interface WorkflowRunBatchCancelResult {
  ok: true;
  state: 'stopped';
  results: Array<{
    runId: string;
    outcome: 'cancelled' | 'already_cancelled' | 'already_terminal';
    terminalStatus?: string;
  }>;
}

/** Resolve a delegated card as one bounded cancellation decision. Every exact
 * member is preflighted server-side before the first mutation, so a completed
 * sibling and a live sibling cannot leave the UI claiming the group is still
 * running after the live occurrence was successfully stopped. */
export async function cancelWorkflowRunsById(runIds: readonly string[]): Promise<WorkflowRunBatchCancelResult> {
  return api<WorkflowRunBatchCancelResult>('/m/api/workflow-runs/cancel', {
    method: 'POST',
    body: JSON.stringify({ runIds }),
  });
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

/** Stop the live chat turn by the REQUEST identity the phone already minted
 *  for it. Unlike the attempt-scoped primitive above this works before a run
 *  attempt is registered, so Stop is reachable from the moment of send rather
 *  than only once the run surfaces on Activity. */
export async function cancelChatRequest(
  sessionId: string,
  clientRequestId: string,
): Promise<{ ok: boolean; pendingAcceptance: boolean }> {
  return api<{ ok: boolean; pendingAcceptance: boolean }>(
    `/m/api/chat/sessions/${encodeURIComponent(sessionId)}/cancel`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientRequestId }),
    },
  );
}

/** Stop the live attempt on this conversation when this client never minted
 *  a cancel key (refresh, another surface, lost in-flight key). */
export async function cancelActiveChat(sessionId: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(
    `/m/api/chat/sessions/${encodeURIComponent(sessionId)}/cancel`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
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
  /** Explicit one-off content contract; null means a dynamic/draft surface. */
  contentMode?: 'static_snapshot' | null;
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
export interface WorkspaceLink { label: string; url: string }
export interface WorkspaceRecord {
  key: string;
  primary: string;
  fields: WorkspaceField[];
  body?: string;
  links?: WorkspaceLink[];
}
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

export interface CodexRescueModelOption {
  id: string;
  label: string;
  available: boolean;
}

export interface CodexRescueSettings {
  modelId: string;
  inheritedModelId: string;
  envKey: 'OPENAI_MODEL_RESCUE';
  configured: boolean;
  options: CodexRescueModelOption[];
}

export interface ModelSettings {
  brain: ResolvedBrain;
  options: BrainOptionRow[];
  effectiveValue: string;
  activeBrain: string;
  /** Optional for cached PWAs talking briefly to an older daemon. */
  codexRescue?: CodexRescueSettings;
}

/** Paired mobile endpoint; independent of model choice and Second opinion. */
export async function getCompletionReview() {
  return readCompletionReviewResponse(await api<unknown>('/m/api/settings/completion-review'));
}

export async function setCompletionReview(enabled: boolean) {
  return readCompletionReviewResponse(await api<unknown>('/m/api/settings/completion-review', {
    method: 'PATCH', body: JSON.stringify({ enabled }),
  }));
}

export async function getModelSettings(): Promise<ModelSettings> {
  return api<ModelSettings>('/m/api/settings/models');
}

/** sessionId is the conversation the switch was made FROM, when there is one
 *  (the chat-header sheet knows it; Settings does not). Session brain pins mean
 *  the global flip alone only steers NEW conversations — sending the sessionId
 *  makes the daemon re-pin that conversation so "applies to your next message"
 *  stays true where the sheet promises it. */
export async function setBrain(value: string, sessionId?: string): Promise<{ ok: boolean; brain: ResolvedBrain; effectiveValue: string }> {
  return api('/m/api/settings/models/brain', {
    method: 'POST',
    body: JSON.stringify(sessionId ? { value, sessionId } : { value }),
  });
}

/** Pick an exact server-catalogued Codex rescue id, or null to follow the
 * primary again. No credential material crosses this mobile API. */
export async function setCodexRescueModel(modelId: string | null): Promise<{ ok: boolean; codexRescue: CodexRescueSettings }> {
  return api('/m/api/settings/models/codex-rescue', {
    method: 'POST',
    body: JSON.stringify(modelId === null ? { clear: true } : { modelId }),
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
