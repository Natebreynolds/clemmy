/**
 * THIS-TURN CATALOG from CONNECTED reality.
 *
 * Live 2026-08-19 session-fixture-catalog-starvation: the admitted collect_then_construct starved
 * twice on the same input defect. The admission-time prover was
 * `resolveTurnCapabilities` — a RECALL matcher — so a fresh session offered
 * cross-goal recency (Slack cron, DataForSEO keywords-for-site, ADD_SHEET)
 * and hid still-connected creates behind tool-memory `previously_failed`.
 * Bind then failed, and the harness swung between two illegal answers:
 * "Connect the missing provider" (it was connected) and the legacy loop
 * (ask_user_question, then a crash).
 *
 * This module enumerates what is ACTUALLY callable right now, offline:
 *   connected toolkits (live Composio registry)
 *   × known frozen schemas (the durable tool-contract store + schema cache)
 *   × schema-grounded goal probes (compileProofProviderArgs — the same
 *     compiler that will build the real provider args)
 * and records the selection as this source's authoritative
 * capability_resolution BEFORE host-bind runs. Tool-memory failure verdicts
 * are advisory history, never connectivity: `previously_failed` does not hide
 * a connected slug. Recency from other sessions/workflows is not consulted.
 *
 * When the CONNECTED registry truly has no capability for a goal family, the
 * gap is reported by FAMILY ("web search", "spreadsheet create from rows") so
 * a blocked outcome can name the missing connection honestly — and when the
 * families exist, that branch is unreachable.
 */
import {
  recordAdmissionCapabilityResolution,
  type CapabilityResolutionEntry,
} from './capability-resolution.js';
import { compileProofProviderArgs } from './proof-provider-args.js';
import type { GraphNodeInvocationEnvelopeV1 } from './graph-node-envelope.js';
import { listConnectedToolkits, peekConnectedToolkits } from '../../integrations/composio/client.js';
import { listToolContractFiles, readToolContractFile } from '../../tools/tool-contract-store.js';
import { registeredToolkitOfSlug } from '../../integrations/composio/toolkit-slug.js';
import { peekHostCapabilityCatalogFactory } from './host-capability-catalog-factory.js';
import { classifyComposioSlugEffect } from '../../integrations/composio/slug-effect.js';

export interface ConnectedRegistryTool {
  slug: string;
  schema: Record<string, unknown>;
}

export interface ConnectedRegistryView {
  /** Normalized toolkit slugs with a live, usable connection. */
  connectedToolkits: string[];
  /** Every operation with a frozen schema the host knows for those toolkits. */
  tools: ConnectedRegistryTool[];
}

export type ConnectedRegistryPort = () => ConnectedRegistryView;

let registryPort: ConnectedRegistryPort | null = null;

/** Production registry: live Composio connections × the durable contract
 *  store. Isolated pins install a connected-SHAPED fixture through the same
 *  port — never a planted resolver. */
export function installConnectedRegistryPort(port: ConnectedRegistryPort | null): void {
  registryPort = port;
}

function productionRegistryView(): ConnectedRegistryView {
  const connected = peekConnectedToolkits()
    .filter((toolkit) => (toolkit.status ?? '').toUpperCase() !== 'FAILED')
    .map((toolkit) => toolkit.slug.trim().toLowerCase())
    .filter(Boolean);
  const connectedSet = new Set(connected);
  const tools: ConnectedRegistryTool[] = [];
  for (const file of listToolContractFiles()) {
    const contract = readToolContractFile(file.fileName);
    if (!contract?.identifier) continue;
    const schema = contract.schema;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) continue;
    const toolkit = registeredToolkitOfSlug(contract.identifier).trim().toLowerCase();
    if (!connectedSet.has(toolkit)) continue;
    tools.push({ slug: contract.identifier, schema: schema as Record<string, unknown> });
  }
  return { connectedToolkits: connected, tools };
}

function registryView(): ConnectedRegistryView {
  return (registryPort ?? productionRegistryView)();
}

function probeEnvelope(objective: string, predecessors: GraphNodeInvocationEnvelopeV1['predecessors'] = []): GraphNodeInvocationEnvelopeV1 {
  return {
    version: 1,
    identity: { sessionId: 'goal-catalog-probe', sourceUserSeq: 0, acceptedTaskId: 'task:goal-catalog-probe#0' },
    goal: { objective, revision: 0, criteria: [] },
    node: { id: 'probe', role: 'probe' },
    cardinality: null,
    predecessors,
    expectedOutput: { kind: 'evidence' },
    binding: { capabilityId: 'probe', manifestDigest: 'probe', schemaDigest: 'probe', effect: 'read' },
  } as GraphNodeInvocationEnvelopeV1;
}

