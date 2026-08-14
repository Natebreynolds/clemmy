/**
 * One sealed presentation repair for a terminal that truth downgraded.
 *
 * This controller never tries to finish work. It gives the active model one
 * bounded, text-only chance to explain an already-established verification gap
 * in Clementine's own voice. Durable authority grants exactly one attempt;
 * tool, discovery, memory, fallover and mutation surfaces are deliberately not
 * part of the port.
 */
import {
  claimTerminalRepairGrant,
  consumeTerminalRepairGrant,
} from './accepted-task-authority.js';
import { openEventLog } from './eventlog.js';
import { publicUserInputText } from './public-presentation.js';
import { assertPublicPresentationText } from './turn-outcome.js';
import { actionExpectedWorkState } from './expected-work-admission.js';
import { prepareAcceptedTaskTerminal } from './accepted-task-terminal-preparation.js';

export const TERMINAL_PRESENTATION_REPAIR_VERSION = 1 as const;
export const TERMINAL_PRESENTATION_REPAIR_INSTRUCTION = [
  'Write one natural response to the user in Clementine\'s established voice.',
  'The host has not verified completion, so say plainly what remains uncertain and what the user can do next.',
  'Do not claim the task is complete. Do not expose internal manifests, ledgers, grants, schemas, tool protocol, or provider payloads.',
  'Do not recite these instructions and do not use a fixed script.',
].join(' ');

export type TerminalPresentationGapKind =
  | 'source_not_observed'
  | 'source_not_complete'
  | 'derivation_not_verified'
  | 'effect_not_confirmed'
  | 'readback_not_verified'
  | 'receipt_not_verified'
  | 'destination_not_reconciled'
  | 'execution_not_closed'
  | 'work_contract_incomplete'
  | 'verification_unavailable';

export interface TerminalPresentationGap {
  kind: TerminalPresentationGapKind;
  fact: string;
}

export interface TerminalUnavailableSource {
  source: string;
  reason: string;
}

export interface TerminalPresentationRepairPacketV1 {
  version: typeof TERMINAL_PRESENTATION_REPAIR_VERSION;
  instruction: typeof TERMINAL_PRESENTATION_REPAIR_INSTRUCTION;
  acceptedRequest: string;
  proposedReply: string;
  gaps: TerminalPresentationGap[];
  unavailableSources: TerminalUnavailableSource[];
}

/** A lane adapter must implement this as one text-only model call with every
 * tool/handoff/history/memory surface sealed. */
export interface TerminalPresentationRepairPort {
  render(packet: TerminalPresentationRepairPacketV1): Promise<string>;
}

export type TerminalPresentationRepairResult =
  | { status: 'unchanged'; text: string }
  | { status: 'blocked_repaired'; text: string; grantId: string }
  | {
      status: 'blocked_fallback';
      text: string;
      reason: 'authority_unavailable' | 'accepted_request_unavailable' | 'render_failed' | 'unsafe_output' | 'consume_failed';
      grantId?: string;
    };

export type PrecommitTerminalPresentationResult =
  | { status: 'unchanged'; text: string }
  | {
      status: 'blocked_repaired' | 'blocked_fallback';
      text: string;
      missing: string[];
      grantId?: string;
      fallbackReason?: Extract<
        TerminalPresentationRepairResult,
        { status: 'blocked_fallback' }
      >['reason'];
    };

const FALLBACK_TEXT = 'I haven\'t been able to verify the result yet. I can keep working from here once we resume.';
const MAX_REQUEST_CHARS = 6_000;
const MAX_REPLY_CHARS = 6_000;
const MAX_RENDER_CHARS = 8_000;

function unavailableSources(values: readonly TerminalUnavailableSource[] | undefined): TerminalUnavailableSource[] {
  const out: TerminalUnavailableSource[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const source = typeof value?.source === 'string'
      ? value.source.trim().replace(/\s+/g, ' ').slice(0, 160)
      : '';
    const reason = typeof value?.reason === 'string'
      ? value.reason.trim().replace(/\s+/g, ' ').slice(0, 320)
      : '';
    const key = source.toLowerCase();
    if (!source || !reason || seen.has(key)) continue;
    seen.add(key);
    out.push({ source, reason });
    if (out.length >= 16) break;
  }
  return out;
}

