/**
 * Foreground host-chat run-strategy learning.
 *
 * Background tasks already distill a proven run SHAPE into run-strategy-store
 * so the next similar objective plans from it. Host chat completed the same
 * kinds of work and then rediscovered tools from scratch because nothing
 * recorded the shape. This module is the same projection at the same
 * delivery boundary: a verified `done` terminal plus explicit settlements
 * may teach a strategy. It never grants dispatch, approval, or a new loop.
 */
import { appendEvent, listEvents, openEventLog } from './eventlog.js';
import { acceptedObjectiveForSource, completionVerdictForAcceptedSource, settledSourceArtifacts } from './host-turn-runner.js';
import {
  evaluateLearningCandidate,
  recordLearningDecision,
} from '../../memory/learning-receipt.js';
import { recordRunStrategy } from '../../memory/run-strategy-store.js';
import { actionTopologyRoleFor } from '../../tools/tool-registry.js';

function toolsUsedForSource(input: { sessionId: string; sourceUserSeq: number }): string[] {
  try {
    const rows = openEventLog().prepare(`
      SELECT l.tool_name AS toolName
        FROM logical_call_settlements s
        JOIN logical_tool_calls l
          ON l.session_id = s.session_id AND l.source_user_seq = s.source_user_seq
         AND l.logical_tool_call_id = s.logical_tool_call_id
       WHERE s.session_id = ? AND s.source_user_seq = ?
         AND s.outcome_kind IN ('succeeded', 'empty_result')
       ORDER BY s.rowid
    `).all(input.sessionId, input.sourceUserSeq) as Array<{ toolName: string }>;
    const names = rows
      .map((row) => row.toolName.trim())
      .filter((name) => name && actionTopologyRoleFor(name) !== 'control');
    return [...new Set(names)].slice(0, 8);
  } catch {
    return [];
  }
}

function durationMsForSource(input: { sessionId: string; sourceUserSeq: number }): number {
  try {
    const start = listEvents(input.sessionId, {
      sinceSeq: input.sourceUserSeq - 1,
      types: ['user_input_received'],
      limit: 1,
    }).find((event) => event.seq === input.sourceUserSeq);
    if (!start?.createdAt) return 0;
    return Math.max(0, Date.now() - Date.parse(start.createdAt));
  } catch {
    return 0;
  }
}

function deliverableForSource(input: { sessionId: string; sourceUserSeq: number }): string | undefined {
  try {
    const artifacts = settledSourceArtifacts(input);
    const handle = artifacts.artifacts.find((row) => row.handle)?.handle;
    return handle ? String(handle).slice(0, 240) : undefined;
  } catch {
    return undefined;
  }
}

export function learnHostRunStrategyForAcceptedTask(input: {
  sessionId: string;
  sourceUserSeq: number;
}): { status: 'learned' | 'updated' | 'not_proven'; reason?: string } {
  const objective = acceptedObjectiveForSource(input);
  if (!objective?.trim()) return { status: 'not_proven', reason: 'no accepted objective' };
  const toolsUsed = toolsUsedForSource(input);
  if (toolsUsed.length === 0) return { status: 'not_proven', reason: 'no settled business tools' };
  const verdict = completionVerdictForAcceptedSource(input);
  const ownerSelected = verdict?.ownerSelectedJudge === true;
  const independent = verdict?.fast === true && verdict?.failedOpen !== true;
  const learningInput = {
    target: 'strategy' as const,
    authority: independent
      ? 'independent_completion_judge' as const
      : ownerSelected
        ? 'configured_completion_review' as const
        : 'execution_controller' as const,
    sessionId: input.sessionId,
    sourceId: `${input.sessionId}:${input.sourceUserSeq}`,
    terminalSuccess: true,
    independentValidation: independent,
    controllerValidation: true,
    ownerSelectedJudge: ownerSelected,
    failedOpen: verdict?.failedOpen === true,
    selfJudge: verdict?.selfJudge === true,
    awaitingUser: false,
  };
  const decision = evaluateLearningCandidate(learningInput);
  recordLearningDecision(learningInput, decision, { surface: 'host_chat', toolsUsed });
  if (!decision.receipt) {
    return { status: 'not_proven', reason: decision.reasons.join('; ') || 'ineligible' };
  }
  const recorded = recordRunStrategy({
    objective,
    toolsUsed,
    workerCount: 0,
    durationMs: durationMsForSource(input),
    deliverable: deliverableForSource(input),
    learningReceipt: decision.receipt,
  });
  if (!recorded) return { status: 'not_proven', reason: 'strategy store rejected the record' };
  const status = recorded.uses > 1 ? 'updated' as const : 'learned' as const;
  try {
    appendEvent({
      sessionId: input.sessionId,
      turn: 0,
      role: 'system',
      type: 'run_strategy_learned',
      data: {
        sourceUserSeq: input.sourceUserSeq,
        status,
        toolsUsed,
        objective: objective.slice(0, 240),
      },
    });
  } catch { /* learning observability must not block delivery */ }
  return { status };
}
