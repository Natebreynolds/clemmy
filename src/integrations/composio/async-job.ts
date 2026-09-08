/**
 * Composio queued-job receipt recognition and explicit poll recipes.
 *
 * A queued receipt is evidence that work started, not the requested result.
 * The current foreground path returns its exact identifiers and guidance.
 * Every status/result request must enter as a separately admitted logical
 * call with normal account, authority, cancellation and settlement checks.
 * It does not automatically poll or park a new job in the legacy watcher.
 *
 * The recipe/poll helpers below remain reusable explicit orchestration
 * helpers. Their presence and feature flags do not authorize background I/O;
 * job-watcher.ts contains only migration of legacy unowned jobs.
 */
import { getRuntimeEnv } from '../../config.js';
import type { ComposioToolkitTool } from './client.js';
import {
  composioSlugEffectEvidence,
  slugHasAffirmativeWriteVerb,
} from './slug-effect.js';
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

/** A live-verified plan for HOW to poll a specific receipt to its terminal
 * result. Recipe and durable slugs are hints; every callable slug in this plan
 * came from the current toolkit catalog. */
export interface PollPlan {
  getterSlug?: string;
  /** The getter's id-input parameter name (e.g. `id`, `task_id`, `run_id`). Set only
   *  from the getter's live schema whenever a discovered action replaces a hint. */
  idArg?: string;
  /** Which durable receipt identifier supplies idArg. Generic/status getters
   * default to the remote job id. */
  idSource?: 'job' | 'actor' | 'dataset';
  /** Optional second-stage getter (for families whose terminal payload lives in
   * a separate result container, such as an actor run's dataset). */
  resultGetterSlug?: string;
  resultIdArg?: string;
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
  /** A durable watcher plan is only a hint. The resolver verifies it against
   * the current catalog before reuse, then self-heals through sibling discovery. */
  preferredPlan?: PollPlan;
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

type PollIdSource = NonNullable<PollPlan['idSource']>;
interface GetterArgChoice { name: string; source: PollIdSource }
interface ResolvedGetter {
  slug: string;
  idArg: string;
  idSource: PollIdSource;
}

/** One bounded, current toolkit view for poll-plan resolution. The ordinary
 * catalog is intentionally cached for model discovery; a recipe getter is about
 * to execute, so its existence/contract must be renewed instead of trusting the
 * cache or a durable record. */
async function liveToolkitTools(receipt: JobReceipt, deps: PollDeps, limit: number): Promise<ComposioToolkitTool[]> {
  const toolkitSlug = receipt.originSlug?.split('_')[0]?.toLowerCase();
  if (!toolkitSlug) return [];
  if (deps.listToolkitTools) return deps.listToolkitTools(toolkitSlug);
  const client = await import('./client.js');
  client.bustToolkitToolsCache();
  return client.listComposioToolkitTools(toolkitSlug, limit);
}

function schemaInputShape(tool: ComposioToolkitTool): {
  known: boolean;
  names: Set<string>;
  required: Set<string>;
} {
  const schema = tool.inputParameters;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { known: false, names: new Set(), required: new Set() };
  }
  const row = schema as { properties?: unknown; required?: unknown };
  if (
    (row.properties !== undefined
      && (!row.properties || typeof row.properties !== 'object' || Array.isArray(row.properties)))
    || (row.required !== undefined && !Array.isArray(row.required))
  ) {
    return { known: false, names: new Set(), required: new Set() };
  }
  const names = new Set<string>();
  const required = new Set<string>();
  if (row.properties && typeof row.properties === 'object' && !Array.isArray(row.properties)) {
    for (const name of Object.keys(row.properties as Record<string, unknown>)) names.add(name);
  }
  if (Array.isArray(row.required)) {
    for (const name of row.required) {
      if (typeof name !== 'string' || name.length === 0) {
        return { known: false, names: new Set(), required: new Set() };
      }
      names.add(name);
      required.add(name);
    }
  }
  return { known: true, names, required };
}

