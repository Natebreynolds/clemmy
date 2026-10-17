/** Informational goal progress. These projections never complete a goal,
 * authorize work, or turn delivery acknowledgement into objective evidence. */
import type { GoalRecord } from '../memory/goals-list.js';
import type { NoticingProposalRecord } from './noticing.js';
import { isDeepStrictEqual } from 'node:util';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readAcceptedNoticingTask } from '../runtime/harness/noticing-approved-task.js';
import { getRunAttemptBySourceUserSeq, isKillRequested, listEvents, openEventLog } from '../runtime/harness/eventlog.js';
import { resolveExactTerminalForAcceptedSource } from '../runtime/harness/accepted-source-terminal.js';
import { workflowOriginReplyTargetForSource } from '../runtime/workflow-origin-authority.js';
import { exactOriginDeliveryTargetDigest, sameExactOriginDeliveryTarget } from '../runtime/exact-origin-delivery.js';
import { readActiveWorkflowOriginGroup, workflowOriginSourceGroupId,
  type WorkflowOriginGroupMember,
  type ActiveWorkflowOriginGroup } from '../execution/workflow-origin-group.js';
import { resolveWorkflowRunDefinitionSnapshot } from '../execution/workflow-run-definition.js';
import { deriveWorkflowTerminalOutcome } from '../execution/workflow-terminal-outcome.js';
import { readWorkflowTargetEvidence } from '../execution/workflow-target-evidence.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { listPlanProposals, workflowGoalSessionId, type PlanProposal } from './plan-proposals.js';
import type { QueuedRunRecord } from '../execution/workflow-runner.js';

export interface GoalWorkflowOutcome {
  runId: string;
  workflowName: string;
  state: 'in_progress' | 'satisfied' | 'not_satisfied' | 'unavailable';
  contractId?: string;
  criteria: { total: number; passed: number; remaining: string[] };
  artifactReadback: 'verified' | 'superseded' | 'changed_or_unavailable' | 'not_checked';
  detail: string;
}
export interface GoalOutcomeTask {
  proposalId: string;
  title: string;
  sessionId?: string;
  sourceUserSeq?: number;
  goalBinding: 'current' | 'historical' | 'pending' | 'unavailable';
  state: 'pending' | 'partial' | 'in_progress' | 'needs_attention' | 'outcome_retained' | 'unavailable';
  detail: string;
  workflows: GoalWorkflowOutcome[];
  omittedWorkflows: number;
}
export interface GoalOutcomeProgress {
  version: 1;
  availability: 'available' | 'unavailable';
  summary: string;
  linkedTasks: GoalOutcomeTask[];
  omittedTasks: number;
}

export function unavailableGoalOutcomeProgress(): GoalOutcomeProgress {
  return { version: 1, availability: 'unavailable',
    summary: 'Couldn’t load linked work. Open its conversation to check the result.',
    linkedTasks: [], omittedTasks: 0 };
}

const MAX_TASKS_PER_GOAL = 4;
const MAX_RUNS_PER_TASK = 4;
const MAX_TASKS_PER_CAPTURE = 8;
const MAX_RUNS_PER_CAPTURE = 8;
// Current content is deliberately a bounded fresh read, never a run-status
// cache that could keep claiming verification after an artifact changes.
const MAX_READBACKS_PER_CAPTURE = 2;
const bounded = (text: string, limit = 220): string => typeof text !== 'string' ? 'Unavailable'
  : text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Progress-log edits do not change the objective. All other saved descriptor
 * fields (including constraints, owner and next actions) must still agree. */
function sameGoalDescriptor(saved: Record<string, unknown>, goal: GoalRecord): boolean {
  const descriptor = (input: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'updatedAt' && key !== 'progressNotes'));
  return isDeepStrictEqual(descriptor(saved), descriptor(goal as unknown as Record<string, unknown>));
}

function unavailableTask(proposal: NoticingProposalRecord): GoalOutcomeTask {
  return { proposalId: proposal.id, title: bounded(proposal.title, 120), goalBinding: 'unavailable',
    state: 'unavailable', detail: 'Couldn’t confirm the task linked to this goal. Check the original conversation.', workflows: [], omittedWorkflows: 0 };
}

