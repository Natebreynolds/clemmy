import { redactSensitiveText } from '../security.js';
/**
 * The single durable foreground-delivery boundary.
 *
 * Both brain lanes reduce their execution state to a TurnOutcome and call this
 * function. The committer writes one idempotent conversation_completed row and
 * derives every legacy field from the public PresentationEvent. It never accepts
 * arbitrary event data, so internal summaries and raw model output have no path
 * into the user-facing terminal payload.
 */
import { acceptedTaskMode } from './accepted-task-mode.js';
import { finishRunAttempt } from './eventlog.js';
import { createHash } from 'node:crypto';
import { readCommittedArtifactContent } from './host-local-write-commit.js';
import { completionReviewEnabled } from './respond-bridge.js';
import { acceptedObjectiveForSource, completionVerdictForAcceptedSource, readCapturedCompletionPolicy, settledSourceArtifacts } from './host-turn-runner.js';
import { sourceRefusedAttempts } from './source-refused-attempts.js';
import {
  AcceptedTaskTerminalPublicationError,
  appendTerminalEventOnce,
  listEvents,
  getSession,
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
import { exactPartialMutationPresentation } from './mutation-verification-presentation.js';
import { persistCommittedClarificationContinuity } from './task-continuity-runtime.js';
import { assertNoPendingWorkflowChatDispatchOwnership } from '../../tools/workflow-run-queue.js';
import { fenceAndReleaseHandoffAtTerminal } from '../../execution/continuation-capsule.js';
import type { ExactVerifiedReadCompletionCertificate } from './verified-read-completion.js';
import { loadManifestState } from './obligation-store.js';
import { adjudicateTerminalForTaskSync } from './terminal-truth.js';
import {
  pendingAcceptedReadPlan,
  prepareAcceptedTaskTerminal,
} from './accepted-task-terminal-preparation.js';
import {
  auditAcceptedSourceSettlementTruth,
  type AcceptedSourceSettlementAudit,
} from './accepted-source-settlement-audit.js';
import { workEvidenceForAcceptedSource, type WorkEvidenceRef } from './work-manifest.js';
import { constrainNeedsInputPresentationForRecovery } from './recovery-presentation-truth.js';
import { learnVerifiedWriteCapabilitiesForAcceptedTask } from './verified-write-capability-learning.js';
import { renderFailureWithRetainedWork } from './retained-work-terminal.js';
import { pendingAcceptedLocalWork } from './local-work-completion.js';
import { getPlanRevisionForSource } from './plan-artifacts.js';

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
  // Bounded machine detail beside blockedReason (for example the last host
  // pre-dispatch refusal check that exhausted the no-progress governor).
  // Metadata only: presentation text never derives from it.
  'blockedDetail',
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
  localWorkIncomplete: boolean;
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
  const localWork = pendingAcceptedLocalWork(input);
  deliveryGap = mergeDeliveryGaps(deliveryGap, localWork);
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
    } else if (
      !acceptedSourceHasBusinessEvidence(settlementAudit)
      && sourceRefusedWorkWithoutDispatch(input)
    ) {
      // DELIVERY TRUTH WITHOUT A CONTRACT. A refused plan leaves no
      // expected-work contract and no manifest, so from the contract tables
      // this turn looks like ordinary conversation — yet the host durably
      // recorded that it refused this source's work before dispatch and no
      // provider call ever crossed. A `done` claim after that has nothing to
      // answer FROM (live: plan_task refused, the fused work_call refused
      // pre-dispatch, dispatches=0, "Your calendar is ready." stamped
      // delivered). The gap travels as data; the judge-unavailable policy
      // holds it and a different-family judge may still choose to disclose.
      deliveryGap = mergeDeliveryGaps(deliveryGap, {
        reason: 'the host refused this source\'s planned work before dispatch and no provider call '
          + 'was made; a completion claim has no business evidence to answer from',
        missing: ['work_refused_without_business_evidence'],
      });
    }
  }
  return { settlementAudit, deliveryGap, localWorkIncomplete: localWork !== null };
}

