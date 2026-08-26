/**
 * The single durable foreground-delivery boundary.
 *
 * Both brain lanes reduce their execution state to a TurnOutcome and call this
 * function. The committer writes one idempotent conversation_completed row and
 * derives every legacy field from the public PresentationEvent. It never accepts
 * arbitrary event data, so internal summaries and raw model output have no path
 * into the user-facing terminal payload.
 */
import { createHash } from 'node:crypto';
import {
  AcceptedTaskTerminalPublicationError,
  appendTerminalEventOnce,
  listEvents,
  openEventLog,
  type EventRow,
} from './eventlog.js';
import { HOST_TOOL_UNCERTAIN_BLOCKED_TEXT } from './host-turn-runner.js';
import {
  InvalidTurnOutcomeError,
  assertPublicPresentationText,
  presentationEventForOutcome,
  presentationEventFromCompletionData,
  type PresentationEvent,
  type TurnEvidenceKind,
  type TurnIdentity,
  type TurnNeed,
  type TurnOutcome,
  type TurnOutcomeStatus,
} from './turn-outcome.js';
import { persistCommittedClarificationContinuity } from './task-continuity-runtime.js';
import { assertNoPendingWorkflowChatDispatchOwnership } from '../../tools/workflow-run-queue.js';
import { fenceAndReleaseHandoffAtTerminal } from '../../execution/continuation-capsule.js';
import type { ExactVerifiedReadCompletionCertificate } from './verified-read-completion.js';
import { loadManifestState } from './obligation-store.js';
import { adjudicateTerminalForTaskSync } from './terminal-truth.js';
import { prepareAcceptedTaskTerminal } from './accepted-task-terminal-preparation.js';
import {
  auditAcceptedSourceSettlementTruth,
  type AcceptedSourceSettlementAudit,
} from './accepted-source-settlement-audit.js';
import { workEvidenceForAcceptedSource, type WorkEvidenceRef } from './work-manifest.js';
import { constrainNeedsInputPresentationForRecovery } from './recovery-presentation-truth.js';

export interface DeliveryCommitResult {
  event: EventRow;
  inserted: boolean;
  presentation: PresentationEvent;
}

/** Transitional non-presentation fields retained on conversation_completed.
 * The committer copies only this allowlist; arbitrary model output, summaries,
 * prompts, tool payloads, and control prose cannot be smuggled in as metadata. */
const DELIVERY_METADATA_KEYS: ReadonlySet<string> = new Set([
  'steps',
  'missingReply',
  'blockedReason',
  'verificationDetail',
  'verificationMissing',
  'failureDetail',
  'deliveryDisclosure',
  'terminalRepairStatus',
  'terminalRepairGrantId',
  'terminalMissing',
  'terminalJudgeDisposition',
  'terminalJudgeReason',
  'terminalJudgeFamily',
  'terminalJudgeResumeCount',
  'limitKind',
  'lastDecisionSummary',
  'verification',
  'verifiedReadCompletionReceipt',
  'artifactVerification',
  'artifactRunScopeId',
  'transport',
  'maxTurns',
  'planProposalId',
  'planProposalStatus',
  'planProposalNeedsUserInput',
  'queuedTaskId',
  // Zero-work continuation replay lineage. The current typed identity remains
  // publication authority; these bounded ids only explain which settled
  // presentation was read instead of invoking another provider.
  'replayedFromSourceUserSeq',
  'replayedFromTerminalId',
  'replayedFromPresentationId',
  // A stop that HANDED the work to a durable background owner is not a
  // cancellation: the id names who is still running it, so clients can link the
  // turn to live work instead of showing it as abandoned.
  'transferredToTaskId',
  // Never-resting ceiling checkpoint: the bridge reads these off the terminal
  // to re-enter on the same spine a human `continue` uses. Without them the
  // park would be visually honest and functionally stranded.
  'autoResume',
  'autoResumeAttempt',
  'autoResumeCap',
]);
const WARM_DELIVERY_METADATA_KEYS: ReadonlySet<string> = new Set([
  'artifactId',
  'laneDigest',
  'counters',
  'warmReadPolicyDigest',
]);
const DELIVERY_METADATA_MAX_BYTES = 64 * 1024;

const READ_PROCEDURE_RESOLUTIONS = new Set([
  'hit',
  'miss',
  'stale',
  'unavailable',
  'quarantined',
]);
const READ_COUNTER_KEYS = new Set([
  'procedure_resolution',
  'schema_discovery_calls',
  'tool_discovery_calls',
  'provider_dispatches',
  'validation_repairs',
  'public_terminals',
  'external_write_or_send_dispatches',
]);
const VERIFIED_READ_RECEIPT_KEYS = new Set([
  'attemptId',
  'callId',
  'kind',
  'objectiveDigest',
  'outputDigest',
  'presentationDigest',
  'sourceUserSeq',
  'toolName',
  'version',
]);

