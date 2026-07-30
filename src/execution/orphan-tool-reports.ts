/**
 * Stranded-tool reunification driver (daemon tick). A turn that died on an infra
 * error while a tool was still in flight registered an `orphaned_tool_inflight`
 * marker (loop.ts recordOrphanedToolInFlight). Once the tool completes, this poke
 * drains the completed orphans into follow-up REPORT turns so the session
 * self-reports the result to the user — the interrupted turn never posted it.
 *
 * Report turns are launched without blocking the daemon loop, but admission is
 * process-global and completion-aware: an unresolved turn keeps its slot across
 * later ticks. Every completed orphan for one session is folded into one report
 * turn so parallel tool completions cannot become parallel model turns.
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import type {
  OrphanedToolCompletionClaim,
  OrphanedToolReport,
} from '../runtime/harness/loop.js';

const logger = pino({ name: 'clementine-next.orphan-tool-reports' });

/** Only sweep sessions touched within this window — an orphan older than the
 *  loop-side ORPHAN_TOOL_MAX_AGE_MS is already dropped by the drain. */
const ORPHAN_SWEEP_WINDOW_MS = 60 * 60_000;
const ORPHAN_REPORT_OUTBOX_FILE = path.join(BASE_DIR, 'state', 'orphan-tool-report-outbox.json');
/** Process-level ceiling, not a per-tick allowance. A slot is released only
 *  after the report turn settles, so repeated daemon ticks cannot accumulate
 *  fire-and-forget model work. */
const MAX_REPORT_TURNS_IN_FLIGHT = 2;
const MAX_REPORTS_PER_CHUNK = 20;
const MAX_REPORT_DIRECTIVE_CHARS = 12_000;
const REPORT_RETRY_BASE_MS = 30_000;
const REPORT_RETRY_MAX_MS = 15 * 60_000;

export const _testOnly_ORPHAN_REPORT_DIRECTIVE_MAX_CHARS = MAX_REPORT_DIRECTIVE_CHARS;

export interface OrphanReportDeps {
  now: () => number;
  recentSessionIds: (sinceIso: string) => string[];
  /**
   * Production path: inspect without consuming, then acknowledge only after
   * the aggregate is durable in the outbox.
   */
  claim?: (sessionId: string) => OrphanedToolCompletionClaim;
  /** Legacy consuming seam retained for callers that own their durability. */
  drain?: (sessionId: string) => OrphanedToolReport[];
  /** Fire ONE aggregated follow-up report turn for this session. */
  fire: (sessionId: string, report: OrphanedToolReport) => void | Promise<void>;
  onFireFailure?: (sessionId: string, report: OrphanedToolReport, error: unknown) => void;
  onOutboxFailure?: (sessionId: string, error: unknown) => void;
  onSourceAckFailure?: (sessionId: string, error: unknown) => void;
}

export interface OrphanReportSweepResult {
  /** Number of report turns admitted during THIS sweep. */
  fired: number;
  /** Report turns currently occupying process slots, including prior sweeps. */
  inFlight: number;
  /** Drained aggregates retained until their report turn succeeds. */
  pending: number;
}

interface PendingReportChunk {
  report: OrphanedToolReport;
  attempts: number;
  nextAttemptAtMs: number;
}

interface PendingReportBatch {
  chunks: PendingReportChunk[];
  durable: boolean;
  sourceCallIds: string[];
  sourceAcknowledged: boolean;
  acknowledgeSource?: () => void;
}

interface OrphanReportOutbox {
  load(): Array<{
    sessionId: string;
    chunks: PendingReportChunk[];
    sourceCallIds: string[];
  }>;
  save(pending: ReadonlyMap<string, PendingReportBatch>): void;
}

export interface OrphanReportCoordinator {
  sweep(deps: OrphanReportDeps): OrphanReportSweepResult;
  snapshot(): Pick<OrphanReportSweepResult, 'inFlight' | 'pending'>;
}

