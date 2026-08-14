/**
 * Production orchestration for the staged expected-work protocol.
 *
 * This is intentionally synchronous because the final delivery boundary is
 * synchronous. It does not author an answer or decide how Clem should speak.
 * It only turns already-durable host facts into the proof state required before
 * a staged `done` may be published.
 */
import { loadExpectedWorkContract } from './expected-work-contract.js';
import { actionExpectedWorkState } from './expected-work-admission.js';
import {
  expectedTaskFor,
  finalizeResolutionAgainstExpectedWork,
} from './resolution-ledger.js';
import { compileObligationManifest } from './obligation-manifest.js';
import {
  loadAcceptedTaskAuthority,
  manifestAcceptedTaskAuthority,
} from './accepted-task-authority.js';
import { issueHostReadEvidenceForManifestNode } from './evidence-receipts.js';
import {
  satisfyDeclaredObligation,
  satisfiedObligationsState,
  loadManifestState,
} from './obligation-store.js';
import { adjudicateTerminalForTaskSync, type TerminalVerdict } from './terminal-truth.js';
import { replyClaimsCompletedWork } from './objective-judge.js';
import { prepareDurableMemoryIntakeHostCompletion } from './durable-memory-intake-receipt.js';
import { listEvents, openEventLog } from './eventlog.js';
import { resolveWriteEvidence } from './work-report.js';
import { summarizeWorkManifest, type WorkManifestSummary } from './work-manifest.js';

export type AcceptedTaskTerminalPreparation =
  | { status: 'unstaged' }
  | { status: 'ready'; manifestId: string; verdict: TerminalVerdict & { status: 'done' } }
  | {
      status: 'needs_verification' | 'conflict' | 'storage_error';
      reason: string;
      missing?: string[];
    };

function boundedReason(value: unknown): string {
  return String(value instanceof Error ? value.message : value).replace(/\s+/g, ' ').slice(0, 300);
}

function exactSatisfactionAlreadyExists(input: {
  sessionId: string;
  sourceUserSeq: number;
  manifestId: string;
  nodeId: string;
  obligation: string;
  receiptId: string;
  physicalDispatchId: string;
}): boolean {
  const state = satisfiedObligationsState(input.sessionId, input.sourceUserSeq);
  return state.status === 'ok' && state.transitions.some((entry) =>
    entry.manifestId === input.manifestId
    && entry.nodeId === input.nodeId
    && entry.obligation === input.obligation
    && entry.receiptId === input.receiptId
    && entry.physicalAttemptId === input.physicalDispatchId);
}

type SettledWorkManifestAuthority =
  | { status: 'none' }
  | { status: 'complete'; manifestIds: string[]; itemPhases: number }
  | { status: 'incomplete'; reason: string };

function manifestFullySettled(summary: WorkManifestSummary): boolean {
  // staleCheckpoints intentionally NOT required to be zero: a mid-run
  // contract revision (steer) supersedes every earlier checkpoint, and the
  // summary already excludes them from canonical coverage — a steered task
  // that redid all 24 items under v2 carried 42 stale v1 rows and was
  // wrongly blocked (live 2026-08-11, background-steer-in-flight).
  return summary.total > 0
    && summary.remaining === 0
    && summary.completed === summary.total
    && summary.anomalies.length === 0
    && summary.untrackedCheckpoints === 0
    && summary.evidenceCount > 0
    && summary.phases.every((phase) =>
      phase.total > 0
      && phase.succeeded === phase.total
      && phase.pending === 0
      && phase.running === 0
      && phase.failed === 0
      && phase.needsValidation === 0
      && phase.invalidated === 0);
}

/**
 * Durable work-manifest authority for an accepted action that fanned out
 * through the control primitive instead of freezing a work_call contract.
 *
 * The fan-out lane already writes its own durable truth: manifest declarations
 * bound to the accepted source, and per-item-phase checkpoints that REQUIRE
 * evidence on success. Refusing that ledger and demanding a work_call contract
 * replaced a fully verified 12/12 completion with a canned "I haven't been
 * able to verify" terminal (live 2026-08-11, long-horizon-manifest run 5).
 * Fail-closed: every manifest bound to the source must be fully settled with
 * zero anomalies; anything less keeps the verification gap.
 */
