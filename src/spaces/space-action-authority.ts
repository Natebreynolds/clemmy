/**
 * Exact durable authority for approval-gated Workspace actions.
 *
 * An approval id is only an address, never authority by itself. Execution must
 * bind to the resolved+approved registry row and the exact Workspace, action,
 * caller arguments, manifest fields, and runner entrypoint digest the human saw.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { get as getApproval, listPending } from '../runtime/harness/approval-registry.js';
import { SPACE_ACTION_APPROVAL_TOOL } from './space-execution-policy.js';
import { resolveInSpace, type SpaceAction, type SpaceRecord } from './store.js';

export interface ActionApprovalSnapshot {
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

function stableJson(v: unknown): string {
  return JSON.stringify(stableClone(v));
}

/**
 * Durable identity for one still-pending Workspace action card.
 *
 * The key includes the same authority fields stored on the approval row, and
 * canonicalizes object key order so an HTTP/client retry cannot mint a second
 * mutation slot merely because its JSON properties arrived in another order.
 * `registerResumable` verifies the full unhashed row authority on a hit, so a
 * theoretical digest collision fails closed instead of sharing a card.
 */
export function spaceActionApprovalResumeKey(input: {
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
}): string {
  const digest = createHash('sha256')
    .update(stableJson({
      sessionId: input.sessionId,
      tool: input.tool,
      args: input.args,
    }))
    .digest('hex');
  return `space-action-approval-v1:${input.sessionId}:${digest}`;
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

export function actionApprovalSnapshot(
  rec: Pick<SpaceRecord, 'id'>,
  action: SpaceAction,
): ActionApprovalSnapshot {
  return {
    id: action.id,
    label: action.label ?? null,
    composioSlug: action.composioSlug ?? null,
    runner: action.runner ?? null,
    argsTemplate: asObj(action.argsTemplate)
      ? stableClone(action.argsTemplate) as Record<string, unknown>
      : null,
    confirm: action.confirm === true,
    runnerSha256: runnerSha256(rec.id, action.runner),
  };
}

export function parseActionApprovalSnapshot(v: unknown): ActionApprovalSnapshot | null {
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
    argsTemplate: argsTemplate
      ? stableClone(argsTemplate) as Record<string, unknown>
      : null,
    confirm: obj.confirm === true,
    runnerSha256: typeof obj.runnerSha256 === 'string' ? obj.runnerSha256 : null,
  };
}

export function actionApprovalSnapshotsEqual(
  a: ActionApprovalSnapshot,
  b: ActionApprovalSnapshot,
): boolean {
  return stableJson(a) === stableJson(b);
}

export function actionFromApprovalSnapshot(snapshot: ActionApprovalSnapshot): SpaceAction {
  const action: SpaceAction = { id: snapshot.id };
  if (snapshot.label) action.label = snapshot.label;
  if (snapshot.composioSlug) action.composioSlug = snapshot.composioSlug;
  if (snapshot.runner) action.runner = snapshot.runner;
  if (snapshot.argsTemplate) action.argsTemplate = snapshot.argsTemplate;
  if (snapshot.confirm) action.confirm = true;
  return action;
}

export interface SpaceActionAuthorityResult {
  ok: boolean;
  approvalId?: string;
  runnerSha256?: string;
  error?: string;
}

/**
 * Standing coverage: a prior human approval whose EXACT authority still holds.
 *
 * Reuses verifySpaceActionApprovalAuthority row by row, so coverage means
 * precisely what a fresh approval would mean — same workspace, same action id,
 * byte-identical caller args, and a runner entrypoint whose LIVE sha256 still
 * equals the approved digest (the snapshot equality recomputes it from disk,
 * so any edit to the runner voids coverage before a spawn). The row's own
 * expiresAt bounds the grant window; eligibility policy (which actions may be
 * covered at all) is the caller's concern, not this module's.
 */
export function findStandingSpaceActionApproval(input: {
  slug: string;
  action: SpaceAction;
  callerArgs: Record<string, unknown>;
  now?: number;
}): SpaceActionAuthorityResult | null {
  const now = input.now ?? Date.now();
  const rows = listPending({ sessionId: `space-${input.slug}`, status: 'any' });
  for (const row of rows) {
    if (row.tool !== SPACE_ACTION_APPROVAL_TOOL) continue;
    if (row.status !== 'resolved' || row.resolution !== 'approved') continue;
    if (!row.expiresAt || Date.parse(row.expiresAt) <= now) continue;
    const verified = verifySpaceActionApprovalAuthority({
      approvalId: row.approvalId,
      slug: input.slug,
      action: input.action,
      callerArgs: input.callerArgs,
    });
    if (verified.ok) return verified;
  }
  return null;
}

export function verifySpaceActionApprovalAuthority(input: {
  approvalId: string;
  slug: string;
  action: SpaceAction;
  callerArgs: Record<string, unknown>;
}): SpaceActionAuthorityResult {
  const approvalId = input.approvalId.trim();
  if (!approvalId) return { ok: false, error: 'approval id is missing' };
  const row = getApproval(approvalId);
  if (
    !row
    || row.status !== 'resolved'
    || row.resolution !== 'approved'
    || row.tool !== SPACE_ACTION_APPROVAL_TOOL
    || row.sessionId !== `space-${input.slug}`
  ) {
    return { ok: false, error: 'approval is missing, unresolved, rejected, or belongs to a different tool/session' };
  }
  const args = row.args;
  if (
    !args
    || args.spaceSlug !== input.slug
    || args.actionId !== input.action.id
    || stableJson(args.callerArgs ?? {}) !== stableJson(input.callerArgs ?? {})
  ) {
    return { ok: false, error: 'approval does not match this Workspace action or its caller arguments' };
  }
  const approvedSnapshot = parseActionApprovalSnapshot(args.actionSnapshot);
  const currentSnapshot = actionApprovalSnapshot({ id: input.slug }, input.action);
  if (!approvedSnapshot || !actionApprovalSnapshotsEqual(approvedSnapshot, currentSnapshot)) {
    return { ok: false, error: 'approval does not match the current action manifest or runner entrypoint' };
  }
  if (approvedSnapshot.runner && !approvedSnapshot.runnerSha256) {
    return { ok: false, error: 'approval is missing its runner entrypoint digest' };
  }
  return {
    ok: true,
    approvalId,
    ...(approvedSnapshot.runnerSha256
      ? { runnerSha256: approvedSnapshot.runnerSha256 }
      : {}),
  };
}
