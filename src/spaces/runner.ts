/**
 * Workspace data-source executor. Composio declarations may execute only by
 * redeeming the shared durable call kernel; local runner and CLI declarations
 * remain zero-process until they are compiled into that same kernel. Legacy
 * trust decisions are retained as migration metadata, never call authority.
 *
 * Used by the on-demand /refresh route and (later) the scheduled daily poll —
 * one execution path for both. Fail-safe: a source error is captured into
 * data.json under _meta so the view can show "couldn't refresh" without the
 * whole Workspace breaking.
 */
import { createHash, randomUUID } from 'node:crypto';
import { runnerFilenameError, spaceStore, type SpaceDataSource, type SpaceAction } from './store.js';
import { appendAudit, type WriteDataResult, type WriteDataError } from './data-store.js';
import {
  bootstrapWorkspaceObservationHistory,
  commitWorkspaceObservationBatch,
  getWorkspaceDatasetObservationByRefreshId,
  healWorkspaceDataProjection,
  indexWorkspaceRecord,
  type CommitWorkspaceObservationBatchResult,
  type WorkspaceObservationCommitItem,
} from './workspace-db.js';
import { finalizeWorkspaceObservationCommit } from './workspace-observation-finalize.js';
import { recordOperationalEvent } from '../runtime/operational-telemetry.js';
import {
  workspaceActionRequiresApproval,
  workspaceDataSourceSafetyError,
} from './space-execution-policy.js';
import { verifySpaceActionApprovalAuthority } from './space-action-authority.js';
import {
  authorizeCliDataSource,
  authorizeInstalledDataRunner,
  registerRunnerTrustRefreshHandler,
} from './space-data-runner-trust.js';
import { acquireSpaceReadAuthority } from './space-read-authority.js';

export interface RunSourceOk { ok: true; data: unknown }
export interface RunSourceErr {
  ok: false;
  error: string;
  /** Nominal executor proof; never inferred from runner-controlled output. */
  provenNoDispatch?: true;
  /** Exact legacy migration decision; never shared-kernel call authority. */
  pendingApprovalId?: string;
}
export type RunSourceResult = RunSourceOk | RunSourceErr;

/** Legacy wrapper namespace retained only to recognize historical diagnostic
 * rows. It is not a Space execution or replay authority. */
export const SPACE_ACTION_MUTATION_WORKFLOW_SLUG = '__clementine-space-actions';

export interface SpaceActionRunOptions {
  /** Present only after the canonical approval registry resolved this action. */
  approvalId?: string;
  /**
   * Compatibility input retained for standing-decision callers. It cannot mint
   * a shared-kernel activation or unlock local process execution.
   */
  executionNonce?: string;
  /**
   * Exact authority already armed by Clementine's shared durable call kernel.
   * Dashboard, tool, scheduler, and recovery callers intentionally do not
   * synthesize this value. Until their Space declaration is compiled into the
   * shared workflow authority graph, Composio-backed actions fail closed.
   */
  composioAuthority?: SpaceSharedDurableComposioAuthority;
}

/**
 * Opaque address of an authority root owned by the existing durable workflow
 * call kernel. This object carries no provider callback and grants nothing by
 * itself: the selected kernel reopens the activation, validates the exact
 * invocation-plan digest and canonical arguments, claims physical I/O, and
 * settles/replays the result. A forged or stale address is therefore a
 * zero-body refusal.
 */
export interface SpaceSharedDurableComposioAuthority {
  version: 1;
  kernel: 'workflow_v1_read_only' | 'workflow_v3_call';
  activationId: string;
  invocationPlan: unknown;
}

export interface SpaceDataSourceRunOptions {
  composioAuthority?: SpaceSharedDurableComposioAuthority;
}

type RetiredSpaceComposioDispatchCanary = (
  toolSlug: string,
  args: Record<string, unknown>,
  opts: {
    dispatchBoundary?: (
      resolved: Record<string, unknown>,
      dispatch: () => Promise<unknown>,
    ) => Promise<unknown>;
  },
) => Promise<unknown>;

