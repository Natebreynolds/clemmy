/**
 * The approval id, timestamps, subject, and display channel describe a card;
 * they do not describe the action that card authorizes. Sticky recovery may
 * inherit a decision only when the durable execution identity below is exact.
 */
export interface ApprovalAuthority {
  approvalId: string;
  sessionId: string;
  tool: string | null;
  args: Record<string, unknown> | null;
  resumeKey: string | null;
}

function canonicalJson(value: unknown, seen: Set<object>): string | null {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (typeof value !== 'object') return null;

  if (seen.has(value)) return null;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const children: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) return null;
        const child = canonicalJson(value[index], seen);
        if (child === null) return null;
        children.push(child);
      }
      return `[${children.join(',')}]`;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    if (Object.getOwnPropertySymbols(value).length > 0) return null;

    const fields: string[] = [];
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = canonicalJson((value as Record<string, unknown>)[key], seen);
      if (child === null) return null;
      fields.push(`${JSON.stringify(key)}:${child}`);
    }
    return `{${fields.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * Exact authority is deliberately narrower than "same session" or "same
 * tool". A different recipient, nested payload field, pending-action id, or
 * resumable key is a different action and must receive its own human decision.
 */
export function exactApprovalAuthorityMatches(
  granted: ApprovalAuthority,
  candidate: ApprovalAuthority,
): boolean {
  if (!granted.sessionId.trim() || granted.sessionId !== candidate.sessionId) return false;
  if (!granted.tool?.trim() || granted.tool !== candidate.tool) return false;
  if ((granted.resumeKey ?? null) !== (candidate.resumeKey ?? null)) return false;

  const grantedArgs = canonicalJson(granted.args, new Set());
  const candidateArgs = canonicalJson(candidate.args, new Set());
  return grantedArgs !== null && candidateArgs !== null && grantedArgs === candidateArgs;
}

function objectArgsFromToolCall(rawArguments: unknown): Record<string, unknown> | null | undefined {
  let parsed = rawArguments;
  if (typeof rawArguments === 'string') {
    try {
      parsed = JSON.parse(rawArguments);
    } catch {
      return undefined;
    }
  }
  if (parsed === null || parsed === undefined) return null;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
}

/** Match a durable registry row to one concrete SDK interruption. Invalid or
 * non-object function arguments are deliberately unmatchable. */
export function approvalAuthorityMatchesToolCall(
  granted: ApprovalAuthority,
  tool: unknown,
  rawArguments: unknown,
): boolean {
  if (typeof tool !== 'string') return false;
  const args = objectArgsFromToolCall(rawArguments);
  if (args === undefined) return false;
  return exactApprovalAuthorityMatches(granted, {
    approvalId: '',
    sessionId: granted.sessionId,
    tool,
    args,
    resumeKey: granted.resumeKey,
  });
}

/**
 * The OpenAI RunState resume API applies one decision to every interruption in
 * that serialized state. Even when one row is an exact duplicate, resuming
 * while another row is pending could authorize the other row too. Therefore a
 * sticky recovery is safe only when the exact duplicate is the sole pending
 * approval for the session.
 */
export function selectSoleExactApprovalDuplicate<T extends ApprovalAuthority>(
  granted: ApprovalAuthority,
  pending: readonly T[],
): T | null {
  if (pending.length !== 1) return null;
  return exactApprovalAuthorityMatches(granted, pending[0]) ? pending[0] : null;
}
