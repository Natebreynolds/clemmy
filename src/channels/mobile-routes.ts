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
import { hasPin, readPinMeta, setPin, verifyPin } from '../runtime/mobile-pin.js';
import { consumeMobilePairingCode } from '../runtime/mobile-pairing.js';
import { beginCodexDeviceLogin, pollCodexDeviceLogin } from '../runtime/auth-store.js';
import {
  createSession,
  listSessions,
  revokeAllSessions,
  revokeSession,
  validateSession,
  type MobileSessionRecord,
} from '../runtime/mobile-sessions.js';
import {
  checkAttempt,
  recordFailure,
  recordSuccess,
} from '../runtime/mobile-rate-limit.js';
import {
  removeWebPushDestinationByEndpoint,
  removeWebPushDestinationsByDeviceId,
  upsertWebPushDestination,
} from '../runtime/notifications.js';
import { getVapidPublicKey } from '../runtime/web-push-keys.js';
import { markPushSubscribed } from '../runtime/mobile-sessions.js';
import {
  getSession as harnessGetSession,
  listEvents as harnessListEvents,
  listSessions as harnessListSessions,
  getLatestEventSeq as harnessLatestEventSeq,
  type EventRow as HarnessEventRow,
  type SessionRow as HarnessSessionRow,
} from '../runtime/harness/eventlog.js';
import { actionBus } from '../runtime/action-bus.js';
import { ClementineGateway } from '../gateway/router.js';
import type { ClementineAssistant } from '../assistant/core.js';
import { lookupIdempotent, rememberIdempotent } from '../runtime/idempotency.js';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { recallHybrid } from '../memory/recall.js';
import { listActiveFacts } from '../memory/facts.js';
type ConsolidatedFactKind = 'user' | 'project' | 'feedback' | 'reference';
import { listWorkflows } from '../memory/workflow-store.js';
import { readWorkflowEvents } from '../execution/workflow-events.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { getPlanProposal, listPlanProposals, planProposalNeedsUserInput, rejectPlanProposal, type PlanProposal } from '../agents/plan-proposals.js';
import { approvePlanAndQueueBackgroundTask } from '../execution/approved-plan-tasks.js';
import { processBackgroundTasks } from '../execution/background-tasks.js';

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
 * Strip an event down to what the PWA actually renders. Tool args are
 * truncated because mobile screens are narrow + payload size matters
 * for push-driven cold starts. Full args remain available on the
 * dashboard.
 */
