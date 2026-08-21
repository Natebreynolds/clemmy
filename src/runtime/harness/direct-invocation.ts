/**
 * Direct runner: one fully bound NodeInvocationPlan, no extra scheduler
 * choice. Reservation, physical dispatch, settlement, evidence, and Outcome
 * are the same kernel as every other typed mode.
 */
import type { TurnIdentity } from './turn-outcome.js';
import { runAdmittedSourceGraph, type ConstructRunResult } from './admitted-construct-run.js';

export async function runDirectNodeInvocation(
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>,
): Promise<ConstructRunResult> {
  return runAdmittedSourceGraph(identity);
}
