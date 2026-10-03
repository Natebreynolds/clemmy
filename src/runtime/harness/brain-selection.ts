/** Shared settings contract: a catalog choice must survive persistence and
 * resolution unchanged before either carrier can acknowledge the switch. */
import type { ModelProviderClass } from './model-wire-registry.js';

export const CODEX_BRAIN_SLOTS = [
  'OPENAI_MODEL_PRIMARY', 'OPENAI_MODEL_FAST', 'OPENAI_MODEL_DEEP', 'OPENAI_MODEL_WORKER',
] as const;
export type CodexBrainSlot = typeof CODEX_BRAIN_SLOTS[number];

export class BrainSelectionError extends Error {
  constructor(message: string, readonly code: string, readonly status = 409) {
    super(message);
    this.name = 'BrainSelectionError';
  }
}

/** The model catalog and wire registry own model eligibility. Never infer a
 * generation from its spelling: new subscription models need no picker patch. */
export function codexBrainSlotUpdates(
  modelId: string,
  current: Readonly<Record<CodexBrainSlot, string>>,
  providerOf: (modelId: string) => ModelProviderClass,
  fallbackModelId: string,
): Array<{ key: CodexBrainSlot; value: string }> {
  if (modelId && providerOf(modelId) !== 'codex') {
    throw new BrainSelectionError('That model is not a Codex brain.', 'INVALID_BRAIN_MODEL', 400);
  }
  return CODEX_BRAIN_SLOTS.flatMap((key) => {
    const previous = current[key];
    const polluted = previous !== '' && providerOf(previous) !== 'codex';
    const value = key === 'OPENAI_MODEL_PRIMARY' && modelId
      ? modelId : polluted ? fallbackModelId : previous;
    return value && value !== previous ? [{ key, value }] : [];
  });
}

export interface BrainSelectionReceipt {
  requestedValue: string;
  effectiveValue: string;
  modelId: string;
  provider: ModelProviderClass;
  scope: 'conversation' | 'new_conversations';
  sessionId?: string;
}

/** A global settings read is not evidence that a conversation was re-pinned.
 * Verify the scope as well as the model before saying "next message". */
export function brainSelectionReceipt(input: {
  requestedValue?: string;
  effectiveValue: string;
  brain: { modelId: string; provider: ModelProviderClass };
  sessionId?: string;
  sessionPin?: { modelId: string; provider: ModelProviderClass } | null;
}): BrainSelectionReceipt {
  const requestedValue = input.requestedValue || input.effectiveValue;
  const separator = requestedValue.indexOf(':');
  const matches = separator < 0
    ? input.effectiveValue === `${requestedValue}:${input.brain.modelId}`
    : requestedValue === input.effectiveValue
      && requestedValue.slice(separator + 1) === input.brain.modelId;
  if (!matches) {
    throw new BrainSelectionError(
      `Requested ${requestedValue}, but ${input.effectiveValue} is effective. The model switch was not confirmed.`,
      'BRAIN_SELECTION_MISMATCH',
    );
  }
  if (input.sessionId && (!input.sessionPin
    || input.sessionPin.modelId !== input.brain.modelId
    || input.sessionPin.provider !== input.brain.provider)) {
    throw new BrainSelectionError(
      'The model choice was saved, but this conversation\'s model switch was not confirmed.',
      'SESSION_BRAIN_SELECTION_MISMATCH',
    );
  }
  return {
    requestedValue,
    effectiveValue: input.effectiveValue,
    modelId: input.brain.modelId,
    provider: input.brain.provider,
    scope: input.sessionId ? 'conversation' : 'new_conversations',
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}
