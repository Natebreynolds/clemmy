/**
 * Composio async/queued-job awareness.
 *
 * Some Composio actions SUCCEED but only return a QUEUED RECEIPT, not the result:
 *  - DataForSEO `*_TASK_POST`  → `{ tasks: [{ id, result: null, status_code: 20100,
 *                                 status_message: "Task Created." }] }`
 *  - Apify `*_RUN_ACTOR`       → `{ id, status: "READY"|"RUNNING", finishedAt: null,
 *                                 defaultDatasetId }`  (output NOT inline)
 *  - Firecrawl async crawl     → `{ id, status: "scraping" }`
 *
 * A model that gets one of these can mistake the receipt for the answer and stop —
 * so the user never gets the data, and never got asked. This module DETECTS the
 * receipt shape (verified against real 2026-06-30 envelopes) and produces a precise
 * corrective naming the exact job id + the poll action, so the run continues to the
 * real result. Detection is SHAPE-based (+ a toolkit-prefix guard), never a blind
 * slug map — so it's inert on a normal result and can't misfire on the common case.
 *
 * Kill-switch CLEMMY_COMPOSIO_ASYNC_RESOLVE (default on).
 */
import { getRuntimeEnv } from '../../config.js';

export type JobFamily = 'dataforseo' | 'apify' | 'firecrawl';

export interface JobReceipt {
  family: JobFamily;
  /** The remote job/task/run id the model must poll on. */
  jobId: string;
  /** Apify: the dataset holding the run's output once it finishes. */
  datasetId?: string;
  /** Apify: the actor id (needed to list runs for the status poll). */
  actorId?: string;
  status?: string;
  /** Precise, id-bearing guidance on how to fetch the real result. */
  pollGuidance: string;
}

/** DEFAULT ON. Off ⇒ a queued receipt is passed through unchanged (prior behavior). */
export function composioAsyncResolveEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_COMPOSIO_ASYNC_RESOLVE', 'on') ?? 'on').toLowerCase() !== 'off';
}

/** The Composio SDK wraps results as `{ data, successful, error }`; unwrap to the
 *  payload the vendor returned (or the object itself if already unwrapped). */
function inner(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  const data = r.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return r;
}

/**
 * Classify a SUCCESS-path Composio result as a queued-job RECEIPT (vs the real
 * result). Returns null for anything that isn't unambiguously a receipt.
 */
export function detectJobReceipt(slug: string, result: unknown): JobReceipt | null {
  const s = (slug || '').toUpperCase();
  const d = inner(result);
  if (!d) return null;

  // DataForSEO: a *_TASK_POST returns tasks[0].{ id, result:null, status_code:20100 }.
  if (s.startsWith('DATAFORSEO')) {
    const tasks = d.tasks;
    if (Array.isArray(tasks) && tasks.length > 0) {
      const t = tasks[0] as Record<string, unknown>;
      const created = t.status_code === 20100 || /task created/i.test(String(t.status_message ?? ''));
      const notReady = t.result === null || t.result === undefined;
      if (created && notReady && typeof t.id === 'string') {
        return {
          family: 'dataforseo',
          jobId: t.id,
          status: 'created',
          pollGuidance:
            `This DataForSEO task is QUEUED (task id "${t.id}"); the results are NOT ready in this receipt. `
            + `Do NOT report this as the answer. When it finishes (usually seconds to a few minutes), fetch the results with the matching `
            + `"...TASK_GET..." action for THIS data type and id="${t.id}" — use composio_search_tools to find the exact getter if unsure `
            + `(you can check the matching "..._TASKS_READY" lister first).`,
        };
      }
    }
  }

  // Apify: an async RUN_ACTOR / RUN_TASK returns a run handle, output not inline.
  if (s.startsWith('APIFY') && s.includes('RUN')) {
    const status = String(d.status ?? '').toUpperCase();
    const running = status === 'READY' || status === 'RUNNING';
    const notFinished = d.finishedAt === null || d.finishedAt === undefined;
    if (running && notFinished && typeof d.id === 'string') {
      const datasetId = typeof d.defaultDatasetId === 'string' ? d.defaultDatasetId : undefined;
      const actorId = typeof d.actId === 'string' ? d.actId : undefined;
      return {
        family: 'apify',
        jobId: d.id,
        datasetId,
        actorId,
        status,
        pollGuidance:
          `This Apify actor run is QUEUED (run id "${d.id}", status ${status}); the output is NOT in this receipt. `
          + `Do NOT report this run handle as the result. Poll APIFY_GET_LIST_OF_RUNS (actorId) until this run reaches SUCCEEDED, `
          + `then fetch the output with APIFY_GET_DATASET_ITEMS (datasetId="${datasetId ?? '<the run\'s defaultDatasetId>'}").`,
      };
    }
  }

  // Firecrawl async crawl handle (the Composio CRAWL action is usually SYNC and
  // returns {completed,data:[…]} — this only fires on the rarer in-progress shape).
  if (s.startsWith('FIRECRAWL') && s.includes('CRAWL')) {
    const status = String(d.status ?? '').toLowerCase();
    const inProgress = status === 'scraping' || status === 'started' || status === 'active';
    const noPages = !Array.isArray(d.data) || (d.data as unknown[]).length === 0;
    if (inProgress && noPages && typeof d.id === 'string') {
      return {
        family: 'firecrawl',
        jobId: d.id,
        status,
        pollGuidance:
          `This Firecrawl crawl is IN PROGRESS (job id "${d.id}"); not all pages are ready. `
          + `Poll FIRECRAWL_GET_THE_STATUS_OF_A_CRAWL_JOB (id="${d.id}") until status is "completed", then read the data.`,
      };
    }
  }

  return null;
}

