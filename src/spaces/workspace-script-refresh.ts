/** Production owner for saved-script refreshes. The existing Space queue owns
 * serialization; the occurrence journal/kernel own execution and publication. */
import { createHash, randomUUID } from 'node:crypto';
import { inspectResumableApproval, isExpired, onApprovalResolved, resolve,
  type PendingApprovalRow } from '../runtime/harness/approval-registry.js';
import { registerResumableApprovalCardAtomically } from '../runtime/harness/approval-card.js';
import { findSavedSourceScriptGrant, recordApprovedSavedSourceScriptGrant,
  SAVED_SOURCE_SCRIPT_CONSENT_TOOL, savedSourceScopeResumeKey, savedSourceScriptScope,
  type SavedSourceScriptScope } from '../runtime/harness/saved-source-consent.js';
import { deliverOutcome } from '../runtime/outcome.js';
import { recordOperationalEvent } from '../runtime/operational-telemetry.js';
import { prepareWorkspaceScriptCall } from './workspace-script-authority.js';
import { activateWorkspaceScriptOccurrenceWithGrant, executeWorkspaceScriptOccurrence,
  listUnpublishedWorkspaceScriptOccurrences, readWorkspaceScriptOccurrence,
  reserveWorkspaceScriptOccurrence, type WorkspaceScriptOccurrenceKey,
  type WorkspaceScriptOccurrenceView } from './workspace-script-occurrence.js';
import { historicalRunnerDenial } from './space-data-runner-trust.js';
import { drainWorkspaceScriptReports, recoverPublishedWorkspaceScriptReports } from './workspace-script-reports.js';
import { spaceStore, type SpaceDataSource } from './store.js';
import type { RefreshResult, RunSourceErr } from './runner.js';

export interface SavedScriptRefreshOptions {
  cause?: 'manual' | 'scheduled' | 'creation_smoke' | 'retry';
  refreshId?: string;
  /** Only a recovery caller supplies the retained address. It is not consent. */
  occurrence?: WorkspaceScriptOccurrenceKey;
  signal?: AbortSignal;
}
export type SavedScriptRefreshResult = RunSourceErr | {
  ok: true; observationId: string; changed: boolean | null; write: { ok: true; bytes: number };
};
const held = (error: string, code: RunSourceErr['code'] = 'not_approved'): RunSourceErr => ({ ok: false, error, code });

function scopeFor(view: WorkspaceScriptOccurrenceView): SavedSourceScriptScope {
  return savedSourceScriptScope.parse({ version: 1, workspaceId: view.key.slug, sourceId: view.key.sourceId,
    sourceDigest: view.args.source_digest, scriptSha256: view.args.script_sha256, runner: view.source.runner,
    schedule: { cron: view.source.schedule?.trim() || null,
      timeZone: view.source.timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone },
    occurrences: 'manual_and_saved_schedule', access: 'local_user_credentials_network_and_live_dependencies',
    validity: 'while_saved_source_and_script_match_unless_revoked' });
}

/** Called inside refreshSpaceData's existing queue. Success already owns an
 * observation: the outer refresh must not transform or publish it a second time. */
