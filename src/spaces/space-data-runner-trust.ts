/**
 * Historical trust receipts for runner-backed Workspace data sources.
 *
 * Older Clementine versions allowed arbitrary local runner code to refresh
 * automatically. New Workspaces must use a provably read-only provider action,
 * but silently disabling installed runners strands otherwise-useful surfaces.
 *
 * Saved grants remain audit evidence, not execution authority. Runtime checks
 * never create new compatibility cards: unsupported declarations report the
 * missing executor, and supported CLI reads use the shared durable read kernel.
 * Old pending cards for the exact snapshot are retired without rewriting a
 * human's historical decision. Approval-resolution recovery remains available
 * for decisions recorded by earlier installations.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  claimResumableApproval,
  isExpired,
  listPending,
  onApprovalResolved,
  resolve,
  type PendingApprovalRow,
} from '../runtime/harness/approval-registry.js';
import { compileReviewedCliArgv } from '../runtime/harness/reviewed-cli-shell-match.js';
import { createSession, getSession } from '../runtime/harness/eventlog.js';
import { deliverOutcome } from '../runtime/outcome.js';
import { recordOperationalEvent } from '../runtime/operational-telemetry.js';
import type { SpaceSourceFailureCode } from './runner.js';
import { appendNote, listNotes } from './data-store.js';
import {
  projectWorkspaceApprovalDecision,
  type WorkspaceApprovalTerminalResolution,
} from './workspace-db.js';
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
  | { state: 'rejected' | 'expired' | 'cancelled' | 'blocked'; error: string; failureCode?: 'local_runner' | 'local_command' };

export type CliSourceTrustDecision =
  | { state: 'approved'; cliArgv: string[]; approvalId: string }
  | { state: 'pending'; approvalId: string; error: string }
  | { state: 'rejected' | 'expired' | 'cancelled' | 'blocked'; error: string; failureCode?: 'local_runner' | 'local_command' };

export interface RunnerTrustAuthorizationOptions {
  /** Legacy caller field. Refresh cannot invent a runnable carrier or erase a prior no. */
  requestFreshApproval?: boolean;
}

export interface RunnerTrustRefreshRequest {
  spaceSlug: string;
  sourceId: string;
  approvalId: string;
}

export interface RunnerTrustRefreshOutcome {
  ok: boolean;
  failureCode?: SpaceSourceFailureCode;
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
}

/** Replay approvals resolved while the daemon was offline. Registration stays
 * side-effect free: importing a chat surface must never open or migrate the
 * event log from a background callback. The foreground daemon calls this only
 * after its synchronous event-log boot fence has completed. */