function assertVerifiedReadCompletionReceipt(
  value: unknown,
  presentation: PresentationEvent,
): asserts value is ExactVerifiedReadCompletionCertificate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTurnOutcomeError('verifiedReadCompletionReceipt must be an exact object.');
  }
  const receipt = value as Record<string, unknown>;
  const keys = Object.keys(receipt);
  if (keys.length !== VERIFIED_READ_RECEIPT_KEYS.size
    || keys.some((key) => !VERIFIED_READ_RECEIPT_KEYS.has(key))) {
    throw new InvalidTurnOutcomeError('verifiedReadCompletionReceipt has an invalid shape.');
  }
  if (presentation.status !== 'done' || presentation.kind !== 'answer') {
    throw new InvalidTurnOutcomeError('verifiedReadCompletionReceipt requires a completed answer.');
  }
  if (receipt.version !== 1
    || (receipt.kind !== 'single_collection_read' && receipt.kind !== 'read_discovery_scaffold')) {
    throw new InvalidTurnOutcomeError('verifiedReadCompletionReceipt has an unsupported version or kind.');
  }
  if (!Number.isSafeInteger(receipt.sourceUserSeq)
    || receipt.sourceUserSeq !== presentation.identity.sourceUserSeq) {
    throw new InvalidTurnOutcomeError('verifiedReadCompletionReceipt contradicts the accepted source.');
  }
  for (const key of ['attemptId', 'callId', 'toolName'] as const) {
    const field = receipt[key];
    if (typeof field !== 'string' || field.trim() !== field || field.length < 1 || field.length > 512) {
      throw new InvalidTurnOutcomeError(`verifiedReadCompletionReceipt.${key} must be a bounded identifier.`);
    }
  }
  for (const key of ['objectiveDigest', 'outputDigest', 'presentationDigest'] as const) {
    if (typeof receipt[key] !== 'string' || !/^[a-f0-9]{64}$/.test(receipt[key] as string)) {
      throw new InvalidTurnOutcomeError(`verifiedReadCompletionReceipt.${key} must be a sha256 digest.`);
    }
  }
  const presentationDigest = createHash('sha256').update(presentation.text).digest('hex');
  if (receipt.presentationDigest !== presentationDigest) {
    throw new InvalidTurnOutcomeError('verifiedReadCompletionReceipt does not name the committed answer bytes.');
  }
}

function assertWarmReadMetadata(metadata: Readonly<Record<string, unknown>>): void {
  if (metadata.artifactId !== undefined
    && (typeof metadata.artifactId !== 'string' || !/^pa_[a-f0-9]{40}$/.test(metadata.artifactId))) {
    throw new InvalidTurnOutcomeError('artifactId must be a canonical procedure artifact id.');
  }
  if (metadata.laneDigest !== undefined
    && (typeof metadata.laneDigest !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.laneDigest))) {
    throw new InvalidTurnOutcomeError('laneDigest must be a sha256 digest.');
  }
  if (metadata.warmReadPolicyDigest !== undefined
    && (typeof metadata.warmReadPolicyDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(metadata.warmReadPolicyDigest))) {
    throw new InvalidTurnOutcomeError('warmReadPolicyDigest must be a sha256 digest.');
  }
  if (metadata.counters === undefined) return;
  if (!metadata.counters || typeof metadata.counters !== 'object' || Array.isArray(metadata.counters)) {
    throw new InvalidTurnOutcomeError('counters must be a bounded read-lane counter object.');
  }
  const counters = metadata.counters as Record<string, unknown>;
  if (Object.keys(counters).some((key) => !READ_COUNTER_KEYS.has(key))
    || Object.keys(counters).length !== READ_COUNTER_KEYS.size
    || typeof counters.procedure_resolution !== 'string'
    || !READ_PROCEDURE_RESOLUTIONS.has(counters.procedure_resolution)) {
    throw new InvalidTurnOutcomeError('counters contain an invalid read-lane counter shape.');
  }
  for (const key of READ_COUNTER_KEYS) {
    if (key === 'procedure_resolution') continue;
    const value = counters[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new InvalidTurnOutcomeError(`counters.${key} must be a non-negative safe integer.`);
    }
  }
}

export interface DeliveryCommitOptions {
  metadata?: Readonly<Record<string, unknown>>;
  /** Compatibility classifier for legacy readers. Typed status remains the
   * control-plane authority; this value is never presentation text. */
  legacyReason?: string;
  /**
   * The caller already replaced the reply with a MODEL-AUTHORED account of what
   * could not be verified. The floor is met by better words than this module
   * owns, so the generic sentence is not appended on top of it.
   */
  presentationAlreadyDiscloses?: boolean;
  /** A completed caller reached its own verification/judge gap before this
   * boundary. It must still propose `done`; the shared delivery rule decides
   * centrally whether that gap is a disclosure or a human hold. */
  deliveryConcern?: {
    reason: string;
    missing?: readonly string[];
  };
  /** A different-family terminal judge explicitly chose to deliver this
   * qualified completion. When absent, the judge was unavailable or this
   * legacy carrier has not reached the async gate, so the old conservative
   * hold policy remains the fallback. */
  terminalJudgeDisposition?: 'deliver';
}

export type DeliveryGap = { reason?: string; missing?: readonly string[] };

