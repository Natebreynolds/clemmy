/**
 * Workspace data-source executor — runs a PROVABLY READ-ONLY declared Composio
 * source server-side with no LLM (the token-saving core), then persists the
 * result into data.json. Installed legacy runner declarations take a one-time,
 * time-bounded human migration decision bound to their pinned entrypoint hash
 * and schedule; new/unapproved/drifted entrypoints fail closed before spawn.
 *
 * Used by the on-demand /refresh route and (later) the scheduled daily poll —
 * one execution path for both. Fail-safe: a source error is captured into
 * data.json under _meta so the view can show "couldn't refresh" without the
 * whole Workspace breaking.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { resolveInSpace, runnerFilenameError, spaceStore, type SpaceDataSource, type SpaceAction } from './store.js';
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
import { augmentPath } from '../runtime/spawn-env.js';
import { recordOperationalEvent } from '../runtime/operational-telemetry.js';
import {
  interpreterFor, scrubbedChildEnv, electronNodeEnv, spawnSandboxedScript,
} from '../runtime/sandboxed-script.js';
import {
  executeWorkflowCallMutation,
  replayWorkflowCallMutationSlot,
  type WorkflowCallMutationSlotInput,
} from '../execution/workflow-call-receipts.js';
import {
  workspaceActionRequiresApproval,
  workspaceDataSourceSafetyError,
} from './space-execution-policy.js';
import { verifySpaceActionApprovalAuthority } from './space-action-authority.js';
import {
  authorizeInstalledDataRunner,
  registerRunnerTrustRefreshHandler,
} from './space-data-runner-trust.js';

// Tunable so a heavy data pull can be given more room without a code change.
const RUNNER_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.SPACE_RUNNER_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
})();
// Hard cap on captured stdout so a runaway runner can't OOM the daemon.
const RUNNER_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface RunSourceOk { ok: true; data: unknown }
export interface RunSourceErr {
  ok: false;
  error: string;
  /** Nominal executor proof; never inferred from runner-controlled output. */
  provenNoDispatch?: true;
  /** Exact human decision that can unlock a legacy compatibility refresh. */
  pendingApprovalId?: string;
}
export type RunSourceResult = RunSourceOk | RunSourceErr;

/** Reuse the structured-workflow mutation ledger for approved Workspace
 * actions. Approval ids are globally unique, and itemKey keeps equal action ids
 * in different Workspaces in distinct durable slots. */
export const SPACE_ACTION_MUTATION_WORKFLOW_SLUG = '__clementine-space-actions';

export interface SpaceActionRunOptions {
  /** Present only after the canonical approval registry resolved this action. */
  approvalId?: string;
}

type SpaceComposioDispatch = typeof import('../tools/composio-tools.js').dispatchComposioTool;
let spaceComposioDispatchForTest: SpaceComposioDispatch | null = null;
type RunnerEntrypointSnapshotHook = (snapshot: {
  sourcePath: string;
  snapshotPath: string;
}) => void;
let runnerEntrypointSnapshotHookForTest: RunnerEntrypointSnapshotHook | null = null;

/** Focused-test seam at the already-resolved Composio gateway boundary. */
export function _setSpaceComposioDispatchForTests(
  dispatch: SpaceComposioDispatch | null,
): void {
  spaceComposioDispatchForTest = dispatch;
}

/** Focused race-test seam after approved bytes are frozen but before spawn. */
export function _setRunnerEntrypointSnapshotHookForTests(
  hook: RunnerEntrypointSnapshotHook | null,
): void {
  runnerEntrypointSnapshotHookForTest = hook;
}

function spaceActionMutationSlot(
  slug: string,
  actionId: string,
  approvalId: string,
): WorkflowCallMutationSlotInput {
  return {
    workflowSlug: SPACE_ACTION_MUTATION_WORKFLOW_SLUG,
    runId: approvalId,
    stepId: actionId,
    itemKey: slug,
  };
}

function replayedRunnerResult(value: unknown): RunSourceResult {
  if (
    value
    && typeof value === 'object'
    && (value as { ok?: unknown }).ok === true
    && 'data' in value
  ) {
    return value as RunSourceOk;
  }
  return {
    ok: false,
    error: 'The durable Workspace action receipt was unreadable; the action was NOT dispatched again.',
  };
}

/** Recovery probe that never crosses a provider/script boundary. A committed
 * result must remain replayable even if the Workspace was edited or archived
 * after dispatch but before its UI outcome was projected. */
export function replaySpaceActionMutation(
  slug: string,
  action: SpaceAction,
  approvalId: string,
): { replayed: false } | { replayed: true; result: RunSourceResult } {
  const replay = replayWorkflowCallMutationSlot(
    spaceActionMutationSlot(slug, action.id, approvalId),
  );
  if (!replay.replayed) return replay;
  return {
    replayed: true,
    result: action.composioSlug
      ? { ok: true, data: replay.result }
      : replayedRunnerResult(replay.result),
  };
}

type PreparedRunnerEntrypoint =
  | {
    ok: true;
    executionPath: string;
    cleanup: () => void;
  }
  | {
    ok: false;
    error: string;
  };