/**
 * Compatibility-only zero-body canary. Space execution no longer owns a raw
 * Composio gateway seam, so installing this callback cannot authorize or
 * trigger a provider call. It remains temporarily exported so containment
 * tests (and older fixtures) can prove the retired body was not reached.
 */
export function _setSpaceComposioDispatchForTests(
  dispatch: RetiredSpaceComposioDispatchCanary | null,
): void {
  void dispatch;
}

/** Recovery probe that never crosses a provider/script boundary. Historical
 * Space mutation rows are diagnostics only: the retired wrapper did not own an
 * accepted logical call or the shared kernel's physical-I/O claim. */
export function replaySpaceActionMutation(
  slug: string,
  action: SpaceAction,
  approvalId: string,
): { replayed: false } | { replayed: true; result: RunSourceResult } {
  void slug;
  void action;
  void approvalId;
  return { replayed: false };
}

/**
 * Compatibility entrypoint retained for callers that still compile against
 * the old Space runner API. A pinned file hash or a human trust decision is not
 * shared-kernel logical/physical authority, so this boundary is intentionally
 * zero-body until Space declarations are compiled into that existing kernel.
 */
export async function runScript(
  slug: string,
  runner: string,
  extra?: Record<string, unknown>,
  opts: { expectedSha256?: string } = {},
): Promise<RunSourceResult> {
  const runnerError = runnerFilenameError(runner);
  if (runnerError) return { ok: false, error: runnerError, provenNoDispatch: true };
  void extra;
  void opts;
  return {
    ok: false,
    error: `Workspace "${slug}" local runner "${runner}" is unavailable: no shared durable call authority was supplied. The process was not started.`,
    provenNoDispatch: true,
  };
}

/**
 * Retired raw CLI boundary. The exact argv trust record remains useful
 * declaration/migration metadata, but cannot mint shared-kernel authority.
 */
async function runCliSource(slug: string, cliArgv: string[]): Promise<RunSourceResult> {
  const commandLabel = cliArgv.join(' ');
  return {
    ok: false,
    error: `Workspace "${slug}" local CLI "${commandLabel}" is unavailable: no shared durable call authority was supplied. The process was not started.`,
    provenNoDispatch: true,
  };
}

/**
 * Space Composio execution may only redeem an authority root owned by the
 * shared durable workflow kernel. Space routes do not fall back to the raw
 * gateway and do not wrap that gateway in the legacy workflow-mutation receipt
 * helper: neither path carries accepted-source lineage or physical authority.
 */
async function runSpaceComposio(
  slug: string,
  toolSlug: string,
  args: Record<string, unknown>,
  authority: SpaceSharedDurableComposioAuthority | undefined,
  requiredEffect: 'read' | 'action',
): Promise<RunSourceResult> {
  const carrierLabel = `Workspace "${slug}" ${requiredEffect === 'read' ? 'refresh' : 'action'} "${toolSlug}"`;
  if (!authority) {
    return {
      ok: false,
      error: `${carrierLabel} is unavailable: no shared durable call authority was supplied. The provider call was not started.`,
      provenNoDispatch: true,
    };
  }
  if (
    authority.version !== 1
    || typeof authority.activationId !== 'string'
    || !authority.activationId.trim()
    || (authority.kernel !== 'workflow_v1_read_only' && authority.kernel !== 'workflow_v3_call')
  ) {
    return {
      ok: false,
      error: `${carrierLabel} was refused: the shared durable call authority address is malformed. The provider call was not started.`,
      provenNoDispatch: true,
    };
  }

  const { parseWorkflowNodeInvocationPlan } = await import('../memory/workflow-node-invocation-plan.js');
  const parsed = parseWorkflowNodeInvocationPlan(authority.invocationPlan);
  if (
    !parsed.ok
    || parsed.plan.binding.operationId !== toolSlug
    || (requiredEffect === 'read' && parsed.plan.binding.effect !== 'read')
    || (authority.kernel === 'workflow_v1_read_only' && parsed.plan.binding.effect !== 'read')
    || (authority.kernel === 'workflow_v3_call'
      && !['local_write', 'external_write', 'admin'].includes(parsed.plan.binding.effect))
  ) {
    return {
      ok: false,
      error: `${carrierLabel} was refused: the shared authority does not bind this exact declared operation and effect. The provider call was not started.`,
      provenNoDispatch: true,
    };
  }

  const {
    executeWorkflowReadOnlyCall,
    executeWorkflowV3Call,
  } = await import('../runtime/harness/workflow-read-only-call-kernel.js');
  const outcome = authority.kernel === 'workflow_v1_read_only'
    ? await executeWorkflowReadOnlyCall({
      activationId: authority.activationId,
      invocationPlan: authority.invocationPlan,
      args,
    })
    : await executeWorkflowV3Call({
      activationId: authority.activationId,
      invocationPlan: authority.invocationPlan,
      args,
    });
  if (outcome.status === 'completed' || outcome.status === 'replayed') {
    return { ok: true, data: outcome.result };
  }
  return {
    ok: false,
    error: `${carrierLabel} was ${outcome.status} by the shared durable call kernel: ${outcome.reason}`,
    ...(outcome.zeroBody ? { provenNoDispatch: true as const } : {}),
  };
}