function settledWorkManifestAuthority(input: {
  sessionId: string;
  sourceUserSeq: number;
}): SettledWorkManifestAuthority {
  let manifestIds: string[];
  try {
    manifestIds = [...new Set(
      listEvents(input.sessionId, { types: ['work_manifest_declared'] })
        .map((event) => event.data as { sourceUserSeq?: unknown; manifestId?: unknown })
        .filter((data) => data?.sourceUserSeq === input.sourceUserSeq)
        .map((data) => (typeof data.manifestId === 'string' ? data.manifestId : ''))
        .filter(Boolean),
    )];
  } catch (error) {
    return { status: 'incomplete', reason: `work-manifest ledger unreadable: ${boundedReason(error)}` };
  }
  if (manifestIds.length === 0) return { status: 'none' };

  let itemPhases = 0;
  for (const manifestId of manifestIds) {
    const summary = summarizeWorkManifest(input.sessionId, manifestId);
    if (!summary) {
      return { status: 'incomplete', reason: `declared work manifest ${manifestId} has no readable state` };
    }
    if (!manifestFullySettled(summary)) {
      const openPhases = summary.phases
        .filter((phase) => phase.succeeded !== phase.total)
        .map((phase) => `${phase.id}: ${phase.succeeded}/${phase.total}`);
      return {
        status: 'incomplete',
        reason: `work manifest ${manifestId} is not fully settled`
          + (openPhases.length > 0 ? ` (${openPhases.join('; ')})` : '')
          + (summary.anomalies.length > 0 ? `; anomalies: ${summary.anomalies.slice(0, 3).join('; ')}` : ''),
      };
    }
    itemPhases += summary.phases.reduce((sum, phase) => sum + phase.total, 0);
  }
  return { status: 'complete', manifestIds, itemPhases };
}

/**
 * Whether any settled call for this accepted source mutated anything. The
 * route classifier sends many plain conversational asks ("what time is it?")
 * down the act route; an activated action whose turn settled zero mutating
 * calls and owns no manifest was answered conversationally — blocking it
 * replaced ordinary replies with a canned verification refusal (the
 * false-block class flagged when the fail-closed gate landed). Mutation
 * without a frozen topology or manifest still fails closed, and text-level
 * effect claims stay guarded by the settlement-derived claim lanes.
 */
/** The persisted graph says this act turn is conversation-shaped: not a
 *  committed 'action' intent, and no external effect was requested. Absent
 *  or unreadable classification never loosens the gate. */
function conversationalActClassification(input: {
  sessionId: string;
  sourceUserSeq: number;
}): boolean {
  try {
    const expected = expectedTaskFor(input.sessionId, input.sourceUserSeq);
    if (expected.status !== 'ok') return false;
    const classification = expected.graph.classification as {
      messageIntent?: unknown;
      externalEffectRequested?: unknown;
    };
    return classification.messageIntent !== 'action'
      && classification.externalEffectRequested !== true;
  } catch {
    return false;
  }
}

/**
 * Whether durable work evidence exists for this exact accepted source:
 * settled logical calls, admitted physical dispatches, or external-write
 * records from this turn. Until the write-evidence issuer exists, this is
 * what separates a real worked turn (publishes, as it always has) from a
 * ZERO-evidence done claim (fails closed). An unreadable store never counts
 * as evidence.
 */
