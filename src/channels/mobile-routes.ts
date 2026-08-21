/**
 * Mobile PWA auth router — mounted at `/m` on the webhook server.
 *
 * Week 1 scope: PIN login, session cookie, logout, rotate, and a
 * reusable `requireMobileSession` middleware. The cookie is HttpOnly
 * + SameSite=Lax + Secure (over the Cloudflare Tunnel TLS edge). The
 * token itself is opaque random bytes; the server stores only its
 * SHA-256 hash (see mobile-sessions.ts).
 *
 * Rotate is gated by `isAdminAuthorized` — the existing dashboard
 * Bearer/cookie auth — so the desktop wizard or an authenticated
 * console session can reset the PIN, but a mobile session cannot
 * elevate itself.
 *
 * This router is intentionally `assistant`-free so it can be tested
 * in isolation. Future endpoints (push subscribe, inbox aggregator,
 * chat send) will live in a parallel router that depends on the
 * assistant + gateway.
 */

import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PKG_DIR } from '../config.js';
import { hasPin, pinNeedsRotation, readPinMeta, setPin, validatePinForSet, verifyPin } from '../runtime/mobile-pin.js';
import { consumeMobilePairingCode } from '../runtime/mobile-pairing.js';
import { beginCodexDeviceLogin, pollCodexDeviceLogin } from '../runtime/auth-store.js';
import {
  createSession,
  listSessions,
  revokeAllSessions,
  revokeSession,
  revokeSessionByDeviceId,
  validateSession,
  rotateSessionToken,
  detectTokenReuse,
  bindDeviceKey,
  needsDeviceUpgrade,
  shouldRotate,
  type MobileSessionRecord,
} from '../runtime/mobile-sessions.js';
import {
  verifyDeviceProof,
  sessionFingerprint,
  isSupportedDeviceKey,
} from '../runtime/mobile-device-proof.js';
import {
  checkAttempt,
  recordFailure,
  recordSuccess,
  type MobileAttemptScope,
} from '../runtime/mobile-rate-limit.js';
import {
  removeWebPushDestinationByEndpoint,
  removeWebPushDestinationsByDeviceId,
  upsertApnsDestination,
  upsertWebPushDestination,
} from '../runtime/notifications.js';
import { getVapidPublicKey } from '../runtime/web-push-keys.js';
import { deviceKeyRequired } from '../runtime/mobile-device-policy.js';
import { relayClientIp } from '../runtime/mobile-ingress.js';
import { markPushSubscribed } from '../runtime/mobile-sessions.js';
import {
  claimHarnessChatRequest,
  claimRunAttemptLease,
  createSession as createHarnessChatSession,
  finishRunAttempt,
  getHarnessChatRequestReceipt,
  getLatestRunAttemptByRunId,
  getSession as harnessGetSession,
  interruptForeignRunAttemptLeases,
  listEvents as harnessListEvents,
  listSessions as harnessListSessions,
  getLatestEventSeq as harnessLatestEventSeq,
  appendEvent as appendHarnessEvent,
  recordRunAttemptUserInput,
  renewRunAttemptLease,
  type EventRow as HarnessEventRow,
  type RunAttemptRef,
  type SessionRow as HarnessSessionRow,
} from '../runtime/harness/eventlog.js';
import {
  projectHarnessEventsForPublic,
  publicUserInputText,
  PUBLIC_RUN_FAILURE_TEXT,
} from '../runtime/harness/public-presentation.js';
import {
  collectBridgedWorkflowReplay,
  createBridgePredicate,
  isCanonicalBridgedActivity,
} from '../runtime/harness/bridged-activity.js';
import { actionBus } from '../runtime/action-bus.js';
import { commitTurnOutcome } from '../runtime/harness/delivery-committer.js';
import { clearRunInFlightAfterTerminal } from '../runtime/harness/restart-recovery.js';
import {
  presentationEventFromCompletionData,
  turnOutcomeId,
  type PresentationEvent,
  type TurnIdentity,
} from '../runtime/harness/turn-outcome.js';
import { ClementineGateway } from '../gateway/router.js';
import type { GatewayResponse } from '../gateway/router.js';
import type { ClementineAssistant } from '../assistant/core.js';
import { lookupIdempotent, rememberIdempotent } from '../runtime/idempotency.js';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { recallMemory } from '../memory/recall-memory.js';
import { listActiveFacts } from '../memory/facts.js';
type ConsolidatedFactKind = 'user' | 'project' | 'feedback' | 'reference';
import { listWorkflows } from '../memory/workflow-store.js';
import { readWorkflowEvents } from '../execution/workflow-events.js';
import {
  deriveWorkflowTerminalOutcome,
  type WorkflowTerminalOutcome,
} from '../execution/workflow-terminal-outcome.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { queueWorkflowRun } from '../tools/workflow-run-queue.js';
import { getPlanProposal, listPlanProposals, planProposalNeedsUserInput, rejectPlanProposal, type PlanProposal } from '../agents/plan-proposals.js';
import { approvePlanAndQueueBackgroundTask } from '../execution/approved-plan-tasks.js';
import {
  processBackgroundTasks,
  queueBackgroundTaskApprovalResolution,
} from '../execution/background-tasks.js';
import type { AssistantRouteDiagnostics } from '../types.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { selectSoleExactApprovalDuplicate } from '../runtime/harness/approval-authority.js';
import { exactPendingActionApprovalPreflight } from '../runtime/harness/pending-action-approval.js';
import { HarnessSession } from '../runtime/harness/session.js';
import { attachSessionViewer } from '../runtime/harness/session-viewers.js';
import { buildOrchestratorAgent, buildOrchestratorAgentForApprovalResume } from '../agents/orchestrator.js';
import { configureHarnessRuntime } from '../runtime/harness/codex-client.js';
import { runConversationFromResume } from '../runtime/harness/loop.js';

export const MOBILE_SESSION_COOKIE = 'clem_mobile_session';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface ChatSendResponse {
  sessionId: string;
  runId?: string;
  reply: string;
  pendingApprovalId?: string;
  queuedTaskId?: string;
  stoppedReason?: string;
  turnsUsed?: number;
  route?: AssistantRouteDiagnostics;
}

const mobileChatInFlight = new Map<string, Promise<GatewayResponse>>();

function mobileChatDigest(deviceId: string, idempotencyKey: string): string {
  return createHash('sha256')
    .update(deviceId)
    .update('\0')
    .update(idempotencyKey)
    .digest('hex');
}

function mobileChatPayloadHash(message: string, requestedSessionId: string | null): string {
  return createHash('sha256')
    .update(JSON.stringify({ message, requestedSessionId }))
    .digest('hex');
}

/** Test-only process restart seam; durable receipts and terminals remain. */
export function _clearMobileChatInFlightForTests(): void {
  mobileChatInFlight.clear();
}

const MOBILE_APPROVAL_LEASE_OWNER = `mobile-approval:${process.pid}:${randomBytes(6).toString('hex')}`;
const MOBILE_APPROVAL_LEASE_MS = 60_000;

function mobileApprovalRunId(approvalId: string, decision: 'approve' | 'reject'): string {
  return `mobile-approval:${approvalId}:${decision}`;
}

function mobileApprovalIdentity(source: HarnessEventRow): TurnIdentity {
  return { sessionId: source.sessionId, turn: source.turn, sourceUserSeq: source.seq };
}

function commitMobileApprovalTerminal(input: {
  source: HarnessEventRow;
  text: string;
  status: 'done' | 'failed';
  reason: string;
  metadata?: Record<string, unknown>;
}): ReturnType<typeof commitTurnOutcome> {
  const identity = mobileApprovalIdentity(input.source);
  const common = { version: 2 as const, id: turnOutcomeId(identity), identity };
  return commitTurnOutcome(input.status === 'failed'
    ? {
        ...common,
        status: 'failed',
        resumable: false,
        presentation: { kind: 'error', text: input.text },
      }
    : {
        ...common,
        status: 'done',
        resumable: false,
        presentation: { kind: 'answer', text: input.text },
      }, {
    legacyReason: input.reason,
    metadata: input.metadata,
  });
}

function exactMobileApprovalTerminal(
  sessionId: string,
  sourceUserSeq: number,
): { event: HarnessEventRow; presentation: PresentationEvent } | null {
  for (const event of harnessListEvents(sessionId, { types: ['conversation_completed'], desc: true })) {
    if (event.data.sourceUserSeq !== sourceUserSeq && event.data.terminalKey !== `turn:${sourceUserSeq}`) continue;
    const presentation = presentationEventFromCompletionData(event.data);
    if (presentation?.identity.sourceUserSeq === sourceUserSeq) return { event, presentation };
  }
  return null;
}

function settleMobileApprovalAttempt(
  attempt: RunAttemptRef,
  status: 'completed' | 'failed' | 'cancelled' = 'completed',
): void {
  try { finishRunAttempt(attempt, status); } finally {
    clearRunInFlightAfterTerminal(attempt.sessionId, attempt.attemptId);
  }
}

/**
 * Mobile-friendly slim shape for a harness session — drops token-budget
 * + plan-id fields the phone doesn't render. Title falls back to
 * objective then a kind-aware default, matching the dashboard.
 */
function serializeSessionForMobile(session: HarnessSessionRow): {
  id: string;
  title: string;
  kind: HarnessSessionRow['kind'];
  channel: string | null;
  status: HarnessSessionRow['status'];
  createdAt: number;
  updatedAt: number;
} {
  const title = session.title?.trim()
    || (session.objective ? session.objective.slice(0, 80) : '')
    || (session.channel === 'discord' ? 'Discord conversation' : 'Clementine session');
  return {
    id: session.id,
    title,
    kind: session.kind,
    channel: session.channel,
    status: session.status,
    createdAt: typeof session.createdAt === 'number' ? session.createdAt : Date.parse(String(session.createdAt)),
    updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : Date.parse(String(session.updatedAt)),
  };
}

/**
 * Shape an already-public-projected event for the phone.
 *
 * The input is projectHarnessEventForPublic's output — the same fail-closed,
 * user-facing projection the desktop console ships over its SSE untouched.
 * Trimming it further is what used to break the phone: tool correlation ids,
 * result glimpses, worker/batch progress and token deltas all arrived as
 * `data: {}`, so the mobile chat could never render the activity the desktop
 * renders. The phone is the same owner on the same daemon behind stronger
 * auth than the console; it gets the same events.
 *
 * The only per-type work left here is enrichment the projection doesn't
 * carry (plan-proposal status lookup) and the derived user-input text.
 */
function serializeEventForMobile(event: HarnessEventRow): {
  seq: number;
  id: string;
  turn: number;
  role: string;
  type: string;
  createdAt: number;
  sessionId: string;
  data: Record<string, unknown>;
} {
  const data = event.data ?? {};
  let shaped: Record<string, unknown>;
  switch (event.type) {
    case 'user_input_received':
      shaped = { ...data, text: publicUserInputText(data) };
      break;
    case 'conversation_completed':
      {
        const planProposalId = typeof data.planProposalId === 'string' ? data.planProposalId : null;
        const planProposal = planProposalId ? getPlanProposal(planProposalId) : null;
        const planProposalStatus = typeof data.planProposalStatus === 'string'
          ? data.planProposalStatus
          : (planProposal?.status ?? null);
        shaped = {
          ...data,
          reply: typeof data.reply === 'string' ? data.reply : (typeof data.summary === 'string' ? data.summary : ''),
          planProposalId,
          planProposalStatus,
          planProposalNeedsUserInput: planProposal ? planProposalNeedsUserInput(planProposal) : false,
        };
      }
      break;
    case 'conversation_limit_exceeded':
      // Passthrough plus explicit nulls: the continue UX reads these fields
      // and the contract pins absent limits as null, not missing.
      shaped = {
        ...data,
        reason: typeof data.reason === 'string' ? data.reason : 'limit_exceeded',
        steps: typeof data.steps === 'number' ? data.steps : null,
        maxSteps: typeof data.maxSteps === 'number' ? data.maxSteps : null,
        maxWallClockMs: typeof data.maxWallClockMs === 'number' ? data.maxWallClockMs : null,
        maxTurns: typeof data.maxTurns === 'number' ? data.maxTurns : null,
        transport: typeof data.transport === 'string' ? data.transport : null,
      };
      break;
    case 'tool_called':
      // Keep the legacy preview field a shipped PWA build still reads while
      // passing the full projected payload (callId, publicSlug, reused …).
      shaped = {
        ...data,
        tool: typeof data.tool === 'string' ? data.tool : String(data.name ?? 'unknown'),
        argsPreview: shortArgsPreview(data.arguments ?? data.args),
      };
      break;
    case 'run_failed':
      shaped = { ...data, error: typeof data.error === 'string' ? data.error.slice(0, 500) : 'failed' };
      break;
    default:
      // Public projection passthrough — identical to what the desktop SSE
      // writes. Includes stream_token deltas the moment the projection
      // starts emitting them; seq cursors stay correct either way.
      shaped = { ...data };
  }
  return {
    seq: event.seq,
    id: event.id,
    turn: event.turn,
    role: event.role,
    type: event.type,
    createdAt: typeof event.createdAt === 'number' ? event.createdAt : Date.parse(String(event.createdAt)),
    // Bridged delegated-work frames keep their own session id so the client
    // can tell foreground turn state from mirrored background activity.
    sessionId: event.sessionId,
    data: shaped,
  };
}

function serializePlanProposalForMobile(proposal: PlanProposal): {
  id: string;
  proposedAt: string;
  status: string;
  objective: string;
  context: string | null;
  complexity: string;
  steps: Array<{ n: number; action: string; rationale: string; verification: string | null }>;
  successCriteria: string[];
  risks: string[];
  needsUserInput: string[];
  appliedInstructions: string[];
} {
  return {
    id: proposal.id,
    proposedAt: proposal.proposedAt,
    status: proposal.status,
    objective: proposal.plan.objective,
    context: proposal.context ?? null,
    complexity: proposal.plan.estimatedComplexity,
    steps: proposal.plan.steps,
    successCriteria: proposal.plan.successCriteria,
    risks: proposal.plan.risks,
    needsUserInput: proposal.plan.needsUserInput,
    appliedInstructions: proposal.plan.appliedInstructions,
  };
}

