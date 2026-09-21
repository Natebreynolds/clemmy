/**
 * Select a proven past run before the first model step so the brain can skip
 * tool_search. Fail-open: no match, low confidence, missing schema, or a
 * provision miss leaves discovery unchanged.
 */
import { listEvents } from '../harness/eventlog.js';
import {
  isCurrentCallableCatalogEntry,
  peekHostCapabilityCatalogFactory,
} from '../harness/host-capability-catalog-factory.js';
import { listMatchingRunStrategies, type RunStrategyRecord } from '../../memory/run-strategy-store.js';
import { composioSlugLooksWellFormed } from '../../integrations/composio/toolkit-slug.js';
import type { HostCapabilityDescriptorV1 } from '../semantic-boundary/turn-semantic-proposal.js';
import { getCachedToolSchema } from '../../tools/composio-schema-cache.js';
import { TOOL_REGISTRY } from '../../tools/tool-registry.js';
import { renderCarrierInvocationExample } from '../../tools/tool-search-tool.js';
import { selectProvenRunStrategyWithJev } from './control-plane.js';

/** Bound so a slow provider refresh cannot stall the first model step. */
const PROVEN_PROVISION_BUDGET_MS = 10_000;

export interface ProvenOperationPreparation {
  text?: string;
  strategyId?: string;
  tools: string[];
  skipDiscoverySearch: boolean;
  capabilityRefs: string[];
  descriptors: HostCapabilityDescriptorV1[];
}

function recordedProvenDescriptors(
  descriptors: readonly HostCapabilityDescriptorV1[],
): HostCapabilityDescriptorV1[] {
  return descriptors.filter((entry) => Boolean(entry?.id));
}

function descriptorIsCurrentlyCallable(descriptor: HostCapabilityDescriptorV1): boolean {
  try {
    const catalog = peekHostCapabilityCatalogFactory();
    if (!catalog) return false;
    const entry = catalog.get(descriptor.id);
    return Boolean(entry && isCurrentCallableCatalogEntry(entry));
  } catch {
    return false;
  }
}

/**
 * skipDiscoverySearch is only legal while a disclosed proven ref is callable
 * on this process. A recorded skip from an interrupted/recovered source must
 * not withhold tool_search after the catalog drops that invoke, and a missing
 * catalog fails open (search stays).
 */
export function resolveCallableProvenDiscoverySkip(input: {
  skipDiscoverySearch: boolean;
  descriptors: readonly HostCapabilityDescriptorV1[];
}): { skipDiscoverySearch: boolean; descriptors: HostCapabilityDescriptorV1[] } {
  const recorded = recordedProvenDescriptors(input.descriptors);
  if (!input.skipDiscoverySearch) {
    return { skipDiscoverySearch: false, descriptors: recorded };
  }
  try {
    const catalog = peekHostCapabilityCatalogFactory();
    if (!catalog) {
      return { skipDiscoverySearch: false, descriptors: recorded };
    }
    const callable = recorded.filter(descriptorIsCurrentlyCallable);
    return {
      skipDiscoverySearch: callable.length > 0,
      descriptors: callable,
    };
  } catch {
    return { skipDiscoverySearch: false, descriptors: recorded };
  }
}

function schemaForTool(name: string): unknown {
  const slug = name.trim();
  if (!slug) return null;
  try {
    const cached = getCachedToolSchema(slug) ?? getCachedToolSchema(slug.toUpperCase());
    if (cached) return cached;
  } catch { /* cache miss is fine */ }
  try {
    const local = TOOL_REGISTRY.find((entry) => entry.name === slug || entry.name === slug.toLowerCase());
    if (local?.description) return { name: local.name, description: local.description };
  } catch { /* registry miss is fine */ }
  return null;
}

