/**
 * Composio async/queued-job awareness — FAMILY RECIPE REGISTRY.
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
 * receipt shape (verified against real 2026-06-30 envelopes), produces a precise
 * corrective naming the exact job id + the poll action, and (where it can) polls
 * the job to its REAL terminal result so the model never has to know it was async.
 * Detection is SHAPE-based (+ a toolkit-prefix guard), never a blind slug map — so
 * it's inert on a normal result and can't misfire on the common case.
 *
 * ── The registry ────────────────────────────────────────────────────────────────
 * Each job family is one `JobFamilyRecipe` in JOB_FAMILIES: a `detect` (receipt
 * classifier) plus an optional `poll` recipe ({ resolveGetter, checkOnce }). ONE
 * shared budget/backoff loop (`pollJobToResolution`, 240s, 2s→10s) drives every
 * family that has a poll recipe; the background job-watcher reuses the same
 * `resolveJobGetter` + `checkJobOnce` for its deterministic per-tick polling.
 *
 * ADDING FAMILY #4 = one registry entry (a `JobFamilyRecipe`) + one fixture test.
 * Nothing else changes: detection, inline auto-resolve, and background parking all
 * dispatch through the registry.
 *
 * Kill-switches: CLEMMY_COMPOSIO_ASYNC_RESOLVE (detect+banner, default on) and
 * CLEMMY_COMPOSIO_AUTO_POLL (inline harness poll, default on).
 */
import { getRuntimeEnv } from '../../config.js';
import type { ComposioToolkitTool } from './client.js';
export type { ComposioToolkitTool } from './client.js';

export type JobFamily = 'dataforseo' | 'apify' | 'firecrawl' | (string & {});

export interface JobReceipt {
  family: JobFamily;
  /** The remote job/task/run id the model must poll on. */
  jobId: string;
  /** Apify: the dataset holding the run's output once it finishes. */
  datasetId?: string;
  /** Apify: the actor id (needed to list runs for the status poll). */
  actorId?: string;
  status?: string;
  /** The originating tool slug (e.g. the `*_TASK_POST`) — needed for runtime
   *  result-getter discovery on families whose getter is derived from it. */
  originSlug?: string;
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

// ── Poll recipe types ────────────────────────────────────────────────────────────

/** Execute a Composio action — the caller injects the real (connection-bound) fn. */
export type ComposioExec = (slug: string, args: Record<string, unknown>) => Promise<unknown>;

/** A resolved plan for HOW to poll a specific receipt to its terminal result.
 *  Apify uses fixed slugs + the receipt's ids, so its plan is empty; DataForSEO /
 *  Firecrawl carry the discovered/fixed result-getter slug. */
export interface PollPlan {
  getterSlug?: string;
}

/** The outcome of ONE poll attempt. `pending` ⇒ not done yet (retry); `done` ⇒
 *  terminal success with `result`; `failed` ⇒ the JOB itself is terminally bad. A
 *  TRANSIENT poll/exec error is NOT a state — checkOnce should throw so the caller
 *  (inline loop stops; background watcher retries next tick) decides. */
export interface PollCheck {
  state: 'pending' | 'done' | 'failed';
  result?: unknown;
  reason?: string;
}

/** Optional, injectable discovery dependencies (tests inject a fake toolkit list). */
export interface PollDeps {
  listToolkitTools?: (toolkitSlug: string) => Promise<ComposioToolkitTool[]>;
}

export interface JobPollRecipe {
  /** true ⇒ eligible for the INLINE call-site auto-resolve (`autoPollJob`); false ⇒
   *  resolved only by the background job-watcher (the call-site parks it). */
  inlineAutoResolve: boolean;
  /** Reason string returned when `resolveGetter` yields null — kept per-family so
   *  the reason vocabulary stays backward-compatible. */
  unresolvableReason: string;
  resolveGetter(receipt: JobReceipt, exec: ComposioExec, deps: PollDeps): Promise<PollPlan | null>;
  checkOnce(plan: PollPlan, receipt: JobReceipt, exec: ComposioExec): Promise<PollCheck>;
}

export interface JobFamilyRecipe {
  family: JobFamily;
  /** Classify a SUCCESS-path (already `inner`-unwrapped) payload as a queued
   *  receipt for THIS family, or null. `slugUpper` is the uppercased slug. */
  detect(slugUpper: string, payload: Record<string, unknown>, originalSlug: string): JobReceipt | null;
  poll?: JobPollRecipe;
}

// ── Apify family ──────────────────────────────────────────────────────────────────

const APIFY_TERMINAL_OK = new Set(['SUCCEEDED']);
const APIFY_TERMINAL_BAD = new Set(['FAILED', 'ABORTED', 'TIMED-OUT', 'TIMED_OUT']);

const apifyRecipe: JobFamilyRecipe = {
  family: 'apify',
  detect(s, d, slug) {
    // An async RUN_ACTOR / RUN_TASK returns a run handle, output not inline.
    if (!(s.startsWith('APIFY') && s.includes('RUN'))) return null;
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
        originSlug: slug,
        pollGuidance:
          `This Apify actor run is QUEUED (run id "${d.id}", status ${status}); the output is NOT in this receipt. `
          + `Do NOT report this run handle as the result. Poll APIFY_GET_LIST_OF_RUNS (actorId) until this run reaches SUCCEEDED, `
          + `then fetch the output with APIFY_GET_DATASET_ITEMS (datasetId="${datasetId ?? '<the run\'s defaultDatasetId>'}").`,
      };
    }
    return null;
  },
  poll: {
    inlineAutoResolve: true,
    unresolvableReason: 'missing-actor-or-dataset',
    async resolveGetter(receipt) {
      // Apify polls fixed slugs (LIST_OF_RUNS → DATASET_ITEMS) with the receipt's
      // own ids — no discovery needed, just the ids present.
      if (!receipt.actorId || !receipt.datasetId) return null;
      return {};
    },
    async checkOnce(_plan, receipt, exec) {
      const runs = await exec('APIFY_GET_LIST_OF_RUNS', { actorId: receipt.actorId });
      const p = inner(runs);
      const list = (p?.items ?? p?.data ?? p) as unknown;
      const arr = Array.isArray(list)
        ? list
        : Array.isArray((list as { items?: unknown[] })?.items)
          ? (list as { items: unknown[] }).items
          : [];
      const run = (arr as Array<Record<string, unknown>>).find((r) => r?.id === receipt.jobId);
      const status = run?.status ? String(run.status).toUpperCase() : undefined;
      if (status && APIFY_TERMINAL_BAD.has(status)) return { state: 'failed', reason: `run ${status}` };
      if (status && APIFY_TERMINAL_OK.has(status)) {
        const items = await exec('APIFY_GET_DATASET_ITEMS', { datasetId: receipt.datasetId });
        return { state: 'done', result: items };
      }
      // still RUNNING/READY (or unknown) — not done yet.
      return { state: 'pending' };
    },
  },
};

