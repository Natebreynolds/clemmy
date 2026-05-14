import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { BASE_DIR } from '../config.js';

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
 * actually said it would do (allowedTools). The wider the
 * allowedTools, the less granular the consent — keep this tight.
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
  /** Tool names that the plan-approval covers. Default: shell + file writes. */
  allowedTools: string[];
  openedAt: string;
  expiresAt: string;
  /** Audit trail of auto-approved calls inside this scope. */
  autoApprovals: AutoApprovalEntry[];
  /** Set when the user or system manually closed the scope. */
  closedAt?: string;
  closedReason?: string;
  version: 'v1';
}

interface ScopesFile {
  scopes: Record<string, PlanScope>; // keyed by sessionId
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
}

export const DEFAULT_SCOPE_ALLOWED_TOOLS = ['run_shell_command', 'write_file'];

export function openPlanScope(input: OpenPlanScopeInput): PlanScope {
  if (!input.sessionId) throw new Error('sessionId required to open a plan scope');
  const ttl = Math.min(ABSOLUTE_MAX_TTL_MS, Math.max(60_000, input.ttlMs ?? DEFAULT_SCOPE_TTL_MS));
  const now = Date.now();
  const scope: PlanScope = {
    sessionId: input.sessionId,
    planProposalId: input.planProposalId,
    approvedPlanObjective: input.approvedPlanObjective,
    allowedTools: input.allowedTools && input.allowedTools.length > 0 ? input.allowedTools : DEFAULT_SCOPE_ALLOWED_TOOLS,
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
  }, 'plan scope opened');

  return scope;
}

export function getPlanScope(sessionId: string): PlanScope | null {
  if (!sessionId) return null;
  const file = readAll();
  const scope = file.scopes[sessionId];
  if (!scope) return null;
  if (scope.closedAt) return scope; // return closed scope for inspection but isAutoApproved will refuse
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
export function isAutoApprovedByScope(sessionId: string | undefined, toolName: string): boolean {
  if (!sessionId) return false;
  const scope = getPlanScope(sessionId);
  if (!scope) return false;
  if (scope.closedAt) return false;
  if (!scope.allowedTools.includes(toolName)) return false;
  return true;
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
      return cwd ? `[cwd=${cwd}] ${cmd.slice(0, 240)}` : cmd.slice(0, 240);
    }
    case 'write_file': {
      const p = typeof obj.path === 'string' ? obj.path : '';
      const len = typeof obj.content === 'string' ? obj.content.length : 0;
      return `${p} (${len} chars)`;
    }
    default:
      return Object.entries(obj).slice(0, 4).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(' · ');
  }
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
