/**
 * Composio background job-watcher — a DETERMINISTIC harness poller (NOT an LLM
 * worker).
 *
 * When a Composio call returns a long-running queued receipt that the inline
 * auto-poll can't resolve in its budget (a genuinely-long Apify scrape) or that
 * needs a live getter lookup (DataForSEO / Firecrawl), the call-site PARKS it here.
 * We create a background task (goal-bound for free, so it shows on the board and
 * reports back to the origin session), immediately mark it RUNNING so the
 * pending-drain never spawns an LLM for it, and then a 15s daemon tick polls the
 * job via the S1 family recipes until it terminates — delivering the REAL result
 * through the existing background-task report-back.
 *
 * Durable records live at `state/composio-jobs/<family>-<jobId>.json`, so a daemon
 * restart mid-poll degrades gracefully: the running background task is interrupted
 * on boot and re-spawned as an LLM task carrying the self-contained poll prompt,
 * and the watcher — seeing the task is no longer 'running' — drops its record, so
 * there is always EXACTLY ONE owner.
 *
 * Kill-switch: CLEMMY_COMPOSIO_BG_DEFER (default on). Off ⇒ parkComposioJob no-ops
 * and the call-site keeps the id-bearing banner (never worse than today).
 */
import path from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { BASE_DIR, getRuntimeEnv } from '../../config.js';
import {
  createBackgroundTask,
  getBackgroundTask,
  markBackgroundTaskRunning,
  markBackgroundTaskDone,
  markBackgroundTaskFailed,
  markBackgroundTaskBlocked,
  updateBackgroundTask,
  type BackgroundTaskRecord,
  type BackgroundTaskStatus,
} from '../../execution/background-tasks.js';
import {
  asyncReceiptBanner,
  checkJobOnce,
  recipeFor,
  resolveJobGetter,
  type ComposioExec,
  type JobFamily,
  type JobReceipt,
  type PollPlan,
} from './async-job.js';

const JOB_DIR = path.join(BASE_DIR, 'state', 'composio-jobs');

/** DEFAULT ON. Off ⇒ never park; the call-site keeps the id-bearing banner. */
export function composioBgDeferEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_COMPOSIO_BG_DEFER', 'on') ?? 'on').toLowerCase() !== 'off';
}

function jobWatchMaxMs(): number {
  // 60 min default: past this the job is treated as stuck and the task is BLOCKED
  // with id-bearing guidance rather than polled forever.
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_COMPOSIO_JOB_WATCH_MAX_MS', '3600000') ?? '3600000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3_600_000;
}

/** A durable record of one parked Composio job the watcher owns. */
export interface ComposioJobRecord {
  family: JobFamily;
  jobId: string;
  datasetId?: string;
  actorId?: string;
  /** The result-getter slug once discovered (DataForSEO/Firecrawl); cached so we
   *  don't re-discover every tick. */
  getterSlug?: string;
  toolSlug: string;
  connectionId: string;
  originSessionId?: string;
  taskId: string;
  createdAt: string;
  deadlineAt: string;
  polls: number;
  nextPollAt: string;
  lastStatus?: string;
}

/** Context the call-site passes when parking a job. */
export interface ParkContext {
  toolSlug: string;
  connectionId?: string;
  originSessionId?: string;
  userId?: string;
  channel?: string;
  source?: BackgroundTaskRecord['source'];
}

export interface ParkResult {
  taskId: string;
  deduped: boolean;
}

/** The tick's exec — connection-bound per record (the daemon binds
 *  executeComposioTool, whose 3rd arg is the connected account id). */
export type ConnectionBoundExec = (
  slug: string,
  args: Record<string, unknown>,
  connectionId?: string,
) => Promise<unknown>;

// A background task in one of these states is "over" for dedup purposes — a new
// park for the same job is a fresh request, not a duplicate.
const DEDUP_TERMINAL: ReadonlySet<BackgroundTaskStatus> = new Set<BackgroundTaskStatus>([
  'done',
  'failed',
  'aborted',
  'blocked',
  'interrupted',
]);

function ensureDir(): void {
  mkdirSync(JOB_DIR, { recursive: true });
}