/** The banner prepended to a receipt result so the model treats it as a queued job,
 *  not the answer. The raw receipt is kept BELOW it so the ids remain available. */
export function asyncReceiptBanner(receipt: JobReceipt): string {
  return `⏳ QUEUED JOB — this is a receipt, not the final result. ${receipt.pollGuidance}`;
}

/** Execute a Composio action — the caller injects the real (connection-bound) fn. */
export type ComposioExec = (slug: string, args: Record<string, unknown>) => Promise<unknown>;

export interface AutoPollResult {
  /** true ⇒ we fetched the terminal result; `result` is the real payload. */
  resolved: boolean;
  result?: unknown;
  /** why we gave up (returned to fall back to the model-driven corrective). */
  reason?: string;
  polls: number;
}

/** DEFAULT ON. Off ⇒ never harness-poll; always fall back to the A1 corrective. */
export function composioAutoPollEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_COMPOSIO_AUTO_POLL', 'on') ?? 'on').toLowerCase() !== 'off';
}

function autoPollBudgetMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_COMPOSIO_AUTO_POLL_MS', '60000') ?? '60000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/** Unwrap `{data,…}` then look for a run/list payload. */
function payload(result: unknown): Record<string, unknown> | null {
  return inner(result);
}

/**
 * Bounded, harness-driven auto-poll for the ONE unambiguous case: an Apify async
 * run. Polls APIFY_GET_LIST_OF_RUNS (by actorId) until THIS run id reaches a
 * terminal status, then fetches APIFY_GET_DATASET_ITEMS by the run's dataset — so
 * the model gets the REAL output, never a bare handle. Conservative: any missing
 * id, unknown status, or budget overrun returns {resolved:false} so the caller
 * falls back to the id-bearing A1 corrective (never worse than model-driven).
 *
 * DataForSEO is deliberately NOT auto-polled: its result-getter slug is not cleanly
 * derivable per endpoint (only a `_TASK_GET_HTML_BY_ID` + a `_TASKS_READY` lister
 * are exposed for SERP organic), so a wrong getter would be worse than the A1
 * corrective. sleepFn is injectable for tests.
 */
export async function autoPollJob(
  receipt: JobReceipt,
  exec: ComposioExec,
  opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<AutoPollResult> {
  if (!composioAutoPollEnabled()) return { resolved: false, reason: 'disabled', polls: 0 };
  if (receipt.family !== 'apify') return { resolved: false, reason: 'family-not-auto-pollable', polls: 0 };
  if (!receipt.actorId || !receipt.datasetId) return { resolved: false, reason: 'missing-actor-or-dataset', polls: 0 };

  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + autoPollBudgetMs();
  const TERMINAL_OK = new Set(['SUCCEEDED']);
  const TERMINAL_BAD = new Set(['FAILED', 'ABORTED', 'TIMED-OUT', 'TIMED_OUT']);

  let polls = 0;
  let backoff = 2000;
  while (now() < deadline) {
    polls += 1;
    let status: string | undefined;
    try {
      const runs = await exec('APIFY_GET_LIST_OF_RUNS', { actorId: receipt.actorId });
      const p = payload(runs);
      const list = (p?.items ?? p?.data ?? p) as unknown;
      const arr = Array.isArray(list) ? list : Array.isArray((list as { items?: unknown[] })?.items) ? (list as { items: unknown[] }).items : [];
      const run = (arr as Array<Record<string, unknown>>).find((r) => r?.id === receipt.jobId);
      status = run?.status ? String(run.status).toUpperCase() : undefined;
    } catch (err) {
      return { resolved: false, reason: `status-poll-error: ${err instanceof Error ? err.message : String(err)}`, polls };
    }
    if (status && TERMINAL_BAD.has(status)) return { resolved: false, reason: `run ${status}`, polls };
    if (status && TERMINAL_OK.has(status)) {
      try {
        const items = await exec('APIFY_GET_DATASET_ITEMS', { datasetId: receipt.datasetId });
        return { resolved: true, result: items, polls };
      } catch (err) {
        return { resolved: false, reason: `dataset-fetch-error: ${err instanceof Error ? err.message : String(err)}`, polls };
      }
    }
    // still RUNNING/READY (or unknown) — wait and re-poll, bounded by the deadline.
    const wait = Math.min(backoff, Math.max(0, deadline - now()));
    if (wait <= 0) break;
    await sleep(wait);
    backoff = Math.min(backoff * 1.5, 10_000);
  }
  return { resolved: false, reason: 'budget-exceeded', polls };
}
