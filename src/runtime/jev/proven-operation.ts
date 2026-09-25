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
import { listMatchingRunStrategies, listVerifiedRunStrategies, runStrategyScopeForSession, strategyKeywords, type MatchedRunStrategy, type RunStrategyRecord } from '../../memory/run-strategy-store.js';
import { selectLearnedStrategyTools } from '../harness/host-run-strategy-learning.js';
import { peekConnectedToolkits } from '../../integrations/composio/client.js';
import { composioSlugLooksWellFormed, registeredToolkitOfSlug } from '../../integrations/composio/toolkit-slug.js';
import { classifyComposioSlugEffect } from '../../integrations/composio/slug-effect.js';
import type { CapabilityResolutionEntry } from '../harness/capability-resolution.js';
import type { McpToolScope } from '../mcp-tool-scope.js';
import { canonicalMcpToolIdentity } from '../mcp-tool-authority.js';
import type { HostCapabilityDescriptorV1 } from '../semantic-boundary/turn-semantic-proposal.js';
import { getCachedToolSchema } from '../../tools/composio-schema-cache.js';
import { TOOL_REGISTRY, isRegistryDeclaredRead } from '../../tools/tool-registry.js';
import { renderCarrierInvocationExample } from '../../tools/tool-search-tool.js';
import { routeOperationWithJev, selectProvenRunStrategyWithJev } from './control-plane.js';
import { DISCOVERY_SIBLING_DOORS, TOOL_SEARCH_ALWAYS_LOADED, rankCatalogEntriesLexically } from '../../agents/tool-catalog.js';
import { NATIVE_PRODUCT_AUTHORING_TOOLS } from '../../tools/native-product-surface.js';

/** Bound so a slow provider refresh cannot stall the first model step. */
const PROVEN_PROVISION_BUDGET_MS = 10_000;
/** The most a request's first model frame waits on Jev strategy picks, in
 *  total. Live answers at the turn start: half by 0.8 s, 83% by 1.5 s. Over
 *  three days most of these picks found nothing to reuse, and the wait they
 *  added outweighed the model rounds the hits saved. */
export const PROVEN_PICK_BUDGET_MS = 1_500;
/** With no proven run to reuse, Jev may route the request to one operation
 *  the host can hand over before the first frame. Long enough for most live
 *  answers, inside the shared budget. */
export const OPERATION_ROUTE_WAIT_MS = 1_000;
/** One request's candidates: every operation a named family holds, as a rule. */
const OPERATION_ROUTE_CANDIDATES = 10;
/** Below this there is no time for a real answer, so the pick is skipped. */
const MIN_JEV_PICK_WAIT_MS = 250;

export interface ProvenLiveRead {
  operation: string;
  kind: 'mcp' | 'cli';
  accountId: string;
  /** A generic operation (not a declared read) materialized exactly; every
   * call still has its effect decided at the invocation gate. */
  generic?: boolean;
}

/** Why each proven live read was or was not warmed; recorded on the
 * selection event so a familiar question that still rediscovers can be read
 * from the log instead of guessed at. */
export interface ProvenLiveReadOutcome {
  operation: string;
  status: 'installed' | 'skipped' | 'failed';
  reason?: string;
  elapsedMs: number;
}

export interface ProvenOperationPreparation {
  text?: string;
  strategyId?: string;
  tools: string[];
  nativeTools: string[];
  skipDiscoverySearch: boolean;
  capabilityRefs: string[];
  descriptors: HostCapabilityDescriptorV1[];
  /** Operating accounts the host already bound for the published operations. */
  boundAccounts: ProvenBoundAccount[];
  /** Native MCP / reviewed CLI reads the host re-attested and recorded as
   * this source's proven resolution before the first frame; callable by name. */
  liveReads: ProvenLiveRead[];
  liveReadOutcomes: ProvenLiveReadOutcome[];
}