function chunkSessionReports(
  sessionId: string,
  reports: OrphanedToolReport[],
): PendingReportChunk[] {
  const header = [
    'Tool calls from an earlier interrupted turn have now completed.',
    'Report EVERY actual outcome in this bounded chunk. Preserve the result details and do not re-run any call.',
    '',
  ].join('\n');
  const footer = [
    '',
    'Give one truthful report covering every result in this chunk. Do not omit failures and do not re-run the tools.',
  ].join('\n');
  // Reserve enough room for the envelope and metadata repeated around a split
  // oversized result. Runtime-produced summaries are already small, but this
  // keeps the coordinator safe for any legacy/custom report producer too.
  const maxSectionBodyChars = MAX_REPORT_DIRECTIVE_CHARS - header.length - footer.length - 512;
  const sections: Array<{ callId: string; toolName: string; text: string }> = [];
  for (const [reportIndex, report] of reports.entries()) {
    const metadata = [
      `--- Completed tool result ${reportIndex + 1} of ${reports.length} ---`,
      `Call ID: ${report.callId}`,
      `Tool: ${report.toolName || 'unknown'}`,
    ].join('\n');
    const maxFragmentChars = Math.max(1, maxSectionBodyChars - metadata.length - 80);
    const fragmentCount = Math.max(1, Math.ceil(report.directive.length / maxFragmentChars));
    for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
      const fragment = report.directive.slice(
        fragmentIndex * maxFragmentChars,
        (fragmentIndex + 1) * maxFragmentChars,
      );
      const fragmentLabel = fragmentCount > 1
        ? `\nResult detail fragment ${fragmentIndex + 1} of ${fragmentCount}:`
        : '';
      sections.push({
        callId: report.callId,
        toolName: report.toolName,
        text: `${metadata}${fragmentLabel}\n${fragment}`,
      });
    }
  }

  const packed: Array<Array<{ callId: string; toolName: string; text: string }>> = [];
  let current: Array<{ callId: string; toolName: string; text: string }> = [];
  let currentChars = header.length + footer.length;
  for (const section of sections) {
    const addedChars = section.text.length + (current.length > 0 ? 2 : 0);
    if (
      current.length > 0
      && (
        current.length >= MAX_REPORTS_PER_CHUNK
        || currentChars + addedChars > MAX_REPORT_DIRECTIVE_CHARS
      )
    ) {
      packed.push(current);
      current = [];
      currentChars = header.length + footer.length;
    }
    current.push(section);
    currentChars += section.text.length + (current.length > 1 ? 2 : 0);
  }
  if (current.length > 0) packed.push(current);

  return packed.map((chunk, chunkIndex) => {
    const toolNames = Array.from(new Set(chunk.map((part) => part.toolName).filter(Boolean)));
    const directive = `${header}${chunk.map((part) => part.text).join('\n\n')}${footer}`;
    if (directive.length > MAX_REPORT_DIRECTIVE_CHARS) {
      throw new Error(`orphan report chunk exceeded ${MAX_REPORT_DIRECTIVE_CHARS} characters`);
    }
    return {
      report: {
        callId: `orphan-chunk:${sessionId}:${chunk[0].callId}:${chunkIndex + 1}`,
        toolName: toolNames.length === 1 ? toolNames[0] : 'multiple_tools',
        directive,
      },
      attempts: 0,
      nextAttemptAtMs: 0,
    };
  });
}

function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(20, attempts - 1));
  return Math.min(REPORT_RETRY_MAX_MS, REPORT_RETRY_BASE_MS * (2 ** exponent));
}

function parseOutboxReport(value: unknown): OrphanedToolReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.callId !== 'string'
    || typeof raw.toolName !== 'string'
    || typeof raw.directive !== 'string'
    || !raw.callId
    || !raw.directive
  ) return null;
  return {
    callId: raw.callId,
    toolName: raw.toolName,
    directive: raw.directive,
  };
}