export async function refreshWorkspaceScriptSource(
  slug: string, source: SpaceDataSource, opts: SavedScriptRefreshOptions = {},
): Promise<SavedScriptRefreshResult> {
  try {
    if (opts.occurrence && (opts.occurrence.slug !== slug || opts.occurrence.sourceId !== source.id)) {
      return held('Saved script recovery address does not match this source.', 'definition');
    }
    const requested: WorkspaceScriptOccurrenceKey = opts.occurrence ?? { slug, sourceId: source.id,
      occurrenceId: opts.refreshId
        ? `refresh:${createHash('sha256').update(opts.refreshId).digest('hex')}` : randomUUID() };
    let view = readWorkspaceScriptOccurrence(requested);
    if (opts.occurrence && !view) return held('Saved script recovery occurrence is missing.', 'definition');
    if (view && !opts.occurrence && opts.cause !== 'retry'
      && view.args.cause !== (opts.cause === 'scheduled' ? 'scheduled' : 'manual')) {
      return held('The same refresh identity cannot change its refresh cause.', 'definition');
    }
    if (!view) {
      const unfinished = listUnpublishedWorkspaceScriptOccurrences(slug, source.id)[0];
      if (unfinished) view = readWorkspaceScriptOccurrence(unfinished);
    }
    if (!view) {
      if (opts.cause === 'retry') {
        return held('No saved refresh is available to retry. Request a new refresh to start another run.', 'definition');
      }
      if (opts.cause === 'scheduled' && !source.schedule?.trim()) {
        return held('This source has no saved schedule to approve for a scheduled refresh.', 'definition');
      }
      const reserved = reserveWorkspaceScriptOccurrence({ ...requested,
        cause: opts.cause === 'scheduled' ? 'scheduled' : 'manual' });
      if (reserved.status === 'blocked') return held(reserved.reason);
      view = readWorkspaceScriptOccurrence(reserved.key);
    }
    if (!view) return held('Saved script occurrence could not be retained.', 'definition');

    if (!view.activationId) {
      // Do not show an executable approval for stale/invalid source bytes.
      // Armed recovery intentionally does not re-prepare: the process may have
      // completed before a file edit or deletion, with its result retained.
      prepareWorkspaceScriptCall(view.args);
      const scope = scopeFor(view);
      const resumeKey = savedSourceScopeResumeKey(scope);
      const decision = inspectResumableApproval(resumeKey);
      let grant = findSavedSourceScriptGrant(scope);
      if (decision.state === 'approved' || decision.state === 'consumed') {
        grant = recordApprovedSavedSourceScriptGrant(decision.row.approvalId);
      } else if (decision.state === 'rejected' || decision.state === 'cancelled') {
        return held(`Approval ${decision.row.approvalId} was ${decision.row.resolution}. This source remains stopped; refresh does not override that decision.`);
      }
      if (grant && !grant.active) return held('Permission for this saved source was revoked. Refresh does not restore it.');
      if (!grant) {
        const priorNo = historicalRunnerDenial(slug, source);
        if (priorNo) return held(`Earlier approval ${priorNo.approvalId} was declined. The new executor preserves that decision; this source has not run.`);
        if (decision.state === 'expired') {
          if (opts.cause !== undefined && opts.cause !== 'manual') return held(`Approval ${decision.row.approvalId} expired. Open this Workspace and request a refresh to review it again.`);
          if (decision.row.status === 'pending' && isExpired(decision.row)) resolve(decision.row.approvalId, 'expired', 'workspace-script:expiry');
        }
        const schedule = scope.schedule.cron
          ? `manually and on its saved schedule (${scope.schedule.cron}, ${scope.schedule.timeZone})`
          : 'when you request a refresh';
        const { row } = registerResumableApprovalCardAtomically({ sessionId: view.sessionId,
          tool: SAVED_SOURCE_SCRIPT_CONSENT_TOOL, args: scope, resumeKey,
          subject: `Allow “${spaceStore.get(slug)?.title ?? slug}” to refresh “${source.id}” using data/${scope.runner} ${schedule}? This script can use your local credentials, network and live dependencies. Permission lasts until the script or source changes, or you revoke it.` });
        return { ...held(`Review approval ${row.approvalId} to run this saved source. Nothing has executed.`), pendingApprovalId: row.approvalId };
      }
      activateWorkspaceScriptOccurrenceWithGrant(view.key, grant.grantId);
    }
    const result = await executeWorkspaceScriptOccurrence(view.key, opts.signal);
    if (result.status === 'held') return held(`This saved refresh is held: ${result.reason} Later ticks will not start a replacement.`, 'script_held');
    // Delivery failure cannot change a proven publication into a failed run.
    try { drainWorkspaceScriptReports(); } catch { /* durable boot/timer retry */ }
    return { ok: true, observationId: result.observationId, changed: result.changed,
      write: { ok: true, bytes: result.bytes } };
  } catch (error) {
    return held(`Saved source could not refresh: ${error instanceof Error ? error.message : String(error)}`, 'script_held');
  }
}

