/**
 * Token-bounded workflow evidence for completion/goal checking.
 *
 * Raw prefix clipping is unsafe for structured results: a wide `columns` or
 * `rows` array can hide proof fields that appear later in the object. Project
 * arrays to count + sample, prioritize identity/proof fields in nested objects,
 * and preserve both ends if the compact JSON still exceeds the budget.
 */
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
  const proofKey = /^(?:blocked|error|status|seoWasReused|enrichmentError|verifiedCount|verifiedRows|protectedFieldsUnchanged|writeBatchCount|readbackBatchCount|ignoredDuplicateRowsTouched)$/i;
  const identityKey = /^(?:id|name|domain|rowNumber|accountId|stableKey|canonicalRowNumber|ignoredRowNumbers)$/i;
  const salientKey = /^(?:id|name|domain|rowNumber|accountId|stableKey|canonicalRowNumber|ignoredRowNumbers|status|blocked|error|existingSeo|seoCapturedAt|domainAuthority|organicTraffic|topKeywords|seoSource|seoWasReused|enrichmentError|verifiedCount|verifiedRows|protectedFieldsUnchanged|writeBatchCount|readbackBatchCount|ignoredDuplicateRowsTouched)$/i;
  const selectedEntries = [...entries]
    .sort(([left], [right]) => {
      const rank = (key: string): number =>
        proofKey.test(key) ? 0 : identityKey.test(key) ? 1 : salientKey.test(key) ? 2 : 3;
      return rank(left) - rank(right);
    })
    .slice(0, keyLimit);
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