// ── DataForSEO family ─────────────────────────────────────────────────────────────

/**
 * Choose the result-getter slug for a DataForSEO `*_TASK_POST` from the LIVE
 * toolkit slug list: strip the trailing `_TASK_POST` → base, keep the live slugs
 * that start with `${base}_TASK_GET`, prefer ADVANCED > REGULAR > (bare) GET > HTML,
 * and drop any candidate whose input schema explicitly lacks an `id` param. Returns
 * an EXACT string from the live list, never an invented slug. Zero candidates or a
 * genuine ambiguity (multiple unknown variants, no clear winner) → null → the caller
 * falls back to the id-bearing banner (never worse than today).
 */
export function pickDataforseoGetterSlug(originSlug: string, tools: ComposioToolkitTool[]): string | null {
  const s = (originSlug || '').toUpperCase();
  if (!s.endsWith('_TASK_POST')) return null;
  const base = s.slice(0, -'_TASK_POST'.length);
  const prefix = `${base}_TASK_GET`;

  const candidates = tools.filter((t) => (t.slug || '').toUpperCase().startsWith(prefix));
  if (candidates.length === 0) return null;

  const suffixRank = (slug: string): number => {
    const suffix = slug.toUpperCase().slice(prefix.length);
    if (suffix === '_ADVANCED') return 0;
    if (suffix === '_REGULAR') return 1;
    if (suffix === '') return 2; // exact _TASK_GET
    if (suffix === '_HTML') return 3;
    return 4; // unknown variant
  };

  // Prefer getters whose schema shows an `id` param; if schema info is absent for
  // all, proceed shape-verified (never bail just because the schema is unknown).
  const acceptsId = (t: ComposioToolkitTool): boolean | null => {
    const ip = t.inputParameters as { properties?: unknown; required?: unknown } | undefined;
    if (!ip || typeof ip !== 'object') return null;
    const props = ip.properties;
    if (props && typeof props === 'object') {
      return Object.prototype.hasOwnProperty.call(props as Record<string, unknown>, 'id');
    }
    if (Array.isArray(ip.required)) return (ip.required as unknown[]).includes('id');
    return null;
  };
  const withId = candidates.filter((t) => acceptsId(t) !== false);
  const pool = withId.length > 0 ? withId : candidates;

  const ranked = [...new Set(pool.map((t) => t.slug))].sort(
    (a, b) => suffixRank(a) - suffixRank(b) || a.localeCompare(b),
  );
  const best = ranked[0];
  // Ambiguity guard: if the best falls in the "unknown variant" bucket AND there
  // is more than one such candidate, we can't pick safely → bail.
  if (suffixRank(best) === 4 && ranked.filter((slug) => suffixRank(slug) === 4).length > 1) {
    return null;
  }
  return best;
}