function exactGroup(sessionId: string, sourceUserSeq: number): ActiveWorkflowOriginGroup | null {
  const source = listEvents(sessionId, { types: ['user_input_received'], sinceSeq: sourceUserSeq - 1, limit: 1 })[0];
  if (!source || source.seq !== sourceUserSeq) throw new Error('missing accepted source');
  // The indexed query is confined to this named source. A second claimed
  // dispatch is ambiguity, not permission to choose the newest winner.
  const rows = openEventLog().prepare(`SELECT id, role, turn, parent_event_id, data_json FROM events
    WHERE session_id = ? AND type = 'async_work_dispatched'
      AND json_extract(data_json, '$.sourceUserSeq') = ? ORDER BY seq LIMIT 2`)
    .all(sessionId, sourceUserSeq) as Array<{ id: string; role: string; turn: number; parent_event_id: string; data_json: string }>;
  const active = readActiveWorkflowOriginGroup(workflowOriginSourceGroupId({ sessionId, sourceUserSeq }));
  if (!active && rows.length === 0) return null;
  if (!active || rows.length !== 1) throw new Error('missing or ambiguous dispatch');
  const row = rows[0]!;
  const data = JSON.parse(row.data_json) as Record<string, unknown>;
  const target = workflowOriginReplyTargetForSource({ sessionId, sourceUserSeq });
  if (row.role !== 'system' || row.turn !== source.turn || row.parent_event_id !== source.id
    || active.sealed.originSessionId !== sessionId || active.sealed.sourceUserSeq !== sourceUserSeq
    || !target || !sameExactOriginDeliveryTarget(target, active.sealed.replyTarget)
    || exactOriginDeliveryTargetDigest(target) !== active.sealed.replyTargetDigest
    || !Object.entries(active.publicDispatch).every(([key, value]) => isDeepStrictEqual(data[key], value))
    || !isDeepStrictEqual(data.replyTarget, active.sealed.replyTarget)) throw new Error('dispatch mismatch');
  return active;
}

interface WorkflowGoalContracts {
  byId: Map<string, PlanProposal[]>;
  byRun: Map<string, PlanProposal[]>;
  bySession: Map<string, PlanProposal[]>;
}

const safeRunId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-zA-Z0-9_.:-]+$/.test(value) && value !== '.' && value !== '..';

