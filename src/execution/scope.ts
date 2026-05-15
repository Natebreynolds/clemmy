import type { ExecutionRecord } from '../types.js';

const INTERNAL_SESSION_PREFIXES = [
  'agent:',
  'background:',
  'console:workflow-architect',
  'cron:',
  'execution:',
];

const INTERNAL_CHANNELS = new Set([
  'agent',
  'background',
  'cron',
  'execution-controller',
]);

export function isInternalSessionId(sessionId?: string): boolean {
  return Boolean(sessionId && INTERNAL_SESSION_PREFIXES.some((prefix) => sessionId.startsWith(prefix)));
}

export function isInternalChannel(channel?: string): boolean {
  const normalized = channel?.toLowerCase();
  return Boolean(normalized && (INTERNAL_CHANNELS.has(normalized) || normalized.startsWith('execution:')));
}

export function looksLikeInternalPrompt(text?: string): boolean {
  return /^\s*(you are|cron job:|execute the following job prompt|autonomy mode:|task id:|workflow architect)/i.test(text ?? '');
}

export function isUserFacingSession(sessionId?: string, channel?: string): boolean {
  return !isInternalSessionId(sessionId) && !isInternalChannel(channel);
}

export function isUserFacingExecution(execution: Pick<ExecutionRecord, 'sessionId' | 'channel' | 'title' | 'objective'>): boolean {
  return isUserFacingSession(execution.sessionId, execution.channel) &&
    !looksLikeInternalPrompt(execution.title) &&
    !looksLikeInternalPrompt(execution.objective);
}
