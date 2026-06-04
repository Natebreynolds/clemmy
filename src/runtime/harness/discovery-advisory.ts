// ─── Redundant-discovery advisory: behavioral tool-search-loop detector ──────
//
// Sibling to fanout-advisory.ts. The fan-out detector catches per-ITEM work
// looping serially; THIS catches DISCOVERY looping — the model searching the
// same toolkit over and over (or re-describing the same schema) before it
// commits to an action. In the 2026-06-04 email-audit incident the run called
// composio_search_tools for the Google Sheets toolkit FOUR times with
// progressively broader queries (+ a list + a query-filter) — ~6 discovery
// calls to find ONE tool — bloating context and pushing the real work into one
// overloaded turn that then blew the wall-clock.
//
// Why a SIBLING and not the fan-out machinery: fan-out's advice ("run_worker")
// is wrong for discovery (you don't parallelize search, you STOP and commit),
// and its independence guard suppresses exactly the case we want to catch
// (progressively-broadened reformulations of the SAME goal). So this is a
// purpose-built detector that keys on a DIFFERENT signal: repeated discovery
// of one toolkit, with overlapping query intent.
//
// False-positive defense (the key): we cluster a toolkit's searches by Jaccard
// token overlap. Reformulations of one goal ("...create spreadsheet update
// values batch" → "create spreadsheet") cluster and accumulate; two genuinely
// different intents in the same toolkit ("gmail list unread" vs "gmail send")
// share no tokens, stay in separate clusters, and never reach threshold. Only a
// single cluster's own count fires the advisory.

const DISCOVERY_ADVICE_THRESHOLD = 3;
const DISCOVERY_ADVICE_MAX_EMITS = 2; // re-arm cap per cluster
const JACCARD_CLUSTER_THRESHOLD = 0.3;

type DiscoveryLane = 'find' | 'describe';

interface DiscoveryCluster {
  /** Token sets of the member signatures, for cluster matching (capped). */
  members: Set<string>[];
  /** Short human samples for the advisory text (capped). */
  samples: string[];
  count: number;
  emits: number;
}
interface DiscoveryBucket { clusters: DiscoveryCluster[]; }
interface DiscoverySessionTracker { buckets: Map<string, DiscoveryBucket>; }

const trackerBySession = new Map<string, DiscoverySessionTracker>();

export function discoveryDirectiveEnabled(): boolean {
  return (process.env.CLEMMY_DISCOVERY_DIRECTIVE ?? 'on').toLowerCase() !== 'off';
}

