/**
 * Compatibility authority for runner-backed Workspace data sources.
 *
 * Older Clementine versions allowed arbitrary local runner code to refresh
 * automatically. New Workspaces must use a provably read-only provider action,
 * but silently disabling installed runners strands otherwise-useful surfaces.
 *
 * Migration is therefore explicit about the authority Clementine can enforce:
 *   - only a runner already declared by the installed manifest is eligible;
 *   - one human approval is bound to workspace + source + filename + entrypoint
 *     hash + automatic schedule policy;
 *   - entrypoint or schedule drift invalidates the grant before another spawn;
 *   - pending retries converge on one approval card;
 *   - a rejection is terminal for that exact snapshot.
 *
 * Arbitrary code is not statically "read-only". Only the entrypoint bytes are
 * pinned; helpers, runtimes, CLIs, files, auth, and network dependencies remain
 * live and outside the digest.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  claimResumableApproval,
  isActionable,
  isExpired,
  listPending,
  onApprovalResolved,
  registerResumable,
  resolve,
  type PendingApprovalRow,
} from '../runtime/harness/approval-registry.js';
import { emitApprovalRequestedCard } from '../runtime/harness/approval-card.js';
import { createSession, getSession } from '../runtime/harness/eventlog.js';
import { deliverOutcome } from '../runtime/outcome.js';
import { recordOperationalEvent } from '../runtime/operational-telemetry.js';
import { appendNote, listNotes } from './data-store.js';
import {
  cliArgvError,
  resolveInSpace,
  runnerFilenameError,
  spaceStore,
  type SpaceDataSource,
  type SpaceRecord,
} from './store.js';
import {
  SPACE_CLI_SOURCE_TRUST_TOOL,
  SPACE_DATA_RUNNER_TRUST_TOOL,
} from './space-execution-policy.js';

export { SPACE_CLI_SOURCE_TRUST_TOOL, SPACE_DATA_RUNNER_TRUST_TOOL };
export const SPACE_DATA_RUNNER_TRUST_VERSION = 1;
export const SPACE_CLI_SOURCE_TRUST_VERSION = 1;
const RUNNER_TRUST_TTL_MS = 90 * 24 * 60 * 60 * 1000;

interface RunnerTrustSnapshot {
  spaceDataRunnerTrustVersion: typeof SPACE_DATA_RUNNER_TRUST_VERSION;
  spaceSlug: string;
  sourceId: string;
  runner: string;
  runnerSha256: string;
  schedulePolicy: {
    schedule: string | null;
    timezone: string | null;
  };
}

/** No file digest: the argv itself IS the frozen program the human reviewed.
 * The command binary and the credentials it uses stay live on the machine and
 * are disclosed as such on the approval card. */
interface CliSourceTrustSnapshot {
  spaceCliSourceTrustVersion: typeof SPACE_CLI_SOURCE_TRUST_VERSION;
  spaceSlug: string;
  sourceId: string;
  cliArgv: string[];
  schedulePolicy: {
    schedule: string | null;
    timezone: string | null;
  };
}

export type RunnerTrustDecision =
  | { state: 'approved'; runnerSha256: string; approvalId: string }
  | { state: 'pending'; approvalId: string; error: string }
  | { state: 'rejected' | 'blocked'; error: string };

export type CliSourceTrustDecision =
  | { state: 'approved'; cliArgv: string[]; approvalId: string }
  | { state: 'pending'; approvalId: string; error: string }
  | { state: 'rejected' | 'blocked'; error: string };

export interface RunnerTrustRefreshRequest {
  spaceSlug: string;
  sourceId: string;
  approvalId: string;
}

export interface RunnerTrustRefreshOutcome {
  ok: boolean;
  sourceId: string;
  error?: string;
  pendingApprovalId?: string;
}

type RunnerTrustRefreshHandler = (
  request: RunnerTrustRefreshRequest,
) => Promise<RunnerTrustRefreshOutcome[]>;

let runnerTrustRefreshHandler: RunnerTrustRefreshHandler | null = null;

/** The runner owns refresh serialization and observation commits. This seam
 * lets approval resolution request that work without creating an import cycle. */
