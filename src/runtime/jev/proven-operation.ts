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
import { listMatchingRunStrategies, listVerifiedRunStrategies, type MatchedRunStrategy, type RunStrategyRecord } from '../../memory/run-strategy-store.js';
import { readActiveToolSurface } from '../../memory/active-tool-surface.js';
import { selectLearnedStrategyTools } from '../harness/host-run-strategy-learning.js';
import { peekConnectedToolkits } from '../../integrations/composio/client.js';
import { composioSlugLooksWellFormed, registeredToolkitOfSlug } from '../../integrations/composio/toolkit-slug.js';
import { classifyComposioSlugEffect } from '../../integrations/composio/slug-effect.js';
import type { CapabilityResolutionEntry } from '../harness/capability-resolution.js';
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

function uniqueActiveConnection(toolkit: string): { connectionId: string } | null {
  try {
    const rows = peekConnectedToolkits().filter((row) => (
      row.slug.trim().toLowerCase() === toolkit.trim().toLowerCase()
      && /^active$/i.test(row.status.trim())
    ));
    if (rows.length !== 1) return null;
    const connectionId = rows[0]!.connectionId.trim();
    return connectionId ? { connectionId } : null;
  } catch {
    return null;
  }
}

export function buildCachedProvenResolutionEntries(slugs: readonly string[]): CapabilityResolutionEntry[] {
  const entries: CapabilityResolutionEntry[] = [];
  for (const slug of slugs) {
    const schema = schemaForTool(slug);
    if (!schema) continue;
    const toolkit = registeredToolkitOfSlug(slug);
    const connection = uniqueActiveConnection(toolkit);
    if (!connection) continue;
    const effect = classifyComposioSlugEffect(slug);
    entries.push({
      intent: 'cached proven operation for this request',
      kind: 'composio',
      identifier: slug,
      status: 'proven',
      connection: 'active',
      accountIdentity: connection.connectionId,
      effectClass: effect === 'external_write' ? 'write' : 'read',
      matchedTokens: [toolkit],
    });
  }
  return entries;
}

async function publishCachedProvenOperations(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedInput: string;
  slugs: readonly string[];
}): Promise<Array<{ slug: string; capabilityId: string; descriptor: HostCapabilityDescriptorV1 }>> {
  const { ensureToolSchema } = await import('../../tools/composio-schema-cache.js');
  for (const slug of input.slugs) {
    if (schemaForTool(slug)) continue;
    try { await ensureToolSchema(slug); } catch { /* cache miss stays fail-open */ }
  }
  const entries = buildCachedProvenResolutionEntries(input.slugs);
  if (entries.length === 0) return [];
  const { recordAdmissionCapabilityResolution } = await import('../harness/capability-resolution.js');
  const { registerProofProvisionedCapabilities } = await import('../harness/proof-provisioned-catalog.js');
  recordAdmissionCapabilityResolution({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedInput: input.acceptedInput,
    entries,
  });
  await registerProofProvisionedCapabilities({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
  });
  return publishedProvenOperations(input.slugs);
}

export interface ProvenBoundAccount {
  slug: string;
  accountId: string;
  label?: string;
}

/** The connected-account label the owner would recognise for a bound id. */
function boundAccountLabel(accountId: string): string | undefined {
  try {
    const row = peekConnectedToolkits().find((entry) => entry.connectionId === accountId);
    return row?.accountEmail || row?.accountLabel || row?.accountName || undefined;
  } catch {
    return undefined;
  }
}

