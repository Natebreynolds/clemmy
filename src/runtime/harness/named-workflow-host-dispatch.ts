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
import { readConsumedTaskContinuityPacket } from '../../memory/task-continuity.js';
import {
  validateExistingWorkflowAuthority,
  type ExistingWorkflowAuthorityV1,
} from './existing-workflow-authority.js';
import { getSession, listEvents } from './eventlog.js';
import {
  requestsWorkflowExecution,
  uniqueEnabledWorkflowMatch,
  uniqueWorkflowRunRequest,
  type UniqueEnabledWorkflowMatch,
} from '../../tools/named-workflow-match.js';
import { admitNamedWorkflowRunFromAcceptedSource } from '../../tools/admit-named-workflow-run.js';
import {
  rehydrateConsumedClarificationContext,
  SEMANTIC_CLARIFICATION_RESOLVER_VERSION,
} from './task-continuity-runtime.js';
import { admittedOpenSlotValueFromLastInterpretation } from '../semantic-boundary/interpret-accepted-source.js';

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

const WORKFLOW_CORRECTION_FILLER = new Set([
  'actually', 'correction', 'flow', 'i', 'is', 'it', 'meant', 'mean', 'my',
  'one', 'sorry', 'that', 'the', 'workflow', 'yes',
]);

function workflowCorrectionTokens(value: string): string[] {
  return value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** B may correct only identity. Any cancellation, management, inspection, or
 * compound action in B must go through ordinary fresh-turn semantics rather
 * than borrowing the parent's RUN imperative. */
function isPureWorkflowIdentityCorrection(
  value: string,
  match: UniqueEnabledWorkflowMatch,
): boolean {
  const text = value.trim();
  if (
    !text
    || text.length > 160
    || /\b(?:do\s+not|don['’]?t|never|not|stop|cancel|skip|leave|forget|delete|disable|enable|edit|update|reschedule|rename|archive|pause|inspect|show|view|read|get|definition|instead|but|also)\b/iu.test(text)
  ) return false;
  const identity = new Set(workflowCorrectionTokens(`${match.slug} ${match.name}`));
  const tokens = workflowCorrectionTokens(text);
  return tokens.length > 0
    && tokens.some((token) => identity.has(token))
    && tokens.every((token) => identity.has(token) || WORKFLOW_CORRECTION_FILLER.has(token));
}

/**
 * A free-text clarification answer supplies only the corrected resource
 * identity. It can never manufacture RUN authority: that must already be
 * present in the exact durable parent request, and the exact open question
 * must name the same unique workflow. Rehydrating the consumed packet also
 * proves this is the checked A/Q/B continuation for the current accepted
 * source rather than an unrelated phrase or a caller-constructed context.
 */
function consumedWorkflowNameCorrection(input: {
  sessionId: string;
  sourceUserSeq: number;
  userText: string;
}): UniqueEnabledWorkflowMatch | null {
  const consumed = readConsumedTaskContinuityPacket({
    sessionId: input.sessionId,
    consumingSourceUserSeq: input.sourceUserSeq,
  });
  if (
    consumed.status !== 'consumed'
    || consumed.packet.pause.kind !== 'clarification'
    || consumed.resolution.resolverVersion !== SEMANTIC_CLARIFICATION_RESOLVER_VERSION
    || consumed.resolution.disposition !== 'provided'
    || consumed.resolution.selectedOption !== undefined
  ) return null;
  const admittedAnswer = admittedOpenSlotValueFromLastInterpretation(
    input.sessionId,
    input.sourceUserSeq,
  );
  const openSlot = consumed.packet.pause.slot;
  if (
    !admittedAnswer
    || !openSlot
    || admittedAnswer.goalId !== openSlot.goalId
    || admittedAnswer.baseRevision !== openSlot.revision
    || admittedAnswer.questionId !== openSlot.questionId
    || admittedAnswer.slotKey !== openSlot.slotKey
    || admittedAnswer.value !== input.userText
  ) return null;
  const continuation = rehydrateConsumedClarificationContext({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    answer: input.userText,
  });
  if (
    !continuation
    || continuation.disposition !== 'provided'
    || continuation.selectedOption !== undefined
    || continuation.answer !== input.userText
    || !requestsWorkflowExecution(continuation.parentInput)
  ) return null;
  const corrected = uniqueEnabledWorkflowMatch(continuation.answer);
  const namedByQuestion = uniqueEnabledWorkflowMatch(continuation.question);
  if (
    !corrected
    || !namedByQuestion
    || corrected.slug !== namedByQuestion.slug
    || !isPureWorkflowIdentityCorrection(continuation.answer, corrected)
  ) return null;
  return corrected;
}

/**
 * Is this accepted source a workflow's OWN step, rather than someone asking
 * for a workflow?
 *
 * A step's model turn runs on the same host engine as chat, and its accepted
 * source is the runner's own step message: "Workflow: <name>\nStep: <id>" over
 * a prompt that legitimately says "run" (the output-contract line, a learned
 * pin) and names the workflow itself. That text is the step's WORK. Reading it
 * as a request queued a sibling run of the same workflow — or, when the reply
 * target could not bind, ended the step with the block message as its output
 * (live 2026-08-31: five of eight enabled workflows). The class is durable on
 * the source, so it is decided there and never from the text: the step
 * session is kind 'workflow' and carries the deterministic `workflow:` id,
 * and the exact accepted event carries the run/step identity the runner wrote.
 * Chat and the cron/background 'execution' surfaces stay open — their
 * accepted text was authored for a user.
 */
export function acceptedSourceIsWorkflowInternal(sessionId: string, sourceUserSeq: number): boolean {
  if (sessionId.startsWith('workflow:')) return true;
  // A self-improvement turn (workflow-self-improvement.ts) is host-authored
  // text ABOUT a workflow that was asked to run; live 2026-09-01 the shortcut
  // read that as a run request, tried to queue the workflow from a system
  // session with no report-back target, and ended the turn before a single
  // authoring call. Host-internal sources never manufacture run authority.
  if (sessionId.startsWith('workflow-improvement:')) return true;
  if (getSession(sessionId)?.kind === 'workflow') return true;
  const accepted = listEvents(sessionId, {
    sinceSeq: sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  }).find((event) => event.seq === sourceUserSeq);
  return typeof accepted?.data.workflowRunId === 'string'
    || typeof accepted?.data.stepId === 'string';
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
  // Decided before any lexical match or clarification correction: a step's
  // own text can never manufacture RUN authority over its own workflow.
  if (acceptedSourceIsWorkflowInternal(input.sessionId, input.sourceUserSeq)) {
    return { status: 'not_applicable', reason: 'accepted_source_is_workflow_internal' };
  }
  const unique = uniqueWorkflowRunRequest(
    input.userText,
    priorAcceptedSourceTexts(input.sessionId, input.sourceUserSeq),
  ) ?? consumedWorkflowNameCorrection(input);
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
