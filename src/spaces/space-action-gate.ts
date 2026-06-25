/**
 * Workspace action gate (E1) — the trust layer that lets Clem build a one-click
 * "Send email / update the CRM" button you can actually rely on.
 *
 * A Space action that MUTATES an external system (a send, a CRM write) must not
 * fire silently from a button click: it routes through the canonical approval
 * registry, so the user approves ONCE (in the same inbox/board as every other
 * approval) and only then does it run. READ-class actions (refresh a list, pull
 * rows) still fire instantly — guardrails inform, they don't get in the way.
 *
 * Why this module (not the action route inline): a Space click has NO agent
 * turn to resume, so the work must happen WHEN THE USER APPROVES. We subscribe
 * to approval-registry's generic `onApprovalResolved` hook, which fires for
 * every approve path (desktop, mobile, chat-dock) by construction — no surgery
 * in the 7k-line console-routes, and no new approval UI (register() writes the
 * row the existing /approvals + board listings already read).
 *
 * Classification reuses the SAME `classifyExternalWrite` the rest of the
 * harness uses, so a Space send gates identically to an agent send.
 *
 * Kill-switch: `CLEMMY_SPACE_ACTION_APPROVAL` — default ON (the safe behavior).
 * Set to off/0/false/no to restore instant execution while debugging.
 */
import { getRuntimeEnv } from '../config.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { classifyExternalWrite } from '../runtime/harness/confirm-first-gate.js';
import {
  onApprovalResolved, register, type PendingApprovalRow,
} from '../runtime/harness/approval-registry.js';
import { getSession, createSession } from '../runtime/harness/eventlog.js';
import { resolveInSpace, spaceStore, type SpaceAction, type SpaceRecord } from './store.js';
import { appendNote, appendAudit } from './data-store.js';
import { runSpaceAction } from './runner.js';

/** Synthetic tool name stamped on the approval row so the resolve listener can
 *  recognise a Space-action approval (and tell it apart from agent tool calls). */
export const SPACE_ACTION_TOOL = 'space_execute_action';

/** Same send-like heuristic as space-enforce's auto-repair, for runner actions
 *  (which can't be statically classified by slug). */
const SEND_LIKE_RE = /\b(send|reply|email|message|publish|post|tweet|dm|invite|sms|notify)\b/i;
function actionLooksLikeSend(a: SpaceAction): boolean {
  const hay = `${a.composioSlug ?? ''} ${a.runner ?? ''} ${a.label ?? ''} ${a.id}`.replace(/_/g, ' ');
  return SEND_LIKE_RE.test(hay);
}

