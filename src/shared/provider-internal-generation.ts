/**
 * Provider-internal generation failure — the model runtime died while
 * sampling, not a model decision and not a client schema/auth error.
 *
 * Native SSE backends often finish HTTP 200 then throw this as a bare
 * message with no status (live 2026-08-28: xAI "Internal error during token
 * generation" after an admitted plan, persisted as a terminal run_failed).
 * Keep the classifier textual and side-effect free so chat, workflows, and
 * BYO/Claude resilience share one interpretation.
 */
import { providerCapacityErrorText } from './provider-capacity.js';

const PROVIDER_INTERNAL_GENERATION_RE =
  /internal error during token generation|the server had an error while processing your request|internal server error|engine (?:error|exception)|"type"\s*:\s*"server_error"/i;

export function isProviderInternalGenerationFailure(value: unknown): boolean {
  return PROVIDER_INTERNAL_GENERATION_RE.test(providerCapacityErrorText(value));
}
