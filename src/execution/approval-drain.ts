import type { ApprovalResolutionResult } from '../types.js';

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
 *   No registry row → the legacy runtime store is authoritative (codex-native
 *   in-memory approvals) and the caller's original call runs unchanged.
 *
 * Rejections never resume: the drain aborts the task on rejection, so a
 * resume turn would spend tokens narrating a stop that is already decided.
 */
export async function resolveDrainApproval(opts: {
  approvalId: string;
  approved: boolean;
  resolver?: string;
  /** The drain's original path: assistant.getRuntime().resolveApproval(...). */
  legacyResolve: () => Promise<ApprovalResolutionResult>;
  /** Test seams; default to the real registry + resume implementations. */
  registryForTest?: {
    get: (id: string) => { sessionId: string; status: string; resolution?: string | null } | undefined;
    resolve: (id: string, resolution: string, resolver: string) => { ok: boolean; reason?: string };
    listPending: (filter: { sessionId?: string }) => Array<{ approvalId: string }>;
  };
  resumeForTest?: (args: { sessionId: string; decision: 'approve' | 'reject'; resolver?: string }) => Promise<{
    status: string;
    error?: string;
    lastDecision?: { reply?: string; summary?: string };
  }>;
}): Promise<ApprovalResolutionResult> {
  const registry = opts.registryForTest
    ?? await import('../runtime/harness/approval-registry.js');
  const row = registry.get(opts.approvalId);
  if (!row) return opts.legacyResolve();

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

  const resume = opts.resumeForTest ?? (async (args: { sessionId: string; decision: 'approve' | 'reject'; resolver?: string }) => {
    const [{ runConversationFromResume }, { buildOrchestratorAgent }] = await Promise.all([
      import('../runtime/harness/loop.js'),
      import('../agents/orchestrator.js'),
    ]);
    const agent = await buildOrchestratorAgent({ sessionId: args.sessionId });
    return runConversationFromResume({ agent, sessionId: args.sessionId, decision: args.decision, resolver: args.resolver });
  });

  const result = await resume({ sessionId: row.sessionId, decision: 'approve', resolver });
  if (result.status === 'failed') {
    throw new Error(result.error ?? `Approval ${opts.approvalId} resume failed.`);
  }
  const nextApprovalId = result.status === 'awaiting_approval'
    ? registry.listPending({ sessionId: row.sessionId }).at(-1)?.approvalId
    : undefined;
  // A resume that ends AWAITING USER INPUT is neither done nor blocked — the
  // settle must park the task on the question, never mark it done-with-empty
  // (live 2026-07-23: the resumed 120-account run hit the artifact ask and
  // was stamped done with an empty result 6s after resuming).
  const awaitingInputQuestion = result.status === 'awaiting_user_input'
    ? (result.lastDecision?.reply ?? result.lastDecision?.summary ?? 'The resumed run needs your input to continue.')
    : undefined;
  return {
    approvalId: opts.approvalId,
    status: 'approved',
    text: result.lastDecision?.reply ?? result.lastDecision?.summary ?? '',
    sessionId: row.sessionId,
    nextApprovalId,
    ...(awaitingInputQuestion ? { awaitingInputQuestion } : {}),
  };
}
