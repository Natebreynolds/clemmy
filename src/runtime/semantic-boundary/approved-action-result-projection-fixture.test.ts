/** Controlled original SDK response through the real local transport observer.
 * No network/provider/model or executor request. Import from tests only. */
import { randomUUID } from 'node:crypto';
import { bindCompletedModelResponse } from '../harness/model-response-binding.js';
import { createModelTransportAttempt, observeCompletedTransportModelResponse, finishModelTransportAttempt,
  withModelTransportAttempt, observeModelTransportFetch } from '../harness/model-transport-observation.js';

export async function controlledApprovedProjectionSdkResult(raw: { message: string; choices: string[] | null },
  options: { outcome?: 'returned' | 'cancelled' | 'failed'; clone?: boolean; final?: unknown } = {}) {
  const id = randomUUID(); const scope = createModelTransportAttempt(id, 1);
  const response = { responseId: `controlled-${id}`, output: [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: JSON.stringify(raw) }] }],
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } };
  await withModelTransportAttempt(scope, () => observeModelTransportFetch('typesafe_systemone', 'controlled-projection-model',
    async () => ({ status: 200, ok: true })));
  bindCompletedModelResponse(response, id, 1);
  observeCompletedTransportModelResponse(scope, response);
  finishModelTransportAttempt(scope, options.outcome ?? 'returned');
  return { finalOutput: options.final ?? raw, rawResponses: [options.clone ? structuredClone(response) : response] };
}
