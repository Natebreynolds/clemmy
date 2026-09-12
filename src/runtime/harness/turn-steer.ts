/**
 * THE MID-TURN STEER CHANNEL.
 *
 * A turn-start instruction is read thousands of tokens before the moment it
 * applies, and this session measured what that is worth. Two prose
 * instructions, opposite outcomes:
 *
 *   - `tool_choice_recall`'s static description says "CALL THIS FIRST before
 *     reaching for composio_search_tools". Measured 2026-09-04..11: THREE calls
 *     against 813 searches.
 *   - The `PROVEN AND CALLABLE NOW` line added to a tool RESULT on 2026-09-11
 *     was followed on its first live run — the document the previous two runs
 *     never read was read at call 4.
 *
 * The difference is not the wording. It is that one arrives at the decision and
 * the other arrived at the door. So this channel delivers host guidance INTO A
 * TOOL RESULT, at the frame where the next choice is actually made.
 *
 * WHAT THIS IS NOT. A steer carries no authority of any kind. It cannot
 * approve, bind an account, satisfy an effect gate, or make an unproven
 * capability callable. It redirects attention and nothing else — every gate in
 * the system still runs exactly as before. It is also not a clock: nothing here
 * measures elapsed time, and a turn is never cut off. The owner's standing
 * direction is that pace is user-facing only, and a stopwatch on the model
 * would be the wrong instrument for a problem that is about knowing when you
 * are done gathering.
 *
 * FIRST CONDITION — publish-or-ask. Live 2026-09-11
 * (sess-desktop-e61923acbde9196a013a147c): a Plan turn read the owner's
 * document at 54 seconds, had its capability refs staged by minute one, and
 * then spent THIRTY-TWO MORE MINUTES re-reading what it already held — 56
 * `recall_tool_result` calls against 4 distinct searches and exactly ONE
 * business read for the whole turn. It did publish a real plan, at minute 33.
 *
 * Plan mode's own instruction already says to bind what you ALREADY have and
 * either publish `needs_input` or ask that exact question — "do not go and
 * gather it". The instruction was right and arrived too early to be acted on.
 *
 * Deliberately a host computation, not a model call. Everything needed to see
 * this stall is a counter the harness already keeps: inputs read, capabilities
 * staged, and whether recent frames learned anything new. Paying a judge model
 * to discover a number the host already has would be the expensive version of a
 * cheap fix. A judge belongs on this same channel later, for the judgments a
 * counter genuinely cannot make ("this plan answers a different question than
 * the one asked") — and it will need a liveness contract, because an
 * unavailable judge pin means zero judge calls, silently.
 */
import { appendEvent, listEvents } from './eventlog.js';
import { getRuntimeEnv } from '../../config.js';

/** How many consecutive settled tool calls may add no new evidence before the
 *  host says so. Tuned against the live 2026-09-11 stall: the document landed
 *  at call 4 and capabilities were staged immediately after, so a threshold in
 *  this range speaks around minute two or three rather than minute thirty-three.
 *  Generous on purpose — a turn legitimately re-reads its own parked results
 *  while composing, and this must not interrupt honest work. */
const DEFAULT_NO_NEW_EVIDENCE_CALLS = 12;

function noNewEvidenceThreshold(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_TURN_STEER_QUIET_CALLS', '') || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_NO_NEW_EVIDENCE_CALLS;
}

export function turnSteerEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_TURN_STEER', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

export const PUBLISH_OR_ASK_STEER =
  '[host] You have already read the inputs the user named and the capabilities '
  + 'for this step are staged and callable. Nothing in the recent frames added '
  + 'new evidence — the re-reads are returning what you already hold. Publish '
  + 'the plan now with what you have: say what those inputs told you, the steps, '
  + 'what each produces, the order, and how you will verify. Name anything still '
  + 'genuinely unresolved as a prerequisite rather than going to gather it, or '
  + 'ask the user that one exact question. Do not run more discovery or recall '
  + 'for this decision. This is guidance only: it approves nothing, binds no '
  + 'account, and every gate still applies.';

export type TurnSteerKind = 'publish_or_ask';

interface SteerIdentity {
  sessionId: string;
  sourceUserSeq: number;
}

/** Plan mode is carried on the accepted user input, not on a separate row. */
function acceptedTaskModeKind(identity: SteerIdentity): string | null {
  try {
    const event = listEvents(identity.sessionId, {
      sinceSeq: identity.sourceUserSeq - 1,
      types: ['user_input_received'],
      limit: 1,
    }).find((row) => row.seq === identity.sourceUserSeq);
    const mode = event?.data.taskMode;
    if (!mode || typeof mode !== 'object' || Array.isArray(mode)) return null;
    const kind = (mode as { kind?: unknown }).kind;
    return typeof kind === 'string' ? kind : null;
  } catch {
    return null;
  }
}

