/** Explicit recurring consent for one saved script. This never broadens Auto
 * mode or reuses a one-shot approval as permission for a second occurrence. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { WORKSPACE_SCRIPT_OPERATION, workspaceScriptArguments, type WorkspaceScriptArguments } from '../../spaces/workspace-script-contract.js';
import { approvalResolutionWithinLifetime, claimResumableApproval, get as getApproval, type PendingApprovalRow } from './approval-registry.js';
import { openEventLog } from './eventlog.js';
import { canonicalArgumentDigestOf } from './resolved-call-authority.js';
import type { WorkflowV3AutoConsentArmInput } from './accepted-turn-call-authority.js';
import { readSavedSourceControlState, savedSourceReviewIsCurrent, stopSavedSource } from './saved-source-control-state.js';

export const SAVED_SOURCE_SCRIPT_CONSENT_TOOL = 'workspace_source_script_consent';
const sha = (value: unknown) => createHash('sha256').update(closedCanonicalJson(value)).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const savedSourceScriptScope = z.strictObject({
  version: z.literal(1),
  reviewId: z.string().uuid().optional(),
  workspaceId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/),
  sourceId: z.string().min(1).max(256),
  sourceDigest: hash,
  scriptSha256: hash,
  runner: z.string().min(1).max(240),
  schedule: z.strictObject({ cron: z.string().min(1).max(240).nullable(), timeZone: z.string().min(1).max(100) }),
  occurrences: z.literal('manual_and_saved_schedule'),
  access: z.literal('local_user_credentials_network_and_live_dependencies'),
  validity: z.literal('while_saved_source_and_script_match_unless_revoked'),
});
export type SavedSourceScriptScope = z.infer<typeof savedSourceScriptScope>;
export const savedSourceScopeResumeKey = (scope: SavedSourceScriptScope) => `saved-source-consent:${sha(savedSourceScriptScope.parse(scope))}`;

interface GrantRow {
  grant_id: string; approval_id: string; scope_json: string; decision_json: string;
  decision_digest: string; revoked_at: string | null;
}
export interface SavedSourceScriptGrant {
  grantId: string; approvalId: string; scope: SavedSourceScriptScope;
  decisionDigest: string; active: boolean;
}
function decisionSnapshot(row: PendingApprovalRow) {
  return { approvalId: row.approvalId, sessionId: row.sessionId, tool: row.tool,
    args: row.args, resumeKey: row.resumeKey, requestedAt: row.requestedAt,
    expiresAt: row.expiresAt, resolvedAt: row.resolvedAt, resolver: row.resolver,
    resolution: row.resolution, status: row.status };
}
function validDecision(value: unknown, scope: SavedSourceScriptScope): boolean {
  if (!value || typeof value !== 'object') return false;
  const row = value as ReturnType<typeof decisionSnapshot>;
  return row.status === 'resolved' && row.resolution === 'approved'
    && typeof row.resolver === 'string' && row.resolver.length > 0
    && row.tool === SAVED_SOURCE_SCRIPT_CONSENT_TOOL
    && row.sessionId === `workspace-script:${scope.workspaceId}`
    && row.resumeKey === savedSourceScopeResumeKey(scope)
    && approvalResolutionWithinLifetime(row)
    && closedCanonicalJson(row.args) === closedCanonicalJson(scope);
}

export function readSavedSourceScriptGrant(grantId: string, db = openEventLog()): SavedSourceScriptGrant | null {
  const row = db.prepare('SELECT * FROM saved_source_script_grants_v1 WHERE grant_id = ?').get(grantId) as GrantRow | undefined;
  if (!row) return null;
  try {
    const scope = savedSourceScriptScope.parse(JSON.parse(row.scope_json));
    const decision = JSON.parse(row.decision_json);
    if (row.grant_id !== `saved-source:${row.approval_id}` || decision.approvalId !== row.approval_id
      || sha(decision) !== row.decision_digest || !validDecision(decision, scope)) return null;
    return { grantId: row.grant_id, approvalId: row.approval_id, scope,
      decisionDigest: row.decision_digest, active: row.revoked_at === null
        && savedSourceReviewIsCurrent(scope.workspaceId, scope.sourceId, scope.reviewId, db) };
  } catch { return null; }
}

/** The grant outlives registry/session retention. A revoked latest grant is
 * returned too, so ordinary refreshes cannot silently ask for it again. */
