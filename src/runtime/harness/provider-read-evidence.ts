/** Shared structural projection for provider read evidence. Request/input echoes
 * are not provider facts and must never authorize artifact verification,
 * reconciliation, or high-stakes `$fromToolOutput` values. */

export function providerRequestEchoKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /^(?:(?:original|submitted)?request(?:data|body|args|arguments|input|params|parameters|payload)?|submittedinput(?:data|body|args|arguments|params|parameters|payload)?|input|args|arguments|payload|params|parameters)$/.test(normalized);
}

const PROVIDER_RESULT_BOOKKEEPING_KEYS = new Set([
  'error', 'errors', 'warning', 'warnings', 'message', 'messages',
  'log', 'logs', 'debug', 'meta', 'metadata',
]);

/** Keys that cannot carry answer-bearing provider result content. Plain
 * `payload` is exempt because it is also a common response envelope. */
export function providerResultBookkeepingKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return PROVIDER_RESULT_BOOKKEEPING_KEYS.has(normalized)
    || (normalized !== 'payload' && providerRequestEchoKey(key));
}

export function pruneProviderRequestEchoes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneProviderRequestEchoes);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !providerRequestEchoKey(key))
    .map(([key, child]) => [key, pruneProviderRequestEchoes(child)]));
}

const EXACT_PROVIDER_DATA_ENVELOPE_KEYS = new Set([
  'data',
  'error',
  'successful',
  'logId',
  'sessionInfo',
]);

const EXACT_COMPLETED_ADAPTER_ENVELOPE_KEYS = new Set([
  'result',
  'complete',
]);

function exactProviderDataEnvelope(value: unknown): Record<string, unknown> | null {
  let candidate = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      !trimmed.startsWith('{')
      || !trimmed.endsWith('}')
      || Buffer.byteLength(trimmed, 'utf8') > 1_000_000
    ) return null;
    try {
      candidate = JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const carrier = candidate as Record<string, unknown>;
  // Production capability adapters seal provider reads in exactly one
  // host-owned completion carrier. `complete:true` proves coverage only; the
  // nested provider envelope must still independently acknowledge success.
  // Keep this closed to the adapter's two-key wire shape so arbitrary business
  // payloads containing `result` cannot manufacture provider authority.
  if (
    carrier.complete === true
    && Object.keys(carrier).length === EXACT_COMPLETED_ADAPTER_ENVELOPE_KEYS.size
    && Object.keys(carrier).every((key) => EXACT_COMPLETED_ADAPTER_ENVELOPE_KEYS.has(key))
    && carrier.result
    && typeof carrier.result === 'object'
    && !Array.isArray(carrier.result)
    && inspectProviderEnvelope(carrier).verdict === 'clean'
  ) candidate = carrier.result;
  const envelope = candidate as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(envelope, 'data')) return null;
  if (Object.keys(envelope).some((key) => !EXACT_PROVIDER_DATA_ENVELOPE_KEYS.has(key))) return null;
  if (
    envelope.successful !== true
    || (envelope.error !== null && envelope.error !== undefined && envelope.error !== '')
    || inspectProviderEnvelope(envelope).verdict !== 'clean'
  ) return null;
  return envelope;
}

/** True only for the exact positively acknowledged SDK data envelope. */
export function exactProviderDataEnvelopeAcknowledged(value: unknown): boolean {
  return exactProviderDataEnvelope(value) !== null;
}

/**
 * Recover the provider-owned payload from the exact one-shot SDK envelope.
 *
 * This is deliberately narrower than a generic `data` unwrapping heuristic:
 * only the current transport's closed envelope, with a positive acknowledgement
 * and no contradictory provider structure, may contribute identity/content
 * proof. Arbitrary nested model or tool data remains opaque.
 */
export function exactProviderDataPayload(value: unknown): unknown {
  const envelope = exactProviderDataEnvelope(value);
  return envelope ? envelope.data : value;
}