function safeSegment(value: string): string {
  return (value || '').replace(/[^A-Za-z0-9._-]/g, '_');
}

function recordPath(family: string, jobId: string): string {
  return path.join(JOB_DIR, `${safeSegment(String(family))}-${safeSegment(jobId)}.json`);
}

function readRecord(file: string): ComposioJobRecord | null {
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as ComposioJobRecord;
    if (!parsed || !parsed.jobId || !parsed.family || !parsed.taskId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeRecord(record: ComposioJobRecord): void {
  ensureDir();
  writeFileSync(recordPath(record.family, record.jobId), JSON.stringify(record, null, 2));
}

function deleteRecord(record: Pick<ComposioJobRecord, 'family' | 'jobId'>): void {
  try {
    const file = recordPath(record.family, record.jobId);
    if (existsSync(file)) unlinkSync(file);
  } catch {
    /* best-effort — a lingering record is re-checked next tick, never double-owned */
  }
}

/** Reconstruct a JobReceipt from a durable record so the S1 recipes can poll it. */
function receiptFromRecord(record: ComposioJobRecord): JobReceipt {
  return {
    family: record.family,
    jobId: record.jobId,
    datasetId: record.datasetId,
    actorId: record.actorId,
    status: record.lastStatus,
    originSlug: record.toolSlug,
    pollGuidance: '',
  };
}

/** A self-contained, model-runnable poll prompt for the LLM-resume degradation
 *  path (used only if the daemon restarts mid-poll and the task is re-spawned). */
function buildPollPrompt(receipt: JobReceipt, ctx: ParkContext): string {
  const lines = [
    `A Composio ${receipt.family} job was started asynchronously and now needs to be polled to completion — then its REAL result reported back.`,
    '',
    receipt.pollGuidance || asyncReceiptBanner(receipt),
    '',
    `Job id: ${receipt.jobId}`,
  ];
  if (receipt.datasetId) lines.push(`Dataset id: ${receipt.datasetId}`);
  if (receipt.actorId) lines.push(`Actor id: ${receipt.actorId}`);
  if (receipt.originSlug) lines.push(`Originating tool: ${receipt.originSlug}`);
  lines.push(`Connected account: ${ctx.connectionId || '(default)'}`);
  lines.push(
    '',
    'Poll until the job finishes, fetch the real output, and report it. Do NOT report the queued receipt as the answer.',
  );
  return lines.join('\n');
}

/**
 * Park a queued Composio job for the background watcher. Dedups by family:jobId —
 * an existing record whose task is still non-terminal returns that taskId. Otherwise
 * creates a background task (goal-bound to the origin session), immediately marks it
 * RUNNING so the pending-drain never spawns an LLM for it (the watcher owns the
 * lifecycle), and writes the durable record. Returns null when the flag is off or the
 * receipt is unusable — the caller then keeps the banner (fail-open, never worse).
 */
export function parkComposioJob(receipt: JobReceipt, ctx: ParkContext): ParkResult | null {
  if (!composioBgDeferEnabled()) return null;
  if (!receipt?.jobId || !receipt?.family) return null;

  ensureDir();
  const file = recordPath(receipt.family, receipt.jobId);

  // Dedup: same job already parked and still running/pending → reuse it.
  if (existsSync(file)) {
    const existing = readRecord(file);
    if (existing) {
      const task = getBackgroundTask(existing.taskId);
      if (task && !DEDUP_TERMINAL.has(task.status)) {
        return { taskId: existing.taskId, deduped: true };
      }
    }
    // Stale/terminal record — fall through and re-park fresh.
  }

  const task = createBackgroundTask({
    title: `Composio ${receipt.family} job ${receipt.jobId}`.slice(0, 120),
    prompt: buildPollPrompt(receipt, ctx),
    originSessionId: ctx.originSessionId,
    userId: ctx.userId,
    channel: ctx.channel,
    source: ctx.source ?? 'gateway',
    maxMinutes: Math.max(1, Math.ceil(jobWatchMaxMs() / 60_000)),
  });
  // Immediately RUNNING: the watcher owns the lifecycle; the pending-drain must
  // never pick this up and spawn an LLM for it.
  markBackgroundTaskRunning(task.id);

  const now = Date.now();
  const record: ComposioJobRecord = {
    family: receipt.family,
    jobId: receipt.jobId,
    datasetId: receipt.datasetId,
    actorId: receipt.actorId,
    getterSlug: (receipt as { getterSlug?: string }).getterSlug,
    toolSlug: ctx.toolSlug,
    connectionId: ctx.connectionId ?? '',
    originSessionId: ctx.originSessionId,
    taskId: task.id,
    createdAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + jobWatchMaxMs()).toISOString(),
    polls: 0,
    nextPollAt: new Date(now).toISOString(),
    lastStatus: receipt.status,
  };
  writeRecord(record);
  return { taskId: task.id, deduped: false };
}

function pollBackoffMs(polls: number): number {
  // Gentle growth 15s → 60s: cheap on credits for a long watch while staying
  // responsive early. The daemon tick is 15s, so this is the per-record floor.
  return Math.min(15_000 * Math.max(1, polls), 60_000);
}

function bumpAndReschedule(record: ComposioJobRecord, now: number, message: string): void {
  record.polls += 1;
  record.nextPollAt = new Date(now + pollBackoffMs(record.polls)).toISOString();
  writeRecord(record);
  // Heartbeat via updateBackgroundTask: bumps updatedAt (satisfies the running-stall
  // watchdog) and shows progress on the board.
  updateBackgroundTask(record.taskId, {
    lastCheckInAt: new Date(now).toISOString(),
    lastCheckInMessage: message,
    progressCheckIns: record.polls,
  });
}

/** The first array of items nested in a terminal result (best-effort). */
function firstItemArray(result: unknown): unknown[] | null {
  const seen: unknown[] = [result];
  for (let i = 0; i < seen.length && i < 6; i += 1) {
    const v = seen[i];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const key of ['items', 'data', 'results', 'records', 'tasks']) {
        if (key in o) seen.push(o[key]);
      }
    }
  }
  return null;
}

