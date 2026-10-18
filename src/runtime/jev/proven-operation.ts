/**
 * Select a proven past run before the first model step so the brain can skip
 * tool_search. Fail-open: no match, low confidence, missing schema, or a
 * provision miss leaves discovery unchanged.
 */
import { performance } from 'node:perf_hooks';
import { withSessionMemoryScope } from '../../memory/memory-scope.js';
import { listEvents } from '../harness/eventlog.js';
import {
  isCurrentCallableCatalogEntry,
  peekHostCapabilityCatalogFactory,
} from '../harness/host-capability-catalog-factory.js';
import { describeProvenVerification, strategyRestatesRequest, STRATEGY_COVERAGE_MIN_OVERLAP, listMatchingRunStrategies, listVerifiedRunStrategies, runStrategyScopeForSession, strategyCoversRequest, type MatchedRunStrategy, type RunStrategyRecord } from '../../memory/run-strategy-store.js';
import { selectLearnedStrategyTools } from '../harness/host-run-strategy-learning.js';
import { peekConnectedToolkits, peekCurrentConnectedToolkits } from '../../integrations/composio/client.js';
import { composioSlugLooksWellFormed, registeredToolkitOfSlug } from '../../integrations/composio/toolkit-slug.js';
import { classifyComposioSlugEffect } from '../../integrations/composio/slug-effect.js';
import type { CapabilityResolutionEntry } from '../harness/capability-resolution.js';
import type { McpToolScope } from '../mcp-tool-scope.js';
import { canonicalMcpToolIdentity } from '../mcp-tool-authority.js';
import type { HostCapabilityDescriptorV1 } from '../semantic-boundary/turn-semantic-proposal.js';
import { getCachedToolSchema } from '../../tools/composio-schema-cache.js';
import { compactContract } from '../../tools/schema-contract-lines.js';
import { TOOL_REGISTRY, isRegistryDeclaredRead } from '../../tools/tool-registry.js';
import { renderCarrierInvocationExample } from '../../tools/tool-search-tool.js';
import {
  decideTurnStartWithJev,
  type ProvenStrategyCandidate,
  type RoutableOperation,
  type TurnStartDecision,
} from './control-plane.js';
import { jevAvailable } from './client.js';
import { listActiveFacts } from '../../memory/facts.js';
import { listToolProcedures } from '../../memory/tool-choice-store.js';
import { DISCOVERY_SIBLING_DOORS, TOOL_SEARCH_ALWAYS_LOADED, rankCatalogEntriesLexically } from '../../agents/tool-catalog.js';
import { NATIVE_PRODUCT_AUTHORING_TOOLS } from '../../tools/native-product-surface.js';

/** Bound so a slow provider refresh cannot stall the first model step. */
const PROVEN_PROVISION_BUDGET_MS = 10_000;
/** Admission budget for the optional turn-start Jev decision. Preparation
 *  before it and event-loop stalls can take longer; an answer admitted after
 *  this deadline is never used. */
export const PROVEN_PICK_BUDGET_MS = 1_500;
/** One request's candidates: every operation a named family holds, as a rule. */
const OPERATION_ROUTE_CANDIDATES = 10;
/** Remembered kinds of work offered to Jev for one request. */
const FAMILIAR_RUN_CANDIDATES = 8;

/** How the turn's remembered run was chosen:
 *  - request_identity: the accepted request exactly restates the proven run;
 *  - jev: Jev judged, inside the budget, that the run did the same kind of work;
 *  - jev_route: Jev routed the request to one operation the host can hand over;
 *  - jev_corroborated: Jev was sure of neither, but the run it leaned to used
 *    the operation it would run first. The run is offered, not bound as the
 *    whole job.
 *  Without a turn-start judgement, remembered runs that disagree are never
 *  settled by how many words the request shares with one of them: nothing is
 *  picked, and discovery runs as usual. */