function tokenize(value: string): Set<string> {
  return new Set(
    value.toLowerCase().split(/[^a-z0-9]+/g).map((t) => t.trim()).filter((t) => t.length >= 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export interface DiscoveryAdvisoryParams {
  /** 'search' and 'list' both count toward the toolkit's FIND lane (they are
   *  the same behavior: "find me the tool"); 'describe' is its own lane. */
  kind: 'search' | 'list' | 'describe';
  /** Toolkit slug — the bucket key. */
  toolkit: string;
  /** The query (search), a `list <toolkit>` marker (list), or the schema
   *  target (describe). Used both for clustering and the advisory samples. */
  signature: string;
  sessionId: string | undefined;
}

/**
 * Core detector. Records this discovery call against its (lane, toolkit) bucket
 * and returns an advisory string to append to the tool result, or null. Pure +
 * best-effort: never throws into a tool call.
 */
export function maybeDiscoveryAdvisory(params: DiscoveryAdvisoryParams): string | null {
  const { kind, toolkit, signature, sessionId } = params;
  try {
    if (!discoveryDirectiveEnabled()) return null;
    if (!sessionId || !toolkit || !signature) return null;

    let t = trackerBySession.get(sessionId);
    if (!t) {
      if (trackerBySession.size > 500) trackerBySession.clear(); // crude bound for a long-lived daemon
      t = { buckets: new Map() };
      trackerBySession.set(sessionId, t);
    }

    const lane: DiscoveryLane = kind === 'describe' ? 'describe' : 'find';
    const bucketKey = `${lane}::${toolkit.toLowerCase()}`;
    let bucket = t.buckets.get(bucketKey);
    if (!bucket) { bucket = { clusters: [] }; t.buckets.set(bucketKey, bucket); }

    const tokens = tokenize(signature);
    let cluster: DiscoveryCluster | undefined;

    if (kind === 'list') {
      // A list is "broaden the net for this toolkit" — fold it into the
      // toolkit's largest active find cluster so search+list share one counter.
      cluster = bucket.clusters.reduce<DiscoveryCluster | undefined>(
        (max, c) => (!max || c.count > max.count ? c : max),
        undefined,
      );
    } else {
      // Match the signature to the best-overlapping cluster (max Jaccard over
      // its member sets). No centroid-union: matching members keeps a later
      // short reformulation ("create spreadsheet") attached to the cluster even
      // after the seed query was long.
      let best: DiscoveryCluster | undefined;
      let bestScore = 0;
      for (const c of bucket.clusters) {
        for (const m of c.members) {
          const s = jaccard(tokens, m);
          if (s > bestScore) { bestScore = s; best = c; }
        }
      }
      if (best && bestScore >= JACCARD_CLUSTER_THRESHOLD) cluster = best;
    }

    if (!cluster) {
      cluster = { members: [], samples: [], count: 0, emits: 0 };
      bucket.clusters.push(cluster);
      if (bucket.clusters.length > 12) bucket.clusters.shift(); // crude bound
    }

    cluster.count += 1;
    if (cluster.members.length < 8) cluster.members.push(tokens);
    if (cluster.samples.length < 4) cluster.samples.push(signature.slice(0, 60));

    const shouldEmit = cluster.count >= DISCOVERY_ADVICE_THRESHOLD * (cluster.emits + 1)
      && cluster.emits < DISCOVERY_ADVICE_MAX_EMITS;
    if (!shouldEmit) return null;
    cluster.emits += 1;

    const samples = cluster.samples.map((s) => `"${s}"`).join(', ');
    if (lane === 'describe') {
      return (
        `\n\n↗ DISCOVERY LOOP: you've described the '${toolkit}' schema ${cluster.count} times over overlapping targets this run (${samples}). `
        + `You already have the field list — STOP re-describing and proceed with the actual query/update. Re-describe only if a specific field genuinely failed.`
      );
    }
    return (
      `\n\n↗ DISCOVERY LOOP: you've searched the '${toolkit}' toolkit ${cluster.count} times with overlapping queries this run (${samples}). `
      + `Stop broadening the search — pick the top viable result you already have and call composio_execute_tool now. `
      + `If you truly can't tell which slug fits, call tool_choice_recall once, then commit. Do NOT issue another search/list for this toolkit.`
    );
  } catch {
    return null; // a nudge must never break a tool call
  }
}

/**
 * P1-D — composio slugs that are SCHEMA DISCOVERY rather than per-item work
 * (e.g. SALESFORCE_DESCRIBE_SOBJECT, AIRTABLE_GET_BASE_SCHEMA). Used by the
 * composio execute path to route a describe loop to the discovery advisory and
 * skip the fan-out advisory so the two never double-fire on the same call.
 */
export function isDescribeSlug(toolSlug: string): boolean {
  return /DESCRIBE|GET_.*SCHEMA|LIST_.*SCHEMA|GET_BASE_SCHEMA/i.test(toolSlug);
}

/** P1-D — toolkit prefix of a composio slug (`SALESFORCE_DESCRIBE_SOBJECT` →
 *  `salesforce`). Falls back to the whole slug when there is no `_`. */
export function toolkitOfSlug(toolSlug: string): string {
  const i = toolSlug.indexOf('_');
  return (i > 0 ? toolSlug.slice(0, i) : toolSlug).toLowerCase();
}

/** P1-D — a stable describe signature from the execute args (the schema
 *  target, e.g. the sObject/table being described) so repeated describes of the
 *  same target cluster together. Falls back to the slug. */
export function describeSignature(toolSlug: string, args: Record<string, unknown>): string {
  const keys = ['sobject', 'object', 'object_name', 'objectName', 'table', 'table_name', 'tableId', 'table_id', 'base_id', 'baseId', 'entity'];
  const parts: string[] = [];
  for (const k of keys) {
    const v = args?.[k];
    if (typeof v === 'string' && v.trim()) parts.push(v.trim());
  }
  return parts.length ? parts.sort().join(' ') : toolSlug;
}