type RecoveryHandler = (key: WorkspaceScriptOccurrenceKey) => Promise<RefreshResult[]>;
let recoveryHandler: RecoveryHandler | null = null;
const recovering = new Map<string, Promise<RefreshResult[]>>();

/** Registration never opens the event log. Boot owns recovery after migration. */
export function registerSavedScriptRefreshHandler(handler: RecoveryHandler): void { recoveryHandler = handler; }

function resume(key: WorkspaceScriptOccurrenceKey): Promise<RefreshResult[]> {
  const id = JSON.stringify([key.slug, key.sourceId, key.occurrenceId]);
  const existing = recovering.get(id);
  if (existing) return existing;
  if (!recoveryHandler) return Promise.resolve([]);
  const handler = recoveryHandler;
  const work = Promise.resolve().then(() => handler(key)).then(results => {
    const view = readWorkspaceScriptOccurrence(key);
    const result = results.find(result => result.sourceId === key.sourceId);
    if (view && result && !result.ok) deliverOutcome({ status: 'needs_input',
      summary: `“${spaceStore.get(key.slug)?.title ?? key.slug}” has not refreshed ${key.sourceId}. ${result.error ?? 'Review its source status.'}`,
      evidence: { work: [{ label: `Refresh ${key.sourceId}`, completed: 0, total: 1 }] },
    }, { originSessionId: view.sessionId, sourceLabel: 'workspace script refresh', sourceId: id,
      title: spaceStore.get(key.slug)?.title ?? key.slug, proactiveTurn: true });
    return results;
  }).finally(() => { recovering.delete(id); });
  recovering.set(id, work);
  return work;
}

function reportRecoveryError(key: WorkspaceScriptOccurrenceKey, error: unknown): void {
  recordOperationalEvent({ source: 'workspace', type: 'workspace_data_refresh_failed', severity: 'error',
    workspaceId: key.slug, actor: 'space-runner', payload: { sourceId: key.sourceId,
      occurrenceId: key.occurrenceId, error: error instanceof Error ? error.message : String(error) } });
}

function onDecision(row: PendingApprovalRow): void {
  if (row.tool !== SAVED_SOURCE_SCRIPT_CONSENT_TOOL || !row.resolution || !recoveryHandler) return;
  const scope = savedSourceScriptScope.safeParse(row.args);
  if (!scope.success || row.sessionId !== `workspace-script:${scope.data.workspaceId}`) return;
  const key = listUnpublishedWorkspaceScriptOccurrences(scope.data.workspaceId, scope.data.sourceId)[0];
  if (!key) return;
  const view = readWorkspaceScriptOccurrence(key);
  if (!view || savedSourceScopeResumeKey(scopeFor(view)) !== row.resumeKey) return;
  void resume(key).catch(error => reportRecoveryError(key, error));
}
onApprovalResolved(onDecision);

/** Recover approved-but-not-armed and armed-but-not-published gaps, without
 * consuming a new card, inventing a tick, or starting a chat/model turn. */
export async function recoverSavedScriptRefreshes(): Promise<number> {
  recoverPublishedWorkspaceScriptReports();
  drainWorkspaceScriptReports();
  if (!recoveryHandler) return 0;
  const work: Promise<unknown>[] = [];
  for (const key of listUnpublishedWorkspaceScriptOccurrences()) {
    const view = readWorkspaceScriptOccurrence(key);
    if (!view) continue;
    const scope = scopeFor(view);
    const decision = inspectResumableApproval(savedSourceScopeResumeKey(scope));
    const grant = findSavedSourceScriptGrant(scope);
    if (!view.activationId && decision.state !== 'approved' && decision.state !== 'consumed' && !grant?.active) continue;
    work.push(resume(key).catch(error => reportRecoveryError(key, error)));
  }
  await Promise.all(work);
  return work.length;
}
