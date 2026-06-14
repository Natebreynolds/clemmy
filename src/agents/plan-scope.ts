import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import { redactSensitiveText } from '../runtime/security.js';

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

interface ScopesFile {
  scopes: Record<string, PlanScope>; // keyed by sessionId
  /** Standing grants, keyed by toolName (B2). */
  grants?: Record<string, StandingGrant>;
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
  if (scope.goalScoped && kindHint === 'send') {
    const sends = scope.allowedSends ?? [];
    if (sends.length === 0) return false;
    const slug = extractComposioSlug(args);
    return sends.includes(toolName) || (!!slug && sends.includes(slug));
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
  reason: 'plan-scope' | 'workspace-policy' | 'yolo-policy' | 'denied';
}

export function evaluateAutoApprove(input: {
  sessionId: string | undefined;
  toolName: string;
  args?: unknown;
  scope: 'strict' | 'balanced' | 'workspace' | 'yolo';
  insideWorkspace: boolean;
  /** 'send' applies the goal-scoped send lock; anything else is 'other'. */
  kindHint?: 'send' | 'other';
}): AutoApproveDecision {
  if (isAutoApprovedByScope(input.sessionId, input.toolName, input.args, input.kindHint)) {
    return { autoApproved: true, reason: 'plan-scope' };
  }
  if (input.scope === 'yolo') {
    return { autoApproved: true, reason: 'yolo-policy' };
  }
  if (input.scope === 'workspace' && input.insideWorkspace) {
    return { autoApproved: true, reason: 'workspace-policy' };
  }
  // 'balanced' and 'strict' are identical on the EXECUTION gate: a
  // mutating shell/file write still needs an active plan scope. Balanced's
  // looseness lives on the CONVERSATION side (plan-first clarify depth),
  // not in extra execution auto-approval. Keeps execution conservative.
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
  return (process.env.CLEMMY_STANDING_GRANTS || 'on').toLowerCase() !== 'off';
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
function isUngrantableMultiplexer(name: string): boolean {
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

export function listAllScopes(): PlanScope[] {
  const file = readAll();
  return Object.values(file.scopes).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}