export function recoverResolvedRunnerTrustApprovals(): number {
  let recovered = 0;
  for (const row of listPending({ status: 'any' })) {
    const runnerDecision = (
      row.tool === SPACE_DATA_RUNNER_TRUST_TOOL
      && row.args?.spaceDataRunnerTrustVersion === SPACE_DATA_RUNNER_TRUST_VERSION
    );
    const cliDecision = (
      row.tool === SPACE_CLI_SOURCE_TRUST_TOOL
      && row.args?.spaceCliSourceTrustVersion === SPACE_CLI_SOURCE_TRUST_VERSION
    );
    if (!runnerDecision && !cliDecision) continue;

    if (row.resolution === 'approved') {
      if (row.consumedAt !== null) continue;
      recovered += 1;
      if (runnerDecision) recordRunnerTrustDecision(row);
      else recordCliSourceTrustDecision(row);
      continue;
    }

    if (!terminalApprovalResolution(row)) continue;
    const changed = runnerDecision
      ? recordRunnerTrustDecision(row)
      : recordCliSourceTrustDecision(row);
    if (changed) recovered += 1;
  }
  return recovered;
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

/** A retired trust approval never authorizes the new carrier. Retire an exact
 * obsolete pending card before its replacement; preserve a person's prior no. */
export function historicalRunnerDenial(slug: string, source: SpaceDataSource): PendingApprovalRow | null {
  const snapshot = runnerSnapshot(slug, source);
  if (!snapshot.ok) return null;
  const { row: decision } = historicalTrustDecision({ sessionId: `space-${snapshot.rec.id}`,
    tool: SPACE_DATA_RUNNER_TRUST_TOOL, trustKey: snapshot.trustKey, sourceId: source.id,
    executionLabel: `The historical runner “data/${source.runner}”` });
  return decision?.resolution === 'rejected' || decision?.resolution === 'cancelled_by_user' ? decision : null;
}

function terminalApprovalResolution(
  row: PendingApprovalRow,
): WorkspaceApprovalTerminalResolution | null {
  switch (row.resolution) {
    case 'rejected':
    case 'expired':
    case 'cancelled_by_user':
    case 'cancelled_by_system':
      return row.resolution;
    default:
      return null;
  }
}

function approvalDecisionTimestamp(row: PendingApprovalRow): string {
  const candidate = row.resolvedAt ?? (
    row.resolution === 'expired' ? row.expiresAt : row.requestedAt
  );
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function approvalDecisionDateLabel(iso: string): string {
  return `${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC`;
}

function terminalApprovalExplanation(input: {
  row: PendingApprovalRow;
  sourceId: string;
  executionLabel: string;
}): { resolution: WorkspaceApprovalTerminalResolution; resolvedAt: string; text: string } | null {
  const resolution = terminalApprovalResolution(input.row);
  if (!resolution) return null;
  const resolvedAt = approvalDecisionTimestamp(input.row);
  const when = approvalDecisionDateLabel(resolvedAt);
  const subject = `approval ${input.row.approvalId} for data source “${input.sourceId}”`;
  const decision = resolution === 'rejected'
    ? `You declined ${subject} on ${when}`
    : resolution === 'expired'
      ? `${subject[0]!.toUpperCase()}${subject.slice(1)} expired on ${when} without a decision`
      : resolution === 'cancelled_by_user'
        ? `You cancelled ${subject} on ${when}`
        : `Clementine cancelled ${subject} on ${when}`;
  return {
    resolution,
    resolvedAt,
    text: `${decision}. ${input.executionLabel} remained blocked and was not executed. This historical decision is preserved. A refresh must have a supported executor before it can run; another approval alone cannot fix a missing executor.`,
  };
}

function terminalAuthorizationRefusal(input: {
  row: PendingApprovalRow;
  sourceId: string;
  executionLabel: string;
  now: number;
}): { state: 'rejected' | 'expired' | 'cancelled'; error: string } | null {
  const terminal = terminalApprovalExplanation(input);
  if (terminal) {
    return {
      state: terminal.resolution === 'rejected'
        ? 'rejected'
        : terminal.resolution === 'expired'
          ? 'expired'
          : 'cancelled',
      error: terminal.text,
    };
  }
  if (
    input.row.resolution === 'approved'
    && Date.parse(input.row.expiresAt) <= input.now
  ) {
    const expiredAt = approvalDecisionTimestamp({
      ...input.row,
      resolution: 'expired',
      resolvedAt: input.row.expiresAt,
    });
    return {
      state: 'expired',
      error: `The grant from approval ${input.row.approvalId} for data source “${input.sourceId}” expired on ${approvalDecisionDateLabel(expiredAt)}. ${input.executionLabel} remained blocked and was not executed. This historical decision is preserved. A refresh must have a supported executor before it can run; another approval alone cannot fix a missing executor.`,
    };
  }
  return null;
}

function projectTerminalTrustDecision(input: {
  row: PendingApprovalRow;
  slug: string;
  sourceId: string;
  executionLabel: string;
}): { changed: boolean; explanation: ReturnType<typeof terminalApprovalExplanation> } {
  const explanation = terminalApprovalExplanation(input);
  if (!explanation) return { changed: false, explanation: null };
  const result = projectWorkspaceApprovalDecision({
    workspaceId: input.slug,
    sourceKey: input.sourceId,
    approvalId: input.row.approvalId,
    resolution: explanation.resolution,
    resolvedAt: explanation.resolvedAt,
    explanation: explanation.text,
  });
  return { changed: result.transitioned > 0, explanation };
}

function recordRunnerTrustDecision(row: PendingApprovalRow): boolean {
  if (row.tool !== SPACE_DATA_RUNNER_TRUST_TOOL || !row.resolution) return false;
  const args = row.args ?? {};
  if (args.spaceDataRunnerTrustVersion !== SPACE_DATA_RUNNER_TRUST_VERSION) return false;
  const slug = typeof args.spaceSlug === 'string' ? args.spaceSlug : '';
  const sourceId = typeof args.sourceId === 'string' ? args.sourceId : '';
  const runner = typeof args.runner === 'string' ? args.runner : '';
  const runnerSha256 = typeof args.runnerSha256 === 'string' ? args.runnerSha256 : '';
  const trustKey = typeof args.trustKey === 'string' ? args.trustKey : '';
  if (!slug || !sourceId || !runner || !/^[a-f0-9]{64}$/.test(runnerSha256) || !trustKey) return false;

  const rec = spaceStore.get(slug);
  if (!rec) return false;
  const installed = rec?.dataSources.find((source) => source.id === sourceId);
  const terminal = projectTerminalTrustDecision({
    row,
    slug,
    sourceId,
    executionLabel: `The pinned runner entrypoint “data/${runner}”`,
  });
  if (!terminal.explanation && installed?.runner?.trim() !== runner.trim()) return false;
  const decisionAlreadyProjected = listNotes(slug, Number.MAX_SAFE_INTEGER).some((note) => (
    note.meta?.approvalId === row.approvalId
    && note.meta?.kind === SPACE_DATA_RUNNER_TRUST_TOOL
    && note.meta?.status === row.resolution
  ));

  const status = row.resolution;
  let noteAdded = false;
  if (!decisionAlreadyProjected) {
    appendNote(slug, {
      text: status === 'approved'
        ? `Runner trust was approved for data source “${sourceId}” (${row.approvalId}). The blocked refresh is resuming automatically; its observation will report the real outcome.`
        : terminal.explanation?.text
          ?? `Runner trust was ${status} for data source “${sourceId}” (${row.approvalId}). The runner remains blocked and was not executed.`,
      kind: 'data-source',
      meta: {
        kind: SPACE_DATA_RUNNER_TRUST_TOOL,
        sourceId,
        runner,
        runnerSha256,
        approvalId: row.approvalId,
        status,
        staleDataStatus: status !== 'approved',
        ...(terminal.explanation
          ? { resolvedAt: terminal.explanation.resolvedAt }
          : {}),
      },
    });
    noteAdded = true;
  }

  if (status !== 'approved') return terminal.changed || noteAdded;
  resumeApprovedSourceRefresh(row, rec, sourceId);
  return noteAdded;
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
    const pendingIds = [...new Set(failures.flatMap(result => result.pendingApprovalId ? [result.pendingApprovalId] : []))];
    const missingExecutor = failures.some(result => result.failureCode === 'local_runner' || result.failureCode === 'local_command');
    const nextAction = pendingIds.length
      ? `Review the saved-source permission ${pendingIds.join(', ')}. The historical trust decision does not authorize the new execution scope.`
      : missingExecutor
      ? 'Open the Workspace activity log for technical details. The source needs a supported executor before another refresh can work.'
      : 'Open the Workspace activity log for technical details, then retry the refresh.';
    const reply = succeeded
      ? `Approved ${row.approvalId}. “${rec.title}” refreshed ${sourceId} successfully.`
      : `Approved ${row.approvalId}, but “${rec.title}” could not refresh ${sourceId} (${failures.length} failed step${failures.length === 1 ? '' : 's'}). ${nextAction}`;
    if (failures.some(result => !result.pendingApprovalId)) {
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
        status: succeeded ? 'done' : pendingIds.length ? 'needs_input' : 'failed',
        summary: reply,
        evidence: {
          work: [{
            label: `Refresh ${sourceId}`,
            completed: results.filter((result) => result.ok).length,
            total: Math.max(1, results.length),
          }],
        },
        ...(!succeeded
          ? { nextAction }
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

function recordCliSourceTrustDecision(row: PendingApprovalRow): boolean {
  if (row.tool !== SPACE_CLI_SOURCE_TRUST_TOOL || !row.resolution) return false;
  const args = row.args ?? {};
  if (args.spaceCliSourceTrustVersion !== SPACE_CLI_SOURCE_TRUST_VERSION) return false;
  const slug = typeof args.spaceSlug === 'string' ? args.spaceSlug : '';
  const sourceId = typeof args.sourceId === 'string' ? args.sourceId : '';
  const cliArgv = parseCliArgvArg(args.cliArgv);
  const trustKey = typeof args.trustKey === 'string' ? args.trustKey : '';
  if (!slug || !sourceId || !cliArgv || !trustKey) return false;

  const rec = spaceStore.get(slug);
  if (!rec) return false;
  const installed = rec?.dataSources.find((source) => source.id === sourceId);
  const commandLabel = cliArgv.join(' ');
  const terminal = projectTerminalTrustDecision({
    row,
    slug,
    sourceId,
    executionLabel: `The frozen CLI refresh “${commandLabel}”`,
  });
  if (
    !terminal.explanation
    && JSON.stringify(installed?.cliArgv ?? null) !== JSON.stringify(cliArgv)
  ) return false;
  const decisionAlreadyProjected = listNotes(slug, Number.MAX_SAFE_INTEGER).some((note) => (
    note.meta?.approvalId === row.approvalId
    && note.meta?.kind === SPACE_CLI_SOURCE_TRUST_TOOL
    && note.meta?.status === row.resolution
  ));

  const status = row.resolution;
  let noteAdded = false;
  if (!decisionAlreadyProjected) {
    appendNote(slug, {
      text: status === 'approved'
        ? `The frozen CLI refresh “${commandLabel}” was approved for data source “${sourceId}” (${row.approvalId}). The blocked refresh is resuming automatically; its observation will report the real outcome.`
        : terminal.explanation?.text
          ?? `The frozen CLI refresh “${commandLabel}” was ${status} for data source “${sourceId}” (${row.approvalId}). The command remains blocked and was not executed.`,
      kind: 'data-source',
      meta: {
        kind: SPACE_CLI_SOURCE_TRUST_TOOL,
        sourceId,
        cliArgv,
        approvalId: row.approvalId,
        status,
        staleDataStatus: status !== 'approved',
        ...(terminal.explanation
          ? { resolvedAt: terminal.explanation.resolvedAt }
          : {}),
      },
    });
    noteAdded = true;
  }

  if (status !== 'approved') return terminal.changed || noteAdded;
  resumeApprovedSourceRefresh(row, rec, sourceId);
  return noteAdded;
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

/** Reconcile only the exact historical snapshot. Obsolete cards cannot remain
 * actionable when their approved path has no executor. Never change a past
 * human decision, and never register a new card to repair missing capability. */
function historicalTrustDecision(input: {
  sessionId: string;
  tool: string;
  trustKey: string;
  sourceId: string;
  executionLabel: string;
}): { row: PendingApprovalRow | undefined; refusal: ReturnType<typeof terminalAuthorizationRefusal> } {
  const matching = () => listPending({ sessionId: input.sessionId, status: 'any' })
    .filter((row) => row.tool === input.tool && row.args?.trustKey === input.trustKey);
  let row = matching()[0];
  if (row?.status === 'pending') {
    resolve(row.approvalId, isExpired(row) ? 'expired' : 'cancelled_by_system', 'workspace-refresh:executor-readiness');
    row = matching()[0];
  }
  return {
    row,
    refusal: row ? terminalAuthorizationRefusal({
      row, sourceId: input.sourceId, executionLabel: input.executionLabel, now: Date.now(),
    }) : null,
  };
}

/** A frozen argv is usable only when its complete argument vector compiles to
 * a reviewed read. Matching the command head alone is not sufficient. The
 * shared read kernel still proves connection, account, schema and execution
 * authority; a registry trust grant does not supply any of those. */
export function authorizeCliDataSource(
  slug: string,
  source: SpaceDataSource,
  _options: RunnerTrustAuthorizationOptions = {},
): CliSourceTrustDecision {
  const resolved = cliSnapshot(slug, source);
  if (!resolved.ok) return { state: 'blocked', error: resolved.error };
  const { rec, snapshot, trustKey } = resolved;
  const commandLabel = snapshot.cliArgv.join(' ');
  const history = historicalTrustDecision({
    sessionId: ensureSpaceSession(rec), tool: SPACE_CLI_SOURCE_TRUST_TOOL, trustKey,
    sourceId: snapshot.sourceId, executionLabel: `The frozen CLI refresh “${commandLabel}”`,
  });
  const reviewed = compileReviewedCliArgv(snapshot.cliArgv);
  if (reviewed.status !== 'matched') {
    const reason = reviewed.status === 'refused'
      ? `names the reviewed read ${reviewed.operationId} but cannot be carried by it: ${reviewed.reason}`
      : 'is not a reviewed CLI read from the catalog';
    return {
      state: 'blocked', failureCode: 'local_command',
      error: `${history.refusal ? `${history.refusal.error} ` : ''}Workspace "${slug}" local CLI "${commandLabel}" ${reason}; no shared durable call authority is available. The process was not started. This source needs a supported read operation; another approval cannot make this command runnable.`,
    };
  }
  // A prior explicit no remains a no even if a later catalog learns the read.
  // System retirement of an obsolete card is not a human denial of the read.
  if (history.refusal && (history.row?.resolution === 'rejected' || history.row?.resolution === 'cancelled_by_user')) return history.refusal;
  return {
    state: 'approved', cliArgv: snapshot.cliArgv,
    approvalId: history.row?.resolution === 'approved' ? history.row.approvalId : `reviewed:${reviewed.operationId}`,
  };
}

/** Runner declarations retain historical decisions for diagnosis. The retired
 * raw runner has no shared durable carrier: do not offer a button whose yes
 * would only fail at the next boundary. */
export function authorizeInstalledDataRunner(
  slug: string,
  source: SpaceDataSource,
  _options: RunnerTrustAuthorizationOptions = {},
): RunnerTrustDecision {
  const resolved = runnerSnapshot(slug, source);
  if (!resolved.ok) return { state: 'blocked', error: resolved.error };
  const { rec, snapshot, trustKey } = resolved;
  const history = historicalTrustDecision({
    sessionId: ensureSpaceSession(rec), tool: SPACE_DATA_RUNNER_TRUST_TOOL, trustKey,
    sourceId: snapshot.sourceId, executionLabel: `The pinned runner entrypoint “data/${snapshot.runner}”`,
  });
  return {
    state: 'blocked', failureCode: 'local_runner',
    error: `${history.refusal ? `${history.refusal.error} ` : ''}Workspace "${slug}" local runner "${snapshot.runner}" is unavailable: no shared durable call authority was supplied. The process was not started. This source needs a supported executor; another approval cannot make the retired runner runnable.`,
  };
}
