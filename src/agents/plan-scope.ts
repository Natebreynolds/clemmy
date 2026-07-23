import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { BASE_DIR, getRuntimeEnv } from '../config.js';
import { redactSensitiveText } from '../runtime/security.js';
import { classifyExternalWrite } from '../runtime/harness/confirm-first-gate.js';

/** Only IRREVERSIBLE sends (email/call/post) get the strict enumeration floor.
 *  The taxonomy's 'send' kind is broader — it tags reversible network writes
 *  (a sheet/record create) too, and those keep the lenient scope/YOLO behavior.
 *  Authoritative irreversibility comes from classifyExternalWrite. */
function isIrreversibleSendAction(toolName: string, args: unknown, kindHint?: 'send' | 'other'): boolean {
  try {
    // The authoritative classifier is the source of truth. A kindHint of 'other'
    // must NOT short-circuit it to false: native comm-object sends (create_event,
    // respond_to_event) derive kindHint='other' from the taxonomy's verb list yet
    // ARE irreversible sends, and the old short-circuit disarmed the send-lock +
    // YOLO/wildcard-scope carve-out for them (2026-07-09 re-hunt: Lanes 2/3).
    if (classifyExternalWrite(toolName, args).irreversible) return true;
  } catch {
    // Fail-safe: if we can't classify but the caller called it a send, treat as
    // irreversible (ask) rather than auto-approve.
    return kindHint === 'send';
  }
  return false;
}

/**
 * Plan-scoped approval — the consent boundary that turns the
 * "approve, approve, approve" per-tool flow into a single
 * "approve the plan" decision.
 *
 * When the user approves a PlanProposal, we open a PlanScope for
 * that session. While the scope is open and unexpired, tools that
 * normally require per-call approval (run_shell_command, write_file)
 * check the scope first. If the scope covers the tool, the call is
 * auto-approved and logged for audit instead of interrupting.
 *
 * Why scoped per-session, not per-user-globally:
 *   - Approval is a *consent in context* primitive. Approving a
 *     deploy plan in Discord session A should not silently authorize
 *     a different deploy in autonomy cycle B.
 *   - The session is the unit of "the user is in the room watching."
 *   - Autonomy cycles get their own scope only when the user
 *     explicitly approves a plan for that agent.
 *
 * Hard time limit (default 15 minutes): scopes expire even if the
 * agent is still running. The user must approve again to extend. This
 * is the safety floor — no plan, however broad, can outrun the
 * user's awareness window.
 *
 * The plan as drafted lists the concrete actions. We optionally
 * constrain auto-approval to tool names that match what the plan
 * actually said it would do (allowedTools). `*` is reserved for
 * already-approved workflows/crons: it covers any non-read tool that
 * survives the shared taxonomy safety checks (admin/destructive tools
 * are still gated before this module is consulted).
 */

const logger = pino({ name: 'clementine-next.plan-scope' });

const SCOPES_FILE = path.join(BASE_DIR, 'state', 'plan-scopes.json');

const DEFAULT_SCOPE_TTL_MS = 15 * 60 * 1000;
const ABSOLUTE_MAX_TTL_MS = 60 * 60 * 1000; // 1 hour hard ceiling

export interface AutoApprovalEntry {
  at: string;
  toolName: string;
  /** Short summary of the call args — enough to audit, not the full payload. */
  summary: string;
}

export interface PlanScope {
  sessionId: string;
  planProposalId: string;
  approvedPlanObjective: string;
  /** Tool names that the plan-approval covers. `*` means all non-admin/non-destructive tools. */
  allowedTools: string[];
  /**
   * Optional argument-level narrowing for the generic Composio broker.
   * When present, `composio_execute_tool` is covered only for these
   * exact Composio slugs.
   */
  allowedComposioSlugs?: string[];
  /**
   * Goal-scoped autonomy (B1): when set, this scope's lifetime is DERIVED from
   * the goal record — it stays open while the goal is `active` and is closed by
   * the goal's terminal transition (satisfy/expire/supersede call
   * closePlanScope), NOT by a TTL. No timer, no new mechanism.
   */
  goalScoped?: { goalId: string };
  /**
   * Under a goal-scoped scope, send-kind tools (irreversible network mutations)
   * auto-approve ONLY when named here — a tool name, or a composio slug for the
   * broker. Populated solely from sends the blessed plan explicitly enumerated.
   * Anything not listed falls through to the approval registry (the side-effect
   * law: a send the user didn't pre-bless always waits).
   */
  allowedSends?: string[];
  openedAt: string;
  expiresAt: string;
  /** Audit trail of auto-approved calls inside this scope. */
  autoApprovals: AutoApprovalEntry[];
  /** Set when the user or system manually closed the scope. */
  closedAt?: string;
  closedReason?: string;
  version: 'v1';
}

