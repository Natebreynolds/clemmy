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
  /** true ⇒ caught by the family-agnostic SHAPE detector (`family:'generic'`), not
   *  a known registry family. Kept so the wiring can telemeter generic hits (to watch
   *  the heuristic's precision) and hedge the corrective wording. */
  generic?: boolean;
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
  /** The getter's id-input parameter name (e.g. `id`, `task_id`, `run_id`). Set only
   *  by the generic recipe, which infers it from the getter's schema; the known
   *  families all use `id` and leave this undefined (checkOnce defaults to `id`). */
  idArg?: string;
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

// ── Generic (family-agnostic) receipt detection ─────────────────────────────────────
//
// The three families above are shape-recipes for KNOWN toolkits. Plenty of other
// Composio actions follow the same start→poll pattern with their own envelope. This
// generic detector catches those from SHAPE alone — but only when a result is
// UNAMBIGUOUSLY a queued receipt: it (a) carries a job/task/run id AND (b) signals a
// non-terminal status (or an explicit async marker) AND (c) has NO substantive payload.
// It runs LAST (registry families win), and is deliberately biased HARD toward NOT
// firing — a false positive on a normal completed result is far costlier than missing
// a rare async family (which just means the model gets today's behavior). A generic
// hit whose sibling result-getter can't be inferred degrades to the id-bearing banner
// (which today's model gets NOTHING of on the success path); one whose getter IS
// inferable can be parked to the background watcher.

/** Non-terminal status words that, with an id and no payload, mark a queued receipt.
 *  Kept TIGHT (close to the spec list) — ambiguous entity-states like "active" are
 *  intentionally excluded so a normal record that merely has a `status` never trips. */
const GENERIC_NONTERMINAL_STATUS = new Set([
  'queued', 'pending', 'running', 'in_progress', 'in-progress', 'in progress',
  'processing', 'accepted', 'submitted', 'enqueued',
]);
/** Terminal-OK status words for the generic poll (result is ready). */
const GENERIC_TERMINAL_OK = new Set([
  'completed', 'complete', 'succeeded', 'success', 'finished', 'done', 'ready',
]);
/** Terminal-BAD status words — the job itself is dead; stop polling. */
const GENERIC_TERMINAL_FAIL = new Set([
  'failed', 'error', 'errored', 'cancelled', 'canceled', 'aborted', 'timed_out', 'timed-out',
]);
const GENERIC_ID_KEYS = ['task_id', 'job_id', 'run_id', 'request_id', 'taskId', 'jobId', 'runId', 'requestId', 'id'];
const GENERIC_STATUS_KEYS = ['status', 'state', 'job_status', 'jobStatus', 'run_status'];
/** Keys that, when carrying real content, mean the result IS present (not a receipt). */
const GENERIC_PAYLOAD_KEYS = ['data', 'items', 'results', 'records', 'rows', 'output', 'tasks'];

/** A job/task/run id at THIS object level, or undefined. Numbers are stringified.
 *  Prefers the explicit keys, then accepts a domain id key (`*_id` / camelCase `*Id` /
 *  exactly `id`) so `video_id` / `exportId` count — but NOT a lowercased word that merely
 *  ends in "id" (e.g. "valid", "grid"), which would be a false id. */
function isIdKey(key: string): boolean {
  const lk = key.toLowerCase();
  return lk === 'id' || lk.endsWith('_id') || /[a-z]Id$/.test(key);
}
function idLikeValue(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}
function findGenericJobId(o: Record<string, unknown>): string | undefined {
  for (const k of GENERIC_ID_KEYS) {
    const v = idLikeValue(o[k]);
    if (v) return v;
  }
  for (const [k, raw] of Object.entries(o)) {
    if (!isIdKey(k)) continue;
    const v = idLikeValue(raw);
    if (v) return v;
  }
  return undefined;
}

/** A lowercased status/state string at THIS object level, or undefined. */
function findGenericStatus(o: Record<string, unknown>): string | undefined {
  for (const k of GENERIC_STATUS_KEYS) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim().toLowerCase();
  }
  return undefined;
}

/** True if the object carries a real result payload (a non-empty data/items/results
 *  array, a non-empty payload object/string, or a non-null `result`) — in which case
 *  it is NOT a bare receipt. Conservative: any content ⇒ not-a-receipt. */
function hasSubstantivePayload(d: Record<string, unknown>): boolean {
  for (const key of GENERIC_PAYLOAD_KEYS) {
    const v = d[key];
    if (Array.isArray(v) && v.length > 0) return true;
    if (v && typeof v === 'object' && Object.keys(v as object).length > 0) return true;
    if (typeof v === 'string' && v.trim().length > 0) return true;
  }
  // The classic "not ready = null" sentinel: a non-null `result` means it IS ready.
  const result = d.result;
  if (Array.isArray(result) && result.length > 0) return true;
  if (result && typeof result === 'object' && Object.keys(result as object).length > 0) return true;
  return false;
}

