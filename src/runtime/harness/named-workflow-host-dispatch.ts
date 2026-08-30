/**
 * Host dispatch for a uniquely identified existing workflow run.
 *
 * A catalog name match is not enough — delete/edit/inspect never collapse
 * into RUN. uniqueWorkflowRunRequest is execution text plus unique catalog
 * identity. That request is queued through admitNamedWorkflowRunFromAcceptedSource
 * (the same queueWorkflowRun path as MCP workflow_run). Live 2026-08-29
 * seq 97371 uniquely named the workflow, then the model asked instead of
 * dispatching; the host owns this dispatch.
 */
import type { TurnGraphRoute } from '../graph/turn-graph-ir.js';
import {
  validateExistingWorkflowAuthority,
  type ExistingWorkflowAuthorityV1,
} from './existing-workflow-authority.js';
import { listEvents } from './eventlog.js';
import { uniqueWorkflowRunRequest } from '../../tools/named-workflow-match.js';
import { admitNamedWorkflowRunFromAcceptedSource } from '../../tools/admit-named-workflow-run.js';

export type NamedWorkflowHostDispatchResult =
  | { status: 'dispatched'; workflowName: string; runId: string; message: string }
  | { status: 'blocked'; reason: string; workflowName: string; message: string }
  | { status: 'not_applicable'; reason: string };

function priorAcceptedSourceTexts(sessionId: string, sourceUserSeq: number): string[] {
  try {
    return listEvents(sessionId, { types: ['user_input_received'] })
      .filter((event) => event.seq < sourceUserSeq)
      .map((event) => {
        const display = typeof event.data.displayText === 'string' ? event.data.displayText.trim() : '';
        const text = typeof event.data.text === 'string' ? event.data.text.trim() : '';
        return display || text;
      })
      .filter((text) => text.length > 0);
  } catch {
    return [];
  }
}

export function tryHostDispatchNamedWorkflow(input: {
  sessionId: string;
  sourceUserSeq: number;
  userText: string;
  route: TurnGraphRoute | undefined;
  authority?: ExistingWorkflowAuthorityV1;
}): NamedWorkflowHostDispatchResult {
  if (input.route === 'retrieve' || input.route === 'direct_reply') {
    return { status: 'not_applicable', reason: 'compiled_route_is_not_act' };
  }
  const unique = uniqueWorkflowRunRequest(
    input.userText,
    priorAcceptedSourceTexts(input.sessionId, input.sourceUserSeq),
  );
  if (unique) {
    const admitted = admitNamedWorkflowRunFromAcceptedSource({
      workflowName: unique.name,
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
    });
    if (admitted.ok && admitted.runId) {
      const queued = admitted.status === 'duplicate'
        ? `Rejoined the already-running "${admitted.workflowName}" workflow. I'll report back here when it finishes.`
        : `Queued "${admitted.workflowName}". I'll report back here when it finishes.`;
      return {
        status: 'dispatched',
        workflowName: admitted.workflowName,
        runId: admitted.runId,
        message: queued,
      };
    }
    return {
      status: 'blocked',
      reason: admitted.status,
      workflowName: admitted.workflowName,
      message: admitted.message,
    };
  }
  void input.sessionId;
  void input.sourceUserSeq;
  if (!input.authority) {
    return { status: 'not_applicable', reason: 'typed_workflow_authority_required' };
  }
  const checked = validateExistingWorkflowAuthority(input.authority);
  if (!checked.ok) {
    return { status: 'not_applicable', reason: checked.reason };
  }
  if (checked.authority.action !== 'run') {
    return { status: 'not_applicable', reason: 'host_action_is_not_run' };
  }
  // Name-only or management phrasing with a typed authority still is not a
  // unique-run request. The graph executor owns run_existing_workflow there.
  return { status: 'not_applicable', reason: 'graph_executor_owns_run_existing_workflow' };
}
