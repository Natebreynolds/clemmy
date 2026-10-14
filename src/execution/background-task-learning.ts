/** Frozen task ancestry restricts learning; it never grants execution authority. */
import type { TurnLearningSource } from '../memory/turn-learning-policy.js';
import type { BackgroundTaskRecord } from './background-tasks.js';

type TaskOrigin = Pick<BackgroundTaskRecord, 'originSessionId' | 'foregroundHandoff' | 'delegation'>;

/** No task chronology or reusable origin-chat's current turn is consulted.
 * An incomplete/conflicting origin stays explicitly unavailable (seq=0), so
 * the optional learning reader declines it while the task can still execute. */
export function backgroundTaskLearningSource(task: TaskOrigin): TurnLearningSource | undefined {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  // Persisted JSON is not guaranteed to have the TypeScript shape. Optional
  // learning must not throw while constructing a real worker's request.
  if (!isRecord(task)) return { sessionId: '', sourceUserSeq: 0 };
  const rawHandoff: unknown = task.foregroundHandoff;
  const rawDelegation: unknown = task.delegation;
  const handoff = isRecord(rawHandoff) ? rawHandoff : undefined;
  const delegated = isRecord(rawDelegation) ? rawDelegation.originSourceUserSeq : undefined;
  const origin: unknown = task.originSessionId;
  const malformed = (rawHandoff !== undefined && !handoff)
    || (rawDelegation !== undefined && !isRecord(rawDelegation))
    || (origin !== undefined && (typeof origin !== 'string' || !origin.trim()));
  if (!malformed && rawHandoff === undefined && origin === undefined && delegated === undefined) return undefined;
  const sessionId = typeof handoff?.sessionId === 'string' ? handoff.sessionId : typeof origin === 'string' ? origin : '';
  const source = handoff?.sourceUserSeq ?? delegated;
  const sourceUserSeq = typeof source === 'number' ? source : 0;
  const invalid = malformed || !sessionId || !Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0
    || (handoff !== undefined && (typeof handoff.sessionId !== 'string' || typeof handoff.sourceUserSeq !== 'number'))
    || (handoff !== undefined && origin !== undefined && origin !== handoff.sessionId)
    || (handoff !== undefined && delegated !== undefined && delegated !== handoff.sourceUserSeq);
  return { sessionId, sourceUserSeq: invalid ? 0 : sourceUserSeq };
}