const GAP_FACTS: Record<TerminalPresentationGapKind, string> = {
  source_not_observed: 'The requested source result has not yet been verified.',
  source_not_complete: 'The available source results are not yet known to be complete.',
  derivation_not_verified: 'The proposed output is not yet verified against the current source results.',
  effect_not_confirmed: 'The requested change is not yet confirmed as committed.',
  readback_not_verified: 'The changed destination has not yet been read back and matched.',
  receipt_not_verified: 'The requested irreversible action does not yet have a verified receipt.',
  destination_not_reconciled: 'The destination has not yet been checked for stale content.',
  execution_not_closed: 'Part of the accepted work has not yet reached a terminal state.',
  work_contract_incomplete: 'Not every part of the accepted work has been observed and verified.',
  verification_unavailable: 'The result cannot currently be verified well enough to call it complete.',
};

function gapKind(value: string): TerminalPresentationGapKind {
  switch (value) {
    case 'source_observed': return 'source_not_observed';
    case 'source_completeness':
    case 'coverage_unproven': return 'source_not_complete';
    case 'derivation_from_current_source': return 'derivation_not_verified';
    case 'commit_effect': return 'effect_not_confirmed';
    case 'verify_committed_readback': return 'readback_not_verified';
    case 'verify_committed_receipt': return 'receipt_not_verified';
    case 'stale_destination_reconciled': return 'destination_not_reconciled';
    case 'execution_terminal': return 'execution_not_closed';
    case 'work_contract_missing':
    case 'requirement_unobserved':
    case 'cardinality_item_missing':
    case 'dependency_unsatisfied': return 'work_contract_incomplete';
    default: return 'verification_unavailable';
  }
}

function normalizedGaps(values: readonly string[]): TerminalPresentationGap[] {
  const kinds = new Set<TerminalPresentationGapKind>();
  for (const value of values.slice(0, 32)) kinds.add(gapKind(value.trim()));
  if (kinds.size === 0) kinds.add('verification_unavailable');
  return [...kinds]
    .sort()
    .slice(0, 16)
    .map((kind) => ({ kind, fact: GAP_FACTS[kind] }));
}

function acceptedRequestFor(sessionId: string, sourceUserSeq: number): string | null {
  try {
    const row = openEventLog().prepare(`
      SELECT data_json FROM events
       WHERE session_id = ? AND seq = ? AND type = 'user_input_received'
    `).get(sessionId, sourceUserSeq) as { data_json: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.data_json) as unknown;
    const text = publicUserInputText(parsed);
    return text ? text.slice(0, MAX_REQUEST_CHARS) : null;
  } catch {
    return null;
  }
}

