export type AddressedApprovalSelection<T> =
  | { kind: 'none' }
  | { kind: 'selected'; row: T }
  | { kind: 'ambiguous'; rows: T[] }
  | { kind: 'missing'; approvalId: string };

/**
 * A bare chat decision is safe only when exactly one approval is actionable.
 * An explicit id must match that exact row. This helper deliberately selects;
 * it never resolves or broadens authority.
 */
export function selectAddressedApproval<T extends { approvalId: string }>(
  pending: readonly T[],
  requestedApprovalId?: string,
): AddressedApprovalSelection<T> {
  const requested = requestedApprovalId?.trim();
  if (requested) {
    const row = pending.find((candidate) => candidate.approvalId === requested);
    return row ? { kind: 'selected', row } : { kind: 'missing', approvalId: requested };
  }
  if (pending.length === 0) return { kind: 'none' };
  if (pending.length === 1) return { kind: 'selected', row: pending[0] };
  return { kind: 'ambiguous', rows: [...pending] };
}
