/**
 * HOST STEP ADAPTER — a brain is an llm pipe, not a lane.
 *
 * The host turn loop (hostRunRunner / codexOneStep) and the judge/checker
 * seams call `model.getResponse` directly, with no Agents `Runner.run` and
 * therefore no ambient trace context. BOTH SDK leaf models —
 * `OpenAIChatCompletionsModel` (@openai/agents-openai, the BYO/Grok leaf) and
 * `AiSdkModel` (@openai/agents-extensions, the Claude leaf) — unconditionally
 * enter `withGenerationSpan → setCurrentSpan` in getResponse, which THROWS
 * "No existing trace found" outside a trace (live 2026-08-19: grok first
 * step, then the same crash through the Claude judge stack on step 2). Their
 * STREAMED paths guard the span on `request.tracing`, so a traceless host
 * step goes through `getStreamedResponse` with tracing:false — zero spans,
 * one provider request — and assembles the ModelResponse from
 * `response_done`. When a real trace context exists (a legacy Runner
 * caller), delegate unchanged. Production never wraps in withTrace to fake
 * one.
 */
import { Usage, getCurrentTrace } from '@openai/agents-core';
import type { Model, ModelRequest, ModelResponse, StreamEvent } from '@openai/agents-core';

function transportModelIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value) && !value.includes('://');
}

/** Read transport metadata only; never infer the served model from output text. */
export function providerReportedModel(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as { providerData?: { model?: unknown; providerReportedModel?: unknown; providerReportedModelUnqualified?: unknown };
    type?: string; response?: unknown; event?: { type?: string; modelId?: unknown } };
  if (row.type === 'response_done') return providerReportedModel(row.response);
  if (row.type === 'model' && row.event?.type === 'response-metadata') {
    const model = row.event.modelId;
    return transportModelIdentity(model) ? model : undefined;
  }
  if (row.providerData?.providerReportedModelUnqualified === true) return undefined;
  if (row.providerData?.model !== undefined && row.providerData.providerReportedModel !== undefined
    && row.providerData.model !== row.providerData.providerReportedModel) return undefined;
  const model = row.providerData?.model;
  return transportModelIdentity(model) ? model : undefined;
}

export function withTracelessStep(inner: Model): Model {
  return {
    async getResponse(request: ModelRequest): Promise<ModelResponse> {
      if (getCurrentTrace()) return inner.getResponse(request);
      const stream = inner.getStreamedResponse({ ...request, tracing: false });
      let done: Extract<StreamEvent, { type: 'response_done' }> | undefined;
      let finishReason: unknown;
      const servedModels = new Set<string>();
      let modelMetadataUnqualified = false;
      for await (const event of stream) {
        if (event.type === 'response_done') done = event;
        const model = providerReportedModel(event);
        if (model) servedModels.add(model);
        const wire = event as { type?: string; event?: { type?: string; modelId?: unknown } };
        if (wire.type === 'model' && wire.event?.type === 'response-metadata'
          && wire.event.modelId !== undefined && !model) modelMetadataUnqualified = true;
        const metadata = event as { type?: string; event?: { type?: string; finishReason?: unknown } };
        if (metadata.type === 'model' && metadata.event?.type === 'finish') finishReason = metadata.event.finishReason;
      }
      if (!done) {
        throw new Error('model stream ended without a response_done event');
      }
      const usage = done.response.usage;
      const existing = (done.response as { providerData?: Record<string, unknown> }).providerData;
      if (existing?.providerReportedModelUnqualified === true) modelMetadataUnqualified = true;
      for (const key of ['providerReportedModel', 'model']) {
        if (existing?.[key] === undefined) continue;
        if (transportModelIdentity(existing[key])) servedModels.add(existing[key]);
        else modelMetadataUnqualified = true;
      }
      modelMetadataUnqualified ||= servedModels.size > 1;
      const servedModel = !modelMetadataUnqualified && servedModels.size === 1 ? [...servedModels][0] : undefined;
      return {
        output: done.response.output,
        usage: new Usage({
          requests: 1,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          totalTokens: usage?.totalTokens ?? 0,
        }),
        responseId: done.response.id,
        providerData: {
          ...existing,
          ...(finishReason === undefined ? {} : { finishReason }),
          ...(servedModel ? { model: servedModel } : {}),
          ...(modelMetadataUnqualified ? { providerReportedModelUnqualified: true } : {}),
        },
      };
    },
    getStreamedResponse(request: ModelRequest) {
      return inner.getStreamedResponse(request);
    },
  };
}

/** Test seam kept under its historical name for the adapter pins. */
export const _withTracelessStepForTest = withTracelessStep;
