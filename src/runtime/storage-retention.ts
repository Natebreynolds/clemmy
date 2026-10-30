/**
 * Keep Clem's footprint inside a budget without losing what she learned.
 *
 * Clem keeps three kinds of things. Memory (facts, preferences, recipes) is
 * small and stays; it fades only by disuse, on its own clock. Records
 * (conversations, run reports) stay. Working copies are what a task needed
 * while it ran: the full copy of every request sent to a model, raw tool
 * results, step checkpoints. They are kept while a task can still resume or be
 * checked, then they go. Working copies were never given an end date, and they
 * are nearly all of the bytes.
 *
 * This pass is the one owner of that end date. It distills before it deletes
 * (recoverable facts are copied out of tool results first), deletes nothing a
 * running task or a recent conversation still reads, and records what it did.
 * When the footprint is still over budget after the ordinary window, the window
 * for working copies tightens; memory is never a candidate.
 *
 * Enforcing is the default: an install bounds itself the way a production one
 * must. An operator may set `CLEMMY_STORAGE_RETENTION=report` to measure only,
 * or `off`.
 */
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { BASE_DIR } from '../config.js';

export type StorageRetentionMode = 'enforce' | 'report' | 'off';

export interface StorageRetentionPolicy {
  mode: StorageRetentionMode;
  budgetBytes: number;
  /** How long working copies are kept after their task. */
  scratchDays: number;
  /** A conversation touched this recently keeps its newest request copies. */
  recentConversationDays: number;
  /** Request copies a recent conversation keeps (later turns read the newest few). */
  keepRequestCopiesPerConversation: number;
  /** Past this age a request copy goes whatever the conversation is doing: a
   *  restart projector is not going to reopen a month-old request. */
  maxRequestCopyDays: number;
}

const GB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Tighter windows for working copies when the footprint is still over budget. */
const OVER_BUDGET_SCRATCH_DAYS = [3, 1] as const;

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export function storageRetentionPolicy(env: NodeJS.ProcessEnv = process.env): StorageRetentionPolicy {
  const mode = (env.CLEMMY_STORAGE_RETENTION ?? '').trim().toLowerCase();
  return {
    mode: mode === 'report' || mode === 'off' ? mode : 'enforce',
    budgetBytes: Math.round(boundedNumber(env.CLEMMY_STORAGE_BUDGET_GB, 10, 1, 1_000) * GB),
    scratchDays: Math.floor(boundedNumber(env.CLEMMY_STORAGE_SCRATCH_DAYS, 7, 1, 90)),
    recentConversationDays: 30,
    keepRequestCopiesPerConversation: 3,
    maxRequestCopyDays: 30,
  };
}

export interface RequestCopyRow {
  sessionId: string;
  sourceUserSeq: number;
  requestOrdinal: number;
  payloadId: string;
  createdAt: string;
}

/**
 * The request copies whose working life is over: older than the window, not
 * in a conversation with a task still running, and not among the newest few
 * of a conversation touched recently (a later turn reads those to recover the
 * exact text of earlier messages; without them the text simply stays live).
 */
export function selectExpiredRequestCopies(rows: readonly RequestCopyRow[], input: {
  nowMs: number;
  scratchDays: number;
  recentConversationDays: number;
  keepPerConversation: number;
  maxDays?: number;
  conversationUpdatedAt: ReadonlyMap<string, string>;
  liveConversations: ReadonlySet<string>;
}): string[] {
  const cutoff = new Date(input.nowMs - input.scratchDays * DAY_MS).toISOString();
  const recent = new Date(input.nowMs - input.recentConversationDays * DAY_MS).toISOString();
  const hardCutoff = input.maxDays === undefined ? null : new Date(input.nowMs - input.maxDays * DAY_MS).toISOString();
  const newestFirst = [...rows].sort((left, right) => left.sessionId.localeCompare(right.sessionId)
    || right.sourceUserSeq - left.sourceUserSeq || right.requestOrdinal - left.requestOrdinal);
  const seen = new Map<string, number>();
  const expired: string[] = [];
  for (const row of newestFirst) {
    const rank = seen.get(row.sessionId) ?? 0;
    seen.set(row.sessionId, rank + 1);
    if (!row.payloadId || row.createdAt >= cutoff) continue;
    if (hardCutoff !== null && row.createdAt < hardCutoff) { expired.push(row.payloadId); continue; }
    if (input.liveConversations.has(row.sessionId)) continue;
    const touched = input.conversationUpdatedAt.get(row.sessionId);
    if (touched !== undefined && touched >= recent && rank < input.keepPerConversation) continue;
    expired.push(row.payloadId);
  }
  return expired;
}