/** Run a single declared data source (no persistence). */
export async function runSpaceDataSource(
  slug: string,
  source: SpaceDataSource,
  opts: SpaceDataSourceRunOptions = {},
): Promise<RunSourceResult> {
  if (source.runner?.trim()) {
    const trust = authorizeInstalledDataRunner(slug, source);
    if (trust.state !== 'approved') {
      return {
        ok: false,
        error: trust.error,
        provenNoDispatch: true,
        ...(trust.state === 'pending' ? { pendingApprovalId: trust.approvalId } : {}),
      };
    }
    return runScript(
      slug,
      source.runner.trim(),
      undefined,
      { expectedSha256: trust.runnerSha256 },
    );
  }
  if (source.cliArgv?.length) {
    const trust = authorizeCliDataSource(slug, source);
    if (trust.state !== 'approved') {
      return {
        ok: false,
        error: trust.error,
        provenNoDispatch: true,
        ...(trust.state === 'pending' ? { pendingApprovalId: trust.approvalId } : {}),
      };
    }
    return runCliSource(slug, trust.cliArgv);
  }
  const safetyError = workspaceDataSourceSafetyError(source);
  if (safetyError) return { ok: false, error: safetyError, provenNoDispatch: true };
  if (source.composioSlug && source.composioSlug.trim()) {
    try {
      return await runSpaceComposio(
        slug,
        source.composioSlug.trim(),
        source.composioArgs ?? {},
        opts.composioAuthority,
        'read',
      );
    } catch (err) {
      return { ok: false, error: `composio call failed: ${(err as Error).message}` };
    }
  }
  return { ok: false, error: `data source "${source.id}" declares no execution mode (runner, cli_argv, or composio_slug)` };
}

/** Execute one declared action with caller-supplied args merged over its template. */
export async function runSpaceAction(
  slug: string,
  action: SpaceAction,
  callerArgs: Record<string, unknown>,
  opts: SpaceActionRunOptions = {},
): Promise<RunSourceResult> {
  const args = { ...(action.argsTemplate ?? {}), ...(callerArgs ?? {}) };
  const requestedApprovalId = opts.approvalId?.trim() ?? '';
  const requiresApproval = workspaceActionRequiresApproval(action);
  const authority = requestedApprovalId
    ? verifySpaceActionApprovalAuthority({
      approvalId: requestedApprovalId,
      slug,
      action,
      callerArgs,
    })
    : { ok: false, error: 'approval id is missing' };
  if (requiresApproval && !authority.ok) {
    return {
      ok: false,
      error: `action "${action.id}" requires exact human approval before execution (${authority.error ?? 'authority check failed'}); invoke it through the Workspace action approval path.`,
      provenNoDispatch: true,
    };
  }
  if (action.composioSlug && action.composioSlug.trim()) {
    try {
      return await runSpaceComposio(
        slug,
        action.composioSlug.trim(),
        args,
        opts.composioAuthority,
        'action',
      );
    } catch (err) {
      return { ok: false, error: `action failed: ${(err as Error).message}` };
    }
  }
  if (action.runner && action.runner.trim()) {
    return {
      ok: false,
      error: `Workspace "${slug}" action "${action.id}" is unavailable: local runner execution has no shared durable call authority. The process was not started.`,
      provenNoDispatch: true,
    };
  }
  return { ok: false, error: `action "${action.id}" declares neither a runner nor a composio_slug` };
}