/**
 * A standing grant (B2): a durable, user-level "always auto-approve this tool"
 * permission, independent of any session or plan. Sends, admin, and destructive
 * tools can NEVER be granted (refused at write); a per-call destructive hint
 * still gates upstream in decideToolApproval even for a granted tool.
 */
export interface StandingGrant {
  toolName: string;
  grantedAt: string;
  note?: string;
  revokedAt?: string;
}

/**
 * A scoped send-trust grant (2026-07-21): the ONE bounded way an irreversible
 * send auto-proceeds without a card. Unlike a StandingGrant (which is refused
 * for sends), a send-trust grant carries a NARROW recipient scope — the user's
 * own team domain, a named client, specific addresses — and a send auto-approves
 * only when EVERY recipient falls inside it AND the count is under the floor.
 * Zero grants → the held-send default is untouched. Revocable; audited.
 */
export interface SendTrustGrant {
  id: string;
  grantedAt: string;
  note?: string;
  revokedAt?: string;
  /** Recipient email domains (bare, lowercased) — e.g. "breakthroughcoaching.ai". */
  domains?: string[];
  /** Exact recipient addresses / chat handles (lowercased). */
  recipients?: string[];
  /** Optional tool/toolkit prefix this grant is limited to (e.g. "googlecalendar", "outlook"). */
  toolkits?: string[];
  /** Per-send recipient ceiling for THIS grant (still capped by the global floor). */
  maxRecipients?: number;
}

