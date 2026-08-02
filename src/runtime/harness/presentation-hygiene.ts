/**
 * Detect compact model decision protocol that is not valid public prose.
 *
 * Structured-output fallbacks occasionally surface the decision authority pair
 * as raw JSON or assignments (live: `done=true\nnextAction=completed`). Only a
 * whole JSON object or compact top-level assignment envelope carrying that
 * exact typed pair is control protocol. Prefixed explanations and fenced
 * config/code examples remain displayable.
 */
export function looksLikeCompactDecisionProtocol(value: string): boolean {
  const text = value.trim();
  if (!text || text.startsWith('```')) return false;

  // A bare JSON object is an internal decision envelope only when the entire
  // public candidate is that object and its two authority fields are valid.
  // Do not scan for the keys inside prose: users may legitimately discuss or
  // show this protocol in a prefixed/fenced config example.
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const done = record.done;
        const nextAction = record.nextAction ?? record.next_action;
        if (
          typeof done === 'boolean'
          && typeof nextAction === 'string'
          && /^(?:awaiting_user_input|awaiting_approval|awaiting_handoff_result|completed|abandoned)$/.test(nextAction)
        ) return true;
      }
    } catch {
      // Not a complete JSON object; the assignment detector below still gets
      // its chance, and ordinary malformed examples remain ordinary prose.
    }
  }

  // Internal compact envelopes begin with a decision field. Requiring that
  // prefix keeps explanatory prose containing example assignments public.
  if (!/^(?:["']?)(?:summary|reply|done|next[\s_-]*action|reason)(?:["']?)\s*=\s*/i.test(text)) {
    return false;
  }

  const boundary = String.raw`(?:^|[\r\n;|/])`;
  const tail = String.raw`(?=$|[\r\n;|/])`;
  const done = new RegExp(
    `${boundary}\\s*["']?done["']?\\s*=\\s*["']?(?:true|false)["']?\\s*${tail}`,
    'im',
  );
  const nextAction = new RegExp(
    `${boundary}\\s*["']?next[\\s_-]*action["']?\\s*=\\s*["']?`
      + '(?:awaiting_user_input|awaiting_approval|awaiting_handoff_result|completed|abandoned)'
      + `["']?\\s*${tail}`,
    'im',
  );
  return done.test(text) && nextAction.test(text);
}