function sourceHasWorkEvidence(input: {
  sessionId: string;
  sourceUserSeq: number;
}): boolean {
  try {
    const db = openEventLog();
    // Only completed BUSINESS settlement is work evidence. A control call,
    // transport marker, crossing, refusal, retry, or in-flight attempt cannot
    // authorize terminal success.
    const settled = db.prepare(`
      SELECT 1 FROM logical_call_settlements
       WHERE session_id = ? AND source_user_seq = ?
         AND business_call = 1
         AND continues_requirement = 0
         AND (
           outcome_kind = 'succeeded'
           OR (outcome_kind = 'empty_result' AND mutating = 0)
         )
       LIMIT 1
    `).get(input.sessionId, input.sourceUserSeq);
    if (settled !== undefined) return true;
    // A CONFIRMED external write is equally durable work evidence: the
    // artifact/effect lanes settle through write-evidence records rather than
    // logical settlements. The same resolution the settlement audit trusts
    // decides here.
    const sourceEvents = turnEventsForWorkEvidence(input.sessionId, input.sourceUserSeq);
    if (resolveWriteEvidence(sourceEvents).confirmed.length > 0) return true;
    // The Claude SDK lane records its tool activity as sdk_tool_use_recorded.
    // Any recorded tool use keeps that lane's completion-judge authority;
    // only a zero-tool claim stays held.
    return sourceEvents.some((event) => {
      if (event.type !== 'sdk_tool_use_recorded') return false;
      const tools = (event.data as { tools?: unknown }).tools;
      return Array.isArray(tools) && tools.some((tool) => typeof tool === 'string' && tool.trim());
    });
  } catch {
    return false;
  }
}

function turnEventsForWorkEvidence(sessionId: string, sourceUserSeq: number) {
  const events = listEvents(sessionId, { sinceSeq: sourceUserSeq - 1 });
  const nextSource = events.find((event) =>
    event.seq > sourceUserSeq && event.type === 'user_input_received');
  return events.filter((event) =>
    event.seq >= sourceUserSeq && (!nextSource || event.seq < nextSource.seq));
}

function verdictResult(
  manifestId: string,
  verdict: TerminalVerdict,
): AcceptedTaskTerminalPreparation {
  if (verdict.status === 'done') {
    return { status: 'ready', manifestId, verdict: verdict as TerminalVerdict & { status: 'done' } };
  }
  return {
    status: 'needs_verification',
    reason: verdict.facts.join('; ') || 'authoritative terminal evidence is incomplete',
    missing: verdict.missing,
  };
}

/**
 * Prepare direct/retrieve work for terminal publication.
 *
 * Uncontracted historical and action-deferred turns return `unstaged` and keep
 * their existing behavior. Once a work contract exists, every failure is
 * typed and fail-closed; there is no legacy fallback for that accepted source.
 */
