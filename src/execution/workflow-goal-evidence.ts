/**
 * Token-bounded workflow evidence for completion/goal checking.
 *
 * Raw prefix clipping is unsafe for structured results: a wide `columns` or
 * `rows` array can hide proof fields that appear later in the object. Project
 * arrays to count + sample, prioritize identity/proof fields in nested objects,
 * and preserve both ends if the compact JSON still exceeds the budget.
 */
/**
 * Rank keys by SHAPE class, never by a specific workflow's field names — the
 * projector serves every user's domain (CRM, invoicing, logistics, research)
 * equally. Keys are normalized (camelCase → snake_case) before matching.
 *
 *   0 proof     — outcome/verification facts: blocked, status, *error*,
 *                 *verified*, receipts/commits/confirmations, unchanged/reused
 *   1 identity  — what the item IS: ids, keys, names, domains, urls,
 *                 row/index/reference numbers
 *   2 metric    — counts, totals, batches, sources, capture timestamps
 *   3 the rest
 */
const PROOF_KEY_RE = /(^|_)(blocked|ok|success|succeeded|failed|failure|status|error|errors)($|_)|verif|receipt|commit|confirm|unchanged|reused/;
const IDENTITY_KEY_RE = /^(id|name|key|slug|domain|url|link|email)$|_(id|ids|key|keys|url|urls|number|numbers|index)$|(^|_)row(_|$)|(^|_)rows?(_|$)/;
const METRIC_KEY_RE = /(^|_)(count|counts|total|totals|batch)($|_)|_at$|source|captured/;

function normalizedEvidenceKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();
}

function evidenceKeyRank(key: string): number {
  const normalized = normalizedEvidenceKey(key);
  if (PROOF_KEY_RE.test(normalized)) return 0;
  if (IDENTITY_KEY_RE.test(normalized)) return 1;
  if (METRIC_KEY_RE.test(normalized)) return 2;
  return 3;
}

export function workflowGoalEvidenceProjection(value: unknown, depth = 0): unknown {
  if (typeof value === 'string' && value.length > 180) {
    return `${value.slice(0, 145)}…${value.slice(-24)}`;
  }
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const count = value.length;
    if (count === 0) return { count: 0, sample: [] };
    const primitive = value.every((item) => item == null || typeof item !== 'object');
    if (primitive) {
      return {
        count,
        first: value.slice(0, 3),
        ...(count > 3 ? { last: value.slice(-2) } : {}),
      };
    }
    return {
      count,
      sample: value.slice(0, 1).map((item) => workflowGoalEvidenceProjection(item, depth + 1)),
    };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const keyLimit = depth === 0 ? 30 : 12;
  const selectedEntries = [...entries]
    .sort(([left], [right]) => evidenceKeyRank(left) - evidenceKeyRank(right));
  selectedEntries.splice(keyLimit);
  const projected: Record<string, unknown> = {};
  for (const [key, nested] of selectedEntries) {
    projected[key] = depth >= 3 && nested && typeof nested === 'object'
      ? Array.isArray(nested) ? { count: nested.length } : '[object]'
      : workflowGoalEvidenceProjection(nested, depth + 1);
  }
  if (entries.length > keyLimit) projected.__omittedKeyCount = entries.length - keyLimit;
  return projected;
}

export function compactWorkflowGoalEvidence(
  value: unknown,
  maxChars: number,
  stringify: (value: unknown) => string = (input) => JSON.stringify(input, null, 2),
): string {
  const text = stringify(workflowGoalEvidenceProjection(value)).replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  const marker = ' …[bounded evidence]… ';
  const remaining = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(remaining * 0.68);
  const tail = Math.max(0, remaining - head);
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

export function countNonEmptyLines(value: string): number {
  return value.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}
