// ─── Global fan-out advisory: behavioral serial-batch detector ──────────────
//
// THE LOAD-BEARING fan-out trigger. The turn-start regex (context-packet.ts
// detectMultiItemIntent) is a brittle English parser that silently withholds
// the fan-out directive for unanticipated phrasings ("enrich 44 records" died
// three ways: 'records' blocklisted, 'enrich' not in the verb gate, '&' broke
// the count regex). So the GUARANTEE lives here instead, keyed on OBSERVED
// RUNTIME BEHAVIOR, not words: when the model calls the same operation-shape
// (toolName + coarse-arg-shape) for N>=3 DISTINCT items in one turn, we append
// an authoritative "fan out the REMAINING items with run_worker now" advisory
// to the tool's result. This is language- and domain-independent — by the time
// it fires, the model is demonstrably looping a per-item job, which is the exact
// condition fan-out fixes.
//
// Reachability is the whole point of moving it here: this module is called from
// BOTH the composio execute path (composio-tools.ts, flag-independent of
// HARNESS_TOOL_BRACKETS) AND the MCP namespace shim (mcp-namespace-shim.ts) so
// native MCP reads (dataforseo__*/firecrawl__* — the literal read-heavy path in
// the MCP namespace regression) are finally covered. No HARNESS_TOOL_BRACKETS
// dependency.
//
// Independence guard (see looksDependentOnPrior): a pure shape counter would
// also fire on a DEPENDENT chain (parent -> contact -> cases) where each call's
// input came from the prior call's output — work that CANNOT be parallelized.
// We suppress those in CODE (not advisory prose) by skipping any call whose args
// derive from the immediately-prior result. The check is conservative and
// per-item self-correcting: a coincidental match only delays the advisory by one
// item for a real batch, but a true chain (every link matches) never fires.

const FANOUT_ADVICE_THRESHOLD = 3;
const FANOUT_ADVICE_MAX_EMITS = 2; // re-arm cap per bucket

interface FanoutBucket {
  items: Set<string>;
  emits: number;
  /** The immediately-prior call's result text in this bucket, for the
   *  data-flow independence check on the NEXT call. */
  priorResult?: string;
}
interface SessionTracker { buckets: Map<string, FanoutBucket>; }

const trackerBySession = new Map<string, SessionTracker>();

// Coarse arg shape = sorted set of top-level arg keys. Distinct enough to keep
// genuinely different job types in separate buckets, coarse enough that the
// same job over different items shares one bucket.
export function coarseArgShape(args: Record<string, unknown>): string {
  try {
    return Object.keys(args ?? {}).sort().join(',');
  } catch {
    return '';
  }
}

// Recursively collect "identifying" string values from args (handles the
// composio gateway's nested { tool_slug, arguments: {...} } shape AND flat MCP
// args alike). Only substantial strings (>=12 chars) are collected so common
// short tokens don't cause spurious dependency matches.
function collectIdentifyingStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 4 || out.length >= 40) return;
  if (typeof value === 'string') {
    if (value.length >= 12) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectIdentifyingStrings(v, out, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectIdentifyingStrings(v, out, depth + 1);
    }
  }
}

// Data-flow independence check: did THIS call's args derive from the PRIOR
// call's result? If a substantial arg value appears verbatim in the prior
// result, the model likely chained on it (dependent sequence), so this is not
// a parallelizable per-item batch. Conservative by design — false matches only
// delay a real batch's advisory by one item; a true chain never fires.
function looksDependentOnPrior(args: Record<string, unknown>, priorResult: string | undefined): boolean {
  if (!priorResult) return false;
  try {
    const strings: string[] = [];
    collectIdentifyingStrings(args, strings);
    for (const s of strings) {
      if (priorResult.includes(s)) return true;
    }
  } catch {
    /* a guard must never break the tool call */
  }
  return false;
}