const SEARCH_NAME_RE = /(^|_)(SEARCH|QUERY|LIST|FIND|LOOKUP)(_|$)/i;
const ID_KEY_RE = /(^|_)(id)$|_id(_|$)/i;

function requiredOf(schema: Record<string, unknown>): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
}

/** Structure words that carry no goal meaning in a tool slug. */
const GENERIC_SLUG_TOKENS = new Set([
  'get', 'list', 'search', 'query', 'find', 'lookup', 'fetch', 'create', 'new',
  'add', 'from', 'to', 'by', 'of', 'all', 'json', 'batch', 'item', 'items',
  'data', 'record', 'records', 'row', 'rows', 'v1', 'v2', 'v3', 'api', 'the', 'a',
  // Live 2026-08-25: DATAFORSEO_GET_SERP_G_DATASET_SEARCH_TASK_ADV_BY_ID
  // survived the zero-evidence floor because its slug token TASK matched
  // "tasks" in a briefing objective. In a tool slug, task/run/job name the
  // provider's execution plumbing, not a user domain — structure words, like
  // item/record above.
  'task', 'run', 'job',
]);

function slugTokens(text: string): string[] {
  // Tokens of one or two characters (the G in SERP_G_DATASET, ID, AD) can
  // only ever match as substrings of longer objective words — pure noise
  // that manufactured overlap where no domain connection exists.
  return text.toLowerCase().split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3)
    .map((token) => token.replace(/s$/, ''));
}

/**
 * Goal affinity of a tool slug against the objective's OWN words. Live 59796:
 * structural probes alone selected APIFY_GET_LIST_OF_BUILDS as the "search"
 * and OUTLOOK_CREATE_CONTACT as the "row create" for "…add them to a Google
 * sheet…" — schema-fillable, goal-meaningless. Overlap between objective
 * tokens and slug tokens (substring-tolerant, so "google sheet" matches the
 * compound toolkit token `googlesheets`) is rewarded; entity tokens the
 * objective never mentions (`builds`, `contact`) are penalized. Generic
 * structure words score nothing either way. No provider names live here.
 */
// The objective is tokenized once per selection pass, not once per tool: a
// selection scans the whole contract store and calls goalAffinity per slug, so
// re-tokenizing a long objective every call multiplies a constant cost by the
// store size (measured live: 10KB objective x ~2,000 contracts = 2.35s of the
// admission stage; 114ms with the objective tokenized once).
let cachedObjectiveTokensFor: string | null = null;
let cachedObjectiveTokens: string[] = [];
function objectiveAffinityTokens(objective: string): string[] {
  if (cachedObjectiveTokensFor !== objective) {
    cachedObjectiveTokensFor = objective;
    cachedObjectiveTokens = slugTokens(objective).filter((token) => token.length >= 4);
  }
  return cachedObjectiveTokens;
}

function goalAffinity(slug: string, objective: string): { overlap: number; foreign: number } {
  const objectiveTokens = objectiveAffinityTokens(objective);
  let overlap = 0;
  let foreign = 0;
  for (const token of new Set(slugTokens(slug))) {
    if (GENERIC_SLUG_TOKENS.has(token)) continue;
    const matched = objectiveTokens.some((word) => token.includes(word) || word.includes(token));
    if (matched) overlap += 1;
    else foreign += 1;
  }
  return { overlap, foreign };
}

function affinityRank(slug: string, objective: string): number {
  const { overlap, foreign } = goalAffinity(slug, objective);
  return foreign * 2 - overlap * 5;
}


/** Attested advisory roles for a slug, read from the registered capability
 *  factory. A DECLARED role is structured evidence: the lexical zero-evidence
 *  floor exists for fillability-only guesses over raw provider probes, and an
 *  attested registration is not a guess (live 2026-08-25: the floor starved
 *  the typed host-bind fixtures whose capabilities declare collection/
 *  transform roles, while the junk it was built to stop carried no roles).
 *  Roles never authorize execution — they only spare a registered capability
 *  from being treated as lexically evidence-free. */