/** Classify ONE object level as a queued receipt (id + non-terminal status), or null. */
function genericLevel(o: Record<string, unknown>): { jobId: string; status: string } | null {
  const jobId = findGenericJobId(o);
  if (!jobId) return null;
  const status = findGenericStatus(o);
  if (status && GENERIC_NONTERMINAL_STATUS.has(status) && !GENERIC_TERMINAL_OK.has(status)) {
    return { jobId, status };
  }
  return null;
}

/** Family-agnostic receipt detection from shape (see the section header). Requires
 *  BOTH an id AND a non-terminal signal AND no substantive payload. */
function detectGenericReceipt(d: Record<string, unknown>, slug: string): JobReceipt | null {
  if (hasSubstantivePayload(d)) return null; // (c) result already present ⇒ not a receipt
  let found = genericLevel(d);
  if (!found) {
    // Shallow nested envelope: a single small object that itself carries BOTH an id
    // and a non-terminal status (e.g. `{ job: { id, status } }`). One level only.
    for (const v of Object.values(d)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const obj = v as Record<string, unknown>;
        if (Object.keys(obj).length <= 12) {
          const nested = genericLevel(obj);
          if (nested) { found = nested; break; }
        }
      }
    }
  }
  if (!found) {
    // Explicit async marker (id + `async:true`/`is_async:true`) with no status word.
    const jobId = findGenericJobId(d);
    if (jobId && (d.async === true || d.is_async === true)) found = { jobId, status: 'async' };
  }
  if (!found) return null;
  const toolkit = (slug.split('_')[0] || '').toLowerCase() || 'this';
  return {
    family: 'generic',
    jobId: found.jobId,
    status: found.status,
    originSlug: slug,
    generic: true,
    pollGuidance:
      `This ${toolkit} call appears to have returned a QUEUED RECEIPT, not the final result — it carries a `
      + `job/task id ("${found.jobId}")${found.status && found.status !== 'async' ? ` with status "${found.status}"` : ''} `
      + `but no result payload yet. If you expected data back and got only this handle, do NOT report it as the answer: `
      + `find this toolkit's matching status/result getter (a "*_GET" / "*_STATUS" / "*_RESULT" action for the same operation) `
      + `and poll it with the id until the result is ready. If this WAS the expected response (a fire-and-forget submission), you can proceed.`,
  };
}

/**
 * Choose a sibling result-getter slug for a GENERIC async-start tool from the LIVE
 * toolkit slug list, purely by token overlap (handles start-verbs in prefix, infix, OR
 * suffix position — `SOMEAPP_START_EXPORT`, `MYTOOL_CREATE_JOB`, `X_RUN`). The origin
 * slug's OPERATION-IDENTITY tokens are its `_`-parts minus the toolkit, the start-verb
 * tokens, and any getter tokens. A candidate must be in the SAME toolkit, carry a getter
 * token (`STATUS` > `RESULT(S)` > `GET`/`POLL`/`FETCH`/`RETRIEVE`), and share at least one
 * identity token. The winner has the highest identity overlap, then the best getter rank.
 * Returns an EXACT slug from the live list, never invented. No identity tokens, zero
 * candidates, or a genuine tie (same overlap AND getter rank) → null → the caller falls
 * back to the id-bearing banner (never worse than today). Exported for tests.
 */
const GENERIC_START_VERBS = new Set([
  'START', 'CREATE', 'RUN', 'POST', 'SUBMIT', 'ENQUEUE', 'TRIGGER', 'LAUNCH', 'ACTOR',
  'TASK', 'GENERATE', 'INITIATE', 'BEGIN', 'DISPATCH', 'KICKOFF', 'SCHEDULE', 'REQUEST',
]);
const GENERIC_GETTER_TOKEN_ORDER = ['STATUS', 'RESULTS', 'RESULT', 'GET', 'POLL', 'FETCH', 'RETRIEVE'];
const GENERIC_GETTER_TOKENS = new Set(GENERIC_GETTER_TOKEN_ORDER);

export function pickSiblingGetterSlug(originSlug: string, tools: ComposioToolkitTool[]): string | null {
  const s = (originSlug || '').toUpperCase();
  const tokens = s.split('_').filter(Boolean);
  if (tokens.length < 2) return null;
  const toolkit = tokens[0];
  const identity = new Set(
    tokens.slice(1).filter((t) => !GENERIC_START_VERBS.has(t) && !GENERIC_GETTER_TOKENS.has(t)),
  );
  if (identity.size === 0) return null; // nothing to match the getter on → bail to banner

  const getterRank = (tk: string[]): number => {
    for (let i = 0; i < GENERIC_GETTER_TOKEN_ORDER.length; i += 1) {
      if (tk.includes(GENERIC_GETTER_TOKEN_ORDER[i])) return i;
    }
    return -1;
  };

  const scored = tools
    .map((t) => ({ slug: t.slug, tk: (t.slug || '').toUpperCase().split('_').filter(Boolean) }))
    .filter((x) => x.tk.join('_') !== s && x.tk[0] === toolkit)
    .map((x) => ({ slug: x.slug, getterRank: getterRank(x.tk), overlap: x.tk.filter((t) => identity.has(t)).length }))
    .filter((x) => x.getterRank >= 0 && x.overlap > 0);
  if (scored.length === 0) return null;

  scored.sort((a, b) => b.overlap - a.overlap || a.getterRank - b.getterRank || a.slug.localeCompare(b.slug));
  const best = scored[0];
  // Ambiguity guard: a second candidate tied on BOTH identity overlap and getter rank →
  // we can't pick safely → bail to the banner.
  if (scored.filter((x) => x.overlap === best.overlap && x.getterRank === best.getterRank).length > 1) return null;
  return best.slug;
}

