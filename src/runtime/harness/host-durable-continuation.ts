/**
 * Private control signal for a host-owned durable continuation whose logical
 * call must stay open. It is never a tool result and must never be projected
 * into model or user history. Only the exact continuation owner may mint it.
 */
export class HostDurableContinuationPendingError extends Error {
  override readonly name = 'HostDurableContinuationPendingError';

  constructor(
    readonly continuationKind: 'async_read_refinement',
    readonly ownerLogicalToolCallId: string,
    readonly reason: string,
  ) {
    super('A durable host continuation is pending.');
  }
}

export function isHostDurableContinuationPendingError(
  value: unknown,
): value is HostDurableContinuationPendingError {
  return value instanceof HostDurableContinuationPendingError;
}
