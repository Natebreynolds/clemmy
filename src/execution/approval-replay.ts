/**
 * Retired legacy approved-payload replay lane.
 *
 * A resolved approval-registry row is a human decision record, not a complete
 * provider-dispatch capability. In particular, it does not carry the accepted
 * source, exact logical call, physical dispatch ownership, or settlement
 * authority required by the host execution kernel. The old implementation
 * atomically consumed an arbitrary session-wide approval and then called the
 * raw Composio dispatcher, so a restart that lost its SDK interrupt blob could
 * execute outside those boundaries.
 *
 * Exact durable pending actions have their own executor and claim capability.
 * Legacy approval rows without that durable action cannot be reconstructed
 * safely. This compatibility module therefore remains deliberately inert so a
 * stale import can never restore the raw provider lane.
 */

export interface ApprovedReplayOutcome {
  approvalId: string;
  toolSlug: string;
  ok: boolean;
  resultText: string;
}

type DispatchFn = (
  toolSlug: string,
  args: Record<string, unknown>,
  opts: { sessionId?: string; connectedAccountId?: string },
) => Promise<{ ok: true; result: unknown } | { ok: false } | Record<string, unknown>>;

/** @deprecated Test compatibility only. The retired replay path never reads
 * this seam and cannot invoke the supplied body. */
export function setApprovalReplayDispatchForTest(_fn: DispatchFn | null): void {
  // Intentionally empty. Keeping the old injection symbol makes downstream
  // tests prove that even an available provider body is unreachable.
}

/**
 * @deprecated Always fail closed. No approval claim, event-log provider
 * lifecycle, dynamic Composio import, or provider body can occur here.
 */
export async function replayApprovedActionForSession(_sessionId: string): Promise<null> {
  return null;
}

/** @deprecated A legacy caller must never tell the model that an action ran. */
export function renderApprovedReplayNote(_outcome: ApprovedReplayOutcome): string {
  return [
    'APPROVED ACTION NOT EXECUTED: the legacy approval replay lane is retired.',
    'The stored approval row is not provider-dispatch authority. Recreate the action through the exact durable pending-action path.',
  ].join('\n');
}