export interface StorageRetentionClassResult {
  eligible: number;
  eligibleBytes: number;
  removed: number;
  removedBytes: number;
}

export interface StorageRetentionReport {
  version: 1;
  at: string;
  mode: StorageRetentionMode;
  budgetBytes: number;
  scratchDays: number;
  footprintBefore: number | null;
  footprintAfter: number | null;
  footprintComplete: boolean;
  requestCopies: StorageRetentionClassResult;
  orphanPayloads: { removed: number };
  toolResults: { removedRows: number; distilled: boolean };
  pythonToolCache: { pruned: boolean; detail?: string };
  /** Bytes still over budget, and what holds them, when the budget is not met. */
  overBudgetBytes: number;
  notes: string[];
}

const emptyClass = (): StorageRetentionClassResult => ({ eligible: 0, eligibleBytes: 0, removed: 0, removedBytes: 0 });

export const STORAGE_RETENTION_REPORT_PATH = path.join(BASE_DIR, 'state', 'storage-retention.json');

export function readStorageRetentionReport(file = STORAGE_RETENTION_REPORT_PATH): StorageRetentionReport | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StorageRetentionReport;
    return parsed?.version === 1 ? parsed : null;
  } catch { return null; }
}

function writeReport(report: StorageRetentionReport, file: string): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(report, null, 2));
    renameSync(tmp, file);
  } catch { /* the report is a record, never a reason to fail the pass */ }
}

export interface StorageRetentionDependencies {
  db: () => Database.Database;
  payloadFilePath: (payloadId: string) => string;
  /** One bounded batch from `startAfter`; `nextCursor` null once the folder is done. */
  reclaimOrphans: (db: Database.Database, startAfter: string | null) => { deletedPayloadFiles: number; nextCursor: string | null };
  distillToolResults: () => void;
  reapToolResults: (days: number) => number;
  footprint: () => Promise<{ totalBytes: number; complete: boolean } | null>;
  prunePythonToolCache: () => Promise<{ pruned: boolean; detail?: string }>;
  yieldTurn: () => Promise<void>;
  now: () => number;
  reportFile: string;
}

function readRequestCopyRows(db: Database.Database): RequestCopyRow[] {
  return (db.prepare(`SELECT session_id, source_user_seq, request_ordinal, payload_id, created_at
      FROM model_request_provenance`).all() as Array<{
    session_id: string; source_user_seq: number; request_ordinal: number; payload_id: string | null; created_at: string;
  }>).map((row) => ({ sessionId: row.session_id, sourceUserSeq: row.source_user_seq,
    requestOrdinal: row.request_ordinal, payloadId: row.payload_id ?? '', createdAt: row.created_at }));
}

function conversationFacts(db: Database.Database): { updatedAt: Map<string, string>; live: Set<string> } {
  const updatedAt = new Map((db.prepare('SELECT id, updated_at FROM sessions').all() as Array<{ id: string; updated_at: string }>)
    .map((row) => [row.id, row.updated_at]));
  const live = new Set((db.prepare(`SELECT DISTINCT session_id FROM run_attempts WHERE finished_at IS NULL`).all() as Array<{ session_id: string }>)
    .map((row) => row.session_id));
  return { updatedAt, live };
}

async function removeRequestCopies(payloadIds: readonly string[], deps: StorageRetentionDependencies, enforce: boolean,
  result: StorageRetentionClassResult, counted: Set<string>): Promise<void> {
  let sinceYield = 0;
  for (const payloadId of payloadIds) {
    // A tighter window re-selects what a wider one already counted.
    if (counted.has(payloadId)) continue;
    counted.add(payloadId);
    let file: string;
    try { file = deps.payloadFilePath(payloadId); } catch { continue; }
    let bytes = 0;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile()) continue;
      bytes = stat.size;
    } catch { continue; }
    result.eligible += 1;
    result.eligibleBytes += bytes;
    if (enforce) {
      try { unlinkSync(file); result.removed += 1; result.removedBytes += bytes; } catch { /* retried next pass */ }
    }
    sinceYield += 1;
    if (sinceYield >= 100) { sinceYield = 0; await deps.yieldTurn(); }
  }
}

