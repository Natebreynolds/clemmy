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

/** The request parameter a provider's structured error names, if any. */
function rejectedParam(detail: string | undefined): { param: string; message: string } | null {
  try {
    const body = JSON.parse(detail ?? '') as { error?: { param?: unknown; message?: unknown } };
    const param = body?.error?.param;
    return typeof param === 'string' && param.trim()
      ? { param: param.trim(), message: typeof body.error?.message === 'string' ? body.error.message : '' }
      : null;
  } catch {
    return null;
  }
}

/** The requested model when a provider's error response refuses it. An error
 *  that names a request parameter (an effort the model does not take, say) is
 *  about that parameter, not the model, even when it names the model too. */
export function refusedModelFromProviderResponse(
  status: number | undefined,
  detail: string | undefined,
  requestedModelId: string | undefined,
): string | undefined {
  const model = requestedModelId?.trim();
  if (!model || typeof status !== 'number' || !MODEL_REFUSAL_STATUSES.has(status)) return undefined;
  const param = rejectedParam(detail);
  if (param && param.param !== 'model') return undefined;
  return detail?.toLowerCase().includes(model.toLowerCase()) ? model : undefined;
}

/** The values a provider says it accepts for a parameter it refused
 *  (`error.param` names it; its message lists them quoted). Null otherwise. */
export function supportedValuesForRejectedParam(detail: string | undefined, param: string): string[] | null {
  const rejected = rejectedParam(detail);
  if (!rejected || rejected.param !== param) return null;
  const listed = rejected.message.split(/supported values? (?:are|is)\s*:?/i)[1];
  if (!listed) return null;
  const values = [...listed.matchAll(/'([^']+)'/g)].map((match) => match[1]!.trim()).filter(Boolean);
  return values.length > 0 ? values : null;
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