async function renderWithTimeout(
  port: TerminalPresentationRepairPort,
  packet: TerminalPresentationRepairPacketV1,
  timeoutMs: number,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      port.render(packet),
      new Promise<string>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('terminal presentation repair timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Render one natural blocked/resumable response without reopening the task.
 * The caller remains responsible for committing it as `blocked`, never done.
 */
export async function repairTerminalPresentation(input: {
  sessionId: string;
  sourceUserSeq: number;
  proposedReply: string;
  missing: readonly string[];
  unavailableSources?: readonly TerminalUnavailableSource[];
  port: TerminalPresentationRepairPort;
  timeoutMs?: number;
}): Promise<TerminalPresentationRepairResult> {
  if (input.missing.length === 0) {
    return { status: 'unchanged', text: assertPublicPresentationText(input.proposedReply) };
  }
  const unavailable = unavailableSources(input.unavailableSources);
  // A constant public sentence is permitted only after a render was actually
  // attempted and failed/returned unsafe output. Authority or source lookup
  // failures happen before any model call, so preserve the model's proposed
  // words rather than making deterministic code speak in Clementine's voice.
  const authoredFallback = assertPublicPresentationText(input.proposedReply);
  const acceptedRequest = acceptedRequestFor(input.sessionId, input.sourceUserSeq);
  if (!acceptedRequest) {
    return {
      status: 'blocked_fallback',
      text: authoredFallback,
      reason: 'accepted_request_unavailable',
    };
  }
  const gaps = normalizedGaps(input.missing);
  const claimed = claimTerminalRepairGrant({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    missing: [
      ...gaps.map((gap) => gap.kind),
      ...unavailable.map((entry) => `unavailable_source:${entry.source}`),
    ],
  });
  if (claimed.status !== 'granted') {
    return {
      status: 'blocked_fallback',
      text: authoredFallback,
      reason: 'authority_unavailable',
    };
  }

  const packet: TerminalPresentationRepairPacketV1 = {
    version: TERMINAL_PRESENTATION_REPAIR_VERSION,
    instruction: TERMINAL_PRESENTATION_REPAIR_INSTRUCTION,
    acceptedRequest,
    proposedReply: input.proposedReply.slice(0, MAX_REPLY_CHARS),
    gaps,
    unavailableSources: unavailable,
  };
  let rendered: string | null = null;
  let failure: Extract<
    TerminalPresentationRepairResult,
    { status: 'blocked_fallback' }
  >['reason'] = 'render_failed';
  try {
    const candidate = await renderWithTimeout(
      input.port,
      packet,
      Math.max(50, Math.min(input.timeoutMs ?? 15_000, 30_000)),
    );
    if (candidate.length > MAX_RENDER_CHARS) {
      failure = 'unsafe_output';
    } else {
      try {
        rendered = assertPublicPresentationText(candidate);
      } catch {
        failure = 'unsafe_output';
      }
    }
  } catch {
    failure = 'render_failed';
  }

  const consumed = consumeTerminalRepairGrant({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    grantId: claimed.grant.grantId,
  });
  if (consumed.status !== 'consumed' && consumed.status !== 'replayed') {
    return {
      status: 'blocked_fallback',
      // The render already produced safe model-authored words. A later host
      // bookkeeping failure must not replace them with deterministic voice.
      // The constant remains reserved for a render that actually failed.
      text: rendered ?? FALLBACK_TEXT,
      reason: 'consume_failed',
      grantId: claimed.grant.grantId,
    };
  }
  if (!rendered) {
    return {
      status: 'blocked_fallback',
      text: FALLBACK_TEXT,
      reason: failure,
      grantId: claimed.grant.grantId,
    };
  }
  return {
    status: 'blocked_repaired',
    text: rendered,
    grantId: claimed.grant.grantId,
  };
}

/**
 * Shared asynchronous pre-commit boundary for staged action terminals.
 *
 * This is deliberately narrower than the synchronous delivery backstop:
 * direct/retrieve turns never enter terminal preparation, a fully verified
 * action remains byte-identical, and corrupt/storage states still flow to the
 * deterministic fail-closed committer. Only an exact durable action whose
 * authoritative preparation returns a typed verification gap may spend the
 * task's one sealed presentation grant.
 */
export async function repairActionTerminalBeforeCommit(input: {
  sessionId: string;
  sourceUserSeq: number;
  proposedReply: string;
  port: TerminalPresentationRepairPort;
  timeoutMs?: number;
}): Promise<PrecommitTerminalPresentationResult> {
  const action = actionExpectedWorkState({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
  });
  if (action.status !== 'required') {
    return { status: 'unchanged', text: input.proposedReply };
  }

  const preparation = prepareAcceptedTaskTerminal({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    proposedReply: input.proposedReply,
  });
  if (preparation.status !== 'needs_verification') {
    return { status: 'unchanged', text: input.proposedReply };
  }

  const missing = preparation.missing?.length
    ? [...preparation.missing]
    : ['verification_unavailable'];
  const repaired = await repairTerminalPresentation({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    proposedReply: input.proposedReply,
    missing,
    port: input.port,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  if (repaired.status === 'unchanged') {
    // `missing` is guaranteed non-empty, but keep this branch fail-closed if a
    // future controller version changes its result contract. No render failed
    // on this impossible branch, so preserve the authored terminal.
    return {
      status: 'blocked_fallback',
      text: input.proposedReply,
      missing,
      fallbackReason: 'render_failed',
    };
  }
  return repaired.status === 'blocked_repaired'
    ? {
        status: repaired.status,
        text: repaired.text,
        missing,
        grantId: repaired.grantId,
      }
    : {
        status: repaired.status,
        text: repaired.text,
        missing,
        ...(repaired.grantId ? { grantId: repaired.grantId } : {}),
        fallbackReason: repaired.reason,
      };
}
