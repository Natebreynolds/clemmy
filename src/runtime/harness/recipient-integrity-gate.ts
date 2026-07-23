import { getRuntimeEnv } from '../../config.js';
import { asksForCompleteRecallSet } from '../../memory/recall-memory.js';
import { extractDuplicateIdentityKeys } from './grounding-gate.js';
import { gatherTrustedEvidence } from './trusted-evidence.js';

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
// Explicit "leave some out" language — a user who signals exclusion intent must
// NOT trigger an omission advisory (they meant the subset).
const EXCLUSION_RE = /\b(?:except|excluding|but\s+not|skip(?:ping)?|without|minus|leave\s+out|leaving\s+out|don'?t\s+include|do\s+not\s+include|exclude|omit)\b/i;

export interface RecipientIntegritySource {
  id: string;
  tool: string | null;
  recipients: string[];
}

export interface RecipientIntegrityResult {
  action: 'allow' | 'block';
  reason: string;
  recipients: string[];
  sourceId?: string;
  unsupportedRecipients?: string[];
  /** ADVISORY (never blocks): the user asked for a complete set but the outgoing
   *  recipients omit some of a roster that a trusted source holds — the "dropped
   *  5" half of the 2026-07-19 incident. Surfaced for a human at approval; not a
   *  refusal, because an intentional partial send is legitimate. */
  omittedRecipients?: string[];
}

export function isRecipientIntegrityGateEnabled(): boolean {
  const raw = (getRuntimeEnv('CLEMMY_RECIPIENT_SET_INTEGRITY', 'on') ?? 'on').trim().toLowerCase();
  return !['off', 'false', '0', 'disabled'].includes(raw);
}

function emailSet(value: unknown): string[] {
  return extractDuplicateIdentityKeys(value)
    .filter((item) => EMAIL_RE.test(item))
    .map((item) => item.toLowerCase())
    .sort();
}

/** Recipient view over the shared trusted-evidence ledger: the email set is the
 *  field extractor; the gather (which outputs count as evidence, echo/effect
 *  filtering, user messages) is the shared spine, no longer re-derived here. */
function trustedRecipientSources(sessionId: string): RecipientIntegritySource[] {
  const sources: RecipientIntegritySource[] = [];
  for (const source of gatherTrustedEvidence(sessionId)) {
    const recipients = emailSet(source.text);
    if (recipients.length > 0) sources.push({ id: source.id, tool: source.tool, recipients });
  }
  return sources;
}

/**
 * Deterministic completeness/identity boundary for batch communications.
 * A single-recipient send follows the existing grounding gates. Two or more
 * recipients must co-occur in one trusted read result or real user message;
 * stitching identities across unrelated snippets is refused.
 */
export function evaluateRecipientSetIntegrity(sessionId: string, rawArgs: unknown): RecipientIntegrityResult {
  const recipients = emailSet(rawArgs);
  if (recipients.length < 2) {
    return { action: 'allow', reason: 'single-recipient or no-email payload', recipients };
  }

  let sources: RecipientIntegritySource[];
  try {
    sources = trustedRecipientSources(sessionId);
  } catch {
    return {
      action: 'block',
      reason: 'trusted recipient sources could not be read; multi-recipient sends fail closed',
      recipients,
      unsupportedRecipients: recipients,
    };
  }

  const exact = sources.find((source) => source.recipients.length === recipients.length
    && recipients.every((recipient) => source.recipients.includes(recipient)));
  if (exact) {
    return { action: 'allow', reason: 'outgoing recipient set exactly matches one trusted source', recipients, sourceId: exact.id };
  }
  const covering = sources.find((source) => recipients.every((recipient) => source.recipients.includes(recipient)));
  if (covering) {
    // Omission advisory (still ALLOW): every outgoing recipient is grounded, but
    // the covering roster has MORE — and the user asked for a complete set with
    // no exclusion language. Surface the drop; never block a legitimate subset.
    const omittedRecipients = covering.recipients.filter((recipient) => !recipients.includes(recipient));
    if (omittedRecipients.length > 0) {
      const userTurns = gatherTrustedEvidence(sessionId).filter((s) => s.kind === 'user').map((s) => s.text);
      if (userTurns.some(asksForCompleteRecallSet) && !userTurns.some((t) => EXCLUSION_RE.test(t))) {
        return {
          action: 'allow',
          reason: `outgoing set omits ${omittedRecipients.length} of ${covering.recipients.length} recipients from a complete roster the user asked for`,
          recipients,
          sourceId: covering.id,
          omittedRecipients,
        };
      }
    }
    return { action: 'allow', reason: 'every outgoing recipient co-occurs in one trusted source', recipients, sourceId: covering.id };
  }

  const seen = new Set(sources.flatMap((source) => source.recipients));
  const unsupportedRecipients = recipients.filter((recipient) => !seen.has(recipient));
  if (unsupportedRecipients.length > 0) {
    return {
      action: 'block',
      reason: `${unsupportedRecipients.length} outgoing recipient(s) do not appear in any trusted source`,
      recipients,
      unsupportedRecipients,
    };
  }
  // S1 (gate audit 2026-07-23): UNION coverage ALLOWS. Every outgoing
  // recipient is individually grounded in a trusted source — they just came
  // from more than one read (two Airtable queries, a report + a thread). The
  // old single-source co-occurrence rule hard-refused exactly the flow a user
  // had confirmed ("yes, send to all of them" over an assembled list), with
  // the confirmation invisible to the gate — the workflow-run-guard failure
  // shape. Anti-fabrication stays intact above: an address in NO trusted
  // source still blocks. Whether the assembled COMBINATION is right is what
  // the approval card review + grounding judge exist for.
  return {
    action: 'allow',
    reason: `every outgoing recipient is grounded across ${sources.length} trusted sources (union coverage)`,
    recipients,
  };
}

export class RecipientSetIntegrityError extends Error {
  public readonly toolName: string;
  public readonly recipients: string[];
  public readonly unsupportedRecipients: string[];

  constructor(input: { toolName: string; result: RecipientIntegrityResult }) {
    const unsupported = input.result.unsupportedRecipients ?? [];
    super(
      `RECIPIENT_SET_INTEGRITY_FAILED: refused this multi-recipient ${input.toolName} before approval or send. `
      + `${input.result.reason}. `
      + `Outgoing set: ${input.result.recipients.join(', ')}. `
      + (unsupported.length > 0 ? `Unsupported: ${unsupported.join(', ')}. ` : '')
      + 'Recover by re-reading one authoritative complete roster (use memory_recall_all or the original source/tool output), rebuild the payload directly from that result, and retry. Do not synthesize, autocomplete, or merge recipient names from memory. If no complete source exists, ask the user.',
    );
    this.name = 'RecipientSetIntegrityError';
    this.toolName = input.toolName;
    this.recipients = input.result.recipients;
    this.unsupportedRecipients = unsupported;
  }
}