function mergeDeliveryGaps(...values: Array<DeliveryGap | null | undefined>): DeliveryGap | null {
  const reasons = [...new Set(values
    .map((value) => value?.reason?.replace(/\s+/g, ' ').trim())
    .filter((value): value is string => Boolean(value)))];
  const missing = [...new Set(values.flatMap((value) => value?.missing ?? []))].slice(0, 16);
  if (reasons.length === 0 && missing.length === 0) return null;
  return {
    ...(reasons.length > 0 ? { reason: reasons.join('; ').slice(0, 800) } : {}),
    ...(missing.length > 0 ? { missing } : {}),
  };
}

export interface AcceptedSourceDeliveryAssessment {
  settlementAudit: AcceptedSourceSettlementAudit;
  deliveryGap: DeliveryGap | null;
}

/**
 * Read the exact same terminal facts the synchronous committer will enforce.
 * Async brain lanes use this before publication so a different-family judge
 * can choose RESUME / ASK / DELIVER without reimplementing the manifest and
 * settlement rules. The committer calls it again at the final write boundary;
 * durable state—not an earlier snapshot—still wins any race.
 */
export function assessAcceptedSourceDelivery(input: {
  sessionId: string;
  sourceUserSeq: number;
  proposedReply: string;
  deliveryConcern?: DeliveryGap | null;
}): AcceptedSourceDeliveryAssessment {
  const settlementAudit = auditAcceptedSourceSettlementTruth({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
  });
  const preparation = settlementAudit.status === 'clean'
    ? prepareAcceptedTaskTerminal({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        proposedReply: input.proposedReply,
      })
    : { status: 'needs_verification' as const, reason: settlementAudit.reason };
  let deliveryGap = mergeDeliveryGaps(input.deliveryConcern);
  if (preparation.status !== 'ready' && preparation.status !== 'unstaged') {
    deliveryGap = mergeDeliveryGaps(deliveryGap, {
      ...('reason' in preparation && preparation.reason ? { reason: preparation.reason } : {}),
      ...('missing' in preparation && preparation.missing ? { missing: preparation.missing } : {}),
    });
  } else if (preparation.status === 'unstaged') {
    // Compatibility for historical manifests created before expected-work
    // staging. A source that has a work contract never enters this branch.
    const manifest = loadManifestState(input.sessionId, input.sourceUserSeq);
    if (manifest.status !== 'missing') {
      const verdict = adjudicateTerminalForTaskSync({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
      });
      if (verdict.status !== 'done') {
        deliveryGap = mergeDeliveryGaps(deliveryGap, {
          reason: verdict.facts.join('; ') || 'authoritative terminal evidence is incomplete',
          missing: verdict.missing,
        });
      }
    }
  }
  return { settlementAudit, deliveryGap };
}

function publicEvidenceKind(kind: WorkEvidenceRef['kind']): TurnEvidenceKind {
  switch (kind) {
    case 'artifact': return 'artifact';
    case 'source': return 'source';
    case 'external_write':
    case 'readback': return 'external_receipt';
    case 'tool_result':
    case 'worker_result':
    case 'other': return 'tool_result';
  }
}

/**
 * ONE GATE, AND IT DECIDES WHETHER A HUMAN CHECKS — NOT WHETHER YOU SEE ANYTHING.
 *
 * Roughly thirty independent conditions sit on this path (six settlement-audit
 * statuses, seventeen matcher conflict kinds, eight preparation refusals), and
 * every one of them could independently withhold a completed turn. ANDed
 * together at PUBLISH — after the work is done and the money spent — they
 * delivered about as often as that arithmetic predicts. Six consecutive live
 * runs on 2026-08-12 each finished their actual job and were each refused by a
 * DIFFERENT gate; not one of those refusals protected the user from anything.
 *
 * So the checks all still run, but the asynchronous terminal judge chooses
 * RESUME, ASK, or DELIVER from those facts. The sole deterministic HOLD floor
 * is an ambiguous IRREVERSIBLE effect (it may have sent; a human must inspect
 * state). A missing judge retains the older conservative policy so an outage
 * cannot make an existing carrier less safe. The precise concern keeps
 * travelling as metadata for forensics.
 */
export function deliveryMustHoldForHuman(audit: AcceptedSourceSettlementAudit): boolean {
  // The sole deterministic floor: an irreversible effect may have happened
  // and nobody can prove which state the world is in. A human must inspect it;
  // no model verdict is authority to repeat or wave away that ambiguity.
  return audit.status === 'uncertain_write';
}

/** A missing/failed/deliberately unavailable terminal judge must not make an
 * existing carrier less safe. This is the pre-judge policy, isolated from the
 * one deterministic floor so normal judged turns no longer inherit four
 * hard-coded dispositions. */
function deliveryMustHoldWhenJudgeUnavailable(audit: AcceptedSourceSettlementAudit): boolean {
  return deliveryMustHoldForHuman(audit)
    || audit.status === 'in_flight'
    || audit.status === 'storage_error'
    // A source where NOTHING worked has no answer to qualify. Disclosure only
    // makes sense alongside real work: attaching a caveat to a reply whose every
    // business call failed would publish a bare claim with a footnote, which is
    // worse than holding. Same earned-exemption rule the settlement audit uses.
    || audit.status === 'no_business_evidence'
    || (
      audit.facts.successfulBusinessSettlements === 0
      && audit.facts.successfulSdkBusinessResults === 0
      && audit.facts.successfulSdkAuthoringResults === 0
      && audit.facts.confirmedWrites === 0
    );
}

