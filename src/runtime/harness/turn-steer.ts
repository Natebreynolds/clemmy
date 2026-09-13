/** Advisory Plan guidance from distinct recorded evidence, never a completeness or authority verdict. */
import { appendEvent, listEvents } from './eventlog.js';
import { getRuntimeEnv } from '../../config.js';
import { capabilityEvidenceKey, evidenceSourceUserSeq, readEvidenceKey } from './held-inventory.js';

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
  '[host] Recent calls have not added distinct recorded read evidence or capability identities. '
  + 'Review what remains necessary to prepare the plan. Read any supplied inputs not yet inspected '
  + 'and discover a missing operation if needed; avoid repeating unchanged lookups. '
  + 'If prepared, publish_plan with the steps, dependencies and verification. '
  + 'If a prerequisite cannot be resolved, publish needs_input naming it or ask the user the specific question. '
  + 'This is guidance only: it does not establish that all inputs were read, approves nothing, '
  + 'binds no account, and every gate still applies.';

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
    return listEvents(identity.sessionId, { sinceSeq: identity.sourceUserSeq - 1, types: ['guardrail_tripped'] })
      .some((event) => event.data.kind === 'turn_steer'
        && event.data.steer === kind
        && event.data.sourceUserSeq === identity.sourceUserSeq);
  } catch {
    return true; // never risk repeating when the ledger cannot be read
  }
}

interface EvidenceWindow {
  /** Distinct successful read evidence recorded for this source. */
  reads: number;
  /** Distinct operation/routing identities recorded as proven. */
  staged: number;
  /** Settled tool calls since the last genuinely NEW evidence. */
  quietCalls: number;
  /** The turn already published, so there is nothing to steer toward. */
  published: boolean;
}

function evidenceWindow(identity: SteerIdentity): EvidenceWindow | null {
  try {
    const events = listEvents(identity.sessionId, {
      sinceSeq: identity.sourceUserSeq - 1,
      types: ['read_receipt', 'capability_resolution', 'tool_returned', 'plan_revision_published'],
    }).filter(event => evidenceSourceUserSeq(event.data) === identity.sourceUserSeq);
    const reads = new Set<string>();
    const capabilities = new Set<string>();
    let quietCalls = 0;
    let published = false;
    for (const event of events) {
      if (event.type === 'plan_revision_published') { published = true; continue; }
      if (event.type === 'read_receipt') {
        const record = event.data.record;
        const key = record && typeof record === 'object' && !Array.isArray(record)
          ? readEvidenceKey(record as Record<string, unknown>) : undefined;
        if (key && !reads.has(key)) { reads.add(key); quietCalls = 0; }
        continue;
      }
      if (event.type === 'capability_resolution') {
        for (const row of Array.isArray(event.data.entries) ? event.data.entries : []) {
          if (!row || typeof row !== 'object' || Array.isArray(row) || row.status !== 'proven' || row.connection === 'missing') continue;
          const key = capabilityEvidenceKey(row);
          if (key && !capabilities.has(key)) { capabilities.add(key); quietCalls = 0; }
        }
        continue;
      }
      if (event.data.accounting === 'top_level') quietCalls += 1;
    }
    return { reads: reads.size, staged: capabilities.size, quietCalls, published };
  } catch {
    return null;
  }
}

/**
 * The steer due at this frame, or null. Pure read of the ledger — computing it
 * must never be able to fail a turn, so every path swallows into null.
 */
export function nextTurnSteer(
  identity: SteerIdentity,
): { kind: TurnSteerKind; text: string; window: { reads: number; staged: number; quietCalls: number } } | null {
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
    // Limit this advisory to the observed repeat-retrieval situation. Neither
    // count proves that the requested preparation is complete.
    if (window.reads < 1 || window.staged < 1) return null;
    if (window.quietCalls < noNewEvidenceThreshold()) return null;
    if (alreadySteered(identity, 'publish_or_ask')) return null;
    return {
      kind: 'publish_or_ask',
      text: PUBLISH_OR_ASK_STEER,
      window: { reads: window.reads, staged: window.staged, quietCalls: window.quietCalls },
    };
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
