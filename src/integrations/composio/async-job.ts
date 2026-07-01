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
      return {
        family: 'apify',
        jobId: d.id,
        datasetId,
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
