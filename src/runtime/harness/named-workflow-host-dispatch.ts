/**
 * Reserved host seam for a future admitted `run_existing_workflow` operation.
 *
 * A name match—even an exact one—does not bind the mutable workflow
 * definition, inputs, effect summary, or independent write judgment captured
 * at accepted-source time. Until the typed graph carries those frozen bytes,
 * the canonical workflow tool/model lane owns resolution and confirmation.
 */
import type { TurnGraphRoute } from '../graph/turn-graph-ir.js';
import {
  validateExistingWorkflowAuthority,
  type ExistingWorkflowAuthorityV1,
} from './existing-workflow-authority.js';

export type NamedWorkflowHostDispatchResult =
  | { status: 'dispatched'; workflowName: string; runId: string }
  | { status: 'not_applicable'; reason: string };

export function tryHostDispatchNamedWorkflow(input: {
  sessionId: string;
  sourceUserSeq: number;
  userText: string;
  route: TurnGraphRoute | undefined;
  authority?: ExistingWorkflowAuthorityV1;
}): NamedWorkflowHostDispatchResult {
  if (input.route !== 'act') {
    return { status: 'not_applicable', reason: 'compiled_route_is_not_act' };
  }
  void input.sessionId;
  void input.sourceUserSeq;
  void input.userText;
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
  // A complete authority still does not re-enable the lexical shortcut.
  // The admitted graph executor owns run_existing_workflow.
  return { status: 'not_applicable', reason: 'graph_executor_owns_run_existing_workflow' };
}
