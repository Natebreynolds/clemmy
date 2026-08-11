/**
 * Whether a task may say it is done.
 *
 * A write acknowledgement is a statement about a request. The user asked about
 * a result. Both live runs shipped `done` on the strength of a receipt: one
 * mis-assigned days and verified only that a sheet existed; the other left
 * stale rows from a previous artifact, stopped with a pagination cursor
 * outstanding, never read back what it wrote, and left its execution active.
 *
 * Two rules, the second learned by getting it wrong here first:
 *
 *  1. Omission is not satisfaction. Evidence never established blocks `done`;
 *     `needs_verification` is a true and useful thing to say.
 *  2. **Evidence, never flags.** An earlier version turned a satisfied boolean
 *     into a fabricated receipt and an empty identity list — so the layer being
 *     audited supplied its own verdict and the audit agreed with it. Anything
 *     that cannot be redeemed is not evidence.
 */

import { ExecutionStore } from '../../execution/store.js';
import {
  exactSourceFanoutTruth,
  type ExactSourceFanoutPlanTruth,
} from '../../execution/durable-fanout-terminal-authority.js';
import {
  loadManifestState,
  satisfiedObligationsState,
} from './obligation-store.js';
import {
  OBLIGATION_RECEIPT_KIND,
  redeemEvidenceReceipt,
} from './evidence-receipts.js';
import type { ObligationManifest } from './obligation-manifest.js';

export type TerminalStatus = 'done' | 'needs_verification' | 'blocked';

/** Each is a specific, checkable claim — never a judgement about tone. */
export type MissingEvidence =
  | 'source_completeness'
  | 'source_identity_accounting'
  | 'derivation_from_current_source'
  | 'commit_effect'
  | 'stale_destination_reconciled'
  | 'exact_read_back'
  | 'execution_terminal';

export interface TerminalTruthInput {
  /** Was the source snapshot complete, or was a continuation outstanding? */
  sourceCompleteness?: 'complete' | 'partial' | 'unknown';
  /** Identities selected from the source. */
  sourceIdentities?: string[];
  /** Identities actually represented in the committed output. */
  committedIdentities?: string[];
  /** The provider's write acknowledgement, if any. */
  writeReceipt?: unknown;
  /** Did the task read back what it wrote? */
  readBackPerformed?: boolean;
  /** Did that read-back MATCH the derivation? Undefined means never compared. */
  readBackMatches?: boolean;
  /** Target content predating this run. Undefined means never inspected. */
  staleRowsFound?: number;
  staleRowsReconciled?: boolean;
  /** Executions still open for this exact accepted source. */
  activeExecutions?: number;
  /** Graph obligations not yet satisfied. */
  unsatisfiedRequirements?: string[];
  /**
   * Obligations this task's own graph nodes incurred. Only these are checked:
   * a task with no reversible write does not owe a read-back, and one that
   * never touched a destination does not owe a stale-content inspection.
   */
  applicableObligations?: string[];
  /** Reversibility of the committed effect, which decides HOW it is verified. */
  effectReversibility?: 'read_only' | 'reversible' | 'irreversible' | 'unknown';
  /** Redeemable receipt for an effect that cannot be re-read. */
  durableReceiptRef?: string;
  /** Redeemable proof the output derives from THIS run's source evidence. */
  derivationProvenance?: string;
  /** An evidence store could not be read at all. */
  evidenceUnreadable?: boolean;
}

export interface TerminalVerdict {
  status: TerminalStatus;
  missing: MissingEvidence[];
  /** Facts for the model to speak from — never a script for it to recite. */
  facts: string[];
}