function fileOutbox(filePath: string): OrphanReportOutbox {
  return {
    load: () => {
      if (!existsSync(filePath)) return [];
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as {
        version?: unknown;
        batches?: unknown;
      };
      if (parsed.version !== 1 || !Array.isArray(parsed.batches)) {
        throw new Error(`Invalid orphan report outbox at ${filePath}; refusing to overwrite retained report evidence.`);
      }
      return parsed.batches.map((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error(`Invalid orphan report outbox batch ${index} at ${filePath}.`);
        }
        const raw = value as Record<string, unknown>;
        if (typeof raw.sessionId !== 'string' || !raw.sessionId) {
          throw new Error(`Invalid orphan report outbox batch ${index} at ${filePath}.`);
        }
        const legacyReport = parseOutboxReport(raw.report);
        const rawChunks = Array.isArray(raw.chunks)
          ? raw.chunks
          : legacyReport
            ? chunkSessionReports(raw.sessionId, [legacyReport])
            : null;
        if (!rawChunks) {
          throw new Error(`Invalid orphan report outbox batch ${index} at ${filePath}.`);
        }
        const chunks = rawChunks.map((chunkValue) => {
          if (!chunkValue || typeof chunkValue !== 'object' || Array.isArray(chunkValue)) return null;
          const chunkRaw = chunkValue as Record<string, unknown>;
          const report = parseOutboxReport(chunkRaw.report);
          const attempts = chunkRaw.attempts === undefined ? 0 : chunkRaw.attempts;
          const nextAttemptAtMs = chunkRaw.nextAttemptAtMs === undefined ? 0 : chunkRaw.nextAttemptAtMs;
          if (
            !report
            || report.directive.length > MAX_REPORT_DIRECTIVE_CHARS
            || !Number.isSafeInteger(attempts)
            || Number(attempts) < 0
            || typeof nextAttemptAtMs !== 'number'
            || !Number.isFinite(nextAttemptAtMs)
            || nextAttemptAtMs < 0
          ) return null;
          return { report, attempts: Number(attempts), nextAttemptAtMs };
        });
        if (chunks.length === 0 || chunks.some((chunk) => chunk === null)) {
          throw new Error(`Invalid orphan report outbox batch ${index} at ${filePath}.`);
        }
        const sourceCallIds = raw.sourceCallIds === undefined
          ? []
          : Array.isArray(raw.sourceCallIds)
            && raw.sourceCallIds.every((callId) => typeof callId === 'string' && callId.length > 0)
            ? raw.sourceCallIds
            : null;
        if (!sourceCallIds) {
          throw new Error(`Invalid orphan report outbox batch ${index} at ${filePath}.`);
        }
        return {
          sessionId: raw.sessionId,
          chunks: chunks as PendingReportChunk[],
          sourceCallIds,
        };
      });
    },
    save: (pending) => {
      mkdirSync(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const payload = JSON.stringify({
          version: 1,
          batches: Array.from(pending, ([sessionId, batch]) => ({
            sessionId,
            chunks: batch.chunks,
            sourceCallIds: batch.sourceCallIds,
          })),
        }, null, 2);
        const fd = openSync(tempPath, 'wx', 0o600);
        try {
          writeFileSync(fd, payload, { encoding: 'utf-8' });
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tempPath, filePath);
        // Best-effort directory fsync makes the rename survive a power loss on
        // filesystems that require the directory entry itself to be flushed.
        try {
          const dirFd = openSync(path.dirname(filePath), 'r');
          try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
        } catch { /* the fsynced file + atomic rename remain valid */ }
      } finally {
        try {
          if (existsSync(tempPath)) unlinkSync(tempPath);
        } catch { /* exact temp cleanup is best-effort */ }
      }
    },
  };
}