export function registerRunnerTrustRefreshHandler(handler: RunnerTrustRefreshHandler): void {
  runnerTrustRefreshHandler = handler;
  setImmediate(() => {
    for (const row of listPending({ status: 'resolved' })) {
      if (row.resolution !== 'approved' || row.consumedAt !== null) continue;
      if (
        row.tool === SPACE_DATA_RUNNER_TRUST_TOOL
        && row.args?.spaceDataRunnerTrustVersion === SPACE_DATA_RUNNER_TRUST_VERSION
      ) {
        recordRunnerTrustDecision(row);
      } else if (
        row.tool === SPACE_CLI_SOURCE_TRUST_TOOL
        && row.args?.spaceCliSourceTrustVersion === SPACE_CLI_SOURCE_TRUST_VERSION
      ) {
        recordCliSourceTrustDecision(row);
      }
    }
  });
}

function normalizedPolicy(source: SpaceDataSource): RunnerTrustSnapshot['schedulePolicy'] {
  return {
    schedule: source.schedule?.trim() || null,
    timezone: source.timezone?.trim() || null,
  };
}

function sameInstalledDeclaration(
  installed: SpaceDataSource,
  requested: SpaceDataSource,
): boolean {
  return installed.id === requested.id
    && (installed.runner?.trim() || '') === (requested.runner?.trim() || '')
    && JSON.stringify(normalizedPolicy(installed)) === JSON.stringify(normalizedPolicy(requested));
}