export function adjudicateTerminal(input: TerminalTruthInput): TerminalVerdict {
  const missing: MissingEvidence[] = [];
  const facts: string[] = [];
  const applicable = new Set(input.applicableObligations ?? []);
  const add = (evidence: MissingEvidence, fact: string): void => {
    if (!missing.includes(evidence)) missing.push(evidence);
    facts.push(fact);
  };

  if (input.evidenceUnreadable) {
    add('source_completeness', 'an evidence store could not be read, so nothing here is established');
  }

  if (input.sourceCompleteness !== 'complete') {
    add('source_completeness', input.sourceCompleteness === 'partial'
      ? 'the source snapshot stopped with a continuation outstanding'
      : 'source completeness was never established');
  }

  if (input.sourceIdentities === undefined) {
    add('source_identity_accounting', 'no source identities were accounted for');
  } else {
    const committed = new Set(input.committedIdentities ?? []);
    const unaccounted = input.sourceIdentities.filter((identity) => !committed.has(identity));
    if (unaccounted.length > 0) {
      add('source_identity_accounting',
        `${unaccounted.length} of ${input.sourceIdentities.length} source records are not accounted for in the output`);
    }
  }

  const committedSomething = input.writeReceipt !== undefined && input.writeReceipt !== null;
  const owesCommit = applicable.size === 0 || applicable.has('commit_effect');
  if (owesCommit && !committedSomething) {
    add('commit_effect', 'no write receipt was recorded');
  }

  // How a commit is verified depends on what it IS. An irreversible send cannot
  // be re-read, so its proof is a durable receipt; a reversible target can be
  // read back, so an acknowledgement alone is not verification.
  if (committedSomething) {
    if (input.effectReversibility === 'irreversible') {
      if (!input.durableReceiptRef) {
        add('exact_read_back', 'an irreversible effect was committed with no durable receipt to prove it');
      }
    } else if (input.readBackPerformed !== true) {
      add('exact_read_back', 'the written target was never read back');
    } else if (input.readBackMatches !== true) {
      // "I looked" is not "it matched".
      add('exact_read_back', input.readBackMatches === false
        ? 'the read-back did not match the derived representation'
        : 'the read-back was performed but never compared against the derivation');
    }
  }

  if (applicable.has('stale_destination_reconciled')) {
    if (input.staleRowsFound === undefined) {
      add('stale_destination_reconciled', 'the destination was never inspected for content predating this run');
    } else if (input.staleRowsFound > 0 && input.staleRowsReconciled !== true) {
      add('stale_destination_reconciled',
        `${input.staleRowsFound} rows from a previous artifact remain in the destination`);
    }
  }

  if (applicable.has('derivation_from_current_source') && !input.derivationProvenance) {
    add('derivation_from_current_source', "the output cannot be traced to this run's source evidence");
  }

  if (input.activeExecutions === undefined) {
    add('execution_terminal', 'execution state was never established');
  } else if (input.activeExecutions > 0) {
    add('execution_terminal', `${input.activeExecutions} execution(s) owned by this request are still active`);
  }

  const outstanding = input.unsatisfiedRequirements ?? [];
  for (const requirement of outstanding) facts.push(`unsatisfied obligation: ${requirement}`);

  if (missing.length === 0 && outstanding.length === 0) {
    return { status: 'done', missing: [], facts: ['every obligation is satisfied and verified'] };
  }
  return { status: 'needs_verification', missing, facts };
}

const OBLIGATION_MISSING_CLASS: Readonly<Record<string, MissingEvidence>> = {
  source_observed: 'source_completeness',
  source_completeness: 'source_completeness',
  derivation_from_current_source: 'derivation_from_current_source',
  commit_effect: 'commit_effect',
  verify_committed_readback: 'exact_read_back',
  verify_committed_receipt: 'exact_read_back',
  stale_destination_reconciled: 'stale_destination_reconciled',
  execution_terminal: 'execution_terminal',
};

