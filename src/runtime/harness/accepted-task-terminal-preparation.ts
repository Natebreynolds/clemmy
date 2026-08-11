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
import { prepareDurableMemoryIntakeHostCompletion } from './durable-memory-intake-receipt.js';

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