export async function runStorageRetention(policy: StorageRetentionPolicy, deps: StorageRetentionDependencies): Promise<StorageRetentionReport> {
  const enforce = policy.mode === 'enforce';
  const report: StorageRetentionReport = {
    version: 1, at: new Date(deps.now()).toISOString(), mode: policy.mode, budgetBytes: policy.budgetBytes,
    scratchDays: policy.scratchDays, footprintBefore: null, footprintAfter: null, footprintComplete: false,
    requestCopies: emptyClass(), orphanPayloads: { removed: 0 }, toolResults: { removedRows: 0, distilled: false },
    pythonToolCache: { pruned: false }, overBudgetBytes: 0, notes: [],
  };
  if (policy.mode === 'off') { report.notes.push('Storage retention is off.'); writeReport(report, deps.reportFile); return report; }
  const before = await deps.footprint();
  report.footprintBefore = before?.totalBytes ?? null;
  report.footprintComplete = before?.complete ?? false;

  const db = deps.db();
  const counted = new Set<string>();
  const windows = [policy.scratchDays, ...OVER_BUDGET_SCRATCH_DAYS.filter((days) => days < policy.scratchDays)];
  let footprint = before?.totalBytes ?? null;
  for (const [index, scratchDays] of windows.entries()) {
    if (index > 0 && (footprint === null || footprint <= policy.budgetBytes)) break;
    if (index > 0) report.notes.push(`Still over budget; working copies kept ${scratchDays} day${scratchDays === 1 ? '' : 's'} instead.`);
    report.scratchDays = scratchDays;
    const facts = conversationFacts(db);
    const expired = selectExpiredRequestCopies(readRequestCopyRows(db), {
      nowMs: deps.now(), scratchDays, recentConversationDays: policy.recentConversationDays,
      keepPerConversation: policy.keepRequestCopiesPerConversation,
      maxDays: policy.maxRequestCopyDays,
      conversationUpdatedAt: facts.updatedAt, liveConversations: facts.live,
    });
    const pass = emptyClass();
    await removeRequestCopies(expired, deps, enforce, pass, counted);
    report.requestCopies.eligible += pass.eligible;
    report.requestCopies.eligibleBytes += pass.eligibleBytes;
    report.requestCopies.removed += pass.removed;
    report.requestCopies.removedBytes += pass.removedBytes;
    if (enforce) {
      // Distill before deleting: recoverable facts are copied out of tool
      // results into memory first, exactly as an operator purge does.
      try { deps.distillToolResults(); report.toolResults.distilled = true; } catch { report.notes.push('Distilling tool results failed; they were kept.'); }
      if (report.toolResults.distilled) {
        try { report.toolResults.removedRows += deps.reapToolResults(scratchDays); } catch { report.notes.push('Removing old tool results failed.'); }
      }
      await deps.yieldTurn();
    }
    if (footprint !== null) footprint -= enforce ? pass.removedBytes : pass.eligibleBytes;
  }
  if (enforce) {
    // The whole folder, in batches: a single bounded scan reread the same
    // first entries every day and never reached most of the folder.
    try {
      let cursor: string | null = null;
      for (let batch = 0; batch < MAX_ORPHAN_BATCHES; batch += 1) {
        const swept: { deletedPayloadFiles: number; nextCursor: string | null } = deps.reclaimOrphans(db, cursor);
        report.orphanPayloads.removed += swept.deletedPayloadFiles;
        if (swept.nextCursor === null || swept.nextCursor === cursor) break;
        cursor = swept.nextCursor;
        await deps.yieldTurn();
      }
    } catch { report.notes.push('Unreferenced copies could not be checked.'); }
    report.pythonToolCache = await deps.prunePythonToolCache();
  }
  const after = enforce ? await deps.footprint() : null;
  report.footprintAfter = after?.totalBytes ?? footprint;
  report.overBudgetBytes = Math.max(0, (report.footprintAfter ?? 0) - policy.budgetBytes);
  if (report.overBudgetBytes > 0) {
    report.notes.push('Turn checkpoints (whole-conversation copies saved at every step) and plug-in tool caches are not trimmed yet; they hold most of what remains.');
  }
  writeReport(report, deps.reportFile);
  return report;
}