/**
 * Freeze the one authority field Clementine can enforce generically: the
 * approved entrypoint bytes. Reading through one open descriptor prevents a
 * path replacement from changing which bytes are hashed; writing those bytes
 * to a random hidden sibling means the interpreter opens the same bytes even
 * if another process edits the installed runner between verification and
 * spawn. The sibling preserves extension and directory semantics, so relative
 * imports and dirname(import.meta.url) keep resolving as installed.
 *
 * Helpers, packages, CLIs, local files, auth state, and network services are
 * deliberately not presented as immutable. They remain live compatibility
 * dependencies and are disclosed as such on the approval card.
 */
function prepareVerifiedRunnerEntrypoint(
  target: string,
  runner: string,
  expectedSha256: string,
): PreparedRunnerEntrypoint {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    return { ok: false, error: 'runner approval is missing a valid entrypoint SHA-256 digest' };
  }

  let fd: number | null = null;
  let sourceBytes: Buffer;
  let sourceMode = 0o400;
  try {
    fd = openSync(target, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { ok: false, error: `runner entrypoint is not a regular file: data/${runner}` };
    }
    sourceMode = stat.mode;
    sourceBytes = readFileSync(fd);
  } catch (error) {
    return {
      ok: false,
      error: `runner trust could not read the approved entrypoint: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best-effort descriptor cleanup */ }
    }
  }

  const actualSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    return {
      ok: false,
      error: `runner entrypoint changed after approval; data/${runner} was not executed`,
    };
  }

  const extension = path.extname(runner);
  const stem = extension ? runner.slice(0, -extension.length) : runner;
  const snapshotPath = path.join(
    path.dirname(target),
    `.clementine-entry-${stem}-${randomUUID()}${extension}`,
  );
  try {
    const ownerMode = (sourceMode & 0o111) !== 0 ? 0o500 : 0o400;
    writeFileSync(snapshotPath, sourceBytes, { flag: 'wx', mode: ownerMode });
    chmodSync(snapshotPath, ownerMode);
    runnerEntrypointSnapshotHookForTest?.({
      sourcePath: target,
      snapshotPath,
    });
  } catch (error) {
    try { unlinkSync(snapshotPath); } catch { /* no snapshot or already gone */ }
    return {
      ok: false,
      error: `runner entrypoint could not be frozen before spawn: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    ok: true,
    executionPath: snapshotPath,
    cleanup: () => {
      try { unlinkSync(snapshotPath); } catch { /* crash-safe best effort */ }
    },
  };
}

/** Low-level runner executor. Approval-gated callers pass the approved
 * entrypoint digest so the same verified bytes—not the mutable source path—are
 * opened by the interpreter. This does not freeze runtime dependencies. */
export async function runScript(
  slug: string,
  runner: string,
  extra?: Record<string, unknown>,
  opts: { expectedSha256?: string } = {},
): Promise<RunSourceResult> {
  const runnerError = runnerFilenameError(runner);
  if (runnerError) return { ok: false, error: runnerError, provenNoDispatch: true };
  let target: string;
  try {
    target = resolveInSpace(slug, path.join('data', runner));
  } catch (err) {
    return { ok: false, error: (err as Error).message, provenNoDispatch: true };
  }
  if (!existsSync(target)) {
    return { ok: false, error: `runner script not found: data/${runner}`, provenNoDispatch: true };
  }
  const prepared = opts.expectedSha256
    ? prepareVerifiedRunnerEntrypoint(target, runner, opts.expectedSha256)
    : {
      ok: true as const,
      executionPath: target,
      cleanup: () => undefined,
    };
  if (!prepared.ok) {
    return {
      ok: false,
      error: prepared.error,
      provenNoDispatch: true,
    };
  }

  try {
    const augmentedPath = augmentPath(process.env.PATH);
    const interp = interpreterFor(prepared.executionPath, augmentedPath);
    if (!interp) {
      return {
        ok: false,
        error: `unsupported runner extension for data/${runner} (use .mjs/.js/.cjs/.ts/.py/.sh or an executable)`,
        provenNoDispatch: true,
      };
    }

    const spaceDir = resolveInSpace(slug, 'data');
    const payload = JSON.stringify({ ...(extra ?? {}), slug, runner });
    const env = scrubbedChildEnv({
      CLEMENTINE_SPACE_SLUG: slug,
      ...electronNodeEnv(interp.command, interp.isElectron),
    });
    const outcome = await spawnSandboxedScript({
      command: interp.command, args: interp.args, cwd: spaceDir, env,
      stdinPayload: payload, timeoutMs: RUNNER_TIMEOUT_MS, maxOutputBytes: RUNNER_MAX_OUTPUT_BYTES,
    });
    if (outcome.launchError) {
      return {
        ok: false,
        error: `runner failed to launch: ${outcome.launchError.message}`,
        provenNoDispatch: true,
      };
    }
    if (outcome.overflowed) return { ok: false, error: `runner output exceeded ${RUNNER_MAX_OUTPUT_BYTES} bytes (print a single JSON document to stdout)` };
    if (outcome.timedOut) return { ok: false, error: `runner timed out after ${RUNNER_TIMEOUT_MS}ms` };
    if (outcome.code !== 0) {
      return { ok: false, error: `runner exited ${outcome.signal ?? outcome.code}: ${[outcome.stderr.trim(), outcome.stdout.trim()].filter(Boolean).join(' | ').slice(0, 2000)}` };
    }
    const out = outcome.stdout.trim();
    if (!out) return { ok: false, error: 'runner produced no output (expected JSON on stdout)' };
    try {
      return { ok: true, data: JSON.parse(out) };
    } catch {
      return { ok: false, error: `runner stdout was not valid JSON: ${out.slice(0, 200)}` };
    }
  } finally {
    prepared.cleanup();
  }
}