export function spaceActionApprovalEnabled(): boolean {
  const raw = (getRuntimeEnv('CLEMMY_SPACE_ACTION_APPROVAL', 'on') ?? 'on').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

/**
 * Does this action mutate an external system (→ needs one approval)?
 *  - confirm:true → ALWAYS gates (explicit author intent; space-enforce already
 *    auto-repairs this onto send-like actions at save time).
 *  - Composio action → the shared harness classifier (CREATE/UPDATE/DELETE/SEND/
 *    POST… gate; GET/LIST/SEARCH stay instant).
 *  - Runner action → can't classify statically; gate only if it looks like a send.
 */
export function spaceActionNeedsApproval(action: SpaceAction): boolean {
  if (action.confirm === true) return true;
  if (action.composioSlug && action.composioSlug.trim()) {
    try {
      return classifyExternalWrite('composio_execute_tool', { tool_slug: action.composioSlug.trim() }).mutating;
    } catch {
      return false; // can't classify → don't block (fail-open, matches the harness)
    }
  }
  return actionLooksLikeSend(action);
}

/** A short human preview of what the action will do, for the approval card. */
function actionPreview(action: SpaceAction, callerArgs: Record<string, unknown>): string {
  const args = { ...(action.argsTemplate ?? {}), ...(callerArgs ?? {}) };
  const pick = (keys: string[]): string | undefined => {
    for (const k of keys) { const v = args[k]; if (typeof v === 'string' && v.trim()) return v; }
    return undefined;
  };
  const recipient = pick(['to', 'to_email', 'toEmail', 'recipient', 'recipients', 'email', 'address']);
  const subject = pick(['subject', 'title', 'summary']);
  const bits = [recipient ? `to ${recipient}` : '', subject ? `“${subject}”` : ''].filter(Boolean).join(' ');
  return bits || action.composioSlug || action.runner || action.id;
}

interface ActionApprovalSnapshot {
  id: string;
  label: string | null;
  composioSlug: string | null;
  runner: string | null;
  argsTemplate: Record<string, unknown> | null;
  confirm: boolean;
  runnerSha256: string | null;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function stableClone(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stableClone);
  const obj = asObj(v);
  if (!obj) return v;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = stableClone(obj[key]);
  return out;
}

function runnerSha256(slug: string, runner: string | undefined): string | null {
  const name = runner?.trim();
  if (!name) return null;
  try {
    const file = resolveInSpace(slug, path.join('data', name));
    if (!existsSync(file)) return null;
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

function actionSnapshot(rec: SpaceRecord, action: SpaceAction): ActionApprovalSnapshot {
  return {
    id: action.id,
    label: action.label ?? null,
    composioSlug: action.composioSlug ?? null,
    runner: action.runner ?? null,
    argsTemplate: asObj(action.argsTemplate) ? stableClone(action.argsTemplate) as Record<string, unknown> : null,
    confirm: action.confirm === true,
    runnerSha256: runnerSha256(rec.id, action.runner),
  };
}

function parseActionSnapshot(v: unknown): ActionApprovalSnapshot | null {
  const obj = asObj(v);
  if (!obj || typeof obj.id !== 'string') return null;
  const argsTemplate = obj.argsTemplate === null || obj.argsTemplate === undefined
    ? null
    : asObj(obj.argsTemplate);
  return {
    id: obj.id,
    label: typeof obj.label === 'string' ? obj.label : null,
    composioSlug: typeof obj.composioSlug === 'string' ? obj.composioSlug : null,
    runner: typeof obj.runner === 'string' ? obj.runner : null,
    argsTemplate: argsTemplate ? stableClone(argsTemplate) as Record<string, unknown> : null,
    confirm: obj.confirm === true,
    runnerSha256: typeof obj.runnerSha256 === 'string' ? obj.runnerSha256 : null,
  };
}

function snapshotsEqual(a: ActionApprovalSnapshot, b: ActionApprovalSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function actionFromSnapshot(snapshot: ActionApprovalSnapshot): SpaceAction {
  const action: SpaceAction = { id: snapshot.id };
  if (snapshot.label) action.label = snapshot.label;
  if (snapshot.composioSlug) action.composioSlug = snapshot.composioSlug;
  if (snapshot.runner) action.runner = snapshot.runner;
  if (snapshot.argsTemplate) action.argsTemplate = snapshot.argsTemplate;
  if (snapshot.confirm) action.confirm = true;
  return action;
}

function recordApprovedActionNotRun(
  slug: string,
  actionLabel: string,
  actionId: string,
  approvalId: string,
  error: string,
): void {
  appendAudit(slug, {
    method: 'ACTION', path: `/action/${actionId}`,
    outcome: 'error', note: error,
  });
  appendNote(slug, {
    text: `“${actionLabel}” was not run after approval: ${error}`,
    kind: 'action',
    meta: { actionId, ok: false, approvalId },
  });
}

export interface EnqueueResult { approvalId: string; subject: string; }

/** The dedicated session id for a Workspace (shared with the dock + re-engage
 *  thread, spaceSessionId() in space-routes). pending_approvals references
 *  sessions(id), so the row must exist before we can register an approval. */
function ensureSpaceSession(rec: SpaceRecord): string {
  const sessionId = `space-${rec.id}`;
  if (!getSession(sessionId)) {
    // Idempotent-by-intent: a concurrent click could create it first → ignore
    // the resulting PK conflict (single-user loopback makes this near-impossible).
    try { createSession({ id: sessionId, kind: 'chat', title: rec.title }); } catch { /* already created */ }
  }
  return sessionId;
}

/** Register a pending approval for a gated Space action; record it on the
 *  surface as a note + audit so the dock + the user see it's waiting. */
export function enqueueSpaceActionApproval(
  rec: SpaceRecord,
  action: SpaceAction,
  callerArgs: Record<string, unknown>,
): EnqueueResult {
  const verb = actionLooksLikeSend(action) ? 'Send' : 'Run';
  const subject = `${verb} “${action.label ?? action.id}” in workspace “${rec.title}”`;
  const row = register({
    sessionId: ensureSpaceSession(rec),
    subject,
    tool: SPACE_ACTION_TOOL,
    args: {
      spaceSlug: rec.id,
      actionId: action.id,
      callerArgs,
      composioSlug: action.composioSlug ?? null,
      actionSnapshot: actionSnapshot(rec, action),
      preview: actionPreview(action, callerArgs),
    },
  });
  appendAudit(rec.id, { method: 'ACTION_PENDING', path: `/action/${action.id}`, outcome: 'ok', note: row.approvalId });
  appendNote(rec.id, {
    text: `“${action.label ?? action.id}” is awaiting your approval (${row.approvalId}).`,
    kind: 'action',
    meta: { actionId: action.id, approvalId: row.approvalId, status: 'pending' },
  });
  return { approvalId: row.approvalId, subject };
}

/** Execute a Space action whose approval was just APPROVED. Best-effort; records
 *  the outcome so the dock's Clem + the user see what happened. */
export async function executeApprovedSpaceAction(row: PendingApprovalRow): Promise<void> {
  const args = row.args ?? {};
  const slug = typeof args.spaceSlug === 'string' ? args.spaceSlug : '';
  const actionId = typeof args.actionId === 'string' ? args.actionId : '';
  const callerArgs = (args.callerArgs && typeof args.callerArgs === 'object')
    ? args.callerArgs as Record<string, unknown> : {};
  if (!slug || !actionId) return;
  const rec = spaceStore.get(slug);
  if (!rec) return;
  const approvedSnapshot = parseActionSnapshot(args.actionSnapshot);
  const action = rec.actions.find((a) => a.id === actionId);
  const label = approvedSnapshot?.label ?? action?.label ?? actionId;
  if (!approvedSnapshot) {
    recordApprovedActionNotRun(
      slug,
      label,
      actionId,
      row.approvalId,
      'approval is missing its action snapshot; click the workspace action again so the approval can bind to the exact action.',
    );
    return;
  }
  if (rec.status !== 'active') {
    recordApprovedActionNotRun(slug, label, actionId, row.approvalId, `workspace is ${rec.status}.`);
    return;
  }
  if (!action) {
    recordApprovedActionNotRun(slug, label, actionId, row.approvalId, 'action no longer exists in the workspace.');
    return;
  }
  if (!snapshotsEqual(actionSnapshot(rec, action), approvedSnapshot)) {
    recordApprovedActionNotRun(
      slug,
      label,
      actionId,
      row.approvalId,
      'action changed after approval was requested; click it again to approve the current action.',
    );
    return;
  }
  if (rec.manifestErrors && rec.manifestErrors.length > 0) {
    const error = `workspace manifest is invalid; fix with space_save before running actions: ${rec.manifestErrors.join('; ')}`;
    recordApprovedActionNotRun(slug, label, actionId, row.approvalId, error);
    return;
  }
  const result = await runSpaceAction(slug, actionFromSnapshot(approvedSnapshot), callerArgs);
  appendAudit(slug, {
    method: 'ACTION', path: `/action/${actionId}`,
    outcome: result.ok ? 'ok' : 'error', note: result.ok ? row.approvalId : result.error,
  });
  appendNote(slug, {
    text: result.ok
      ? `Approved and ran “${label}”.`
      : `“${label}” failed after approval: ${result.error}`,
    kind: 'action',
    meta: { actionId, ok: result.ok, approvalId: row.approvalId },
  });
}

/** Record a rejected/expired/cancelled Space action so the surface reflects it. */
function recordUnapproved(row: PendingApprovalRow): void {
  const args = row.args ?? {};
  const slug = typeof args.spaceSlug === 'string' ? args.spaceSlug : '';
  const actionId = typeof args.actionId === 'string' ? args.actionId : '';
  if (!slug || !actionId) return;
  const status = row.resolution ?? 'rejected';
  appendAudit(slug, { method: 'ACTION_REJECTED', path: `/action/${actionId}`, outcome: 'rejected', note: row.approvalId });
  appendNote(slug, {
    text: `“${actionId}” was not run (${status}).`,
    kind: 'action',
    meta: { actionId, approvalId: row.approvalId, status },
  });
}

function recordApprovalExecutionCrash(row: PendingApprovalRow, err: unknown): void {
  const args = row.args ?? {};
  const slug = typeof args.spaceSlug === 'string' ? args.spaceSlug : '';
  const actionId = typeof args.actionId === 'string' ? args.actionId : '';
  if (!slug || !actionId) return;
  const message = err instanceof Error ? err.message : String(err);
  recordApprovedActionNotRun(
    slug,
    actionId,
    actionId,
    row.approvalId,
    `approved action crashed before it could report an outcome: ${message}`,
  );
}

let initialized = false;
/**
 * Wire the resolve listener once (idempotent). Called from registerSpaceRoutes
 * at daemon boot so an approved Space action actually runs.
 */
export function initSpaceActionApprovals(): void {
  if (initialized) return;
  initialized = true;
  onApprovalResolved((row) => {
    if (row.tool !== SPACE_ACTION_TOOL) return;
    if (row.resolution === 'approved') {
      void executeApprovedSpaceAction(row).catch((err) => {
        recordApprovalExecutionCrash(row, err);
      });
    } else {
      recordUnapproved(row);
    }
  });
}