/** Remove what the Python tool cache no longer uses, with uv's own command. */
export async function prunePythonToolCache(input: { uvCommand: string | null; cacheDir: string; timeoutMs?: number }): Promise<{ pruned: boolean; detail?: string }> {
  if (!input.uvCommand) return { pruned: false, detail: 'uv is not available' };
  if (!existsSync(input.cacheDir)) return { pruned: false, detail: 'no cache' };
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(input.uvCommand!, ['cache', 'prune'], {
      env: { ...process.env, UV_CACHE_DIR: input.cacheDir, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, input.timeoutMs ?? 10 * 60_000);
    child.stdout?.on('data', (chunk) => { output = (output + String(chunk)).slice(-400); });
    child.stderr?.on('data', (chunk) => { output = (output + String(chunk)).slice(-400); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ pruned: false, detail: error.message.slice(0, 200) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ pruned: code === 0, detail: output.trim().split('\n').pop()?.slice(0, 200) }); });
  });
}

/** Small batches keep each synchronous step short; the cap only stops a runaway. */
const ORPHAN_BATCH = 512;
const MAX_ORPHAN_BATCHES = 2_000;

const DUE_FILE = path.join(BASE_DIR, 'state', 'storage-retention-due.json');
const PASS_INTERVAL_MS = DAY_MS;

/** Once a day on a persisted clock: a daemon that restarts often still runs it. */
export function storageRetentionDue(nowMs: number, file = DUE_FILE): boolean {
  try {
    const last = Number((JSON.parse(readFileSync(file, 'utf8')) as { lastRunMs?: unknown }).lastRunMs);
    return !Number.isFinite(last) || nowMs - last >= PASS_INTERVAL_MS;
  } catch { return true; }
}

export function markStorageRetentionRun(nowMs: number, file = DUE_FILE): void {
  try { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ lastRunMs: nowMs })); } catch { /* next tick retries */ }
}

/** The production pass: the event log, the encrypted copy store, the memory
 *  distiller and the storage inventory, wired once. */
export async function runProductionStorageRetention(policy = storageRetentionPolicy()): Promise<StorageRetentionReport> {
  const [{ openEventLog, reapStaleToolOutputs }, payloads, { backfillTemporalEvidence }, { createStorageInventoryReader }, { resolveUv }, phase] = await Promise.all([
    import('./harness/eventlog.js'),
    import('./harness/authority-encrypted-payload-store.js'),
    import('../memory/temporal-memory.js'),
    import('./storage-inventory.js'),
    import('./markitdown.js'),
    import('../daemon/phase.js'),
  ]);
  return runStorageRetention(policy, {
    db: openEventLog,
    payloadFilePath: payloads.authorityEncryptedPayloadFilePath,
    reclaimOrphans: (db, startAfter) => payloads.reclaimOrphanedAuthorityEncryptedPayloads({ db, scanLimit: ORPHAN_BATCH, startAfter }),
    distillToolResults: () => { backfillTemporalEvidence(2_000); },
    reapToolResults: (days) => reapStaleToolOutputs(days),
    footprint: async () => {
      // Its own reader: the Settings reader caches for minutes, and the
      // after-measurement must see this pass's deletions.
      try {
        const inventory = await createStorageInventoryReader({ baseDir: BASE_DIR, cacheMs: 1, maxDurationMs: 60_000, maxEntries: 500_000 })();
        return { totalBytes: inventory.totalBytes, complete: inventory.complete };
      } catch { return null; }
    },
    prunePythonToolCache: () => {
      const uv = resolveUv();
      return prunePythonToolCache({ uvCommand: 'error' in uv ? null : uv.command, cacheDir: path.join(BASE_DIR, 'runtime', 'uv-cache') });
    },
    yieldTurn: phase.yieldToEventLoop,
    now: Date.now,
    reportFile: STORAGE_RETENTION_REPORT_PATH,
  });
}