function serializeEventForMobile(event: HarnessEventRow): {
  seq: number;
  id: string;
  turn: number;
  role: string;
  type: string;
  createdAt: number;
  data: Record<string, unknown>;
} {
  const data = event.data ?? {};
  let trimmed: Record<string, unknown> = {};
  switch (event.type) {
    case 'user_input_received':
      trimmed = { text: typeof data.text === 'string' ? data.text : String(data.message ?? '') };
      break;
    case 'conversation_completed':
      {
        const planProposalId = typeof data.planProposalId === 'string' ? data.planProposalId : null;
        const planProposal = planProposalId ? getPlanProposal(planProposalId) : null;
        const planProposalStatus = typeof data.planProposalStatus === 'string'
          ? data.planProposalStatus
          : (planProposal?.status ?? null);
        trimmed = {
          reply: typeof data.reply === 'string' ? data.reply : (typeof data.summary === 'string' ? data.summary : ''),
          reason: data.reason,
          planProposalId,
          planProposalStatus,
          planProposalNeedsUserInput: planProposal ? planProposalNeedsUserInput(planProposal) : false,
        };
      }
      break;
    case 'conversation_limit_exceeded':
      trimmed = {
        reason: typeof data.reason === 'string' ? data.reason : 'limit_exceeded',
        steps: typeof data.steps === 'number' ? data.steps : null,
        maxSteps: typeof data.maxSteps === 'number' ? data.maxSteps : null,
        maxWallClockMs: typeof data.maxWallClockMs === 'number' ? data.maxWallClockMs : null,
        maxTurns: typeof data.maxTurns === 'number' ? data.maxTurns : null,
        transport: typeof data.transport === 'string' ? data.transport : null,
      };
      break;
    case 'tool_called':
      trimmed = {
        tool: typeof data.tool === 'string' ? data.tool : String(data.name ?? 'unknown'),
        argsPreview: shortArgsPreview(data.arguments ?? data.args),
      };
      break;
    case 'tool_returned':
      trimmed = {
        tool: typeof data.tool === 'string' ? data.tool : String(data.name ?? 'unknown'),
        ok: data.ok ?? data.success ?? true,
      };
      break;
    case 'approval_requested':
      trimmed = {
        subject: typeof data.subject === 'string' ? data.subject : '',
        tool: typeof data.tool === 'string' ? data.tool : '',
        approvalId: typeof data.approvalId === 'string' ? data.approvalId : null,
      };
      break;
    case 'approval_resolved':
      trimmed = {
        decision: data.decision ?? data.resolution ?? 'resolved',
      };
      break;
    case 'run_failed':
      trimmed = { error: typeof data.error === 'string' ? data.error.slice(0, 240) : 'failed' };
      break;
    default:
      // Pass through nothing for events the phone doesn't render —
      // keeps the event in the timeline (so seq cursors stay correct)
      // but doesn't ship arbitrary payloads to the phone.
      trimmed = {};
  }
  return {
    seq: event.seq,
    id: event.id,
    turn: event.turn,
    role: event.role,
    type: event.type,
    createdAt: typeof event.createdAt === 'number' ? event.createdAt : Date.parse(String(event.createdAt)),
    data: trimmed,
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

interface MobileWorkflowRunSummary {
  id: string;
  workflow: string;
  status: string;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  source: string | null;
  error: string | null;
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
        createdAt: stringOrNull(raw.createdAt),
        startedAt: stringOrNull(raw.startedAt),
        finishedAt: stringOrNull(raw.finishedAt) ?? stringOrNull(raw.completedAt),
        source: stringOrNull(raw.source),
        error: stringOrNull(raw.error),
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
  // Cloudflare adds CF-Connecting-IP. Behind the tunnel, req.ip is
  // the tunnel daemon (loopback). We trust the CF header here because
  // the only path to /m/* is via the tunnel; direct loopback access
  // is for the dev box and shares the rate limit anyway.
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.length > 0) return cfIp;
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]?.trim() || req.ip || 'unknown';
  }
  return req.ip || 'unknown';
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
  async function requireMobileSession(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): Promise<void> {
    const token = readSessionCookie(req);
    if (!token) {
      res.status(401).json({ error: 'NO_SESSION' });
      return;
    }
    const record = await validateSession(token, stateOpts);
    if (!record) {
      res.clearCookie(MOBILE_SESSION_COOKIE, { path: '/', secure: mobileCookieSecure(req), sameSite: 'lax' });
      res.status(401).json({ error: 'INVALID_SESSION' });
      return;
    }
    req.mobileSession = { token, record };
    next();
  }
  (router as express.Router & { requireMobileSession: typeof requireMobileSession })
    .requireMobileSession = requireMobileSession;

  router.get('/auth/status', async (req, res) => {
    const token = readSessionCookie(req);
    const record = token ? await validateSession(token, stateOpts) : undefined;
    res.json({
      pinConfigured: hasPin(stateOpts),
      pinUpdatedAt: readPinMeta(stateOpts)?.updatedAt ?? null,
      authenticated: Boolean(record),
      deviceId: record?.deviceId ?? null,
      deviceLabel: record?.deviceLabel ?? null,
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

      // Distributed-bruteforce alarm: one-shot push when this failure
      // is what tipped the global counter into lockdown. Best-effort;
      // notification failures must not block the auth response.
      if (decision.globalTrippedNow) {
        try {
          const { addNotification } = await import('../runtime/notifications.js');
          addNotification({
            id: `mobile-pin-global-lockout-${Date.now().toString(36)}`,
            kind: 'system',
            title: 'Mobile sign-ins locked down',
            body: 'Too many failed mobile PIN attempts from different sources in a short window. All mobile sign-ins are blocked for the next hour. If this wasn’t you, rotate your PIN in the desktop Mobile Access panel.',
            createdAt: new Date().toISOString(),
            read: false,
            metadata: {
              globalFailures: decision.globalFailures,
              retryAfterMs: decision.retryAfterMs,
            },
          });
        } catch {
          /* swallow — auth path must stay responsive */
        }
      }

      res.status(status).json(body);
      return;
    }

    await recordSuccess(ip, stateOpts);
    const { token, record } = await createSession({ deviceLabel }, stateOpts);
    res.cookie(MOBILE_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: mobileCookieSecure(req),
      path: '/',
      maxAge: COOKIE_MAX_AGE_MS,
    });
    res.json({
      deviceId: record.deviceId,
      deviceLabel: record.deviceLabel,
      expiresAt: record.expiresAt,
    });
  });

  router.post('/auth/pair', async (req, res) => {
    const pairToken = typeof req.body?.pairToken === 'string'
      ? req.body.pairToken.trim()
      : (typeof req.body?.token === 'string' ? req.body.token.trim() : '');
    const deviceLabel = typeof req.body?.deviceLabel === 'string' ? req.body.deviceLabel : undefined;
    if (!pairToken) {
      res.status(400).json({ error: 'PAIR_TOKEN_REQUIRED' });
      return;
    }

    const pairing = await consumeMobilePairingCode(pairToken, stateOpts);
    if (!pairing) {
      res.status(401).json({ error: 'INVALID_PAIRING_CODE' });
      return;
    }

    const { token, record } = await createSession({ deviceLabel }, stateOpts);
    res.cookie(MOBILE_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: mobileCookieSecure(req),
      path: '/',
      maxAge: COOKIE_MAX_AGE_MS,
    });
    res.json({
      deviceId: record.deviceId,
      deviceLabel: record.deviceLabel,
      expiresAt: record.expiresAt,
    });
  });

  router.post('/auth/logout', async (req, res) => {
    const token = readSessionCookie(req);
    if (token) await revokeSession(token, stateOpts);
    res.clearCookie(MOBILE_SESSION_COOKIE, { path: '/', secure: mobileCookieSecure(req), sameSite: 'lax' });
    res.json({ ok: true });
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

  /** Smoke endpoint — confirms the cookie middleware works end-to-end. */
  router.get('/api/whoami', requireMobileSession, (req, res) => {
    const ctx = req.mobileSession!;
    res.json({
      deviceId: ctx.record.deviceId,
      deviceLabel: ctx.record.deviceLabel,
      expiresAt: ctx.record.expiresAt,
      lastSeenAt: ctx.record.lastSeenAt,
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
    const events = harnessListEvents(session.id, { limit: 500 });
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
      const replay = harnessListEvents(session.id, { sinceSeq, limit: 500 });
      const shaped = replay.map(serializeEventForMobile);
      // Last event's seq becomes the resume cursor on the next
      // reconnect — even when no live events fire in between.
      const lastSeq = shaped.length > 0 ? shaped[shaped.length - 1].seq : sinceSeq;
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
      writeEvent('replay', { sessionId: session.id, events: [], error: (err as Error).message });
    }

    const unsubscribe = actionBus.subscribe((event) => {
      if (event.kind !== 'harness.event') return;
      if (event.sessionId !== session.id) return;
      const shaped = serializeEventForMobile(event.event as HarnessEventRow);
      writeEvent('event', shaped, shaped.seq);
    });
    const heartbeat = setInterval(() => {
      if (closed || res.destroyed) return;
      res.write(`: ping\n\n`);
    }, 15_000);
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
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
   *   - If sessionId omitted, generate `sess-mob-<short>` and treat it
   *     as a brand-new harness chat.
   *   - Cache the response by (deviceId, key) for 15 min so a network
   *     retry replays the same JSON without re-running tools.
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

    // Idempotency check — replay the cached response if the same
    // (deviceId, key) tuple already produced one. The scope is the
    // deviceId so two clients can use the same key without colliding.
    const scope = `chat:${ctx.record.deviceId}`;
    const cached = lookupIdempotent<ChatSendResponse>(scope, idempotencyKey);
    if (cached.cached) {
      res.setHeader('Idempotent-Replay', '1');
      res.json(cached.value);
      return;
    }

    const sessionId = typeof req.body?.sessionId === 'string' && req.body.sessionId.trim()
      ? req.body.sessionId.trim()
      : `sess-mob-${randomBytes(6).toString('base64url')}`;

    try {
      const gatewayResponse = await new ClementineGateway(deps.assistant).handleMessage({
        message,
        sessionId,
        userId: ctx.record.deviceId,
        channel: 'mobile',
        source: 'mobile',
      });
      const payload: ChatSendResponse = {
        sessionId: gatewayResponse.sessionId,
        runId: gatewayResponse.runId,
        reply: gatewayResponse.text,
        pendingApprovalId: gatewayResponse.pendingApprovalId,
        queuedTaskId: gatewayResponse.queuedTaskId,
        stoppedReason: gatewayResponse.stoppedReason,
        turnsUsed: gatewayResponse.turnsUsed,
      };
      rememberIdempotent(scope, idempotencyKey, payload);
      res.json(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Don't cache failures — a retry might genuinely succeed.
      res.status(500).json({ error: 'CHAT_SEND_FAILED', message });
    }
  });

  // ─── Memory (read-only) ─────────────────────────────────────────

  router.get('/api/memory/search', requireMobileSession, async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) { res.json({ query: '', hits: [] }); return; }
    const limit = clampInt(req.query.limit, 20, 1, 50);
    try {
      const hits = await recallHybrid(q, { limit });
      res.json({
        query: q,
        hits: hits.map((hit) => ({
          path: hit.filePath,
          title: hit.title,
          snippet: typeof hit.snippet === 'string' ? hit.snippet.slice(0, 280) : '',
          score: Number(hit.score.toFixed(3)),
        })),
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
          lastRunAt: last?.createdAt ?? last?.startedAt ?? null,
        };
      });
      res.json({ workflows: items });
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
    if (Object.keys(entry.data.inputs ?? {}).length > 0) {
      // Mobile v1 doesn't render an inputs form — block triggering and
      // tell the client to use the desktop dashboard for now.
      res.status(409).json({ error: 'WORKFLOW_REQUIRES_INPUT' });
      return;
    }
    try {
      mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
      const id = `${Date.now()}-${randomBytes(3).toString('hex')}`;
      const payload = {
        id,
        workflow: entry.data.name,
        inputs: {},
        status: 'queued',
        createdAt: new Date().toISOString(),
        source: 'mobile',
      };
      writeFileSync(
        path.join(WORKFLOW_RUNS_DIR, `${id}.json`),
        JSON.stringify(payload, null, 2),
        'utf-8',
      );
      res.json({ ok: true, runId: id, status: 'queued' });
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
      const tail = events.slice(-limit).map((ev) => ({
        t: ev.t,
        kind: ev.kind,
        stepId: ev.stepId ?? null,
        error: ev.error ?? null,
        // output can be huge — only ship a short preview to mobile.
        outputPreview: ev.output !== undefined
          ? truncateOutput(ev.output)
          : null,
      }));
      res.json({ runId, workflow: entry.data.name, events: tail });
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