function structuredTrue(value: unknown): boolean {
  return value === true
    || value === 1
    || (typeof value === 'string' && /^(?:1|true|yes)$/i.test(value.trim()));
}

function structuredFalse(value: unknown): boolean {
  return value === false
    || value === 0
    || (typeof value === 'string' && /^(?:0|false|no)$/i.test(value.trim()));
}

function statusCodeIsFailure(value: unknown): boolean {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d{3,5}$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isFinite(numeric)
    && ((numeric >= 400 && numeric < 600) || (numeric >= 40_000 && numeric < 60_000));
}

const FAILURE_STATUS_RE = /^(?:aborted|cancelled|canceled|declined|denied|error|failed|failure|not[_ -]?connected|not[_ -]?found|rejected|refused|timed[_ -]?out|timeout|unauthori[sz]ed)$/i;
const ERROR_TERM_RE = /\b(?:bad|denied|does not exist|error|fail(?:ed|ure)?|forbidden|invalid|missing|no such|not found|reject(?:ed|ion)?|refus(?:ed|al)?|timeout|timed out|unauthori[sz]ed|unavailable)\b/i;

function errorFieldIsFailure(value: unknown): boolean {
  if (
    value === undefined
    || value === null
    || value === ''
    || structuredFalse(value)
  ) return false;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return false;
    if (/^(?:none|null|ok|success)$/i.test(text)) return false;
    if (ERROR_TERM_RE.test(text)) return true;
    return !/\bdeprecat(?:ed|ion)\b/i.test(text);
  }
  if (Array.isArray(value)) return value.some(errorFieldIsFailure);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 0) return false;
    const text = JSON.stringify(record);
    return ERROR_TERM_RE.test(text) || !/\bdeprecat(?:ed|ion)\b/i.test(text);
  }
  return value === true || (typeof value === 'number' && value !== 0);
}

const CONTRADICTION_MAX_DEPTH = 8;
const CONTRADICTION_MAX_NODES = 512;
const CONTRADICTION_MAX_ENTRIES = 128;
const CONTRADICTION_RESULT_ARRAY_KEYS = new Set([
  'data', 'documents', 'drafts', 'entries', 'events', 'items', 'messages',
  'records', 'resources', 'results', 'rows', 'value', 'values',
]);
const NEGATIVE_SUCCESS_KEYS = new Set(['ok', 'success', 'successful']);
const FAILURE_FLAG_KEYS = new Set(['failed', 'haserror', 'iserror', 'isfailed']);
const ERROR_FIELD_KEYS = new Set([
  'error', 'errors', 'exception', 'exceptions', 'failure', 'failures', 'httperror',
]);
const STATUS_FIELD_KEYS = new Set([
  'httpcode', 'httpstatus', 'httpstatuscode', 'responsecode', 'status', 'statuscode',
]);
const BUSINESS_IDENTITY_KEYS = new Set([
  'id', 'identifier', 'key', 'recordid', 'uid', 'uuid',
]);
const EXACT_MCP_CALL_RESULT_KEYS = new Set([
  'content', 'structuredContent', 'isError', '_meta',
]);

function normalizedEnvelopeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function explicitMcpSuccessOwnsStructuredPayload(
  record: Record<string, unknown>,
): boolean {
  return record.isError === false
    && Array.isArray(record.content)
    && Object.prototype.hasOwnProperty.call(record, 'structuredContent')
    && Object.keys(record).every((key) => EXACT_MCP_CALL_RESULT_KEYS.has(key));
}

export type ProviderEnvelopeInspection =
  | { verdict: 'clean' }
  | { verdict: 'contradicted'; reason: string; depth: number }
  | { verdict: 'uninspected'; reason: 'depth_limit' | 'node_limit' | 'entry_limit' };