function workflowOutcome(member: WorkflowOriginGroupMember, sourceGroupId: string, contracts: WorkflowGoalContracts, readbackBudget: { remaining: number }): GoalWorkflowOutcome {
  const runId = member.runId;
  const unknown: GoalWorkflowOutcome = { runId, workflowName: '', state: 'unavailable',
    criteria: { total: 0, passed: 0, remaining: [] }, artifactReadback: 'not_checked',
    detail: 'Couldn’t load this workflow run or check its result.' };
  try {
    if (!safeRunId(runId)) return unknown;
    const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
    const bytes = readFileSync(file, 'utf8');
    const run = JSON.parse(bytes) as QueuedRunRecord;
    if (!record(run) || run.id !== runId || typeof run.workflow !== 'string') return unknown;
    if (run.chatDispatchSourceGroupId !== sourceGroupId
      || run.chatDispatchQueueRequestDigest !== member.queueRequestDigest) return unknown;
    unknown.workflowName = run.workflow;
    const outcome = deriveWorkflowTerminalOutcome(run);
    if (outcome && outcome !== 'succeeded') {
      // A readable exact failure does not need a successful goal review to
      // remain visible. This records no criterion pass or current readback.
      const result: GoalWorkflowOutcome = { ...unknown, state: 'not_satisfied',
        detail: `This workflow ${outcome === 'partial' ? 'finished with work still outstanding' : outcome === 'blocked' ? 'could not finish' : outcome === 'cancelled' ? 'was stopped' : 'failed'}. Open its conversation for what finished and what still needs attention.` };
      return readFileSync(file, 'utf8') === bytes ? result : unknown;
    }
    if (run.status === 'pending_approval' || run.status === 'paused') {
      return readFileSync(file, 'utf8') === bytes ? { ...unknown, state: 'not_satisfied',
        detail: 'This workflow is waiting for approval or is paused. It hasn’t finished yet.' } : unknown;
    }
    const running = ['awaiting_chat_dispatch_seal', 'queued', 'running', 'pending_approval', 'paused'].includes(run.status ?? '');
    if (running && !run.finishedAt) return { ...unknown, state: 'in_progress', detail: 'This workflow hasn’t finished yet.' };
    const admission = resolveWorkflowRunDefinitionSnapshot(run.workflowDefinitionSnapshot);
    if (admission.status !== 'valid') return unknown;
    const declared = admission.snapshot.definition.goal;
    const contractSessionId = workflowGoalSessionId(admission.snapshot.definition.name);
    const snapshots = new Map<string, string>([[file, bytes]]);
    const sameRevision = (id: unknown): QueuedRunRecord | null => {
      if (!safeRunId(id)) return null;
      const ancestorFile = path.join(WORKFLOW_RUNS_DIR, `${id}.json`);
      const ancestorBytes = snapshots.get(ancestorFile) ?? readFileSync(ancestorFile, 'utf8');
      const ancestor = JSON.parse(ancestorBytes) as QueuedRunRecord;
      const prior = record(ancestor) && ancestor.id === id
        ? resolveWorkflowRunDefinitionSnapshot(ancestor.workflowDefinitionSnapshot) : null;
      if (!prior || prior.status !== 'valid' || prior.snapshot.workflowSlug !== admission.snapshot.workflowSlug
        || prior.snapshot.definitionHash !== admission.snapshot.definitionHash
        || prior.snapshot.codeRevision !== admission.snapshot.codeRevision) return null;
      snapshots.set(ancestorFile, ancestorBytes);
      return ancestor;
    };
    const pinnedCandidates = (run: QueuedRunRecord) => typeof run.goalContractId === 'string' && run.goalContractId.trim()
      ? contracts.byId.get(run.goalContractId) ?? [] : [];
    const candidates = (() => {
      // A present pin is binding, even when malformed or no longer readable.
      // Never replace it with an unrelated active or same-named contract.
      if (Object.hasOwn(run, 'goalContractId')) return pinnedCandidates(run);
      const exact = contracts.byRun.get(runId) ?? [];
      if (exact.length) return exact;
      if (run.requeuedFromRunId !== undefined) {
        let current: QueuedRunRecord = run;
        const seen = new Set<string>([runId]);
        for (let hop = 0; hop < 4; hop++) {
          const previousId = current.requeuedFromRunId;
          if (!safeRunId(previousId) || seen.has(previousId)) return [];
          const continued = record(current.goalFollowUp) ? current.goalFollowUp.fromRunId : undefined;
          const recoveryIntent = (current as QueuedRunRecord & { recoveryIntent?: unknown }).recoveryIntent;
          const recovery = record(recoveryIntent) ? recoveryIntent.sourceRunId : undefined;
          if ((continued !== undefined && continued !== previousId) || (recovery !== undefined && recovery !== previousId)
            || (continued !== previousId && recovery !== previousId)) return [];
          seen.add(previousId);
          const previous = sameRevision(previousId);
          if (!previous) return [];
          if (Object.hasOwn(previous, 'goalContractId')) return pinnedCandidates(previous);
          const priorContracts = contracts.byRun.get(previousId) ?? [];
          if (priorContracts.length) return priorContracts;
          if (previous.requeuedFromRunId === undefined) return [];
          current = previous;
        }
        return [];
      }
      // Legacy independent fires have no persisted pin. A retained contract's
      // exact canonical session, revision and lifetime must cover this run's
      // own validation. Overlapping epochs stay ambiguous; never pick latest.
      return (contracts.bySession.get(contractSessionId) ?? []).filter(contract => {
        const plan = contract.approvedPlan ?? contract.plan;
        const validatedAt = Date.parse(run.goalValidation?.validatedAt ?? '');
        const createdAt = Date.parse(run.createdAt ?? ''), finishedAt = Date.parse(run.finishedAt ?? '');
        const openedAt = Date.parse(contract.proposedAt);
        const closedAt = contract.resolvedAt === undefined ? Infinity : Date.parse(contract.resolvedAt);
        return ['active', 'satisfied', 'expired', 'superseded'].includes(contract.status)
          && (contract.status === 'active' || Number.isFinite(closedAt))
          && Number.isFinite(openedAt) && Number.isFinite(validatedAt) && Number.isFinite(createdAt) && Number.isFinite(finishedAt)
          && openedAt <= validatedAt && validatedAt <= closedAt && createdAt <= validatedAt && validatedAt <= finishedAt
          && declared && plan?.objective === declared.objective
          && isDeepStrictEqual(plan?.successCriteria, declared.successCriteria ?? [])
          && sameRevision(contract.origin?.runId) !== null;
      });
    })();
    if (candidates.length !== 1) return { ...unknown, detail: candidates.length > 1
      ? 'The saved requirements for this run conflict. Open its conversation to check the result.'
      : 'The saved requirements for this run are missing. A finished run alone doesn’t confirm the task was done.' };
    const contract = candidates[0]!;
    const plan = contract.approvedPlan ?? contract.plan;
    const validation = run.goalValidation;
    if (typeof contract.id !== 'string' || !contract.id || !plan || typeof plan.objective !== 'string' || !Array.isArray(plan.successCriteria)
      || contract.origin?.kind !== 'workflow' || contract.sessionId !== contractSessionId || !declared
      || (run.workflow !== admission.snapshot.workflowSlug && run.workflow !== admission.snapshot.definition.name)
      || !validation || validation.version !== 1 || validation.objective !== plan.objective
      || declared.objective !== plan.objective
      || !isDeepStrictEqual(validation.successCriteria, plan.successCriteria)
      || !isDeepStrictEqual(declared.successCriteria ?? [], validation.successCriteria)
      || !Array.isArray(validation.perCriterion)
      || !Number.isFinite(Date.parse(validation.validatedAt))) return { ...unknown, contractId: contract.id };
    const criteria = validation.successCriteria;
    if (!criteria.every(c => typeof c === 'string')
      || new Set(criteria).size !== criteria.length
      || validation.perCriterion.length !== criteria.length
      || !criteria.every(c => validation.perCriterion.filter(row => row.criterion === c).length === 1)
      || !validation.perCriterion.every(row => typeof row.pass === 'boolean' && ['deterministic', 'judge', 'skipped'].includes(row.method))) return unknown;
    const passed = validation.perCriterion.filter(row => row.pass === true && row.method !== 'skipped').length;
    const objectivePassed = validation.objectiveReview?.pass === true && validation.objectiveReview.scope === 'objective'
      && ['deterministic', 'judge'].includes(validation.objectiveReview.method);
    const satisfied = run.status === 'completed' && Number.isFinite(Date.parse(run.finishedAt ?? '')) && run.needsAttention !== true
      && run.goalOutcome === 'satisfied' && contract.status === 'satisfied'
      && validation.pass === true && validation.judgeFailedOpen === false && passed === criteria.length
      && objectivePassed;
    const remaining = validation.perCriterion.filter(row => !row.pass || row.method === 'skipped').map(row => row.criterion);
    if (!objectivePassed) {
      remaining.push(validation.objectiveReview?.criterion ?? validation.objective);
    }
    const result: GoalWorkflowOutcome = { ...unknown, contractId: contract.id,
      state: satisfied ? 'satisfied' : 'not_satisfied',
      criteria: { total: criteria.length, passed,
        remaining: remaining.slice(0, 4).map(criterion => bounded(criterion, 180)) },
      detail: satisfied ? 'This run met its saved requirements. That does not mark the whole goal done.'
        : 'This run hasn’t met all its saved requirements. Review what remains, including any changes that may already have happened.' };
    if (satisfied && readbackBudget.remaining > 0) {
      readbackBudget.remaining -= 1;
      const target = readWorkflowTargetEvidence(runId, { compactResults: true });
      const counts = target.artifactReadback;
      if (counts && counts.checked > 0) {
        // A known failed readback remains contrary evidence even when some
        // other write has no current-content contract. Unknown cannot hide bad.
        if (counts.unavailable > 0) result.artifactReadback = 'changed_or_unavailable';
        else if (counts.uncoveredWrites === 0) {
          const proved = target.available && !!target.results?.length && target.results.every(row => row.status === 'verified');
          const superseded = counts.superseded ?? 0;
          result.artifactReadback = proved && counts.verified + superseded === counts.checked
            ? superseded > 0 ? 'superseded' : 'verified' : 'changed_or_unavailable';
        }
      }
    }
    // Cross-process writes can replace a run while evidence is being read.
    // Never mix one record's review with another generation's readback.
    if ([...snapshots].some(([name, captured]) => readFileSync(name, 'utf8') !== captured)) return unknown;
    return result;
  } catch { return unknown; }
}