function acceptedTextForSource(sessionId: string, sourceUserSeq: number): string | undefined {
  try {
    const accepted = listEvents(sessionId, {
      sinceSeq: sourceUserSeq - 1,
      types: ['user_input_received'],
      limit: 1,
    }).find((event) => event.seq === sourceUserSeq);
    const display = typeof accepted?.data.displayText === 'string' ? accepted.data.displayText : '';
    if (display.trim()) return display;
    return typeof accepted?.data.text === 'string' ? accepted.data.text : undefined;
  } catch {
    return undefined;
  }
}

function composioSlugsFromStrategy(toolsUsed: readonly string[]): string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();
  for (const name of toolsUsed) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const local = TOOL_REGISTRY.find((entry) => entry.name === trimmed || entry.name === trimmed.toLowerCase());
    if (local) continue;
    const slug = trimmed.toUpperCase();
    if (!composioSlugLooksWellFormed(slug) || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
}

function descriptorFromCatalogEntry(entry: {
  capabilityId: string;
  effect: HostCapabilityDescriptorV1['effect'] | string;
  account?: string;
  manifestDigest?: string;
  manifest?: {
    purpose: string;
    accountId: string;
    outputContract?: { kind?: string };
    acceptedInputKinds?: readonly string[];
    producedOutputKinds?: readonly string[];
    applicableDeliverableKinds?: readonly string[];
  };
}): HostCapabilityDescriptorV1 {
  const effect: HostCapabilityDescriptorV1['effect'] = (
    entry.effect === 'external_write'
    || entry.effect === 'local_write'
    || entry.effect === 'admin'
    || entry.effect === 'read'
    || entry.effect === 'compute'
    || entry.effect === 'host_only'
    || entry.effect === 'unknown'
    || entry.effect === 'none'
  ) ? entry.effect : 'read';
  const kind = entry.manifest?.outputContract?.kind ?? 'evidence';
  return {
    id: entry.capabilityId,
    effect,
    purpose: entry.manifest?.purpose ?? entry.capabilityId,
    acceptedInputKinds: [...(entry.manifest?.acceptedInputKinds ?? ['evidence'])],
    producedOutputKinds: [...(entry.manifest?.producedOutputKinds ?? ['evidence'])],
    applicableDeliverableKinds: [...(entry.manifest?.applicableDeliverableKinds ?? [kind])],
    inputShape: 'evidence',
    outputShape: kind,
    outputKind: kind,
    deliverableKind: kind,
    destinationPosture: null,
    evidenceKinds: ['tool_result'],
    handleRequired: false,
    readbackRequired: effect === 'external_write',
    accountScope: entry.account ?? entry.manifest?.accountId ?? 'runtime',
    manifestDigest: entry.manifestDigest ?? entry.capabilityId,
  };
}

function publishedProvenOperations(slugs: readonly string[]): Array<{
  slug: string;
  capabilityId: string;
  descriptor: HostCapabilityDescriptorV1;
}> {
  try {
    const catalog = peekHostCapabilityCatalogFactory();
    if (!catalog) return [];
    const published: Array<{
      slug: string;
      capabilityId: string;
      descriptor: HostCapabilityDescriptorV1;
    }> = [];
    for (const slug of slugs) {
      const base = `cap:resolved:${slug.toLowerCase()}`;
      const entry = catalog.snapshot().find((row) => (
        (row.capabilityId === base || row.capabilityId.startsWith(`${base}:definition:`))
        && isCurrentCallableCatalogEntry(row)
        && row.manifest.operationId.toUpperCase() === slug
      ));
      if (!entry) continue;
      published.push({
        slug,
        capabilityId: entry.capabilityId,
        descriptor: descriptorFromCatalogEntry(entry),
      });
    }
    return published;
  } catch {
    return [];
  }
}