/** Space composio dispatch — through the SAME gateway as chat/workflow (owner
 *  resolution, sender constraints, typed blocks). A blocked resolution surfaces
 *  as the source/action error with the gateway's deterministic message, so a
 *  Space can never dispatch under an ambiguous or non-compliant account. */
async function runSpaceComposio(
  slug: string,
  toolSlug: string,
  args: Record<string, unknown>,
  mutationSlot?: WorkflowCallMutationSlotInput,
): Promise<RunSourceResult> {
  const {
    composioDispatchErrorProvesNoCommit,
    composioFailureProvesNoCommit,
    detectComposioFailure,
    dispatchComposioTool,
  } = await import('../tools/composio-tools.js');
  const dispatchThroughGateway = spaceComposioDispatchForTest ?? dispatchComposioTool;
  const outcome = await dispatchThroughGateway(toolSlug, args, {
    sessionId: `space:${slug}`,
    ...(mutationSlot
      ? {
        dispatchBoundary: (resolved, dispatch) => executeWorkflowCallMutation({
          ...mutationSlot,
          tool: resolved.toolSlug,
          account: {
            ...(resolved.connectionId ? { connectionId: resolved.connectionId } : {}),
            ...(resolved.identity ? { identity: resolved.identity } : {}),
          },
          args: resolved.args,
        }, dispatch, {
          classifyFailure: (result) => {
            const failure = detectComposioFailure(result);
            return failure.failed
              ? {
                summary: failure.summary || 'provider reported failure',
                provenNoCommit: composioFailureProvesNoCommit(result),
              }
              : null;
          },
          classifyThrownFailure: (error) => (
            composioDispatchErrorProvesNoCommit(error)
              ? (error instanceof Error ? error.message : String(error))
              : null
          ),
        }),
      }
      : {}),
  });
  if (!outcome.ok) return { ok: false, error: `blocked (${outcome.reason}): ${outcome.message}` };
  return { ok: true, data: outcome.result };
}

/** Run a single declared data source (no persistence). */
export async function runSpaceDataSource(slug: string, source: SpaceDataSource): Promise<RunSourceResult> {
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
  const safetyError = workspaceDataSourceSafetyError(source);
  if (safetyError) return { ok: false, error: safetyError, provenNoDispatch: true };
  if (source.composioSlug && source.composioSlug.trim()) {
    try {
      return await runSpaceComposio(slug, source.composioSlug.trim(), source.composioArgs ?? {});
    } catch (err) {
      return { ok: false, error: `composio call failed: ${(err as Error).message}` };
    }
  }
  return { ok: false, error: `data source "${source.id}" declares neither a runner nor a composio_slug` };
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
  const approvalId = authority.ok ? authority.approvalId ?? '' : '';
  const mutationSlot = approvalId
    ? spaceActionMutationSlot(slug, action.id, approvalId)
    : undefined;
  if (action.composioSlug && action.composioSlug.trim()) {
    try {
      if (mutationSlot) {
        const replay = replaySpaceActionMutation(slug, action, approvalId);
        if (replay.replayed) return replay.result;
      }
      return await runSpaceComposio(slug, action.composioSlug.trim(), args, mutationSlot);
    } catch (err) {
      return { ok: false, error: `action failed: ${(err as Error).message}` };
    }
  }
  if (action.runner && action.runner.trim()) {
    const approvedEntrypointSha256 = authority.ok ? authority.runnerSha256 : undefined;
    if (!mutationSlot || !approvedEntrypointSha256) {
      return {
        ok: false,
        error: `action "${action.id}" requires approval bound to a valid runner entrypoint digest before execution`,
        provenNoDispatch: true,
      };
    }
    try {
      const replay = replaySpaceActionMutation(slug, action, approvalId);
      if (replay.replayed) return replay.result;
      return await executeWorkflowCallMutation({
        ...mutationSlot,
        tool: `space-runner:${action.runner.trim()}`,
        args,
      }, () => runScript(
        slug,
        action.runner!.trim(),
        { args },
        { expectedSha256: approvedEntrypointSha256 },
      ), {
        classifyFailure: (result) => (
          result.ok
            ? null
            : {
              summary: result.error,
              provenNoCommit: result.provenNoDispatch === true,
            }
        ),
      });
    } catch (err) {
      return { ok: false, error: `action failed: ${(err as Error).message}` };
    }
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
    const run = await runSpaceDataSource(slug, source);
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
