import { listEvents, recentToolOutputs } from './eventlog.js';

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
  /** The raw source text a field extractor runs against. */
  text: string;
  kind: 'user' | 'tool';
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
    if (text.length > 0) sources.push({ id: `user:${event.seq}`, tool: null, effect: null, text, kind: 'user' });
  }

  // Join tool_outputs (content) with tool_returned (effect + tool) on call_id.
  const returnsByCall = new Map<string, { effect?: string; tool?: string | null }>();
  for (const event of events) {
    if (event.type !== 'tool_returned') continue;
    const callId = typeof event.data.callId === 'string' ? event.data.callId : '';
    if (!callId) continue;
    returnsByCall.set(callId, {
      effect: typeof event.data.effect === 'string' ? event.data.effect : undefined,
      tool: typeof event.data.tool === 'string' ? event.data.tool : null,
    });
  }
  for (const output of recentToolOutputs(sessionId, { limit: toolOutputLimit })) {
    const meta = returnsByCall.get(output.callId);
    const tool = output.tool ?? meta?.tool ?? null;
    if (ECHO_TOOL_RE.test(tool ?? '')) continue;
    // A write/send output is a confirmation of a payload, not authority FOR it.
    // Legacy rows without effect metadata stay eligible unless echo-named above.
    if (meta?.effect && meta.effect !== 'read' && meta.effect !== 'compute') continue;
    if (typeof output.output === 'string' && output.output.length > 0) {
      sources.push({ id: output.callId, tool, effect: meta?.effect ?? null, text: output.output, kind: 'tool' });
    }
  }
  return sources;
}