/** The getter's id-input parameter name, inferred from its schema (required wins over
 *  optional). Defaults to `id` when the schema is unknown. */
function pickGetterIdArg(tool: ComposioToolkitTool | undefined): string {
  const ip = tool?.inputParameters as { properties?: Record<string, unknown>; required?: unknown } | undefined;
  const props = ip?.properties && typeof ip.properties === 'object' ? Object.keys(ip.properties) : [];
  const required = Array.isArray(ip?.required) ? (ip!.required as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  for (const k of GENERIC_ID_KEYS) if (required.includes(k)) return k;
  for (const k of GENERIC_ID_KEYS) if (props.includes(k)) return k;
  return 'id';
}

const GENERIC_GETTER_DISCOVERY_LIMIT = 300;

const genericRecipe: JobFamilyRecipe = {
  family: 'generic',
  detect(_s, d, slug) {
    return detectGenericReceipt(d, slug);
  },
  poll: {
    // Getter discovery needs a live toolkit lookup, so generic jobs are resolved by
    // the background watcher (parked), never inline — same policy as DataForSEO.
    inlineAutoResolve: false,
    unresolvableReason: 'generic-getter-not-found',
    async resolveGetter(receipt, _exec, deps) {
      if (!receipt.originSlug) return null;
      const toolkitSlug = receipt.originSlug.split('_')[0]?.toLowerCase();
      if (!toolkitSlug) return null;
      let tools: ComposioToolkitTool[];
      try {
        const lister = deps.listToolkitTools
          ?? (await import('./client.js')).listComposioToolkitTools;
        tools = await lister(toolkitSlug, GENERIC_GETTER_DISCOVERY_LIMIT);
      } catch {
        return null;
      }
      const getterSlug = pickSiblingGetterSlug(receipt.originSlug, tools ?? []);
      if (!getterSlug) return null;
      const idArg = pickGetterIdArg((tools ?? []).find((t) => (t.slug || '').toUpperCase() === getterSlug.toUpperCase()));
      return { getterSlug, idArg };
    },
    async checkOnce(plan, receipt, exec) {
      if (!plan.getterSlug) return { state: 'pending' };
      const res = await exec(plan.getterSlug, { [plan.idArg || 'id']: receipt.jobId });
      const d = inner(res);
      if (!d) return { state: 'pending' };
      const status = findGenericStatus(d);
      if (status && GENERIC_TERMINAL_FAIL.has(status)) return { state: 'failed', reason: `job ${status}` };
      // A real payload OR a terminal-OK status ⇒ done. Otherwise still queued.
      if (hasSubstantivePayload(d)) return { state: 'done', result: res };
      if (status && GENERIC_TERMINAL_OK.has(status)) return { state: 'done', result: res };
      return { state: 'pending' };
    },
  },
};

// ── Registry ──────────────────────────────────────────────────────────────────────

// generic MUST be last: the known families win (family-specific getter resolution),
// and generic only catches what none of them claimed.
const JOB_FAMILIES: JobFamilyRecipe[] = [dataforseoRecipe, apifyRecipe, firecrawlRecipe, genericRecipe];

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
  /** Explicit poll budget (ms). Defaults to autoPollBudgetMs(). Lets autoPollJob cap
   *  the INLINE poll short when a park target exists (see parkAvailable). */
  budgetMs?: number;
  /** true ⇒ a background park target exists (origin session id present). The inline
   *  auto-poll then caps SHORT (INLINE_POLL_PARK_CAP_MS) and returns budget-exceeded so
   *  the caller PARKS the overflow instead of blocking the turn for the full budget. */
  parkAvailable?: boolean;
}

/** How long the INLINE auto-poll blocks before it prefers PARKING (when a background
 *  target exists). Short by design: past this the turn continues and the background
 *  watcher finishes the job. Rides CLEMMY_COMPOSIO_AUTO_POLL (no new flag). */
const INLINE_POLL_PARK_CAP_MS = 45_000;

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
  const deadline = now() + (opts.budgetMs ?? autoPollBudgetMs());
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
  // Prefer PARKING over a long inline block: when a background park target exists
  // (origin session present), cap the inline poll SHORT — if the job isn't terminal by
  // the cap we return budget-exceeded and the caller parks it, so the turn keeps moving
  // instead of blocking up to the full budget. With NO park target, blocking the full
  // budget is better than losing the result, so keep the long budget.
  const budgetMs = opts.budgetMs
    ?? (opts.parkAvailable ? Math.min(INLINE_POLL_PARK_CAP_MS, autoPollBudgetMs()) : autoPollBudgetMs());
  return pollJobToResolution(receipt, exec, { ...opts, budgetMs });
}