function createOrphanReportCoordinator(
  maxInFlight: number,
  outbox?: OrphanReportOutbox,
): OrphanReportCoordinator {
  const limit = Number.isFinite(maxInFlight) && maxInFlight > 0
    ? Math.max(1, Math.trunc(maxInFlight))
    : MAX_REPORT_TURNS_IN_FLIGHT;
  // `pending` owns the exact claimed directives until a report turn succeeds.
  // Production claims acknowledge their source only after this aggregate is
  // fsynced in the outbox.
  const pending = new Map<string, PendingReportBatch>();
  const inFlight = new Map<string, PendingReportBatch>();
  for (const stored of outbox?.load() ?? []) {
    pending.set(stored.sessionId, {
      chunks: stored.chunks,
      durable: true,
      sourceCallIds: stored.sourceCallIds,
      // Legacy outbox rows have no source IDs because their old drain already
      // acknowledged before persistence.
      sourceAcknowledged: stored.sourceCallIds.length === 0,
    });
  }

  const snapshot = (): Pick<OrphanReportSweepResult, 'inFlight' | 'pending'> => ({
    inFlight: inFlight.size,
    pending: pending.size,
  });

  const persistPending = (): void => {
    outbox?.save(pending);
    for (const batch of pending.values()) batch.durable = true;
  };

  const sweep = (deps: OrphanReportDeps): OrphanReportSweepResult => {
    let fired = 0;
    const since = new Date(deps.now() - ORPHAN_SWEEP_WINDOW_MS).toISOString();
    let recentSessionIds: string[] = [];
    try { recentSessionIds = deps.recentSessionIds(since); } catch { /* retained failures still retry below */ }
    // Failed/remaining batches go first and no longer depend on the
    // recent-session window. New source work stays claimable until capacity
    // and durable outbox ownership exist.
    const candidates = Array.from(new Set([...pending.keys(), ...recentSessionIds]));

    for (const sessionId of candidates) {
      if (inFlight.has(sessionId)) continue; // at most one report turn per session
      if (inFlight.size >= limit) break; // do not claim source work beyond capacity

      let batch = pending.get(sessionId);
      if (!batch) {
        let reports: OrphanedToolReport[];
        let claim: OrphanedToolCompletionClaim | undefined;
        try {
          if (deps.claim) {
            claim = deps.claim(sessionId);
            reports = claim.reports;
          } else {
            reports = deps.drain?.(sessionId) ?? [];
          }
        } catch {
          continue;
        }
        if (reports.length === 0) {
          // Expiration is cleanup, not report evidence, so it needs no outbox.
          // It remains idempotent and failures simply leave it claimable.
          if (claim && claim.expiredCallIds.length > 0) {
            try {
              claim.acknowledge(claim.expiredCallIds);
            } catch (error) {
              try { deps.onSourceAckFailure?.(sessionId, error); } catch { /* source remains claimable */ }
            }
          }
          continue;
        }
        const sourceCallIds = claim?.sourceCallIds ?? [];
        batch = {
          chunks: chunkSessionReports(sessionId, reports),
          durable: outbox === undefined,
          sourceCallIds,
          sourceAcknowledged: claim === undefined,
          acknowledgeSource: claim
            ? () => claim!.acknowledge(sourceCallIds)
            : undefined,
        };
        // Install retention before persistence and source acknowledgement.
        pending.set(sessionId, batch);
      }

      if (!batch.durable) {
        try {
          persistPending();
        } catch (error) {
          // Do not acknowledge or launch unpersisted work. Keep it in memory
          // and retry the atomic outbox write next tick; the source remains
          // claimable across a crash.
          try { deps.onOutboxFailure?.(sessionId, error); } catch { /* pending memory wins */ }
          break;
        }
      }

      if (!batch.sourceAcknowledged) {
        try {
          if (batch.acknowledgeSource) {
            batch.acknowledgeSource();
          } else if (deps.claim) {
            // A coordinator restored from disk has no closure. Re-claim the
            // session and acknowledge only the logical call IDs stored beside
            // its durable aggregate; newer completions remain untouched.
            deps.claim(sessionId).acknowledge(batch.sourceCallIds);
          } else {
            throw new Error('cannot acknowledge restored orphan report source without a claim dependency');
          }
          batch.sourceAcknowledged = true;
          batch.acknowledgeSource = undefined;
        } catch (error) {
          try { deps.onSourceAckFailure?.(sessionId, error); } catch { /* durable outbox wins */ }
          continue;
        }
      }

      const chunk = batch.chunks[0];
      if (!chunk) {
        pending.delete(sessionId);
        try {
          persistPending();
        } catch {
          pending.set(sessionId, batch);
        }
        continue;
      }
      if (chunk.nextAttemptAtMs > deps.now()) continue;

      inFlight.set(sessionId, batch);
      fired += 1;
      const admittedBatch = batch;
      const admittedChunk = chunk;
      void (async () => {
        try {
          await deps.fire(sessionId, admittedChunk.report);
          if (pending.get(sessionId) === admittedBatch) {
            if (admittedBatch.chunks[0] !== admittedChunk) return;
            admittedBatch.chunks.shift();
            if (admittedBatch.chunks.length === 0) pending.delete(sessionId);
            try {
              // Advance/delete the durable queue only after this chunk
              // succeeds. Remaining chunks stay serial for the same session.
              persistPending();
            } catch (error) {
              admittedBatch.chunks.unshift(admittedChunk);
              pending.set(sessionId, admittedBatch);
              try { deps.onOutboxFailure?.(sessionId, error); } catch { /* retained retry wins */ }
              throw error;
            }
          }
        } catch (error) {
          // Persist deterministic capped backoff with the exact chunk, so a
          // daemon restart cannot turn a persistent provider failure into a
          // retry on every short tick.
          if (
            pending.get(sessionId) === admittedBatch
            && admittedBatch.chunks[0] === admittedChunk
          ) {
            admittedChunk.attempts += 1;
            admittedChunk.nextAttemptAtMs = deps.now() + retryDelayMs(admittedChunk.attempts);
            try {
              persistPending();
            } catch (persistError) {
              try { deps.onOutboxFailure?.(sessionId, persistError); } catch { /* in-memory backoff wins */ }
            }
          }
          try { deps.onFireFailure?.(sessionId, admittedChunk.report, error); } catch { /* retry state wins */ }
        } finally {
          if (inFlight.get(sessionId) === admittedBatch) inFlight.delete(sessionId);
        }
      })();
    }

    return { fired, ...snapshot() };
  };

  return { sweep, snapshot };
}