function manifestVerdict(
  manifest: ObligationManifest,
  input: { sessionId: string; sourceUserSeq: number },
): TerminalVerdict {
  const missing: MissingEvidence[] = [];
  const facts: string[] = [];
  const add = (kind: MissingEvidence, fact: string): void => {
    if (!missing.includes(kind)) missing.push(kind);
    facts.push(fact);
  };

  const transitionState = satisfiedObligationsState(input.sessionId, input.sourceUserSeq);
  if (transitionState.status !== 'ok') {
    add('source_completeness',
      `the obligation evidence store could not be read: ${transitionState.reason}`);
    return { status: 'needs_verification', missing, facts };
  }

  const foreignTransitions = transitionState.transitions.filter((transition) =>
    transition.manifestId !== manifest.manifestId);
  if (foreignTransitions.length > 0) {
    add('source_completeness',
      `${foreignTransitions.length} proof transition(s) name a different manifest for this task`);
    return { status: 'needs_verification', missing, facts };
  }

  for (const node of manifest.nodes) {
    for (const obligation of node.obligations) {
      if (obligation === 'execution_terminal') continue;
      const missingClass = OBLIGATION_MISSING_CLASS[obligation] ?? 'source_completeness';
      const matches = transitionState.transitions.filter((transition) =>
        transition.manifestId === manifest.manifestId
        && transition.nodeId === node.nodeId
        && transition.obligation === obligation);
      if (matches.length !== 1) {
        add(missingClass, matches.length === 0
          ? `unsatisfied obligation: ${node.nodeId}:${obligation}`
          : `ambiguous proof transitions for ${node.nodeId}:${obligation}`);
        continue;
      }
      const transition = matches[0]!;
      const requiredKind = OBLIGATION_RECEIPT_KIND[obligation];
      if (!requiredKind) {
        add(missingClass, `no typed receipt class exists for ${node.nodeId}:${obligation}`);
        continue;
      }
      const redeemed = redeemEvidenceReceipt(input.sessionId, transition.receiptId, {
        expectKind: requiredKind,
        sourceUserSeq: input.sourceUserSeq,
        physicalAttemptId: transition.physicalAttemptId,
      });
      if (!redeemed.ok) {
        add(missingClass,
          `proof for ${node.nodeId}:${obligation} is not redeemable: ${redeemed.reason}`);
      }
    }
  }

  const owesExecutionTerminal = manifest.nodes.some((node) =>
    node.obligations.includes('execution_terminal'));
  let ownedExecutionStatus: string | undefined;
  let fanoutPlans: ExactSourceFanoutPlanTruth[] = [];
  if (owesExecutionTerminal) {
    let executionUnreadable = false;
    try {
      ownedExecutionStatus = new ExecutionStore()
        .getForSource(input.sessionId, input.sourceUserSeq)?.status;
    } catch (error) {
      executionUnreadable = true;
      add('execution_terminal', `the exact-source execution ledger is unreadable: ${String(error)}`);
    }
    if (!executionUnreadable
      && ownedExecutionStatus !== undefined && ownedExecutionStatus !== 'completed') {
      add('execution_terminal',
        `the execution owned by this request is still ${ownedExecutionStatus}`);
    }

    const fanout = exactSourceFanoutTruth(input.sessionId, input.sourceUserSeq);
    if (fanout.status === 'ok') fanoutPlans = fanout.plans;
    else add('execution_terminal', `the exact-source fan-out ledger is ${fanout.status}: ${fanout.reason}`);
    const unsettledPlans = fanoutPlans.filter((plan) => plan.status !== 'reduced');
    if (unsettledPlans.length > 0) {
      const statuses = unsettledPlans.map((plan) => `${plan.planId}:${plan.status}`).join(', ');
      add('execution_terminal',
        `${unsettledPlans.length} fan-out plan(s) owned by this request are not reduced (${statuses})`);
    }
  }
  const unsettledPlans = fanoutPlans.filter((plan) => plan.status !== 'reduced');

  if (missing.length === 0) {
    return { status: 'done', missing: [], facts: ['every declared obligation is backed by redeemable evidence'] };
  }
  const irrecoverable = Boolean(
    ownedExecutionStatus === 'blocked'
    || unsettledPlans.some((plan) => plan.status === 'failed'),
  );
  return { status: irrecoverable ? 'blocked' : 'needs_verification', missing, facts };
}

/**
 * Adjudicate from AUTHORITATIVE stores.
 *
 * The caller supplies identity and nothing else. The exact persisted manifest
 * says what the task owes; the obligation transition and typed receipt stores
 * say what has actually been proved. Execution and fan-out ownership are keyed
 * by the same accepted source, so another turn can neither block nor release
 * this one.
 */
export function adjudicateTerminalForTaskSync(input: {
  sessionId: string;
  sourceUserSeq: number;
}): TerminalVerdict {
  const state = loadManifestState(input.sessionId, input.sourceUserSeq);
  if (state.status === 'ok') return manifestVerdict(state.manifest, input);
  return {
    status: 'needs_verification',
    missing: ['source_completeness'],
    facts: [state.status === 'missing'
      ? 'no authoritative obligation manifest exists for this accepted task'
      : `manifest authority is ambiguous: ${state.reason}`],
  };
}

/** Async compatibility for existing brains and tests. Authority itself is
 * synchronous so the terminal committer can consult the exact same verdict at
 * its durable publication boundary. */
export async function adjudicateTerminalForTask(input: {
  sessionId: string;
  sourceUserSeq: number;
}): Promise<TerminalVerdict> {
  return adjudicateTerminalForTaskSync(input);
}
