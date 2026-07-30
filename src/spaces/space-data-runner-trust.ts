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
import { appendEvent, createSession, getSession } from '../runtime/harness/eventlog.js';
import { appendNote, listNotes } from './data-store.js';
import {
  resolveInSpace,
  runnerFilenameError,
  spaceStore,
  type SpaceDataSource,
  type SpaceRecord,
} from './store.js';
import { SPACE_DATA_RUNNER_TRUST_TOOL } from './space-execution-policy.js';

export { SPACE_DATA_RUNNER_TRUST_TOOL };
export const SPACE_DATA_RUNNER_TRUST_VERSION = 1;
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

export type RunnerTrustDecision =
  | { state: 'approved'; runnerSha256: string; approvalId: string }
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
      if (
        row.tool === SPACE_DATA_RUNNER_TRUST_TOOL
        && row.resolution === 'approved'
        && row.consumedAt === null
        && row.args?.spaceDataRunnerTrustVersion === SPACE_DATA_RUNNER_TRUST_VERSION
      ) {
        recordRunnerTrustDecision(row);
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

  if (status !== 'approved' || !row.resumeKey || !runnerTrustRefreshHandler) return;
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
      : `Approved ${row.approvalId}, but “${rec.title}” could not refresh ${sourceId}: ${
        failures.map((result) => result.error ?? 'unknown refresh error').join('; ')
      }`;
    appendEvent({
      sessionId: row.sessionId,
      turn: 0,
      role: 'Clem',
      type: 'conversation_completed',
      data: {
        reason: succeeded
          ? 'workspace_runner_approval_refresh_completed'
          : 'workspace_runner_approval_refresh_failed',
        summary: reply,
        reply,
        steps: 0,
        approvalId: row.approvalId,
        sourceId,
      },
    });
  }).catch((error: unknown) => {
    const reply = `Approved ${row.approvalId}, but “${rec.title}” could not refresh ${sourceId}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    appendEvent({
      sessionId: row.sessionId,
      turn: 0,
      role: 'Clem',
      type: 'conversation_completed',
      data: {
        reason: 'workspace_runner_approval_refresh_failed',
        summary: reply,
        reply,
        steps: 0,
        approvalId: row.approvalId,
        sourceId,
      },
    });
  });
}

onApprovalResolved(recordRunnerTrustDecision);

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