function attestedRolesForSlug(slug: string): readonly string[] {
  try {
    const factory = peekHostCapabilityCatalogFactory();
    if (!factory) return [];
    const lower = slug.trim().toLowerCase();
    for (const entry of factory.snapshot()) {
      const operation = (entry.manifest?.operationId ?? entry.toolName ?? '').trim().toLowerCase();
      if (operation !== lower) continue;
      // Proof-provisioned mints derive their roles FROM a prior goal-catalog
      // selection — the very thing this floor guards. Exempting them would be
      // circular: yesterday's lexical guess laundered into today's evidence.
      // Only a registration whose manifest was issued OUTSIDE resolution
      // proof (connect-time deposit, local registry, reviewed CLI, bootstrap)
      // counts as attested.
      if (entry.manifest?.provenance?.issuer === 'host:resolution-proof') return [];
      return entry.advisoryRoles ?? [];
    }
  } catch { /* advisory only — a factory failure never blocks selection */ }
  return [];
}

export interface GoalCatalogSelection {
  entries: CapabilityResolutionEntry[];
  gaps: Array<'search' | 'row_create' | 'readback'>;
}

/**
 * Select goal-carrying operations for a collect→construct shape from the
 * connected registry. Deterministic and schema-grounded — the same probes the
 * executor's argument compiler will run.
 */
