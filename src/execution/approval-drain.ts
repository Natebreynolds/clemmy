import type { ApprovalResolutionResult } from '../types.js';
import type { RunConversationResult } from '../runtime/harness/loop.js';
import {
  runConversationDisposition,
  type RunConversationHold,
} from '../runtime/harness/run-conversation-disposition.js';

type ApprovalDrainBase = Pick<
  ApprovalResolutionResult,
  'approvalId' | 'text' | 'sessionId'
>;

/**
 * The approval decision and the resumed execution disposition are different
 * facts. `approved` means the resumed source reached a success/input/approval
 * boundary; the remaining variants prevent an approved decision from
 * laundering blocked or still-owned execution into completion.
 */
export type DrainApprovalResolutionResult =
  | ApprovalResolutionResult
  | (ApprovalDrainBase & {
    status: 'in_progress';
    execution:
      | { kind: 'dispatched' }
      | { kind: 'held'; hold: RunConversationHold; recoveredContract: boolean };
  })
  | (ApprovalDrainBase & {
    status: 'blocked';
    reason: string;
    /** Machine terminal facts from the resumed harness run. They distinguish
     * an advisory readback failure from a real unfinished/denied operation. */
    blockedReason?: string;
    blockedDetail?: string;
  })
  | (ApprovalDrainBase & { status: 'awaiting_continue'; reason: string })
  | (ApprovalDrainBase & { status: 'cancelled'; reason: string });

/**
 * Registry-first approval resolution for the background-task drain.
 *
 * The drain historically resolved approvals ONLY through the legacy runtime
 * (`assistant.getRuntime().resolveApproval`), whose in-memory interruption
 * store never sees approvals the harness lane parks in the sqlite registry.
 * Live 2026-07-22: a board-approved send on the orchestrator/BYO lane failed
 * with "Approval apr-… not found." while its registry row sat pending — the
 * approve→no-send class, one store removed.
 *
 * This resolver mirrors what the working non-background board path does:
 *   registry row exists → resolve the row, then resume the parked run via
 *   runConversationFromResume (which carries BOTH resume paths: serialized
 *   interrupt state and the no-blob approved-payload replay), and map the
 *   outcome back to the drain's ApprovalResolutionResult contract.
 *   No registry row → fail closed. Opaque legacy runtime approvals cannot
 *   mint shared-host authority and are never deserialized or resumed here.
 *
 * Rejections never resume: the drain aborts the task on rejection, so a
 * resume turn would spend tokens narrating a stop that is already decided.
 */
