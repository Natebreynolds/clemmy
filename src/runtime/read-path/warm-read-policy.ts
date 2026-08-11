import { createHash } from 'node:crypto';

/** Canonical caller-owned tool boundary carried by durable warm-read rows.
 * Undefined and an explicitly empty list remain distinct policies. */
export function warmReadToolPolicyDigest(input: {
  allowedToolNames?: readonly string[];
  excludeToolNames?: readonly string[];
}): string {
  const normalize = (values: readonly string[] | undefined): string[] | null => values
    ? [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort()
    : null;
  return createHash('sha256').update(JSON.stringify({
    allowed: normalize(input.allowedToolNames),
    excluded: normalize(input.excludeToolNames),
  }), 'utf8').digest('hex');
}
