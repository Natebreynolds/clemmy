/** Atomic direct-bridge admission, including callers without a chat run ID. */
import { createHash } from 'node:crypto';
import { resolveExactTerminalForAcceptedSource } from './accepted-source-terminal.js';
import { beginRunAttempt, getSession, listEvents, openEventLog, recordRunAttemptUserInput } from './eventlog.js';
import { claimPlanExecution, getLatestPlanRevision, getPlanExecutionClaim, getPlanRevision, PlanArtifactError } from './plan-artifacts.js';
import { parseTaskMode, taskModeDigest, type TaskMode } from './task-mode.js';

export function admitPlanExecutionBridgeSource(input: {
  sessionId: string;
  sourceUserSeq?: number;
  runId?: string;
  mode: Extract<TaskMode, { kind: 'execute' }>;
  displayText: string;
  modelDirectiveApplied: boolean;
  surface: string;
}) {
  return openEventLog().transaction(() => {
    const session = getSession(input.sessionId);
    if (!session) throw new PlanArtifactError('denied', 'Execute requires its existing owned conversation.');
    const scope = { sessionId: session.id, principalId: session.userId ?? session.id, ref: input.mode.executeRef };
    const artifact = getPlanRevision(scope);
    if (input.sourceUserSeq !== undefined) {
      const source = listEvents(session.id, { sinceSeq: input.sourceUserSeq - 1, types: ['user_input_received'], limit: 1 }).find(event => event.seq === input.sourceUserSeq);
      if (!source || taskModeDigest(parseTaskMode(source.data.taskMode)) !== taskModeDigest(input.mode)) throw new PlanArtifactError('conflict', 'Execute source mode does not match the selected revision.');
    }
    const prior = getPlanExecutionClaim(scope);
    const sameSource = prior?.sessionId === session.id && prior.sourceUserSeq === input.sourceUserSeq;
    if (!sameSource) {
      const latest = getLatestPlanRevision({ ...scope, planId: artifact.planId });
      if (latest?.digest !== artifact.digest) throw new PlanArtifactError('stale', 'Review the latest revision before Execute.');
      if (artifact.readiness !== 'ready' || artifact.missingPrerequisites.length) throw new PlanArtifactError('not_ready', 'The reviewed plan still has unresolved prerequisites.');
    }
    if (prior && sameSource) {
      const origin = listEvents(prior.sessionId, { sinceSeq: prior.sourceUserSeq - 1, types: ['user_input_received'], limit: 1 }).find(event => event.seq === prior.sourceUserSeq);
      if (!origin) throw new PlanArtifactError('corrupt', 'The established Execute source is missing.');
      if (resolveExactTerminalForAcceptedSource(origin).kind !== 'absent') return { kind: 'joined' as const, claim: prior };
    }
    if (prior && !sameSource) {
      if (input.sourceUserSeq !== undefined) claimPlanExecution({ ...scope, sourceUserSeq: input.sourceUserSeq, executeRef: scope.ref });
      return { kind: 'joined' as const, claim: prior };
    }
    if (prior && input.runId && input.runId !== prior.executionRunId) throw new PlanArtifactError('conflict', 'Execute cannot replace its established run identity.');
    const derivedRunId = `run-plan-source-${createHash('sha256').update(JSON.stringify({ version: 1, sessionId: session.id, sourceUserSeq: input.sourceUserSeq ?? null, ref: scope.ref })).digest('hex').slice(0, 40)}`;
    const runId = prior?.executionRunId ?? input.runId ?? derivedRunId;
    const attempt = beginRunAttempt(session.id, { runId });
    const source = recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: {
      text: input.displayText, taskMode: input.mode, runId, attemptId: attempt.attemptId,
      ...(input.modelDirectiveApplied ? { modelDirectiveApplied: true } : {}), source: `bridge:${input.surface}`,
    } }, { existingEventSeq: input.sourceUserSeq, armRunInFlight: true });
    const selected = claimPlanExecution({ ...scope, sourceUserSeq: source.seq, executeRef: scope.ref });
    if (selected.joinedExistingSource || selected.claim.executionRunId !== attempt.runId) throw new PlanArtifactError('conflict', 'Execute admission lost its exact source/run ownership.');
    return { kind: 'accepted' as const, attempt, source, claim: selected.claim };
  }).immediate();
}