/**
 * Is a contradiction's ONLY evidence a status-shaped key found somewhere in the
 * payload?
 *
 * The carrier owns the verdict about the CALL: MCP states it as
 * `CallToolResult.isError`, Composio as `successful`. The payload is domain data
 * describing whatever the tool fetched. A `statusCode` nested under `metadata`
 * is the status of a SCRAPED PAGE, not of the call that scraped it — live
 * example, a Firecrawl scrape of a bot-blocked prospect site:
 *   {success: true, data: {markdown: "...", metadata: {statusCode: 404}}}
 * The scrape succeeded and returned content; only the fetched page 404'd.
 *
 * This predicate lets a caller that HAS an explicit carrier verdict discount
 * that weakest signal while keeping every stronger one — `negative_*` (an
 * explicit success flag set false), `error_*` (a populated error field), and the
 * failure-flag keys. Those are the carrier speaking; a nested status is not.
 */
export function contradictionIsNestedStatusOnly(
  inspection: ProviderEnvelopeInspection,
): boolean {
  if (inspection.verdict !== 'contradicted' || inspection.depth === 0) return false;
  if (!inspection.reason.startsWith('failure_')) return false;
  const key = inspection.reason.slice('failure_'.length);
  return STATUS_FIELD_KEYS.has(key);
}

/**
 * Inspect transport/envelope structure without confusing a safety bound with
 * a provider contradiction. `uninspected` grants no content evidence, but it
 * also cannot reverse a clean top-level acknowledgement into a failed call.
 */
