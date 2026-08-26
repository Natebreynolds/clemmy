import { listEvents, recentToolOutputs, resolveToolOutputEvidenceExcerptsForAuthority } from './eventlog.js';

/**
 * The ONE shared trusted-evidence ledger for a session.
 *
 * "Is this value grounded?" is the same question for every field of an
 * irreversible write — a recipient, an amount, a destination, a record id.
 * Before this, five gates (recipient-integrity, grounding, output-grounding,
 * goal-fidelity, destination-provenance) each re-derived "what counts as trusted
 * evidence this session" with their own retrieval + filtering (the 2026-07-19
 * audit found the gather step implemented 5 independent times). This is the
 * single source of that truth: real (non-synthetic) user messages plus
 * read/compute tool outputs, excluding write/send CONFIRMATIONS and echo
 * surfaces — because a payload that was queued/approved/sent is not independent
 * evidence FOR itself (that laundering is exactly how a fabricated attendee list
 * slipped through the confirmation UI). Field-specific checks apply their own
 * extractor to each source's `text`; they never re-implement the gather.
 */

/** Tools whose output ECHOES a payload (a queued/approved action, an approval
 *  card, a stored memory) rather than being independent evidence for it. Never
 *  source authority. */
const ECHO_TOOL_RE = /^(?:pending_action_|request_approval|approval_|memory_remember$|execution_|notify_user$)/i;

export interface TrustedSource {
  /** Stable id: `user:<seq>` for a message, else the tool call_id. */
  id: string;
  /** Producing tool name (null for a user message). */
  tool: string | null;
  /** Runtime effect of the producing tool ('read' | 'compute' | ...), or null
   *  for a user message / legacy row with no effect metadata. */
  effect: string | null;
  /** Semantic use of the evidence. A mutation-safety class is not source
   * authority: compute output is a derivation until durable lineage proves
   * otherwise, while a settled read may serve as an observed source. */
  evidenceRole: 'source_read' | 'derivation' | 'committed_effect' | 'verification' | null;
  /** Provider-response text a field extractor runs against. Structured request
   * echoes are removed before this value can authorize a downstream field. */
  text: string;
  kind: 'user' | 'tool';
  /** True when automatic evidence retained only a verified prefix. Such a
   * prefix identifies the source but is not parsed as structured field truth. */
  excerpted?: boolean;
}

export interface GatherTrustedEvidenceOptions {
  /** Max recent tool outputs to consider (default 40, matching the legacy
   *  recipient gate). User messages are always included. */
  toolOutputLimit?: number;
}

export function gatherTrustedEvidence(
  sessionId: string,
  opts: GatherTrustedEvidenceOptions = {},
): TrustedSource[] {
  const toolOutputLimit = opts.toolOutputLimit ?? 40;
  const sources: TrustedSource[] = [];
  const events = listEvents(sessionId, { types: ['user_input_received', 'tool_returned'] });

  // Real user messages are first-class source authority (the human said it).
  for (const event of events) {
    if (event.type !== 'user_input_received' || event.data.synthetic === true) continue;
    const text = typeof event.data.text === 'string' ? event.data.text : '';
    if (text.length > 0) sources.push({
      id: `user:${event.seq}`,
      tool: null,
      effect: null,
      evidenceRole: 'source_read',
      text,
      kind: 'user',
    });
  }

  // Search/recall rows are presentation state: a reused SDK call id keeps its
  // longest (possibly stale) bytes there. Re-resolve each candidate against the
  // exact parented read/compute lifecycle before it can source a later field.
  const candidates = recentToolOutputs(sessionId, { limit: toolOutputLimit });
  for (const output of resolveToolOutputEvidenceExcerptsForAuthority(sessionId, candidates, {
    readOrComputeOnly: true,
    excerptChars: 5_000,
  })) {
    const tool = output.tool;
    if (ECHO_TOOL_RE.test(tool ?? '')) continue;
    if (
      output.excerpted
      || output.automaticEvidenceSuppressed
      || (typeof output.output === 'string' && output.output.length > 0)
    ) {
      sources.push({
        id: output.callId,
        tool,
        effect: output.effect,
        evidenceRole: output.effect === 'read'
          ? 'source_read'
          : output.effect === 'compute'
            ? 'derivation'
            : null,
        // Parsing an incomplete JSON prefix would re-expose request/input echo
        // fields that the complete structured projection normally removes.
        // Purpose-built streaming matchers recover middle identifiers safely.
        text: output.output,
        kind: 'tool',
        excerpted: output.excerpted,
      });
    }
  }
  return sources;
}