export async function resolveDrainApproval(opts: {
  approvalId: string;
  approved: boolean;
  /** Owning task session, used only to return a truthful blocked disposition
   * when no canonical registry row exists. */
  sessionId?: string;
  resolver?: string;
  /** Deprecated compatibility seam. It is intentionally never invoked. */
  legacyResolve?: () => Promise<ApprovalResolutionResult>;
  /** Test seams; default to the real registry + resume implementations. */
  registryForTest?: {
    get: (id: string) => { sessionId: string; status: string; resolution?: string | null } | undefined;
    resolve: (id: string, resolution: string, resolver: string) => { ok: boolean; reason?: string };
    listPending: (filter: { sessionId?: string }) => Array<{ approvalId: string }>;
  };
  resumeForTest?: (args: { sessionId: string; approvalId: string; decision: 'approve' | 'reject'; resolver?: string }) => Promise<Pick<
    RunConversationResult,
    'status' | 'error' | 'lastDecision' | 'hold' | 'limitKind' | 'blockedReason' | 'blockedDetail' | 'publicPresentation'
  >>;
}): Promise<DrainApprovalResolutionResult> {
  const registry = opts.registryForTest
    ?? await import('../runtime/harness/approval-registry.js');
  const row = registry.get(opts.approvalId);
  if (!row) {
    const reason = `Legacy approval ${opts.approvalId} is retired and was not executed because it has no canonical shared-host registry authority.`;
    return {
      approvalId: opts.approvalId,
      status: 'blocked',
      sessionId: opts.sessionId ?? '',
      text: reason,
      reason,
    };
  }

  const resolver = opts.resolver ?? 'background-task-drain';
  if (row.status === 'pending') {
    registry.resolve(opts.approvalId, opts.approved ? 'approved' : 'rejected', resolver);
    // An approve that loses this resolve race to another approver still
    // resumes below: the run is parked either way and the resume path claims
    // the approved payload one-shot, so a double-resume cannot double-dispatch.
  } else if (opts.approved && row.resolution !== 'approved') {
    // Registry says rejected/expired/cancelled — dispatching now would execute
    // an action the durable record refused. Fail closed with the record.
    return { approvalId: opts.approvalId, status: 'rejected', text: `Approval ${opts.approvalId} is ${row.resolution ?? row.status} in the registry; not dispatching.`, sessionId: row.sessionId };
  }

  if (!opts.approved) {
    return { approvalId: opts.approvalId, status: 'rejected', text: `Approval ${opts.approvalId} rejected.`, sessionId: row.sessionId };
  }

  const resume = opts.resumeForTest ?? (async (args: { sessionId: string; approvalId: string; decision: 'approve' | 'reject'; resolver?: string }) => {
    const [{ runConversationFromResume }, { buildOrchestratorAgentForApprovalResume }] = await Promise.all([
      import('../runtime/harness/loop.js'),
      import('../agents/orchestrator.js'),
    ]);
    return runConversationFromResume({
      buildAgent: (identity) => buildOrchestratorAgentForApprovalResume({
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        acceptedRoute: identity.route,
      }),
      sessionId: args.sessionId,
      approvalId: args.approvalId,
      decision: args.decision,
      resolver: args.resolver,
    });
  });

  const result = await resume({
    sessionId: row.sessionId,
    approvalId: opts.approvalId,
    decision: 'approve',
    resolver,
  });
  const text = result.publicPresentation?.text
    ?? result.lastDecision?.reply
    ?? result.lastDecision?.summary
    ?? '';
  const base = {
    approvalId: opts.approvalId,
    text,
    sessionId: row.sessionId,
  };
  const disposition = runConversationDisposition(result);
  switch (disposition.kind) {
    case 'completed':
      return { ...base, status: 'approved' };
    case 'awaiting_approval':
      return {
        ...base,
        status: 'approved',
        nextApprovalId: registry.listPending({ sessionId: row.sessionId }).at(-1)?.approvalId,
      };
    case 'awaiting_user_input':
      // A resume that asks a question is neither done nor blocked. Preserve the
      // existing approved-decision contract while parking the task on the ask.
      return {
        ...base,
        status: 'approved',
        awaitingInputQuestion: text || 'The resumed run needs your input to continue.',
      };
    case 'dispatched':
      return {
        ...base,
        status: 'in_progress',
        execution: { kind: 'dispatched' },
      };
    case 'held':
      return {
        ...base,
        status: 'in_progress',
        execution: {
          kind: 'held',
          hold: disposition.hold,
          recoveredContract: disposition.recoveredContract,
        },
      };
    case 'blocked': {
      const reason = result.error?.trim() || text || `Approval ${opts.approvalId} resumed into a blocked execution.`;
      return {
        ...base,
        status: 'blocked',
        reason,
        ...(result.blockedReason ? { blockedReason: result.blockedReason } : {}),
        ...(result.blockedDetail ? { blockedDetail: result.blockedDetail } : {}),
      };
    }
    case 'limit_exceeded': {
      const reason = result.error?.trim()
        || `The resumed run reached its ${result.limitKind === 'token_budget' ? 'token budget' : 'execution limit'} before finishing.`;
      return { ...base, status: 'awaiting_continue', reason };
    }
    case 'killed': {
      const reason = result.error?.trim() || 'The resumed run was cancelled.';
      return { ...base, status: 'cancelled', reason };
    }
    case 'failed':
      // Preserve the historical failure behavior: the background drain's
      // outer error boundary owns a genuine runtime failure.
      throw new Error(result.error ?? `Approval ${opts.approvalId} resume failed.`);
  }
}