export function inspectProviderEnvelope(value: unknown, depth = 0): ProviderEnvelopeInspection {
  if (!value || typeof value !== 'object') return { verdict: 'clean' };
  // A top-level array is a business result set, not an envelope collection.
  if (Array.isArray(value) && depth === 0) return { verdict: 'clean' };
  let visited = 0;
  let uninspectedReason: Extract<ProviderEnvelopeInspection, { verdict: 'uninspected' }>['reason'] | null = null;

  const markUninspected = (
    reason: Extract<ProviderEnvelopeInspection, { verdict: 'uninspected' }>['reason'],
  ): void => {
    uninspectedReason ??= reason;
  };

  type Contradiction = { reason: string; depth: number };
  const contradict = (reason: string, currentDepth: number): Contradiction => ({
    reason,
    depth: Math.max(0, currentDepth - depth),
  });

  const visit = (
    node: unknown,
    currentDepth: number,
    mcpPayloadRootDepth: number | null,
  ): Contradiction | null => {
    if (!node || typeof node !== 'object') return null;
    visited += 1;
    if (currentDepth > CONTRADICTION_MAX_DEPTH) {
      markUninspected('depth_limit');
      return null;
    }
    if (visited > CONTRADICTION_MAX_NODES) {
      markUninspected('node_limit');
      return null;
    }
    if (Array.isArray(node)) {
      if (node.length > CONTRADICTION_MAX_ENTRIES) markUninspected('entry_limit');
      for (const entry of node.slice(0, CONTRADICTION_MAX_ENTRIES)) {
        const contradiction = visit(entry, currentDepth + 1, mcpPayloadRootDepth);
        if (contradiction) return contradiction;
      }
      return null;
    }

    const record = node as Record<string, unknown>;
    const entries = Object.entries(record);
    if (entries.length > CONTRADICTION_MAX_ENTRIES) markUninspected('entry_limit');
    const inspectedEntries = entries.slice(0, CONTRADICTION_MAX_ENTRIES);
    const normalizedKeys = inspectedEntries.map(([key]) => normalizedEnvelopeKey(key));
    const businessEntity = normalizedKeys.some((key) => BUSINESS_IDENTITY_KEYS.has(key));
    for (const [rawKey, child] of inspectedEntries) {
      const key = normalizedEnvelopeKey(rawKey);
      if (NEGATIVE_SUCCESS_KEYS.has(key) && structuredFalse(child)) {
        return contradict(`negative_${key}`, currentDepth);
      }
      if (FAILURE_FLAG_KEYS.has(key) && structuredTrue(child)) {
        return contradict(`failure_${key}`, currentDepth);
      }
      if (ERROR_FIELD_KEYS.has(key) && errorFieldIsFailure(child)) {
        return contradict(`error_${key}`, currentDepth);
      }
      if (STATUS_FIELD_KEYS.has(key)) {
        // A status on an identified returned ENTITY is domain data: a failed
        // job/order/task is still a successful READ of the response that
        // reports it. That doctrine was only applied to the bare `status` key,
        // so a per-row `status_code` stayed transport evidence and one bad row
        // condemned the whole payload.
        //
        // Live 2026-09-04, the exact prospects/SEO shape: a DataForSEO request
        // fanned out across geos returns
        //   {status_code: 20000, tasks: [ {id:'a', status_code:20000, result:[...]},
        //                                 {id:'b', status_code:20000, result:[...]},
        //                                 {id:'c', status_code:40501, ...} ]}
        // `tasks` is not a CONTRADICTION_RESULT_ARRAY_KEY, so the walker
        // descends into each task; task c is identified (`id`) but its key is
        // `status_code`, not `status`, so the skip never applied. Measured:
        // success=false with recordCount=3 — three good geos discarded because
        // a fourth errored. The same path condemned DataForSEO's NON-error
        // in-progress codes (40602 "Task In Queue", 40603 "Task In Progress").
        //
        // The transport verdict belongs to the envelope, which carries no
        // business identity, so a top-level `status_code: 40501`/`50000` still
        // contradicts exactly as before — verified: dropping the 40_000-60_000
        // band entirely would let real provider errors pass as success, because
        // `status_message: "Invalid Field."` alone reads clean.
        if (businessEntity) continue;
        // An exact MCP carrier owns the call verdict outside structuredContent.
        // Only status nested *inside* that selected payload yields to an
        // explicit `isError:false`; a status at the payload root remains a
        // transport contradiction. This keeps raw-settlement inspection aligned
        // with result-fact derivation without weakening error/failure signals.
        if (mcpPayloadRootDepth !== null && currentDepth > mcpPayloadRootDepth) continue;
        if (statusCodeIsFailure(child)) return contradict(`failure_${key}`, currentDepth);
        if (typeof child === 'string' && FAILURE_STATUS_RE.test(child.trim())) {
          return contradict(`failure_${key}`, currentDepth);
        }
      }
    }

    for (const [rawKey, child] of inspectedEntries) {
      if (!child || typeof child !== 'object') continue;
      const key = normalizedEnvelopeKey(rawKey);
      // Plain `payload` is also a common response carrier, so only skip keys
      // that are unmistakably request/input echoes.
      if (providerRequestEchoKey(rawKey) && key !== 'payload') continue;
      if (Array.isArray(child) && CONTRADICTION_RESULT_ARRAY_KEYS.has(key)) continue;
      const nestedMcpPayloadRootDepth = key === 'structuredcontent'
        && explicitMcpSuccessOwnsStructuredPayload(record)
        ? currentDepth + 1
        : mcpPayloadRootDepth;
      const contradiction = visit(child, currentDepth + 1, nestedMcpPayloadRootDepth);
      if (contradiction) return contradiction;
    }
    return null;
  };

  const contradiction = visit(value, depth, null);
  if (contradiction) return { verdict: 'contradicted', ...contradiction };
  if (uninspectedReason) return { verdict: 'uninspected', reason: uninspectedReason };
  return { verdict: 'clean' };
}

/** Compatibility predicate: only observed contradictory structure is a
 * contradiction. Evidence-granting callers must require `clean` explicitly. */
export function providerEnvelopeHasContradiction(value: unknown, depth = 0): boolean {
  return inspectProviderEnvelope(value, depth).verdict === 'contradicted';
}

const COUNT_KEYS = new Set(['count', 'total', 'totalcount', 'rowcount', 'recordcount', 'resultcount']);
const RESULT_ARRAY_KEYS = new Set(['items', 'records', 'results', 'rows', 'documents', 'drafts', 'messages', 'resources']);
const RESULT_ENVELOPE_KEYS = new Set(['data', 'response', 'result', 'output']);
const AUXILIARY_COLLECTION_KEYS = new Set(['error', 'errors', 'warning', 'warnings', 'advisory', 'metadata']);
const NON_RESULT_SCALAR_KEYS = new Set([
  'error', 'errors', 'warning', 'warnings', 'advisory', 'message', 'status',
  'statusmessage', 'statuscode', 'httpstatus', 'httpstatuscode', 'successful',
  'success', 'ok', 'failed',
]);

