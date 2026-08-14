import type { TaskContinuationContext } from '../../types.js';
import { resolveActiveTaskContext } from './active-task-context.js';

/**
 * The action surface needs a typed distinction between new work and a request
 * to recover prior task state.  A durable clarification packet is the strongest
 * source.  Free-form anaphora is admitted only when it is both explicit in the
 * current request and backed by an active/parked task or goal; wording alone
 * never opens the history surface.
 */
export type ActionTaskState =
  | { kind: 'fresh' }
  | {
      kind: 'continuation';
      authority: 'durable_clarification' | 'anaphoric_durable_task';
      contextDigest?: string;
    };

const EXPLICIT_TASK_CONTINUATION_RE =
  /\b(?:continue|resume|reopen|carry\s+on|keep\s+going|get\s+back\s+to|pick\s+(?:this|that|it|the\s+(?:task|work))?\s*(?:back\s+)?up|where\s+(?:we|you)\s+left\s+off|finish\s+(?:this|that|it|the\s+(?:task|work))|(?:prior|previous|parked|held)\s+(?:task|work))\b/i;

function continuationPacketCarriesTaskAuthority(
  continuation: TaskContinuationContext | undefined,
): boolean {
  return continuation !== undefined
    && continuation.disposition !== 'declined'
    && continuation.disposition !== 'declined_with_new_task';
}
export function resolveActionTaskState(input: {
  sessionId?: string | null;
  userInput?: string | null;
  taskContinuation?: TaskContinuationContext;
}): ActionTaskState {
  if (continuationPacketCarriesTaskAuthority(input.taskContinuation)) {
    return { kind: 'continuation', authority: 'durable_clarification' };
  }

  const text = input.userInput?.trim() ?? '';
  if (!text || !EXPLICIT_TASK_CONTINUATION_RE.test(text)) return { kind: 'fresh' };

  const context = resolveActiveTaskContext({
    sessionId: input.sessionId?.trim() || undefined,
    input: text,
  });
  if (!context.focus && context.parked.length === 0 && !context.goal) return { kind: 'fresh' };
  return {
    kind: 'continuation',
    authority: 'anaphoric_durable_task',
    contextDigest: context.digest,
  };
}