export interface RefreshResult {
  ok: boolean;
  sourceId: string;
  error?: string;
  pendingApprovalId?: string;
  write?: WriteDataResult | WriteDataError;
  observationId?: string;
  changed?: boolean | null;
}

const refreshQueues = new Map<string, Promise<void>>();

function enqueueSpaceRefresh<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const previous = refreshQueues.get(slug) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const tail = run.then(() => undefined, () => undefined);
  refreshQueues.set(slug, tail);
  tail.finally(() => {
    if (refreshQueues.get(slug) === tail) refreshQueues.delete(slug);
  }).catch(() => undefined);
  return run;
}

/** Test-only: clear pending queue metadata after a fixture run. */
export function _resetSpaceRefreshQueuesForTest(): void {
  refreshQueues.clear();
}

/**
 * Refresh one data source (or the first, if sourceId omitted) and persist into
 * data.json under the source id, with a _meta entry. Returns per-source status.
 */
export interface RefreshSpaceOptions {
  /** Paused-build auto-retry: probe the sources of a PAUSED workspace (the
   *  status gate otherwise makes a retry impossible). Archived stays blocked. */
  allowPaused?: boolean;
  /** Why this refresh ran. Kept deliberately small and descriptive; it is
   * provenance, not control flow. */
  cause?: 'manual' | 'scheduled' | 'creation_smoke' | 'retry';
  /** Stable caller-owned idempotency key. Scheduled/retry callers use this to
   * converge after a daemon restart; manual calls may omit it. */
  refreshId?: string;
  /** Optional durable batch identity for diagnostics. */
  batchId?: string;
  /**
   * Exact shared-kernel authority per declared source. Ordinary dashboard,
   * scheduler, creation-smoke, and retry callers provide no entries and thus
   * cannot reach Composio until a production compiler/activation adapter is
   * wired. Local runner and CLI declarations remain zero-body as well; their
   * legacy trust records are not shared-kernel authority.
   */
  composioAuthorityBySourceId?: Readonly<Record<string, SpaceSharedDurableComposioAuthority>>;
}

export async function refreshSpaceData(slug: string, sourceId?: string, opts: RefreshSpaceOptions = {}): Promise<RefreshResult[]> {
  return enqueueSpaceRefresh(slug, () => refreshSpaceDataLocked(slug, sourceId, opts));
}

registerRunnerTrustRefreshHandler(async ({ spaceSlug, sourceId, approvalId }) => (
  refreshSpaceData(spaceSlug, sourceId, {
    cause: 'manual',
    refreshId: `runner-trust:${approvalId}`,
    batchId: `runner-trust:${approvalId}`,
  })
));