/** Count items in a terminal result for the done summary (best-effort). */
function countItems(result: unknown): number | null {
  const items = firstItemArray(result);
  return items ? items.length : null;
}

function doneSummary(record: ComposioJobRecord, result: unknown): string {
  const n = countItems(result);
  const countNote = n !== null ? ` It returned ${n} item${n === 1 ? '' : 's'}.` : '';
  let body: string;
  try {
    body = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  } catch {
    body = String(result);
  }
  return `The Composio ${record.family} job ${record.jobId} finished — this is the real result.${countNote}\n\n${body}`;
}

/** Clip a single field value so a preview line stays short. */
function clipField(value: string): string {
  const v = value.trim().replace(/\s+/g, ' ');
  return v.length > 80 ? `${v.slice(0, 79)}…` : v;
}

/** A short, readable one-liner for a single result item (best-effort). Picks up
 *  to 3 string/number fields from an object; strings/numbers stand alone. */
function readableItemLine(item: unknown): string {
  if (item == null) return '';
  if (typeof item === 'string') return clipField(item);
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  if (typeof item !== 'object') return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
    if (parts.length >= 3) break;
    if (typeof value === 'string' && value.trim()) parts.push(`${key}: ${clipField(value)}`);
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(`${key}: ${value}`);
  }
  return parts.join(' · ');
}

/**
 * The HUMAN-facing completion notification for a Composio job: a conversational
 * sentence plus up to 3 readable preview lines derived from the items — NOT the
 * raw JSON. The full JSON stays in the model-facing `result` (doneSummary).
 * Best-effort: any gap degrades to just the sentence.
 */
export function humanJobNotification(record: ComposioJobRecord, result: unknown): string {
  const n = countItems(result);
  const head = n !== null
    ? `Your ${record.family} job finished — ${n} item${n === 1 ? '' : 's'} retrieved.`
    : `Your ${record.family} job finished.`;
  let preview: string[] = [];
  try {
    const items = firstItemArray(result) ?? [];
    for (const item of items) {
      if (preview.length >= 3) break;
      const line = readableItemLine(item);
      if (line) preview.push(`- ${line}`);
    }
  } catch {
    preview = [];
  }
  return preview.length ? `${head}\n\n${preview.join('\n')}` : head;
}