/** Durable partial evidence belongs to the turn however it publishes. A
 * qualified completion that dropped its refs would be a weaker terminal than
 * the hold it replaced. */
function withDurablePartialEvidence(
  outcome: Extract<TurnOutcome, { status: 'done' }>,
): NonNullable<TurnOutcome['evidenceRefs']> {
  let durablePartial: NonNullable<TurnOutcome['evidenceRefs']> = [];
  try {
    durablePartial = workEvidenceForAcceptedSource({
      sessionId: outcome.identity.sessionId,
      sourceUserSeq: outcome.identity.sourceUserSeq,
    }).map((ref) => ({ kind: publicEvidenceKind(ref.kind), id: ref.ref }));
  } catch { /* absence/unreadability cannot manufacture presentation evidence */ }
  return [...(outcome.evidenceRefs ?? []), ...durablePartial]
    .filter((ref, index, all) => all.findIndex((candidate) =>
      candidate.kind === ref.kind && candidate.id === ref.id && candidate.uri === ref.uri) === index)
    .slice(0, 100);
}

/** Publish the exact model/judge-authored answer. Qualification is DATA in the
 * terminal metadata; the synchronous committer must never improvise a second
 * Clementine sentence. Legacy callers without an async judge retain their
 * authored text and the conservative status fallback. */
function disclosedCompletionOutcome(
  outcome: Extract<TurnOutcome, { status: 'done' }>,
  _alreadyDiscloses: boolean,
): TurnOutcome {
  const evidenceRefs = withDurablePartialEvidence(outcome);
  return {
    ...outcome,
    ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
  };
}

function disclosedCompletionOptions(
  options: DeliveryCommitOptions,
  detail?: { reason?: string; missing?: readonly string[] },
): DeliveryCommitOptions {
  const metadata = { ...(options.metadata ?? {}) };
  // A read-lane completion certificate asserts verification this turn does not
  // have. Publishing the answer never manufactures that proof.
  delete metadata.verifiedReadCompletionReceipt;
  metadata.deliveryDisclosure = 'unverified_completion';
  if (detail?.reason) {
    metadata.verificationDetail = String(detail.reason).replace(/\s+/g, ' ').slice(0, 400);
  }
  if (detail?.missing?.length) {
    metadata.verificationMissing = detail.missing.slice(0, 8);
  }
  return { metadata };
}

function unverifiedCompletionOutcome(
  outcome: Extract<TurnOutcome, { status: 'done' }>,
  /** The reply is already the model's own account of the shortfall. Holding the
   * turn is no reason to throw those words away for a canned line — the hold
   * deserves the better explanation just as much as the completion does. */
  _keepAuthoredText = false,
): TurnOutcome {
  const evidenceRefs = withDurablePartialEvidence(outcome);
  // There is no safe generic substitute for a real model's account. Even on
  // the judge-unavailable fallback, preserve the only authored terminal rather
  // than replacing Clementine's voice in deterministic code. Async lanes mark
  // their authored disclosure explicitly; this fallback
  // covers legacy carriers too.
  if (outcome.presentation.text.trim().length > 0) {
    return {
      version: 2,
      id: outcome.id,
      identity: outcome.identity,
      status: 'blocked',
      resumable: true,
      presentation: { kind: 'blocked', text: outcome.presentation.text },
      ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
    };
  }
  throw new InvalidTurnOutcomeError(
    'An unverified completion has no model- or judge-authored public text.',
  );
}

function unverifiedCompletionOptions(
  options: DeliveryCommitOptions,
  detail?: { reason?: string; missing?: readonly string[] },
): DeliveryCommitOptions {
  const metadata = { ...(options.metadata ?? {}) };
  // A read-lane completion certificate cannot accompany a terminal that the
  // authoritative manifest has refused as complete.
  delete metadata.verifiedReadCompletionReceipt;
  const verificationDetail = detail?.reason
    ? String(detail.reason).replace(/\s+/g, ' ').slice(0, 400)
    : null;
  // Preserve the upstream verifier's concrete diagnosis in the compatibility
  // field. `verification_required` alone erased exactly the information the
  // old lane-local hold exposed, making the one-gate migration a forensic
  // regression even though the typed status stayed correct.
  metadata.blockedReason = verificationDetail ?? 'verification_required';
  // Name the refusing gate as DATA (never presentation text): two live
  // incidents (2026-08-11 shell, 2026-08-12 calendar) each cost an hour of
  // database forensics because the terminal said only verification_required.
  if (verificationDetail) metadata.verificationDetail = verificationDetail;
  if (detail?.missing?.length) {
    metadata.verificationMissing = detail.missing.slice(0, 8);
  }
  return {
    metadata,
    legacyReason: options.legacyReason ?? 'verification_required',
  };
}

interface DurableTurnOutcomeProjection {
  version: 2;
  id: string;
  status: TurnOutcomeStatus;
  resumable: boolean;
  needs?: TurnNeed;
  evidenceRefs?: PresentationEvent['evidenceRefs'];
}