function acceptedSourceHasBusinessEvidence(audit: AcceptedSourceSettlementAudit): boolean {
  return audit.facts.successfulBusinessSettlements > 0
    || audit.facts.successfulSdkBusinessResults > 0
    || audit.facts.successfulSdkAuthoringResults > 0
    || audit.facts.confirmedWrites > 0;
}

/** The host refused at least one of this source's calls before dispatch (a
 * durable host disposition receipt or a refused_pre_dispatch settlement) and
 * no physical dispatch was ever started for the source. Unreadable storage
 * manufactures neither a hold nor permission to publish. */
function sourceRefusedWorkWithoutDispatch(input: {
  sessionId: string;
  sourceUserSeq: number;
}): boolean {
  try {
    const db = openEventLog();
    const refused = db.prepare(`
      SELECT 1 FROM host_model_result_receipts
       WHERE session_id = ? AND source_user_seq = ? AND disposition = 'refused_pre_dispatch'
       LIMIT 1
    `).get(input.sessionId, input.sourceUserSeq) !== undefined
      || db.prepare(`
        SELECT 1 FROM logical_call_settlements
         WHERE session_id = ? AND source_user_seq = ?
           AND business_call = 1 AND execution_kind = 'refused_pre_dispatch'
         LIMIT 1
      `).get(input.sessionId, input.sourceUserSeq) !== undefined;
    if (!refused) return false;
    const dispatched = db.prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
    `).get(input.sessionId, input.sourceUserSeq) as { n: number };
    return dispatched.n === 0;
  } catch {
    return false;
  }
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
    || audit.status === 'write_projection_missing'
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

function withExactMutationPartialTruth(
  outcome: Extract<TurnOutcome, { status: 'done' }>,
): Extract<TurnOutcome, { status: 'done' }> {
  const text = exactPartialMutationPresentation({
    sessionId: outcome.identity.sessionId,
    sourceUserSeq: outcome.identity.sourceUserSeq,
  });
  return text
    ? { ...outcome, presentation: { kind: 'answer', text } }
    : outcome;
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
    // This projection changed the typed terminal from done to blocked.  The
    // compatibility reason must change with it: preserving an upstream
    // `success` here creates the internally impossible row
    // `{ status: blocked, reason: success }` at the one durable gateway.
    legacyReason: 'verification_required',
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
  'Something on my side failed while I was finishing this. Nothing was sent or changed, and what I already gathered is kept.';

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


function withRetainedWorkTerminal(outcome: TurnOutcome): TurnOutcome {
  switch (outcome.status) {
    case 'needs_input': {
      const text = renderFailureWithRetainedWork({
        sessionId: outcome.identity.sessionId,
        sourceUserSeq: outcome.identity.sourceUserSeq,
        fallbackText: outcome.presentation.text,
      });
      if (text === outcome.presentation.text) return outcome;
      if (outcome.presentation.kind === 'approval') {
        return {
          ...outcome,
          needs: { kind: 'approval' },
          presentation: { ...outcome.presentation, text },
        };
      }
      if (outcome.presentation.kind === 'continue') {
        return {
          ...outcome,
          needs: { kind: 'continue' },
          presentation: { ...outcome.presentation, text },
        };
      }
      return {
        ...outcome,
        needs: { kind: 'input' },
        presentation: { ...outcome.presentation, text },
      };
    }
    case 'blocked': {
      const text = renderFailureWithRetainedWork({
        sessionId: outcome.identity.sessionId,
        sourceUserSeq: outcome.identity.sourceUserSeq,
        fallbackText: outcome.presentation.text,
      });
      return text === outcome.presentation.text
        ? outcome
        : { ...outcome, presentation: { kind: 'blocked', text } };
    }
    case 'uncertain': {
      const text = renderFailureWithRetainedWork({
        sessionId: outcome.identity.sessionId,
        sourceUserSeq: outcome.identity.sourceUserSeq,
        fallbackText: outcome.presentation.text,
      });
      return text === outcome.presentation.text
        ? outcome
        : { ...outcome, presentation: { kind: 'blocked', text } };
    }
    case 'failed': {
      const text = renderFailureWithRetainedWork({
        sessionId: outcome.identity.sessionId,
        sourceUserSeq: outcome.identity.sourceUserSeq,
        fallbackText: outcome.presentation.text,
      });
      return text === outcome.presentation.text
        ? outcome
        : { ...outcome, presentation: { kind: 'error', text } };
    }
    default:
      return outcome;
  }
}


/** Did this accepted source publish an inspectable plan revision? */
function acceptedSourcePublishedPlanRevision(identity: {
  sessionId: string; sourceUserSeq: number;
}): boolean {
  try {
    return listEvents(identity.sessionId, { types: ['plan_revision_published'] })
      .some((row) => row.data.sourceUserSeq === identity.sourceUserSeq);
  } catch {
    // Unreadable history must not turn a good plan into a question.
    return true;
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
    // The asynchronous terminal judge/repair is advisory prose. Re-project an
    // exact partial mutation at the single public write boundary as well, so a
    // judge that repeats a stale full-completion claim cannot leak it through
    // the terminal row or transport edit.
    const mutationTruthOutcome = withExactMutationPartialTruth(outcome);
    effectiveOutcome = mutationTruthOutcome;
    const assessment = assessAcceptedSourceDelivery({
      sessionId: requested.identity.sessionId,
      sourceUserSeq: requested.identity.sourceUserSeq,
      proposedReply: mutationTruthOutcome.presentation.text,
      deliveryConcern: options.deliveryConcern,
    });
    const { settlementAudit, deliveryGap } = assessment;
    if (deliveryGap) {
      // A judge may author the best public explanation, but it cannot erase a
      // frozen read plan that has not executed even one accepted operation.
      // This is the source-91257 floor: plan_task succeeded, the model stopped,
      // and a truthful-sounding explanation was otherwise stamped success.
      const acceptedReadPlanStillPending = pendingAcceptedReadPlan({
        sessionId: requested.identity.sessionId,
        sourceUserSeq: requested.identity.sourceUserSeq,
      }) !== null;
      const mustHold = assessment.localWorkIncomplete || acceptedReadPlanStillPending
        || (options.terminalJudgeDisposition === 'deliver'
          ? deliveryMustHoldForHuman(settlementAudit)
          : deliveryMustHoldWhenJudgeUnavailable(settlementAudit));
      if (mustHold) {
        effectiveOutcome = unverifiedCompletionOutcome(
          mutationTruthOutcome,
          options.presentationAlreadyDiscloses === true,
        );
        effectiveOptions = unverifiedCompletionOptions(options, deliveryGap);
      } else {
        effectiveOutcome = disclosedCompletionOutcome(
          mutationTruthOutcome,
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
  // A PLAN TURN'S DELIVERABLE IS A PLAN.
  //
  // Nothing asserted this, so an explicit Plan request could end `done` with a
  // conversational answer and no published revision — leaving exact Execute
  // with nothing to run and the mode silently degraded to chat. Live
  // 2026-09-07 source 149138: a genuinely good Platform 49 analysis, zero
  // mutations, terminal `done`, and no plan_revision_published anywhere in the
  // session.
  //
  // The analysis is kept and the turn stays resumable — this is not a failure
  // and nothing is discarded. It simply stops calling itself finished when the
  // thing the owner asked for was not produced.
  if (effectiveOutcome.status === 'done') {
    try {
      const mode = acceptedTaskMode(
        effectiveOutcome.identity.sessionId,
        effectiveOutcome.identity.sourceUserSeq,
      );
      if (mode?.kind === 'plan' && !acceptedSourcePublishedPlanRevision(effectiveOutcome.identity)) {
        effectiveOutcome = {
          ...effectiveOutcome,
          status: 'needs_input',
          resumable: true,
          needs: { kind: 'input' },
          presentation: {
            kind: 'question',
            text: `${effectiveOutcome.presentation.text}\n\n`
              + '_I have not published this as an inspectable plan yet, so there is '
              + 'nothing to Execute. Say the word and I will publish it as a plan '
              + 'revision you can review and run._',
          },
        };
      }
    } catch { /* mode is advisory here; never fail a terminal on it */ }
  }
  // Completion depends on the accepted objective and its evidence. A carrier
  // call with no business settlement may be a valid retained-data answer or an
  // adopted cancellation; one unrelated (or failed) business call proves no
  // objective complete. The host completion reviewer owns semantic gaps, while
  // the typed delivery assessment above retains concrete unfinished-work floors.
  effectiveOutcome = withRetainedWorkTerminal(effectiveOutcome);
  const proposed = presentationEventForOutcome(effectiveOutcome);
  // A prepared/held workflow admission is durable accepted work, not an error
  // or needs-input terminal. Until immutable group activation transfers that
  // ownership to the background daemon, no brain/bridge may publish a terminal
  // winner for the same source and erase its only restart handle.
  assertNoPendingWorkflowChatDispatchOwnership({
    sessionId: proposed.identity.sessionId,
    sourceUserSeq: proposed.identity.sourceUserSeq,
  });
  // This ref comes only from the complete immutable artifact published by this
  // exact accepted source. It is deliberately absent from the caller-metadata
  // allowlist, so a model reply cannot nominate a different plan for Execute.
  const planSession = getSession(proposed.identity.sessionId);
  const publishedPlan = planSession ? getPlanRevisionForSource({
    sessionId: proposed.identity.sessionId, sourceUserSeq: proposed.identity.sourceUserSeq,
    principalId: planSession.userId ?? planSession.id,
  }) : null;
  const planMetadata = publishedPlan ? { planArtifactRef: {
    planId: publishedPlan.planId, revision: publishedPlan.revision, digest: publishedPlan.digest,
  } } : {};
  // The completion verdict for this exact accepted source, derived HERE from the
  // durable event rather than accepted from caller metadata — the same reasoning
  // as planArtifactRef above, so a model reply cannot nominate its own verdict.
  // Read at publish time, so a terminal committed after a crash/reopen in
  // another process binds the same verdict the first attempt would have.
  const publishedVerdict = completionVerdictForAcceptedSource({
    sessionId: proposed.identity.sessionId,
    sourceUserSeq: proposed.identity.sourceUserSeq,
  });
  // VALIDATE before attaching. Copying a same-source verdict without checking it
  // against the bytes actually being published let a mismatched reply, a stale
  // objective, a vanished artifact and a NEGATIVE verdict all publish as
  // completion. `proposed.text` is the exact published presentation — every
  // rewrite happens above this line.
  // The policy this run ACTUALLY ran under, stamped at accept time. Re-reading
  // the live setting here let a switch flipped between the work and the terminal
  // relabel the run in either direction. The live value is used only when no
  // stamp exists (a source accepted by an older build).
  const capturedRead = readCapturedCompletionPolicy({
    sessionId: proposed.identity.sessionId,
    sourceUserSeq: proposed.identity.sourceUserSeq,
  });
  // 'absent' is a legacy source with no stamp — today's setting is the honest
  // best answer. 'unreadable' is a STORE FAILURE and must never be quietly
  // replaced by today's setting, which would be a policy claim we cannot back.
  const reviewWasEnabled = capturedRead.status === 'captured'
    ? capturedRead.policy.enabled
    : capturedRead.status === 'absent' && completionReviewEnabled();
  const policyEvidence = capturedRead.status;
  const reviewDisposition = ((): 'disabled_by_owner' | 'reviewed' | 'enabled_unavailable' => {
    // A policy we could not read cannot certify anything about this run.
    if (capturedRead.status === 'unreadable') return 'enabled_unavailable';
    if (!reviewWasEnabled) return 'disabled_by_owner';
    if (!publishedVerdict) return 'enabled_unavailable';
    // A review that ran but did not stand — negative, failed open, or with
    // unreadable evidence — is NOT 'reviewed'. Calling it reviewed is what let a
    // failed-open publish look like a successful evaluation.
    if (publishedVerdict.failedOpen === true) return 'enabled_unavailable';
    if (publishedVerdict.settledEvidenceAvailable === false) return 'enabled_unavailable';
    if (!publishedVerdict.fulfills) return 'enabled_unavailable';
    return 'reviewed';
  })();
  // OBJECTIVE VALIDATION against the same authority-aware expression the judge
  // used. A verdict whose objectiveDigest names a different objective was still
  // accepted as verified after reopen; comparing to raw user text instead would
  // fail Plan and Execute, whose accepted expressions legitimately differ.
  const acceptedObjective = acceptedObjectiveForSource({
    sessionId: proposed.identity.sessionId,
    sourceUserSeq: proposed.identity.sourceUserSeq,
  });
  const objectiveMatches = publishedVerdict?.objectiveDigest
    ? (acceptedObjective !== null
      && publishedVerdict.objectiveDigest
        === createHash('sha256').update(acceptedObjective, 'utf8').digest('hex'))
    : false;
  const replyMatches = publishedVerdict?.replyDigest
    ? publishedVerdict.replyDigest === createHash('sha256').update(proposed.text, 'utf8').digest('hex')
    : false;
  // RE-VERIFY the artifacts NOW, against the files as they stand at publication.
  // Trusting the `digestMatches` flags recorded during judging misses every
  // change made between the verdict and the terminal — the artifact could have
  // been altered, truncated or deleted in that window and still publish as
  // verified. `readCommittedArtifactContent` re-opens each handle through the
  // same safe reader and re-hashes the raw bytes.
  // History is not required coverage. A superseded generation, and any effect
  // with no file contract, are excluded from the current-bytes recheck —
  // publication was requiring every historical receipt to match current bytes,
  // which no valid edit can satisfy.
  const artifactCoverage = (publishedVerdict?.artifacts ?? [])
    .filter((entry) => entry.superseded !== true && entry.evidenceContract !== 'none')
    .map((entry) => {
    const recheck = readCommittedArtifactContent({
      createdId: entry.createdId,
      handle: entry.handle,
      contentDigest: entry.contentDigest,
      receipt: '',
    });
    return {
      createdId: entry.createdId,
      handle: entry.handle,
      contentDigest: entry.contentDigest,
      judgedMatch: entry.digestMatches === true,
      currentMatch: recheck.verified,
    };
  });
  // Coverage is REQUIRED: a verdict with no artifacts cannot vouch for a turn
  // that settled work, and one whose artifacts no longer verify cannot either.
  // Coverage is required only when this source actually settled work. An
  // ordinary artifact-free answer must not be made to look unverified for
  // having produced no artifact.
  // THE REQUIREMENT COMES FROM CANONICAL SETTLED WORK, not from the verdict.
  // Reading `settledEffectCount` off the verdict let a missing or omitted field
  // self-exempt: no verdict, or a verdict with the field absent and no
  // artifacts, published as done/verified. The settled ledger is the authority
  // on whether this request performed work; the verdict is only evidence about
  // that work.
  const settledNow = settledSourceArtifacts({
    sessionId: proposed.identity.sessionId,
    sourceUserSeq: proposed.identity.sourceUserSeq,
  });
  // Required only when this request produced FILE-contract work. A turn whose
  // only effects were deletions or non-file writes requires no artifact.
  const artifactsRequired = settledNow.artifacts.some((entry) => (
    !entry.superseded && (entry.evidenceContract === 'file' || entry.evidenceContract === 'unknown')
  ));
  // REQUIRED vs JUDGED vs CURRENT. Every settled identity must have been judged
  // and must still verify now; a judged list that omits settled work is not
  // coverage. Unresolved settled evidence fails coverage rather than vanishing.
  // TYPED REVISION IDENTITY, not names. A workflow and a Space can share a
  // createdId while differing in handle and digest, so a name join let judging
  // only one of them pass. Coverage compares the exact revision.
  const revisionKey = (entry: { createdId: string; handle: string; contentDigest: string }) =>
    `${entry.createdId}\u0000${entry.handle}\u0000${entry.contentDigest}`;
  const judgedRevisions = new Set(artifactCoverage.map(revisionKey));
  // Only FINAL generations of FILE-contract effects can be required. Earlier
  // generations are history, and an operation that never promised a file
  // (deletion, write_file) has its settlement as its evidence.
  // `unknown` is work we know happened but could not resolve. Excluding it from
  // required coverage let an earlier positive omit unresolved work entirely.
  const requiredFinal = settledNow.artifacts.filter((entry) => (
    !entry.superseded && (entry.evidenceContract === 'file' || entry.evidenceContract === 'unknown')
  ));
  const coverageComplete = requiredFinal.every((entry) => judgedRevisions.has(revisionKey(entry)))
    && requiredFinal.every((entry) => !entry.unresolvedReason);
  const artifactsMatch = artifactsRequired
    ? (artifactCoverage.length > 0
      && coverageComplete
      && artifactCoverage.every((entry) => entry.judgedMatch && entry.currentMatch))
    : artifactCoverage.every((entry) => entry.judgedMatch && entry.currentMatch);
  const verdictTrustworthy = Boolean(
    publishedVerdict
    && reviewDisposition === 'reviewed'
    && publishedVerdict.fulfills
    && publishedVerdict.failedOpen !== true
    && publishedVerdict.settledEvidenceAvailable !== false
    // CURRENT inventory must be readable too. A retained positive verdict from
    // an earlier read cannot certify work whose evidence we cannot see now.
    && settledNow.evidenceAvailable
    && replyMatches
    && objectiveMatches
    && artifactsMatch,
  );
  // VERIFICATION GOVERNS THE PUBLIC RESULT.
  //
  // A wrong objective, content changed after judgment, or missing coverage for
  // work that actually settled previously left the owner with the ordinary
  // "done" reply and disposition `reviewed`, with only metadata dissenting.
  // When review was REQUIRED for this run and its verification does not stand,
  // the turn publishes as a truthful unverified result instead.
  //
  // `unverifiedCompletionOutcome` keeps the model's own account of the work and
  // marks the turn blocked/resumable, so committed effects are retained and the
  // owner can direct a targeted repair — no duplicate create, no compulsory
  // Plan, no extra approval. An owner-disabled run and an ordinary artifact-free
  // answer are untouched: both leave `verificationRequired` false.
  // Review is REQUIRED when the owner had it on and this request actually
  // settled work. A MISSING verdict then fails verification rather than
  // exempting itself — previously `Boolean(publishedVerdict)` meant no verdict
  // meant no requirement.
  // An unreadable evidence spine cannot certify anything either — previously
  // `evidenceAvailable:false` / count 0 was simply ignored at publication, so a
  // missing review or a prior artifact-free verdict could self-exempt.
  const verificationRequired = reviewWasEnabled
    && (Boolean(publishedVerdict) || artifactsRequired || !settledNow.evidenceAvailable);
  const verificationFailed = verificationRequired && !verdictTrustworthy;
  if (verificationFailed && effectiveOutcome.status === 'done') {
    // TYPED INDEPENDENT CAUSES, tested in order of what is actually knowable.
    // Previously a MISSING verdict fell through to "reply mismatch" (there was
    // no reply digest to compare) and a valid current file merely OMITTED from
    // coverage was reported as "file drift" (nothing had drifted). Each cause is
    // now distinguished from the others before any wording is chosen.
    const coverageGap = artifactsRequired
      && artifactCoverage.every((entry) => entry.currentMatch)
      && !coverageComplete;
    const detail = !publishedVerdict
      ? 'completion_review_absent'
      : publishedVerdict.failedOpen === true
        ? 'completion_review_failed_open'
        : !publishedVerdict.fulfills
          ? 'completion_review_negative'
          : !settledNow.evidenceAvailable
            ? 'completion_review_evidence_unreadable'
            : coverageGap
              ? 'completion_review_coverage_incomplete'
              : !objectiveMatches
                ? 'completion_review_objective_mismatch'
                : !replyMatches
                  ? 'completion_review_reply_mismatch'
                  : !artifactsMatch
                    ? 'completion_review_artifact_drift'
                    : 'completion_review_did_not_stand';
    // The model's own account of the work STAYS — the work happened, and there
    // is no safe generic substitute for a real account. What was missing is the
    // HOST's finding: the reply alone read as plain success while verification
    // had failed. This appends one factual sentence saying what was checked and
    // what would settle it. It never repeats or undoes a committed effect.
    const NOTES: Record<string, string> = {
      completion_review_absent:
        'Verification note: no completion review was recorded for this request, so nothing '
        + 'has confirmed the result. Ask me to check it.',
      completion_review_failed_open:
        'Verification note: no completion verdict was obtained. This result remains unreviewed.',
      completion_review_negative:
        'Verification note: the completion review found this did not meet the request. Ask '
        + 'me what is missing before relying on it.',
      completion_review_evidence_unreadable:
        'Verification note: I could not read the record of what this request wrote, so I '
        + 'cannot confirm the result. Ask me to re-check it.',
      completion_review_coverage_incomplete:
        'Verification note: the review did not cover everything this request wrote. The '
        + 'files themselves still match their receipts. Ask me to review the remaining work.',
      completion_review_objective_mismatch:
        'Verification note: the completion review was recorded against a different request, '
        + 'so it does not vouch for this one. Ask me to re-check this result.',
      completion_review_reply_mismatch:
        'Verification note: the completion review was recorded against different reply text, '
        + 'so it does not vouch for what you are reading. Ask me to re-check this result.',
      completion_review_artifact_drift:
        'Verification note: the saved file no longer matches the receipt for this write, so '
        + 'I could not confirm the result. Ask me to re-read it and report what it now '
        + 'contains before relying on this.',
      completion_review_did_not_stand:
        'Verification note: the completion review did not stand for this result, so it is '
        + 'unconfirmed. Ask me to re-check it.',
    };
    const reviewReason = detail === 'completion_review_failed_open' && publishedVerdict?.reviewUnavailableReason
      // Older durable verdicts used this internal fail-open label. It never
      // meant a review accepted the result, including when reopened today.
      ? redactSensitiveText(publishedVerdict.reviewUnavailableReason)
        .replace(' — accepting completion', '; no review was completed').trim().slice(0, 800) : '';
    const note = reviewReason ? `Verification note: ${reviewReason} This result remains unreviewed.`
      : NOTES[detail] ?? NOTES.completion_review_did_not_stand!;
    const authored = effectiveOutcome.presentation.text.trim();
    effectiveOutcome = unverifiedCompletionOutcome({
      ...effectiveOutcome,
      presentation: {
        ...effectiveOutcome.presentation,
        text: authored ? `${authored}\n\n${note}` : note,
      },
    }, true);
    effectiveOptions = {
      ...effectiveOptions,
      // The verification projection changed done to blocked. Derive the
      // compatibility reason from that outcome instead of retaining success.
      legacyReason: undefined,
      metadata: { ...(effectiveOptions.metadata ?? {}), verificationDetail: detail },
    };
  }
  const verdictMetadata = publishedVerdict ? { completionVerdictRef: {
    version: 1 as const,
    eventId: publishedVerdict.eventId,
    seq: publishedVerdict.seq,
    fulfills: publishedVerdict.fulfills,
    // The single field a consumer may read as "this result was reviewed and the
    // review stands against what we actually published". Never `fulfills` alone.
    verified: verdictTrustworthy,
    // An OFF policy with a retained verdict from an earlier state is still
    // owner-disabled; calling it enabled_unavailable misreports the owner's
    // choice as a review problem.
    // A VALID captured-off with a retained verdict is genuinely owner-disabled.
    // An UNREADABLE policy is not: we do not know what the owner chose, so it
    // must not be presented as their decision.
    disposition: capturedRead.status === 'unreadable'
      ? 'enabled_unavailable'
      : !reviewWasEnabled
        ? 'disabled_by_owner'
        : verdictTrustworthy ? reviewDisposition : 'enabled_unavailable',
    policyEvidence,
    replyMatches,
    // The digest above describes the AUTHORED text the review saw. When a host
    // verification note is appended the delivered bytes differ from it, so the
    // published text is not what was judged and must not read as though it were.
    deliveredTextIsJudgedText: !verificationFailed,
    objectiveMatches,
    artifactsMatch,
    // Judged-vs-now per artifact, so a post-judgment change is visible rather
    // than collapsed into one boolean.
    artifactCoverage,
    // Truthful qualifiers, previously dropped entirely.
    ...(publishedVerdict.failedOpen ? { failedOpen: true } : {}),
    ...(publishedVerdict.selfJudge ? { selfJudge: true } : {}),
    ...(publishedVerdict.ownerSelectedJudge ? { ownerSelectedJudge: true } : {}),
    ...(publishedVerdict.substituteForExactPin ? { substituteForExactPin: true } : {}),
    ...(publishedVerdict.requestedJudgeModelId
      ? { requestedJudgeModelId: publishedVerdict.requestedJudgeModelId } : {}),
    ...(publishedVerdict.substituteReason ? { substituteReason: publishedVerdict.substituteReason } : {}),
    ...(publishedVerdict.settledEvidenceAvailable === false ? { settledEvidenceAvailable: false } : {}),
    ...(publishedVerdict.judgeModelId ? { judgeModelId: publishedVerdict.judgeModelId } : {}),
    ...(publishedVerdict.judgeProvider ? { judgeProvider: publishedVerdict.judgeProvider } : {}),
    ...(publishedVerdict.judgeProviderId ? { judgeProviderId: publishedVerdict.judgeProviderId } : {}),
    ...(publishedVerdict.objectiveDigest ? { objectiveDigest: publishedVerdict.objectiveDigest } : {}),
    ...(publishedVerdict.replyDigest ? { replyDigest: publishedVerdict.replyDigest } : {}),
    artifacts: publishedVerdict.artifacts.slice(0, 16),
  } } : {
    // Disabled is a legitimate policy, NOT a failed verification. An absent
    // verdict must be readable as which of the two it was.
    completionReview: { version: 1 as const, disposition: reviewDisposition, policyEvidence },
  };
  // Clean-attempt measurement, from the canonical ledgers. Metadata only — it
  // must never become a gate.
  const refused = sourceRefusedAttempts({
    sessionId: proposed.identity.sessionId,
    sourceUserSeq: proposed.identity.sourceUserSeq,
  });
  const refusalMetadata = refused.count > 0 ? {
    refusedAttempts: refused.count,
    refusedLogicalCallIds: refused.attempts.map((entry) => entry.logicalToolCallId).slice(0, 16),
  } : {};
  let data = {
    ...completionDataForTurnOutcome(effectiveOutcome, effectiveOptions),
    ...planMetadata, ...verdictMetadata, ...refusalMetadata,
  };
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
    effectiveOutcome = withRetainedWorkTerminal(
      unverifiedCompletionOutcome(
        withExactMutationPartialTruth(outcome as Extract<TurnOutcome, { status: 'done' }>),
        options.presentationAlreadyDiscloses === true,
      ),
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
    // The hold fallback previously dropped every derived field, so a held
    // terminal lost its review disposition and refusal measurement entirely.
    // The verdict reference is deliberately NOT carried here: it was validated
    // against a presentation this branch just replaced, so only the disposition
    // and the measurement — neither of which is a claim about this text —
    // survive.
    data = {
      ...completionDataForTurnOutcome(effectiveOutcome, effectiveOptions),
      ...planMetadata,
      completionReview: { version: 1 as const, disposition: reviewDisposition, policyEvidence },
      ...refusalMetadata,
    };
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
  // Capability learning is a separate, identity-only projection of already
  // durable success. It carries no invocation/approval authority and cannot
  // affect this terminal. A crash in this narrow gap is repaired lazily from
  // the same receipts on a later planning turn.
  if (persisted.status === 'done') {
    void learnVerifiedWriteCapabilitiesForAcceptedTask({
      sessionId: persisted.identity.sessionId,
      sourceUserSeq: persisted.identity.sourceUserSeq,
    }).catch(() => {});
  }
  // NOTE: the run attempt is closed by the terminal publication itself, in the
  // same transaction (eventlog `terminalOwner` branch). A best-effort finish
  // here would be a second, weaker copy of that guarantee.
  return {
    event: terminal.event,
    inserted: terminal.inserted,
    presentation: persisted,
  };
}