interface ScopesFile {
  scopes: Record<string, PlanScope>; // keyed by sessionId
  /** Standing grants, keyed by toolName (B2). */
  grants?: Record<string, StandingGrant>;
  /** Scoped send-trust grants (2026-07-21). */
  sendTrust?: SendTrustGrant[];
  version: 'v1';
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readAll(): ScopesFile {
  if (!existsSync(SCOPES_FILE)) return { scopes: {}, version: 'v1' };
  try {
    const parsed = JSON.parse(readFileSync(SCOPES_FILE, 'utf-8')) as ScopesFile;
    if (!parsed || typeof parsed !== 'object' || !parsed.scopes) return { scopes: {}, version: 'v1' };
    return parsed;
  } catch {
    return { scopes: {}, version: 'v1' };
  }
}

function writeAll(file: ScopesFile): void {
  ensureDir(path.dirname(SCOPES_FILE));
  const tmp = `${SCOPES_FILE}.${process.pid}.${randomUUID().slice(0, 6)}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
  renameSync(tmp, SCOPES_FILE);
}

export interface OpenPlanScopeInput {
  sessionId: string;
  planProposalId: string;
  approvedPlanObjective: string;
  ttlMs?: number;
  allowedTools?: string[];
  allowedComposioSlugs?: string[];
  /** Open a goal-lifetime scope (no TTL) keyed to this goal id. */
  goalScoped?: { goalId: string };
  /** Sends the plan enumerated + the user blessed (goal-scoped only). */
  allowedSends?: string[];
}

export const DEFAULT_SCOPE_ALLOWED_TOOLS = ['run_shell_command', 'write_file'];

export function openPlanScope(input: OpenPlanScopeInput): PlanScope {
  if (!input.sessionId) throw new Error('sessionId required to open a plan scope');
  const now = Date.now();
  // A goal-scoped scope has no TTL — its lifetime is the goal's. We still stamp
  // a far-future expiresAt for back-compat with consumers that read the field,
  // but getPlanScope never expires a goal-scoped scope on time.
  const ttl = input.goalScoped
    ? 365 * 24 * 60 * 60 * 1000
    : Math.min(ABSOLUTE_MAX_TTL_MS, Math.max(60_000, input.ttlMs ?? DEFAULT_SCOPE_TTL_MS));
  const scope: PlanScope = {
    sessionId: input.sessionId,
    planProposalId: input.planProposalId,
    approvedPlanObjective: input.approvedPlanObjective,
    allowedTools: input.allowedTools && input.allowedTools.length > 0 ? input.allowedTools : DEFAULT_SCOPE_ALLOWED_TOOLS,
    allowedComposioSlugs: input.allowedComposioSlugs && input.allowedComposioSlugs.length > 0
      ? input.allowedComposioSlugs
      : undefined,
    goalScoped: input.goalScoped,
    allowedSends: input.allowedSends && input.allowedSends.length > 0 ? input.allowedSends : undefined,
    openedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
    autoApprovals: [],
    version: 'v1',
  };

  const file = readAll();
  file.scopes[input.sessionId] = scope;
  writeAll(file);

  logger.info({
    sessionId: scope.sessionId,
    planProposalId: scope.planProposalId,
    expiresAt: scope.expiresAt,
    allowedTools: scope.allowedTools,
    allowedComposioSlugs: scope.allowedComposioSlugs,
  }, 'plan scope opened');

  return scope;
}

export function getPlanScope(sessionId: string): PlanScope | null {
  if (!sessionId) return null;
  const file = readAll();
  const scope = file.scopes[sessionId];
  if (!scope) return null;
  if (scope.closedAt) return scope; // return closed scope for inspection but isAutoApproved will refuse
  // A goal-scoped scope has NO time limit — it is closed only by the goal's
  // terminal transition (which calls closePlanScope). Never time-expire it.
  if (scope.goalScoped) return scope;
  // Expire lazily if we're past the window.
  if (Date.parse(scope.expiresAt) <= Date.now()) {
    return { ...scope, closedAt: new Date().toISOString(), closedReason: 'expired' };
  }
  return scope;
}

export function closePlanScope(sessionId: string, reason: string = 'closed'): PlanScope | null {
  const file = readAll();
  const scope = file.scopes[sessionId];
  if (!scope) return null;
  if (scope.closedAt) return scope;
  scope.closedAt = new Date().toISOString();
  scope.closedReason = reason;
  file.scopes[sessionId] = scope;
  writeAll(file);
  logger.info({ sessionId, reason }, 'plan scope closed');
  return scope;
}

/**
 * Pure check — does the session have an active, unexpired plan scope
 * that covers `toolName`? Does not mutate.
 */
export function isAutoApprovedByScope(
  sessionId: string | undefined,
  toolName: string,
  args?: unknown,
  kindHint?: 'send' | 'other',
): boolean {
  // Standing grants (B2): durable, user-level, session-independent. A send is
  // never grantable (refused at write), so a grant only ever covers a safe
  // write/execute tool — but guard kindHint defensively anyway.
  if (kindHint !== 'send' && isStandingGranted(toolName)) return true;
  if (!sessionId) return false;
  const scope = getPlanScope(sessionId);
  if (!scope) return false;
  if (scope.closedAt) return false;
  // Goal-scoped autonomy, the send chokepoint: an irreversible SEND under a
  // goal-lifetime scope auto-approves ONLY if the plan enumerated it and the
  // user blessed it (allowedSends). Everything else about a send — an
  // un-enumerated DM, a publish the plan never mentioned — falls through to the
  // approval registry. This holds even if allowedTools/`*` would otherwise
  // cover it: the side-effect law is stricter than the tool allowlist. (The 5
  // safety gates already ran before this module; this is the extra send lock a
  // no-TTL scope needs that the 15-min time-boxed scope didn't.)
  // THE SEND LOCK (2026-07-09 bypass hunt, edit 3): a WILDCARD `['*']` scope
  // never auto-approves an irreversible send. The workflow/background lanes open
  // `allowedTools:['*']` at launch, and the old goalScoped-only lock let the
  // `includes('*')` fast-path below wave an un-enumerated send through with no
  // human (Hole 2). A send is auto-approved only when EXPLICITLY enumerated —
  // in `allowedSends`, or named (not via wildcard) in `allowedTools`. Otherwise
  // it returns false → needsApproval → the run PARKS for a card.
  // THE SEND LOCK — only IRREVERSIBLE sends (email/call/post), not reversible
  // network writes (a sheet/record create still auto-approves under a scope).
  if (isIrreversibleSendAction(toolName, args, kindHint)) {
    const slug = extractComposioSlug(args);
    const sends = scope.allowedSends ?? [];
    // The SLUG is the real action for a composio send — auto-approve only when
    // the exact slug is enumerated (allowedSends or allowedComposioSlugs).
    if (slug && (sends.includes(slug) || (scope.allowedComposioSlugs ?? []).includes(slug))) return true;
    // A NON-multiplexer send tool named explicitly in allowedTools/allowedSends
    // is consent. A multiplexer name (composio_execute_tool, call_tool, shell)
    // is NOT — naming the gateway would blanket-approve every slug through it
    // (2026-07-09 Hole A: approve Gmail, model then sends Slack). Nor does a
    // wildcard '*'.
    if (!isUngrantableMultiplexer(toolName) && (sends.includes(toolName) || scope.allowedTools.includes(toolName))) return true;
    return false; // wildcard / multiplexer / un-enumerated → human approval required
  }
  if (scope.allowedTools.includes('*')) return true;
  if (scope.allowedTools.includes(toolName)) {
    if (
      toolName === 'composio_execute_tool'
      && scope.allowedComposioSlugs
      && scope.allowedComposioSlugs.length > 0
    ) {
      const slug = extractComposioSlug(args);
      return !!slug && scope.allowedComposioSlugs.includes(slug);
    }
    return true;
  }
  const prefixMatch = scope.allowedTools.some((allowed) => (
    allowed.endsWith('*') && toolName.startsWith(allowed.slice(0, -1))
  ));
  if (!prefixMatch) return false;
  return true;
}

function extractComposioSlug(args: unknown): string | undefined {
  if (!args) return undefined;
  if (typeof args === 'string') {
    try {
      return extractComposioSlug(JSON.parse(args) as unknown);
    } catch {
      return undefined;
    }
  }
  if (typeof args !== 'object') return undefined;
  const slug = (args as Record<string, unknown>).tool_slug;
  return typeof slug === 'string' && slug.length > 0 ? slug : undefined;
}

/**
 * Evaluate the user's global auto-approve policy. Layered on top of
 * `isAutoApprovedByScope`:
 *
 *   strict    → defer to plan-scope only
 *   workspace → also auto-approve when the tool's cwd / path resolves
 *               inside a configured workspace dir
 *   yolo      → auto-approve everything (the danger denylist on the
 *               tool itself still applies — it's the safety floor)
 *
 * Returns the reason for auto-approval so the audit trail captures
 * why a call ran without human approval.
 */
export interface AutoApproveDecision {
  autoApproved: boolean;
  reason: 'plan-scope' | 'workspace-policy' | 'yolo-policy' | 'send-trust' | 'denied';
}

export function evaluateAutoApprove(input: {
  sessionId: string | undefined;
  toolName: string;
  args?: unknown;
  scope: 'strict' | 'workspace' | 'yolo';
  insideWorkspace: boolean;
  /** 'send' applies the goal-scoped send lock; anything else is 'other'. */
  kindHint?: 'send' | 'other';
}): AutoApproveDecision {
  if (isAutoApprovedByScope(input.sessionId, input.toolName, input.args, input.kindHint)) {
    return { autoApproved: true, reason: 'plan-scope' };
  }
  // Scoped send-trust: the ONE bounded way an irreversible send skips the card.
  // The user granted a narrow recipient scope and EVERY recipient of THIS send
  // falls inside it (and under the mass-send floor). Applies regardless of
  // posture, like a standing grant — it IS the user's explicit consent, scoped;
  // revocable; the returned reason lands in the audit trail. Fail-closed inside
  // matchesSendTrust, so an unparseable or mass send falls through to the card.
  if (isIrreversibleSendAction(input.toolName, input.args, input.kindHint)
    && matchesSendTrust(input.toolName, input.args)) {
    return { autoApproved: true, reason: 'send-trust' };
  }
  // YOLO / workspace blanket policies NEVER auto-approve an IRREVERSIBLE send
  // (Hole C, 2026-07-09): the batch path already carved this out (brackets
  // confirm-first), but this per-tool path — used by canUseTool for single
  // sends — did not, so a native-MCP send under YOLO fired with no card. Only
  // irreversible sends (email/call/post) are held; reversible writes (a sheet
  // create) keep full YOLO/workspace convenience. YOLO means "don't nag me
  // about reversible work", not "email anyone silently".
  if (!isIrreversibleSendAction(input.toolName, input.args, input.kindHint)) {
    if (input.scope === 'yolo') {
      return { autoApproved: true, reason: 'yolo-policy' };
    }
    if (input.scope === 'workspace' && input.insideWorkspace) {
      return { autoApproved: true, reason: 'workspace-policy' };
    }
  }
  // 'strict' (Approve) defers entirely to plan-scope on the EXECUTION gate: a
  // mutating shell/file write still needs an active plan scope. (Legacy
  // 'balanced' coerced to 'strict' on read — same behavior.) Keeps execution
  // conservative.
  return { autoApproved: false, reason: 'denied' };
}

/**
 * Record that a tool call was auto-approved by an active scope. Call
 * this from the same code path that returns true from
 * `isAutoApprovedByScope` so the audit trail stays in sync with what
 * actually ran.
 */
export function recordAutoApproval(sessionId: string, toolName: string, summary: string): void {
  const file = readAll();
  const scope = file.scopes[sessionId];
  if (!scope) return;
  scope.autoApprovals = scope.autoApprovals ?? [];
  scope.autoApprovals.push({
    at: new Date().toISOString(),
    toolName,
    summary: summary.slice(0, 400),
  });
  file.scopes[sessionId] = scope;
  writeAll(file);
}

/** Summarize args for the audit log without dumping secrets/long blobs. */
export function summarizeToolArgs(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '(no args)';
  const obj = input as Record<string, unknown>;
  switch (toolName) {
    case 'run_shell_command': {
      const cmd = typeof obj.command === 'string' ? obj.command : '';
      const cwd = typeof obj.cwd === 'string' ? obj.cwd : '';
      const summary = cwd ? `[cwd=${cwd}] ${cmd.slice(0, 240)}` : cmd.slice(0, 240);
      return redactSensitiveText(summary);
    }
    case 'write_file': {
      const p = typeof obj.path === 'string' ? obj.path : '';
      const mode = typeof obj.mode === 'string' ? `${obj.mode} ` : '';
      const len = typeof obj.content === 'string' ? obj.content.length : 0;
      return redactSensitiveText(`${mode}${p} (${len} chars)`);
    }
    default:
      return redactSensitiveText(Object.entries(obj).slice(0, 4).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(' · '));
  }
}

// ─── Standing grants (B2) ────────────────────────────────────────────────────

function standingGrantsEnabled(): boolean {
  // getRuntimeEnv (not raw process.env) so live BASE_DIR/.env overrides and the
  // desktop dev-flags panel reach this switch like every sibling flag.
  return (getRuntimeEnv('CLEMMY_STANDING_GRANTS', 'on') || 'on').toLowerCase() !== 'off';
}

/**
 * Arbitrary-capability MULTIPLEXER tools: a single tool name that can reach
 * any external capability (run any shell command, any composio slug, any CLI,
 * any code). Granting one of these is granting standing auto-approval to
 * EVERYTHING it can reach — including sends/destructive ops the grant refusal
 * is meant to block. They classify as `execute` (not send/admin) so the kind
 * refusal alone lets them through; refuse them by name/shape too. (Verified:
 * `classifyTool('run_shell_command')` and `'composio_execute_tool'` both return
 * `execute`, so a standing grant for either was being accepted.)
 */
const UNGRANTABLE_MULTIPLEXERS = new Set<string>([
  'run_shell_command',
  'composio_execute_tool',
  'local_cli_run',
  'local_cli_exec',
]);
export function isUngrantableMultiplexer(name: string): boolean {
  if (UNGRANTABLE_MULTIPLEXERS.has(name)) return true;
  // Arbitrary code/command execution hosted via MCP (kernel exec_command,
  // playwright run_code_unsafe / execute_playwright_code, ide executeCode).
  return /(^|_)(exec_command|run_code_unsafe|execute_playwright_code|executecode|eval)(_|$)/i.test(
    name.toLowerCase(),
  );
}

/**
 * Grant a durable auto-approval for a tool. Refuses send/admin kinds (the
 * caller classifies and passes `kind`) AND arbitrary-capability multiplexers —
 * those must always be a deliberate, in-the-moment decision (side-effect law).
 * Returns the grant, or null if refused. Re-granting clears any prior revocation.
 */
export function grantStandingApproval(
  toolName: string,
  opts: { kind?: 'read' | 'write' | 'execute' | 'send' | 'admin'; note?: string } = {},
): StandingGrant | null {
  const name = toolName.trim();
  if (!name) return null;
  if (opts.kind === 'send' || opts.kind === 'admin') return null; // never grantable
  if (isUngrantableMultiplexer(name)) return null; // granting the multiplexer grants all it can reach
  const file = readAll();
  file.grants = file.grants ?? {};
  const grant: StandingGrant = { toolName: name, grantedAt: new Date().toISOString(), note: opts.note?.trim() || undefined };
  file.grants[name] = grant;
  writeAll(file);
  logger.info({ toolName: name }, 'standing grant added');
  return grant;
}

/** Revoke a standing grant (soft — keeps the row with revokedAt for audit). */
export function revokeStandingApproval(toolName: string): boolean {
  const file = readAll();
  const grant = file.grants?.[toolName];
  if (!grant || grant.revokedAt) return false;
  grant.revokedAt = new Date().toISOString();
  file.grants![toolName] = grant;
  writeAll(file);
  logger.info({ toolName }, 'standing grant revoked');
  return true;
}

/** Is there a live (non-revoked) standing grant for this tool? */
export function isStandingGranted(toolName: string): boolean {
  if (!standingGrantsEnabled()) return false;
  const file = readAll();
  const grant = file.grants?.[toolName];
  return !!grant && !grant.revokedAt;
}

export function listStandingGrants(): StandingGrant[] {
  const file = readAll();
  return Object.values(file.grants ?? {}).filter((g) => !g.revokedAt);
}

export function listActiveScopes(): PlanScope[] {
  const file = readAll();
  const now = Date.now();
  return Object.values(file.scopes).filter((s) => !s.closedAt && Date.parse(s.expiresAt) > now);
}

// ─── Scoped send-trust (2026-07-21) ──────────────────────────────────────────
// The bounded relaxation of the held-send invariant. A send auto-approves ONLY
// when the user granted a NARROW recipient scope and EVERY recipient falls
// inside a live grant (and under the mass-send floor). Fail-closed: a send whose
// recipients can't be extracted never matches. Over-extraction only ever causes
// MORE holding (safe) — the full-args email scan makes under-extraction of an
// email recipient essentially impossible, and non-email recipients (a phone
// call, an unlisted channel) fail closed unless explicitly granted. Zero grants
// → behaviour is byte-identical to the always-ask default. Never touches the
// batch/mass-send path: a fan-out over the floor still asks.

/** Hard ceiling no grant can exceed — a send to more than this many recipients
 *  ALWAYS asks, grant or not. The mass-send floor. */
export const SEND_TRUST_MAX_RECIPIENTS = 20;

function sendTrustEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_SEND_TRUST', 'on') || 'on').toLowerCase() !== 'off';
}

/**
 * Grant scoped send-trust. Refuses an UNSCOPED grant (no domain and no
 * recipient) — the whole point is a narrow, named boundary, never "trust all
 * sends". `maxRecipients` is clamped to the global floor. Returns the grant, or
 * null if refused.
 */
export function grantSendTrust(scope: {
  domains?: string[];
  recipients?: string[];
  toolkits?: string[];
  maxRecipients?: number;
  note?: string;
}): SendTrustGrant | null {
  if (!sendTrustEnabled()) return null;
  const domains = (scope.domains ?? []).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  const recipients = (scope.recipients ?? []).map((r) => r.trim().toLowerCase()).filter(Boolean);
  const toolkits = (scope.toolkits ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  // An unscoped send-trust ("trust everything") is refused by design.
  if (domains.length === 0 && recipients.length === 0) return null;
  const max = scope.maxRecipients !== undefined
    ? Math.max(1, Math.min(SEND_TRUST_MAX_RECIPIENTS, Math.floor(scope.maxRecipients)))
    : undefined;
  const grant: SendTrustGrant = {
    id: randomUUID(),
    grantedAt: new Date().toISOString(),
    note: scope.note?.trim() || undefined,
    domains: domains.length ? domains : undefined,
    recipients: recipients.length ? recipients : undefined,
    toolkits: toolkits.length ? toolkits : undefined,
    maxRecipients: max,
  };
  const file = readAll();
  file.sendTrust = file.sendTrust ?? [];
  file.sendTrust.push(grant);
  writeAll(file);
  logger.info({ id: grant.id, domains, recipients, toolkits, maxRecipients: max }, 'send-trust grant added');
  return grant;
}

/** Revoke a send-trust grant (soft — keeps the row with revokedAt for audit). */
export function revokeSendTrust(id: string): boolean {
  const file = readAll();
  const grant = file.sendTrust?.find((g) => g.id === id);
  if (!grant || grant.revokedAt) return false;
  grant.revokedAt = new Date().toISOString();
  writeAll(file);
  logger.info({ id }, 'send-trust grant revoked');
  return true;
}

export function listSendTrustGrants(): SendTrustGrant[] {
  const file = readAll();
  return (file.sendTrust ?? []).filter((g) => !g.revokedAt);
}

/**
 * Best-effort recipient extraction from a send's args. Scans EVERY string in the
 * args tree for email addresses (so a recipient can't hide in a nested/aliased
 * field), plus chat-style handles under recipient/channel-ish keys. Lowercased.
 * An empty result forces the caller to fail closed.
 */
export function extractSendTargets(args: unknown): { emails: string[]; handles: string[] } {
  const emails = new Set<string>();
  const handles = new Set<string>();
  const emailRe = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  const visit = (v: unknown, key?: string): void => {
    if (v == null) return;
    if (typeof v === 'string') {
      const found = v.match(emailRe);
      if (found) { found.forEach((e) => emails.add(e.toLowerCase())); return; }
      // A bare handle under a recipient/channel-ish key (Slack #channel, @user).
      if (key && /channel|recipient|handle|^to$|^to_|_to$/i.test(key)) {
        const h = v.trim().toLowerCase();
        if (h && /^[#@]?[a-z0-9._-]+$/i.test(h)) handles.add(h);
      }
      return;
    }
    if (typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x) => visit(x, key)); return; }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) visit(val, k);
  };
  let parsed: unknown = args;
  if (typeof args === 'string') { try { parsed = JSON.parse(args); } catch { /* scan the raw string */ } }
  visit(parsed);
  return { emails: [...emails], handles: [...handles] };
}

function inferToolkit(toolName: string, args: unknown): string {
  return (extractComposioSlug(args) ?? toolName).toLowerCase();
}

/**
 * Does a live send-trust grant cover THIS send? True only when every extracted
 * recipient is inside one grant's scope and the count is under the floor.
 */
export function matchesSendTrust(toolName: string, args: unknown): boolean {
  if (!sendTrustEnabled()) return false;
  const grants = listSendTrustGrants();
  if (grants.length === 0) return false;
  const { emails, handles } = extractSendTargets(args);
  const targetCount = emails.length + handles.length;
  if (targetCount === 0) return false; // fail-closed: no verifiable recipient
  if (targetCount > SEND_TRUST_MAX_RECIPIENTS) return false; // mass-send floor
  const toolkit = inferToolkit(toolName, args);
  for (const g of grants) {
    if (g.maxRecipients !== undefined && targetCount > g.maxRecipients) continue;
    if (g.toolkits && g.toolkits.length > 0 && !g.toolkits.some((t) => toolkit.includes(t))) continue;
    const domains = g.domains ?? [];
    const recipients = g.recipients ?? [];
    const emailCovered = (e: string) => recipients.includes(e) || domains.includes(e.split('@')[1] ?? '');
    const handleCovered = (h: string) => recipients.includes(h) || recipients.includes(h.replace(/^[#@]/, ''));
    if (emails.every(emailCovered) && handles.every(handleCovered)) return true;
  }
  return false;
}

/**
 * C (v2.3.0) — grant-at-card: derive a NARROW send-trust grant from the very
 * action the user just approved, so the next identical send auto-proceeds
 * instead of raising another card ("I am in full autonomy — a card shouldn't
 * be needed", 2026-07-23). Scope = exactly the recipients this action targets
 * on exactly this toolkit; no recipients extractable → no grant (fail-closed,
 * same rule as matchesSendTrust). Every grant stays revocable + audited.
 */
export function grantSendTrustFromApprovedAction(
  toolName: string,
  args: unknown,
  note?: string,
): SendTrustGrant | null {
  const { emails, handles } = extractSendTargets(args);
  const recipients = [...emails, ...handles];
  if (recipients.length === 0) return null;
  return grantSendTrust({
    recipients,
    toolkits: [inferToolkit(toolName, args)],
    note: note ?? `always-allow granted from an approved ${toolName} card`,
  });
}

export function listAllScopes(): PlanScope[] {
  const file = readAll();
  return Object.values(file.scopes).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}