async function refreshSpaceDataLocked(slug: string, sourceId?: string, opts: RefreshSpaceOptions = {}): Promise<RefreshResult[]> {
  const rec = spaceStore.get(slug);
  if (!rec) return [{ ok: false, sourceId: sourceId ?? '(none)', error: `no workspace "${slug}"` }];
  if (rec.manifestErrors && rec.manifestErrors.length > 0) {
    return [{
      ok: false,
      sourceId: sourceId ?? '(manifest)',
      error: `workspace manifest is invalid; fix with space_save before refreshing: ${rec.manifestErrors.join('; ')}`,
    }];
  }
  if (rec.status === 'archived' || (rec.status === 'paused' && !opts.allowPaused)) {
    return [{ ok: false, sourceId: sourceId ?? '(none)', error: `workspace is ${rec.status}` }];
  }
  const sources = sourceId
    ? rec.dataSources.filter((s) => s.id === sourceId)
    : rec.dataSources;
  if (sources.length === 0) {
    return [{ ok: false, sourceId: sourceId ?? '(none)', error: 'no matching data source' }];
  }

  // Existing file-backed Workspaces may predate the temporal index. Preserve
  // their current data as the comparison baseline before the first 3.0 pull.
  indexWorkspaceRecord(rec, {
    emitOperational: false,
    appendStateEvent: false,
  });
  const baseline = bootstrapWorkspaceObservationHistory(slug);
  if (!baseline.ok) {
    return sources.map((source) => ({
      ok: false,
      sourceId: source.id,
      error: `workspace history baseline could not be preserved; refresh was not run: ${baseline.error}`,
      write: { ok: false, error: baseline.error, bytes: 0 },
    }));
  }

  const results: RefreshResult[] = [];
  const observations: WorkspaceObservationCommitItem[] = [];
  const cause = opts.cause ?? 'manual';
  const batchId = opts.batchId ?? randomUUID();

  // Phase A observability: the workspace data-refresh lifecycle on the operator view.
  recordOperationalEvent({ source: 'workspace', type: 'workspace_data_refresh_started', workspaceId: slug, actor: 'space-runner', payload: { sourceCount: sources.length, sourceId } });
  for (const source of sources) {
    const authorityMap = opts.composioAuthorityBySourceId;
    let composioAuthority = authorityMap && Object.prototype.hasOwnProperty.call(authorityMap, source.id)
      ? authorityMap[source.id]
      : undefined;
    // A declared Composio data source is a READ, and reads redeem the shared
    // durable workflow_v1_read_only kernel. Mint that authority here so every
    // caller of refreshSpaceData (dashboard route, scheduler, creation smoke,
    // Ask Clem) supplies the root the gate demands. A caller-provided
    // authority always wins; a mint refusal leaves the gate's zero-body
    // refusal in place and is surfaced beside it below.
    let mintRefusal: string | undefined;
    if (
      !composioAuthority
      && source.composioSlug?.trim()
      && !source.runner?.trim()
      && !source.cliArgv?.length
      && !workspaceDataSourceSafetyError(source)
    ) {
      const minted = acquireSpaceReadAuthority({
        slug,
        sourceId: source.id,
        toolSlug: source.composioSlug.trim(),
        args: source.composioArgs ?? {},
        cause,
      });
      if (minted.ok) composioAuthority = minted.authority;
      else mintRefusal = minted.error;
    }
    const run = await runSpaceDataSource(slug, source, { composioAuthority });
    if (!run.ok && mintRefusal) {
      run.error = `${run.error} Durable read authority could not be minted: ${mintRefusal}`;
    }
    const observedAt = new Date().toISOString();
    // Repeated clicks while the same trust card is pending are one observation,
    // not new facts. The approval id is already exact to workspace + source +
    // runner hash + schedule and therefore makes the correct durable key.
    const refreshId = run.ok
      ? (opts.refreshId ?? randomUUID())
      : (run.pendingApprovalId ? `runner-trust-pending:${run.pendingApprovalId}` : (opts.refreshId ?? randomUUID()));
    const provenance: Record<string, unknown> = source.composioSlug
      ? {
        provider: 'composio',
        adapter: 'composio',
        toolSlug: source.composioSlug,
        argsHash: createHash('sha256')
          .update(JSON.stringify(source.composioArgs ?? {}))
          .digest('hex'),
        ...(source.schedule ? { schedule: source.schedule } : {}),
      }
      : {
        adapter: 'legacy_runner',
        ...(source.runner ? { runner: source.runner } : {}),
        ...(source.schedule ? { schedule: source.schedule } : {}),
      };
    if (run.ok) {
      results.push({ ok: true, sourceId: source.id });
      observations.push({
        sourceKey: source.id,
        refreshId,
        cause,
        status: 'ok',
        data: run.data,
        observedAt,
        provenance,
      });
    } else {
      results.push({
        ok: false,
        sourceId: source.id,
        error: run.error,
        ...(run.pendingApprovalId ? { pendingApprovalId: run.pendingApprovalId } : {}),
      });
      observations.push({
        sourceKey: source.id,
        refreshId,
        cause,
        status: run.pendingApprovalId ? 'awaiting_approval' : 'error',
        error: run.error,
        observedAt,
        provenance: run.pendingApprovalId
          ? { ...provenance, approvalId: run.pendingApprovalId }
          : provenance,
      });
    }
  }

  // Persist each source independently. One malformed/oversized provider result
  // must not roll back valid observations from the same refresh fan-out.
  // batchId still correlates the independent commits for diagnostics.
  for (const [index, observation] of observations.entries()) {
    const result = results[index]!;
    let committed: CommitWorkspaceObservationBatchResult | null = null;
    let persistenceError = '';
    try {
      committed = commitWorkspaceObservationBatch({
        workspaceId: slug,
        batchId,
        observations: [observation],
      });
    } catch (error) {
      persistenceError = error instanceof Error ? error.message : String(error);
      const durable = getWorkspaceDatasetObservationByRefreshId(
        slug,
        observation.sourceKey,
        observation.refreshId,
      );
      if (durable) {
        // SQLite commits before data.json. A crash or idempotent retry can
        // therefore find the exact durable receipt even when projection failed
        // (or the provider returned different bytes on a retry). The receipt
        // wins: heal from it and never relabel/reinsert this refresh identity.
        try {
          committed = {
            batchId: durable.batchId,
            observations: [{ ...durable, deduped: true }],
            projection: healWorkspaceDataProjection(slug),
          };
        } catch (healError) {
          persistenceError = healError instanceof Error
            ? healError.message
            : String(healError);
        }
      } else {
        // The successful payload itself was rejected before commit (for
        // example, a size bound). Preserve a small, truthful error observation
        // under the same refresh id so history explains the gap while prior
        // current data remains intact.
        const error = `source result was not persisted: ${persistenceError}`.slice(0, 2_000);
        const { data: _discardedData, ...failureObservation } = observation;
        try {
          committed = commitWorkspaceObservationBatch({
            workspaceId: slug,
            batchId,
            observations: [{
              ...failureObservation,
              status: 'error',
              error,
            }],
          });
        } catch (fallbackError) {
          persistenceError = fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError);
        }
      }
    }

    if (!committed) {
      const write: WriteDataError = {
        ok: false,
        error: `workspace observation was not persisted: ${persistenceError}`.slice(0, 2_000),
        bytes: 0,
      };
      result.ok = false;
      result.error = result.error ? `${result.error}; ${write.error}` : write.error;
      result.write = write;
      appendAudit(slug, {
        method: 'REFRESH',
        path: `/refresh/${result.sourceId}`,
        outcome: 'error',
        note: result.error,
      });
      continue;
    }

    const saved = committed.observations[0]!;
    const write: WriteDataResult = { ok: true, bytes: committed.projection.bytes };
    result.write = write;
    result.observationId = saved.id;
    result.changed = saved.changed;
    delete result.pendingApprovalId;
    if (saved.status === 'ok') {
      result.ok = true;
      delete result.error;
    } else {
      result.ok = false;
      result.error = saved.error ?? 'workspace source did not produce a successful observation';
      if (
        saved.status === 'awaiting_approval'
        && typeof saved.provenance.approvalId === 'string'
      ) {
        result.pendingApprovalId = saved.provenance.approvalId;
      }
    }
    appendAudit(slug, {
      method: 'REFRESH',
      path: `/refresh/${result.sourceId}`,
      outcome: result.ok ? 'ok' : result.pendingApprovalId ? 'rejected' : 'error',
      note: result.ok ? undefined : result.error,
    });
    await finalizeWorkspaceObservationCommit(slug, committed);
  }

  const okCount = results.filter((r) => r.ok).length;
  if (okCount > 0) spaceStore.update(slug, { lastRefreshedAt: new Date().toISOString() });
  const pendingCount = results.filter((result) => !result.ok && result.pendingApprovalId).length;
  const failedCount = results.length - okCount - pendingCount;
  recordOperationalEvent({
    source: 'workspace',
    type: failedCount > 0
      ? 'workspace_data_refresh_failed'
      : pendingCount > 0
        ? 'workspace_data_refresh_awaiting_approval'
        : 'workspace_data_refresh_completed',
    severity: failedCount > 0 ? 'error' : pendingCount > 0 ? 'warn' : 'info',
    workspaceId: slug,
    actor: 'space-runner',
    payload: {
      okCount,
      pendingCount,
      failedCount,
      total: results.length,
      writeOk: results.every((result) => result.write?.ok === true),
    },
  });
  return results;
}