function bindPublishedSkip(
  published: Array<{ slug: string; capabilityId: string; descriptor: HostCapabilityDescriptorV1; accountId?: string }>,
): {
  skipDiscoverySearch: boolean;
  capabilityRefs: string[];
  descriptors: HostCapabilityDescriptorV1[];
  invocations: unknown[];
  boundAccounts: ProvenBoundAccount[];
} {
  const capabilityRefs = published.map((row) => row.capabilityId);
  return {
    skipDiscoverySearch: capabilityRefs.length > 0,
    capabilityRefs,
    descriptors: published.map((row) => row.descriptor),
    boundAccounts: published.flatMap((row) => (row.accountId
      ? [{ slug: row.slug, accountId: row.accountId, ...(boundAccountLabel(row.accountId) ? { label: boundAccountLabel(row.accountId) } : {}) }]
      : [])),
    invocations: published.map((row) => renderCarrierInvocationExample(
      'work_call',
      {
        name: 'composio_execute_tool',
        fixedArgs: { tool_slug: row.slug },
        payloadField: 'arguments',
      },
      row.capabilityId,
    )),
  };
}

function publishedProvenOperations(slugs: readonly string[]): Array<{
  slug: string;
  capabilityId: string;
  descriptor: HostCapabilityDescriptorV1;
  accountId?: string;
}> {
  try {
    const catalog = peekHostCapabilityCatalogFactory();
    if (!catalog) return [];
    const published: Array<{
      slug: string;
      capabilityId: string;
      descriptor: HostCapabilityDescriptorV1;
      accountId?: string;
    }> = [];
    for (const slug of slugs) {
      const base = `cap:resolved:${slug.toLowerCase()}`;
      const entry = catalog.snapshot().find((row) => (
        (row.capabilityId === base || row.capabilityId.startsWith(`${base}:definition:`))
        && isCurrentCallableCatalogEntry(row)
        && row.manifest.operationId.toUpperCase() === slug
      ));
      if (!entry) continue;
      const accountId = (entry as { account?: unknown }).account ?? entry.manifest?.accountId;
      published.push({
        slug,
        capabilityId: entry.capabilityId,
        descriptor: descriptorFromCatalogEntry(entry),
        ...(typeof accountId === 'string' && accountId ? { accountId } : {}),
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
  boundAccounts: readonly ProvenBoundAccount[] = [],
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
      ? 'Call them directly on this turn. tool_search stays available if these operations cannot fulfill the whole request or a call is refused.'
      : 'Prefer these tools. Use tool_search once if their requirement_id is not already disclosed on work_call.',
    'Connected provider operations go through work_call: name composio_execute_tool, args_json a JSON string with tool_slug and arguments.',
    'Local operations use their exact callable name.',
    // Live 277962: the cap:… ref below was sent to tool_output_query as a
    // call_id. Say the one thing that prevents that at the source.
    'A cap:… reference is an OPERATION to invoke, not a result: results only exist after the call returns, under the call_id it returns.',
    ...(callable
      ? [
          'Exact work_call already disclosed and callable now:',
          ...invocations.map((invocation) => JSON.stringify(invocation)),
        ]
      : []),
    // Live 279653: with three Outlook accounts connected, the brain spent a
    // 31 s frame on tool_search account_selection for an operation whose
    // account the host had already routed. Say so, in the brain's own terms.
    ...(callable && boundAccounts.length > 0
      ? [
          'Operating account already bound by the host for these operations; no account_selection and no tool_search is needed to choose or confirm it:',
          ...boundAccounts.map((row) => `- ${row.slug}: ${row.label ? `${row.label} (${row.accountId})` : row.accountId}`),
        ]
      : []),
    ...schemaLines,
  ].join('\n');
}

function toolSignature(tools: readonly string[]): string {
  return selectLearnedStrategyTools(tools).map((name) => name.toLowerCase()).sort().join('\0');
}

/**
 * Bind a proven run without exact wording. One matching strategy is enough.
 * Several matches that used the same tools are the same job (today vs
 * tomorrow calendar). Jev is only needed when proven tools disagree.
 */
export function pickProvenRunStrategy(matches: readonly MatchedRunStrategy[]): RunStrategyRecord | null {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!.strategy;
  const signatures = new Set(matches.map((row) => toolSignature(row.strategy.toolsUsed)));
  if (signatures.size === 1) return matches[0]!.strategy;
  return null;
}

function stagedCandidatesForJev(): Array<{ id: string; objective: string; toolsUsed: string[]; record: RunStrategyRecord }> {
  const staged = readActiveToolSurface().tools.filter((row) => row.schemaReady).slice(0, 8);
  if (staged.length === 0) return [];
  const proven = listVerifiedRunStrategies();
  return staged.map((row) => {
    const record = proven.find((strategy) => (
      strategy.toolsUsed.some((name) => name.trim().toLowerCase() === row.name.toLowerCase())
    ));
    return {
      id: record?.id ?? `surface:${row.name}`,
      objective: record?.objective ?? row.name.replace(/_/g, ' '),
      toolsUsed: record?.toolsUsed ?? [row.name],
      record: record ?? {
        id: `surface:${row.name}`,
        objective: row.name.replace(/_/g, ' '),
        keywords: [],
        toolsUsed: [row.name],
        workerCount: 0,
        durationMs: 0,
        createdAt: new Date().toISOString(),
        uses: 0,
      },
    };
  });
}

async function pickStagedSurfaceStrategy(query: string, sessionId?: string): Promise<RunStrategyRecord | null> {
  const staged = stagedCandidatesForJev();
  if (staged.length === 0) return null;
  const jev = await selectProvenRunStrategyWithJev(
    query,
    staged.map((row) => ({ id: row.id, objective: row.objective, toolsUsed: row.toolsUsed })),
    { sessionId },
  );
  if (jev.strategy) {
    return staged.find((row) => row.id === jev.strategy!.id)?.record ?? null;
  }
  return null;
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
  void import('./active-surface-heartbeat.js')
    .then((mod) => mod.tickActiveToolSurfaceHeartbeat())
    .catch(() => { /* heartbeat never blocks the live turn */ });
  const matches = listMatchingRunStrategies(input.query, 4);
  const lexical = pickProvenRunStrategy(matches);
  let strategy = lexical;
  if (!strategy && matches.length > 0) {
    const jev = await selectProvenRunStrategyWithJev(
      input.query,
      matches.map((row) => ({
        id: row.strategy.id,
        objective: row.strategy.objective,
        toolsUsed: row.strategy.toolsUsed,
      })),
      { sessionId: input.sessionId },
    );
    strategy = (jev.strategy
      ? matches.find((row) => row.strategy.id === jev.strategy!.id)?.strategy
      : null)
      ?? (jev.failedOpen ? matches[0]!.strategy : null);
  }
  if (!strategy) {
    strategy = await pickStagedSurfaceStrategy(input.query, input.sessionId);
  }
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
  let boundAccounts: ProvenBoundAccount[] = [];
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
      const identity = {
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq as number,
        acceptedInput,
        slugs: composioSlugs,
      };
      let published = await publishCachedProvenOperations(identity);
      if (published.length === 0) {
        const { provisionExactWorkflowProviderOperations } = await import(
          '../../tools/tool-search-provider-sources.js'
        );
        const provisioned = await provisionExactWorkflowProviderOperations({
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          acceptedInput,
          operationIds: composioSlugs,
          deadlineAt: Date.now() + PROVEN_PROVISION_BUDGET_MS,
        });
        if (provisioned.ok) published = publishedProvenOperations(composioSlugs);
      }
      const bound = bindPublishedSkip(published);
      skipDiscoverySearch = bound.skipDiscoverySearch;
      capabilityRefs = bound.capabilityRefs;
      descriptors = bound.descriptors;
      invocations = bound.invocations;
      boundAccounts = bound.boundAccounts;
    } catch { /* proven provision is fail-open: keep tool_search */ }
  }

  return {
    text: renderProvenOperationGuidance(strategy, schemas, invocations, boundAccounts),
    strategyId: strategy.id,
    tools: strategy.toolsUsed,
    skipDiscoverySearch,
    capabilityRefs,
    descriptors,
  };
}
