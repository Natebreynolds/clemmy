import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';
import type { StreamEvent } from '@openai/agents-core/types';
import { getRuntimeEnv } from '../../config.js';
import { BoundaryError } from '../boundary-error.js';

/**
 * Dev-only DETERMINISTIC fault injection for live-testing chat brain fallover.
 *
 * `CLEMMY_FAULT_INJECT_BRAIN=<provider>` (codex | claude | byo) makes that brain's
 * model call YIELD one real chunk and then throw a transient overload. Yielding
 * first is deliberate: the in-stream FallbackModel only switches BEFORE the first
 * byte (yieldedAny), so a post-commit throw bubbles past it and exercises the
 * chat STEP-BOUNDARY fallover (W1a) specifically — not the pre-existing in-stream
 * layer. No-op unless the env names a provider, so it is inert in production.
 */
export function faultInjectTargetBrain(): string | null {
  const v = (getRuntimeEnv('CLEMMY_FAULT_INJECT_BRAIN', '') || '').trim().toLowerCase();
  return v || null;
}

export function maybeWrapWithFaultInjection(model: Model, provider: string): Model {
  const target = faultInjectTargetBrain();
  if (!target || target !== provider) return model;
  return new FaultInjectingModel(model);
}

function injectedTransientError(): BoundaryError {
  return BoundaryError.from(
    new Error('injected transient fault (CLEMMY_FAULT_INJECT_BRAIN — dev only)'),
    { kind: 'model.overloaded', retryable: true, userMessage: 'Injected transient fault for live fallover testing.' },
  );
}

class FaultInjectingModel implements Model {
  constructor(private readonly inner: Model) {}

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    throw injectedTransientError();
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const it = this.inner.getStreamedResponse(request)[Symbol.asyncIterator]();
    const first = await it.next();
    // Commit one real event so the in-stream FallbackModel can't swallow the
    // failure (yieldedAny → no pre-content switch), then throw post-commit.
    if (!first.done) yield first.value;
    throw injectedTransientError();
  }
}