function legacyReason(presentation: PresentationEvent): string {
  switch (presentation.status) {
    case 'done':
      return 'success';
    case 'needs_input':
      if (presentation.needs?.kind === 'approval') return 'awaiting_approval';
      if (presentation.needs?.kind === 'continue') return 'awaiting_continue';
      return 'awaiting_user_input';
    case 'blocked':
      return 'blocked';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'transferred':
      return 'transferred';
    case 'uncertain':
      return 'reconciliation_required';
  }
}

function durableOutcomeProjection(presentation: PresentationEvent): DurableTurnOutcomeProjection {
  return {
    version: 2,
    id: presentation.outcomeId,
    status: presentation.status,
    resumable: presentation.resumable,
    ...(presentation.needs ? { needs: presentation.needs } : {}),
    ...(presentation.evidenceRefs ? { evidenceRefs: presentation.evidenceRefs } : {}),
  };
}

/** Existing transports still read reply/summary/reason/delivered. Generate those
 * fields from the public projection while new readers adopt `presentation`. */
function safeDeliveryMetadata(
  metadata: DeliveryCommitOptions['metadata'],
  presentation: PresentationEvent,
): Record<string, unknown> {
  if (!metadata) return {};
  const warmTransport = metadata.transport === 'read_lane_warm'
    || metadata.transport === 'read_lane_warm_spent';
  if (warmTransport) assertWarmReadMetadata(metadata);
  if (metadata.verifiedReadCompletionReceipt !== undefined) {
    assertVerifiedReadCompletionReceipt(metadata.verifiedReadCompletionReceipt, presentation);
  }
  const selected: Record<string, unknown> = {};
  for (const key of DELIVERY_METADATA_KEYS) {
    if (metadata[key] !== undefined) selected[key] = metadata[key];
  }
  if (warmTransport) {
    for (const key of WARM_DELIVERY_METADATA_KEYS) {
      if (metadata[key] !== undefined) selected[key] = metadata[key];
    }
  }
  try {
    const json = JSON.stringify(selected);
    if (Buffer.byteLength(json, 'utf8') > DELIVERY_METADATA_MAX_BYTES) {
      throw new InvalidTurnOutcomeError('Delivery metadata exceeds 64 KiB. Store bulky evidence by reference.');
    }
    return JSON.parse(json) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof InvalidTurnOutcomeError) throw error;
    throw new InvalidTurnOutcomeError('Delivery metadata must be JSON-serializable.');
  }
}

export function completionDataForTurnOutcome(
  outcome: TurnOutcome,
  options: DeliveryCommitOptions = {},
): Record<string, unknown> {
  const presentation = presentationEventForOutcome(outcome);
  const identity = presentation.identity;
  const requestedLegacyReason = options.legacyReason?.trim();
  if (requestedLegacyReason && !/^[a-z0-9_]{1,80}$/.test(requestedLegacyReason)) {
    throw new InvalidTurnOutcomeError('legacyReason must be a short machine-readable label.');
  }
  const reason = requestedLegacyReason || legacyReason(presentation);
  const metadata = safeDeliveryMetadata(options.metadata, presentation);
  const data: Record<string, unknown> = {
    ...metadata,
    presentation,
    turnOutcome: durableOutcomeProjection(presentation),
    reply: presentation.text,
    summary: presentation.text.slice(0, 400),
    reason,
    // Compatibility only. New code reads turnOutcome.status; event existence is
    // the independent proof that presentation delivery committed.
    delivered: presentation.status === 'done',
    attemptId: 'attemptId' in identity ? identity.attemptId : undefined,
    runId: identity.runId,
    sourceUserSeq: identity.sourceUserSeq,
    ...(presentation.status === 'needs_input' ? { awaitingUser: true } : {}),
    ...(presentation.approvalId ? { pendingApprovalId: presentation.approvalId } : {}),
    ...(presentation.status === 'blocked' && metadata.blockedReason === undefined
      ? { blockedReason: 'blocked' }
      : {}),
  };
  // Do not serialize compatibility keys as explicit undefined values.
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) delete data[key];
  }
  return data;
}

function legacyText(event: EventRow): string {
  const reply = typeof event.data.reply === 'string' ? event.data.reply.trim() : '';
  const summary = typeof event.data.summary === 'string' ? event.data.summary.trim() : '';
  const text = reply || summary;
  if (!text) {
    throw new InvalidTurnOutcomeError('The existing terminal event has no public presentation text.');
  }
  return assertPublicPresentationText(text);
}

function normalizedReason(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase()
    : '';
}

/** A process upgraded between terminal append and retry may encounter an old
 * row with the same terminal key. The durable first writer remains authority;
 * adapt its public fields instead of returning the losing proposal. */
