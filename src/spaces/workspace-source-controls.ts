/** First-party owner controls over one source's retained execution. These
 * commands do not grant execution, overwrite settlements or undo effects. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { inspectResumableApproval, resolve } from '../runtime/harness/approval-registry.js';
import { findSavedSourceScriptGrant, savedSourceScopeResumeKey, SAVED_SOURCE_SCRIPT_CONSENT_TOOL } from '../runtime/harness/saved-source-consent.js';
import { beginSavedSourceReview, readSavedSourceControlState, stopSavedSource } from '../runtime/harness/saved-source-control-state.js';
import { closeWorkflowV3CallAuthority, readWorkflowV3CallAuthority } from '../runtime/harness/accepted-turn-call-authority.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import type { WorkspaceSourceControlView, WorkspaceSourceControlResponse } from '../shared/workspace-source-controls.js';
import { captureWorkspaceScriptArguments } from './workspace-script-carrier.js';
import { listUnpublishedWorkspaceScriptOccurrences, readWorkspaceScriptOccurrence } from './workspace-script-occurrence.js';
import { spaceStore } from './store.js';

const requestSchema = z.strictObject({ controlId: z.string().uuid(), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  action: z.enum(['stop', 'review', 'resolve']), note: z.string().trim().max(2000).optional(), reviewedEffects: z.boolean().optional() });
export class WorkspaceSourceControlError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const fail = (status: number, message: string): never => { throw new WorkspaceSourceControlError(status, message); };
const digest = (value: unknown) => createHash('sha256').update(closedCanonicalJson(value)).digest('hex');

function inspect(slug: string, sourceId: string) {
  const space = spaceStore.get(slug);
  const source = space?.dataSources.find(source => source.id === sourceId);
  if (!space || space.status === 'archived' || !source?.runner || source.cliArgv?.length || source.composioSlug?.trim()) {
    return fail(404, 'Saved script source not found.');
  }
  const db = openEventLog();
  const policy = readSavedSourceControlState(slug, sourceId);
  const key = listUnpublishedWorkspaceScriptOccurrences(slug, sourceId)[0];
  const occurrence = key ? readWorkspaceScriptOccurrence(key) : null;
  let args: ReturnType<typeof captureWorkspaceScriptArguments> | null = null;
  let unavailable: string | null = null;
  try { args = captureWorkspaceScriptArguments({ slug, source_id: sourceId, occurrence_id: 'control-inspection', cause: 'manual' }); }
  catch (error) { unavailable = String(error instanceof Error ? error.message : error).slice(0, 300); }
  const scope = args ? { version: 1 as const, workspaceId: slug, sourceId,
    ...(policy.reviewId ? { reviewId: policy.reviewId } : {}), sourceDigest: args.source_digest, scriptSha256: args.script_sha256,
    runner: source.runner, schedule: { cron: source.schedule?.trim() || null,
      timeZone: source.timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone },
    occurrences: 'manual_and_saved_schedule' as const, access: 'local_user_credentials_network_and_live_dependencies' as const,
    validity: 'while_saved_source_and_script_match_unless_revoked' as const } : null;
  const decision = scope ? inspectResumableApproval(savedSourceScopeResumeKey(scope)) : null;
  const grant = scope ? findSavedSourceScriptGrant(scope) : null;
  const logical = occurrence ? db.prepare(`SELECT state, outcome_kind FROM logical_tool_calls
    WHERE session_id = ? AND logical_tool_call_id = (SELECT logical_call_id FROM workspace_script_occurrences_v1
      WHERE workspace_id = ? AND source_id = ? AND occurrence_id = ?)`).get(occurrence.sessionId, slug, sourceId, occurrence.key.occurrenceId) as
      { state: string; outcome_kind: string | null } | undefined : undefined;
  const crossings = occurrence ? db.prepare(`SELECT state FROM physical_dispatches WHERE session_id = ?
    AND logical_tool_call_id = (SELECT logical_call_id FROM workspace_script_occurrences_v1
      WHERE workspace_id = ? AND source_id = ? AND occurrence_id = ?) ORDER BY ordinal`)
      .all(occurrence.sessionId, slug, sourceId, occurrence.key.occurrenceId) as Array<{ state: string }> : [];
  const running = crossings.some(row => row.state === 'started') || logical?.state === 'open';
  const phase = running ? 'running' as const : crossings.length ? 'held' as const : 'not_started' as const;
  const canClose = !!occurrence && !running && (!logical || logical.state === 'settled');
  const permission = policy.stopped ? 'stopped' as const : grant?.active ? 'active' as const : 'needs_review' as const;
  const view: WorkspaceSourceControlView = { sourceId, runner: source.runner,
    revision: digest({ source, args, unavailable, policy, occurrence, logical: logical ?? null, crossings,
      decision: decision && 'row' in decision ? { id: decision.row.approvalId, state: decision.state } : null,
      grant: grant ? { id: grant.grantId, active: grant.active } : null }), permission,
    detail: running ? (policy.stopped ? 'Stopping this run. Completed effects are not undone.' : 'This source is running.')
      : phase === 'held' ? 'This run has not published its data. Check its effects before closing it; it will not run again automatically.'
      : unavailable ? `Source needs repair: ${unavailable}`
      : policy.stopped ? 'Stopped. Script edits and scheduled ticks cannot restore permission.'
      : decision?.state === 'pending' ? 'Waiting for your permission. Nothing has started.'
      : permission === 'active' ? 'Allowed for manual refreshes and the saved schedule while this source matches.'
      : 'Review this source before allowing it to run.',
    run: occurrence ? { occurrenceId: occurrence.key.occurrenceId, phase, crossings: crossings.length, outcome: logical?.outcome_kind ?? null } : null,
    canStop: !policy.stopped,
    canReview: !!args && (!occurrence || (canClose && crossings.length === 0)),
    canResolve: policy.stopped && canClose && crossings.length > 0,
    ...(decision?.state === 'pending' ? { approvalId: decision.row.approvalId } : {}),
  };
  return { view, occurrence, policy };
}

export function listWorkspaceSourceControls(slug: string): WorkspaceSourceControlView[] {
  return (spaceStore.get(slug)?.dataSources ?? []).filter(source => source.runner && !source.cliArgv?.length && !source.composioSlug?.trim())
    .map(source => inspect(slug, source.id).view);
}

function closeOccurrence(state: ReturnType<typeof inspect>, controlId: string, reason: string, note?: string): void {
  const occurrence = state.occurrence;
  if (!occurrence) return;
  if (occurrence.activationId) {
    const root = readWorkflowV3CallAuthority(occurrence.activationId);
    if (root.status !== 'ok') return fail(409, 'The retained execution authority needs recovery before this run can be closed.');
    if (root.authority.state === 'open') {
      const closed = closeWorkflowV3CallAuthority({ activationId: occurrence.activationId, outcome: 'cancelled' });
      if (closed.status !== 'closed' && closed.status !== 'replayed') return fail(409, 'This run still owns unsettled work. Stop it and wait for its result before closing it.');
    }
  }
  openEventLog().prepare(`UPDATE workspace_script_occurrences_v1 SET resolution_json = ?
    WHERE workspace_id = ? AND source_id = ? AND occurrence_id = ? AND observation_id IS NULL AND resolution_json IS NULL`)
    .run(JSON.stringify({ controlId, reason, note: note ?? null, at: new Date().toISOString(), effectsUndone: false }),
      occurrence.key.slug, occurrence.key.sourceId, occurrence.key.occurrenceId);
}

function cancelOldCards(slug: string, sourceId: string): void {
  const rows = openEventLog().prepare(`SELECT approval_id FROM pending_approvals WHERE session_id = ? AND tool = ?
    AND status = 'pending' AND json_valid(args_json) AND json_extract(args_json, '$.sourceId') = ?`)
    .all(`workspace-script:${slug}`, SAVED_SOURCE_SCRIPT_CONSENT_TOOL, sourceId) as Array<{ approval_id: string }>;
  for (const row of rows) resolve(row.approval_id, 'cancelled_by_system', 'workspace-source-owner-control');
}

export async function controlWorkspaceSource(slug: string, sourceId: string, raw: unknown): Promise<WorkspaceSourceControlResponse> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return fail(400, 'Invalid source control request. Reload the source and try again.');
  const input = parsed.data;
  const db = openEventLog();
  db.transaction(() => {
    const prior = db.prepare('SELECT * FROM workspace_source_control_receipts_v1 WHERE control_id = ?').get(input.controlId) as
      { workspace_id: string; source_id: string; request_json: string } | undefined;
    if (prior) {
      if (prior.workspace_id !== slug || prior.source_id !== sourceId || prior.request_json !== closedCanonicalJson(input)) {
        return fail(409, 'This control request already belongs to a different action.');
      }
      return;
    }
    const state = inspect(slug, sourceId);
    if (state.view.revision !== input.expectedRevision) return fail(409, 'This source changed. Reload its status before deciding.');
    if (input.action === 'stop') stopSavedSource(slug, sourceId, db);
    if (input.action === 'review') {
      if (!state.view.canReview) return fail(409, 'Close the held run after checking its effects before reviewing new permission.');
      closeOccurrence(state, input.controlId, 'superseded_before_dispatch');
      beginSavedSourceReview(slug, sourceId, input.controlId, db);
    }
    if (input.action === 'resolve') {
      if (!state.view.canResolve) return fail(409, 'Stop this source and wait for its execution to settle before closing it.');
      if (!input.reviewedEffects || !input.note) return fail(400, 'Confirm you checked this run’s effects and add a short note.');
      closeOccurrence(state, input.controlId, 'closed_after_owner_review', input.note);
    }
    db.prepare(`INSERT INTO workspace_source_control_receipts_v1
      (control_id, workspace_id, source_id, request_json, resolution_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.controlId, slug, sourceId, closedCanonicalJson(input),
        JSON.stringify({ action: input.action, occurrenceId: state.occurrence?.key.occurrenceId ?? null, effectsUndone: false }), new Date().toISOString());
  }).immediate();
  // Registry resolution publishes committed events: never wrap it inside the
  // control transaction, and never cancel a newer generation on command replay.
  const state = inspect(slug, sourceId);
  if (input.action === 'stop' && state.policy.stopped) cancelOldCards(slug, sourceId);
  if (input.action === 'review') {
    if (state.policy.reviewId !== input.controlId || state.policy.stopped) return fail(409, 'A newer decision superseded this permission review.');
    const rows = db.prepare(`SELECT approval_id FROM pending_approvals WHERE session_id = ? AND tool = ?
      AND status = 'pending' AND json_valid(args_json) AND json_extract(args_json, '$.sourceId') = ?
      AND COALESCE(json_extract(args_json, '$.reviewId'), '') != ?`)
      .all(`workspace-script:${slug}`, SAVED_SOURCE_SCRIPT_CONSENT_TOOL, sourceId, input.controlId) as Array<{ approval_id: string }>;
    for (const row of rows) resolve(row.approval_id, 'cancelled_by_system', 'workspace-source-owner-control');
    const { refreshSpaceData } = await import('./runner.js');
    const results = await refreshSpaceData(slug, sourceId, { cause: 'manual', refreshId: `owner-review:${input.controlId}` });
    const result = results.find(result => result.sourceId === sourceId);
    return { view: inspect(slug, sourceId).view, ...(result?.pendingApprovalId ? { pendingApprovalId: result.pendingApprovalId } : {}) };
  }
  return { view: inspect(slug, sourceId).view };
}
