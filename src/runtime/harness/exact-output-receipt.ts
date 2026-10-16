/** Exact invocation output reference; this proves retained bytes, never task completion. */
import { createHash } from 'node:crypto';

const EXACT_OUTPUT_RECEIPT_RE = /\[exact-output-receipt:v1 nonce=([0-9a-f-]{36}) sha256=([0-9a-f]{64})\]/ig;

export function exactOutputSha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Verify that a compact result names the exact bytes in the lossless store.
 * The expected nonce belongs to one outer invocation, not a reusable call id. */
export function compactResultProvesExactToolOutput(
  compactResult: unknown,
  exactOutput: string,
  expectedNonce: string | undefined,
): boolean {
  if (!expectedNonce || typeof compactResult !== 'string') return false;
  const expectedHash = exactOutputSha256(exactOutput);
  return [...compactResult.matchAll(EXACT_OUTPUT_RECEIPT_RE)].some((match) =>
    match[1] === expectedNonce && match[2]?.toLowerCase() === expectedHash);
}