function presentationFromLegacyWinner(event: EventRow, proposed: PresentationEvent): PresentationEvent {
  const text = legacyText(event);
  const reason = normalizedReason(event.data.reason);
  const approvalId = typeof event.data.pendingApprovalId === 'string' && event.data.pendingApprovalId.trim()
    ? event.data.pendingApprovalId.trim()
    : undefined;

  let status: TurnOutcomeStatus = proposed.status;
  let kind: PresentationEvent['kind'] = proposed.kind;
  let needs: TurnNeed | undefined = proposed.needs;
  let resumable = proposed.resumable;

  if (approvalId || /awaiting_approval|pending_approval/.test(reason)) {
    status = 'needs_input';
    resumable = true;
    if (approvalId) {
      kind = 'approval';
      needs = { kind: 'approval' };
    } else {
      kind = 'question';
      needs = { kind: 'input' };
    }
  } else if (/awaiting_continue|limit_exceeded|max_turn|max_step|token_budget|budget_parked/.test(reason)) {
    // Budget parks — legacy ask-shaped rows included — replay as
    // blocked+resumable, never as a manufactured "reply continue" ask.
    // gate-reason.ts is the only author of needs_input; a ceiling is the
    // harness's own checkpoint and re-entry is the host's job (2026-08-18).
    status = 'blocked';
    kind = 'blocked';
    needs = undefined;
    resumable = true;
  } else if (event.data.awaitingUser === true || /awaiting_(?:user|input|reply)|needs_input/.test(reason)) {
    status = 'needs_input';
    kind = 'question';
    needs = { kind: 'input' };
    resumable = true;
  } else if (/transferred/.test(reason)) {
    // The foreground stopped, but the work did not. A legacy row that says
    // transferred must keep saying transferred rather than being re-read as an
    // abandoned turn by the cancelled branch below.
    status = 'transferred';
    kind = 'transferred';
    needs = undefined;
    resumable = false;
  } else if (/cancelled|canceled|aborted|stopped|rejected_by_user/.test(reason)) {
    status = 'cancelled';
    kind = 'stopped';
    needs = undefined;
    resumable = false;
  } else if (reason === 'budget_checkpoint_auto_resume') {
    // A never-resting ceiling checkpoint: parked blocked + resumable with the
    // bridge re-entering on its own. Rewriting it to needs_input would hand the
    // harness's bookkeeping to the user; dropping resumable would strand it.
    status = 'blocked';
    kind = 'blocked';
    needs = undefined;
    resumable = true;
  } else if (/fail|error|no_structured|exhaust/.test(reason)) {
    status = 'failed';
    kind = 'error';
    needs = undefined;
    resumable = false;
  } else if (event.data.delivered === false || /blocked|stall|abandon/.test(reason)) {
    status = 'blocked';
    kind = 'blocked';
    needs = undefined;
    resumable = false;
  } else if (event.data.delivered === true || /success|delivered|complete/.test(reason)) {
    status = 'done';
    kind = 'answer';
    needs = undefined;
    resumable = false;
  }

  return {
    version: 1,
    id: proposed.id,
    outcomeId: proposed.outcomeId,
    audience: 'user',
    phase: 'final',
    identity: proposed.identity,
    status,
    kind,
    text,
    resumable,
    ...(needs ? { needs } : {}),
    ...(approvalId ? { approvalId } : {}),
  };
}

function sameTurnIdentity(left: TurnIdentity, right: TurnIdentity): boolean {
  // Physical attempts can legitimately race or fall over while completing the
  // same accepted user turn. Only the durable source event owns publication.
  return left.sessionId === right.sessionId
    && left.turn === right.turn
    && left.sourceUserSeq === right.sourceUserSeq;
}

function assertExactAcceptedSource(identity: TurnIdentity): void {
  const accepted = listEvents(identity.sessionId, {
    sinceSeq: identity.sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  })[0];
  if (!accepted || accepted.seq !== identity.sourceUserSeq) {
    throw new InvalidTurnOutcomeError(
      `Turn identity source ${identity.sourceUserSeq} is not an accepted user event in this session.`,
    );
  }
  if (accepted.turn !== identity.turn) {
    throw new InvalidTurnOutcomeError(
      `Turn identity ${identity.turn} contradicts accepted event ${identity.sourceUserSeq} turn ${accepted.turn}.`,
    );
  }
}

function isExplicitLegacyTerminal(event: EventRow): boolean {
  return !Object.prototype.hasOwnProperty.call(event.data, 'presentation')
    && !Object.prototype.hasOwnProperty.call(event.data, 'turnOutcome');
}

function assertPersistedPresentationOwnership(
  event: EventRow,
  persisted: PresentationEvent,
  proposed: PresentationEvent,
): void {
  if (event.sessionId !== persisted.identity.sessionId || event.turn !== persisted.identity.turn) {
    throw new InvalidTurnOutcomeError(
      'Persisted presentation identity contradicts its conversation_completed event.',
    );
  }
  if (!sameTurnIdentity(persisted.identity, proposed.identity)) {
    throw new InvalidTurnOutcomeError(
      'Persisted terminal winner belongs to a different turn identity.',
    );
  }
}

function repairArgumentsNeedsInputOutcome(
  outcome: Extract<TurnOutcome, { status: 'needs_input' }>,
  text: string,
): Extract<TurnOutcome, { status: 'needs_input' }> {
  // A repair choice is ordinary user input.  Do not preserve a model-proposed
  // approval/continue edge (or its opaque id) after durable settlement says
  // the actual choice is repair-or-stop.
  return {
    version: 2,
    id: outcome.id,
    identity: outcome.identity,
    ...(outcome.evidenceRefs ? { evidenceRefs: outcome.evidenceRefs } : {}),
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text },
  };
}