export interface FanoutAdvisoryParams {
  /** Composio slug, namespaced MCP tool name, or local tool name — the bucket key. */
  toolName: string;
  args: Record<string, unknown>;
  sessionId: string | undefined;
  /** This call's result text. When provided, enables the independence guard
   *  (stored as the bucket's priorResult for the next call). Omit to get the
   *  legacy count-only behavior (byte-identical to the original composio path). */
  resultText?: string;
  /** Force the workflow-step variant. Defaults to deriving from the
   *  `workflow:<runId>:<stepId>` session-id prefix. */
  isWorkflowStep?: boolean;
}

/**
 * Core detector. Records this call against its bucket and returns an advisory
 * string to append to the tool result, or null. Pure + best-effort: never
 * throws into a tool call.
 */
export function appendFanoutAdvisory(params: FanoutAdvisoryParams): string | null {
  const { toolName, args, sessionId, resultText } = params;
  try {
    if (!sessionId || !toolName) return null;
    let t = trackerBySession.get(sessionId);
    if (!t) {
      if (trackerBySession.size > 500) trackerBySession.clear(); // crude bound for a long-lived daemon
      t = { buckets: new Map() };
      trackerBySession.set(sessionId, t);
    }
    // Per toolName+arg-shape bucket with capped re-emit.
    const bucketKey = `${toolName}::${coarseArgShape(args)}`;
    let bucket = t.buckets.get(bucketKey);
    if (!bucket) { bucket = { items: new Set(), emits: 0 }; t.buckets.set(bucketKey, bucket); }

    // Independence guard (only active when a result is supplied). Check the
    // CURRENT args against the PRIOR call's result, THEN record this result for
    // the next call. A dependent call is not counted toward the batch total.
    const dependent = looksDependentOnPrior(args, bucket.priorResult);
    if (resultText !== undefined) bucket.priorResult = resultText;
    if (dependent) return null;

    let argHash = '';
    try { argHash = JSON.stringify(args ?? {}); } catch { argHash = `#${bucket.items.size + 1}`; }
    bucket.items.add(argHash);
    const size = bucket.items.size;

    // Emit on threshold crossings, spaced by THRESHOLD distinct items (3, 6),
    // capped. Spacing keeps the re-emit from firing on every call after 3.
    const shouldEmit = size >= FANOUT_ADVICE_THRESHOLD * (bucket.emits + 1) && bucket.emits < FANOUT_ADVICE_MAX_EMITS;
    if (!shouldEmit) return null;
    bucket.emits += 1;

    // Inside a workflow STEP (session id is `workflow:<runId>:<stepId>`),
    // run_worker is blocklisted by construction — recommending it would be
    // actively misleading. The fan-out primitive for workflows is a `forEach`
    // step (an authoring decision the runner parallelizes). Surface the
    // CORRECT mechanism instead of the run_worker advice.
    const isWorkflowStep = params.isWorkflowStep ?? sessionId.startsWith('workflow:');
    if (isWorkflowStep) {
      return (
        `\n\n↗ Fan-out tip: this workflow step has called ${toolName} for ${size} different items in series. `
        + `Inside a workflow step the fan-out primitive is a forEach step, not run_worker (which isn't available here): `
        + `have the upstream step emit an array and add a \`forEach: <upstreamStepId>\` step so the runner processes `
        + `items concurrently (bounded) and keeps each item's context lean.`
      );
    }
    return (
      `\n\n↗ FAN-OUT NOW: you've called ${toolName} serially for ${size} different items in this turn. `
      + `Do NOT make the next serial call. If these are INDEPENDENT items (not a dependent chain), you already `
      + `resolved the shared tool/connection — reuse it and call run_worker once per REMAINING item in parallel `
      + `waves of up to 8, then aggregate. Serial here is exactly what piles every item's payload into one context, `
      + `trips the loop guard, and got the last batch cancelled.`
    );
  } catch {
    return null; // a nudge must never break the tool call
  }
}