function serializeApprovalForMobile(row: approvalRegistry.PendingApprovalRow): {
  kind: 'harness';
  approvalId: string;
  sessionId: string;
  channel: string | null;
  channelId: string | null;
  requestedAt: string;
  expiresAt: string;
  subject: string;
  tool: string | null;
  args: Record<string, unknown> | null;
  status: approvalRegistry.PendingApprovalStatus;
  resolution: approvalRegistry.ApprovalResolution | null;
} {
  return {
    kind: 'harness',
    approvalId: row.approvalId,
    sessionId: row.sessionId,
    channel: row.channel,
    channelId: row.channelId,
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt,
    subject: row.subject,
    tool: row.tool,
    args: row.args,
    status: row.status,
    resolution: row.resolution,
  };
}

interface MobileWorkflowRunSummary {
  id: string;
  workflow: string;
  status: string;
  terminalOutcome?: WorkflowTerminalOutcome;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  source: string | null;
  error: string | null;
  /** The run finished but is asking for a human — parity with the desktop's
   *  run projection, where hiding this made a parked run look merely slow. */
  needsAttention: boolean;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'string' ? Number.parseInt(value, 10) : (typeof value === 'number' ? value : NaN);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(raw)));
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Read every workflow run file off disk, sort newest-first, and group
 * by workflow name. Same on-disk layout the dashboard uses
 * (`WORKFLOW_RUNS_DIR/<id>.json`); we just reshape to the mobile view.
 */
function readMobileWorkflowRuns(): Map<string, MobileWorkflowRunSummary[]> {
  const grouped = new Map<string, MobileWorkflowRunSummary[]>();
  let files: string[] = [];
  try {
    files = readdirSync(WORKFLOW_RUNS_DIR);
  } catch {
    return grouped;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>;
      const id = typeof raw.id === 'string' ? raw.id : '';
      const workflow = typeof raw.workflow === 'string' ? raw.workflow : '';
      if (!id || !workflow) continue;
      const summary: MobileWorkflowRunSummary = {
        id,
        workflow,
        status: typeof raw.status === 'string' ? raw.status : 'unknown',
        terminalOutcome: deriveWorkflowTerminalOutcome({
          status: raw.status,
          finishedAt: raw.finishedAt,
          needsAttention: raw.needsAttention,
          terminalOutcome: raw.terminalOutcome,
          reportBack: raw.reportBack && typeof raw.reportBack === 'object' && !Array.isArray(raw.reportBack)
            ? { outcome: (raw.reportBack as Record<string, unknown>).outcome }
            : undefined,
        }),
        createdAt: stringOrNull(raw.createdAt),
        startedAt: stringOrNull(raw.startedAt),
        finishedAt: stringOrNull(raw.finishedAt) ?? stringOrNull(raw.completedAt),
        source: stringOrNull(raw.source),
        error: stringOrNull(raw.error),
        needsAttention: raw.needsAttention === true,
      };
      const list = grouped.get(workflow) ?? [];
      list.push(summary);
      grouped.set(workflow, list);
    } catch {
      /* malformed run file — skip */
    }
  }
  for (const list of grouped.values()) {
    list.sort((a, b) =>
      String(b.createdAt ?? b.startedAt ?? '').localeCompare(String(a.createdAt ?? a.startedAt ?? '')),
    );
  }
  return grouped;
}

function truncateOutput(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.length > 240 ? value.slice(0, 240) + '…' : value;
  try {
    const json = JSON.stringify(value);
    return json.length > 240 ? json.slice(0, 240) + '…' : json;
  } catch {
    return String(value).slice(0, 240);
  }
}

function shortArgsPreview(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.slice(0, 120);
  try {
    return JSON.stringify(value).slice(0, 120);
  } catch {
    return '';
  }
}

export interface MobileRouterDeps {
  /**
   * Trusts the request as an admin (desktop wizard or dashboard cookie).
   * Used to gate `/m/auth/rotate`. Reuses the existing `isAuthorized`
   * helper from webhook.ts.
   */
  isAdminAuthorized: (req: express.Request) => boolean;
  /** Required for /m/api/chat/send to call into the gateway. Tests
   *  that exercise only the auth surface can omit this and the send
   *  endpoint will return 503. */
  assistant?: ClementineAssistant;
  /**
   * Recent activity runs (chats + workflows), injected from webhook.ts so
   * the phone's Activity tab shows the SAME list as the desktop dashboard's
   * /api/runs. Tests that exercise only the auth surface can omit this and
   * the endpoint will return 503.
   */
  listRecentRuns?: (limit: number) => unknown[];
  /**
   * Stops a tracked run, injected from webhook.ts so the phone uses the same
   * verb as the dashboard. Omitted in auth-only test harnesses (route 503s).
   */
  cancelRun?: (id: string) => { ok: boolean; httpStatus: number; message: string; runId: string; taskStatus?: string };
  /** Test seam — override the state dir for fixtures. */
  stateDir?: string;
  /** Test seam — override secure-cookie behavior. */
  cookieSecure?: boolean;
  /**
   * Optional override for the built PWA assets directory. When unset,
   * the router probes the usual candidate paths (apps/mobile-web/dist
   * relative to the package, then sibling resources/mobile-web in
   * packaged builds). Tests pass `null` to disable static serving.
   */
  pwaDistDir?: string | null;
}

/** Locate the built PWA bundle. Returns null if not built yet. */
function resolvePwaDistDir(override?: string | null): string | null {
  if (override === null) return null;
  if (typeof override === 'string') return existsSync(path.join(override, 'index.html')) ? override : null;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Dev/repo layout: PKG_DIR/apps/mobile-web/dist.
    path.join(PKG_DIR, 'apps', 'mobile-web', 'dist'),
    // Packaged Electron layout: bin alongside the daemon's dist.
    path.join(here, '..', '..', 'apps', 'mobile-web', 'dist'),
    path.join(here, '..', '..', '..', 'apps', 'mobile-web', 'dist'),
    // Optional override via env (useful in CI).
    process.env.CLEMENTINE_MOBILE_WEB_DIST ?? '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      try { cookies[key] = decodeURIComponent(value); }
      catch { cookies[key] = value; }
    }
  }
  return cookies;
}

function readSessionCookie(req: express.Request): string {
  const header = req.headers.cookie ?? '';
  return parseCookies(header)[MOBILE_SESSION_COOKIE] ?? '';
}

function clientIp(req: express.Request): string {
  // The socket peer IS the client on the loopback and pinned-TLS direct-app
  // doors. On the relay door every stream arrives from 127.0.0.1, so the
  // relay-observed client IP is restored via the in-process stream-peer
  // registry (mobile-ingress.ts) — without it every remote caller would
  // share one rate-limit bucket and one attacker could lock out the owner.
  // Forwarding HEADERS (CF-Connecting-IP, X-Forwarded-For) remain untrusted
  // everywhere: they were only ever a spoofing surface that would let a
  // caller mint fresh rate-limit buckets per request.
  if (req.clemIngress === 'relay') {
    const restored = relayClientIp(req);
    if (restored) return restored;
  }
  return req.socket.remoteAddress || req.ip || 'unknown';
}

/**
 * Short-lived single-use tickets for SSE streams.
 *
 * EventSource cannot set request headers, so a stream cannot carry the
 * X-Clem-Device-Proof header every other authenticated request uses. Putting a
 * proof in the query string instead would leak it into access logs, proxy logs,
 * and browser history. So the client spends one proof-authenticated POST to
 * mint an opaque ticket, and the stream URL carries only that.
 *
 * In-memory and deliberately tiny: 60-second TTL, single use, bound to both the
 * device and the exact stream path. A daemon restart invalidates outstanding
 * tickets, which costs a reconnect and nothing else.
 */
const STREAM_TICKET_TTL_MS = 60_000;
const streamTickets = new Map<string, { deviceId: string; path: string; expiresAt: number }>();

function mintStreamTicket(deviceId: string, pathname: string): string {
  const now = Date.now();
  for (const [key, value] of streamTickets) {
    if (value.expiresAt <= now) streamTickets.delete(key);
  }
  const ticket = randomBytes(24).toString('base64url');
  streamTickets.set(ticket, { deviceId, path: pathname, expiresAt: now + STREAM_TICKET_TTL_MS });
  return ticket;
}

function consumeStreamTicket(ticket: string, deviceId: string, pathname: string): boolean {
  const entry = streamTickets.get(ticket);
  if (!entry) return false;
  // Single use, whatever the outcome.
  streamTickets.delete(ticket);
  if (entry.expiresAt <= Date.now()) return false;
  if (entry.deviceId !== deviceId) return false;
  return entry.path === pathname;
}

/**
 * Origin handoff — how a phone that paired on the LAN can also be itself at
 * the relay origin.
 *
 * A web session cookie and the device key in IndexedDB are per-ORIGIN. The
 * phone pairs at `https://<lan-ip>:8421` and holds its credential there; the
 * relay door is a DIFFERENT origin (`https://<pairId>.<base>:<port>`), so the
 * browser presents nothing there — and pairing is refused over the relay
 * because it is a LAN ceremony. Off-LAN access was therefore a deadlock: the
 * one credential the phone could establish remotely was the one credential
 * remote callers may not establish (live: the app reached the relay and sat
 * on a login screen that could not be satisfied from anywhere but home).
 *
 * The handoff breaks it without weakening the ceremony. The token is minted
 * ONLY by an already-authenticated request on a LAN door — the trust decision
 * still happens at home, in person — and is single-use with a short TTL. It
 * is then redeemable at the relay origin to mint a second session for the
 * SAME device, so the phone keeps one identity in the device list. A remote
 * attacker without a token gains nothing; a token that leaks is one device
 * session, expiring in minutes, revocable from the desktop like any other.
 */
const ORIGIN_HANDOFF_TTL_MS = 10 * 60_000;
const originHandoffs = new Map<string, { deviceId: string; deviceLabel?: string; expiresAt: number }>();

function mintOriginHandoff(deviceId: string, deviceLabel?: string): { token: string; expiresAt: number } {
  const now = Date.now();
  for (const [key, value] of originHandoffs) {
    if (value.expiresAt <= now) originHandoffs.delete(key);
  }
  // One live handoff per device: minting a fresh one retires the old, so a
  // token left unused on a previous LAN visit cannot be redeemed later.
  for (const [key, value] of originHandoffs) {
    if (value.deviceId === deviceId) originHandoffs.delete(key);
  }
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + ORIGIN_HANDOFF_TTL_MS;
  originHandoffs.set(token, { deviceId, deviceLabel, expiresAt });
  return { token, expiresAt };
}

function consumeOriginHandoff(token: string): { deviceId: string; deviceLabel?: string } | null {
  const entry = originHandoffs.get(token);
  if (!entry) return null;
  // Single use, whatever the outcome.
  originHandoffs.delete(token);
  if (entry.expiresAt <= Date.now()) return null;
  return { deviceId: entry.deviceId, deviceLabel: entry.deviceLabel };
}

/** Test seam: a fresh process starts with no outstanding handoffs. */
export function _clearOriginHandoffsForTests(): void {
  originHandoffs.clear();
}

/**
 * Distributed-brute-force alarm: a one-shot notification the moment a failure
 * tips the global counter into lockdown.
 *
 * Shared by every credential-establishing route so a new one cannot silently
 * ship without the alarm. Best-effort by design — a notification failure must
 * never block or delay the auth response.
 */
async function notifyGlobalLockdown(
  scope: MobileAttemptScope,
  decision: { globalTrippedNow: boolean; globalFailures: number; retryAfterMs: number },
): Promise<void> {
  if (!decision.globalTrippedNow) return;
  const what = scope === 'pair' ? 'device pairing attempts' : 'mobile PIN attempts';
  const remedy = scope === 'pair'
    ? 'If this wasn’t you, regenerate the pairing QR in the desktop Mobile Access panel.'
    : 'If this wasn’t you, rotate your PIN in the desktop Mobile Access panel.';
  try {
    const { addNotification } = await import('../runtime/notifications.js');
    addNotification({
      id: `mobile-${scope}-global-lockout-${Date.now().toString(36)}`,
      kind: 'system',
      title: 'Mobile sign-ins locked down',
      body: `Too many failed ${what} from different sources in a short window. `
        + `All mobile sign-ins are blocked for the next hour. ${remedy}`,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: {
        scope,
        globalFailures: decision.globalFailures,
        retryAfterMs: decision.retryAfterMs,
      },
    });
  } catch {
    /* swallow — auth path must stay responsive */
  }
}

export interface MobileSessionContext {
  token: string;
  record: MobileSessionRecord;
}

declare module 'express-serve-static-core' {
  interface Request {
    mobileSession?: MobileSessionContext;
  }
}