export interface ProviderResultProjection {
  containsExpectedTarget: boolean;
  hasEmptyResult: boolean;
  hasNonEmptyResult: boolean;
}

/** Inspect only provider-returned content after echo pruning. A target returned
 * anywhere in a real result dominates empty sibling result sets; only a
 * globally empty, explicitly identified result can prove absence. Auxiliary
 * arrays such as `warnings`, `errors`, and `metadata` are deliberately not
 * result sets: treating their emptiness as provider absence could authorize a
 * duplicate external create. Unknown shapes fail closed. */
export function projectProviderResult(
  value: unknown,
  expectedTargets: readonly string[],
): ProviderResultProjection {
  const targets = expectedTargets.map((target) => target.trim().toLowerCase()).filter(Boolean);
  const projection: ProviderResultProjection = {
    containsExpectedTarget: false,
    hasEmptyResult: false,
    hasNonEmptyResult: false,
  };
  const pruned = pruneProviderRequestEchoes(value);
  const visit = (
    node: unknown,
    key: string,
    context: {
      resultContent: boolean;
      arrayIsResult: boolean;
      countsAreResults: boolean;
    },
  ): void => {
    if (Array.isArray(node)) {
      if (context.arrayIsResult) {
        if (node.length === 0) projection.hasEmptyResult = true;
        else projection.hasNonEmptyResult = true;
      }
      for (const entry of node) {
        visit(entry, key, {
          // Keep target-search scope through provider-specific nested arrays,
          // but do not let an unrecognized array become absence evidence.
          resultContent: context.resultContent || context.arrayIsResult,
          arrayIsResult: false,
          countsAreResults: false,
        });
      }
      return;
    }
    if (!node || typeof node !== 'object') {
      if (
        context.resultContent
        && typeof node === 'string'
        && !NON_RESULT_SCALAR_KEYS.has(key)
        && targets.some((target) => node.toLowerCase().includes(target))
      ) projection.containsExpectedTarget = true;
      if (
        context.resultContent
        && !COUNT_KEYS.has(key)
        && node !== null
        && node !== undefined
        && node !== ''
      ) projection.hasNonEmptyResult = true;
      return;
    }
    for (const [rawKey, child] of Object.entries(node as Record<string, unknown>)) {
      const normalizedKey = rawKey.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (context.countsAreResults && COUNT_KEYS.has(normalizedKey)) {
        if (child === 0 || child === '0') projection.hasEmptyResult = true;
        else if ((typeof child === 'number' && child > 0) || (typeof child === 'string' && /^[1-9]\d*$/.test(child))) {
          projection.hasNonEmptyResult = true;
        }
      }
      const resultEnvelope = RESULT_ENVELOPE_KEYS.has(normalizedKey);
      const resultCollection = RESULT_ARRAY_KEYS.has(normalizedKey);
      const auxiliaryCollection = AUXILIARY_COLLECTION_KEYS.has(normalizedKey);
      visit(child, normalizedKey, {
        // Diagnostic collections never become result sets. Other nonempty
        // fields beneath a real result envelope remain conservative evidence
        // of content/uncertainty, so an empty sibling cannot prove absence.
        resultContent: !auxiliaryCollection && (context.resultContent || resultEnvelope || resultCollection),
        arrayIsResult: !auxiliaryCollection && (resultEnvelope || resultCollection),
        countsAreResults: !auxiliaryCollection && (resultEnvelope || resultCollection),
      });
    }
  };
  visit(pruned, '', {
    resultContent: false,
    arrayIsResult: Array.isArray(pruned),
    countsAreResults: true,
  });
  return projection;
}