export type ProvenPickSource = 'request_identity' | 'jev' | 'jev_route' | 'jev_corroborated';

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
  /** Whether the bound turn may also narrow its tool surface to the proven
   *  carrier. Only a request known to BE the proven run (it restates it, or
   *  was routed to one operation) narrows; a judgement that a run did the same
   *  kind of work says its operations do the core of the request, not all of
   *  it, so the rest of the surface stays. */
  narrowSurface: boolean;
  /** How the remembered run was chosen; absent when none was. */
  pickedBy?: ProvenPickSource;
  /** The owner's standing rule that offered the routed operation, so a view of
   *  remembered tools can say why this one was used. `operation` is set when
   *  the rule rode beside a picked run rather than being the routed pick. */
  ownerRule?: { factId: number; text: string; operation?: string };
  /** Existing Date.now elapsed around the decision, when asked. Wall-clock
   *  diagnostic only; not the whole preparation span or a timing guarantee. */
  decisionWaitMs?: number;
}

export interface ProvenOperationDependencies {
  acquireLiveRead?: typeof import('../../tools/tool-search-provider-sources.js').acquireProvenLiveReadForSource;
  /** Test seam for the turn-start Jev decision. An injected decision stands in
   *  for Jev entirely, so it is asked whether or not Jev is available. */
  decideTurnStart?: typeof decideTurnStartWithJev;
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

/** A bind before the first frame skips the discovery that would have listed
 *  connections afresh, so it holds the connection to the same freshness an
 *  execution preparation does: a current observation, never a last-good one of
 *  any age. Without one, the provisioning path lists connections afresh. */
function uniqueActiveConnection(toolkit: string): { connectionId: string } | null {
  try {
    const rows = (peekCurrentConnectedToolkits() ?? []).filter((row) => (
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

/** A schema the field summary cannot state goes over whole up to this size. */
const PROVEN_FULL_SCHEMA_CHARS = 6_000;

export function renderProvenOperationGuidance(
  strategy: RunStrategyRecord,
  schemas: Record<string, unknown>,
  invocations: readonly unknown[] = [],
  boundAccounts: readonly ProvenBoundAccount[] = [],
  liveReads: readonly ProvenLiveRead[] = [],
  opts: { routed?: boolean; likely?: boolean; ownerRule?: { operation: string; text: string } } = {},
): string {
  const tools = strategy.toolsUsed;
  if (opts.routed === true && tools.every(isHandoverRegistryTool)) {
    // The orchestrator loads a handed-over registry tool with its own schema,
    // unless this turn's mode keeps it off the surface; then search stays the door.
    return [
      '[ROUTED OPERATION]',
      `This request most likely needs ${tools.join(', ')}.`,
      `When your tools list ${tools.join(', ')}, call it directly. Use tool_search only if it is not listed or cannot do the whole request.`,
    ].join('\n');
  }
  // Every field with its type, nullability, required marker and limits,
  // nested fields included; only descriptions are shortened. Clipping the raw
  // JSON lost whole fields and their limits behind one long description
  // (10-10: a page size's maximum sat past the clip, and the model asked for
  // more than it allows). A schema whose structure the summary cannot state
  // goes over whole, or, when too large, the model is sent to fetch it and is
  // not told to skip the lookup.
  const needsFullSchema: string[] = [];
  const schemaLines = tools.map((name) => {
    const schema = schemas[name] ?? schemas[name.toUpperCase()];
    if (!schema) return `- ${name}`;
    const contract = compactContract(schema);
    if (contract.complete && contract.lines.length > 0) {
      return [`- ${name} fields (* = required):`, ...contract.lines.map((line) => `  ${line}`)].join('\n');
    }
    const body = JSON.stringify(schema);
    if (body.length <= PROVEN_FULL_SCHEMA_CHARS) return `- ${name} full schema: ${body}`;
    needsFullSchema.push(name);
    return `- ${name}: its schema is too large to show here; call tool_search with the exact name ${name} for the full schema before calling it.`;
  });
  const callable = invocations.length > 0;
  const skipSearch = callable && needsFullSchema.length === 0;
  return [
    opts.routed
      ? (skipSearch ? '[ROUTED OPERATION — skip tool_search]' : '[ROUTED OPERATION]')
      : (skipSearch ? '[PROVEN OPERATION — skip tool_search]' : '[PROVEN OPERATION]'),
    // The earlier request's text carries that instance's targets and values,
    // which are not this one's, however close the wording: the hint names
    // the tools and the roles of their arguments only.
    opts.routed
      ? `This request most likely needs ${tools.join(', ')}.`
      : opts.likely
        // Offered on agreement, not certainty: say so, so the brain checks the
        // fit itself instead of taking the run as the whole job.
        ? `A prior successful run of what looks like the same kind of request used these tools: ${tools.join(', ')}. They are verified and callable now. Use them where they do what this request asks, with this request's own targets and values; anything else this request needs is still yours to find.`
        : `A prior successful run of this same kind of request already proved these tools: ${tools.join(', ')}. Use this request's own targets and values.`,
    // The run did not use the rule's tool, so say it apart from the run's
    // tools, and say that it holds inside what the request builds too.
    ...(opts.ownerRule
      ? [`The owner's standing rule applies to part of this request: "${opts.ownerRule.text}" Use ${opts.ownerRule.operation} for that part, including inside anything you build for this request, such as a workflow step or a Space source.`]
      : []),
    skipSearch
      ? 'Call them directly on this turn. tool_search stays available if these operations cannot fulfill the whole request or a call is refused.'
      : callable
        ? `Call them on this turn; first fetch the full schema of ${needsFullSchema.join(', ')} with tool_search by exact name, as shown above.`
        : 'Prefer these tools. Use tool_search once if their requirement_id is not already disclosed on work_call.',
    // How the proven run checked its own work travels with the run. A faster
    // second run must not be a less careful one.
    ...(() => {
      const verification = describeProvenVerification(strategy.provenSteps);
      return verification ? [verification] : [];
    })(),
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
          'Request shapes that succeeded in the proven run (values elided; only the operation selectors method, tool_slug and an API route stay literal). Reuse the same field names with this request\'s own values:',
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
export const PROVEN_SKIP_MIN_OVERLAP = STRATEGY_COVERAGE_MIN_OVERLAP;

/** Does the strategy cover the request, not merely touch it? The rule is the
 *  strategy store's own (strategyCoversRequest), so every surface that offers
 *  a remembered run without a judgement applies the same bar. */
export function provenStrategyCoversRequest(query: string, strategy: Pick<RunStrategyRecord, 'keywords'>): boolean {
  return strategyCoversRequest(query, strategy);
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

/** The owner's standing rules weighed against one request. */
const OWNER_RULE_WINDOW = 12;
/** Remembered operations one rule may offer. */
const OWNER_RULE_OPERATIONS = 3;

/** Operations the owner's own standing rules name for a kind of work. A rule
 *  names a provider Clem has already used successfully ("read pages with
 *  Firecrawl"), so that provider's proven operations become candidates, with
 *  the rule as their purpose. Whether the rule covers this request, its
 *  exception included, is Jev's choice like any other candidate; the host only
 *  gathers them. Live 2026-10-18: the owner's rule sat in the prompt and the
 *  brain still read the page with the plain web read already in hand. */
export function ownerRuleOperations(query: string): Array<{ id: string; purpose: string; rule: { factId: number; text: string } }> {
  let rules: Array<{ id: number; content: string }>;
  let procedures: ReturnType<typeof listToolProcedures>;
  try {
    rules = listActiveFacts({ kind: 'constraint', ranking: 'stanford', objective: query, limit: OWNER_RULE_WINDOW });
    if (rules.length === 0) return [];
    procedures = listToolProcedures();
  } catch {
    return [];
  }
  let connected: Set<string> | null = null;
  try {
    const rows = peekConnectedToolkits().filter((row) => /^active$/i.test(row.status.trim()));
    if (rows.length > 0) connected = new Set(rows.map((row) => row.slug.trim().toLowerCase()));
  } catch { /* unknown connections: provisioning still checks the exact operation */ }
  const out: Array<{ id: string; purpose: string; rule: { factId: number; text: string } }> = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const words = new Set(nameWords(rule.content));
    const named = procedures.filter((procedure) => {
      const choice = procedure.choice;
      const provider = procedure.provider?.trim().toLowerCase();
      if (!choice || choice.kind !== 'composio' || !provider || !words.has(provider)) return false;
      // The operation belongs to the provider the rule names; the host still
      // re-attests the exact operation before handing it over.
      if (!choice.identifier.toUpperCase().startsWith(`${provider.toUpperCase()}_`)) return false;
      if ((choice.successCount ?? 0) <= 0) return false;
      return !connected || connected.has(registeredToolkitOfSlug(choice.identifier).toLowerCase());
    });
    if (named.length === 0) continue;
    const ranked = rankCatalogEntriesLexically(query, named.map((procedure) => ({
      name: procedure.choice!.identifier,
      oneLiner: procedure.aliases.map((alias) => alias.intent).join('; '),
    })));
    const said = rule.content.replace(/\s+/g, ' ').trim();
    for (const row of ranked.slice(0, OWNER_RULE_OPERATIONS)) {
      if (seen.has(row.name)) continue;
      seen.add(row.name);
      out.push({ id: row.name, purpose: `Owner's standing rule: "${said.length > 190 ? `${said.slice(0, 189)}…` : said}"`, rule: { factId: rule.id, text: said } });
    }
  }
  return out.slice(0, OPERATION_ROUTE_CANDIDATES);
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
  return routableOperationsFromStrategies(query, scope, listVerifiedRunStrategies());
}

function routableOperationsFromStrategies(
  query: string,
  scope: 'chat' | 'any',
  strategies: readonly RunStrategyRecord[],
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
  for (const strategy of strategies) {
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

/** The operations of a remembered run that the host can hand over before the
 *  first frame: provider operations it provisions or re-attests, and registry
 *  tools the orchestrator loads by name. A tool already on every surface, or a
 *  discovery door, is no reason to recall a run. */
function bindableStrategyTools(toolsUsed: readonly string[]): string[] {
  return selectLearnedStrategyTools(toolsUsed).filter((name) => {
    const row = TOOL_REGISTRY.find((entry) => entry.name === name || entry.name === name.toLowerCase());
    if (!row) return true;
    return isHandoverRegistryTool(row.name)
      && !TOOL_SEARCH_ALWAYS_LOADED.has(row.name)
      && !DISCOVERY_SIBLING_DOORS.has(row.name);
  });
}

/**
 * The kinds of work this owner has already done successfully, offered to Jev
 * as candidates for this request: every verified run in scope that has an
 * operation to hand over, one per distinct set of operations. A familiar
 * request is usually worded differently from the run that proved it (another
 * target, another phrasing), so recall is not gated on shared words. Words
 * only ORDER the window: runs that share informative words with the request
 * come first, then the most recently used. Jev decides relevance; the host
 * then checks that each operation is still connected and callable.
 */
export function familiarRunStrategiesForRequest(
  query: string,
  scope: 'chat' | 'any',
  limit = FAMILIAR_RUN_CANDIDATES,
): RunStrategyRecord[] {
  return familiarRunStrategiesFromStrategies(query, scope, listVerifiedRunStrategies(), limit);
}

function familiarRunStrategiesFromStrategies(
  query: string,
  scope: 'chat' | 'any',
  strategies: readonly RunStrategyRecord[],
  limit = FAMILIAR_RUN_CANDIDATES,
): RunStrategyRecord[] {
  const offered = strategies
    .filter((strategy) => scope === 'any' || (strategy.scope ?? 'chat') === 'chat')
    .filter((strategy) => bindableStrategyTools(strategy.toolsUsed).length > 0);
  if (offered.length === 0) return [];
  const ranked = rankCatalogEntriesLexically(query, offered.map((strategy, recency) => ({
    name: selectLearnedStrategyTools(strategy.toolsUsed).join(' '),
    oneLiner: strategy.objective,
    strategy,
    recency,
  })));
  const ordered = [
    ...ranked.filter((row) => row.score > 0),
    ...ranked.filter((row) => !(row.score > 0)).sort((left, right) => left.recency - right.recency),
  ];
  const seen = new Set<string>();
  const picked: RunStrategyRecord[] = [];
  for (const row of ordered) {
    const signature = toolSignature(row.strategy.toolsUsed);
    if (seen.has(signature)) continue;
    seen.add(signature);
    picked.push(row.strategy);
    if (picked.length >= limit) break;
  }
  return picked;
}

type TurnStartDecisionFor = TurnStartDecision<ProvenStrategyCandidate, RoutableOperation>;

/** Admit a turn-start result only within its budget. The race cannot preempt
 *  synchronous work or a descheduled process; its later answer is not used. */
async function decideWithinBudget(
  decide: () => Promise<TurnStartDecisionFor>,
  budgetMs: number,
): Promise<TurnStartDecisionFor> {
  const unavailable: TurnStartDecisionFor = {
    strategy: null,
    route: { pick: null, outcome: 'unavailable' },
    failedOpen: true,
  };
  const deadline = performance.now() + budgetMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<TurnStartDecisionFor>((resolve) => {
    timer = setTimeout(() => resolve(unavailable), budgetMs);
  });
  try {
    const decision = await Promise.race([decide().catch(() => unavailable), expired]);
    // A fulfilled microtask can precede an overdue timer after an event-loop
    // stall. Only a result admitted inside the original budget may be used.
    return performance.now() < deadline ? decision : unavailable;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function prepareProvenOperationForRequest(input: {
  query: string;
  sessionId?: string;
  sourceUserSeq?: number;
  acceptedInput?: string;
  /** The request's MCP scope; a proven native read outside it is not warmed. */
  mcpToolScope?: McpToolScope | null;
}, dependencies: ProvenOperationDependencies = {}): Promise<ProvenOperationPreparation> {
  // A remembered method is offered to the session it may be offered to: one
  // proved inside another project is not this request's method.
  return withSessionMemoryScope(input.sessionId, () => prepareProvenOperationInScope(input, dependencies));
}

async function prepareProvenOperationInScope(
  input: Parameters<typeof prepareProvenOperationForRequest>[0],
  dependencies: ProvenOperationDependencies = {},
): Promise<ProvenOperationPreparation> {
  const empty: ProvenOperationPreparation = {
    tools: [],
    nativeTools: [],
    skipDiscoverySearch: false,
    narrowSurface: false,
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
  // An identical accepted request can reuse a proven procedure. Similar text
  // supplies candidates to Jev, never an operation binding by itself.
  const unambiguousMatch = pickProvenRunStrategy(matches);
  let strategy = unambiguousMatch && strategyRestatesRequest(input.query, unambiguousMatch) ? unambiguousMatch : null;
  let pickedBy: ProvenPickSource | undefined = strategy ? 'request_identity' : undefined;
  let decisionWaitMs: number | undefined;
  // Whether a remembered kind of work fits and which operation would do the
  // core of the request go to Jev together, in one bounded wait before the
  // first model frame. A late answer is not used. Jev's pick of a remembered
  // run is the relevance decision: the host binds that run's operations below
  // exactly as it binds a run the request restates. A routed pick stands only
  // when Jev is sure of it and of its fit; it is advisory until the host hands
  // the operation over below.
  let routed = false;
  const ownerRuleFor = new Map<string, { factId: number; text: string }>();
  // The operation an owner's rule names for part of the work, beside the run
  // Jev picked. It is provisioned with the run's operations; it never joins
  // the run's own proven tools, which that run alone proved.
  let ruleBesideRun: string | null = null;
  if (!strategy) {
    // The candidates exist only for Jev's question. When Jev cannot be asked
    // (turned off, or no key), none are built and nothing waits. With no
    // judgement, whether it was never asked, failed or ran out of time, no
    // remembered run is picked or offered on the words it shares with the
    // request: discovery finds the operation instead.
    const decideTurnStart = dependencies.decideTurnStart
      ?? (await jevAvailable() ? decideTurnStartWithJev : null);
    // Both candidate windows describe this one decision. Read the verified,
    // scoped runs once; selected operations are still re-attested below.
    const verified = decideTurnStart ? listVerifiedRunStrategies() : [];
    const familiar = decideTurnStart ? familiarRunStrategiesFromStrategies(input.query, strategyScope, verified) : [];
    // The owner's own rules go first: a tool they named for this kind of work
    // is weighed before anything the request merely shares words with.
    const ruled = decideTurnStart ? ownerRuleOperations(input.query) : [];
    for (const row of ruled) if (!ownerRuleFor.has(row.id)) ownerRuleFor.set(row.id, row.rule);
    const operations = decideTurnStart ? [
      ...ruled.map(({ id, purpose, rule }) => ({ id, purpose, rule: rule.text })),
      ...routableOperationsFromStrategies(input.query, strategyScope, verified),
    ].filter((row, index, rows) => rows.findIndex((other) => other.id === row.id) === index) : [];
    if (decideTurnStart && (familiar.length > 0 || operations.length > 0)) {
      const startedAt = Date.now();
      const decision = await decideWithinBudget(() => decideTurnStart(
        input.query,
        familiar.map((row) => ({
          id: row.id,
          objective: row.objective,
          toolsUsed: row.toolsUsed,
        })),
        operations,
        { timeoutMs: PROVEN_PICK_BUDGET_MS, ...(input.sessionId ? { sessionId: input.sessionId } : {}) },
      ), PROVEN_PICK_BUDGET_MS);
      decisionWaitMs = Date.now() - startedAt;
      const judged = decision.strategy
        ? familiar.find((row) => row.id === decision.strategy!.id) ?? null
        : null;
      if (judged) {
        strategy = judged;
        pickedBy = 'jev';
        const beside = decision.ownerRule?.operation.id;
        if (beside && ownerRuleFor.has(beside)) ruleBesideRun = beside;
      }
      const agreed = !strategy && !decision.route.pick && decision.corroborated
        ? familiar.find((row) => row.id === decision.corroborated!.strategy.id) ?? null
        : null;
      if (agreed) {
        strategy = agreed;
        pickedBy = 'jev_corroborated';
      }
      if (!strategy && decision.route.pick) {
        routed = true;
        pickedBy = 'jev_route';
        strategy = {
          id: `route:${decision.route.pick.id}`,
          objective: decision.route.pick.purpose,
          keywords: [],
          toolsUsed: [decision.route.pick.id],
          workerCount: 0,
          durationMs: 0,
          createdAt: new Date().toISOString(),
          uses: 0,
        };
      }
    }
  }
  if (!strategy) return { ...empty, ...(decisionWaitMs !== undefined ? { decisionWaitMs } : {}) };
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
  const composioSlugs = composioSlugsFromStrategy(ruleBesideRun ? [...strategy.toolsUsed, ruleBesideRun] : strategy.toolsUsed);
  // A strategy that does not cover the request must not spend the request's
  // time provisioning its operations. Coverage is either the request restating the run
  // (its own keywords), or a turn-start judgement inside the budget that the
  // run did this same kind of work or that the routed operation does its core.
  const coversRequest = routed || pickedBy === 'jev' || pickedBy === 'jev_corroborated'
    || provenStrategyCoversRequest(input.query, strategy);
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
      // called directly, but it never thins the surface: a short strategy can
      // match a longer request that needs other doors, and a thinned surface
      // would not have them.
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
    text: renderProvenOperationGuidance(strategy, schemas, invocations, boundAccounts, liveReads, {
      routed,
      ...(pickedBy === 'jev_corroborated' ? { likely: true } : {}),
      ...(ruleBesideRun ? { ownerRule: { operation: ruleBesideRun, text: ownerRuleFor.get(ruleBesideRun)!.text } } : {}),
    }),
    strategyId: strategy.id,
    tools: strategy.toolsUsed,
    nativeTools: coversRequest ? strategy.toolsUsed.filter(isHandoverRegistryTool) : [],
    skipDiscoverySearch,
    // A judgement that a run did the same kind of work, sure or corroborated,
    // says its operations do the core of the request, not all of it.
    // An owner's rule picks the tool for one part of the work (reading the
    // page), not the whole method, so the rest of the surface stays.
    narrowSurface: skipDiscoverySearch && pickedBy !== 'jev' && pickedBy !== 'jev_corroborated'
      && !(routed && ownerRuleFor.has(strategy.toolsUsed[0] ?? '')),
    boundAccounts,
    capabilityRefs,
    descriptors,
    liveReads,
    liveReadOutcomes,
    ...(pickedBy ? { pickedBy } : {}),
    ...(routed && ownerRuleFor.has(strategy.toolsUsed[0] ?? '') ? { ownerRule: ownerRuleFor.get(strategy.toolsUsed[0]!)! } : {}),
    ...(ruleBesideRun ? { ownerRule: { ...ownerRuleFor.get(ruleBesideRun)!, operation: ruleBesideRun } } : {}),
    ...(decisionWaitMs !== undefined ? { decisionWaitMs } : {}),
  };
}