export interface ProvenOperationDependencies {
  acquireLiveRead?: typeof import('../../tools/tool-search-provider-sources.js').acquireProvenLiveReadForSource;
  /** Test seams for the bounded turn-start picks. */
  selectStrategy?: typeof selectProvenRunStrategyWithJev;
  routeOperation?: typeof routeOperationWithJev;
  now?: () => number;
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
  // Local schemas come from configured runtime tools on the model surface.
  // A registry description is not an input schema.
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
    // A native MCP operation is server__operation. When the server shares its
    // name with a connected Composio toolkit (live 2026-09-24:
    // a docs search on a server whose name is also a connected toolkit) the uppercased id
    // also passes the slug shape test and was provisioned as a Composio
    // action that does not exist, so the read it named was never warmed.
    if (canonicalMcpToolIdentity(trimmed)) continue;
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
  liveReads: readonly ProvenLiveRead[] = [],
  opts: { routed?: boolean } = {},
): string {
  const tools = strategy.toolsUsed;
  if (opts.routed === true && tools.every(isHandoverRegistryTool)) {
    // The orchestrator loads a handed-over registry tool with its own schema,
    // unless this turn's mode keeps it off the surface; then search stays the door.
    return [
      '[ROUTED OPERATION]',
      `This request most likely needs ${tools.join(', ')}: ${strategy.objective}`,
      `When your tools list ${tools.join(', ')}, call it directly. Use tool_search only if it is not listed or cannot do the whole request.`,
    ].join('\n');
  }
  const schemaLines = tools.map((name) => {
    const schema = schemas[name] ?? schemas[name.toUpperCase()];
    if (!schema) return `- ${name}`;
    const body = JSON.stringify(schema);
    const clipped = body.length > 1_800 ? `${body.slice(0, 1_800)}…` : body;
    return `- ${name} schema: ${clipped}`;
  });
  const callable = invocations.length > 0;
  return [
    opts.routed
      ? (callable ? '[ROUTED OPERATION — skip tool_search]' : '[ROUTED OPERATION]')
      : (callable ? '[PROVEN OPERATION — skip tool_search]' : '[PROVEN OPERATION]'),
    opts.routed
      ? `This request most likely needs ${tools.join(', ')}: ${strategy.objective}`
      : `A prior successful run ("${strategy.objective}") already proved these tools: ${tools.join(', ')}.`,
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
    ...((strategy.provenShapes?.length ?? 0) > 0
      ? [
          'Request shapes that succeeded in the proven run (values elided; method and path literal). Reuse the same field names:',
          ...strategy.provenShapes!.map((row) => `- ${row.tool}: ${row.shape}`),
        ]
      : []),
    ...(liveReads.length > 0
      ? [
          'Native reads the host already re-attested for this request; call each by its exact name now (no tool_search is needed to find or disclose it):',
          ...liveReads.map((row) => `- ${row.operation} (${row.kind === 'mcp' ? 'connected MCP server' : 'reviewed CLI read'}, account ${row.accountId}${row.generic ? '; generic operation, effect decided per call' : ''})`),
        ]
      : []),
    ...(callable && boundAccounts.length > 0
      ? [
          'Operating account already bound by the host for these operations; no account_selection and no tool_search is needed to choose or confirm it:',
          ...boundAccounts.map((row) => `- ${row.slug}: ${row.label ? `${row.label} (${row.accountId})` : row.accountId}`),
        ]
      : []),
    // The moment the brain holds exact operation ids is the moment it can
    // author them: a saved workflow step for one of these is an exact `call`,
    // never a prompt step that re-describes the read.
    ...(() => {
      // Only real operations are authorable: the ones the host bound an
      // account for, else the ones it holds a schema for. A control tool
      // that only exists inside a step session is never a call step.
      const authorable = boundAccounts.length > 0
        ? [...new Set(boundAccounts.map((row) => row.slug))]
        : tools.filter((name) => schemas[name] !== undefined || schemas[name.toUpperCase()] !== undefined);
      return authorable.length > 0
        ? [`If this becomes a saved workflow, author these as exact call steps: call.tool = the operation id (${authorable.join(', ')}), literal args with time tokens ({{now}}, {{now+24h}}, {{date}}); the host binds the account.`]
        : [];
    })(),
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
export const PROVEN_SKIP_MIN_OVERLAP = 0.5;

/** Does the strategy cover the request, not merely touch it? The store's
 *  recall score is containment of the SHORTER keyword list, so a two-word
 *  strategy matches any longer request that mentions one of its words, and
 *  a three-word strategy matches a four-word request about something else
 *  that shares two of them. The skip (a thinned surface with no search) needs
 *  the two keyword sets to mostly coincide: shared words over all words of
 *  either side, at least half. */
export function provenStrategyCoversRequest(query: string, strategy: Pick<RunStrategyRecord, 'keywords'>): boolean {
  const words = new Set(strategyKeywords(query));
  const known = new Set(strategy.keywords);
  if (words.size === 0 || known.size === 0) return words.size === known.size;
  let shared = 0;
  for (const word of words) if (known.has(word)) shared += 1;
  const union = words.size + known.size - shared;
  return shared / union >= PROVEN_SKIP_MIN_OVERLAP;
}

export function pickProvenRunStrategy(matches: readonly MatchedRunStrategy[]): RunStrategyRecord | null {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!.strategy;
  const signatures = new Set(matches.map((row) => toolSignature(row.strategy.toolsUsed)));
  if (signatures.size === 1) return matches[0]!.strategy;
  return null;
}

/** A registry tool the orchestrator may load before the first frame. Only
 *  these can be handed over by name; the rest stay behind tool_search. */
function isHandoverRegistryTool(name: string): boolean {
  return TOOL_REGISTRY.some((row) => row.name === name
    && (row.localPlanning !== undefined || row.localPlanningRead === true));
}

/** Words of an operation name or a request, lowercased, with a plural `s`
 *  folded so "workflows" names the workflow tools. */
function nameWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1)
    .map((word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word));
}