const DATAFORSEO_GETTER_DISCOVERY_LIMIT = 300;

async function resolveDataforseoGetter(receipt: JobReceipt, deps: PollDeps): Promise<PollPlan | null> {
  if (!receipt.originSlug) return null;
  const toolkitSlug = receipt.originSlug.split('_')[0]?.toLowerCase();
  if (!toolkitSlug) return null;
  let tools: ComposioToolkitTool[];
  try {
    const lister = deps.listToolkitTools
      ?? (await import('./client.js')).listComposioToolkitTools;
    tools = await lister(toolkitSlug, DATAFORSEO_GETTER_DISCOVERY_LIMIT);
  } catch {
    return null; // no live list ⇒ can't discover a getter ⇒ banner fallback
  }
  const getterSlug = pickDataforseoGetterSlug(receipt.originSlug, tools ?? []);
  return getterSlug ? { getterSlug } : null;
}

const dataforseoRecipe: JobFamilyRecipe = {
  family: 'dataforseo',
  detect(s, d, slug) {
    // A *_TASK_POST returns tasks[0].{ id, result:null, status_code:20100 }.
    if (!s.startsWith('DATAFORSEO')) return null;
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
          originSlug: slug,
          pollGuidance:
            `This DataForSEO task is QUEUED (task id "${t.id}"); the results are NOT ready in this receipt. `
            + `Do NOT report this as the answer. When it finishes (usually seconds to a few minutes), fetch the results with the matching `
            + `"...TASK_GET..." action for THIS data type and id="${t.id}" — use composio_search_tools to find the exact getter if unsure `
            + `(you can check the matching "..._TASKS_READY" lister first).`,
        };
      }
    }
    return null;
  },
  poll: {
    // Getter discovery + polling can take a live toolkit lookup, so DataForSEO is
    // resolved by the background watcher (parked), not inline on the caller's turn.
    inlineAutoResolve: false,
    unresolvableReason: 'dataforseo-getter-not-found',
    resolveGetter(receipt, _exec, deps) {
      return resolveDataforseoGetter(receipt, deps);
    },
    async checkOnce(plan, receipt, exec) {
      if (!plan.getterSlug) return { state: 'pending' };
      const res = await exec(plan.getterSlug, { id: receipt.jobId });
      const d = inner(res);
      const tasks = d?.tasks;
      if (Array.isArray(tasks) && tasks.length > 0) {
        const t = tasks[0] as Record<string, unknown>;
        const code = typeof t.status_code === 'number' ? t.status_code : undefined;
        const hasResult = t.result !== null && t.result !== undefined;
        if (code === 20000 && hasResult) return { state: 'done', result: res };
        // A genuine error status (4xxxx / 5xxxx) is terminal-bad — do NOT keep polling.
        if (typeof code === 'number' && code >= 40000) {
          return { state: 'failed', reason: `DataForSEO task ${code}` };
        }
        // 20100 "Task Created" / still-queued / result not ready — keep polling.
        return { state: 'pending' };
      }
      // Unrecognized shape — keep polling until the budget, then fall back.
      return { state: 'pending' };
    },
  },
};

// ── Firecrawl family ──────────────────────────────────────────────────────────────

const FIRECRAWL_STATUS_GETTER = 'FIRECRAWL_GET_THE_STATUS_OF_A_CRAWL_JOB';

