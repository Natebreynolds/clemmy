import type { AssistantRouteDiagnostics } from '../../types.js';

export interface ResponseRouteEvent {
  seq: number;
  sessionId: string;
  role: string;
  type: string;
  data: Record<string, unknown>;
}

/** Project the latest primary route for this accepted source only. Judge and
 * worker routes, unscoped legacy rows, and adjacent turns are not its route. */
export function acceptedResponseRoute(
  planned: AssistantRouteDiagnostics,
  identity: { sessionId: string; sourceUserSeq: number },
  events: readonly ResponseRouteEvent[],
): AssistantRouteDiagnostics {
  if (!Number.isSafeInteger(identity.sourceUserSeq) || identity.sourceUserSeq < 1) return planned;
  const routed = events.filter(event => event.sessionId === identity.sessionId
    && event.seq > identity.sourceUserSeq && event.role === 'system'
    && event.type === 'turn_model_routed'
    && event.data.sourceUserSeq === identity.sourceUserSeq
    && (event.data.routeKind === 'harness' || event.data.routeKind === 'harness_fallover')
    && typeof event.data.model === 'string' && event.data.model.trim()
    && typeof event.data.provider === 'string' && event.data.provider.trim())
    .sort((a, b) => b.seq - a.seq)[0];
  if (!routed) return planned;
  const fallback = routed.data.routeKind === 'harness_fallover';
  return {
    ...planned,
    effectiveModel: (routed.data.model as string).trim(),
    provider: (routed.data.provider as string).trim(),
    ...(fallback && planned.effectiveModel ? { falloverFrom: planned.effectiveModel } : {}),
  };
}