export function selectGoalCatalog(objective: string): GoalCatalogSelection {
  const view = registryView();
  const readEffect = (slug: string): 'read' | 'write' =>
    (classifyComposioSlugEffect(slug) === 'read' ? 'read' : 'write');

  const searchCandidates: Array<{ slug: string; rank: number }> = [];
  const createCandidates: Array<{ slug: string; rank: number; toolkit: string }> = [];
  for (const tool of view.tools) {
    const effect = readEffect(tool.slug);
    // Zero-evidence floor: when no token of the slug connects to the objective
    // and at least one names a different domain, fillability alone is a lexical
    // guess — and a guess selected here is minted downstream as a "proven"
    // authoritative entry. Abstaining routes to the existing gaps machinery;
    // a slot with no evidenced candidate reports a gap rather than a winner.
    const affinity = goalAffinity(tool.slug, objective);
    if (
      affinity.overlap === 0
      && affinity.foreign > 0
      && attestedRolesForSlug(tool.slug).length === 0
    ) continue;
    if (effect === 'read') {
      // A goal-carrying search: the frozen required fields can be filled from
      // the objective alone (FIRECRAWL_SEARCH's `q` — not keywords-for-site,
      // whose required fields need a target the objective does not carry).
      const args = compileProofProviderArgs({
        schema: tool.schema,
        role: 'source',
        effect: 'read',
        payload: undefined,
        envelope: probeEnvelope(objective),
      });
      if (args !== null && Object.keys(args).length > 0) {
        searchCandidates.push({
          slug: tool.slug,
          // Prefer operations whose NAME says they search/list a set; a
          // fillable-but-random read (a get-by-default) ranks below. Goal
          // affinity separates a real search from a fillable impostor
          // (APIFY_GET_LIST_OF_BUILDS outranked FIRECRAWL_SEARCH live).
          rank: (SEARCH_NAME_RE.test(tool.slug) ? 0 : 10)
            + requiredOf(tool.schema).length
            + affinityRank(tool.slug, objective),
        });
      }
    } else {
      // A goal-carrying construct write: the schema ACCEPTS THE COLLECTED
      // ROWS (array member or JSON-string member). ADD_SHEET-shaped tab
      // writes fail this probe structurally.
      const args = compileProofProviderArgs({
        schema: tool.schema,
        role: 'create',
        effect: 'external_write',
        payload: [{ probe: 'row' }],
        envelope: probeEnvelope(objective),
      });
      // A construct-create must REQUIRE the collection: the rows land in a
      // required array (or required JSON-string) member. An optional array
      // property is not a row contract — OUTLOOK_CREATE_CONTACT (zero
      // required, optional `categories`) passed the loose probe live.
      const required = requiredOf(tool.schema);
      const properties = (tool.schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const requiresCollection = required.some((key) => {
        const type = typeof properties[key]?.type === 'string' ? properties[key]!.type : '';
        return type === 'array' || (type === 'string' && /json/i.test(key));
      });
      if (args !== null && requiresCollection) {
        createCandidates.push({
          slug: tool.slug,
          rank: required.length + affinityRank(tool.slug, objective),
          toolkit: registeredToolkitOfSlug(tool.slug).trim().toLowerCase(),
        });
      }
    }
  }
  searchCandidates.sort((a, b) => a.rank - b.rank || a.slug.localeCompare(b.slug));
  createCandidates.sort((a, b) => a.rank - b.rank || a.slug.localeCompare(b.slug));
  const search = searchCandidates[0];
  const create = createCandidates[0];

  // Readback: a read on the CREATE's toolkit whose required fields are
  // id-shaped (fillable from the created resource id).
  let readback: { slug: string } | undefined;
  if (create) {
    const readbackCandidates: Array<{ slug: string; rank: number }> = [];
    for (const tool of view.tools) {
      if (readEffect(tool.slug) !== 'read') continue;
      if (registeredToolkitOfSlug(tool.slug).trim().toLowerCase() !== create.toolkit) continue;
      const required = requiredOf(tool.schema);
      const args = compileProofProviderArgs({
        schema: tool.schema,
        role: 'readback',
        effect: 'read',
        payload: undefined,
        envelope: probeEnvelope(objective, [{ nodeId: 'probe-create', role: 'create', value: { id: 'probe-id' } }]),
      });
      if (args !== null && required.some((key) => ID_KEY_RE.test(key))) {
        readbackCandidates.push({ slug: tool.slug, rank: required.length });
      }
    }
    readbackCandidates.sort((a, b) => a.rank - b.rank || a.slug.localeCompare(b.slug));
    readback = readbackCandidates[0];
  }

  const gaps: GoalCatalogSelection['gaps'] = [];
  if (!search) gaps.push('search');
  if (!create) gaps.push('row_create');
  if (create && !readback) gaps.push('readback');

  const entries: CapabilityResolutionEntry[] = [];
  if (search) {
    entries.push({
      intent: 'goal search: collect the requested set',
      kind: 'composio',
      identifier: search.slug,
      status: 'proven',
      connection: 'active',
      effectClass: 'read',
    });
  }
  if (create) {
    entries.push({
      intent: 'goal construct: create the destination from the collected rows',
      kind: 'composio',
      identifier: create.slug,
      status: 'proven',
      connection: 'active',
      effectClass: 'write',
    });
  }
  if (readback) {
    entries.push({
      intent: 'goal readback: verify the created resource',
      kind: 'composio',
      identifier: readback.slug,
      status: 'proven',
      connection: 'active',
      effectClass: 'read',
    });
  }
  return { entries, gaps };
}

/** Human copy for a genuine connectivity gap, by FAMILY — never "connect the
 *  missing provider" when the provider is connected. */
export function describeGoalCatalogGap(
  gaps: GoalCatalogSelection['gaps'],
  opts?: { projection?: readonly string[] },
): string {
  const families: string[] = [];
  const fields = (opts?.projection ?? []).filter((role) => role.trim().length > 0);
  if (gaps.includes('search')) {
    families.push(fields.length > 0
      ? `a collection that can return ${fields.join(', ')}`
      : 'a collection that can return the requested records');
  }
  if (gaps.includes('row_create')) {
    families.push('an app that can persist those records into the named destination');
  }
  if (gaps.includes('readback')) families.push('a read-back on the created destination');
  return `I understood the task, but none of your connected apps provide ${families.join(' or ')}. `
    + 'Connect or certify one that does — I will continue this exact request. Nothing was started.';
}

/**
 * Enumerate, select, and durably record this source's goal catalog. Idempotent
 * intent: callers invoke it only when the source has no authoritative
 * resolution yet.
 */
export async function recordConnectedGoalCatalog(input: {
  sessionId: string;
  sourceUserSeq: number;
  objective: string;
}): Promise<GoalCatalogSelection> {
  // COLD-BOOT PRIME: the connections registry is in-memory; the first turn
  // after a daemon restart would otherwise see ZERO connected toolkits and
  // false-block the goal families. Await one bounded registry load (it serves
  // from cache when fresh) before enumerating.
  if (!registryPort) {
    try { await listConnectedToolkits(); } catch { /* the peek below stays the honest view */ }
  }
  const selection = selectGoalCatalog(input.objective);
  if (selection.entries.length > 0) {
    recordAdmissionCapabilityResolution({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedInput: input.objective,
      entries: selection.entries,
    });
  }
  return selection;
}