/** The operations this request most plausibly needs, from what the host can
 *  hand over before the first frame: registry tools the orchestrator can load,
 *  and provider operations already proven in a successful run. An operation is
 *  offered only when the request names a distinctive word of its name (one
 *  most names do not share), then ranked by the same lexical relevance
 *  tool_search uses. A request that names none of them asks Jev nothing. */
export function routableOperationsForRequest(
  query: string,
  scope: 'chat' | 'any',
): Array<{ id: string; purpose: string }> {
  const rows = new Map<string, { name: string; oneLiner: string }>();
  for (const row of TOOL_REGISTRY) {
    if (!isHandoverRegistryTool(row.name)) continue;
    if (TOOL_SEARCH_ALWAYS_LOADED.has(row.name) || DISCOVERY_SIBLING_DOORS.has(row.name)) continue;
    // On an action turn the orchestrator keeps a handed-over registry tool
    // first-class only if it is a read or a product authoring tool; any other
    // write would reach the brain without its schema, so it is not offered.
    if (!isRegistryDeclaredRead(row.name) && !NATIVE_PRODUCT_AUTHORING_TOOLS.has(row.name)) continue;
    rows.set(row.name.toLowerCase(), { name: row.name, oneLiner: (row.description ?? '').trim() });
  }
  for (const strategy of listVerifiedRunStrategies()) {
    if (scope !== 'any' && (strategy.scope ?? 'chat') !== 'chat') continue;
    for (const raw of selectLearnedStrategyTools(strategy.toolsUsed)) {
      const name = raw.trim();
      const key = name.toLowerCase();
      if (!name || rows.has(key) || TOOL_REGISTRY.some((row) => row.name.toLowerCase() === key)) continue;
      rows.set(key, { name, oneLiner: strategy.objective });
    }
  }
  const requested = new Set(nameWords(query));
  const shared = new Map<string, number>();
  for (const row of rows.values()) {
    for (const word of new Set(nameWords(row.name))) shared.set(word, (shared.get(word) ?? 0) + 1);
  }
  const distinctive = (word: string): boolean => (shared.get(word) ?? 0) <= rows.size / 2;
  const named = [...rows.values()].filter((row) => nameWords(row.name)
    .some((word) => distinctive(word) && requested.has(word)));
  return rankCatalogEntriesLexically(query, named)
    .slice(0, OPERATION_ROUTE_CANDIDATES)
    .map((row) => ({ id: row.name, purpose: row.oneLiner.replace(/\s+/g, ' ').slice(0, 200) }));
}