/**
 * Commit exactly one final public presentation for a logical user turn.
 *
 * Throws on invalid/unsafe presentation or durable write failure. A foreground
 * caller must never return success, clear recovery state, or stream the proposed
 * text until this function succeeds.
 */
/** Honest terminal for a host-side failure with a provably effect-free ledger.
 * Value-opaque like every host constant: no tool names, no model prose. */
export const HOST_LOCAL_FAILURE_BLOCKED_TEXT =
  'A host-side step failed after running locally. Nothing external was executed or changed — no call left this machine for this request — so there is nothing to reconcile. Ask me to continue and I will retry from the durable checkpoint.';

/**
 * Ledger effect-truth for one accepted source: true only when the write ledger
 * can PROVE nothing external could have run — zero physical dispatches outside
 * the host site and zero settlements that own reconciliation. Any unreadable
 * ledger keeps the conservative uncertainty copy: honesty may only ever be
 * upgraded on proof, never on a query failure.
 */
function acceptedSourceHasZeroExternalEffectSurface(
  identity: TurnIdentity,
): boolean {
  try {
    const row = openEventLog().prepare(`
      SELECT
        (SELECT COUNT(*) FROM physical_dispatches
          WHERE session_id = ? AND source_user_seq = ?
            AND (execution_site IS NULL OR execution_site <> 'host')) AS external_dispatches,
        (SELECT COUNT(*) FROM logical_call_settlements
          WHERE session_id = ? AND source_user_seq = ?
            AND (outcome_kind = 'uncertain_write' OR requires_reconciliation = 1)) AS reconciliation_owed
    `).get(
      identity.sessionId,
      identity.sourceUserSeq,
      identity.sessionId,
      identity.sourceUserSeq,
    ) as { external_dispatches: number; reconciliation_owed: number } | undefined;
    return row !== undefined
      && row.external_dispatches === 0
      && row.reconciliation_owed === 0;
  } catch {
    return false;
  }
}