const firecrawlRecipe: JobFamilyRecipe = {
  family: 'firecrawl',
  detect(s, d, slug) {
    // The Composio CRAWL action is usually SYNC ({completed,data:[…]}); this only
    // fires on the rarer in-progress shape.
    if (!(s.startsWith('FIRECRAWL') && s.includes('CRAWL'))) return null;
    const status = String(d.status ?? '').toLowerCase();
    const inProgress = status === 'scraping' || status === 'started' || status === 'active';
    const noPages = !Array.isArray(d.data) || (d.data as unknown[]).length === 0;
    if (inProgress && noPages && typeof d.id === 'string') {
      return {
        family: 'firecrawl',
        jobId: d.id,
        status,
        originSlug: slug,
        pollGuidance:
          `This Firecrawl crawl is IN PROGRESS (job id "${d.id}"); not all pages are ready. `
          + `Poll FIRECRAWL_GET_THE_STATUS_OF_A_CRAWL_JOB (id="${d.id}") until status is "completed", then read the data.`,
      };
    }
    return null;
  },
  poll: {
    inlineAutoResolve: false,
    unresolvableReason: 'firecrawl-getter-unavailable',
    async resolveGetter() {
      return { getterSlug: FIRECRAWL_STATUS_GETTER };
    },
    async checkOnce(plan, receipt, exec) {
      const res = await exec(plan.getterSlug ?? FIRECRAWL_STATUS_GETTER, { id: receipt.jobId });
      const d = inner(res);
      const status = String(d?.status ?? '').toLowerCase();
      if (status === 'completed') return { state: 'done', result: res };
      if (status === 'failed' || status === 'cancelled') return { state: 'failed', reason: `crawl ${status}` };
      return { state: 'pending' };
    },
  },
};

// ── Registry ──────────────────────────────────────────────────────────────────────

const JOB_FAMILIES: JobFamilyRecipe[] = [dataforseoRecipe, apifyRecipe, firecrawlRecipe];

/** Register an extra family at runtime (used by tests to prove one-entry
 *  extensibility). Returns a disposer that removes it again. */
export function registerJobFamily(recipe: JobFamilyRecipe): () => void {
  JOB_FAMILIES.push(recipe);
  return () => {
    const i = JOB_FAMILIES.indexOf(recipe);
    if (i >= 0) JOB_FAMILIES.splice(i, 1);
  };
}

/** The recipe for a family, or undefined. Exported for the watcher + tests. */
export function recipeFor(family: JobFamily): JobFamilyRecipe | undefined {
  return JOB_FAMILIES.find((r) => r.family === family);
}

/**
 * Classify a SUCCESS-path Composio result as a queued-job RECEIPT (vs the real
 * result). Returns null for anything that isn't unambiguously a receipt. Dispatches
 * through the family registry — adding a family adds a detector for free.
 */
export function detectJobReceipt(slug: string, result: unknown): JobReceipt | null {
  const s = (slug || '').toUpperCase();
  const d = inner(result);
  if (!d) return null;
  for (const recipe of JOB_FAMILIES) {
    const receipt = recipe.detect(s, d, slug || '');
    if (receipt) return receipt;
  }
  return null;
}

/** The banner prepended to a receipt result so the model treats it as a queued job,
 *  not the answer. The raw receipt is kept BELOW it so the ids remain available. */
export function asyncReceiptBanner(receipt: JobReceipt): string {
  return `⏳ QUEUED JOB — this is a receipt, not the final result. ${receipt.pollGuidance}`;
}

// ── Poll driver ────────────────────────────────────────────────────────────────────

export interface AutoPollResult {
  /** true ⇒ we fetched the terminal result; `result` is the real payload. */
  resolved: boolean;
  result?: unknown;
  /** why we gave up (returned to fall back to the model-driven corrective). */
  reason?: string;
  polls: number;
}

export interface AutoPollOpts {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable toolkit-tools lister for getter discovery (defaults to live). */
  listToolkitTools?: (toolkitSlug: string, limit?: number) => Promise<ComposioToolkitTool[]>;
}

/** DEFAULT ON. Off ⇒ never harness-poll; always fall back to the A1 corrective. */
export function composioAutoPollEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_COMPOSIO_AUTO_POLL', 'on') ?? 'on').toLowerCase() !== 'off';
}

