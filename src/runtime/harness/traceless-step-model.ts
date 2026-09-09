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

export function withTracelessStep(inner: Model): Model {
  return {
    async getResponse(request: ModelRequest): Promise<ModelResponse> {
      if (getCurrentTrace()) return inner.getResponse(request);
      const stream = inner.getStreamedResponse({ ...request, tracing: false });
      let done: Extract<StreamEvent, { type: 'response_done' }> | undefined;
      let finishReason: unknown;
      for await (const event of stream) {
        if (event.type === 'response_done') done = event;
        const metadata = event as { type?: string; event?: { type?: string; finishReason?: unknown } };
        if (metadata.type === 'model' && metadata.event?.type === 'finish') finishReason = metadata.event.finishReason;
      }
      if (!done) {
        throw new Error('model stream ended without a response_done event');
      }
      const usage = done.response.usage;
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
          ...(done.response as { providerData?: Record<string, unknown> }).providerData,
          ...(finishReason === undefined ? {} : { finishReason }),
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