export function createMobileRouter(deps: MobileRouterDeps): express.Router {
  const router = express.Router();
  const stateOpts = deps.stateDir ? { stateDir: deps.stateDir } : undefined;
  // A restarted daemon cannot still own its prior mobile approval executor.
  // Retire only this process-scoped run family; live owners in this process
  // keep the same owner id and are left untouched.
  try {
    interruptForeignRunAttemptLeases(MOBILE_APPROVAL_LEASE_OWNER, { runIdPrefix: 'mobile-approval:' });
  } catch { /* startup recovery is best-effort */ }
  // Tests can force insecure cookies. Runtime defaults to Secure on the
  // public HTTPS tunnel while keeping localhost/127.0.0.1 preview usable.
  const cookieSecureOverride = deps.cookieSecure;

  function mobileCookieSecure(req: express.Request): boolean {
    if (typeof cookieSecureOverride === 'boolean') return cookieSecureOverride;
    const forwardedProto = typeof req.headers['x-forwarded-proto'] === 'string'
      ? req.headers['x-forwarded-proto'].split(',')[0]?.trim().toLowerCase()
      : '';
    if (req.secure || forwardedProto === 'https') return true;

    const rawHost = typeof req.headers.host === 'string' ? req.headers.host : '';
    const host = rawHost
      .replace(/^\[/, '')
      .replace(/\](:\d+)?$/, '')
      .replace(/:\d+$/, '')
      .toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;

    return true;
  }

  /**
   * Used by anything mounted on /m/api/* (and equivalent paths) that
   * needs a valid mobile session. Sets `req.mobileSession` on success.
   */
  /**
   * Reads a device public key offered at credential time.
   *
   * Absent on an older cached PWA bundle, which is why a keyless session is
   * still issued (with an upgrade grace) rather than refused — a stale service
   * worker must not lock a user out of their own phone.
   */
  function readDeviceKeyFromBody(req: express.Request): JsonWebKey | undefined {
    const jwk = req.body?.devicePublicKeyJwk as unknown;
    return isSupportedDeviceKey(jwk) ? jwk : undefined;
  }

  function setSessionCookie(req: express.Request, res: express.Response, token: string): void {
    res.cookie(MOBILE_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: mobileCookieSecure(req),
      path: '/',
      maxAge: COOKIE_MAX_AGE_MS,
    });
  }

  async function requireMobileSession(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): Promise<void> {
    const now = Date.now();
    const token = readSessionCookie(req);
    if (!token) {
      res.status(401).json({ error: 'NO_SESSION' });
      return;
    }
    let record = await validateSession(token, stateOpts);
    if (!record) {
      // A token we retired is being presented past its grace. The legitimate
      // client always holds the newest one, so this means the value leaked and
      // two parties hold session material. We cannot tell which caller is the
      // owner, so the safe move is to kill the whole device chain and make
      // both re-authenticate.
      const reuse = await detectTokenReuse(token, stateOpts);
      if (reuse.reused) {
        await revokeSessionByDeviceId(reuse.deviceId, stateOpts).catch(() => undefined);
        await notifySessionReuse(reuse.deviceId);
        res.clearCookie(MOBILE_SESSION_COOKIE, { path: '/', secure: mobileCookieSecure(req), sameSite: 'lax' });
        res.status(401).json({ error: 'SESSION_REVOKED' });
        return;
      }
      res.clearCookie(MOBILE_SESSION_COOKIE, { path: '/', secure: mobileCookieSecure(req), sameSite: 'lax' });
      res.status(401).json({ error: 'INVALID_SESSION' });
      return;
    }

    if (record.binding === 'key' && deviceKeyRequired()) {
      const verdict = await verifySessionProof(req, token, record);
      if (!verdict.ok) {
        // Budgeted separately from PIN and pairing: a client failing this many
        // signature checks is broken or hostile, but it must never be able to
        // consume the budget the credential paths depend on.
        await recordFailure(clientIp(req), { ...stateOpts, scope: 'proof' });
        res.status(401).json({ error: 'BAD_DEVICE_PROOF', reason: verdict.reason });
        return;
      }
    } else if (deviceKeyRequired() && needsDeviceUpgrade(record, now)) {
      // A migrated v1 session that never bound a key within its grace. Fails to
      // a login screen, not to a broken app.
      res.clearCookie(MOBILE_SESSION_COOKIE, { path: '/', secure: mobileCookieSecure(req), sameSite: 'lax' });
      res.status(401).json({ error: 'DEVICE_UPGRADE_REQUIRED' });
      return;
    }

    // A legacy weak PIN gets in, but only into a sandbox that can do nothing
    // except look at itself and set a stronger PIN.
    if (record.scope === 'pin-rotation' && !isPinRotationPath(req.path)) {
      res.status(403).json({ error: 'PIN_ROTATION_REQUIRED' });
      return;
    }

    let activeToken = token;
    if (shouldRotate(record, now)) {
      const rotated = await rotateSessionToken(token, stateOpts).catch(() => undefined);
      if (rotated) {
        activeToken = rotated.token;
        record = rotated.record;
        setSessionCookie(req, res, rotated.token);
        // The device proof signs over the session fingerprint, which is
        // derived from the token — so a rotation the client can't observe
        // guarantees a BAD_DEVICE_PROOF 401 on its next request (live: a
        // paired phone bounced to the login screen every 12h). The cookie is
        // HttpOnly by design, so the new fingerprint rides a response header
        // the fetch layer folds into its signing state.
        res.setHeader('x-clem-session-fp', sessionFingerprint(rotated.token));
      }
    }

    req.mobileSession = { token: activeToken, record };
    next();
  }

  /** The only paths a pin-rotation-scoped session may reach. */
  function isPinRotationPath(pathname: string): boolean {
    return pathname === '/auth/status' || pathname === '/auth/pin' || pathname === '/auth/logout';
  }

  /**
   * Verifies the per-request device proof.
   *
   * EventSource cannot set headers, so SSE streams carry a short-lived
   * single-use ticket in the query string instead. The ticket is minted by a
   * proof-authenticated endpoint, so the guarantee is preserved without putting
   * a signature into access logs and browser history.
   */
  async function verifySessionProof(
    req: express.Request,
    token: string,
    record: MobileSessionRecord,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!record.devicePublicKeyJwk) return { ok: false, reason: 'NO_DEVICE_KEY' };

    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
    if (ticket) {
      return consumeStreamTicket(ticket, record.deviceId, req.path)
        ? { ok: true }
        : { ok: false, reason: 'BAD_TICKET' };
    }

    const header = req.headers['x-clem-device-proof'];
    const proof = typeof header === 'string' ? header : '';
    if (!proof) return { ok: false, reason: 'PROOF_REQUIRED' };

    const result = await verifyDeviceProof({
      proof,
      publicKeyJwk: record.devicePublicKeyJwk,
      method: req.method,
      // req.path is router-relative; proofs are signed over the full path the
      // client actually requested.
      path: req.originalUrl.split('?')[0] ?? req.path,
      sessionFingerprint: sessionFingerprint(token),
    });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  async function notifySessionReuse(deviceId: string): Promise<void> {
    try {
      const { addNotification } = await import('../runtime/notifications.js');
      addNotification({
        id: `mobile-session-reuse-${Date.now().toString(36)}`,
        kind: 'system',
        title: 'A mobile session was revoked',
        body: 'A retired session token was replayed, which means the value leaked. '
          + 'That device has been signed out everywhere. Pair it again from the desktop '
          + 'Mobile Access panel.',
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { deviceId },
      });
    } catch {
      /* swallow — auth path must stay responsive */
    }
  }
  (router as express.Router & { requireMobileSession: typeof requireMobileSession })
    .requireMobileSession = requireMobileSession;

  /** Liveness probe — setup uses this to confirm the daemon is answering. */
  /**
   * Where the relay door is, if one is configured. Public by construction:
   * the origin is a hostname derived from the (public) certificate hash —
   * knowing it grants nothing, since the TLS pin and the device session
   * still gate everything behind it. Served anonymously so the native shell
   * can learn/refresh it on any LAN visit without a web session.
   */
  router.get('/relay-info', async (_req, res) => {
    const { getMobileRelayRuntime } = await import('../runtime/mobile-relay.js');
    res.json({ origin: getMobileRelayRuntime()?.origin ?? null });
  });

  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  router.get('/auth/status', async (req, res) => {
    const token = readSessionCookie(req);
    const record = token ? await validateSession(token, stateOpts) : undefined;
    res.json({
      pinConfigured: hasPin(stateOpts),
      pinUpdatedAt: readPinMeta(stateOpts)?.updatedAt ?? null,
      authenticated: Boolean(record),
      deviceId: record?.deviceId ?? null,
      deviceLabel: record?.deviceLabel ?? null,
      binding: record?.binding ?? null,
      scope: record?.scope ?? null,
      // Drives the PWA's silent self-upgrade: on seeing this it generates a
      // non-extractable keypair and POSTs the public half to /auth/device-key,
      // with no user interaction.
      needsDeviceUpgrade: record ? record.binding !== 'key' : false,
      // Only meaningful to a caller that already holds this exact token.
      sessionFingerprint: token && record ? sessionFingerprint(token) : null,
    });
  });

  router.post('/auth/login', async (req, res) => {
    const ip = clientIp(req);
    const pin = typeof req.body?.pin === 'string' ? req.body.pin : '';
    const deviceLabel = typeof req.body?.deviceLabel === 'string' ? req.body.deviceLabel : undefined;

    if (!hasPin(stateOpts)) {
      res.status(409).json({ error: 'PIN_NOT_CONFIGURED' });
      return;
    }

    const gate = checkAttempt(ip, stateOpts);
    if (!gate.allowed) {
      res.status(429)
        .set('Retry-After', String(Math.ceil(gate.retryAfterMs / 1000)))
        .json({ error: 'LOCKED_OUT', retryAfterMs: gate.retryAfterMs });
      return;
    }

    let ok = false;
    try {
      ok = await verifyPin(pin, stateOpts);
    } catch {
      ok = false;
    }

    if (!ok) {
      const decision = await recordFailure(ip, stateOpts);
      const status = decision.allowed ? 401 : 429;
      const errorCode = decision.allowed
        ? 'BAD_PIN'
        : decision.globalLocked
          ? 'GLOBAL_LOCKED_OUT'
          : 'LOCKED_OUT';
      const body: Record<string, unknown> = { error: errorCode };
      if (!decision.allowed) body.retryAfterMs = decision.retryAfterMs;
      if (!decision.allowed) res.set('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));

      await notifyGlobalLockdown('pin', decision);

      res.status(status).json(body);
      return;
    }

    await recordSuccess(ip, stateOpts);
    // A PIN predating the 8-char floor still logs in — locking those users out
    // would be a worse outcome than the weak PIN itself, especially since PIN
    // is the recovery path when you are away from the Mac that holds the QR.
    // Instead it lands in a sandbox that can do nothing but set a stronger one.
    const needsRotation = pinNeedsRotation(stateOpts);
    const { token, record } = await createSession(
      {
        deviceLabel,
        devicePublicKeyJwk: readDeviceKeyFromBody(req),
        ip,
        scope: needsRotation ? 'pin-rotation' : 'full',
      },
      stateOpts,
    );
    setSessionCookie(req, res, token);
    res.json({
      deviceId: record.deviceId,
      deviceLabel: record.deviceLabel,
      expiresAt: record.expiresAt,
      binding: record.binding,
      scope: record.scope,
      pinRotationRequired: needsRotation,
      // The client signs every subsequent proof over this, binding it to this
      // exact session token.
      sessionFingerprint: sessionFingerprint(token),
    });
  });

  router.post('/auth/pair', async (req, res) => {
    const ip = clientIp(req);
    const pairToken = typeof req.body?.pairToken === 'string'
      ? req.body.pairToken.trim()
      : (typeof req.body?.token === 'string' ? req.body.token.trim() : '');
    const deviceLabel = typeof req.body?.deviceLabel === 'string' ? req.body.deviceLabel : undefined;
    if (!pairToken) {
      res.status(400).json({ error: 'PAIR_TOKEN_REQUIRED' });
      return;
    }

    // Pairing mints a full session exactly like PIN login does, but was
    // previously unlimited. The 256-bit token means guessing is not the threat;
    // this bounds resource abuse and makes the window after a photographed or
    // shoulder-surfed QR noisy instead of silent. Budgeted separately from
    // 'pin' so PIN failures can never lock out the pairing recovery path.
    const pairOpts = { ...stateOpts, scope: 'pair' as const };
    const gate = checkAttempt(ip, pairOpts);
    if (!gate.allowed) {
      res.status(429)
        .set('Retry-After', String(Math.ceil(gate.retryAfterMs / 1000)))
        .json({ error: 'LOCKED_OUT', retryAfterMs: gate.retryAfterMs });
      return;
    }

    const pairing = await consumeMobilePairingCode(pairToken, stateOpts);
    if (!pairing) {
      const decision = await recordFailure(ip, pairOpts);
      await notifyGlobalLockdown('pair', decision);
      if (!decision.allowed) {
        res.status(429)
          .set('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)))
          .json({
            error: decision.globalLocked ? 'GLOBAL_LOCKED_OUT' : 'LOCKED_OUT',
            retryAfterMs: decision.retryAfterMs,
          });
        return;
      }
      res.status(401).json({ error: 'INVALID_PAIRING_CODE' });
      return;
    }

    await recordSuccess(ip, pairOpts);
    const { token, record } = await createSession(
      {
        deviceLabel,
        devicePublicKeyJwk: readDeviceKeyFromBody(req),
        ip,
        // A re-pair of a known phone keeps its identity, so it stays one row in
        // the device list instead of appearing as a stranger each time.
        deviceId: pairing.deviceId,
      },
      stateOpts,
    );
    setSessionCookie(req, res, token);
    res.json({
      deviceId: record.deviceId,
      deviceLabel: record.deviceLabel,
      expiresAt: record.expiresAt,
      binding: record.binding,
      sessionFingerprint: sessionFingerprint(token),
    });
  });

  /**
   * Mint an origin handoff. LAN doors only — the whole point is that the
   * authorization happened at home. Requires a live authenticated session
   * (and its device proof), so only a phone that already paired can ask.
   */
  router.post('/auth/origin-handoff', requireMobileSession, (req, res) => {
    if (req.clemIngress === 'relay') {
      res.status(403).json({ error: 'LAN_ONLY' });
      return;
    }
    const ctx = req.mobileSession!;
    const handoff = mintOriginHandoff(ctx.record.deviceId, ctx.record.deviceLabel);
    res.json(handoff);
  });

  /**
   * Redeem an origin handoff at the origin that needs a session (the relay
   * door). Anonymous by necessity — the browser has nothing else to present
   * here — so the token IS the credential, and it is rate-limited on the same
   * budget as pairing.
   */
  router.post('/auth/origin-adopt', async (req, res) => {
    const ip = clientIp(req);
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token) {
      res.status(400).json({ error: 'HANDOFF_TOKEN_REQUIRED' });
      return;
    }
    const adoptOpts = { ...stateOpts, scope: 'pair' as const };
    const gate = checkAttempt(ip, adoptOpts);
    if (!gate.allowed) {
      res.status(429)
        .set('Retry-After', String(Math.ceil(gate.retryAfterMs / 1000)))
        .json({ error: 'LOCKED_OUT', retryAfterMs: gate.retryAfterMs });
      return;
    }
    const handoff = consumeOriginHandoff(token);
    if (!handoff) {
      const decision = await recordFailure(ip, adoptOpts);
      await notifyGlobalLockdown('pair', decision);
      if (!decision.allowed) {
        res.status(429)
          .set('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)))
          .json({
            error: decision.globalLocked ? 'GLOBAL_LOCKED_OUT' : 'LOCKED_OUT',
            retryAfterMs: decision.retryAfterMs,
          });
        return;
      }
      res.status(401).json({ error: 'INVALID_HANDOFF' });
      return;
    }
    await recordSuccess(ip, adoptOpts);
    const { token: sessionToken, record } = await createSession(
      {
        deviceLabel: handoff.deviceLabel,
        devicePublicKeyJwk: readDeviceKeyFromBody(req),
        ip,
        // Same device identity as the LAN session: one phone, one row in the
        // device list, revocable as one thing.
        deviceId: handoff.deviceId,
      },
      stateOpts,
    );
    setSessionCookie(req, res, sessionToken);
    res.json({
      deviceId: record.deviceId,
      deviceLabel: record.deviceLabel,
      expiresAt: record.expiresAt,
      binding: record.binding,
      sessionFingerprint: sessionFingerprint(sessionToken),
    });
  });

  router.post('/auth/logout', async (req, res) => {
    const token = readSessionCookie(req);
    if (token) await revokeSession(token, stateOpts);
    res.clearCookie(MOBILE_SESSION_COOKIE, { path: '/', secure: mobileCookieSecure(req), sameSite: 'lax' });
    res.json({ ok: true });
  });

  /**
   * Silent upgrade path for a session that predates device binding.
   *
   * Deliberately NOT behind requireMobileSession: that middleware demands a
   * proof for key-bound sessions, and this is the one request a not-yet-bound
   * client must be able to make. It authenticates on the cookie alone, then
   * bindDeviceKey refuses outright if the session is already key-bound — so a
   * stolen cookie cannot use this to swap in a key the thief controls.
   */
  router.post('/auth/device-key', async (req, res) => {
    const token = readSessionCookie(req);
    if (!token) {
      res.status(401).json({ error: 'NO_SESSION' });
      return;
    }
    const record = await validateSession(token, stateOpts);
    if (!record) {
      res.status(401).json({ error: 'INVALID_SESSION' });
      return;
    }
    const jwk = req.body?.devicePublicKeyJwk as unknown;
    if (!isSupportedDeviceKey(jwk)) {
      res.status(400).json({ error: 'UNSUPPORTED_DEVICE_KEY' });
      return;
    }
    const bound = await bindDeviceKey(token, jwk, stateOpts);
    if (!bound) {
      res.status(409).json({ error: 'ALREADY_BOUND' });
      return;
    }
    setSessionCookie(req, res, bound.token);
    res.json({
      deviceId: bound.record.deviceId,
      binding: bound.record.binding,
      sessionFingerprint: sessionFingerprint(bound.token),
      expiresAt: bound.record.expiresAt,
    });
  });

  /**
   * Self-service PIN rotation — the way out of the pin-rotation sandbox.
   *
   * Requires the CURRENT PIN as well as the session, so a stolen session
   * cannot silently change the credential out from under the owner. On success
   * every session for this device is re-issued at full scope, because the
   * reason for the sandbox no longer holds.
   */
  router.post('/auth/pin', requireMobileSession, async (req, res) => {
    const currentPin = typeof req.body?.currentPin === 'string' ? req.body.currentPin : '';
    const newPin = typeof req.body?.newPin === 'string' ? req.body.newPin : '';

    const invalid = validatePinForSet(newPin);
    if (invalid) {
      res.status(400).json({ error: invalid.code, message: invalid.message });
      return;
    }

    const ip = clientIp(req);
    const gate = checkAttempt(ip, stateOpts);
    if (!gate.allowed) {
      res.status(429)
        .set('Retry-After', String(Math.ceil(gate.retryAfterMs / 1000)))
        .json({ error: 'LOCKED_OUT', retryAfterMs: gate.retryAfterMs });
      return;
    }

    let ok = false;
    try {
      ok = await verifyPin(currentPin, stateOpts);
    } catch {
      ok = false;
    }
    if (!ok) {
      const decision = await recordFailure(ip, stateOpts);
      await notifyGlobalLockdown('pin', decision);
      res.status(401).json({ error: 'BAD_PIN' });
      return;
    }
    await recordSuccess(ip, stateOpts);

    await setPin(newPin, stateOpts);

    // Re-issue at full scope. The old token is revoked rather than upgraded in
    // place so the sandboxed value cannot keep being used.
    const session = req.mobileSession!;
    await revokeSession(session.token, stateOpts);
    const { token, record } = await createSession(
      {
        deviceLabel: session.record.deviceLabel,
        devicePublicKeyJwk: session.record.devicePublicKeyJwk,
        deviceId: session.record.deviceId,
        ip,
        scope: 'full',
      },
      stateOpts,
    );
    setSessionCookie(req, res, token);
    res.json({
      ok: true,
      deviceId: record.deviceId,
      scope: record.scope,
      binding: record.binding,
      sessionFingerprint: sessionFingerprint(token),
    });
  });

  /**
   * Mints a single-use ticket for an SSE stream.
   *
   * EventSource cannot set headers, so a stream cannot carry the device proof
   * every other request uses. Spending one proof-authenticated POST to get an
   * opaque 60-second ticket keeps the binding guarantee without writing a
   * signature into access logs and browser history.
   */
  router.post('/auth/stream-ticket', requireMobileSession, (req, res) => {
    const targetPath = typeof req.body?.path === 'string' ? req.body.path : '';
    if (!targetPath.startsWith('/m/api/')) {
      res.status(400).json({ error: 'INVALID_STREAM_PATH' });
      return;
    }
    const record = req.mobileSession!.record;
    res.json({
      ticket: mintStreamTicket(record.deviceId, targetPath),
      expiresInMs: STREAM_TICKET_TTL_MS,
    });
  });

  router.post('/auth/rotate', async (req, res) => {
    if (!deps.isAdminAuthorized(req)) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }
    const pin = typeof req.body?.pin === 'string' ? req.body.pin : '';
    try {
      await setPin(pin, stateOpts);
    } catch (err) {
      res.status(400).json({ error: 'INVALID_PIN', message: (err as Error).message });
      return;
    }
    const revoked = await revokeAllSessions(stateOpts);
    res.json({ ok: true, revokedSessions: revoked, updatedAt: new Date().toISOString() });
  });

  router.get('/auth/sessions', (req, res) => {
    if (!deps.isAdminAuthorized(req)) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }
    const sessions = listSessions(stateOpts).map((row) => ({
      deviceId: row.deviceId,
      deviceLabel: row.deviceLabel,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      lastSeenAt: row.lastSeenAt,
      pushSubscribed: row.pushSubscribed ?? false,
    }));
    res.json({ sessions });
  });

  /** Smoke endpoint — confirms the cookie middleware works end-to-end.
   *  Also carries the profile name so the phone can greet the way the desktop
   *  console does: resolved at runtime, never hardcoded, empty when unknown. */
  router.get('/api/whoami', requireMobileSession, async (req, res) => {
    const ctx = req.mobileSession!;
    let name = '';
    try {
      const { loadUserProfile } = await import('../runtime/user-profile.js');
      const profile = loadUserProfile() as { preferredName?: string; displayName?: string; name?: string } | null;
      name = profile?.preferredName?.trim() || profile?.displayName?.trim() || profile?.name?.trim() || '';
    } catch { /* a nameless greeting is the graceful degrade */ }
    res.json({
      deviceId: ctx.record.deviceId,
      deviceLabel: ctx.record.deviceLabel,
      expiresAt: ctx.record.expiresAt,
      lastSeenAt: ctx.record.lastSeenAt,
      name,
    });
  });

  // ─── Remote Codex re-authentication (device code) ───────────────
  //
  // The whole point of the mobile companion is doing things when you are NOT at
  // the daemon. A Codex sign-in that lapses would otherwise strand the user
  // until they got back to the machine (the desktop "Re-authenticate" button
  // runs the browser/loopback flow ON THE DAEMON). The device-code flow lets the
  // user re-auth right from the phone: begin() returns a code + URL to show, they
  // sign in, and the PWA polls until the daemon has the tokens.

  router.post('/api/auth/codex-device/begin', requireMobileSession, async (_req, res) => {
    try {
      const start = await beginCodexDeviceLogin();
      res.json(start);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/api/auth/codex-device/poll', requireMobileSession, async (req, res) => {
    const loginId = typeof req.body?.loginId === 'string' ? req.body.loginId : '';
    if (!loginId) { res.status(400).json({ error: 'loginId required' }); return; }
    try {
      res.json(await pollCodexDeviceLogin(loginId));
    } catch (err) {
      res.status(500).json({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Plan approvals ─────────────────────────────────────────────
  //
  // Plan-first proposals are higher-level approvals than individual
  // tool interrupts. Mobile needs first-class actions here; otherwise
  // the plan text renders but the user has no button to continue.

  router.get('/api/plan-proposals', requireMobileSession, (_req, res) => {
    try {
      const proposals = listPlanProposals({ status: 'pending', limit: 20 })
        .map(serializePlanProposalForMobile);
      res.json({ proposals, count: proposals.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/api/plan-proposals/:id/approve', requireMobileSession, (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const existing = getPlanProposal(id);
    if (existing && planProposalNeedsUserInput(existing)) {
      res.status(409).json({
        error: 'plan needs user input before approval',
        needsUserInput: existing.plan.needsUserInput,
      });
      return;
    }
    const result = approvePlanAndQueueBackgroundTask(id);
    if (!result) {
      res.status(404).json({ error: 'PLAN_PROPOSAL_NOT_FOUND_OR_RESOLVED' });
      return;
    }
    if (deps.assistant) {
      setImmediate(() => {
        processBackgroundTasks(deps.assistant!, 1).catch((err) => {
          console.warn('Immediate background task processor failed after mobile plan approval:', err);
        });
      });
    }
    res.json({
      proposal: serializePlanProposalForMobile(result.proposal),
      queuedTask: result.task,
      run: result.run,
    });
  });

  router.post('/api/plan-proposals/:id/reject', requireMobileSession, (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'Rejected from mobile.';
    const result = rejectPlanProposal(id, reason);
    if (!result) {
      res.status(404).json({ error: 'PLAN_PROPOSAL_NOT_FOUND' });
      return;
    }
    res.json({ proposal: serializePlanProposalForMobile(result) });
  });

  // ─── Tool approvals ─────────────────────────────────────────────
  //
  // Keep mobile on the /m surface. The public mobile hostname deliberately
  // hides /api/console/*, so approval actions cannot depend on desktop routes.

  router.get('/api/approvals', requireMobileSession, (_req, res) => {
    try {
      const approvals = approvalRegistry.listPending({ status: 'pending' })
        .filter((row) => !approvalRegistry.isExpired(row))
        .filter((row) => approvalRegistry.isFormalApprovalSurface(row))
        .map(serializeApprovalForMobile);
      res.json({ approvals, count: approvals.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  async function resolveMobileApproval(
    res: express.Response,
    id: string,
    decision: 'approve' | 'reject',
  ): Promise<void> {
    const existing = approvalRegistry.get(id);
    if (!existing) {
      res.status(404).json({ error: 'approval not found' });
      return;
    }
    if (!approvalRegistry.isFormalApprovalSurface(existing)) {
      res.status(409).json({
        error: 'This send is waiting for an ordinary answer in its exact original conversation, not a mobile approval action.',
      });
      return;
    }
    const runId = mobileApprovalRunId(id, decision);
    const replayAttempt = getLatestRunAttemptByRunId(existing.sessionId, runId);
    const auditResolution: approvalRegistry.ApprovalResolution = decision === 'reject' ? 'rejected' : 'approved';
    const replayTerminal = replayAttempt?.sourceUserSeq
      ? exactMobileApprovalTerminal(existing.sessionId, replayAttempt.sourceUserSeq)
      : null;
    const recoveringAcceptedResolution = existing.status === 'resolved'
      && existing.resolution === auditResolution
      && !!replayAttempt?.sourceUserSeq
      && !replayTerminal;
    if (existing.status !== 'pending' && !recoveringAcceptedResolution) {
      if (replayTerminal) {
          res.setHeader('Idempotent-Replay', '1');
          if (replayTerminal.presentation.status === 'failed') {
            res.status(500).json({ error: 'APPROVAL_RESUME_FAILED', message: PUBLIC_RUN_FAILURE_TEXT });
          } else {
            res.json({
              ok: true,
              approvalId: id,
              sessionId: existing.sessionId,
              status: 'replayed',
              message: replayTerminal.presentation.text,
            });
          }
          return;
      }
      res.status(409).json({ error: 'approval already resolved', approval: serializeApprovalForMobile(existing) });
      return;
    }
    if (approvalRegistry.isExpired(existing)) {
      res.status(409).json({
        error: 'approval expired',
        approval: serializeApprovalForMobile(existing),
      });
      return;
    }
    const pendingActionPreflight = exactPendingActionApprovalPreflight(existing, decision);
    if (!recoveringAcceptedResolution && pendingActionPreflight.kind === 'error') {
      res.status(pendingActionPreflight.status).json({ error: pendingActionPreflight.reason });
      return;
    }

    const sessionRowForKind = harnessGetSession(existing.sessionId);
    const harnessSession = HarnessSession.load(existing.sessionId);
    if (!sessionRowForKind || !harnessSession) {
      res.status(409).json({ error: 'approval session is unavailable' });
      return;
    }
    const shouldResume = pendingActionPreflight.kind !== 'ok'
      && sessionRowForKind.kind !== 'workflow'
      && !!harnessSession.loadInterruptState();

    const executionClaim = claimRunAttemptLease({
      sessionId: existing.sessionId,
      runId,
      ownerId: MOBILE_APPROVAL_LEASE_OWNER,
      leaseMs: MOBILE_APPROVAL_LEASE_MS,
    });
    if (!executionClaim.attempt) {
      res.status(500).json({ error: 'APPROVAL_ACCEPT_FAILED', message: PUBLIC_RUN_FAILURE_TEXT });
      return;
    }
    if (!executionClaim.claimed) {
      const latest = getLatestRunAttemptByRunId(existing.sessionId, runId);
      if (latest?.sourceUserSeq) {
        const terminal = exactMobileApprovalTerminal(existing.sessionId, latest.sourceUserSeq);
        if (terminal) {
          res.setHeader('Idempotent-Replay', '1');
          res.json({
            ok: terminal.presentation.status !== 'failed',
            approvalId: id,
            sessionId: existing.sessionId,
            status: 'replayed',
            message: terminal.presentation.status === 'failed'
              ? PUBLIC_RUN_FAILURE_TEXT
              : terminal.presentation.text,
          });
          return;
        }
      }
      res.status(202).json({
        ok: true,
        approvalId: id,
        sessionId: existing.sessionId,
        status: 'already-processing',
      });
      return;
    }

    const approvalAttempt = executionClaim.attempt;
    let acceptedApprovalSource: HarnessEventRow;
    try {
      const displayText = `${decision === 'approve' ? 'Approve' : 'Reject'} ${id}`;
      acceptedApprovalSource = recordRunAttemptUserInput(approvalAttempt, {
        turn: 0,
        role: 'user',
        data: {
          text: `${displayText}.`,
          displayText,
          synthetic: true,
          source: 'mobile_approval',
          approvalId: id,
          decision,
          runId,
          attemptId: approvalAttempt.attemptId,
        },
      }, { armRunInFlight: true });
    } catch (err) {
      console.error('mobile approval response acceptance failed:', err);
      settleMobileApprovalAttempt(approvalAttempt, 'failed');
      res.status(500).json({ error: 'APPROVAL_ACCEPT_FAILED', message: PUBLIC_RUN_FAILURE_TEXT });
      return;
    }

    const failAcceptedApproval = (stage: string, err: unknown, statusCode = 500): void => {
      const detail = err instanceof Error ? err.message : String(err);
      try {
        appendHarnessEvent({
          sessionId: existing.sessionId,
          turn: acceptedApprovalSource.turn,
          role: 'system',
          type: 'run_failed',
          data: { error: detail, stage, approvalId: id, sourceUserSeq: acceptedApprovalSource.seq },
        });
      } catch { /* private diagnostics are best-effort */ }
      let committed = false;
      try {
        commitMobileApprovalTerminal({
          source: acceptedApprovalSource,
          text: PUBLIC_RUN_FAILURE_TEXT,
          status: 'failed',
          reason: stage,
          metadata: { approvalId: id, decision },
        });
        committed = true;
      } catch (commitErr) {
        console.error('accepted mobile approval could not commit its stable failure:', commitErr);
      }
      if (committed) settleMobileApprovalAttempt(approvalAttempt, 'failed');
      res.status(statusCode).json({ error: 'APPROVAL_RESUME_FAILED', message: PUBLIC_RUN_FAILURE_TEXT });
    };

    // Background tasks retain first claim on execution ownership. Only after
    // that lane declines the card may generic mobile approval authorize a
    // pending action without resuming its serialized SDK state.
    let queued: ReturnType<typeof queueBackgroundTaskApprovalResolution> = null;
    if (!recoveringAcceptedResolution) {
      try {
        queued = queueBackgroundTaskApprovalResolution(id, decision === 'approve');
      } catch (err) {
        failAcceptedApproval('mobile_background_approval_failed', err);
        return;
      }
    }
    if (queued) {
      const text = `${decision === 'approve' ? 'Approved' : 'Rejected'} ${id}; queued background task ${queued.id}.`;
      commitMobileApprovalTerminal({
        source: acceptedApprovalSource,
        text,
        status: 'done',
        reason: 'mobile_background_approval_queued',
        metadata: { approvalId: id, decision, queuedTaskId: queued.id },
      });
      settleMobileApprovalAttempt(approvalAttempt);
      res.json({
        ok: true,
        approvalId: id,
        status: 'queued-background-task',
        queuedTaskId: queued.id,
        sessionId: queued.runSessionId,
      });
      return;
    }
    if (!shouldResume) {
      let resolvedRow = existing;
      if (!recoveringAcceptedResolution) {
        let result: ReturnType<typeof approvalRegistry.resolve>;
        try {
          result = approvalRegistry.resolve(id, auditResolution, 'mobile-inbox');
        } catch (err) {
          failAcceptedApproval('mobile_approval_resolution_failed', err);
          return;
        }
        if (!result.ok || !result.row) {
          failAcceptedApproval('mobile_approval_resolution_failed', result.reason ?? 'could not resolve approval', 409);
          return;
        }
        resolvedRow = result.row;
      }
      const status = sessionRowForKind.kind === 'workflow'
        ? 'resolved-workflow-runner-resumes'
        : pendingActionPreflight.kind === 'ok'
          ? 'resolved-pending-action-approval-only'
          : 'resolved-stale';
      const message = pendingActionPreflight.kind === 'ok'
        ? decision === 'approve'
          ? `Approved ${id}; the exact queued action is authorized, but execution is not confirmed and remains with its runtime owner.`
          : `Rejected ${id}; the exact queued action will not execute.`
        : `${decision === 'approve' ? 'Approved' : 'Rejected'} ${id}.`;
      commitMobileApprovalTerminal({
        source: acceptedApprovalSource,
        text: message,
        status: 'done',
        reason: 'mobile_approval_resolved',
        metadata: { approvalId: id, decision, status },
      });
      settleMobileApprovalAttempt(approvalAttempt);
      res.json({
        ok: true,
        approval: serializeApprovalForMobile(resolvedRow),
        status,
        message,
      });
      return;
    }

    const auth = await configureHarnessRuntime();
    if (!auth.ok) {
      console.warn('mobile approval resume blocked by unavailable model runtime:', auth.reason);
      failAcceptedApproval('mobile_approval_runtime_unavailable', auth.reason, 412);
      return;
    }

    const sessionId = existing.sessionId;
    let resolvedRow = existing;
    if (!recoveringAcceptedResolution) {
      let result: ReturnType<typeof approvalRegistry.resolve>;
      try {
        result = approvalRegistry.resolve(id, auditResolution, 'mobile-inbox');
      } catch (err) {
        failAcceptedApproval('mobile_approval_resolution_failed', err);
        return;
      }
      if (!result.ok || !result.row) {
        failAcceptedApproval('mobile_approval_resolution_failed', result.reason ?? 'could not resolve approval', 409);
        return;
      }
      resolvedRow = result.row;
    }

    res.status(202).json({
      ok: true,
      approval: serializeApprovalForMobile(resolvedRow),
      sessionId,
      status: 'resuming',
    });

    setImmediate(async () => {
      const leaseHeartbeat = setInterval(() => {
        renewRunAttemptLease(approvalAttempt, MOBILE_APPROVAL_LEASE_OWNER, MOBILE_APPROVAL_LEASE_MS);
      }, Math.floor(MOBILE_APPROVAL_LEASE_MS / 3));
      leaseHeartbeat.unref?.();
      try {
        const agent = await buildOrchestratorAgentForApprovalResume({ sessionId, allowToolJit: true });
        await runConversationFromResume({
          agent,
          sessionId,
          approvalId: id,
          decision,
          resolver: 'mobile-inbox',
          sourceUserSeq: acceptedApprovalSource.seq,
          runAttemptId: approvalAttempt.attemptId,
        });
        // A newly emitted duplicate card is a distinct control edge. Leave it
        // pending until it has its own accepted response and attempt binding.
        const pending = approvalRegistry.listPending({ sessionId, status: 'pending' });
        const exactDuplicate = selectSoleExactApprovalDuplicate(existing, pending);
        if (exactDuplicate && approvalRegistry.isActionable(exactDuplicate)) {
          appendHarnessEvent({
            sessionId,
            turn: 0,
            role: 'system',
            type: 'conversation_step',
            data: {
              reason: 'mobile_exact_duplicate_deferred',
              summary: `Repeated approval ${exactDuplicate.approvalId} remains pending for its own response.`,
              approvalId: exactDuplicate.approvalId,
              sourceUserSeq: acceptedApprovalSource.seq,
            },
          });
        }
        const terminal = exactMobileApprovalTerminal(sessionId, acceptedApprovalSource.seq);
        settleMobileApprovalAttempt(approvalAttempt, terminal ? 'completed' : 'failed');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          appendHarnessEvent({
            sessionId,
            turn: 0,
            role: 'system',
            type: 'run_failed',
            data: { error: message, stage: 'mobile_approval_resume' },
          });
        } catch {
          /* best effort */
        }
        let committed = false;
        try {
          commitMobileApprovalTerminal({
            source: acceptedApprovalSource,
            text: PUBLIC_RUN_FAILURE_TEXT,
            status: 'failed',
            reason: 'mobile_approval_resume_failed',
            metadata: { approvalId: id, decision },
          });
          committed = true;
        } catch (commitErr) {
          console.error('accepted mobile approval resume could not commit its stable failure:', commitErr);
        }
        if (committed) settleMobileApprovalAttempt(approvalAttempt, 'failed');
      } finally {
        clearInterval(leaseHeartbeat);
      }
    });
  }

  router.post('/api/approvals/:id/approve', requireMobileSession, async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    await resolveMobileApproval(res, id, 'approve');
  });

  router.post('/api/approvals/:id/reject', requireMobileSession, async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    await resolveMobileApproval(res, id, 'reject');
  });

  // ─── Web Push ───────────────────────────────────────────────────
  //
  // The PWA calls `getVapidPublicKey()` first, then registers its
  // PushSubscription with the daemon, which stores it as a web_push
  // NotificationDestination. The existing delivery pipeline (Discord
  // fan-out, retry, dedupe) then carries every approval / reply /
  // proactive brief to the phone.

  router.get('/push/vapid-key', (_req, res) => {
    const publicKey = getVapidPublicKey(stateOpts);
    res.json({ publicKey });
  });

  router.post('/push/subscribe', requireMobileSession, async (req, res) => {
    const ctx = req.mobileSession!;
    const body = req.body ?? {};
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
    const keys = (body.keys ?? {}) as { p256dh?: unknown; auth?: unknown };
    const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : '';
    const auth = typeof keys.auth === 'string' ? keys.auth : '';
    const expirationTime = typeof body.expirationTime === 'number' ? body.expirationTime : null;
    if (!endpoint || !p256dh || !auth) {
      res.status(400).json({ error: 'INVALID_SUBSCRIPTION' });
      return;
    }
    if (!/^https:\/\//.test(endpoint)) {
      res.status(400).json({ error: 'ENDPOINT_NOT_HTTPS' });
      return;
    }
    const destination = upsertWebPushDestination({
      endpoint,
      p256dh,
      auth,
      deviceId: ctx.record.deviceId,
      deviceLabel: ctx.record.deviceLabel,
      expirationTime,
    });
    await markPushSubscribed(ctx.token, true, stateOpts).catch(() => undefined);
    res.json({ ok: true, destinationId: destination.id });
  });

  /**
   * Native iOS push registration. The Clem app obtains an APNs device token
   * and hands it in over the same authenticated device session the PWA uses
   * — the native shell asks the page to make this call, so the device-bound
   * proof machinery stays the single auth path. Idempotent per device.
   */
  router.post('/push/apns', requireMobileSession, async (req, res) => {
    const ctx = req.mobileSession!;
    const deviceToken = typeof req.body?.deviceToken === 'string' ? req.body.deviceToken.trim() : '';
    // APNs tokens are opaque hex; 64 bytes today but Apple says do not assume.
    if (!/^[0-9a-fA-F]{16,512}$/.test(deviceToken)) {
      res.status(400).json({ error: 'INVALID_DEVICE_TOKEN' });
      return;
    }
    const destination = upsertApnsDestination({
      deviceToken: deviceToken.toLowerCase(),
      deviceId: ctx.record.deviceId,
      deviceLabel: ctx.record.deviceLabel,
    });
    await markPushSubscribed(ctx.token, true, stateOpts).catch(() => undefined);
    res.json({ ok: true, destinationId: destination.id });
  });

  // ─── Chat (read-only) ──────────────────────────────────────────
  //
  // The PWA lists harness chat sessions and renders a transcript per
  // session. Read-only in Week 4; Week 5 adds a send box.
  //
  // Mobile-friendly shapes — we drop fields the phone doesn't render
  // (token budget, plan IDs, raw metadata) to keep payloads small.

  router.get('/api/chat/sessions', requireMobileSession, (_req, res) => {
    const sessions = harnessListSessions({ limit: 80 })
      // Only chat-like sessions land on the phone — workflow / execution
      // sessions belong on the dashboard, not in the mobile chat list.
      .filter((session) => session.kind === 'chat')
      .map(serializeSessionForMobile);
    res.json({ sessions });
  });

  router.get('/api/chat/sessions/:sessionId', requireMobileSession, (req, res) => {
    const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
    const session = harnessGetSession(sessionId);
    if (!session) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    const events = projectHarnessEventsForPublic(harnessListEvents(session.id, { limit: 500 }));
    res.json({
      session: serializeSessionForMobile(session),
      events: events.map(serializeEventForMobile),
      latestSeq: harnessLatestEventSeq(session.id),
    });
  });

  /**
   * SSE stream that replays the transcript and then forwards live
   * events. Mirrors /api/sessions/:id/events but with mobile-friendly
   * payloads and PIN-cookie auth.
   *
   * Note: EventSource doesn't send cookies cross-origin by default,
   * but the PWA is same-origin (/m/* is served by the daemon), so
   * the session cookie rides along automatically.
   */
  router.get('/api/chat/sessions/:sessionId/stream', requireMobileSession, (req, res) => {
    const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
    const session = harnessGetSession(sessionId);
    if (!session) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    // SSE resume: when the browser reconnects after a drop, it sends
    // the `Last-Event-ID` header carrying the last `id:` we emitted
    // (which is the harness event seq). Explicit ?sinceSeq= wins so
    // clients can also override.
    const queryRaw = typeof req.query.sinceSeq === 'string' ? Number(req.query.sinceSeq) : NaN;
    const headerRaw = typeof req.headers['last-event-id'] === 'string'
      ? Number(req.headers['last-event-id'])
      : NaN;
    const sinceSeq = Number.isFinite(queryRaw) && queryRaw > 0
      ? queryRaw
      : (Number.isFinite(headerRaw) && headerRaw > 0 ? headerRaw : 0);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    // Emit `id: <seq>` on each frame so the browser sends
    // Last-Event-ID on reconnect; `seq` is monotonic per session.
    const writeEvent = (name: string, payload: unknown, eventSeq?: number): void => {
      if (closed || res.destroyed) return;
      if (typeof eventSeq === 'number' && Number.isFinite(eventSeq)) {
        res.write(`id: ${eventSeq}\n`);
      }
      res.write(`event: ${name}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      // Merge host-dispatched workflow activity into the replay so a
      // reconnect mid-run seeds the live activity strip instead of waiting
      // for the next tool frame — same rule as the desktop console stream.
      const ownEvents = harnessListEvents(session.id, { sinceSeq, limit: 500 });
      const bridged = collectBridgedWorkflowReplay(session.id, ownEvents)
        .filter((ev) => ev.seq > sinceSeq);
      const merged = [...ownEvents, ...bridged].sort((a, b) => a.seq - b.seq);
      const replay = projectHarnessEventsForPublic(merged.slice(-500));
      const shaped = replay.map(serializeEventForMobile);
      // The resume cursor must come from the session's OWN ledger — bridged
      // frames carry foreign seq numbers that would corrupt it.
      const ownShaped = shaped.filter((ev) => ev.sessionId === session.id);
      const lastSeq = ownShaped.length > 0 ? ownShaped[ownShaped.length - 1].seq : sinceSeq;
      writeEvent(
        'replay',
        {
          sessionId: session.id,
          sessionStatus: session.status,
          events: shaped,
          latestSeq: lastSeq,
        },
        lastSeq > 0 ? lastSeq : undefined,
      );
    } catch (err) {
      console.error('mobile chat replay failed:', err);
      writeEvent('replay', { sessionId: session.id, events: [], error: PUBLIC_RUN_FAILURE_TEXT });
    }

    // Besides the session's own events, forward activity-shaped events from
    // background tasks this chat spawned and from host-dispatched workflow
    // step sessions whose origin observer is this chat — without them the
    // phone shows a silent bubble for the whole delegated run.
    const bridgesToThisSession = createBridgePredicate(session.id);
    const unsubscribe = actionBus.subscribe((event) => {
      if (event.kind !== 'harness.public_event') return;
      if (event.sessionId !== session.id) {
        if (!isCanonicalBridgedActivity(event.event)) return;
        if (!bridgesToThisSession(event.sessionId)) return;
      }
      const shaped = serializeEventForMobile(event.event as HarnessEventRow);
      // Only the session's own frames advance the browser's Last-Event-ID —
      // a bridged frame's foreign seq must never become the resume cursor.
      writeEvent('event', shaped, shaped.sessionId === session.id ? shaped.seq : undefined);
    });

    // Phone-in-hand is the same "in the room" signal the desktop dock provides:
    // while this stream is open the user is watching, so a run that lands now
    // does not also need an out-of-band ping. See terminal-report-back.ts.
    const detachViewer = attachSessionViewer(session.id);
    const heartbeat = setInterval(() => {
      if (closed || res.destroyed) return;
      res.write(`: ping\n\n`);
    }, 15_000);
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      detachViewer();
      unsubscribe();
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
  });

  /**
   * JSON catch-up for the chat stream. The stream can die without the client
   * ever seeing an HTTP status (webview suspension, cellular handoff, spent
   * stream ticket), and the live defect this fixes was exactly that: a turn
   * completed server-side and the phone never rendered it. This endpoint
   * lets the client poll the same serialized events over normal fetch auth
   * (device proof — no ticket needed) and recover the visible turn.
   */
  router.get('/api/chat/sessions/:sessionId/events/recent', requireMobileSession, (req, res) => {
    const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
    const session = harnessGetSession(sessionId);
    if (!session) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    const sinceSeqRaw = typeof req.query.sinceSeq === 'string' ? Number(req.query.sinceSeq) : 0;
    const sinceSeq = Number.isFinite(sinceSeqRaw) && sinceSeqRaw > 0 ? sinceSeqRaw : 0;
    const limit = clampInt(req.query.limit, 200, 1, 500);
    try {
      const ownEvents = harnessListEvents(session.id, { sinceSeq, limit });
      const bridged = collectBridgedWorkflowReplay(session.id, ownEvents)
        .filter((ev) => ev.seq > sinceSeq);
      const merged = [...ownEvents, ...bridged].sort((a, b) => a.seq - b.seq);
      const shaped = projectHarnessEventsForPublic(merged.slice(-limit)).map(serializeEventForMobile);
      const ownShaped = shaped.filter((ev) => ev.sessionId === session.id);
      res.json({
        sessionId: session.id,
        sessionStatus: session.status,
        events: shaped,
        latestSeq: ownShaped.length > 0 ? ownShaped[ownShaped.length - 1].seq : sinceSeq,
      });
    } catch (err) {
      console.error('mobile chat catch-up failed:', err);
      res.status(500).json({ error: 'CATCH_UP_FAILED' });
    }
  });

  /**
   * Mobile chat send. Cookie-gated; requires Idempotency-Key.
   *
   * Body shape:
   *   { message: string, sessionId?: string }
   *
   * Header:
   *   Idempotency-Key: <opaque-uuid>
   *
   * Behaviour:
   *   - If sessionId is omitted, derive one stable id from (deviceId, key).
   *   - Durably bind (deviceId, key) to one payload/session/run before work.
   *     The short-lived response cache is only an optimization after that
   *     authority check; restart replay comes from the graph terminal.
   *   - Delegates to ClementineGateway.handleMessage with
   *     source:'mobile' so run-events + harness eventlog all carry the
   *     mobile origin.
   */
  router.post('/api/chat/send', requireMobileSession, async (req, res) => {
    if (!deps.assistant) {
      res.status(503).json({ error: 'CHAT_SEND_UNAVAILABLE' });
      return;
    }
    const ctx = req.mobileSession!;
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
      res.status(400).json({ error: 'EMPTY_MESSAGE' });
      return;
    }
    if (message.length > 8000) {
      res.status(413).json({ error: 'MESSAGE_TOO_LARGE' });
      return;
    }
    const idempotencyKey = (() => {
      const raw = req.headers['idempotency-key'];
      if (typeof raw === 'string') return raw.trim();
      if (Array.isArray(raw) && raw.length > 0) return String(raw[0]).trim();
      return '';
    })();
    if (!idempotencyKey) {
      res.status(400).json({ error: 'MISSING_IDEMPOTENCY_KEY' });
      return;
    }

    const scope = `chat:${ctx.record.deviceId}`;
    const digest = mobileChatDigest(ctx.record.deviceId, idempotencyKey);
    const requestId = `mobile:${digest}`;
    const runId = `run-mobile-${digest}`;
    const requestedSessionId = typeof req.body?.sessionId === 'string' && req.body.sessionId.trim()
      ? req.body.sessionId.trim()
      : null;
    const proposedSessionId = requestedSessionId ?? `sess-mob-${digest.slice(0, 32)}`;
    const inputHash = mobileChatPayloadHash(message, requestedSessionId);

    // Workspace-scoped chat is a SESSION-ID CONVENTION (space-<slug>), not a
    // payload field — same rule as the desktop dock. Recognizing it here is
    // what makes "chat about this workspace" from the phone land in the SAME
    // continuous thread the desktop uses, with the same workspace metadata.
    const spaceSlug = requestedSessionId && /^space-[a-z0-9][a-z0-9-]*$/.test(requestedSessionId)
      ? requestedSessionId.slice('space-'.length)
      : null;

    try {
      // The receipt has a session FK, so create the deterministic session first
      // only on a genuinely new key. Replays recover its original durable id.
      const priorReceipt = getHarnessChatRequestReceipt(requestId);
      if (!priorReceipt && !harnessGetSession(proposedSessionId)) {
        createHarnessChatSession({
          id: proposedSessionId,
          kind: 'chat',
          channel: 'mobile',
          userId: ctx.record.deviceId,
          title: message.length > 80 ? `${message.slice(0, 77)}...` : message,
          metadata: spaceSlug ? { source: 'workspace', spaceSlug } : { source: 'mobile' },
        });
      }
      let requestClaim: ReturnType<typeof claimHarnessChatRequest>;
      try {
        requestClaim = claimHarnessChatRequest({
          requestId,
          sessionId: proposedSessionId,
          runId,
          inputHash,
          sinceSeq: harnessLatestEventSeq(proposedSessionId),
        });
      } catch (err) {
        console.warn('mobile idempotency key conflict:', err);
        res.status(409).json({ error: 'IDEMPOTENCY_KEY_CONFLICT' });
        return;
      }
      const { sessionId } = requestClaim.receipt;
      if (!requestClaim.inserted) res.setHeader('Idempotent-Replay', '1');

      // Validate the durable key binding before consulting this optimization.
      const cached = lookupIdempotent<ChatSendResponse>(scope, idempotencyKey);
      if (cached.cached) {
        res.json(cached.value);
        return;
      }

      // Lane parity with the desktop dock: seed the workspace context primer
      // (idempotent by prefix) so the gateway lane knows WHICH workspace this
      // thread is about. The Claude SDK lane derives it from the session id on
      // its own; without this, the orchestrator lane was a contextless generic
      // assistant — the exact drift the primer was collapsed to prevent.
      if (spaceSlug) {
        try {
          const { HarnessSession } = await import('../runtime/harness/session.js');
          const { buildWorkspaceContextPrimer } = await import('../spaces/workspace-context.js');
          const harnessSession = HarnessSession.load(sessionId);
          const primer = buildWorkspaceContextPrimer(spaceSlug);
          if (harnessSession && primer) harnessSession.setContextPrimer('[workspace-context]', primer);
        } catch { /* best-effort primer */ }
      }

      let execution = mobileChatInFlight.get(requestId);
      if (!execution) {
        const started = new ClementineGateway(deps.assistant).handleMessage({
          message,
          sessionId,
          userId: ctx.record.deviceId,
          channel: 'mobile',
          source: 'mobile',
          runId: requestClaim.receipt.runId,
          // A process may die after the logical turn is durably accepted but
          // before its public terminal is committed. A client retry must not
          // turn that uncertainty into a second tool/write dispatch. The
          // gateway replays an existing terminal when present and otherwise
          // closes the accepted source with one stable failed terminal.
          failClosedOnUnsettledReplay: !requestClaim.inserted,
        });
        execution = started.finally(() => {
          if (mobileChatInFlight.get(requestId) === execution) mobileChatInFlight.delete(requestId);
        });
        mobileChatInFlight.set(requestId, execution);
      }
      // Async mode: acknowledge the durable claim and let the reply ride the
      // event stream. A phone must never hold a fetch open across a whole
      // turn — the webview suspends on lock and the connection dies with it,
      // while the accepted run keeps going. Idempotent replays of the same
      // key get the same acknowledgement (and the same run).
      if (req.body?.async === true) {
        execution.catch((err) => console.error('mobile chat async run failed:', err));
        res.status(202).json({
          accepted: true,
          sessionId,
          runId: requestClaim.receipt.runId,
          sinceSeq: requestClaim.receipt.sinceSeq,
        });
        return;
      }
      const gatewayResponse = await execution;
      if (gatewayResponse.stoppedReason === 'error') {
        res.status(500).json({ error: 'CHAT_SEND_FAILED', message: PUBLIC_RUN_FAILURE_TEXT });
        return;
      }
      const payload: ChatSendResponse = {
        sessionId: gatewayResponse.sessionId,
        runId: gatewayResponse.runId,
        reply: gatewayResponse.text,
        pendingApprovalId: gatewayResponse.pendingApprovalId,
        queuedTaskId: gatewayResponse.queuedTaskId,
        stoppedReason: gatewayResponse.stoppedReason,
        turnsUsed: gatewayResponse.turnsUsed,
        route: gatewayResponse.route,
      };
      rememberIdempotent(scope, idempotencyKey, payload);
      res.json(payload);
    } catch (err) {
      // Don't cache failures — a retry might genuinely succeed.
      console.error('mobile chat send failed:', err);
      res.status(500).json({ error: 'CHAT_SEND_FAILED', message: PUBLIC_RUN_FAILURE_TEXT });
    }
  });

  // ─── Memory (read-only) ─────────────────────────────────────────

  router.get('/api/memory/search', requireMobileSession, async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      res.json({
        query: '',
        hits: [],
        answerability: 'insufficient',
        diagnostics: { candidates: 0, stores: [], elapsedMs: 0 },
      });
      return;
    }
    const limit = clampInt(req.query.limit, 20, 1, 50);
    try {
      // Keep the original mobile hit contract while sourcing it from the same
      // evidence-backed, temporal, graph-assisted pipeline used by the agent
      // and desktop console. A fact/episode/person/resource must not become
      // invisible merely because the user searched from their phone.
      const result = await recallMemory(q, { limit, graphDepth: 1 });
      res.json({
        query: q,
        hits: result.hits.map((hit) => ({
          path: hit.ref.type === 'note' ? hit.ref.id : `${hit.ref.type}:${hit.ref.id}`,
          title: hit.title ?? `${hit.ref.type} memory`,
          snippet: hit.text.slice(0, 280),
          score: Number(hit.score.toFixed(3)),
          ref: hit.ref,
          confidence: Number(hit.confidence.toFixed(3)),
          evidenceCount: hit.evidence.length,
          whyRecalled: hit.whyRecalled,
        })),
        answerability: result.answerability,
        diagnostics: result.diagnostics,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/api/memory/facts', requireMobileSession, (req, res) => {
    const kindRaw = typeof req.query.kind === 'string' ? req.query.kind : '';
    const validKinds: ConsolidatedFactKind[] = ['user', 'project', 'feedback', 'reference'];
    const kind = (validKinds as string[]).includes(kindRaw) ? (kindRaw as ConsolidatedFactKind) : undefined;
    const limit = clampInt(req.query.limit, 40, 1, 120);
    try {
      const facts = listActiveFacts({ kind, limit });
      res.json({
        facts: facts.map((fact) => ({
          id: fact.id,
          kind: fact.kind,
          content: fact.content,
          importance: fact.importance ?? null,
          updatedAt: fact.updatedAt,
          lastAccessedAt: fact.lastAccessedAt ?? null,
          pinned: fact.pinned === true,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Fact detail — full content plus everything the desktop's fact card shows:
   * evidence, validity history (the "continued as #N" supersession chain),
   * and the policy attached to it. Same enrichment call the desktop list
   * route makes per row (getFactWithEvidence); the phone just asks for one.
   */
  router.get('/api/memory/facts/:id', requireMobileSession, async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return; }
    try {
      const { getFactWithEvidence } = await import('../memory/facts.js');
      const { listMemoryPolicies } = await import('../memory/temporal-memory.js');
      const fact = getFactWithEvidence(id);
      if (!fact) { res.status(404).json({ error: `no fact #${id}` }); return; }
      const policy = listMemoryPolicies().find((p) => p.fact_id === id) ?? null;
      res.json({ fact, policy });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Memory mutations — the same four verbs the desktop console exposes, each
   * delegating to the canonical function so all surfaces share ONE
   * implementation and ONE safety story:
   *  - corrections SUPERSEDE (validity chain + pin transfer preserved), never
   *    overwrite;
   *  - forget is soft-delete only — hard delete is never exposed here;
   *  - every successful mutation bumps the stable-context generation, or the
   *    running agent's prompt cache keeps serving the retired/unpinned fact.
   *    (We bump on supersede too: the old content is retired there as well.)
   */
  router.post('/api/memory/facts/:id/forget', requireMobileSession, async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return; }
    try {
      const { forgetFact } = await import('../memory/facts.js');
      const { bumpStableContextGeneration } = await import('../runtime/stable-context-generation.js');
      const ok = forgetFact(id);
      if (ok) bumpStableContextGeneration();
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/api/memory/facts/:id/restore', requireMobileSession, async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return; }
    try {
      const { reactivateFact } = await import('../memory/facts.js');
      const { bumpStableContextGeneration } = await import('../runtime/stable-context-generation.js');
      const ok = reactivateFact(id);
      if (ok) bumpStableContextGeneration();
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/api/memory/facts/:id/pin', requireMobileSession, async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return; }
    const pinned = ((req.body ?? {}) as { pinned?: unknown }).pinned !== false;
    try {
      const { getFact, setFactPinned } = await import('../memory/facts.js');
      const { bumpStableContextGeneration } = await import('../runtime/stable-context-generation.js');
      if (!getFact(id)) { res.status(404).json({ error: `no fact #${id}` }); return; }
      const ok = setFactPinned(id, pinned);
      if (ok) bumpStableContextGeneration();
      res.json({ ok, pinned });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.patch('/api/memory/facts/:id', requireMobileSession, async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return; }
    const body = (req.body ?? {}) as { content?: unknown; importance?: unknown };
    const patch: { content?: string; importance?: number } = {};
    if (typeof body.content === 'string' && body.content.trim()) patch.content = body.content.trim().slice(0, 800);
    if (typeof body.importance === 'number' && Number.isFinite(body.importance)) patch.importance = Math.max(0, Math.min(10, body.importance));
    if (patch.content === undefined && patch.importance === undefined) {
      res.status(400).json({ error: 'nothing to update (provide content and/or importance)' });
      return;
    }
    try {
      const { getFact, supersedeFact, updateFact } = await import('../memory/facts.js');
      const { bumpStableContextGeneration } = await import('../runtime/stable-context-generation.js');
      const existing = getFact(id);
      if (!existing) { res.status(404).json({ error: `no fact #${id}` }); return; }
      const updated = patch.content
        ? supersedeFact(id, {
            content: patch.content,
            importance: patch.importance ?? existing.importance ?? undefined,
            trustLevel: 1,
            sourceApp: 'Clementine Mobile',
          })
        : updateFact(id, { importance: patch.importance });
      if (!updated) { res.status(404).json({ error: `no fact #${id}` }); return; }
      if (patch.content) bumpStableContextGeneration();
      res.json({ ok: true, fact: updated, supersededFactId: patch.content ? id : null });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Remember something new, from the phone. Routes through consolidateFact —
   * the same dedup-aware path the desktop add box and the agent's own
   * reflection use — never a blind insert: the outcome can be add, reinforce,
   * supersede, or ignore.
   */
  router.post('/api/memory/facts', requireMobileSession, async (req, res) => {
    const kindRaw = typeof req.body?.kind === 'string' ? req.body.kind : 'user';
    const validKinds: ConsolidatedFactKind[] = ['user', 'project', 'feedback', 'reference'];
    const kind = (validKinds as string[]).includes(kindRaw) ? (kindRaw as ConsolidatedFactKind) : 'user';
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) { res.status(400).json({ error: 'fact content required' }); return; }
    try {
      const { consolidateFact } = await import('../memory/reflection.js');
      const { getFact } = await import('../memory/facts.js');
      const outcome = await consolidateFact({
        kind,
        text: content.slice(0, 800),
        trustLevel: 1,
        authority: 'user',
        sourceApp: 'Clementine Mobile',
        sourceUri: 'clementine://mobile/memory/facts',
      }, { sessionId: 'mobile:memory' });
      const fact = outcome.factId ? getFact(outcome.factId) : null;
      res.json({
        fact,
        consolidation: { action: outcome.action, supersededFactId: outcome.supersededFactId ?? null },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Who Clem knows — entity list + full dossier, same canonical sources as
   * the desktop (listEntities extraction + getEntityMemoryDetail).
   */
  router.get('/api/memory/entities', requireMobileSession, async (req, res) => {
    try {
      const { listEntities } = await import('../memory/entity-list.js');
      res.json(listEntities({
        type: typeof req.query.type === 'string' ? req.query.type : undefined,
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        limit: clampInt(req.query.limit, 100, 1, 400),
      }));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/api/memory/entities/:id', requireMobileSession, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'entity id must be a positive integer' }); return; }
    try {
      const { getEntityMemoryDetail } = await import('../memory/entity-memory.js');
      res.json(getEntityMemoryDetail(id, {}));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(message === 'entity not found' ? 404 : 500).json({ error: message });
    }
  });

  /**
   * The memory constellation, phone-sized. Same tested builder the desktop
   * console uses (buildMemoryGraph), with mobile-tuned defaults: fewer nodes,
   * semantic PCA layout and similarity edges on by default so the graph
   * arrives ready to render, no client-side knobs required.
   */
  router.get('/api/memory/graph', requireMobileSession, async (req, res) => {
    try {
      const { buildMemoryGraph } = await import('../dashboard/memory-graph.js');
      const { openMemoryDb } = await import('../memory/db.js');
      const result = buildMemoryGraph(openMemoryDb(), {
        factsLimit: clampInt(req.query.facts, 120, 10, 200),
        filesLimit: clampInt(req.query.files, 30, 0, 80),
        entitiesLimit: clampInt(req.query.entities, 60, 0, 100),
        semanticLayout: true,
        simEdges: clampInt(req.query.simEdges, 3, 0, 6),
        simThreshold: 0.7,
        simCap: 200,
        clusterMode: 'kind',
        truthMode: 'stored',
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/api/memory/neighborhood', requireMobileSession, async (req, res) => {
    const nodeId = typeof req.query.nodeId === 'string' ? req.query.nodeId.trim() : '';
    if (!nodeId) { res.status(400).json({ error: 'nodeId required' }); return; }
    try {
      const { buildMemoryNeighborhood } = await import('../dashboard/memory-graph.js');
      const { openMemoryDb } = await import('../memory/db.js');
      res.json(buildMemoryNeighborhood(openMemoryDb(), nodeId, req.query.depth === '2' ? 2 : 1));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * The Activity tab's feed. Delegates to the same collector as the desktop
   * dashboard's /api/runs — the phone door only serves /m/*, so this is the
   * mobile-reachable spelling of that list, not a second implementation.
   */
  router.get('/api/runs', requireMobileSession, (req, res) => {
    if (!deps.listRecentRuns) {
      res.status(503).json({ error: 'UNAVAILABLE' });
      return;
    }
    const limit = clampInt(req.query.limit, 20, 1, 50);
    try {
      res.json({ runs: deps.listRecentRuns(limit) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Everything Clementine has committed to do later, in one list: one-shot
   * reminders (timers) and armed prospective intentions. Read-only — the
   * phone surfaces them; managing them stays a conversation.
   */
  router.get('/api/reminders', requireMobileSession, async (_req, res) => {
    try {
      const { readTimers } = await import('../runtime/timers.js');
      const { listProspectiveIntentions } = await import('../runtime/prospective-intentions.js');
      const now = Date.now();
      const timers = readTimers()
        .filter((timer) => timer.fireAt > now)
        .map((timer) => ({
          id: timer.id,
          kind: 'reminder' as const,
          text: timer.message,
          at: new Date(timer.fireAt).toISOString(),
          recurring: false,
        }));
      const intentions = listProspectiveIntentions({ statuses: ['active', 'due', 'blocked'], limit: 50 })
        .map((intention) => ({
          id: intention.id,
          kind: 'intention' as const,
          text: intention.objective,
          at: intention.dueAt ?? null,
          recurring: intention.recurring,
          status: intention.status,
        }));
      const items = [...timers, ...intentions].sort((a, b) => {
        if (!a.at) return 1;
        if (!b.at) return -1;
        return a.at.localeCompare(b.at);
      });
      res.json({ items });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Workflows (list + trigger + recent runs + events) ───────────

  router.get('/api/workflows', requireMobileSession, (_req, res) => {
    try {
      const entries = listWorkflows().sort((a, b) => a.data.name.localeCompare(b.data.name));
      const runsByWorkflow = readMobileWorkflowRuns();
      const items = entries.map((entry) => {
        const recent = runsByWorkflow.get(entry.data.name) ?? [];
        const last = recent[0];
        return {
          name: entry.data.name,
          description: entry.data.description ?? '',
          enabled: entry.data.enabled !== false,
          stepCount: entry.data.steps.length,
          schedule: entry.data.trigger?.schedule ?? null,
          requiresInput: Object.keys(entry.data.inputs ?? {}).length > 0,
          lastRunId: last?.id ?? null,
          lastRunStatus: last?.status ?? null,
          lastRunOutcome: last?.terminalOutcome ?? null,
          lastRunAt: last?.createdAt ?? last?.startedAt ?? null,
        };
      });
      res.json({ workflows: items });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * The FULL workflow, one name at a time: schedule, inputs schema, a plain-
   * English description of what it does, and the certified step list (label,
   * executor, effect, approval-gated) from the same dry-run trace the desktop
   * drawer renders. Certification is real synchronous work (~hundreds of ms),
   * which is why it lives here — on the single-workflow detail — and must
   * never be added to the list route (a certification-per-workflow list was a
   * measured 11s event-loop stall on the desktop before it was memoized).
   */
  router.get('/api/workflows/:name', requireMobileSession, async (req, res) => {
    const target = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    try {
      const { certifyWorkflow } = await import('../execution/workflow-certification.js');
      const { describeWorkflowPlainEnglish } = await import('../execution/workflow-describe.js');
      let certification: Awaited<ReturnType<typeof certifyWorkflow>> | null = null;
      try { certification = certifyWorkflow(entry.data); } catch { /* an uncertifiable workflow still has a definition to show */ }
      let summary = '';
      try { summary = describeWorkflowPlainEnglish(entry.data); } catch { /* best-effort prose */ }
      const inputsSchema = Object.entries(entry.data.inputs ?? {}).map(([key, spec]) => ({
        key,
        description: typeof (spec as { description?: unknown })?.description === 'string'
          ? (spec as { description: string }).description
          : '',
        required: (spec as { required?: unknown })?.required !== false,
        example: typeof (spec as { example?: unknown })?.example === 'string'
          ? (spec as { example: string }).example
          : null,
      }));
      const certSteps = (certification as { steps?: unknown } | null)?.steps;
      res.json({
        name: entry.data.name,
        description: entry.data.description ?? '',
        enabled: entry.data.enabled !== false,
        schedule: entry.data.trigger?.schedule ?? null,
        stepCount: entry.data.steps.length,
        inputs: inputsSchema,
        summary,
        steps: Array.isArray(certSteps)
          ? (certSteps as Array<Record<string, unknown>>).map((step) => ({
              stepId: typeof step.stepId === 'string' ? step.stepId : '',
              label: typeof step.label === 'string' ? step.label : '',
              executor: typeof step.executor === 'string' ? step.executor : null,
              effect: typeof step.effect === 'string' ? step.effect : null,
              gated: step.gated === true,
            }))
          : entry.data.steps.map((step) => {
              const raw = step as unknown as Record<string, unknown>;
              return {
                stepId: typeof raw.id === 'string' ? raw.id : '',
                label: typeof raw.label === 'string' ? raw.label : '',
                executor: null,
                effect: null,
                gated: false,
              };
            }),
        certification: certification
          ? {
              verdict: (certification as { verdict?: unknown }).verdict ?? null,
              missingInputs: (certification as { missingInputs?: unknown }).missingInputs ?? [],
            }
          : null,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/api/workflows/:name/run', requireMobileSession, (req, res) => {
    const target = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    if (entry.data.enabled === false) {
      res.status(409).json({ error: 'WORKFLOW_DISABLED' });
      return;
    }
    // Inputs ride the body as strings, validated against the schema — the
    // phone renders the same inputs the desktop form does. Missing required
    // inputs are a 409 naming exactly what's missing, not a dead end.
    const schema = entry.data.inputs ?? {};
    const provided = (req.body?.inputs && typeof req.body.inputs === 'object' && !Array.isArray(req.body.inputs))
      ? req.body.inputs as Record<string, unknown>
      : {};
    const inputs: Record<string, string> = {};
    for (const [key, value] of Object.entries(provided)) {
      if (!(key in schema)) continue;
      if (typeof value === 'string' && value.trim()) inputs[key] = value.trim().slice(0, 2000);
    }
    const missing = Object.entries(schema)
      .filter(([key, spec]) => (spec as { required?: unknown })?.required !== false && !inputs[key])
      .map(([key]) => key);
    if (missing.length > 0) {
      res.status(409).json({ error: 'WORKFLOW_REQUIRES_INPUT', missing });
      return;
    }
    try {
      const queued = queueWorkflowRun(entry.data.name, inputs, { source: 'mobile', dedupe: false });
      res.json({ ok: true, runId: queued.id, status: 'queued' });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/api/workflows/:name/runs', requireMobileSession, (req, res) => {
    const target = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    const limit = clampInt(req.query.limit, 20, 1, 100);
    const runs = (readMobileWorkflowRuns().get(entry.data.name) ?? []).slice(0, limit);
    res.json({ runs });
  });

  router.get('/api/workflows/:name/runs/:runId/events', requireMobileSession, (req, res) => {
    const target = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    try {
      const events = readWorkflowEvents(entry.name, runId);
      const limit = clampInt(req.query.limit, 200, 1, 500);
      // ?full=1 keeps each event's complete output — required by the shared
      // per-step timeline reducer, which reads `output`, not a preview. Only
      // the ONE run being viewed pays that weight; lists stay on previews.
      const full = req.query.full === '1' || req.query.full === 'true';
      const tail = events.slice(-limit).map((ev) => ({
        t: ev.t,
        kind: ev.kind,
        stepId: ev.stepId ?? null,
        itemKey: ev.itemKey ?? null,
        error: ev.error ?? null,
        meta: ev.meta ?? null,
        // output can be huge — only ship a short preview to mobile lists.
        outputPreview: ev.output !== undefined
          ? truncateOutput(ev.output)
          : null,
        ...(full && ev.output !== undefined ? { output: ev.output } : {}),
      }));
      // The run's own status rides along: without it the phone had to infer
      // "is this still going?" from the last event kind, which is wrong the
      // moment a run parks or is cancelled elsewhere.
      const summary = (readMobileWorkflowRuns().get(entry.data.name) ?? []).find((run) => run.id === runId);
      res.json({
        runId,
        workflow: entry.data.name,
        status: summary?.status ?? null,
        terminalOutcome: summary?.terminalOutcome ?? null,
        events: tail,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── workspaces ────────────────────────────────────────────────
  //
  // A workspace's authored view is loopback-only on purpose: it is
  // agent-written JavaScript and it never leaves this machine. So the phone
  // gets the DATA, re-projected (src/spaces/mobile-projection.ts) into
  // headline numbers and scannable records. That is a different view of the
  // same workspace, and the UI says so rather than pretending to be the
  // desktop.

  router.get('/api/workspaces', requireMobileSession, async (_req, res) => {
    try {
      const { spaceStore } = await import('../spaces/store.js');
      const { readData } = await import('../spaces/data-store.js');
      const { projectWorkspaceData, workspacePhonePresence } = await import('../spaces/mobile-projection.js');
      const spaces = spaceStore.list().map((record) => {
        const health = spaceStore.health(record.id);
        // Whether there is anything to LOOK at, decided here rather than
        // guessed in the UI. Half of a real user's workspaces are drafts and
        // abandoned experiments with no data at all; on a laptop they are easy
        // to scroll past, but on a phone they crowd out the two or three that
        // actually matter.
        let rows = 0;
        let hasSummary = false;
        try {
          const projection = projectWorkspaceData(readData(record.id));
          rows = projection.total;
          hasSummary = projection.headline.length > 0;
        } catch { /* unreadable data reads as empty, which is the truth */ }
        const presence = workspacePhonePresence({
          show: record.mobile?.show,
          rows,
          hasSummary,
          lastRefreshedAt: record.lastRefreshedAt ?? null,
        });
        return {
          id: record.id,
          title: record.title,
          status: record.status,
          objective: record.contract?.objective ?? null,
          updatedAt: record.updatedAt,
          lastRefreshedAt: record.lastRefreshedAt ?? null,
          freshness: health?.freshness.state ?? 'unknown',
          issues: (health?.issues ?? []).slice(0, 3),
          counts: health?.counts ?? null,
          rows,
          hasSummary,
          // Whether this belongs on the phone, and whether the answer came
          // from the owner or from the content.
          onPhone: presence.onPhone,
          presence: presence.reason,
          showPreference: record.mobile?.show ?? null,
        };
      });
      res.json({ workspaces: spaces });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/api/workspaces/:id', requireMobileSession, async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    try {
      const { spaceStore, isValidSpaceSlug } = await import('../spaces/store.js');
      if (!isValidSpaceSlug(id)) { res.status(400).json({ error: 'INVALID_ID' }); return; }
      const record = spaceStore.get(id);
      if (!record || record.status === 'archived') { res.status(404).json({ error: 'NOT_FOUND' }); return; }
      const { readData } = await import('../spaces/data-store.js');
      const { projectWorkspaceData, projectSourceHealth, shortenDiagnostic } = await import('../spaces/mobile-projection.js');
      const data = readData(id);
      const health = spaceStore.health(id);
      // Workflows that feed this workspace — content scan, same rule as the
      // desktop: the workflow's own text referencing the slug IS the link.
      const linkedWorkflows = listWorkflows().flatMap((entry) => {
        try {
          if (!readFileSync(entry.filePath, 'utf-8').toLowerCase().includes(id.toLowerCase())) return [];
          return [{
            name: entry.data.name,
            description: (entry.data.description ?? '').slice(0, 200),
            enabled: entry.data.enabled !== false,
          }];
        } catch { return []; }
      });
      res.json({
        id: record.id,
        title: record.title,
        status: record.status,
        objective: record.contract?.objective ?? null,
        // The full contract, not just the objective — what "good" means for
        // this workspace and what must never happen.
        successCriteria: record.contract?.successCriteria ?? [],
        invariants: record.contract?.invariants ?? [],
        updatedAt: record.updatedAt,
        lastRefreshedAt: record.lastRefreshedAt ?? null,
        freshness: health?.freshness.state ?? 'unknown',
        counts: health?.counts ?? null,
        // Health issues quote runner stderr verbatim; unbounded, one of them
        // pushed the whole workspace off a phone screen.
        issues: (health?.issues ?? []).slice(0, 3).map((issue) => shortenDiagnostic(issue, 160)),
        sources: projectSourceHealth(data),
        linkedWorkflows,
        projection: projectWorkspaceData(data),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Keep or banish a workspace from the phone. The owner's answer, stored on
   * the workspace itself, so it holds for every surface and survives a
   * refresh rebuilding the data underneath it.
   */
  router.post('/api/workspaces/:id/mobile', requireMobileSession, async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const raw = (req.body ?? {}) as { show?: unknown };
    // null/absent clears the preference and returns the workspace to the
    // automatic, content-decides rule.
    const show = typeof raw.show === 'boolean' ? raw.show : undefined;
    try {
      const { spaceStore, isValidSpaceSlug } = await import('../spaces/store.js');
      if (!isValidSpaceSlug(id)) { res.status(400).json({ error: 'INVALID_ID' }); return; }
      const updated = spaceStore.update(id, { mobile: show === undefined ? undefined : { show } });
      if (!updated) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
      res.json({ ok: true, showPreference: updated.mobile?.show ?? null });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Refresh a workspace's data — with the truth the desktop gets.
   *
   * The old route was fire-and-forget, which made a refresh blocked on a
   * pinned-entrypoint APPROVAL indistinguishable from a successful one: the
   * timestamp silently never moved (live defect). Now the route waits a
   * bounded window — approval blocks and fast failures land inside it and
   * come back as structured results with pendingApprovalIds, exactly the
   * triage the desktop does. A genuinely long runner outlives the window and
   * degrades to the old behavior: 202, keep polling. Accepts an optional
   * per-source refresh ({ sourceId }) like the desktop.
   */
  router.post('/api/workspaces/:id/refresh', requireMobileSession, async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    try {
      const { spaceStore, isValidSpaceSlug } = await import('../spaces/store.js');
      if (!isValidSpaceSlug(id)) { res.status(400).json({ error: 'INVALID_ID' }); return; }
      const record = spaceStore.get(id);
      if (!record || record.status === 'archived') { res.status(404).json({ error: 'NOT_FOUND' }); return; }
      const { refreshSpaceData } = await import('../spaces/runner.js');
      const sourceId = typeof req.body?.sourceId === 'string' && req.body.sourceId.trim()
        ? req.body.sourceId.trim()
        : undefined;
      const refreshing = Promise.resolve()
        .then(() => refreshSpaceData(id, sourceId))
        .catch((err) => {
          console.warn(`mobile workspace refresh failed for ${id}:`, err instanceof Error ? err.message : err);
          return null;
        });
      const WINDOW_MS = 20_000;
      const settled = await Promise.race([
        refreshing.then((results) => ({ results })),
        new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), WINDOW_MS)),
      ]);
      if ('timeout' in settled) {
        // Still running — the refresh continues; the phone polls the record.
        res.status(202).json({ ok: true, started: true, done: false });
        return;
      }
      const results = (settled.results ?? []) as Array<{ sourceId?: string; ok?: boolean; error?: string; pendingApprovalId?: string }>;
      const failures = results.filter((r) => r.ok === false);
      const pendingApprovalIds = [...new Set(
        failures.map((r) => r.pendingApprovalId).filter((v): v is string => typeof v === 'string' && v.length > 0),
      )];
      res.json({
        ok: failures.length === 0,
        done: true,
        results,
        pendingApprovalIds,
        failureMessage: failures.length === 0
          ? null
          : pendingApprovalIds.length > 0
            ? 'Approval needed before this can refresh — it’s waiting in your decisions.'
            : failures.map((r) => `${r.sourceId ?? 'source'}: ${r.error ?? 'refresh failed'}`).join('; ').slice(0, 300),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Stop a workflow run from the phone. Cancels at the next step boundary —
   * the same verb the desktop console uses, so a run stopped from the couch
   * lands in exactly the state a run stopped at the desk does.
   *
   * There is deliberately no "pause": nothing in the system can suspend
   * in-flight work and resume it later, and a button that implied otherwise
   * would be a lie about what happens to the work.
   */
  router.post('/api/workflows/:name/runs/:runId/cancel', requireMobileSession, async (req, res) => {
    const target = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    const runId = Array.isArray(req.params.runId) ? req.params.runId[0] : req.params.runId;
    const entry = listWorkflows().find((e) => e.data.name === target || e.name === target);
    if (!entry) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    try {
      const { cancelWorkflowRunAtBoundary } = await import('../execution/workflow-run-cancellation.js');
      const outcome = cancelWorkflowRunAtBoundary({
        runId,
        reason: 'Stopped from the phone',
        source: 'mobile',
        // Guards against a stale phone view stopping a different workflow's run.
        expectedWorkflow: entry.data.name,
      });
      if (outcome.status === 'not_found' || outcome.status === 'workflow_mismatch') {
        res.status(404).json({ error: 'RUN_NOT_FOUND' });
        return;
      }
      if (outcome.status === 'already_terminal') {
        res.status(409).json({ error: 'ALREADY_FINISHED', status: outcome.terminalStatus });
        return;
      }
      try {
        const { appendWorkflowEvent } = await import('../execution/workflow-events.js');
        appendWorkflowEvent(entry.name, runId, { kind: 'run_cancelled', error: 'Stopped from the phone' });
      } catch { /* the cancellation is the effect; the event is a courtesy */ }
      res.json({ ok: true, outcome: outcome.status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Stop a tracked run (a chat turn or background job surfaced on Activity).
   * Delegates to the same helper the desktop dashboard uses.
   */
  router.post('/api/runs/:id/cancel', requireMobileSession, (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!deps.cancelRun) {
      res.status(503).json({ error: 'UNAVAILABLE' });
      return;
    }
    try {
      const result = deps.cancelRun(id);
      res.status(result.httpStatus).json({
        ok: result.ok,
        message: result.message,
        runId: result.runId,
        taskStatus: result.taskStatus,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Background task control. `cancel` stops at the next safe checkpoint;
   * `resume` picks a stopped task back up — the only genuine resume the
   * system has, and the reason a phone is useful when work stalls while
   * you're away from the desk.
   */
  router.post('/api/tasks/:id/:action', requireMobileSession, async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const action = Array.isArray(req.params.action) ? req.params.action[0] : req.params.action;
    if (action !== 'cancel' && action !== 'resume') {
      res.status(400).json({ error: 'UNSUPPORTED_ACTION' });
      return;
    }
    try {
      const tasks = await import('../execution/background-tasks.js');
      if (action === 'cancel') {
        const task = tasks.cancelBackgroundTask(id, 'Stopped from the phone');
        if (!task) { res.status(404).json({ error: 'TASK_NOT_FOUND' }); return; }
        res.json({ ok: true, status: task.status });
        return;
      }
      const resumed = tasks.resumeBackgroundTask(id);
      if (!resumed) { res.status(409).json({ error: 'NOT_RESUMABLE' }); return; }
      res.json({ ok: true, status: resumed.status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/push/unsubscribe', requireMobileSession, async (req, res) => {
    const ctx = req.mobileSession!;
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    let removed = 0;
    if (endpoint) {
      removed = removeWebPushDestinationByEndpoint(endpoint) ? 1 : 0;
    } else {
      // Without a specific endpoint, drop every push subscription tied
      // to this device — used by the PWA's "disable notifications"
      // affordance when the browser revokes the permission.
      removed = removeWebPushDestinationsByDeviceId(ctx.record.deviceId);
    }
    await markPushSubscribed(ctx.token, false, stateOpts).catch(() => undefined);
    res.json({ ok: true, removed });
  });

  // ─── PWA static assets ──────────────────────────────────────────
  //
  // Order matters: this runs AFTER the auth + API routes above, so a
  // path like /m/auth/login never falls through to the static handler.
  // Only GET requests are served; everything else falls back to the
  // 404 the router emits by default.

  const pwaDir = resolvePwaDistDir(deps.pwaDistDir);
  if (pwaDir) {
    router.use(express.static(pwaDir, {
      index: false,
      fallthrough: true,
      // Service workers must update on every load; the SW itself
      // disables HTTP caching for the API anyway.
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('sw.js')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Service-Worker-Allowed', '/m/');
        } else if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }));

    // SPA fallback for client-side routes. Returns the cached
    // index.html for any unhandled GET under /m/* so deep links
    // (e.g. /m/inbox once we add router) work after Add-to-Home-Screen.
    router.get('*', (req, res, next) => {
      // Only GETs for HTML — JSON API calls fall through to 404.
      if (req.method !== 'GET') { next(); return; }
      const accepts = (req.headers.accept ?? '').toLowerCase();
      if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') || req.path.startsWith('/push/')) {
        next(); return;
      }
      if (!accepts.includes('text/html') && accepts !== '*/*' && accepts !== '') {
        next(); return;
      }
      const indexPath = path.join(pwaDir, 'index.html');
      if (!existsSync(indexPath)) { next(); return; }
      const html = readFileSync(indexPath, 'utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    });
  }

  return router;
}

/**
 * Helper exposed so non-router callers (e.g. future SSE streams that
 * Express middleware can't easily inspect) can validate a session.
 */
export async function authenticateMobileRequest(
  req: express.Request,
  opts?: { stateDir?: string },
): Promise<MobileSessionRecord | undefined> {
  const token = readSessionCookie(req);
  if (!token) return undefined;
  return validateSession(token, opts);
}
