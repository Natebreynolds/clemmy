import type { AssistantResponse, AssistantRouteDiagnostics } from '../../types.js';
import { resolveEffectiveProviderForModel } from './byo-providers.js';

function clean(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function providerFor(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  try { return resolveEffectiveProviderForModel(modelId); } catch { return undefined; }
}

function rawRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeRouteDiagnostics(route: AssistantRouteDiagnostics | undefined): AssistantRouteDiagnostics | undefined {
  if (!route) return undefined;
  const effectiveModel = clean(route.effectiveModel);
  const requestedModel = clean(route.requestedModel);
  const provider = clean(route.provider) ?? providerFor(effectiveModel);
  return {
    routeKind: route.routeKind,
    ...(clean(route.surface) ? { surface: clean(route.surface) } : {}),
    ...(requestedModel ? { requestedModel } : {}),
    ...(effectiveModel ? { effectiveModel } : {}),
    ...(provider ? { provider } : {}),
    ...(clean(route.transport) ? { transport: clean(route.transport) } : {}),
    ...(clean(route.mode) ? { mode: clean(route.mode) } : {}),
    ...(clean(route.falloverFrom) ? { falloverFrom: clean(route.falloverFrom) } : {}),
  };
}

export function withRouteDiagnostics(
  response: AssistantResponse,
  route: AssistantRouteDiagnostics,
): AssistantResponse {
  const normalized = normalizeRouteDiagnostics(route);
  return normalized ? { ...response, route: normalized } : response;
}

export function routeDiagnosticsFromResponse(response: Pick<AssistantResponse, 'route' | 'raw'>): AssistantRouteDiagnostics | undefined {
  if (response.route) return normalizeRouteDiagnostics(response.route);
  const raw = rawRecord(response.raw);
  if (!raw) return undefined;
  const transport = clean(raw.transport);
  if (transport === 'claude_agent_sdk_brain') {
    const effectiveModel = clean(raw.model);
    return normalizeRouteDiagnostics({
      routeKind: 'claude_agent_sdk_brain',
      effectiveModel,
      provider: 'claude',
      transport,
      mode: clean(raw.mode),
    });
  }
  return undefined;
}