function deadlineGuidance(record: ComposioJobRecord): string {
  return (
    `The Composio ${record.family} job ${record.jobId} did not finish within the watch window `
    + `(${Math.round(jobWatchMaxMs() / 60_000)} min). It may still be running remotely — check it manually with `
    + `${record.getterSlug ? `${record.getterSlug} ` : 'the matching result-getter '}and id="${record.jobId}"`
    + `${record.datasetId ? ` (dataset "${record.datasetId}")` : ''}, or re-run with a smaller scope.`
  );
}

/**
 * One watcher tick. Polls every DUE record once via its S1 recipe, updates the
 * task heartbeat, delivers the real result on completion (report-back → origin
 * session), and blocks past the deadline. Drops any record whose task is no longer
 * running (cancelled / resumed into an LLM task / already terminal) so exactly one
 * owner remains. `exec` executes a Composio tool bound to the record's connectionId.
 * Returns the number of records it processed (due this tick).
 */
export async function processComposioJobWatchTick(
  exec: ConnectionBoundExec,
  opts: { now?: () => number } = {},
): Promise<number> {
  if (!existsSync(JOB_DIR)) return 0;
  const now = (opts.now ?? Date.now)();
  const files = readdirSync(JOB_DIR).filter((f) => f.endsWith('.json'));
  let processed = 0;

  for (const f of files) {
    const file = path.join(JOB_DIR, f);
    const record = readRecord(file);
    if (!record) {
      try { unlinkSync(file); } catch { /* ignore */ }
      continue;
    }
    // Not due yet.
    if (Date.parse(record.nextPollAt) > now) continue;

    // Ownership: exactly one owner. If the task is gone or no longer running
    // (cancelled by the user / resumed into a fresh LLM task / already terminal),
    // this watcher no longer owns the job — drop the record.
    const task = getBackgroundTask(record.taskId);
    if (!task || task.status !== 'running') {
      deleteRecord(record);
      continue;
    }

    processed += 1;

    // Past the watch deadline → block honestly (do NOT poll forever).
    if (Date.parse(record.deadlineAt) <= now) {
      const guidance = deadlineGuidance(record);
      markBackgroundTaskBlocked(record.taskId, guidance, guidance);
      deleteRecord(record);
      continue;
    }

    const boundExec: ComposioExec = (slug, args) => exec(slug, args, record.connectionId || undefined);

    // Resolve the result-getter once, then cache it on the record.
    let plan: PollPlan | null = record.getterSlug ? { getterSlug: record.getterSlug } : null;
    if (!plan) {
      // Apify needs no discovery (fixed slugs + ids); families with a getter do.
      const recipe = recipeFor(record.family);
      if (recipe?.poll) {
        try {
          plan = await resolveJobGetter(receiptFromRecord(record), boundExec, {});
        } catch {
          plan = null;
        }
        if (plan?.getterSlug) record.getterSlug = plan.getterSlug;
      }
    }
    if (!plan) {
      // Couldn't determine how to poll yet — heartbeat and retry (bounded by the
      // deadline). Never worse than the banner.
      bumpAndReschedule(record, now, `poll #${record.polls + 1} — getter not resolved yet`);
      continue;
    }

    let check;
    try {
      check = await checkJobOnce(plan, receiptFromRecord(record), boundExec);
    } catch (err) {
      // Transient poll/exec error — keep the record, retry next tick. A write is
      // NEVER auto-retried; polls are reads, safe to repeat.
      bumpAndReschedule(
        record,
        now,
        `poll #${record.polls + 1} — transient error: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (check.state === 'done') {
      markBackgroundTaskDone(
        record.taskId,
        doneSummary(record, check.result),
        { notificationBody: humanJobNotification(record, check.result) },
      );
      deleteRecord(record);
      continue;
    }
    if (check.state === 'failed') {
      const reason = check.reason ?? `${record.family} job ${record.jobId} did not complete`;
      markBackgroundTaskFailed(record.taskId, reason);
      deleteRecord(record);
      continue;
    }
    // pending
    record.lastStatus = check.reason ?? 'pending';
    bumpAndReschedule(record, now, `poll #${record.polls + 1} — status ${record.lastStatus}`);
  }

  return processed;
}