export function commitTurnOutcome(
  outcome: TurnOutcome,
  options: DeliveryCommitOptions = {},
): DeliveryCommitResult {
  const requested = presentationEventForOutcome(outcome);
  assertExactAcceptedSource(requested.identity);
  let effectiveOutcome = outcome;
  let effectiveOptions = options;
  /** Set when a verification shortfall was DISCLOSED rather than held, so a
   * durable publication invariant can still send it back to the hold. */
  let disclosedInsteadOfHeld = false;
  let disclosureDetail: { reason?: string; missing?: readonly string[] } = {};
  if (outcome.status === 'needs_input') {
    const recoveryPresentation = constrainNeedsInputPresentationForRecovery({
      sessionId: requested.identity.sessionId,
      sourceUserSeq: requested.identity.sourceUserSeq,
      proposedText: requested.text,
    });
    if (recoveryPresentation.constrained) {
      effectiveOutcome = repairArgumentsNeedsInputOutcome(outcome, recoveryPresentation.text);
      // The durable directive replaced any approval/continue edge with an
      // ordinary repair-or-stop question. Compatibility readers still inspect
      // `reason`, so it must describe the same edge as the typed projection.
      effectiveOptions = {
        ...options,
        legacyReason: 'awaiting_user_input',
      };
    }
  }
  // An immutable expected-work contract is the staged cut-over marker. Before
  // publishing `done`, derive the manifest and redeem host evidence from the
  // exact settled calls. Historical/action-deferred sources retain their
  // existing behavior; they never borrow staged authority by accident.
  if (outcome.status === 'done') {
    const assessment = assessAcceptedSourceDelivery({
      sessionId: requested.identity.sessionId,
      sourceUserSeq: requested.identity.sourceUserSeq,
      proposedReply: requested.text,
      deliveryConcern: options.deliveryConcern,
    });
    const { settlementAudit, deliveryGap } = assessment;
    if (deliveryGap) {
      const mustHold = options.terminalJudgeDisposition === 'deliver'
        ? deliveryMustHoldForHuman(settlementAudit)
        : deliveryMustHoldWhenJudgeUnavailable(settlementAudit);
      if (mustHold) {
        effectiveOutcome = unverifiedCompletionOutcome(
          outcome,
          options.presentationAlreadyDiscloses === true,
        );
        effectiveOptions = unverifiedCompletionOptions(options, deliveryGap);
      } else {
        effectiveOutcome = disclosedCompletionOutcome(
          outcome,
          options.presentationAlreadyDiscloses === true,
        );
        effectiveOptions = disclosedCompletionOptions(options, deliveryGap);
        disclosedInsteadOfHeld = true;
        disclosureDetail = deliveryGap;
      }
    }
  }
  // TERMINAL COPY DERIVES FROM THE WRITE LEDGER'S EFFECT-TRUTH, never from
  // tool-shape heuristics. The host runner's uncertain-blocked constant claims
  // possible external execution; the ledger for this exact accepted source is
  // the authority on whether anything external could have run. Live 2026-08-26:
  // all 12 blocked terminals rendered "may have begun… must be reconciled"
  // about host-only meta-tools with ZERO non-host dispatch rows, and the
  // phantom uncertainty then poisoned later turns cross-brain (S6) with no
  // user-reachable path to clear it. A turn whose ledger shows zero external
  // dispatches may never claim possible external execution; a turn WITH an
  // unresolved external crossing keeps the reconciliation copy unchanged.
  if (
    effectiveOutcome.status === 'blocked'
    && effectiveOutcome.presentation.text === HOST_TOOL_UNCERTAIN_BLOCKED_TEXT
    && acceptedSourceHasZeroExternalEffectSurface(effectiveOutcome.identity)
  ) {
    effectiveOutcome = {
      ...effectiveOutcome,
      // Nothing left the machine, so retrying is provably safe: the honest
      // terminal is a resumable checkpoint, not a locked reconciliation door.
      resumable: true,
      presentation: { kind: 'blocked', text: HOST_LOCAL_FAILURE_BLOCKED_TEXT },
    };
    effectiveOptions = {
      ...effectiveOptions,
      metadata: {
        ...(effectiveOptions.metadata ?? {}),
        blockedReason: 'host_control_failure_no_external_effect',
      },
    };
  }
  const proposed = presentationEventForOutcome(effectiveOutcome);
  // A prepared/held workflow admission is durable accepted work, not an error
  // or needs-input terminal. Until immutable group activation transfers that
  // ownership to the background daemon, no brain/bridge may publish a terminal
  // winner for the same source and erase its only restart handle.
  assertNoPendingWorkflowChatDispatchOwnership({
    sessionId: proposed.identity.sessionId,
    sourceUserSeq: proposed.identity.sourceUserSeq,
  });
  let data = completionDataForTurnOutcome(effectiveOutcome, effectiveOptions);
  let terminal;
  try {
    terminal = appendTerminalEventOnce({
      sessionId: proposed.identity.sessionId,
      turn: proposed.identity.turn,
      role: 'system',
      data,
    }, proposed.outcomeId);
  } catch (error) {
    // A `done` terminal is not only a presentation: it CLOSES the accepted-task
    // authority, and the durable state machine refuses to close one that never
    // entered manifested verification. That invariant is older and deeper than
    // the disclosure rule, so the database stays authoritative here rather than
    // this module re-deriving the condition and drifting from it. A turn that
    // cannot legally complete is genuinely incomplete: fall back to the hold.
    if (!disclosedInsteadOfHeld || !(error instanceof AcceptedTaskTerminalPublicationError)) throw error;
    effectiveOutcome = unverifiedCompletionOutcome(
      outcome as Extract<TurnOutcome, { status: 'done' }>,
      options.presentationAlreadyDiscloses === true,
    );
    effectiveOptions = unverifiedCompletionOptions(options, disclosureDetail);
    effectiveOptions = {
      ...effectiveOptions,
      metadata: {
        ...(effectiveOptions.metadata ?? {}),
        // The shared rule selected DISCLOSE, then the durable accepted-task
        // state machine correctly refused to close an unmanifested authority.
        // Keep that two-stage disposition observable instead of making it look
        // indistinguishable from a direct human hold.
        deliveryDisclosure: 'state_machine_hold',
      },
    };
    const heldPresentation = presentationEventForOutcome(effectiveOutcome);
    data = completionDataForTurnOutcome(effectiveOutcome, effectiveOptions);
    terminal = appendTerminalEventOnce({
      sessionId: heldPresentation.identity.sessionId,
      turn: heldPresentation.identity.turn,
      role: 'system',
      data,
    }, heldPresentation.outcomeId);
  }
  // THE FENCE IS WRITTEN WHERE THE FOREGROUND ACTUALLY STOPS. Detach cannot
  // assert it: at that point the run is still executing and may yet complete an
  // in-flight tool call. Only the committer knows the final model/tool boundary
  // has been crossed and no further foreground work can occur for this turn,
  // which is exactly what the fence rung claims. Both brain lanes reduce through
  // here, so neither can transfer a turn without fencing and releasing it.
  try {
    fenceAndReleaseHandoffAtTerminal(proposed.identity.sessionId, proposed.identity.sourceUserSeq);
  } catch { /* the terminal is durable; ownership converges at boot reconciliation */ }
  const decoded = presentationEventFromCompletionData(terminal.event.data);
  let persisted: PresentationEvent;
  if (decoded) {
    assertPersistedPresentationOwnership(terminal.event, decoded, proposed);
    persisted = decoded;
  } else {
    // Compatibility is deliberately narrow: only a row written before typed
    // projections existed may borrow the retry's canonical identity. A row
    // containing either typed field is never reinterpreted as legacy.
    if (!isExplicitLegacyTerminal(terminal.event)) {
      throw new InvalidTurnOutcomeError('Typed terminal row could not be decoded safely.');
    }
    persisted = presentationFromLegacyWinner(terminal.event, proposed);
  }
  // Clarification continuity is a derived, private restart aid. Create it only
  // after the typed public terminal is durable and only when the exact paired
  // awaiting event proves this was an ordinary clarification. A failure here
  // cannot roll back or mask the already-committed user-facing outcome.
  try {
    persistCommittedClarificationContinuity({
      terminalEvent: terminal.event,
      presentation: persisted,
    });
  } catch { /* next turn safely falls back to ordinary discovery */ }
  return {
    event: terminal.event,
    inserted: terminal.inserted,
    presentation: persisted,
  };
}