export async function prepareProvenOperationForRequest(input: {
  query: string;
  sessionId?: string;
  sourceUserSeq?: number;
  acceptedInput?: string;
  /** The request's MCP scope; a proven native read outside it is not warmed. */
  mcpToolScope?: McpToolScope | null;
}, dependencies: ProvenOperationDependencies = {}): Promise<ProvenOperationPreparation> {
  const empty: ProvenOperationPreparation = {
    tools: [],
    nativeTools: [],
    skipDiscoverySearch: false,
    capabilityRefs: [],
    descriptors: [],
    boundAccounts: [],
    liveReads: [],
    liveReadOutcomes: [],
  };
  void import('./active-surface-heartbeat.js')
    .then((mod) => mod.tickActiveToolSurfaceHeartbeat())
    .catch(() => { /* heartbeat never blocks the live turn */ });
  // A chat request is offered chat strategies only; a workflow step may reuse
  // anything it or a chat proved.
  const strategyScope = runStrategyScopeForSession(input.sessionId) === 'workflow_step' ? 'any' as const : 'chat' as const;
  const matches = listMatchingRunStrategies(input.query, 4, { scope: strategyScope });
  // A remembered run is taken on keywords alone only when it covers the
  // request. One that merely shares words with it goes through Jev's check
  // below like any other ambiguous match: live 300948, "Show me the Daily
  // Brief space" matched a run that BUILT that space, whose calendar and mail
  // tools were then recommended while routing to the space tools never ran.
  const lexical = pickProvenRunStrategy(matches);
  let strategy = lexical && provenStrategyCoversRequest(input.query, lexical) ? lexical : null;
  // Every Jev pick here holds the request's first model frame, so together
  // they get one bounded wait. A pick that is late is not used.
  const jevDeadlineAt = (dependencies.now ?? Date.now)() + PROVEN_PICK_BUDGET_MS;
  const jevTimeLeft = (): number => jevDeadlineAt - (dependencies.now ?? Date.now)();
  if (!strategy && matches.length > 0) {
    const jev = await (dependencies.selectStrategy ?? selectProvenRunStrategyWithJev)(
      input.query,
      matches.map((row) => ({
        id: row.strategy.id,
        objective: row.strategy.objective,
        toolsUsed: row.strategy.toolsUsed,
      })),
      { sessionId: input.sessionId, timeoutMs: jevTimeLeft() },
    );
    strategy = (jev.strategy
      ? matches.find((row) => row.strategy.id === jev.strategy!.id)?.strategy
      : null)
      ?? (jev.failedOpen ? matches[0]!.strategy : null);
  }
  // No proven run: Jev may route the request to the one operation it needs
  // first, so the brain calls it instead of paying a discovery round. A pick
  // stands only when Jev is sure of it and of its fit; it is advisory until
  // the host hands the operation over below.
  let routed = false;
  const routeWaitMs = Math.min(OPERATION_ROUTE_WAIT_MS, jevTimeLeft());
  if (!strategy && routeWaitMs >= MIN_JEV_PICK_WAIT_MS) {
    const candidates = routableOperationsForRequest(input.query, strategyScope);
    if (candidates.length > 0) {
      const route = await (dependencies.routeOperation ?? routeOperationWithJev)(input.query, candidates, {
        timeoutMs: routeWaitMs,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      });
      if (route.pick) {
        routed = true;
        strategy = {
          id: `route:${route.pick.id}`,
          objective: route.pick.purpose,
          keywords: [],
          toolsUsed: [route.pick.id],
          workerCount: 0,
          durationMs: 0,
          createdAt: new Date().toISOString(),
          uses: 0,
        };
      }
    }
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
  // A strategy that does not cover the request must not spend the request's
  // time provisioning its operations. Live 2026-09-24 (source 299433): "I just
  // connected monday.com, check that" matched a calendar strategy and spent
  // 19 s publishing Outlook operations before the brain's first frame.
  // A routed pick was judged to do the core of this request; a remembered run
  // must cover it by its own keywords.
  const coversRequest = routed || provenStrategyCoversRequest(input.query, strategy);
  if (
    coversRequest
    && composioSlugs.length > 0
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
      // A strategy that covers only a sliver of the request may still be
      // called directly, but it never thins the surface: live 282184 a
      // two-word calendar strategy matched "create a workflow… calendar…"
      // and the thinned surface had no door to authoring.
      skipDiscoverySearch = bound.skipDiscoverySearch && coversRequest;
      capabilityRefs = bound.capabilityRefs;
      descriptors = bound.descriptors;
      invocations = bound.invocations;
      boundAccounts = bound.boundAccounts;
    } catch { /* proven provision is fail-open: keep tool_search */ }
  }

  // Native MCP and reviewed CLI reads are neither registry rows nor Composio
  // slugs. Re-attest each one through the acquisition discovery would run
  // for it and record the installed manifest as this source's proven
  // resolution, so the brain can call it by name on its first frame.
  const liveReads: ProvenLiveRead[] = [];
  const liveReadOutcomes: ProvenLiveReadOutcome[] = [];
  const liveReadIds = strategy.toolsUsed.filter((name) => {
    const trimmed = name.trim();
    return trimmed
      && !TOOL_REGISTRY.some((row) => row.name === trimmed || row.name === trimmed.toLowerCase())
      && !composioSlugs.includes(trimmed.toUpperCase());
  });
  if (
    coversRequest
    && liveReadIds.length > 0
    && input.sessionId
    && Number.isSafeInteger(input.sourceUserSeq)
    && (input.sourceUserSeq ?? 0) > 0
  ) {
    try {
      const acquire = dependencies.acquireLiveRead
        ?? (await import('../../tools/tool-search-provider-sources.js')).acquireProvenLiveReadForSource;
      const identity = { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq as number };
      const deadlineAt = Date.now() + PROVEN_PROVISION_BUDGET_MS;
      const entries: CapabilityResolutionEntry[] = [];
      for (const operation of liveReadIds) {
        if (Date.now() >= deadlineAt) {
          liveReadOutcomes.push({ operation, status: 'skipped', reason: 'budget_exhausted', elapsedMs: 0 });
          continue;
        }
        const startedAt = Date.now();
        let acquired: Awaited<ReturnType<typeof acquire>>;
        try {
          acquired = await acquire({ operation, scope: input.mcpToolScope, identity, deadlineAt });
        } catch (error) {
          liveReadOutcomes.push({
            operation,
            status: 'failed',
            reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
            elapsedMs: Date.now() - startedAt,
          });
          continue;
        }
        liveReadOutcomes.push({
          operation,
          status: acquired.status,
          ...(acquired.status === 'skipped' ? { reason: acquired.reason } : {}),
          elapsedMs: Date.now() - startedAt,
        });
        if (acquired.status !== 'installed') continue;
        liveReads.push({ operation: acquired.operation, kind: acquired.kind, accountId: acquired.accountId, ...(acquired.generic ? { generic: true } : {}) });
        if (acquired.schema) schemas[operation] = acquired.schema;
        const effectClass: 'read' | 'write' | 'unknown' = acquired.generic
          ? (acquired.effect === 'read' ? 'read' : acquired.effect === 'external_write' || acquired.effect === 'local_write' ? 'write' : 'unknown')
          : 'read';
        entries.push({
          intent: acquired.generic
            ? 'proven operation for this request; its effect is decided per call'
            : 'proven live read for this request',
          kind: acquired.kind,
          identifier: acquired.operation,
          status: 'proven',
          connection: 'active',
          accountIdentity: acquired.accountId,
          effectClass,
          matchedTokens: [acquired.kind === 'mcp'
            ? acquired.operation.slice(0, Math.max(0, acquired.operation.indexOf('__')))
            : acquired.operation],
        });
      }
      if (entries.length > 0) {
        const { recordAdmissionCapabilityResolution } = await import('../harness/capability-resolution.js');
        recordAdmissionCapabilityResolution({
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          acceptedInput: input.acceptedInput?.trim()
            || acceptedTextForSource(identity.sessionId, identity.sourceUserSeq)
            || input.query,
          entries,
        });
      }
    } catch (error) {
      // Live-read warming is fail-open: tool_search remains. Say why.
      liveReadOutcomes.push({
        operation: '*',
        status: 'failed',
        reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
        elapsedMs: 0,
      });
    }
  }

  return {
    text: renderProvenOperationGuidance(strategy, schemas, invocations, boundAccounts, liveReads, { routed }),
    strategyId: strategy.id,
    tools: strategy.toolsUsed,
    nativeTools: coversRequest ? strategy.toolsUsed.filter(isHandoverRegistryTool) : [],
    skipDiscoverySearch,
    boundAccounts,
    capabilityRefs,
    descriptors,
    liveReads,
    liveReadOutcomes,
  };
}