function autoPollBudgetMs(): number {
  // 240s (was 60s): a real 100-lead area scrape (Google-Maps/Apollo-style Apify actor)
  // routinely runs 1-4 minutes, so a 60s budget almost always overran → degraded to the
  // fragile model-driven manual-poll path. 240s brings the common case back inside the
  // harness's own resolve while staying under the 300s externalApi tool-timeout bucket.
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_COMPOSIO_AUTO_POLL_MS', '240000') ?? '240000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 240_000;
}

/** Resolve a receipt's poll plan via its family recipe. Used by the watcher. */
export async function resolveJobGetter(
  receipt: JobReceipt,
  exec: ComposioExec,
  deps: PollDeps = {},
): Promise<PollPlan | null> {
  const recipe = recipeFor(receipt.family);
  if (!recipe?.poll) return null;
  return recipe.poll.resolveGetter(receipt, exec, deps);
}

/** One poll attempt via a receipt's family recipe. Used by the watcher (one per
 *  tick). Throws on a transient/exec error so the caller decides. */
export async function checkJobOnce(
  plan: PollPlan,
  receipt: JobReceipt,
  exec: ComposioExec,
): Promise<PollCheck> {
  const recipe = recipeFor(receipt.family);
  if (!recipe?.poll) return { state: 'pending' };
  return recipe.poll.checkOnce(plan, receipt, exec);
}

/**
 * The ONE shared, bounded budget/backoff loop that drives ANY family with a poll
 * recipe to its terminal result. Resolves the poll plan, then polls checkOnce until
 * done/failed or the budget runs out. Conservative: a missing plan, a terminal-bad
 * job, a poll error, or a budget overrun returns {resolved:false} with an id-bearing
 * reason so the caller falls back to the banner (never worse than model-driven).
 * `sleep`/`now`/`listToolkitTools` are injectable for tests.
 */
export async function pollJobToResolution(
  receipt: JobReceipt,
  exec: ComposioExec,
  opts: AutoPollOpts = {},
): Promise<AutoPollResult> {
  const recipe = recipeFor(receipt.family);
  if (!recipe?.poll) return { resolved: false, reason: 'family-not-auto-pollable', polls: 0 };

  let plan: PollPlan | null;
  try {
    plan = await recipe.poll.resolveGetter(receipt, exec, { listToolkitTools: opts.listToolkitTools });
  } catch {
    plan = null;
  }
  if (!plan) return { resolved: false, reason: recipe.poll.unresolvableReason, polls: 0 };

  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + autoPollBudgetMs();
  let polls = 0;
  let backoff = 2000;
  while (now() < deadline) {
    polls += 1;
    let check: PollCheck;
    try {
      check = await recipe.poll.checkOnce(plan, receipt, exec);
    } catch (err) {
      return { resolved: false, reason: `status-poll-error: ${err instanceof Error ? err.message : String(err)}`, polls };
    }
    if (check.state === 'failed') return { resolved: false, reason: check.reason ?? 'run failed', polls };
    if (check.state === 'done') return { resolved: true, result: check.result, polls };
    // still pending — wait and re-poll, bounded by the deadline.
    const wait = Math.min(backoff, Math.max(0, deadline - now()));
    if (wait <= 0) break;
    await sleep(wait);
    backoff = Math.min(backoff * 1.5, 10_000);
  }
  return { resolved: false, reason: 'budget-exceeded', polls };
}

/**
 * INLINE call-site auto-poll: resolve a queued receipt to its REAL output on the
 * caller's turn, but ONLY for families flagged `inlineAutoResolve` (today: Apify,
 * whose poll needs no live discovery). A family whose poll needs a toolkit lookup
 * (DataForSEO / Firecrawl) returns {resolved:false, reason:'family-not-auto-pollable'}
 * so the caller PARKS it to the background job-watcher instead of blocking the turn.
 * Any missing id, terminal-bad run, poll error, or budget overrun also returns
 * {resolved:false} → the caller falls back to the id-bearing banner. sleepFn is
 * injectable for tests.
 */
export async function autoPollJob(
  receipt: JobReceipt,
  exec: ComposioExec,
  opts: AutoPollOpts = {},
): Promise<AutoPollResult> {
  if (!composioAutoPollEnabled()) return { resolved: false, reason: 'disabled', polls: 0 };
  const recipe = recipeFor(receipt.family);
  if (!recipe?.poll?.inlineAutoResolve) {
    return { resolved: false, reason: 'family-not-auto-pollable', polls: 0 };
  }
  return pollJobToResolution(receipt, exec, opts);
}
