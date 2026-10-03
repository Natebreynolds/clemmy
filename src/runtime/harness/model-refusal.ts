import { labelForModelId } from './model-discovery.js';

/**
 * A provider that will not run the requested model for this sign-in.
 *
 * The provider's own error says so by naming the model the request asked for
 * on a 400 or 404: the request reached the provider and the provider refused
 * the model itself. Another attempt on the same model cannot help, and neither
 * can a generic "try again"; the owner picks another model. The signal is the
 * provider's response naming our request, never the owner's text.
 */
export const MODEL_REFUSED_BLOCKED_REASON = 'model_refused_for_account';

const MODEL_REFUSAL_STATUSES = new Set([400, 404]);

/** The requested model when a provider's error response refuses it. */
export function refusedModelFromProviderResponse(
  status: number | undefined,
  detail: string | undefined,
  requestedModelId: string | undefined,
): string | undefined {
  const model = requestedModelId?.trim();
  if (!model || typeof status !== 'number' || !MODEL_REFUSAL_STATUSES.has(status)) return undefined;
  return detail?.toLowerCase().includes(model.toLowerCase()) ? model : undefined;
}

/** The refused model a thrown provider error carries, through its causes. */
export function refusedRequestedModel(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 4; depth += 1) {
    const id = (current as { refusedModelId?: unknown }).refusedModelId;
    if (typeof id === 'string' && id.trim()) return id.trim();
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** What the owner reads: the model by name, and the one thing that helps. */
export function refusedModelPublicText(modelId: string): string {
  return `${labelForModelId(modelId)} isn't available on this sign-in, so I couldn't answer. `
    + 'Pick another model on the model chip, or in Settings → Models, and send this again.';
}