export function prepareAcceptedTaskTerminal(input: {
  sessionId: string;
  sourceUserSeq: number;
  /** The reply proposed for delivery, when the caller has it. Used ONLY to
   * distinguish a claim-shaped zero-evidence action terminal (held) from a
   * reply that IS the content (published). */
  proposedReply?: string;
}): AcceptedTaskTerminalPreparation {
  const contract = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
  if (contract.status === 'missing') {
    // A task accepted before expected-work activation may already own a
    // content-addressed authoritative manifest and redeemable receipts. That
    // durable authority remains sufficient on upgrade; requiring a newly
    // introduced activation marker here would strand an otherwise completed
    // task. This is not a fallback for new work: without an exact persisted
    // manifest the action path below still requires durable activation and a
    // frozen work contract before it can publish done.
    const legacyManifest = loadManifestState(input.sessionId, input.sourceUserSeq);
    if (legacyManifest.status === 'ok') {
      return verdictResult(
        legacyManifest.manifest.manifestId,
        adjudicateTerminalForTaskSync(input),
      );
    }
    if (legacyManifest.status === 'ambiguous') {
      return { status: 'conflict', reason: legacyManifest.reason };
    }
    const action = actionExpectedWorkState(input);
    if (action.status === 'not_action') return { status: 'unstaged' };
    if (action.status === 'missing') {
      const authority = loadAcceptedTaskAuthority(input.sessionId, input.sourceUserSeq);
      if (authority.status === 'legacy') return { status: 'unstaged' };
      if (authority.status === 'unreadable') {
        return { status: 'storage_error', reason: authority.reason };
      }
      return {
        status: 'conflict',
        reason: `accepted-task authority exists but its graph/action state is missing: ${action.reason}`,
      };
    }
    if (action.status === 'storage_error') {
      return { status: 'storage_error', reason: action.reason };
    }
    if (action.status === 'conflict') {
      return { status: 'conflict', reason: action.reason };
    }
    if (action.status === 'required' && !action.contractId) {
      const host = prepareDurableMemoryIntakeHostCompletion(input);
      if (host.status === 'redeemed') {
        return {
          status: 'ready',
          manifestId: host.receiptId,
          verdict: {
            status: 'done',
            missing: [],
            facts: [
              'the exact accepted memory instruction is durably recorded in its source episode and candidate ledger',
            ],
          },
        };
      }
      if (host.status === 'storage_error') {
        return { status: 'storage_error', reason: host.reason };
      }
      if (host.status === 'conflict') {
        return { status: 'conflict', reason: host.reason };
      }
      const workAuthority = settledWorkManifestAuthority(input);
      if (workAuthority.status === 'complete') {
        return {
          status: 'ready',
          manifestId: workAuthority.manifestIds[0]!,
          verdict: {
            status: 'done',
            missing: [],
            facts: [
              `every declared work item-phase is durably settled with evidence: `
              + `${workAuthority.itemPhases} item-phase(s) across `
              + `${workAuthority.manifestIds.length} manifest(s) (${workAuthority.manifestIds.join(', ')})`,
            ],
          },
        };
      }
      if (workAuthority.status === 'incomplete') {
        return {
          status: 'needs_verification',
          reason: workAuthority.reason,
          missing: ['cardinality_item_missing'],
        };
      }
      // No contract, no manifest, not a memory instruction (host 'ineligible'
      // — one that failed to record keeps its gap). Two deterministic doors:
      // - the turn left durable work evidence (settled calls / admitted
      //   dispatches / external-write records): a real worked turn publishes
      //   as it always has — positive write verification arrives with the
      //   write-evidence issuer;
      // - the graph classifies the ask as conversation-shaped (messageIntent
      //   is not 'action', no external effect requested — "what time is it?"
      //   routes act as tool_intent): the reply is the terminal.
      // A ZERO-evidence done claim on an 'action'-intent ask fails closed.
      if (host.status === 'ineligible') {
        if (sourceHasWorkEvidence(input)) {
          return {
            status: 'ready',
            manifestId: `worked:${input.sessionId}:${input.sourceUserSeq}`,
            verdict: {
              status: 'done',
              missing: [],
              facts: [
                'durable work evidence (settled calls, dispatches, or external-write records) exists for this accepted source',
              ],
            },
          };
        }
        // Two conversational doors: the graph says the ask is conversation-
        // shaped, OR the reply itself claims no completed work (the classifier
        // reads reply-directives like "ping — reply with one word" as action
        // intent; a claim-free reply IS the content, not an unverified claim —
        // live 2026-08-11 dev-daemon smoke). A claim-shaped "Done." with zero
        // evidence still holds.
        if (
          conversationalActClassification(input)
          || (typeof input.proposedReply === 'string'
            && input.proposedReply.trim().length > 0
            && !replyClaimsCompletedWork(input.proposedReply))
        ) {
          return {
            status: 'ready',
            manifestId: `conversational:${input.sessionId}:${input.sourceUserSeq}`,
            verdict: {
              status: 'done',
              missing: [],
              facts: [
                'no work was dispatched for this accepted source; the conversational reply is the terminal',
              ],
            },
          };
        }
      }
    }
    return {
      status: 'needs_verification',
      reason: action.status === 'required'
        ? 'accepted action has no frozen expected-work contract'
        : action.reason,
      missing: ['work_contract_missing'],
    };
  }
  if (contract.status === 'storage_error') {
    return { status: 'storage_error', reason: contract.reason };
  }
  if (contract.status !== 'ok') {
    return { status: 'conflict', reason: `expected-work contract is ${contract.status}: ${contract.reason}` };
  }

  const finalized = finalizeResolutionAgainstExpectedWork(input);
  if (finalized.status === 'incomplete') {
    return {
      status: 'needs_verification',
      reason: finalized.match.gaps.map((gap) => gap.detail).join('; '),
      missing: finalized.match.gaps.map((gap) => gap.kind),
    };
  }
  if (finalized.status === 'conflict') {
    return {
      status: 'conflict',
      reason: finalized.reason
        ?? finalized.match?.gaps.map((gap) => gap.detail).join('; ')
        ?? 'expected and observed work conflict',
    };
  }
  if (finalized.status === 'not_ready' || finalized.status === 'storage_error') {
    return {
      status: finalized.status === 'storage_error' ? 'storage_error' : 'needs_verification',
      reason: finalized.reason,
    };
  }

  const expected = expectedTaskFor(input.sessionId, input.sourceUserSeq);
  if (expected.status !== 'ok') {
    return {
      status: expected.status === 'missing' ? 'needs_verification' : 'conflict',
      reason: `accepted task expectation is ${expected.status}: ${expected.reason}`,
    };
  }
  const compiled = compileObligationManifest({ graph: expected.graph });
  if (!compiled.validation.ok || compiled.manifest.readiness !== 'ready') {
    return {
      status: compiled.validation.ok ? 'needs_verification' : 'conflict',
      reason: compiled.validation.errors.join('; ') || 'authoritative manifest remains unresolved',
    };
  }
  const manifested = manifestAcceptedTaskAuthority(compiled.manifest);
  if (manifested.status !== 'manifested' && manifested.status !== 'replayed') {
    const failure = manifested as Exclude<typeof manifested, { status: 'manifested' | 'replayed' }>;
    return {
      status: failure.status === 'storage_error' ? 'storage_error'
        : failure.status === 'not_ready' ? 'needs_verification'
          : 'conflict',
      reason: failure.reason,
    };
  }

  // A restarted terminal publication may already have every proof. Check that
  // first so a terminal authority replay does not try to mint a second receipt.
  const priorVerdict = adjudicateTerminalForTaskSync(input);
  if (priorVerdict.status === 'done') {
    return {
      status: 'ready',
      manifestId: compiled.manifest.manifestId,
      verdict: priorVerdict as TerminalVerdict & { status: 'done' },
    };
  }

  // Deterministic V1 can contain only zero work or one read. Refuse any future
  // effect shape until its host issuer exists; never improvise proof for it.
  for (const node of compiled.manifest.nodes) {
    if (node.effectKind !== 'read') {
      return {
        status: 'needs_verification',
        reason: `no production evidence issuer exists for manifest effect ${node.effectKind}`,
      };
    }
    const issued = issueHostReadEvidenceForManifestNode({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      manifestId: compiled.manifest.manifestId,
      nodeId: node.nodeId,
    });
    if (issued.status !== 'issued' && issued.status !== 'replayed') {
      const failure = issued as Exclude<typeof issued, { status: 'issued' | 'replayed' }>;
      return {
        status: failure.status === 'storage_error' ? 'storage_error'
          : failure.status === 'conflict' ? 'conflict'
            : 'needs_verification',
        reason: failure.reason,
      };
    }
    const request = {
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      manifestId: compiled.manifest.manifestId,
      nodeId: node.nodeId,
      obligation: issued.receipt.obligation,
      receiptId: issued.receipt.receiptId,
      physicalAttemptId: issued.receipt.physicalDispatchId,
    };
    const satisfied = satisfyDeclaredObligation(request);
    if (!satisfied.ok && !exactSatisfactionAlreadyExists({
      ...request,
      physicalDispatchId: issued.receipt.physicalDispatchId,
    })) {
      return {
        status: 'conflict',
        reason: `host read evidence could not satisfy its exact obligation: ${boundedReason(satisfied.reason)}`,
      };
    }
  }

  return verdictResult(
    compiled.manifest.manifestId,
    adjudicateTerminalForTaskSync(input),
  );
}