function compatibleReadGetter(
  tool: ComposioToolkitTool,
  choices: readonly GetterArgChoice[],
): ResolvedGetter | null {
  // The canonical provider-neutral classifier owns effect truth across
  // dispatch, approval, and retry policy. A getter-looking action it proves to
  // be a write can never become an unattended poll. Unknown effect remains
  // eligible only because the sibling matcher separately requires a getter
  // token and same-family identity overlap.
  if (composioSlugEffectEvidence(tool.slug) === 'write') return null;
  const schema = schemaInputShape(tool);
  const selected = schema.known
    ? choices.find((choice) =>
        schema.names.has(choice.name)
        && [...schema.required].every((name) => name === choice.name))
    : undefined;
  if (!selected) return null;
  // PollPlan supplies exactly one receipt-derived input. A live action whose
  // contract now requires anything else is stale for this recipe, even if its
  // old id field still exists. Let bounded sibling discovery self-heal instead
  // of dispatching an invocation the catalog already proves incomplete.
  return { slug: tool.slug, idArg: selected.name, idSource: selected.source };
}

/** Treat exact recipe/cached slugs as hints. Verify each against the renewed
 * catalog; if absent or incompatible, feed the same compatible catalog into the
 * generic same-toolkit sibling selector. A discovered replacement needs a real
 * schema match—its argument name is never guessed from the retired hint. */
function resolveGetterHint(
  tools: readonly ComposioToolkitTool[],
  input: {
    hints: readonly string[];
    discoveryIdentity: string;
    choices: readonly GetterArgChoice[];
  },
): ResolvedGetter | null {
  for (const hint of input.hints) {
    const exact = tools.find((tool) => tool.slug.toUpperCase() === hint.toUpperCase());
    if (!exact) continue;
    const verified = compatibleReadGetter(exact, input.choices);
    if (verified) return verified;
  }
  const compatible = tools.filter((tool) => compatibleReadGetter(tool, input.choices) !== null);
  const slug = pickSiblingGetterSlug(input.discoveryIdentity, compatible);
  if (!slug) return null;
  const selected = compatible.find((tool) => tool.slug === slug);
  return selected ? compatibleReadGetter(selected, input.choices) : null;
}

function pollIdValue(receipt: JobReceipt, source: PollIdSource | undefined): string | undefined {
  if (source === 'actor') return receipt.actorId;
  if (source === 'dataset') return receipt.datasetId;
  return receipt.jobId;
}

// ── Apify family ──────────────────────────────────────────────────────────────────

