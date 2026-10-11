import { createHash } from 'node:crypto';

export interface CompletedModelResponseBinding {
  readonly modelCallId: string;
  readonly physicalAttempt: number;
  readonly providerResponseIdDigest: string;
}

const completedResponses = new WeakMap<object, CompletedModelResponseBinding>();
const ambiguousResponses = new WeakSet<object>();

/** Exact SDK response identity only. Never recover identity from text or URLs. */
export function providerResponseDigest(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(value)) return undefined;
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Called at the provider boundary that owns this generated host call ID.
 * A clone, caller-supplied trace, or later source cannot inherit this proof. */
export function bindCompletedModelResponse(
  response: unknown, modelCallId: string, physicalAttempt: number,
): CompletedModelResponseBinding | undefined {
  try {
    if (!response || typeof response !== 'object' || Array.isArray(response)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(modelCallId)
      || !Number.isSafeInteger(physicalAttempt) || physicalAttempt <= 0) return undefined;
    if (ambiguousResponses.has(response)) return undefined;
    const fields = response as Record<string, unknown>;
    // Buffered responses use responseId; streamed response_done uses id. If both
    // are supplied, inconsistent identities cannot authorize attribution.
    if (fields.responseId !== undefined && fields.id !== undefined && fields.responseId !== fields.id) return undefined;
    const digest = providerResponseDigest(fields.responseId ?? fields.id);
    if (!digest) return undefined;
    const binding = Object.freeze({ modelCallId, physicalAttempt, providerResponseIdDigest: digest });
    const prior = completedResponses.get(response);
    if (prior && (prior.modelCallId !== modelCallId || prior.physicalAttempt !== physicalAttempt
      || prior.providerResponseIdDigest !== digest)) {
      // Reusing a mutable response across distinct requests is ambiguous, even
      // if its current ID happens to match. Never rebind the older response.
      completedResponses.delete(response);
      ambiguousResponses.add(response);
      return undefined;
    }
    completedResponses.set(response, binding);
    return binding;
  } catch { return undefined; /* observability never changes the response */ }
}

export function completedModelResponseBinding(response: unknown): CompletedModelResponseBinding | undefined {
  try {
    if (!response || typeof response !== 'object') return undefined;
    const binding = completedResponses.get(response);
    if (!binding) return undefined;
    const fields = response as Record<string, unknown>;
    if (fields.responseId !== undefined && fields.id !== undefined && fields.responseId !== fields.id) return undefined;
    return providerResponseDigest(fields.responseId ?? fields.id) === binding.providerResponseIdDigest ? binding : undefined;
  } catch { return undefined; }
}
