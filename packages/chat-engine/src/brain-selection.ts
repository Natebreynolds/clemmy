/** Validate an exact daemon selection receipt before displaying success.
 * It confirms configuration and conversation scope, not model execution. */
export interface SelectionBrain { modelId: string; provider: string; source: string }
export interface BrainSelectionResponse<T extends SelectionBrain = SelectionBrain> {
  ok: true;
  brain: T;
  effectiveValue: string;
  activeBrain: string;
  selection: {
    requestedValue: string;
    effectiveValue: string;
    modelId: string;
    provider: string;
    scope: 'conversation' | 'new_conversations';
    sessionId?: string;
  };
}

export function readBrainSelectionResponse<T extends SelectionBrain = SelectionBrain>(
  value: unknown, requestedValue: string, sessionId?: string,
): BrainSelectionResponse<T> {
  const response = value as Partial<BrainSelectionResponse<T>> | null;
  const selection = response?.selection;
  const separator = requestedValue.indexOf(':');
  const modelId = separator < 0 ? response?.brain?.modelId : requestedValue.slice(separator + 1);
  const effectiveValue = separator < 0 ? `${requestedValue}:${modelId}` : requestedValue;
  const expectedScope = sessionId ? 'conversation' : 'new_conversations';
  if (response?.ok !== true || !response.brain || !selection || !modelId
    || response.effectiveValue !== effectiveValue
    || response.brain.modelId !== modelId
    || !response.brain.provider || typeof response.brain.source !== 'string'
    || selection.requestedValue !== requestedValue
    || selection.effectiveValue !== effectiveValue
    || selection.modelId !== modelId
    || selection.provider !== response.brain.provider
    || selection.scope !== expectedScope
    || (selection.sessionId ?? undefined) !== (sessionId || undefined)
    || response.activeBrain !== requestedValue.split(':', 1)[0]) {
    const effective = typeof response?.effectiveValue === 'string' ? response.effectiveValue : 'unknown';
    throw new Error(`The model switch was not confirmed. Requested ${requestedValue}; effective ${effective}. Refresh the model picker and try again.`);
  }
  return response as BrainSelectionResponse<T>;
}