export function findSavedSourceScriptGrant(scope: SavedSourceScriptScope): SavedSourceScriptGrant | null {
  const row = openEventLog().prepare(`SELECT grant_id FROM saved_source_script_grants_v1
    WHERE scope_json = ? ORDER BY rowid DESC LIMIT 1`).get(
    closedCanonicalJson(savedSourceScriptScope.parse(scope)),
  ) as { grant_id: string } | undefined;
  return row ? readSavedSourceScriptGrant(row.grant_id) : null;
}

/** Transfer one approved scope card into an immutable grant in the same DB
 * transaction as its consume CAS. Reentry cannot revive a revoked grant. */
export function recordApprovedSavedSourceScriptGrant(approvalId: string): SavedSourceScriptGrant {
  const db = openEventLog();
  return db.transaction(() => {
    const grantId = `saved-source:${approvalId}`;
    const prior = readSavedSourceScriptGrant(grantId);
    if (prior) return prior;
    const row = getApproval(approvalId);
    if (!row || row.presentation) throw new Error('Saved source lacks an explicit scope approval.');
    const scope = savedSourceScriptScope.parse(row.args);
    const decision = decisionSnapshot(row);
    if (!validDecision(decision, scope)) throw new Error('Saved source scope approval does not match or was not approved in time.');
    const claimed = claimResumableApproval(savedSourceScopeResumeKey(scope), approvalId);
    if (claimed.state !== 'approved') throw new Error(`Saved source scope approval cannot be consumed: ${claimed.state}.`);
    db.prepare(`INSERT INTO saved_source_script_grants_v1
      (grant_id, approval_id, scope_json, decision_json, decision_digest, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(grantId, approvalId, closedCanonicalJson(scope),
      closedCanonicalJson(decision), sha(decision), new Date().toISOString());
    return readSavedSourceScriptGrant(grantId)!;
  }).immediate();
}

export function revokeSavedSourceScriptGrant(grantId: string, reason: string): boolean {
  if (!reason.trim()) throw new Error('Saved source revocation requires a reason.');
  const db = openEventLog();
  return db.transaction(() => {
    const grant = readSavedSourceScriptGrant(grantId, db);
    const changed = db.prepare(`UPDATE saved_source_script_grants_v1 SET revoked_at = ?, revocation_reason = ?
      WHERE grant_id = ? AND revoked_at IS NULL`).run(new Date().toISOString(), reason.trim().slice(0, 2000), grantId).changes === 1;
    if (changed && grant && readSavedSourceControlState(grant.scope.workspaceId, grant.scope.sourceId, db).reviewId === (grant.scope.reviewId ?? null)) {
      stopSavedSource(grant.scope.workspaceId, grant.scope.sourceId, db);
    }
    return changed;
  }).immediate();
}

/** Process-opaque token. Structural clones and serialized fields grant nothing. */
export interface SavedSourceWorkflowConsentAuthorization { readonly version: 1 }
interface ConsentReceipt {
  version: 1; grantId: string; decisionDigest: string; authorityDigest: string;
  args: WorkspaceScriptArguments; receiptDigest: string;
}
export interface SavedSourceWorkflowConsentState {
  authority: WorkflowV3AutoConsentArmInput;
  receipt: ConsentReceipt;
}
const authorizations = new WeakMap<object, SavedSourceWorkflowConsentState>();

function grantMatchesCall(grant: SavedSourceScriptGrant, authority: WorkflowV3AutoConsentArmInput, args: WorkspaceScriptArguments,
  db = openEventLog(), requireCurrentZone = true): boolean {
  const occurrence = db.prepare(`SELECT session_id, logical_call_id, preparation_json FROM workspace_script_occurrences_v1
    WHERE workspace_id = ? AND source_id = ? AND occurrence_id = ?`).get(args.slug, args.source_id, args.occurrence_id) as
      { session_id: string; logical_call_id: string; preparation_json: string } | undefined;
  if (!occurrence) return false;
  const prepared = JSON.parse(occurrence.preparation_json) as { args: WorkspaceScriptArguments;
    source: { runner?: string; schedule?: string; timezone?: string } };
  const timeZone = prepared.source.timezone?.trim();
  return occurrence?.session_id === authority.sessionId && occurrence.logical_call_id === authority.logicalCallId
    && canonicalArgumentDigestOf(prepared.args) === canonicalArgumentDigestOf(args)
    && grant.scope.runner === prepared.source.runner
    && grant.scope.schedule.cron === (prepared.source.schedule?.trim() || null)
    && (!timeZone || grant.scope.schedule.timeZone === timeZone)
    && (!requireCurrentZone || !!timeZone || grant.scope.schedule.timeZone === Intl.DateTimeFormat().resolvedOptions().timeZone)
    && authority.binding.operationId === WORKSPACE_SCRIPT_OPERATION
    && authority.binding.effect === 'admin' && authority.binding.accountId === 'local_registry:host'
    && authority.sessionId === `workspace-script:${args.slug}`
    && authority.runOccurrenceId === args.occurrence_id && authority.runId === args.occurrence_id
    && canonicalArgumentDigestOf(args) === authority.canonicalArgumentDigest
    && grant.scope.workspaceId === args.slug && grant.scope.sourceId === args.source_id
    && grant.scope.sourceDigest === args.source_digest && grant.scope.scriptSha256 === args.script_sha256
    && (args.cause !== 'scheduled' || grant.scope.schedule.cron !== null);
}

export function authorizeSavedSourceWorkflowCall(input: {
  authority: WorkflowV3AutoConsentArmInput; args: Record<string, unknown>; grantId: string;
}): SavedSourceWorkflowConsentAuthorization {
  // Parse for validation only: the canonical argument seal includes key order.
  workspaceScriptArguments.parse(input.args);
  const args = JSON.parse(JSON.stringify(input.args)) as WorkspaceScriptArguments;
  const authority = JSON.parse(closedCanonicalJson(input.authority)) as WorkflowV3AutoConsentArmInput;
  const grant = readSavedSourceScriptGrant(input.grantId);
  if (!grant?.active || !grantMatchesCall(grant, authority, args)) {
    throw new Error('Saved source grant does not cover this exact call, or has been revoked.');
  }
  const fields = { version: 1 as const, grantId: grant.grantId, decisionDigest: grant.decisionDigest,
    authorityDigest: sha(authority), args };
  const authorization = Object.freeze({ version: 1 as const });
  authorizations.set(authorization, { authority, receipt: { ...fields, receiptDigest: sha(fields) } });
  return authorization;
}

function receiptMatches(receipt: ConsentReceipt, authority: WorkflowV3AutoConsentArmInput, requireActive: boolean, db = openEventLog()): boolean {
  try {
    const grant = readSavedSourceScriptGrant(receipt.grantId, db);
    const { receiptDigest, ...fields } = receipt;
    workspaceScriptArguments.parse(receipt.args);
    return !!grant && (!requireActive || grant.active)
      && receipt.version === 1 && receipt.authorityDigest === sha(authority)
      && receipt.decisionDigest === grant.decisionDigest && receiptDigest === sha(fields)
      && grantMatchesCall(grant, authority, receipt.args, db, requireActive);
  } catch { return false; }
}

export function savedSourceWorkflowConsentState(
  token: SavedSourceWorkflowConsentAuthorization | undefined, authority: WorkflowV3AutoConsentArmInput,
): SavedSourceWorkflowConsentState | null {
  if (!token) return null;
  const state = authorizations.get(token);
  return state && receiptMatches(state.receipt, authority, true) ? state : null;
}

export function persistSavedSourceWorkflowConsent(activationId: string, state: SavedSourceWorkflowConsentState, db = openEventLog()): void {
  if (!receiptMatches(state.receipt, state.authority, true, db)) throw new Error('Saved source consent changed before activation.');
  db.prepare(`INSERT INTO workflow_v3_saved_source_consent_v1
    (activation_id, session_id, logical_call_id, grant_id, receipt_json)
    VALUES (?, ?, ?, ?, ?)`).run(activationId, state.authority.sessionId,
    state.authority.logicalCallId, state.receipt.grantId, JSON.stringify(state.receipt));
}

/** Historical proof remains valid after revocation; dispatch separately checks
 * current grant status. A completed result can still replay without executing. */
export function hasRetainedSavedSourceWorkflowConsent(activationId: string, authority: WorkflowV3AutoConsentArmInput, db = openEventLog()): boolean {
  const row = db.prepare('SELECT receipt_json FROM workflow_v3_saved_source_consent_v1 WHERE activation_id = ?')
    .get(activationId) as { receipt_json: string } | undefined;
  try { return !!row && receiptMatches(JSON.parse(row.receipt_json), authority, false, db); }
  catch { return false; }
}

/** Called by the script carrier before launch and while its process is alive.
 * One-shot script calls have no scope receipt and keep their original rules. */
export function savedSourceCallConsentIsCurrent(sessionId: string, logicalCallId: string, timeZone: string): boolean {
  const row = openEventLog().prepare(`SELECT grant_id FROM workflow_v3_saved_source_consent_v1
    WHERE session_id = ? AND logical_call_id = ?`).get(sessionId, logicalCallId) as { grant_id: string } | undefined;
  if (!row) return true;
  const grant = readSavedSourceScriptGrant(row.grant_id);
  return !!grant?.active && grant.scope.schedule.timeZone === timeZone;
}
