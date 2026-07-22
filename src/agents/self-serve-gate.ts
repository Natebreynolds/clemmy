import { getRuntimeEnv } from '../config.js';

/**
 * Self-serve-first bounce (v2.2.2): a real assistant tries the obvious
 * derivation before asking the user for a pointer to data she can query
 * herself. Live 2026-07-22: "the saved Salesforce report is gone — can you
 * send the current report link or ID?" … user: "can you just find them?" …
 * model finds all 30 accounts in 7 tool calls. The ask was honest but lazy.
 *
 * Mechanism: when a user-facing question is POINTER-SHAPED (asks the user to
 * supply a link/id/report/file that merely points at queryable data) AND a
 * connected toolkit plausibly covers that domain, bounce it back to the model
 * ONCE with a derive-first steer. Strictly bounded and fail-open: one bounce
 * per session, any classification doubt lets the ask through, and the second
 * ask always reaches the user (ideally enriched with what was tried).
 * Kill-switch: CLEMMY_SELF_SERVE_BOUNCE=off.
 */

export function selfServeBounceEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_SELF_SERVE_BOUNCE', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

// Deliberately in-memory: a bounce is turn-flow control, not durable state —
// a daemon restart forgetting it just means at most one more bounce.
const bouncedSessions = new Set<string>();

export function clearSelfServeBouncesForTest(): void {
  bouncedSessions.clear();
}

/** The ask must be POINTER-SHAPED, in either live-observed form:
 *  (a) request-to-provide — "can you send the report link/ID…"
 *  (b) identify-the-schema-pointer — "which Salesforce field or report view
 *      marks an account as a Market Leader?" (2026-07-22, same user session:
 *      both were answered by the model itself in ~7 tool calls once nudged). */
const POINTER_PROVIDE_RE = /\b(?:can you (?:send|share|provide|paste|give)|please (?:send|share|provide|paste|give)|send me|share (?:the|a|your)|give me|paste|provide (?:the|a|your)|what(?:'s| is) the)\b[^.?!]{0,80}\b(?:link|url|id\b|ids\b|report|export|file|spreadsheet|sheet|list|csv|dashboard)/i;
const POINTER_IDENTIFY_RE = /\b(?:which|what|where)\b[^.?!]{0,100}\b(?:field|report|view|column|dashboard|record type|list view|flag|property|label)\b/i;
const POINTER_REQUEST_RE = new RegExp(`(?:${POINTER_PROVIDE_RE.source})|(?:${POINTER_IDENTIFY_RE.source})`, 'i');

/** …and toolkit-domain words that tie the pointer to a queryable system. The
 *  slugs come from the LIVE connected-toolkit list (never a hardcoded catalog);
 *  domain aliases widen matching for the big families. */
const TOOLKIT_ALIASES: Record<string, RegExp> = {
  salesforce: /salesforce|account|opportunit|lead|contact|crm|report/i,
  hubspot: /hubspot|crm|deal|contact|account/i,
  googlesheets: /sheet|spreadsheet|tab\b|row/i,
  airtable: /airtable|base\b|table\b|record/i,
  outlook: /outlook|email|inbox|mail\b/i,
  gmail: /gmail|email|inbox|mail\b/i,
  slack: /slack|channel|thread/i,
  notion: /notion|page\b|database/i,
};

export interface SelfServeBounceDecision {
  bounce: boolean;
  steer?: string;
  toolkit?: string;
}

/** Pure classification: pointer-shaped ask + a connected toolkit that covers
 *  the domain → bounce. Anything else → let the ask through. */
export function classifySelfServeBounce(question: string, connectedToolkitSlugs: string[]): SelfServeBounceDecision {
  const q = (question ?? '').slice(0, 1200);
  if (!q.trim() || connectedToolkitSlugs.length === 0) return { bounce: false };
  if (!POINTER_REQUEST_RE.test(q)) return { bounce: false };
  for (const slug of connectedToolkitSlugs) {
    const key = slug.trim().toLowerCase();
    const alias = TOOLKIT_ALIASES[key];
    const matches = alias ? alias.test(q) : new RegExp(`\\b${key.replace(/[^a-z0-9]/g, '')}\\b`, 'i').test(q);
    if (matches) {
      return {
        bounce: true,
        toolkit: key,
        steer: [
          `Question deferred — try to SELF-SERVE first: this asks the user for a pointer (link/id/report) to data your connected ${key} tools can likely derive directly.`,
          `Attempt the direct query now (search/list/filter in ${key} for the underlying records).`,
          `If your attempt comes up empty, errors, or is ambiguous, ask the user again — that ask WILL go through — and include exactly what you tried so their answer is one step, not a scavenger hunt.`,
        ].join(' '),
      };
    }
  }
  return { bounce: false };
}

/** One-shot session gate around the pure classifier. Fail-open by contract:
 *  errors, repeat asks, and the kill-switch all resolve to "let it through". */
export function maybeSelfServeBounce(opts: {
  sessionId: string | undefined;
  question: string;
  connectedToolkitSlugs: string[];
}): SelfServeBounceDecision {
  try {
    if (!selfServeBounceEnabled()) return { bounce: false };
    const sessionId = (opts.sessionId ?? '').trim();
    if (!sessionId || bouncedSessions.has(sessionId)) return { bounce: false };
    const decision = classifySelfServeBounce(opts.question, opts.connectedToolkitSlugs);
    if (decision.bounce) bouncedSessions.add(sessionId);
    return decision;
  } catch {
    return { bounce: false };
  }
}
