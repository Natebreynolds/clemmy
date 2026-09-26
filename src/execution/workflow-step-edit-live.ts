/**
 * One way to change one step, whoever asks: Clementine's workflow_edit_step
 * tool and the console's step panel both come through here.
 *
 * The edit itself is workflow-step-edit.ts (snapshot, validate, write). What
 * this adds is what a LIVE workflow needs on top: when the workflow is on and
 * the edit changes what it executes, the workflow is written off, its owner is
 * told, and a creation test is queued that turns it back on when it passes.
 * A wording change that leaves the execution surface alone skips the test.
 *
 * Callers that can wait (the chat tool) follow the queued test to its settled
 * result; callers that answer a click (the console route) return the run id
 * and let the page follow it.
 */
import { readWorkflow, type WorkflowDefinition } from '../memory/workflow-store.js';
import { queueWorkflowCreationTest } from '../tools/workflow-run-queue.js';
import { notifyWorkflowAwaitingEnable } from './workflow-enable-inbox.js';
import { missingWorkflowRunInputs } from './workflow-inputs.js';
import { workflowExecutionSurfaceChanged, workflowNeedsCreationTest } from './workflow-enforce.js';
import {
  renderMissingSmokeInputs,
  warmExactScheduledSendSchemaAuthorityForWrite,
  workflowSmokeInputs,
} from './workflow-authoring.js';
import { writeWorkflowAndSyncTriggers } from './workflow-write.js';
import { applyStepPatch, applyStepPromptEdit, type StepEditResult } from './workflow-step-edit.js';

export type StepEditRequest =
  | { patch: Record<string, unknown> }
  | { find: string; replace: string };

export interface StepEditVerification {
  /** The workflow was on and the edit changed what runs, so it is off until the test passes. */
  turnedOff: boolean;
  /** The creation test that turns it back on, when one could be queued. */
  runId?: string;
  /** The test could not start: the workflow stays off until these are supplied. */
  missingInputs?: string[];
  /** The daemon's own words for what happened to the test. */
  message?: string;
}

export interface LiveStepEditOutcome {
  result: StepEditResult;
  /** The definition before the edit (the backup's content). */
  before: WorkflowDefinition | null;
  /** The definition after the edit and any off-switch, as stored. */
  after: WorkflowDefinition | null;
  verification: StepEditVerification;
}

export async function editWorkflowStepLive(
  workflowSlug: string,
  stepId: string,
  edit: StepEditRequest,
  opts: { description?: string; originSessionId?: string; displayName?: string } = {},
): Promise<LiveStepEditOutcome> {
  const entry = readWorkflow(workflowSlug);
  if (!entry) {
    return {
      result: { ok: false, message: `Workflow "${workflowSlug}" not found.` },
      before: null,
      after: null,
      verification: { turnedOff: false },
    };
  }
  const before = entry.data;
  await warmExactScheduledSendSchemaAuthorityForWrite(before);
  const result = 'patch' in edit
    ? applyStepPatch(workflowSlug, stepId, edit.patch, { description: opts.description })
    : applyStepPromptEdit(workflowSlug, stepId, edit.find, edit.replace, { description: opts.description });
  if (!result.ok) return { result, before, after: before, verification: { turnedOff: false } };

  const updated = readWorkflow(workflowSlug)?.data ?? null;
  const verification: StepEditVerification = { turnedOff: false };
  // Re-test parity with workflow_update: an enabled workflow whose execution
  // surface changed is re-verified by running (saved off, back on when the
  // test passes) rather than trusted on the strength of the edit.
  if (updated && before.enabled === true && workflowExecutionSurfaceChanged(before, updated) && workflowNeedsCreationTest(updated)) {
    const testInputs = workflowSmokeInputs(updated, {});
    const missing = missingWorkflowRunInputs(updated, testInputs);
    writeWorkflowAndSyncTriggers(workflowSlug, { ...updated, enabled: false });
    verification.turnedOff = true;
    // It was running before this edit and it is not running now. Whoever owns
    // it hears that from the product, not from whether they read the reply.
    notifyWorkflowAwaitingEnable({
      workflowName: workflowSlug,
      displayName: opts.displayName ?? updated.name ?? workflowSlug,
      cause: 'edit_needs_verification',
    });
    if (missing.length > 0) {
      verification.missingInputs = missing;
      verification.message = renderMissingSmokeInputs(workflowSlug, missing);
    } else {
      const queued = queueWorkflowCreationTest(workflowSlug, testInputs, { originSessionId: opts.originSessionId });
      verification.runId = queued.id;
      verification.message = queued.message;
    }
  }
  return { result, before, after: readWorkflow(workflowSlug)?.data ?? updated, verification };
}