export function renderProvenOperationGuidance(
  strategy: RunStrategyRecord,
  schemas: Record<string, unknown>,
  invocations: readonly unknown[] = [],
): string {
  const tools = strategy.toolsUsed;
  const schemaLines = tools.map((name) => {
    const schema = schemas[name] ?? schemas[name.toUpperCase()];
    if (!schema) return `- ${name}`;
    const body = JSON.stringify(schema);
    const clipped = body.length > 1_800 ? `${body.slice(0, 1_800)}…` : body;
    return `- ${name} schema: ${clipped}`;
  });
  const callable = invocations.length > 0;
  return [
    callable
      ? '[PROVEN OPERATION — skip tool_search]'
      : '[PROVEN OPERATION]',
    `A prior successful run ("${strategy.objective}") already proved these tools: ${tools.join(', ')}.`,
    callable
      ? 'Call them directly on this turn. Do not call tool_search unless these operations cannot fulfill the request.'
      : 'Prefer these tools. Use tool_search once if their requirement_id is not already disclosed on work_call.',
    'Connected provider operations go through work_call: name composio_execute_tool, args_json a JSON string with tool_slug and arguments.',
    'Local operations use their exact callable name.',
    ...(callable
      ? [
          'Exact work_call already disclosed and callable now:',
          ...invocations.map((invocation) => JSON.stringify(invocation)),
        ]
      : []),
    ...schemaLines,
  ].join('\n');
}

export async function prepareProvenOperationForRequest(input: {
  query: string;
  sessionId?: string;
  sourceUserSeq?: number;
  acceptedInput?: string;
}): Promise<ProvenOperationPreparation> {
  const empty: ProvenOperationPreparation = {
    tools: [],
    skipDiscoverySearch: false,
    capabilityRefs: [],
    descriptors: [],
  };
  const matches = listMatchingRunStrategies(input.query, 4);
  if (matches.length === 0) return empty;
  const exact = matches.length === 1 && matches[0]!.score >= 0.8
    ? matches[0]!.strategy
    : null;
  const selected = exact ?? await selectProvenRunStrategyWithJev(
    input.query,
    matches.map((row) => ({
      id: row.strategy.id,
      objective: row.strategy.objective,
      toolsUsed: row.strategy.toolsUsed,
    })),
    { sessionId: input.sessionId },
  );
  if (!selected) return empty;
  const strategy = exact ?? matches.find((row) => row.strategy.id === selected.id)?.strategy;
  if (!strategy) return empty;
  const schemas: Record<string, unknown> = {};
  for (const name of strategy.toolsUsed) {
    const schema = schemaForTool(name);
    if (schema) schemas[name] = schema;
  }

  let skipDiscoverySearch = false;
  let capabilityRefs: string[] = [];
  let descriptors: HostCapabilityDescriptorV1[] = [];
  let invocations: unknown[] = [];
  const composioSlugs = composioSlugsFromStrategy(strategy.toolsUsed);
  if (
    composioSlugs.length > 0
    && input.sessionId
    && Number.isSafeInteger(input.sourceUserSeq)
    && (input.sourceUserSeq ?? 0) > 0
  ) {
    try {
      const acceptedInput = input.acceptedInput?.trim()
        || acceptedTextForSource(input.sessionId, input.sourceUserSeq as number)
        || input.query;
      const { provisionExactWorkflowProviderOperations } = await import(
        '../../tools/tool-search-provider-sources.js'
      );
      const provisioned = await provisionExactWorkflowProviderOperations({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq as number,
        acceptedInput,
        operationIds: composioSlugs,
        deadlineAt: Date.now() + PROVEN_PROVISION_BUDGET_MS,
      });
      if (provisioned.ok) {
        const published = publishedProvenOperations(composioSlugs);
        capabilityRefs = published.map((row) => row.capabilityId);
        descriptors = published.map((row) => row.descriptor);
        invocations = published.map((row) => renderCarrierInvocationExample(
          'work_call',
          {
            name: 'composio_execute_tool',
            fixedArgs: { tool_slug: row.slug },
            payloadField: 'arguments',
          },
          row.capabilityId,
        ));
        skipDiscoverySearch = capabilityRefs.length > 0;
      }
    } catch { /* proven provision is fail-open: keep tool_search */ }
  }

  return {
    text: renderProvenOperationGuidance(strategy, schemas, invocations),
    strategyId: strategy.id,
    tools: strategy.toolsUsed,
    skipDiscoverySearch,
    capabilityRefs,
    descriptors,
  };
}