let liveCoordinator: OrphanReportCoordinator | undefined;

function getLiveCoordinator(): OrphanReportCoordinator {
  // Lazy construction keeps importing this module side-effect free. A corrupt
  // outbox throws before any new source rows are drained, preserving the file
  // for operator recovery instead of silently overwriting report evidence.
  liveCoordinator ??= createOrphanReportCoordinator(
    MAX_REPORT_TURNS_IN_FLIGHT,
    fileOutbox(ORPHAN_REPORT_OUTBOX_FILE),
  );
  return liveCoordinator;
}

/** Test factory keeps async coordinator state isolated between cases. */
export const _testOnly_createOrphanReportCoordinator = (
  maxInFlight = MAX_REPORT_TURNS_IN_FLIGHT,
  outboxFile?: string,
): OrphanReportCoordinator => createOrphanReportCoordinator(
  maxInFlight,
  outboxFile ? fileOutbox(outboxFile) : undefined,
);

/** Admit completed orphan reports without blocking the daemon loop. Capacity
 *  and retained failures live in the coordinator across repeated sweeps. */
export function sweepOrphanedToolReports(
  deps: OrphanReportDeps,
  coordinator?: OrphanReportCoordinator,
): OrphanReportSweepResult {
  return (coordinator ?? getLiveCoordinator()).sweep(deps);
}

/** Daemon entry point: wire the live seams (event-log sessions + drain, orchestrator
 *  runConversation) and run one sweep. Best-effort — never throws into the tick. */
export async function processOrphanedToolReports(): Promise<void> {
  try {
    const [{ claimOrphanedToolCompletions, runConversation }, { listSessions }, { buildOrchestratorAgent }] = await Promise.all([
      import('../runtime/harness/loop.js'),
      import('../runtime/harness/eventlog.js'),
      import('../agents/orchestrator.js'),
    ]);
    const result = sweepOrphanedToolReports({
      now: () => Date.now(),
      recentSessionIds: (sinceIso) => {
        try { return listSessions({ updatedAfter: sinceIso, limit: 200 }).map((s) => s.id); } catch { return []; }
      },
      claim: (sessionId) => claimOrphanedToolCompletions(sessionId),
      fire: async (sessionId, report) => {
        const agent = await buildOrchestratorAgent({ userInput: report.directive, sessionId });
        const outcome = await runConversation({ agent, sessionId, input: report.directive });
        // RunConversationResult documents completedReason only for a nominal
        // `completed` status that is actually a dead turn (parse exhaustion or
        // sub-agent stall). Ordinary successful completions leave it unset.
        if (outcome.status !== 'completed' || outcome.completedReason) {
          throw new Error(
            `orphan report turn did not complete (${outcome.completedReason ?? outcome.status}${outcome.error ? `: ${outcome.error}` : ''})`,
          );
        }
      },
      onFireFailure: (sessionId, report, err) => logger.warn(
        { err: err instanceof Error ? err.message : err, sessionId, callId: report.callId },
        'orphan report turn failed; retained for retry',
      ),
      onOutboxFailure: (sessionId, err) => logger.error(
        { err: err instanceof Error ? err.message : err, sessionId, outbox: ORPHAN_REPORT_OUTBOX_FILE },
        'orphan report outbox update failed; source remains claimable and no unpersisted turn launched',
      ),
      onSourceAckFailure: (sessionId, err) => logger.error(
        { err: err instanceof Error ? err.message : err, sessionId, outbox: ORPHAN_REPORT_OUTBOX_FILE },
        'orphan report source acknowledgement failed; durable outbox retained for retry',
      ),
    });
    if (result.fired > 0) logger.info(result, 'stranded-tool report turns admitted');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'processOrphanedToolReports failed');
  }
}
