/**
 * One admission path for a uniquely identified workflow run.
 *
 * MCP `workflow_run` and the host unique-run dispatch both call this so a
 * named run is queued through queueWorkflowRun — not a second kernel, and
 * not a model prompt after plan_not_required. Live 2026-08-29 seq 97371:
 * the host uniquely named platform-49-slack-channel-review, then the model
 * asked a check-in instead of dispatching.
 */
import { listWorkflows } from '../memory/workflow-store.js';
import {
  certifyWorkflow,
  renderWorkflowCertification,
} from '../execution/workflow-certification.js';
import {
  missingWorkflowRunInputs,
  normalizeWorkflowRunInputs,
} from '../execution/workflow-inputs.js';
import { surfaceWorkflowPendingInputs } from '../agents/plan-proposals.js';
import { listEvents } from '../runtime/harness/eventlog.js';
import { workflowOriginReplyTargetForSource } from '../runtime/workflow-origin-authority.js';
import { prepareWorkflowChatDispatch } from '../runtime/harness/workflow-chat-dispatch-prepare.js';
import { queueWorkflowRun } from './workflow-run-queue.js';
import { workflowNamesEqual } from './workflow-resolve.js';
import { linkFocusActionForSession } from '../memory/focus.js';

export interface AdmitNamedWorkflowRunInput {
  workflowName: string;
  sessionId?: string;
  sourceUserSeq?: number;
  inputs?: Record<string, string>;
}

export interface AdmitNamedWorkflowRunResult {
  ok: boolean;
  status:
    | 'queued'
    | 'duplicate'
    | 'held'
    | 'blocked_readiness'
    | 'disabled'
    | 'missing_inputs'
    | 'certification_failed'
    | 'origin_unbound'
    | 'not_found';
  message: string;
  workflowName: string;
  runId?: string;
}

export function admitNamedWorkflowRunFromAcceptedSource(
  input: AdmitNamedWorkflowRunInput,
): AdmitNamedWorkflowRunResult {
  const wanted = input.workflowName.trim();
  const workflow = listWorkflows().find((entry) => workflowNamesEqual(entry.data.name, wanted));
  if (!workflow) {
    return {
      ok: false,
      status: 'not_found',
      workflowName: wanted,
      // A missing workflow is not a missing capability. Naming only the
      // absence left the model with nowhere to go: live 2026-09-03, a cold
      // request matched a saved workflow, the run was refused, and the turn
      // ENDED on the bare sentence — no prospect research, no reads, nothing
      // attempted. A saved workflow is a shortcut, never the only door.
      message: `Workflow "${wanted}" not found. This does not block the work: `
        + `carry out the request directly with the tools you already have `
        + `(tool_search for the exact operations, then plan and act as usual).`,
    };
  }
  const canonicalName = workflow.data.name;
  if (!workflow.data.enabled) {
    return {
      ok: false,
      status: 'disabled',
      workflowName: canonicalName,
      // Disabled means "do not run this saved definition", never "do not do
      // this work". Live 2026-09-03 run 29: the model matched a saved workflow,
      // was told it is disabled, and stopped there — zero business calls on a
      // request it was fully equipped to carry out directly.
      message: `Workflow "${canonicalName}" is disabled, so it will not be run. `
        + `That does not block the request: carry it out directly with the tools `
        + `you already have (tool_search for the exact operations, then plan and `
        + `act as usual). Do not re-attempt this workflow.`,
    };
  }

  const normalizedInputs = normalizeWorkflowRunInputs(input.inputs ?? {});
  const runCertification = certifyWorkflow(workflow.data, {
    workflowSlug: workflow.name,
    runInputs: normalizedInputs,
  });
  if (runCertification.resourceGaps.length > 0) {
    return {
      ok: false,
      status: 'certification_failed',
      workflowName: canonicalName,
      message: renderWorkflowCertification(runCertification),
    };
  }
  const missing = missingWorkflowRunInputs(workflow.data, normalizedInputs);
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  const sourceUserSeq = Number.isSafeInteger(input.sourceUserSeq) ? input.sourceUserSeq as number : 0;
  if (missing.length > 0) {
    if (sessionId) {
      surfaceWorkflowPendingInputs({
        workflowName: canonicalName,
        requiredInputs: missing,
        providedInputs: normalizedInputs,
        sessionId,
        originatingRequest: `Run the "${canonicalName}" workflow`,
      });
      const inputList = missing.map((key) => `\`${key}\``).join(', ');
      return {
        ok: false,
        status: 'missing_inputs',
        workflowName: canonicalName,
        message: `I need ${inputList} to run the "${canonicalName}" workflow. Reply with ${missing.length === 1 ? 'it' : 'them'} and I'll run it.`,
      };
    }
    return {
      ok: false,
      status: 'missing_inputs',
      workflowName: canonicalName,
      message: [
        `Workflow "${canonicalName}" was not queued because required input${missing.length === 1 ? '' : 's'} ${missing.map((key) => `"${key}"`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`,
        `Call workflow_run again with inputs including ${missing.map((key) => `"${key}": "<value>"`).join(', ')}.`,
      ].join('\n'),
    };
  }

  const exactOrigin = sessionId && sourceUserSeq > 0
    ? { sessionId, sourceUserSeq }
    : undefined;
  const exactSource = exactOrigin
    ? listEvents(exactOrigin.sessionId, { types: ['user_input_received'] })
        .find((event) => event.seq === exactOrigin.sourceUserSeq)
    : undefined;
  const replyTarget = exactOrigin
    ? workflowOriginReplyTargetForSource(exactOrigin)
    : null;
  if (exactOrigin && (!exactSource || !replyTarget)) {
    return {
      ok: false,
      status: 'origin_unbound',
      workflowName: canonicalName,
      message: `Workflow "${canonicalName}" was not queued because this chat's exact report-back target could not be bound safely.`,
    };
  }
  const originObserver = exactOrigin && replyTarget
    ? { ...exactOrigin, replyTarget }
    : undefined;
  const queued = queueWorkflowRun(canonicalName, normalizedInputs, {
    ...(originObserver
      ? {
          originObserver,
          prepareChatDispatch: prepareWorkflowChatDispatch,
        }
      : { originSessionId: sessionId || undefined }),
  });
  const acceptedDispatch = Boolean(queued.chatDispatchPreparation)
    || queued.status === 'queued'
    || queued.status === 'duplicate';
  if (acceptedDispatch && !queued.id) {
    throw new Error('workflow queue accepted a run without returning its durable run id');
  }
  if (queued.id && acceptedDispatch && !queued.chatDispatchPreparation) {
    linkFocusActionForSession(sessionId || undefined, {
      id: queued.id,
      label: canonicalName,
      status: 'running',
      kind: 'workflow',
      ref: queued.id,
      note: queued.status === 'duplicate'
        ? 'Rejoined the already-running workflow; no duplicate was queued.'
        : undefined,
    });
  }
  const ok = queued.status === 'queued'
    || queued.status === 'duplicate'
    || queued.status === 'held';
  return {
    ok,
    status: queued.status === 'blocked_readiness'
      ? 'blocked_readiness'
      : queued.status === 'held'
        ? 'held'
        : queued.status === 'duplicate'
          ? 'duplicate'
          : 'queued',
    workflowName: canonicalName,
    message: queued.message,
    ...(queued.id ? { runId: queued.id } : {}),
  };
}