/** Fire at most once per accepted source per kind. A steer that repeats every
 *  frame becomes noise the model learns to skip, which is exactly how the
 *  static instruction lost. */
function alreadySteered(identity: SteerIdentity, kind: TurnSteerKind): boolean {
  try {
    return listEvents(identity.sessionId, { types: ['guardrail_tripped'], desc: true, limit: 60 })
      .some((event) => event.data.kind === 'turn_steer'
        && event.data.steer === kind
        && event.data.sourceUserSeq === identity.sourceUserSeq);
  } catch {
    return true; // never risk repeating when the ledger cannot be read
  }
}

interface EvidenceWindow {
  /** Inputs the turn actually read from a provider. */
  reads: number;
  /** Capability resolutions staged for this source. */
  staged: number;
  /** Settled tool calls since the newest read or staging event. */
  quietCalls: number;
  /** The turn already published, so there is nothing to steer toward. */
  published: boolean;
}

function evidenceWindow(identity: SteerIdentity): EvidenceWindow | null {
  try {
    const events = listEvents(identity.sessionId, {
      sinceSeq: identity.sourceUserSeq - 1,
      types: ['read_receipt', 'capability_resolution', 'tool_returned'],
    }).filter((event) => {
      const seq = event.data.sourceUserSeq;
      return seq === undefined || seq === identity.sourceUserSeq;
    });
    let reads = 0;
    let staged = 0;
    let quietCalls = 0;
    let published = false;
    for (const event of events) {
      if (event.type === 'read_receipt') { reads += 1; quietCalls = 0; continue; }
      if (event.type === 'capability_resolution') { staged += 1; quietCalls = 0; continue; }
      // tool_returned
      if (event.data.effectiveTool === 'publish_plan') { published = true; continue; }
      // Only top-level settled calls count toward quiet; transport mirrors and
      // inner bookkeeping would inflate the window and fire early.
      if (event.data.accounting === 'top_level') quietCalls += 1;
    }
    return { reads, staged, quietCalls, published };
  } catch {
    return null;
  }
}

/**
 * The steer due at this frame, or null. Pure read of the ledger — computing it
 * must never be able to fail a turn, so every path swallows into null.
 */
export function nextTurnSteer(identity: SteerIdentity): { kind: TurnSteerKind; text: string } | null {
  if (!turnSteerEnabled()) return null;
  if (!identity.sessionId || !Number.isSafeInteger(identity.sourceUserSeq) || identity.sourceUserSeq <= 0) {
    return null;
  }
  try {
    // Scope: Plan turns only for now. Act mode has its own terminal shape and
    // deserves its own measured condition rather than this one by analogy.
    if (acceptedTaskModeKind(identity) !== 'plan') return null;
    const window = evidenceWindow(identity);
    if (!window) return null;
    // Nothing to steer toward once the plan exists.
    if (window.published) return null;
    // The precondition Plan mode's own instruction names: the inputs are read
    // and the capabilities are held. Without both, gathering is the right move
    // and the host must stay out of the way.
    if (window.reads < 1 || window.staged < 1) return null;
    if (window.quietCalls < noNewEvidenceThreshold()) return null;
    if (alreadySteered(identity, 'publish_or_ask')) return null;
    return { kind: 'publish_or_ask', text: PUBLISH_OR_ASK_STEER };
  } catch {
    return null;
  }
}

/** Record that a steer was delivered — both to dedupe it and because an
 *  unobservable nudge is undebuggable. Every behaviour this session that could
 *  not be seen in the ledger cost hours to diagnose. */
export function recordTurnSteer(
  identity: SteerIdentity,
  kind: TurnSteerKind,
  window?: { reads: number; staged: number; quietCalls: number },
): void {
  try {
    appendEvent({
      sessionId: identity.sessionId,
      turn: 0,
      role: 'system',
      type: 'guardrail_tripped',
      data: {
        kind: 'turn_steer',
        steer: kind,
        sourceUserSeq: identity.sourceUserSeq,
        ...(window ? { reads: window.reads, staged: window.staged, quietCalls: window.quietCalls } : {}),
      },
    });
  } catch {
    // Telemetry never blocks a turn.
  }
}

/** Append the steer to a tool result's text. Separated so the appending rule —
 *  one blank line, host tag, never inside structured output — is pinned in one
 *  place and testable without the runner. */
export function appendSteerToResultText(text: string, steer: string): string {
  return text.length > 0 ? `${text}\n\n${steer}` : steer;
}