const APIFY_TERMINAL_OK = new Set(['SUCCEEDED']);
const APIFY_TERMINAL_BAD = new Set(['FAILED', 'ABORTED', 'TIMED-OUT', 'TIMED_OUT']);
const APIFY_RUN_STATUS_GETTER_HINT = 'APIFY_GET_LIST_OF_RUNS';
const APIFY_DATASET_GETTER_HINT = 'APIFY_GET_DATASET_ITEMS';
const APIFY_STATUS_ARGS: readonly GetterArgChoice[] = [
  { name: 'actorId', source: 'actor' },
  { name: 'actor_id', source: 'actor' },
  { name: 'actId', source: 'actor' },
  { name: 'runId', source: 'job' },
  { name: 'run_id', source: 'job' },
  { name: 'id', source: 'job' },
];
const APIFY_DATASET_ARGS: readonly GetterArgChoice[] = [
  { name: 'datasetId', source: 'dataset' },
  { name: 'dataset_id', source: 'dataset' },
  { name: 'id', source: 'dataset' },
];

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
          + `Do NOT report this run handle as the result. Poll the current live run-status getter (recipe hint: ${APIFY_RUN_STATUS_GETTER_HINT}) `
          + `until this run reaches SUCCEEDED, then use the current live dataset-items getter (recipe hint: ${APIFY_DATASET_GETTER_HINT}) `
          + `with datasetId="${datasetId ?? '<the run\'s defaultDatasetId>'}". The harness verifies both hints before dispatch.`,
      };
    }
    return null;
  },
  poll: {
    inlineAutoResolve: true,
    unresolvableReason: 'apify-getter-not-found-or-incompatible',
    async resolveGetter(receipt, _exec, deps) {
      if (!receipt.actorId || !receipt.datasetId) return null;
      let tools: ComposioToolkitTool[];
      try { tools = await liveToolkitTools(receipt, deps, GENERIC_GETTER_DISCOVERY_LIMIT); } catch { return null; }
      const status = resolveGetterHint(tools, {
        hints: [deps.preferredPlan?.getterSlug, APIFY_RUN_STATUS_GETTER_HINT].filter((slug): slug is string => Boolean(slug)),
        discoveryIdentity: APIFY_RUN_STATUS_GETTER_HINT,
        choices: APIFY_STATUS_ARGS,
      });
      const result = resolveGetterHint(tools, {
        hints: [deps.preferredPlan?.resultGetterSlug, APIFY_DATASET_GETTER_HINT].filter((slug): slug is string => Boolean(slug)),
        discoveryIdentity: APIFY_DATASET_GETTER_HINT,
        choices: APIFY_DATASET_ARGS,
      });
      if (!status || !result) return null;
      return {
        getterSlug: status.slug,
        idArg: status.idArg,
        idSource: status.idSource,
        resultGetterSlug: result.slug,
        resultIdArg: result.idArg,
      };
    },
    async checkOnce(plan, receipt, exec) {
      if (!plan.getterSlug || !plan.idArg || !plan.resultGetterSlug || !plan.resultIdArg) {
        return { state: 'pending' };
      }
      const statusId = pollIdValue(receipt, plan.idSource);
      if (!statusId || !receipt.datasetId) return { state: 'pending' };
      const runs = await exec(plan.getterSlug, { [plan.idArg]: statusId });
      const p = inner(runs);
      const list = (p?.items ?? p?.data ?? p) as unknown;
      const arr = Array.isArray(list)
        ? list
        : Array.isArray((list as { items?: unknown[] })?.items)
          ? (list as { items: unknown[] }).items
          : p && typeof p === 'object'
            ? [p]
            : [];
      const exactRun = (arr as Array<Record<string, unknown>>).find((r) =>
        r?.id === receipt.jobId || r?.runId === receipt.jobId);
      // A direct run-id getter may omit the id from its single-object response;
      // an actor/list getter cannot. Never associate an unrelated sole list row
      // with this receipt merely because the list happened to contain one run.
      const run = exactRun ?? (plan.idSource === 'job' && arr.length === 1 ? arr[0] : undefined);
      const status = run?.status ? String(run.status).toUpperCase() : undefined;
      if (status && APIFY_TERMINAL_BAD.has(status)) return { state: 'failed', reason: `run ${status}` };
      if (status && APIFY_TERMINAL_OK.has(status)) {
        const items = await exec(plan.resultGetterSlug, { [plan.resultIdArg]: receipt.datasetId });
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
  // TASK_GET is the provider's structurally read-only result endpoint even
  // when the shared operation stem contains CREATE from the paired TASK_POST.
  const pool = candidates.filter((t) => {
    const suffix = t.slug.toUpperCase().slice(prefix.length);
    return acceptsId(t) !== false && !slugHasAffirmativeWriteVerb(suffix);
  });
  if (pool.length === 0) return null;

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
  let tools: ComposioToolkitTool[];
  try {
    tools = await liveToolkitTools(receipt, deps, DATAFORSEO_GETTER_DISCOVERY_LIMIT);
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
export const FIRECRAWL_BATCH_SCRAPE_START = 'FIRECRAWL_BATCH_SCRAPE' as const;
export const FIRECRAWL_BATCH_SCRAPE_GETTER = 'FIRECRAWL_BATCH_SCRAPE_GET' as const;
const GENERIC_JOB_ID_ARGS: readonly GetterArgChoice[] = [
  { name: 'task_id', source: 'job' },
  { name: 'job_id', source: 'job' },
  { name: 'run_id', source: 'job' },
  { name: 'request_id', source: 'job' },
  { name: 'taskId', source: 'job' },
  { name: 'jobId', source: 'job' },
  { name: 'runId', source: 'job' },
  { name: 'requestId', source: 'job' },
  { name: 'id', source: 'job' },
];

const firecrawlRecipe: JobFamilyRecipe = {
  family: 'firecrawl',
  detect(s, d, slug) {
    // Current v20260826 batch-scrape start is an id-only asynchronous receipt:
    // `{success:true,id,url}`. Keep this exact-slug and exact-shape so an
    // arbitrary Firecrawl payload containing an id cannot mint poll authority.
    if (
      s === FIRECRAWL_BATCH_SCRAPE_START
      && d.success === true
      && typeof d.id === 'string'
      && d.id.trim() === d.id
      && d.id.length > 0
      && d.id.length <= 512
      && typeof d.url === 'string'
      && /^https?:\/\//u.test(d.url)
      && !Array.isArray(d.data)
    ) {
      return {
        family: 'firecrawl',
        jobId: d.id,
        status: 'started',
        originSlug: slug,
        pollGuidance:
          `This Firecrawl batch scrape is IN PROGRESS (job id "${d.id}"). `
          + `Poll the exact live ${FIRECRAWL_BATCH_SCRAPE_GETTER} read getter with that id `
          + 'until status is "completed"; the start receipt is not page evidence.',
      };
    }
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
          + `Poll the current live crawl-status getter (recipe hint: ${FIRECRAWL_STATUS_GETTER}, id="${d.id}") `
          + `until status is "completed", then read the data. The harness verifies the hint before dispatch.`,
      };
    }
    return null;
  },
  poll: {
    inlineAutoResolve: false,
    unresolvableReason: 'firecrawl-getter-unavailable',
    async resolveGetter(receipt, _exec, deps) {
      let tools: ComposioToolkitTool[];
      try { tools = await liveToolkitTools(receipt, deps, GENERIC_GETTER_DISCOVERY_LIMIT); } catch { return null; }
      const getter = resolveGetterHint(tools, {
        hints: [
          deps.preferredPlan?.getterSlug,
          receipt.originSlug?.toUpperCase() === FIRECRAWL_BATCH_SCRAPE_START
            ? FIRECRAWL_BATCH_SCRAPE_GETTER
            : FIRECRAWL_STATUS_GETTER,
        ]
          .filter((slug): slug is string => Boolean(slug)),
        discoveryIdentity: receipt.originSlug?.toUpperCase() === FIRECRAWL_BATCH_SCRAPE_START
          ? FIRECRAWL_BATCH_SCRAPE_GETTER
          : FIRECRAWL_STATUS_GETTER,
        choices: GENERIC_JOB_ID_ARGS,
      });
      return getter
        ? { getterSlug: getter.slug, idArg: getter.idArg, idSource: getter.idSource }
        : null;
    },
    async checkOnce(plan, receipt, exec) {
      if (!plan.getterSlug || !plan.idArg) return { state: 'pending' };
      const res = await exec(plan.getterSlug, { [plan.idArg]: receipt.jobId });
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
const GENERIC_GETTER_TOKEN_ORDER = [
  'STATUS', 'RESULTS', 'RESULT', 'GET', 'POLL', 'FETCH', 'RETRIEVE',
  'LIST', 'SEARCH', 'LOOKUP', 'CHECK',
];
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
      let tools: ComposioToolkitTool[];
      try {
        tools = await liveToolkitTools(receipt, deps, GENERIC_GETTER_DISCOVERY_LIMIT);
      } catch {
        return null;
      }
      const getter = resolveGetterHint(tools ?? [], {
        hints: deps.preferredPlan?.getterSlug ? [deps.preferredPlan.getterSlug] : [],
        discoveryIdentity: receipt.originSlug,
        choices: GENERIC_JOB_ID_ARGS,
      });
      return getter
        ? { getterSlug: getter.slug, idArg: getter.idArg, idSource: getter.idSource }
        : null;
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
  return `⏳ QUEUED JOB — this is a receipt, not the final result. ${receipt.pollGuidance}`
    + ' Keep the exact returned handle. Make status and result reads as separately admitted tool calls; '
    + 'the foreground path does not automatically poll or background this job. Do not start a replacement.';
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
 * after its recipe hints are verified against the live catalog). A family whose poll needs a toolkit lookup
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
