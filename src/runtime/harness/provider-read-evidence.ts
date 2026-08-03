/** Shared structural projection for provider read evidence. Request/input echoes
 * are not provider facts and must never authorize artifact verification,
 * reconciliation, or high-stakes `$fromToolOutput` values. */

export function providerRequestEchoKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /^(?:(?:original|submitted)?request(?:data|body|args|arguments|input|params|parameters|payload)?|submittedinput(?:data|body|args|arguments|params|parameters|payload)?|input|args|arguments|payload|params|parameters)$/.test(normalized);
}

export function pruneProviderRequestEchoes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneProviderRequestEchoes);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !providerRequestEchoKey(key))
    .map(([key, child]) => [key, pruneProviderRequestEchoes(child)]));
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
  if (value === undefined || value === null || value === false || value === '') return false;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return false;
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

/** Contradictory provider envelopes (`successful:true` plus 404/error) are not
 * evidence. Recurse through known envelope carriers only. */
export function providerEnvelopeHasContradiction(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 4) return false;
  if (Array.isArray(value)) return value.some((entry) => providerEnvelopeHasContradiction(entry, depth + 1));
  const record = value as Record<string, unknown>;
  if (
    structuredFalse(record.successful)
    || structuredFalse(record.success)
    || structuredFalse(record.ok)
    || structuredTrue(record.failed)
    || errorFieldIsFailure(record.error)
    || errorFieldIsFailure(record.errors)
    || errorFieldIsFailure(record.http_error)
    || errorFieldIsFailure(record.exception)
  ) return true;
  if (
    statusCodeIsFailure(record.status_code)
    || statusCodeIsFailure(record.statusCode)
    || statusCodeIsFailure(record.http_status)
    || statusCodeIsFailure(record.httpStatus)
  ) return true;
  if (typeof record.status === 'string' && FAILURE_STATUS_RE.test(record.status.trim())) return true;
  for (const key of ['data', 'response', 'result', 'output']) {
    if (providerEnvelopeHasContradiction(record[key], depth + 1)) return true;
  }
  return false;
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
