/** Conversation history is durable user data. Automatic age-based deletion is
 * an explicit operator policy, not a default memory/token optimization. */
import { reapStaleChatCancellations, reapStaleSessions, reapStaleToolOutputs } from '../runtime/harness/eventlog.js';
import { reapStaleWorkingMemory } from './working-memory.js';

export function automaticConversationRetentionPolicy(env: NodeJS.ProcessEnv = process.env): {
  sessionDays: number | null; toolOutputDays: number | null;
} {
  const configuredDays = (raw: string | undefined): number | null => {
    if (!raw?.trim()) return null;
    const days = Number(raw);
    return Number.isFinite(days) && days > 0 ? Math.max(1, Math.min(365, Math.floor(days))) : null;
  };
  return { sessionDays: configuredDays(env.CLEMMY_SESSION_TTL_DAYS),
    toolOutputDays: configuredDays(env.CLEMMY_TOOL_OUTPUT_TTL_DAYS) };
}

export function reapConfiguredConversationHistory(input: {
  policy?: ReturnType<typeof automaticConversationRetentionPolicy>;
  onError?: (store: string, error: unknown) => void;
} = {}): Record<'toolOutputs' | 'sessions' | 'cancellations' | 'workingMemory', number> {
  const policy = input.policy ?? automaticConversationRetentionPolicy();
  const result = { toolOutputs: 0, sessions: 0, cancellations: 0, workingMemory: 0 };
  const sweep = (key: keyof typeof result, action: () => number) => {
    try { result[key] = action(); } catch (error) { input.onError?.(key, error); }
  };
  if (policy.toolOutputDays !== null) sweep('toolOutputs', () => reapStaleToolOutputs(policy.toolOutputDays!));
  if (policy.sessionDays !== null) {
    sweep('sessions', () => reapStaleSessions(policy.sessionDays!));
    sweep('cancellations', () => reapStaleChatCancellations(policy.sessionDays!));
    sweep('workingMemory', () => reapStaleWorkingMemory(policy.sessionDays!));
  }
  return result;
}