/** One bounded, fresh read for a Goals screen or a Noticing observation.
 * No source, goal, run, contract, artifact or delivery record is changed. */
export function readGoalOutcomeProgress(input: {
  goals: readonly GoalRecord[]; proposals: readonly NoticingProposalRecord[];
}): Record<string, GoalOutcomeProgress> {
  const result: Record<string, GoalOutcomeProgress> = Object.create(null);
  if (input.goals.length === 0) return result;
  const contracts: WorkflowGoalContracts = { byId: new Map(), byRun: new Map(), bySession: new Map() };
  const readbackBudget = { remaining: MAX_READBACKS_PER_CAPTURE };
  let remainingTasks = MAX_TASKS_PER_CAPTURE;
  let remainingRuns = MAX_RUNS_PER_CAPTURE;
  const goalIds = new Set(input.goals.filter(goal => goal && typeof goal.id === 'string').map(goal => goal.id));
  const byGoal = new Map<string, NoticingProposalRecord[]>();
  for (const proposal of input.proposals) {
    if (!proposal || typeof proposal.goalId !== 'string' || !goalIds.has(proposal.goalId)
      || proposal.answer?.decision !== 'do_it' || !proposal.handoff) continue;
    const rows = byGoal.get(proposal.goalId) ?? [];
    rows.push(proposal); byGoal.set(proposal.goalId, rows);
  }
  // Shared once, never a full run-directory scan per lightweight goal.
  // The existing plan registry has no run-origin index. This remains one
  // full registry read only when there are qualifying linked tasks.
  let capturedContracts: PlanProposal[];
  try { capturedContracts = byGoal.size ? listPlanProposals({ status: 'all', strictRead: true }) : []; }
  catch {
    for (const goalId of goalIds) result[goalId] = unavailableGoalOutcomeProgress();
    return result;
  }
  for (const contract of capturedContracts) {
    if (contract?.origin?.kind !== 'workflow' || typeof contract.origin.runId !== 'string') continue;
    for (const [index, key] of [[contracts.byRun, contract.origin.runId], [contracts.byId, contract.id],
      [contracts.bySession, contract.sessionId]] as const) {
      if (typeof key !== 'string' || !key) continue;
      const rows = index.get(key) ?? [];
      rows.push(contract); index.set(key, rows);
    }
  }
  for (const goal of input.goals) {
    if (!goal || typeof goal.id !== 'string') continue;
    const linked = (byGoal.get(goal.id) ?? [])
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    const selected = linked.slice(0, Math.min(MAX_TASKS_PER_GOAL, remainingTasks));
    remainingTasks -= selected.length;
    const linkedTasks = selected.map(proposal => {
      const unavailable = unavailableTask(proposal);
      try {
        const handoff = proposal.handoff!;
        if (handoff.sessionId === undefined && handoff.sourceUserSeq === undefined && handoff.requestId === undefined
          && (handoff.state === 'not_started' || handoff.state === 'needs_attention')) {
          return { proposalId: proposal.id, title: bounded(proposal.title, 120), goalBinding: 'pending' as const,
            state: handoff.state === 'not_started' ? 'pending' as const : 'needs_attention' as const,
            detail: handoff.state === 'not_started'
              ? 'Your answer is saved; the task’s start is not confirmed yet.'
              : 'Clem couldn’t confirm that the task started. Please check the original conversation.',
            workflows: [], omittedWorkflows: 0 } satisfies GoalOutcomeTask;
        }
        if (!handoff.sessionId || !Number.isSafeInteger(handoff.sourceUserSeq) || !handoff.requestId) return unavailable;
        const identity = { sessionId: handoff.sessionId, sourceUserSeq: handoff.sourceUserSeq! };
        const accepted = readAcceptedNoticingTask(identity);
        const source = listEvents(identity.sessionId, { types: ['user_input_received'], sinceSeq: identity.sourceUserSeq - 1, limit: 1 })[0];
        const binding = source?.data.noticingApprovedTask as { requestId?: unknown } | undefined;
        if (!accepted || !source || accepted.packet.proposal.id !== proposal.id
          || accepted.packet.proposal.goalId !== goal.id || accepted.packet.goal?.id !== goal.id
          || binding?.requestId !== handoff.requestId || accepted.packet.checkIn.answer !== proposal.answer?.text) return unavailable;
        const current = sameGoalDescriptor(accepted.packet.goal, goal);
        let active: ActiveWorkflowOriginGroup | null = null;
        let groupUnavailable = false;
        try { active = exactGroup(identity.sessionId, identity.sourceUserSeq); }
        catch { groupUnavailable = true; }
        const selectedMembers = (active?.sealed.members ?? []).slice(0, Math.min(MAX_RUNS_PER_TASK, remainingRuns));
        remainingRuns -= selectedMembers.length;
        const workflows = selectedMembers
          .map(member => workflowOutcome(member, active!.sealed.sourceGroupId, contracts, readbackBudget));
        const omittedWorkflows = Math.max(0, (active?.sealed.members.length ?? 0) - workflows.length);
        const truncated = omittedWorkflows > 0;
        const terminal = resolveExactTerminalForAcceptedSource(source);
        const stopped = isKillRequested(identity.sessionId, { sourceUserSeq: identity.sourceUserSeq });
        const attempt = getRunAttemptBySourceUserSeq(identity.sessionId, identity.sourceUserSeq);
        const attention = workflows.some(row => row.state === 'not_satisfied' || row.artifactReadback === 'changed_or_unavailable')
          || stopped
          || (terminal.kind === 'terminal' && terminal.presentation.status !== 'done')
          || handoff.state === 'needs_attention'
          || (terminal.kind === 'absent' && attempt && ['failed', 'cancelled', 'interrupted', 'superseded'].includes(attempt.status))
          || (terminal.kind === 'absent' && !active && !groupUnavailable
            && (handoff.state === 'settled' || attempt?.status !== 'active'));
        const evidenceUnavailable = groupUnavailable || workflows.some(row => row.state === 'unavailable')
          || terminal.kind === 'corrupt' || terminal.kind === 'legacy';
        const state: GoalOutcomeTask['state'] = attention ? 'needs_attention'
          : workflows.some(row => row.state === 'in_progress') ? 'in_progress'
          : evidenceUnavailable ? 'unavailable'
          : truncated ? 'partial'
          : workflows.length > 0 || terminal.kind === 'terminal' ? 'outcome_retained'
          : 'in_progress';
        return { proposalId: proposal.id, title: bounded(accepted.packet.proposal.title, 120), ...identity,
          goalBinding: current ? 'current' as const : 'historical' as const, state, workflows, omittedWorkflows,
          detail: !current ? 'This task used an earlier version of your goal. Check the current requirements before relying on its result.'
            : truncated ? 'More workflow runs are in the original conversation.'
            : evidenceUnavailable ? 'Some results couldn’t be checked. Known problems and ongoing work are still shown below.'
            : workflows.length ? 'Workflow results are below. You decide when the whole goal is done.'
            : terminal.kind === 'terminal' ? 'A result is saved in the conversation. Workflow requirements and the current saved output haven’t been checked here.'
            : 'Open the conversation for progress or to continue. This view does not restart work.' } satisfies GoalOutcomeTask;
      } catch { return unavailable; }
    });
    result[goal.id] = { version: 1, availability: 'available', linkedTasks,
      omittedTasks: Math.max(0, linked.length - linkedTasks.length),
      summary: linkedTasks.length ? 'Recent work is shown below. Tasks outside this view haven’t been checked here. Your goal’s status stays as you set it.'
        : linked.length ? 'More tasks are linked to this goal. Tasks outside this view haven’t been checked here. Your goal’s status stays as you set it.'
        : 'No approved task is linked to this goal yet. Your goal’s status stays as you set it.' };
  }
  return result;
}