function runnerSnapshot(
  slug: string,
  source: SpaceDataSource,
): { ok: true; rec: SpaceRecord; snapshot: RunnerTrustSnapshot; trustKey: string }
  | { ok: false; error: string } {
  const runner = source.runner?.trim() ?? '';
  const filenameError = runnerFilenameError(runner);
  if (filenameError) return { ok: false, error: filenameError };

  const rec = spaceStore.get(slug);
  if (!rec) {
    return {
      ok: false,
      error: `Data source "${source.id}" is not part of an installed Workspace manifest; opaque runner execution remains blocked.`,
    };
  }
  const installed = rec.dataSources.find((candidate) => candidate.id === source.id);
  if (!installed || !sameInstalledDeclaration(installed, source)) {
    return {
      ok: false,
      error: `Data source "${source.id}" does not exactly match its installed legacy runner declaration; opaque runner execution remains blocked.`,
    };
  }

  let target: string;
  try {
    target = resolveInSpace(slug, path.join('data', runner));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!existsSync(target)) {
    return { ok: false, error: `runner script not found: data/${runner}` };
  }

  let runnerSha256: string;
  try {
    runnerSha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
  } catch (error) {
    return {
      ok: false,
      error: `could not fingerprint data/${runner}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const snapshot: RunnerTrustSnapshot = {
    spaceDataRunnerTrustVersion: SPACE_DATA_RUNNER_TRUST_VERSION,
    spaceSlug: slug,
    sourceId: source.id,
    runner,
    runnerSha256,
    schedulePolicy: normalizedPolicy(source),
  };
  const trustKey = createHash('sha256')
    .update(JSON.stringify(snapshot))
    .digest('hex');
  return { ok: true, rec, snapshot, trustKey };
}

function ensureSpaceSession(rec: SpaceRecord): string {
  const sessionId = `space-${rec.id}`;
  if (!getSession(sessionId)) {
    try {
      createSession({ id: sessionId, kind: 'chat', title: rec.title });
    } catch {
      // A concurrent refresh may have created the same deterministic session.
    }
  }
  return sessionId;
}

function recordRunnerTrustDecision(row: PendingApprovalRow): void {
  if (row.tool !== SPACE_DATA_RUNNER_TRUST_TOOL || !row.resolution) return;
  const args = row.args ?? {};
  if (args.spaceDataRunnerTrustVersion !== SPACE_DATA_RUNNER_TRUST_VERSION) return;
  const slug = typeof args.spaceSlug === 'string' ? args.spaceSlug : '';
  const sourceId = typeof args.sourceId === 'string' ? args.sourceId : '';
  const runner = typeof args.runner === 'string' ? args.runner : '';
  const runnerSha256 = typeof args.runnerSha256 === 'string' ? args.runnerSha256 : '';
  const trustKey = typeof args.trustKey === 'string' ? args.trustKey : '';
  if (!slug || !sourceId || !runner || !/^[a-f0-9]{64}$/.test(runnerSha256) || !trustKey) return;

  const rec = spaceStore.get(slug);
  const installed = rec?.dataSources.find((source) => source.id === sourceId);
  if (!rec || installed?.runner?.trim() !== runner.trim()) return;
  const decisionAlreadyProjected = listNotes(slug, Number.MAX_SAFE_INTEGER).some((note) => (
    note.meta?.approvalId === row.approvalId
    && note.meta?.kind === SPACE_DATA_RUNNER_TRUST_TOOL
    && note.meta?.status === row.resolution
  ));

  const status = row.resolution;
  if (!decisionAlreadyProjected) {
    appendNote(slug, {
      text: status === 'approved'
        ? `Runner trust was approved for data source “${sourceId}” (${row.approvalId}). The blocked refresh is resuming automatically; its observation will report the real outcome.`
        : `Runner trust was ${status} for data source “${sourceId}” (${row.approvalId}). The runner remains blocked and was not executed.`,
      kind: 'data-source',
      meta: {
        kind: SPACE_DATA_RUNNER_TRUST_TOOL,
        sourceId,
        runner,
        runnerSha256,
        approvalId: row.approvalId,
        status,
        staleDataStatus: status !== 'approved',
      },
    });
  }

  if (status !== 'approved') return;
  resumeApprovedSourceRefresh(row, rec, sourceId);
}

/** Approved trust card → replay the blocked refresh exactly once (claim the
 * resume key) and narrate the real outcome into the Workspace session. Shared
 * by the runner-entrypoint and frozen-CLI trust shapes. */
function resumeApprovedSourceRefresh(
  row: PendingApprovalRow,
  rec: SpaceRecord,
  sourceId: string,
): void {
  const slug = rec.id;
  if (!row.resumeKey || !runnerTrustRefreshHandler) return;
  const claim = claimResumableApproval(row.resumeKey);
  if (claim.state !== 'approved') return;

  void runnerTrustRefreshHandler({
    spaceSlug: slug,
    sourceId,
    approvalId: row.approvalId,
  }).then((results) => {
    const succeeded = results.length > 0 && results.every((result) => result.ok);
    const failures = results.filter((result) => !result.ok);
    const reply = succeeded
      ? `Approved ${row.approvalId}. “${rec.title}” refreshed ${sourceId} successfully.`
      : `Approved ${row.approvalId}, but “${rec.title}” could not refresh ${sourceId} (${failures.length} failed step${failures.length === 1 ? '' : 's'}). Open the activity log for technical details, then try again.`;
    if (!succeeded) {
      recordOperationalEvent({
        source: 'workspace',
        type: 'workspace_data_refresh_failed',
        severity: 'error',
        workspaceId: slug,
        sessionId: row.sessionId,
        actor: 'space-runner',
        payload: {
          approvalId: row.approvalId,
          sourceId,
          failures: failures.slice(0, 20).map((result) => result.error ?? 'unknown refresh error'),
        },
      });
    }
    deliverOutcome(
      {
        status: succeeded ? 'done' : 'failed',
        summary: reply,
        evidence: {
          work: [{
            label: `Refresh ${sourceId}`,
            completed: results.filter((result) => result.ok).length,
            total: Math.max(1, results.length),
          }],
        },
        ...(!succeeded
          ? { nextAction: 'Open the Workspace activity log for technical details, then retry the refresh.' }
          : {}),
      },
      {
        originSessionId: row.sessionId,
        sourceLabel: 'workspace refresh',
        sourceId: `${row.approvalId}:${sourceId}`,
        title: rec.title,
        statusHint: `space_get('${slug}')`,
        proactiveTurn: true,
      },
    );
  }).catch((error: unknown) => {
    recordOperationalEvent({
      source: 'workspace',
      type: 'workspace_data_refresh_failed',
      severity: 'error',
      workspaceId: slug,
      sessionId: row.sessionId,
      actor: 'space-runner',
      payload: {
        approvalId: row.approvalId,
        sourceId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    const reply = `Approved ${row.approvalId}, but “${rec.title}” could not refresh ${sourceId}. Open the activity log for technical details, then try again.`;
    deliverOutcome(
      {
        status: 'failed',
        summary: reply,
        nextAction: 'Open the Workspace activity log for technical details, then retry the refresh.',
      },
      {
        originSessionId: row.sessionId,
        sourceLabel: 'workspace refresh',
        sourceId: `${row.approvalId}:${sourceId}`,
        title: rec.title,
        statusHint: `space_get('${slug}')`,
        proactiveTurn: true,
      },
    );
  });
}

function parseCliArgvArg(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((item) => typeof item === 'string' && item.length > 0)) return null;
  return v as string[];
}

function recordCliSourceTrustDecision(row: PendingApprovalRow): void {
  if (row.tool !== SPACE_CLI_SOURCE_TRUST_TOOL || !row.resolution) return;
  const args = row.args ?? {};
  if (args.spaceCliSourceTrustVersion !== SPACE_CLI_SOURCE_TRUST_VERSION) return;
  const slug = typeof args.spaceSlug === 'string' ? args.spaceSlug : '';
  const sourceId = typeof args.sourceId === 'string' ? args.sourceId : '';
  const cliArgv = parseCliArgvArg(args.cliArgv);
  const trustKey = typeof args.trustKey === 'string' ? args.trustKey : '';
  if (!slug || !sourceId || !cliArgv || !trustKey) return;

  const rec = spaceStore.get(slug);
  const installed = rec?.dataSources.find((source) => source.id === sourceId);
  if (!rec || JSON.stringify(installed?.cliArgv ?? null) !== JSON.stringify(cliArgv)) return;
  const decisionAlreadyProjected = listNotes(slug, Number.MAX_SAFE_INTEGER).some((note) => (
    note.meta?.approvalId === row.approvalId
    && note.meta?.kind === SPACE_CLI_SOURCE_TRUST_TOOL
    && note.meta?.status === row.resolution
  ));

  const status = row.resolution;
  const commandLabel = cliArgv.join(' ');
  if (!decisionAlreadyProjected) {
    appendNote(slug, {
      text: status === 'approved'
        ? `The frozen CLI refresh “${commandLabel}” was approved for data source “${sourceId}” (${row.approvalId}). The blocked refresh is resuming automatically; its observation will report the real outcome.`
        : `The frozen CLI refresh “${commandLabel}” was ${status} for data source “${sourceId}” (${row.approvalId}). The command remains blocked and was not executed.`,
      kind: 'data-source',
      meta: {
        kind: SPACE_CLI_SOURCE_TRUST_TOOL,
        sourceId,
        cliArgv,
        approvalId: row.approvalId,
        status,
        staleDataStatus: status !== 'approved',
      },
    });
  }

  if (status !== 'approved') return;
  resumeApprovedSourceRefresh(row, rec, sourceId);
}

onApprovalResolved(recordRunnerTrustDecision);
onApprovalResolved(recordCliSourceTrustDecision);

function cliSnapshot(
  slug: string,
  source: SpaceDataSource,
): { ok: true; rec: SpaceRecord; snapshot: CliSourceTrustSnapshot; trustKey: string }
  | { ok: false; error: string } {
  const argvErrorText = cliArgvError(source.cliArgv);
  if (argvErrorText) return { ok: false, error: argvErrorText };
  const cliArgv = (source.cliArgv as string[]).slice();

  const rec = spaceStore.get(slug);
  if (!rec) {
    return {
      ok: false,
      error: `Data source "${source.id}" is not part of an installed Workspace manifest; CLI execution remains blocked.`,
    };
  }
  const installed = rec.dataSources.find((candidate) => candidate.id === source.id);
  if (
    !installed
    || JSON.stringify(installed.cliArgv ?? null) !== JSON.stringify(cliArgv)
    || JSON.stringify(normalizedPolicy(installed)) !== JSON.stringify(normalizedPolicy(source))
  ) {
    return {
      ok: false,
      error: `Data source "${source.id}" does not exactly match its installed CLI declaration; CLI execution remains blocked.`,
    };
  }

  const snapshot: CliSourceTrustSnapshot = {
    spaceCliSourceTrustVersion: SPACE_CLI_SOURCE_TRUST_VERSION,
    spaceSlug: slug,
    sourceId: source.id,
    cliArgv,
    schedulePolicy: normalizedPolicy(source),
  };
  const trustKey = createHash('sha256')
    .update(JSON.stringify(snapshot))
    .digest('hex');
  return { ok: true, rec, snapshot, trustKey };
}

/**
 * Resolve or request the one decision for this frozen CLI declaration. The
 * approval pins the exact argv vector plus the automatic schedule policy; any
 * argv or schedule change mints a new trustKey and re-asks. Merely calling
 * this function never executes the command.
 */
export function authorizeCliDataSource(
  slug: string,
  source: SpaceDataSource,
): CliSourceTrustDecision {
  const resolved = cliSnapshot(slug, source);
  if (!resolved.ok) return { state: 'blocked', error: resolved.error };
  const { rec, snapshot, trustKey } = resolved;
  const sessionId = ensureSpaceSession(rec);
  const now = Date.now();
  const commandLabel = snapshot.cliArgv.join(' ');
  const matchingRows = (): ReturnType<typeof listPending> => listPending({ sessionId, status: 'any' })
    .filter((row) => (
      row.tool === SPACE_CLI_SOURCE_TRUST_TOOL
      && row.args?.spaceCliSourceTrustVersion === SPACE_CLI_SOURCE_TRUST_VERSION
      && row.args?.trustKey === trustKey
    ));
  let latest = matchingRows()[0];

  // Same liveness rule as runner trust: never depend on the background reaper
  // to free the resumable-key uniqueness slot after expiry.
  if (latest?.status === 'pending' && isExpired(latest, new Date(now))) {
    resolve(latest.approvalId, 'expired', 'space-cli-source-trust');
    latest = matchingRows()[0];
  }

  if (
    latest?.status === 'resolved'
    && latest.resolution === 'approved'
    && Date.parse(latest.expiresAt) > now
  ) {
    return {
      state: 'approved',
      cliArgv: snapshot.cliArgv,
      approvalId: latest.approvalId,
    };
  }
  if (latest && isActionable(latest)) {
    return {
      state: 'pending',
      approvalId: latest.approvalId,
      error: `Frozen CLI refresh "${commandLabel}" is awaiting one-time approval (${latest.approvalId}); it was not executed.`,
    };
  }
  if (latest?.resolution === 'rejected') {
    return {
      state: 'rejected',
      error: `Trust for frozen CLI refresh "${commandLabel}" was rejected (${latest.approvalId}); it was not executed. Migrate this source to a provably read-only Composio action or change the declared command to request a new review.`,
    };
  }

  const subject = `Allow “${commandLabel}” to refresh “${rec.title}” automatically`;
  const reason = 'This approval freezes the exact command line shown — no shell, no substitutions — and lets it run on the declared schedule without asking again. '
    + 'The command binary itself, plus the local auth state and network services it uses, stay live on this machine and outside the freeze; approve only a command you know is read-only. '
    + 'The grant expires after 90 days; any command or schedule change invalidates it.';
  const { row, created } = registerResumable({
    sessionId,
    resumeKey: `space-cli-source-trust:v${SPACE_CLI_SOURCE_TRUST_VERSION}:${trustKey}`,
    ttlMs: RUNNER_TRUST_TTL_MS,
    subject,
    tool: SPACE_CLI_SOURCE_TRUST_TOOL,
    args: {
      ...snapshot,
      trustKey,
      subject,
      reason,
      preview: {
        count: 1,
        samples: [{
          label: 'Frozen command',
          value: commandLabel,
          secondary: `${rec.title} · ${snapshot.sourceId}${snapshot.schedulePolicy.schedule ? ` · ${snapshot.schedulePolicy.schedule}` : ''}`,
        }],
      },
    },
  });
  if (created) {
    appendNote(rec.id, {
      text: `Data source “${snapshot.sourceId}” is waiting for one-time approval of its frozen CLI command (${row.approvalId}).`,
      kind: 'data-source',
      meta: {
        kind: SPACE_CLI_SOURCE_TRUST_TOOL,
        sourceId: snapshot.sourceId,
        cliArgv: snapshot.cliArgv,
        approvalId: row.approvalId,
        status: 'pending',
      },
    });
    emitApprovalRequestedCard({
      sessionId,
      approvalId: row.approvalId,
      extra: {
        workspaceId: rec.id,
        sourceId: snapshot.sourceId,
      },
    });
  }
  return {
    state: 'pending',
    approvalId: row.approvalId,
    error: `Frozen CLI refresh "${commandLabel}" needs one-time approval (${row.approvalId}) before it can refresh automatically; it was not executed.`,
  };
}

/**
 * Resolve or request the one compatibility decision for this installed runner
 * entrypoint snapshot. Merely calling this function never executes the runner.
 */
export function authorizeInstalledDataRunner(
  slug: string,
  source: SpaceDataSource,
): RunnerTrustDecision {
  const resolved = runnerSnapshot(slug, source);
  if (!resolved.ok) return { state: 'blocked', error: resolved.error };
  const { rec, snapshot, trustKey } = resolved;
  const sessionId = ensureSpaceSession(rec);
  const now = Date.now();
  const matchingRows = (): ReturnType<typeof listPending> => listPending({ sessionId, status: 'any' })
    .filter((row) => (
      row.tool === SPACE_DATA_RUNNER_TRUST_TOOL
      && row.args?.spaceDataRunnerTrustVersion === SPACE_DATA_RUNNER_TRUST_VERSION
      && row.args?.trustKey === trustKey
    ));
  let latest = matchingRows()[0];

  // Do not depend on the background approval reaper for liveness. A daemon
  // that was asleep past expiry may still have the old row marked `pending`,
  // which would otherwise occupy the resumable-key uniqueness slot forever.
  if (latest?.status === 'pending' && isExpired(latest, new Date(now))) {
    resolve(latest.approvalId, 'expired', 'space-data-runner-trust');
    latest = matchingRows()[0];
  }

  if (
    latest?.status === 'resolved'
    && latest.resolution === 'approved'
    && Date.parse(latest.expiresAt) > now
  ) {
    return {
      state: 'approved',
      runnerSha256: snapshot.runnerSha256,
      approvalId: latest.approvalId,
    };
  }
  if (latest && isActionable(latest)) {
    return {
      state: 'pending',
      approvalId: latest.approvalId,
      error: `Legacy data runner "data/${snapshot.runner}" is awaiting one-time approval (${latest.approvalId}); it was not executed.`,
    };
  }
  if (latest?.resolution === 'rejected') {
    return {
      state: 'rejected',
      error: `Trust for legacy data runner "data/${snapshot.runner}" was rejected (${latest.approvalId}); it was not executed. Migrate this source to a provably read-only Composio action or change the runner to request a new entrypoint review.`,
    };
  }

  const subject = `Allow pinned entrypoint “${snapshot.runner}” to refresh “${rec.title}” automatically`;
  const reason = 'Legacy compatibility: this approval pins only the runner entrypoint bytes. Helpers, packages, CLIs, local files, auth state, and network services remain live and outside the digest; arbitrary runner code is not a read-only sandbox. The grant expires after 90 days; any entrypoint, source, or schedule change invalidates it.';
  const { row, created } = registerResumable({
    sessionId,
    resumeKey: `space-data-runner-trust:v${SPACE_DATA_RUNNER_TRUST_VERSION}:${trustKey}`,
    ttlMs: RUNNER_TRUST_TTL_MS,
    subject,
    tool: SPACE_DATA_RUNNER_TRUST_TOOL,
    args: {
      ...snapshot,
      trustKey,
      subject,
      reason,
      preview: {
        count: 1,
        samples: [{
          label: 'Pinned entrypoint',
          value: `${rec.title} · ${snapshot.sourceId} · data/${snapshot.runner}`,
          secondary: `SHA-256 ${snapshot.runnerSha256.slice(0, 12)}…`,
        }],
      },
    },
  });
  if (created) {
    appendNote(rec.id, {
      text: `Data source “${snapshot.sourceId}” is waiting for one-time runner approval (${row.approvalId}).`,
      kind: 'data-source',
      meta: {
        kind: SPACE_DATA_RUNNER_TRUST_TOOL,
        sourceId: snapshot.sourceId,
        runner: snapshot.runner,
        runnerSha256: snapshot.runnerSha256,
        approvalId: row.approvalId,
        status: 'pending',
      },
    });
    emitApprovalRequestedCard({
      sessionId,
      approvalId: row.approvalId,
      extra: {
        workspaceId: rec.id,
        sourceId: snapshot.sourceId,
      },
    });
  }
  return {
    state: 'pending',
    approvalId: row.approvalId,
    error: `Legacy data runner "data/${snapshot.runner}" needs one-time approval (${row.approvalId}) before it can refresh automatically; it was not executed.`,
  };
}
