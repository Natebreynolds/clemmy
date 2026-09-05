/**
 * tool_search — the schema-on-demand discovery entry.
 *
 * Given a natural-language query it ranks the compact tool catalog (derived from
 * TOOL_REGISTRY) and returns the top matches as names + one-liners, plus the FULL
 * JSON schema for the top few so the model can call a discovered tool correctly on
 * the first try. Every hit is recorded to the session hot-set so a searched tool is
 * promoted to a first-class schema next turn.
 *
 * READ-ONLY, no approval: it only reads the static registry + the tool schemas.
 * Registered on BOTH the MCP server (Claude Agent SDK lane) and the local runtime
 * (Codex/GLM lane), like every other built-in.
 *
 * It remains additive while `CLEMMY_CODEX_TOOL_SEARCH` is off. When the switch is
 * enabled, catalog discovery can replace most first-class schemas.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { hostStructuralPlanningControlLookup } from './structural-control-lookup.js';
import { maybeDiscoveryAdvisory } from '../runtime/harness/discovery-advisory.js';
import { textResult } from './shared.js';
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from '../runtime/harness/tool-output-format.js';
import { catalogEntries, rankCatalogLexically, type RankedCatalogEntry } from '../agents/tool-catalog.js';
import { uniqueWorkflowRunRequest } from './named-workflow-match.js';
import { peekConnectedToolkits } from '../integrations/composio/client.js';
import { registeredToolkitOfSlug } from '../integrations/composio/toolkit-slug.js';
import { relaxJsonSchemaForDeferred } from '../runtime/schema-normalizer.js';
import {
  AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
  issueAuthorizedLocalPlanningDisclosureCandidate,
  type LocalPlanningRefusalReason,
} from '../runtime/harness/local-planning-capability.js';
import {
  AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE,
  type AuthorizedLiveReadPlanningAuthorityV1,
} from '../runtime/harness/live-read-planning-authority.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import {
  readToolSearchContinuation,
  TOOL_SEARCH_CONTINUATION_MAX_ENTRIES as DURABLE_TOOL_SEARCH_CONTINUATION_MAX_ENTRIES,
  TOOL_SEARCH_CONTINUATION_MAX_ENTRY_BYTES,
  TOOL_SEARCH_CONTINUATION_MAX_SESSION_BYTES,
  writeToolSearchContinuation,
} from '../runtime/harness/eventlog.js';

/**
 * Models often serialize JSON null as the string `"null"` because the wire
 * schema advertises `cursor` as a required nullable string. That string is
 * not a host-issued continuation; treating it as one burned the one physical
 * discovery epoch and then refused the retry (live 2026-08-29 GLM: Salesforce
 * read never ran). Sentinels are omitted. Forged host-shaped cursors still fail.
 */
const TOOL_SEARCH_CURSOR_SENTINELS = new Set([
  'null',
  'undefined',
  'none',
  'nil',
  'n/a',
  'na',
]);

export function normalizeToolSearchCursor(cursor: string | null | undefined): string | null {
  if (cursor == null) return null;
  const trimmed = cursor.trim();
  if (!trimmed) return null;
  if (TOOL_SEARCH_CURSOR_SENTINELS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

function connectedToolkitSlugs(): Set<string> {
  try {
    return new Set(
      peekConnectedToolkits()
        .filter((toolkit) => (toolkit.status ?? '').toUpperCase() !== 'FAILED')
        .map((toolkit) => toolkit.slug.trim().toLowerCase())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function candidateToolkitConnected(name: string, connected: Set<string>): boolean {
  if (connected.size === 0) return false;
  try {
    return connected.has(registeredToolkitOfSlug(name).trim().toLowerCase());
  } catch {
    return false;
  }
}

/** Exact live-read acquisition for this query is not a peer of fuzzy broker
 * membership. A 0.05 memory nudge on a connected Composio row previously
 * outranked an acquired reviewed CLI (live 2026-08-28: GOOGLESHEETS_QUERY_TABLE
 * ranked above salesforce_sf_soql_query on "query Salesforce ... sf CLI"). */
const ACQUIRED_LIVE_READ_RANK_BOOST = 1;
const PLANNING_PROVIDER_RANK_BOOST = 2;
const CONNECTED_TOOLKIT_RANK_BOOST = 0.5;
/**
 * Her own catalog ranks in the SAME band as a provider row, so relevance
 * decides between them.
 *
 * Both rankers bound their base score to [0,1]. While this was 1 and the
 * planning provider boost was 2, providers occupied [2,3] and built-ins [1,2]
 * — so no built-in could outrank any provider at any relevance, which is the
 * defect the tiering comment below says was fixed on 2026-08-19
 * (APIFY_SCHEDULE_PUT over her own workflow_schedule). It regressed.
 *
 * Measured live 2026-08-28: "I need this to update please and refresh" against
 * a workspace returned twenty SALESFORCE_/ASANA_/SLACK_/APIFY_ rows and ZERO
 * space_* tools. Her workspace tools were not mis-ranked; they never entered
 * the window to be ranked at all.
 *
 * The value is 1.5, not 2, and the half matters: at 2 a maximally relevant
 * built-in TIES an acquired live read, collapsing the tier above it. At 1.5 the
 * bands are built-in [1.5,2.5], connected provider [2,3], acquired [3,4] — they
 * overlap enough for relevance to decide, and the acquired tier stays strictly
 * on top.
 *
 * Equal footing, not precedence: a provider row that is genuinely more relevant to
 * the query still wins. What can no longer happen is losing by construction.
 */
const OWN_CATALOG_RANK_BOOST = 1.5;

function isAcquiredLiveReadCandidate(
  candidate: Pick<ToolSearchBrokerCandidate, 'planningAuthority'> & {
    sourceKind?: ToolSearchCandidateSourceKind;
  },
): boolean {
  return candidate.sourceKind === AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE
    || candidate.planningAuthority != null;
}

function scoreDiscoveredSourceCandidate(
  candidate: ToolSearchBrokerCandidate & { sourceKind: ToolSearchCandidateSourceKind },
  index: number,
  count: number,
  input: { discloseForPlanning: boolean; connectedToolkitSlugs: Set<string> },
): number {
  const base = candidate.score ?? Math.max(0, 1 - (index / Math.max(1, count)));
  const planningOrConnected = input.discloseForPlanning
    ? PLANNING_PROVIDER_RANK_BOOST
    : candidateToolkitConnected(candidate.name, input.connectedToolkitSlugs)
      ? CONNECTED_TOOLKIT_RANK_BOOST
      : 0;
  const acquired = isAcquiredLiveReadCandidate(candidate) ? ACQUIRED_LIVE_READ_RANK_BOOST : 0;
  return base + planningOrConnected + acquired;
}

const TOP_RESULTS = 8;
const TOP_SCHEMAS = 3;
/** One physical broker search retains at most the same window the public
 * surface can request. A smaller first page therefore never makes rank nine
 * unreachable, while provider/catalog scans remain strictly bounded. */
export const TOOL_SEARCH_WINDOW_RESULTS = 20;
/** JSON text is chunked below the generic result ceiling so its enclosing JSON
 * remains intact even when every source character needs escaping. */
export const TOOL_SEARCH_SCHEMA_CHUNK_CHARS = 8_000;
/** Matches the provider-side schema file ceiling. Larger documents are refused
 * instead of turning schema discovery into an unbounded blob store. */
export const TOOL_SEARCH_SCHEMA_MAX_BYTES = TOOL_SEARCH_CONTINUATION_MAX_ENTRY_BYTES;
const TOOL_SEARCH_CONTINUATION_MAX_ENTRIES = DURABLE_TOOL_SEARCH_CONTINUATION_MAX_ENTRIES;
const TOOL_SEARCH_CONTINUATION_MAX_BYTES = TOOL_SEARCH_CONTINUATION_MAX_SESSION_BYTES;
const TOOL_SEARCH_PAGE_CURSOR_PREFIX = 'tool_search_page:v1:';
const TOOL_SEARCH_SCHEMA_CURSOR_PREFIX = 'tool_search_schema:v1:';
/** Bound on one live candidate source's search. Healthy provider searches
 *  answer in ~1-2s; the local catalog needs no network at all. Generous 10s
 *  keeps slow-but-alive sources contributing while a wedged one can no longer
 *  hold a discovery READ for the carrier's whole call window. */
export const CANDIDATE_SOURCE_SEARCH_DEADLINE_MS = 10_000;
/** Budget for the planning-disclosure materialization stage as a whole:
 *  generous against one slow candidate, fatal to a full-list walk of a slow
 *  provider (~3.3s/fetch measured live × 20 candidates = the 60s stalls). */
export const PLANNING_DISCLOSURE_DEADLINE_MS = 15_000;
/** Absolute broker budget. Per-source search and per-adapter disclosure remain
 * separately bounded below, but they also consume this one wall clock so a
 * future phase cannot silently stack another full allowance behind a slow
 * predecessor. Kept at half the 60s host-tool window to reserve settlement,
 * cancellation, and model-recovery time. */
export const TOOL_SEARCH_TOTAL_DEADLINE_MS = 30_000;

interface ToolSearchSchemaHandle {
  schema_ref: string;
  sha256: string;
  chars: number;
  bytes: number;
  cursor: string;
  encoding: 'json_text_chunks';
}

type StoredToolSearchContinuation =
  | { kind: 'page'; text: string; bytes: number }
  | { kind: 'schema'; text: string; bytes: number };

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Durable-session continuation store with a bounded per-broker fallback for
 * synthetic/no-session callers. Every payload remains content-addressed;
 * neither path permits a cursor to cross its issuing session. */
class ToolSearchContinuationStore {
  private readonly entries = new Map<string, StoredToolSearchContinuation>();
  private retainedBytes = 0;

  private memoryKey(cursor: string, sessionId?: string): string {
    return JSON.stringify([sessionId ?? null, cursor]);
  }

  private put(
    cursor: string,
    entry: StoredToolSearchContinuation,
    sessionId?: string,
  ): boolean {
    if (entry.bytes > TOOL_SEARCH_CONTINUATION_MAX_ENTRY_BYTES) return false;
    if (sessionId) {
      try {
        const digest = writeToolSearchContinuation({
          sessionId,
          kind: entry.kind,
          text: entry.text,
        });
        if (digest && cursor.includes(digest)) return true;
      } catch {
        // A transient/unavailable eventlog still leaves the current broker's
        // bounded fallback usable. It does not mint cross-process authority.
      }
    }

    const key = this.memoryKey(cursor, sessionId);
    const prior = this.entries.get(key);
    if (prior) {
      this.entries.delete(key);
      this.retainedBytes -= prior.bytes;
    }
    this.entries.set(key, entry);
    this.retainedBytes += entry.bytes;
    while (
      this.entries.size > TOOL_SEARCH_CONTINUATION_MAX_ENTRIES
      || this.retainedBytes > TOOL_SEARCH_CONTINUATION_MAX_BYTES
    ) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      const evicted = this.entries.get(oldest);
      this.entries.delete(oldest);
      this.retainedBytes -= evicted?.bytes ?? 0;
    }
    return this.entries.has(key);
  }

  storePage(text: string, sessionId?: string): string | undefined {
    const digest = sha256Text(text);
    const key = `${TOOL_SEARCH_PAGE_CURSOR_PREFIX}${digest}`;
    return this.put(key, { kind: 'page', text, bytes: Buffer.byteLength(text, 'utf8') }, sessionId)
      ? key
      : undefined;
  }

  storeSchema(schema: unknown, sessionId?: string): ToolSearchSchemaHandle | undefined {
    let text: string;
    try {
      text = JSON.stringify(schema);
    } catch {
      return undefined;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (!text || bytes > TOOL_SEARCH_SCHEMA_MAX_BYTES) return undefined;
    const digest = sha256Text(text);
    const key = `${TOOL_SEARCH_SCHEMA_CURSOR_PREFIX}${digest}`;
    if (!this.put(key, { kind: 'schema', text, bytes }, sessionId)) return undefined;
    return {
      schema_ref: `sha256:${digest}`,
      sha256: digest,
      chars: text.length,
      bytes,
      cursor: `${key}:0`,
      encoding: 'json_text_chunks',
    };
  }

  private durableText(
    sessionId: string | undefined,
    kind: StoredToolSearchContinuation['kind'],
    digest: string,
  ): string | null {
    if (!sessionId) return null;
    try {
      return readToolSearchContinuation({ sessionId, kind, digest });
    } catch {
      return null;
    }
  }

  private memoryEntry(cursor: string, sessionId?: string): StoredToolSearchContinuation | undefined {
    return this.entries.get(this.memoryKey(cursor, sessionId));
  }

  private refreshMemoryEntry(
    cursor: string,
    sessionId: string | undefined,
    entry: StoredToolSearchContinuation,
  ): void {
    const key = this.memoryKey(cursor, sessionId);
    if (!this.entries.has(key)) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  read(cursor: string, sessionId?: string): { text: string; isError?: boolean } {
    if (cursor.startsWith(TOOL_SEARCH_PAGE_CURSOR_PREFIX)) {
      const digest = cursor.slice(TOOL_SEARCH_PAGE_CURSOR_PREFIX.length);
      const durable = /^[a-f0-9]{64}$/.test(digest)
        ? this.durableText(sessionId, 'page', digest)
        : null;
      const entry = durable === null
        ? this.memoryEntry(cursor, sessionId)
        : { kind: 'page' as const, text: durable, bytes: Buffer.byteLength(durable, 'utf8') };
      if (
        !/^[a-f0-9]{64}$/.test(digest)
        || entry?.kind !== 'page'
        || sha256Text(entry.text) !== digest
      ) {
        return {
          text: JSON.stringify({
            error: 'invalid_or_expired_tool_search_cursor',
            hint: 'Use only the exact next_cursor returned in this durable session.',
          }),
          isError: true,
        };
      }
      this.refreshMemoryEntry(cursor, sessionId, entry);
      return { text: entry.text };
    }

    const match = cursor.match(/^tool_search_schema:v1:([a-f0-9]{64}):(\d{1,10})$/);
    if (!match) {
      return {
        text: JSON.stringify({
          error: 'invalid_or_expired_tool_search_cursor',
          hint: 'Use only a result next_cursor or schema_handles[*].cursor returned by this tool_search instance.',
        }),
        isError: true,
      };
    }
    const [, digest, rawOffset] = match;
    const key = `${TOOL_SEARCH_SCHEMA_CURSOR_PREFIX}${digest}`;
    const durable = this.durableText(sessionId, 'schema', digest);
    const entry = durable === null
      ? this.memoryEntry(key, sessionId)
      : { kind: 'schema' as const, text: durable, bytes: Buffer.byteLength(durable, 'utf8') };
    const offset = Number(rawOffset);
    if (
      entry?.kind !== 'schema'
      || sha256Text(entry.text) !== digest
      || !Number.isSafeInteger(offset)
      || offset < 0
      || offset >= entry.text.length
    ) {
      return {
        text: JSON.stringify({
          error: 'invalid_or_expired_tool_search_cursor',
          hint: 'Redeem schema chunks in order from the exact cursor returned with the schema handle.',
        }),
        isError: true,
      };
    }
    this.refreshMemoryEntry(key, sessionId, entry);
    const end = Math.min(entry.text.length, offset + TOOL_SEARCH_SCHEMA_CHUNK_CHARS);
    const nextCursor = end < entry.text.length
      ? `${TOOL_SEARCH_SCHEMA_CURSOR_PREFIX}${digest}:${end}`
      : undefined;
    return {
      text: JSON.stringify({
        kind: 'tool_search_schema_chunk',
        schema_ref: `sha256:${digest}`,
        sha256: digest,
        encoding: 'json_text_chunk',
        offset_chars: offset,
        chars: entry.text.length,
        bytes: entry.bytes,
        chunk: entry.text.slice(offset, end),
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
        complete: nextCursor === undefined,
      }),
    };
  }
}

const DESCRIPTION = [
  'Search the built-in tool catalog by intent: names + one-line summaries for the top matches, plus the complete JSON input schema for the closest few.',
  'Use it when the tool you need is not on your surface — say what you want to do (e.g. "schedule a recurring workflow", "spawn workers for N items") and follow the returned invocation hint.',
  'Read-only.',
].join(' ');

interface ToolSearchMetadata {
  schema: unknown;
  description: string;
}

export type ToolSearchDispatchCarrier = 'call_tool' | 'work_call';

export type ToolSearchCandidateSourceKind =
  | 'authorized_external_mcp'
  | 'authorized_composio'
  | typeof AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE
  | typeof AUTHORIZED_LOCAL_REGISTRY_PROVENANCE;

/** Provider adapters stay behind the one visible broker. A candidate is
 * capability context only: its host-selected carrier still performs every
 * dispatch/approval check. `invocation` represents adapters whose public
 * operation identity is wrapped by a stable business carrier (for example an
 * action slug passed to a generic executor) without teaching that shape to the
 * broker itself. */
/** A literal call the model can copy, with only the action arguments left to
 * fill. Live 2026-09-01: an abstract hint ("inner name/args_json of
 * work_call") plus a structured `invocation` object was not enough for GLM 5.3,
 * which put the action arguments where tool_slug belongs. */
export function renderCarrierInvocationExample(
  carrier: string,
  invocation: { name: string; fixedArgs?: Record<string, unknown>; payloadField?: string },
  capabilityRef?: string,
): {
  tool: string;
  args: {
    requirement_id?: string;
    source_call_ids?: null;
    source_record_ids?: null;
    name: string;
    args_json: string;
  };
} {
  const payloadField = invocation.payloadField ?? 'arguments';
  const inner = { ...(invocation.fixedArgs ?? {}), [payloadField]: { '<argument>': '<value>' } };
  const base = { name: invocation.name, args_json: JSON.stringify(inner) };
  // Direct tool-edge nomination is keyed by the opaque capability ref that
  // tool_search just disclosed. Keeping that ref beside the literal carrier
  // example prevents a second, contradictory grammar in
  // which the model copies a semantic role label (for example
  // "clause-8:write") into requirement_id and the host refuses the exact
  // write before dispatch. A frozen graph still overrides this selector with
  // its open operation id; the example grants no authority by itself.
  if (carrier === 'work_call' && capabilityRef?.startsWith('cap:')) {
    return {
      tool: carrier,
      args: {
        requirement_id: capabilityRef,
        source_call_ids: null,
        source_record_ids: null,
        ...base,
      },
    };
  }
  return { tool: carrier, args: base };
}

export interface ToolSearchBrokerCandidate {
  name: string;
  summary: string;
  schema?: unknown;
  carrier: ToolSearchDispatchCarrier;
  score?: number;
  guidance?: string;
  invocation?: {
    name: string;
    fixedArgs?: Record<string, unknown>;
    payloadField?: string;
  };
  /** Process-only nomination issued by a live-read source. The broker carries
   * it to the planning callback but never serializes it into model-visible
   * result JSON. */
  planningAuthority?: AuthorizedLiveReadPlanningAuthorityV1;
}

export interface ToolSearchCandidateSource {
  kind: ToolSearchCandidateSourceKind;
  search(input: {
    query: string;
    limit: number;
    signal?: AbortSignal;
    /** Absolute wall deadline owned by the broker. Adapters with multiple
     * internal reads should settle slightly before it so partial progress can
     * be returned instead of being discarded by the outer abort. */
    deadlineAt?: number;
  }): Promise<ToolSearchBrokerCandidate[]>;
}

/** A stable, repair-relevant reason a candidate source could not answer.
 * Never "the capability doesn't exist" — that is a real empty array. */
export type CandidateSourceUnavailableCode =
  | 'not_configured'
  | 'not_authenticated'
  | 'no_connections'
  | 'search_failed'
  | 'timed_out';

/**
 * Host-owned connection target attached by a configured candidate source.
 *
 * This is deliberately smaller than the model-visible dependency subject:
 * the broker adds the exact accepted query/role and source identity while it
 * serializes the canonical tool_search result. Candidate prose and a later
 * ask_user_question can never manufacture or widen these fields.
 */
export type CandidateSourceConnectionSubjectHint =
  | {
      kind: 'exact_capability_connection';
      toolkit: string;
      capability: string;
      capabilityRef: string;
    }
  | {
      kind: 'provider_reconnect_and_rerun';
    };

export type ToolSearchUnavailableConnectionSubjectV1 =
  | {
      version: 1;
      kind: 'exact_capability_connection';
      source: ToolSearchCandidateSourceKind;
      query: string;
      roleKey?: string;
      toolkit: string;
      capability: string;
      capabilityRef: string;
    }
  | {
      version: 1;
      kind: 'provider_reconnect_and_rerun';
      source: ToolSearchCandidateSourceKind;
      query: string;
      roleKey?: string;
    };

/**
 * A candidate source's `search()` throws this to report that the PROVIDER
 * did not answer — never that no matching capability exists. The two facts
 * were previously collapsed into the same empty array by every source's own
 * silent `return []`/`catch { return [] }`, and the caller could not tell a
 * live, connected capability that a search simply failed to reach from one
 * that genuinely does not exist (live 2026-08-26: Composio was fine, five
 * searches that could not reach it were, and the model was told nothing
 * matched instead of "could not reach Composio" — it then guessed a ref and
 * ten plan_task admissions were refused "not disclosed to this source").
 * Any OTHER throw is still treated as an unnamed instance of this same fact,
 * never as a reason to fail the whole tool_search call — a candidate source
 * is advisory breadth, never load-bearing.
 */
export class CandidateSourceUnavailableError extends Error {
  readonly code: CandidateSourceUnavailableCode;
  readonly connectionSubject?: CandidateSourceConnectionSubjectHint;

  constructor(
    code: CandidateSourceUnavailableCode,
    message: string,
    connectionSubject?: CandidateSourceConnectionSubjectHint,
  ) {
    super(message);
    this.name = 'CandidateSourceUnavailableError';
    this.code = code;
    this.connectionSubject = connectionSubject;
  }
}

function canonicalUnavailableConnectionSubject(input: {
  source: ToolSearchCandidateSourceKind;
  code: CandidateSourceUnavailableCode;
  query: string;
  roleKey?: string | null;
  hint?: CandidateSourceConnectionSubjectHint;
}): ToolSearchUnavailableConnectionSubjectV1 | undefined {
  if (input.code !== 'no_connections' && input.code !== 'not_authenticated') return undefined;
  const query = input.query.trim();
  const roleKey = input.roleKey?.trim() || undefined;
  if (!query || query.length > 240 || /[\u0000-\u001f\u007f]/.test(query)) return undefined;
  const common = {
    version: 1 as const,
    source: input.source,
    query,
    ...(roleKey && /^[a-z][a-z0-9_:-]{0,79}$/.test(roleKey) ? { roleKey } : {}),
  };
  if (input.hint?.kind === 'exact_capability_connection') {
    const toolkit = input.hint.toolkit.trim().toLowerCase();
    const capability = input.hint.capability.trim().toUpperCase();
    const capabilityRef = input.hint.capabilityRef.trim();
    if (
      /^[a-z0-9][a-z0-9_]{0,79}$/.test(toolkit)
      && /^[A-Z0-9][A-Z0-9_]{1,159}$/.test(capability)
      && capability.startsWith(`${toolkit.toUpperCase()}_`)
      && capabilityRef === `cap:resolved:${capability.toLowerCase()}`
    ) {
      return {
        ...common,
        kind: 'exact_capability_connection',
        toolkit,
        capability,
        capabilityRef,
      };
    }
  }
  // If the adapter could prove only the provider outage, retain exactly that
  // fact. A model may present a helpful example, but it cannot turn this
  // provider-neutral reconnect-and-rerun subject into a toolkit lease.
  return { ...common, kind: 'provider_reconnect_and_rerun' };
}

export interface ToolSearchPlanningDisclosureCandidate {
  name: string;
  carrier: ToolSearchDispatchCarrier;
  schema?: unknown;
  /** Exact adapter that produced this visible result. Candidate text cannot
   * manufacture this value; the broker attaches it while flattening the
   * configured host sources. */
  sourceKind: ToolSearchCandidateSourceKind;
  planningAuthority?: AuthorizedLiveReadPlanningAuthorityV1;
  /** Provider-neutral argument variants minted by the local registry. The
   * disclosure callback reopens their opaque host seal before any ref is made
   * visible; these public fields never grant authority by themselves. */
  capabilityVariants?: readonly {
    variantId: string;
    capabilityRef: string;
    reversibility: string;
    destructive: boolean;
    destinationPosture: 'create_new' | 'named_existing' | null;
  }[];
}

/** Model-visible identity evidence for the one current account that backed a
 * resolved provider row. This is descriptive only: it is deliberately absent
 * from every planning/execution input and cannot grant or widen authority. */
export interface ToolSearchSelectedAccountEvidence {
  toolkit: string;
  accountIdentity: string;
  accountIdentityKind: 'email' | 'connection_id';
  email?: string;
  label?: string;
}

// The provider staging boundary is the only place that has both the exact
// disclosure candidate object and a freshly resolved current connection. Keep
// that association process-private: candidate prose cannot manufacture it,
// callback return values cannot copy it onto a different row, and the public
// serializer below emits it only alongside the capabilityRef minted for this
// same object.
const selectedAccountEvidenceByCandidate = new WeakMap<
  ToolSearchPlanningDisclosureCandidate,
  ToolSearchSelectedAccountEvidence
>();

function boundedEvidenceText(value: string | null | undefined, maxChars: number): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > maxChars || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

/** Provider-staging seam. Attaching evidence does not affect ref disclosure,
 * account selection, planning admission, or dispatch. */
export function attachToolSearchSelectedAccountEvidence(
  candidate: ToolSearchPlanningDisclosureCandidate,
  input: {
    toolkit: string;
    email?: string;
    label?: string;
    connectionId?: string;
  },
): void {
  if (candidate.sourceKind !== 'authorized_composio' || candidate.carrier !== 'work_call') return;
  const toolkit = boundedEvidenceText(input.toolkit.toLowerCase(), 80);
  const possibleEmail = boundedEvidenceText(input.email?.toLowerCase().replace(/^smtp:/, ''), 320);
  const email = possibleEmail?.includes('@') ? possibleEmail : undefined;
  // An opaque connection id is useful only when the provider exposes no
  // stable mailbox identity. Never leak it in addition to a known email.
  const fallbackConnectionId = email
    ? undefined
    : boundedEvidenceText(input.connectionId, 256);
  const accountIdentity = email ?? fallbackConnectionId;
  if (!toolkit || !accountIdentity) return;
  const label = boundedEvidenceText(input.label, 160);
  selectedAccountEvidenceByCandidate.set(candidate, Object.freeze({
    toolkit,
    accountIdentity,
    accountIdentityKind: email ? 'email' : 'connection_id',
    ...(email ? { email } : {}),
    ...(label ? { label } : {}),
  }));
}

export interface ToolSearchPlanningBlocker {
  code: 'account_selection_required';
  /** Stable current identities the user can name on the next accepted turn.
   * Emails are preferred; an opaque connection id is used only when the
   * provider exposes no mailbox identity. */
  choices: readonly string[];
}

export interface ToolSearchPlanningDisclosureOutcome {
  version: 1;
  refs: Readonly<Record<string, string>>;
  blockers: Readonly<Record<string, ToolSearchPlanningBlocker>>;
}

function isPlanningDisclosureOutcome(
  value: unknown,
): value is ToolSearchPlanningDisclosureOutcome {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { version?: unknown }).version === 1
    && (value as { refs?: unknown }).refs
    && typeof (value as { refs?: unknown }).refs === 'object'
    && (value as { blockers?: unknown }).blockers
    && typeof (value as { blockers?: unknown }).blockers === 'object',
  );
}

export type ToolSearchBrokerCoverage = 'builtins_only' | 'authorized_external_v1';

/** Positive construction-time signal for the role governor. Partial provider
 * coverage deliberately reports builtins_only so unresolved external roles
 * retain the legacy compatibility route instead of being stranded. */
export function toolSearchBrokerCoverage(
  sources: readonly ToolSearchCandidateSource[] | undefined,
): ToolSearchBrokerCoverage {
  const kinds = new Set((sources ?? []).map((source) => source.kind));
  return (
    kinds.has(AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE)
    || kinds.has('authorized_external_mcp')
  ) && kinds.has('authorized_composio')
    ? 'authorized_external_v1'
    : 'builtins_only';
}

function dispatchHint(carrier: ToolSearchDispatchCarrier): string {
  return carrier === 'work_call'
    ? 'Invoke the selected result through work_call by copying its literal example. For one fresh standalone write, keep example.requirement_id equal to this result\'s exact capabilityRef — never replace it with role_key; the existing tool-edge allow/deny/ask path owns the decision. If a graph is already frozen, use its exact open operation id instead. Replace source_call_ids:null only when the write arguments consume or copy bytes from one settled model-visible result, using that exact function-call id; a prior read used only as a condition or decision is not content lineage and stays null.'
    : 'Invoke the selected result with call_tool(name, args_json), using the exact name and JSON schema above. Omit optional/nullable fields you do not need.';
}

function queryExplicitlyNamesTool(query: string, toolName: string): boolean {
  const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(query);
}

const JSON_SCHEMA_ANNOTATION_KEYS = new Set([
  '$schema',
  'description',
  'title',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

// Values of these keywords are maps keyed by user-authored property/schema
// names. A map entry named "description" is data, not an annotation keyword.
const JSON_SCHEMA_NAMED_MAP_KEYS = new Set([
  '$defs',
  'definitions',
  'dependentRequired',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);

// These keywords contain instance JSON, not nested schema nodes. Recursing as
// though they were schemas would corrupt legitimate values whose object keys
// happen to be named "description", "title", "default", and so on.
const JSON_SCHEMA_INSTANCE_VALUE_KEYS = new Set(['const', 'enum']);

function stripSchemaAnnotations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripSchemaAnnotations(item));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (JSON_SCHEMA_ANNOTATION_KEYS.has(key)) continue;
    if (JSON_SCHEMA_INSTANCE_VALUE_KEYS.has(key)) {
      out[key] = nested;
      continue;
    }
    if (
      JSON_SCHEMA_NAMED_MAP_KEYS.has(key)
      && nested
      && typeof nested === 'object'
      && !Array.isArray(nested)
    ) {
      out[key] = Object.fromEntries(
        Object.entries(nested as Record<string, unknown>)
          .map(([name, schema]) => [name, stripSchemaAnnotations(schema)]),
      );
      continue;
    }
    out[key] = stripSchemaAnnotations(nested);
  }
  return out;
}

/** Lazily-built, memoized name → schema/instructions map. Dynamic-imported so
 * this module (which the runtime tool registry imports) never forms an
 * eval-time import cycle. */
let metadataMapPromise: Promise<Map<string, ToolSearchMetadata>> | null = null;
async function toolMetadataMap(): Promise<Map<string, ToolSearchMetadata>> {
  if (!metadataMapPromise) {
    metadataMapPromise = (async () => {
      const map = new Map<string, ToolSearchMetadata>();
      try {
        const { getCoreTools } = await import('./registry.js');
        for (const t of getCoreTools() as Array<{ name?: string; description?: string; parameters?: unknown }>) {
          if (t?.name && t.parameters) {
            map.set(t.name, {
              schema: t.parameters,
              description: typeof t.description === 'string' ? t.description : '',
            });
          }
        }
      } catch {
        /* schemas are best-effort; names + one-liners still return */
      }
      return map;
    })();
  }
  return metadataMapPromise;
}

export function registerToolSearchTool(
  server: McpServer,
  opts: {
    allowedNames?: ReadonlySet<string>;
    /** Deferred results are intentionally absent from the advertised schema
     * surface and must be invoked through the generic same-turn dispatcher. */
    dispatchViaCallTool?: boolean;
    /** Action turns use the semantic carrier instead of advertising a second,
     * unbound business dispatcher. Omitted preserves the legacy call_tool hint. */
    dispatchCarrier?: ToolSearchDispatchCarrier;
    /** A mixed action catalog keeps controls and business capabilities behind
     * different carriers. The registry-derived resolver lets one search return
     * the correct carrier per result without duplicating search schemas or
     * teaching provider/task-specific operation lists. */
    dispatchCarrierForName?: (name: string) => ToolSearchDispatchCarrier;
    /** Scope-bound provider adapters searched behind this same visible door. */
    candidateSources?: readonly ToolSearchCandidateSource[];
    /** Fresh-host planning only. The callback may return a capabilityRef only
     * after independently matching/materializing this metadata result against
     * the current host catalog. Candidate prose itself grants nothing. */
    discloseForPlanning?: (
      candidates: readonly ToolSearchPlanningDisclosureCandidate[],
      control?: Readonly<{ signal: AbortSignal; deadlineAt: number }>,
    ) => Promise<Readonly<Record<string, string>> | ToolSearchPlanningDisclosureOutcome>
      | Readonly<Record<string, string>>
      | ToolSearchPlanningDisclosureOutcome;
  } = {},
): void {
  const continuations = new ToolSearchContinuationStore();
  server.tool(
    'tool_search',
    DESCRIPTION,
    {
      query: z
        .string()
        .min(1)
        .max(400)
        .describe('What you want to do, in plain language.'),
      role_key: z
        .string()
        .min(1)
        .max(128)
        .nullable()
        .optional()
        .describe('Required on the wire. For broad discovery: one exact unresolved role_key from the current capability card; if no unresolved role is listed, pass null. For an exact tool-name schema refresh, pass null.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .nullable()
        .optional()
        .describe(`Ranked results to return (default ${TOP_RESULTS}).`),
      cursor: z
        .string()
        .max(160)
        .nullable()
        // Default keeps serialized pre-cursor calls/replays valid while the
        // Codex-strict schema still advertises a required nullable field.
        // Empty string is omitted — models emit "" for "no continuation"
        // (live 2026-08-29 GLM/Grok: min(1) 400'd the first discovery call).
        .default(null)
        .describe('next_cursor or schema_handles[*].cursor from a prior result in this session; null means the first page.'),
    },
    async ({ query, role_key, limit, cursor }: {
      query: string;
      role_key?: string | null;
      limit?: number | null;
      cursor?: string | null;
    }) => {
      const continuationSessionId = getToolOutputContext()?.sessionId;
      // A continuation is a read of bytes retained by an earlier admitted
      // search, never another discovery attempt. Invalid/expired cursors fail
      // locally and cannot fall through into a candidate source.
      const continuation = normalizeToolSearchCursor(cursor);
      if (continuation) {
        const continued = continuations.read(continuation, continuationSessionId);
        return textResult(continued.text, { isError: continued.isError });
      }
      // plan_task/work_call are host-owned controls, not business/provider
      // capabilities. Answer their narrowly recognized structural lookup
      // locally before any candidate source, schema materializer, or planning
      // disclosure callback can run. The result grants no capabilityRef; the
      // ordinary orchestrator lifecycle owns when their real schemas appear.
      const structuralControl = hostStructuralPlanningControlLookup(query);
      if (structuralControl) return textResult(JSON.stringify(structuralControl));
      const brokerDeadlineAt = Date.now() + TOOL_SEARCH_TOTAL_DEADLINE_MS;
      const remainingBrokerMs = (): number => Math.max(0, brokerDeadlineAt - Date.now());
      // An exact tool name is an explicit selection, not another fuzzy search
      // term. Resolve it against the policy-filtered catalog BEFORE semantic
      // ranking so a selected name never pays a cold embedding/model detour.
      // Once selected, neighboring guesses add no value: return only the exact
      // capability and its schema. Natural-language discovery still ranks the
      // whole allowed catalog below.
      const requestedLimit = Math.min(limit ?? TOP_RESULTS, TOOL_SEARCH_WINDOW_RESULTS);
      const scopedCatalog = catalogEntries({ allowedNames: opts.allowedNames });
      const exactEntry = scopedCatalog
        .find((entry) => queryExplicitlyNamesTool(query, entry.name));
      const exactKnownButDenied = !exactEntry && catalogEntries()
        .some((entry) => queryExplicitlyNamesTool(query, entry.name));
      // A uniquely named saved workflow plus execution text is an exact
      // selection of workflow_run — not a fuzzy hunt across Composio actors
      // (live 2026-08-29: "run my platform 49 workflow" ranked APIFY_RUN_ACTOR).
      const uniqueWorkflowRun = !exactEntry && uniqueWorkflowRunRequest(query)
        ? scopedCatalog.find((entry) => entry.name === 'workflow_run')
        : undefined;
      const exactNamedHit: RankedCatalogEntry | undefined = exactEntry
        ? { ...exactEntry, score: 1 }
        : uniqueWorkflowRun
          ? { ...uniqueWorkflowRun, score: 1 }
          : undefined;
      // Sources the provider itself could not answer, so the model is told
      // "could not reach X" and can retry — never silence that reads as "X
      // does not exist" (see CandidateSourceUnavailableError).
      const unavailable: Array<{
        source: ToolSearchCandidateSourceKind;
        code: CandidateSourceUnavailableCode;
        reason: string;
        dependencySubject?: ToolSearchUnavailableConnectionSubjectV1;
      }> = [];
      // An exact registered built-in is already resolved and never pays for
      // provider I/O. Provider adapters are consulted only for an unresolved
      // name/role, preserving the fast path and avoiding broad discovery after
      // an exact capability selection.
      const sourceCandidates = exactNamedHit || exactKnownButDenied
        ? []
        : (await Promise.all((opts.candidateSources ?? []).map(async (source) => {
            // A candidate source is advisory breadth, never load-bearing: the
            // local catalog always answers. Live 2026-08-25 (platform-49): a
            // provider-side search hung and held this READ for ten minutes —
            // the carrier's whole call window — because the only bound was
            // the transport timeout. A source that cannot answer inside the
            // deadline contributes nothing, exactly like one that throws — but
            // "contributes nothing" must not be laundered into "found
            // nothing"; both are recorded below instead of discarded.
            let deadline: ReturnType<typeof setTimeout> | undefined;
            const controller = new AbortController();
            try {
              const sourceBudgetMs = Math.min(
                CANDIDATE_SOURCE_SEARCH_DEADLINE_MS,
                remainingBrokerMs(),
              );
              if (sourceBudgetMs <= 0) {
                throw new CandidateSourceUnavailableError(
                  'timed_out',
                  `${source.kind} did not answer before the tool_search deadline.`,
                );
              }
              const sourceDeadlineAt = Date.now() + sourceBudgetMs;
              const candidates = await Promise.race([
                // A source may retain a larger bounded provider snapshot than
                // the visible limit (the Composio adapter does); whatever it
                // returns is paged locally and never fetched a second time.
                source.search({
                  query,
                  limit: requestedLimit,
                  signal: controller.signal,
                  deadlineAt: sourceDeadlineAt,
                }),
                new Promise<never>((_, reject) => {
                  deadline = setTimeout(
                    () => {
                      controller.abort();
                      reject(new CandidateSourceUnavailableError(
                        'timed_out',
                        `${source.kind} did not answer within ${sourceBudgetMs / 1000}s.`,
                      ));
                    },
                    sourceBudgetMs,
                  );
                }),
              ]);
              if (
                controller.signal.aborted
                || Date.now() >= sourceDeadlineAt
                || remainingBrokerMs() <= 0
              ) {
                throw new CandidateSourceUnavailableError(
                  'timed_out',
                  `${source.kind} answered after the tool_search deadline.`,
                );
              }
              // Truncating BEFORE scoring let a source's own ordering decide
              // what the ranker is ever allowed to see. The tier design above
              // (acquired [3,4] strictly over connected provider [2,3]) then
              // only ranks the survivors, so a broker answering a broad query
              // with a full window of provider rows evicts the acquired live
              // read that the design says must win — it "never entered the
              // window to be ranked at all", the same shape as the 2026-08-28
              // workspace incident one tier up.
              //
              // Live 2026-09-03 run 15: "run shell command Salesforce sf CLI
              // query prospects" returned twenty APIFY_/DATAFORSEO_/OPENAI_/
              // OUTLOOK_ rows and zero salesforce_sf_soql_query, while the
              // SAME sealed descriptor answered run 13's narrower "run shell
              // command salesforce sf cli". Two extra words in an otherwise
              // correct query silently lost a capability that was present,
              // connected and hash-verified, and the run did no work.
              //
              // Acquired rows are carried past the truncation instead. The
              // window stays bounded at TOOL_SEARCH_WINDOW_RESULTS, and
              // relevance still orders the survivors downstream.
              const sourced = candidates
                .filter((candidate) => candidate.name.trim() && candidate.summary.trim())
                .map((candidate) => ({
                  ...candidate,
                  summary: candidate.summary.trim().slice(0, 600),
                  sourceKind: source.kind,
                }));
              return [
                ...sourced.filter((candidate) => isAcquiredLiveReadCandidate(candidate)),
                ...sourced.filter((candidate) => !isAcquiredLiveReadCandidate(candidate)),
              ].slice(0, TOOL_SEARCH_WINDOW_RESULTS);
            } catch (error) {
              const code: CandidateSourceUnavailableCode = error instanceof CandidateSourceUnavailableError
                ? error.code
                : 'search_failed';
              unavailable.push({
                source: source.kind,
                code,
                reason: error instanceof CandidateSourceUnavailableError
                  ? error.message
                  : `${source.kind} raised an unexpected error during discovery.`,
                ...(() => {
                  const dependencySubject = canonicalUnavailableConnectionSubject({
                    source: source.kind,
                    code,
                    query,
                    roleKey: role_key,
                    ...(error instanceof CandidateSourceUnavailableError && error.connectionSubject
                      ? { hint: error.connectionSubject }
                      : {}),
                  });
                  return dependencySubject ? { dependencySubject } : {};
                })(),
              });
              return [];
            } finally {
              if (deadline) clearTimeout(deadline);
            }
          }))).flat();
      const exactSourceMatches = sourceCandidates.filter((candidate) =>
        queryExplicitlyNamesTool(query, candidate.name));
      const exactSourceHit = exactSourceMatches.length === 1
        ? exactSourceMatches[0]
        : undefined;
      const selectedExactly = exactSourceHit ?? exactNamedHit;
      const rankedBuiltins = selectedExactly
        ? []
        // Provider membership/schema acquisition already owns this control
        // call's bounded network budget. Embeddings are only an advisory
        // ordering signal, so the execution-critical broker uses the same
        // deterministic lexical fallback directly instead of stacking a cold
        // 2x10s embedding retry behind provider search (live 2026-08-27: that
        // stack turned the nominal 10s source bound into a 66s host timeout).
        : rankCatalogLexically(query, { allowedNames: opts.allowedNames });
      // TIERED RANKING (live 2026-08-19: APIFY_SCHEDULE_PUT outranked her own
      // workflow_schedule; live 2026-08-28: GOOGLESHEETS_QUERY_TABLE outranked
      // an acquired Salesforce CLI read). Exact live-read acquisition for this
      // query outranks fuzzy broker membership, which outranks her own catalog,
      // which outranks the rest — she cites the acquired how before the world's
      // noise.
      const connectedSlugs = connectedToolkitSlugs();
      const combined = selectedExactly
        ? [selectedExactly]
        : [
            ...sourceCandidates.map((candidate, index) => ({
              ...candidate,
              score: scoreDiscoveredSourceCandidate(
                candidate,
                index,
                sourceCandidates.length,
                {
                  discloseForPlanning: Boolean(opts.discloseForPlanning),
                  connectedToolkitSlugs: connectedSlugs,
                },
              ),
            })),
            ...rankedBuiltins.map((entry) => ({
              name: entry.name,
              summary: entry.oneLiner,
              score: (entry.score ?? 0) + OWN_CATALOG_RANK_BOOST,
            })),
          ].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
      const seen = new Set<string>();
      const rankedWindow = combined.filter((candidate) => {
        const key = candidate.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, TOOL_SEARCH_WINDOW_RESULTS);
      const metadataMap = await toolMetadataMap();
      const planningOutcomes: (ToolSearchPlanningDisclosureCandidate | { name: string; refused: LocalPlanningRefusalReason } | null)[] = opts.discloseForPlanning
        ? (await Promise.all(rankedWindow.map(async (candidate) => {
            const sourcedMatches = sourceCandidates.filter((entry) => entry.name === candidate.name);
            const sourced = sourcedMatches.length === 1 ? sourcedMatches[0] : undefined;
            if (sourced) {
              return {
                name: sourced.name,
                carrier: sourced.carrier,
                sourceKind: sourced.sourceKind,
                ...(sourced.schema !== undefined ? { schema: sourced.schema } : {}),
                ...(sourced.planningAuthority
                  ? { planningAuthority: sourced.planningAuthority }
                  : {}),
              } satisfies ToolSearchPlanningDisclosureCandidate;
            }
            // Local authority is issued only for an exact row on this scoped
            // broker's configured surface. The opaque issuance validates the
            // current deferred schema and structural registry semantics; fuzzy
            // text and a predictable name cannot manufacture the WeakMap seal.
            if (!opts.allowedNames) return null;
            const carrier = opts.dispatchCarrierForName?.(candidate.name)
              ?? opts.dispatchCarrier
              ?? (opts.dispatchViaCallTool ? 'call_tool' : null);
            if (!carrier) return null;
            return issueAuthorizedLocalPlanningDisclosureCandidate({
              name: candidate.name,
              carrier,
              configuredNames: opts.allowedNames,
            }).then((outcome) => (
              outcome && 'refused' in outcome
                ? { name: candidate.name, refused: outcome.refused }
                : outcome
            ));
          })))
        : [];
      // A refusal is KEPT, not dropped. It says the row cannot be CITED in a
      // plan; the row's own carrier still says whether it can be CALLED now.
      const planningRefusalByName = new Map(
        planningOutcomes
          .filter((outcome): outcome is { name: string; refused: LocalPlanningRefusalReason } => (
            outcome !== null && 'refused' in outcome
          ))
          .map((outcome) => [outcome.name, outcome.refused] as const),
      );
      const planningCandidates = planningOutcomes
        .filter((outcome): outcome is ToolSearchPlanningDisclosureCandidate => (
          outcome !== null && !('refused' in outcome)
        ));
      const planningCandidateByName = new Map(planningCandidates.map((candidate) => [candidate.name, candidate]));

      /**
       * Say what a ref-less row actually IS.
       *
       * Not citable is not not usable. The orchestrator routes exactly the
       * names that fail the planning gate to the call_tool dispatcher, so a
       * row whose carrier resolves to call_tool is dispatchable on THIS turn.
       * Stamping one flat `unsupported_unmaterialized` across every ref-less
       * row told the model the opposite, and it believed the label over the
       * carrier sitting beside it — live 2026-08-27 seq 90427.
       *
       * A destructive row is named as such and gets NO invitation: the reason
       * a plan will not carry it is the same reason a page must not nudge the
       * model to fire it. Everything else keeps the original status, because a
       * work_call-carrier row with no ref genuinely has no door on this turn.
       */
      const localPlanningRowStatus = (name: string): Record<string, unknown> => {
        const refused = planningRefusalByName.get(name);
        if (!refused) return { planningRefStatus: 'unsupported_unmaterialized' as const };
        if (refused === 'destructive' || refused === 'irreversible_or_unknown') {
          return { planningRefStatus: 'not_plannable_destructive' as const, planningRefusalReason: refused };
        }
        const carrier = opts.dispatchCarrierForName?.(name)
          ?? opts.dispatchCarrier
          ?? (opts.dispatchViaCallTool ? 'call_tool' : undefined);
        if (carrier === 'call_tool') {
          return { planningRefStatus: 'dispatch_now' as const, planningRefusalReason: refused };
        }
        return { planningRefStatus: 'unsupported_unmaterialized' as const, planningRefusalReason: refused };
      };

      // Planning disclosure materializes exact host refs, which can mean one
      // LIVE schema fetch per candidate — measured ~3.3s each against the
      // provider today, and five consecutive 60-second tool_search calls in
      // one live turn (2026-08-25, the team-slack-update request) were this
      // stage walking a candidate list with no budget. Discovery is a READ:
      // it answers with what materialized inside the budget, and the
      // existing no-materialized-ref copy stays honest about the rest.
      const planningDisclosure = opts.discloseForPlanning
        ? await (async (): Promise<ToolSearchPlanningDisclosureOutcome> => {
            // Materialize already-independent MCP/reviewed-local rows first,
            // then Composio's account-bound rows. The catalog mutation owner is
            // intentionally sequential: concurrent callbacks could each read
            // the same catalog snapshot and let the last writer erase the
            // other's newly disclosed descriptor. Every group consumes the
            // same absolute broker clock, so this does not stack unbounded
            // provider allowances.
            const independent = planningCandidates.filter((candidate) => (
              candidate.sourceKind !== 'authorized_composio'
            ));
            const composio = planningCandidates.filter((candidate) => (
              candidate.sourceKind === 'authorized_composio'
            ));
            const groups = [independent, composio].filter((group) => group.length > 0);
            const disclose = opts.discloseForPlanning!;
            const outcomes: Array<
              Readonly<Record<string, string>>
              | ToolSearchPlanningDisclosureOutcome
              | null
            > = [];
            for (const group of groups) {
              let timer: ReturnType<typeof setTimeout> | undefined;
              const controller = new AbortController();
              const groupBudgetMs = Math.min(
                PLANNING_DISCLOSURE_DEADLINE_MS,
                remainingBrokerMs(),
              );
              if (groupBudgetMs <= 0) {
                outcomes.push(null);
                continue;
              }
              const groupDeadlineAt = Date.now() + groupBudgetMs;
              try {
                const outcome = await Promise.race([
                  Promise.resolve(disclose(group, {
                    signal: controller.signal,
                    deadlineAt: groupDeadlineAt,
                  })).catch(() => null),
                  new Promise<null>((resolve) => {
                    timer = setTimeout(() => {
                      controller.abort();
                      resolve(null);
                    }, groupBudgetMs);
                  }),
                ]);
                outcomes.push(
                  controller.signal.aborted
                  || Date.now() >= groupDeadlineAt
                  || remainingBrokerMs() <= 0
                  ? null
                  : outcome,
                );
              } finally {
                if (timer) clearTimeout(timer);
              }
            }
            const refs: Record<string, string> = {};
            const blockers: Record<string, ToolSearchPlanningBlocker> = {};
            for (const outcome of outcomes) {
              if (outcome === null) continue;
              if (isPlanningDisclosureOutcome(outcome)) {
                Object.assign(refs, outcome.refs);
                Object.assign(blockers, outcome.blockers);
              } else {
                Object.assign(refs, outcome);
              }
            }
            return Object.freeze({
              version: 1,
              refs: Object.freeze({ ...refs }),
              blockers: Object.freeze({ ...blockers }),
            });
          })()
        : Object.freeze({ version: 1, refs: Object.freeze({}), blockers: Object.freeze({}) });
      const planningRefs: Readonly<Record<string, string>> = planningDisclosure.refs;
      const planningBlockers: Readonly<Record<string, ToolSearchPlanningBlocker>> = planningDisclosure.blockers;

      const schemaForName = (name: string): unknown => {
        const localPlanning = planningCandidateByName.get(name);
        if (
          localPlanning?.sourceKind === AUTHORIZED_LOCAL_REGISTRY_PROVENANCE
          && localPlanning.schema !== undefined
        ) {
          return localPlanning.schema;
        }
        const sourced = sourceCandidates.find((candidate) => candidate.name === name);
        if (sourced?.schema !== undefined) {
          return relaxJsonSchemaForDeferred(sourced.schema);
        }
        const metadata = metadataMap.get(name);
        if (metadata?.schema !== undefined) {
          return (opts.dispatchViaCallTool || opts.dispatchCarrier || opts.dispatchCarrierForName)
            ? relaxJsonSchemaForDeferred(metadata.schema)
            : metadata.schema;
        }
        return undefined;
      };

      const exactSourceCarrier = exactSourceHit?.carrier;
      const exactCarrier = exactSourceCarrier ?? (
        exactNamedHit && opts.dispatchCarrierForName
          ? opts.dispatchCarrierForName(exactNamedHit.name)
          : null
      );
      const hint = (() => {
        // A provider that did not answer must never read like a capability
        // that does not exist. Lead with this only when it plausibly explains
        // an otherwise-empty result — an exact/built-in hit already answered
        // the question and outranks a co-occurring unrelated outage.
        if (
          unavailable.length > 0
          && sourceCandidates.length === 0
          && !exactNamedHit
          && !exactKnownButDenied
        ) {
          const causes = unavailable.map((entry) => `${entry.source}: ${entry.reason}`).join(' | ');
          return `Could not reach: ${causes}. This is a provider/connection problem, not evidence the capability is missing — do not conclude it does not exist or invent a reference for it. Retry this search once, or tell the user the connection could not be reached if it keeps failing.`;
        }
        if (Object.keys(planningBlockers).length > 0) {
          const choices = [...new Set(Object.values(planningBlockers).flatMap((blocker) => blocker.choices))];
          return `Account selection is required before these provider results can receive a capabilityRef. Ask the user which exact connected account to use${choices.length ? ` (${choices.join(', ')})` : ''}; then repeat one search that names that account. Do not call plan_task or invent a capabilityRef before that search returns one.`;
        }
        if (opts.discloseForPlanning && Object.keys(planningRefs).length === 0) {
          // "No plan ref" is not "no door". The names below fail the plan-citation
          // gate, which is exactly what routes them to the call_tool dispatcher,
          // so they are invocable on this turn. Telling the model to refine
          // discovery here sent it back to search five times while it was
          // holding the tool with a full schema (live 2026-08-27, seq 90427).
          // Destructive rows are deliberately never named here — a page that
          // cannot plan them must not nudge the model to fire them either.
          const callableNow = rankedWindow
            .map((row) => row.name)
            .filter((name) => {
              const status = localPlanningRowStatus(name);
              return status.planningRefStatus === 'dispatch_now';
            });
          if (callableNow.length > 0) {
            return `None of these can be CITED in plan_task, but ${callableNow.length === 1 ? 'this one is' : 'these are'} directly invocable on this turn with call_tool(name, args_json): ${callableNow.join(', ')}. Each result carries its schema. Call what you need instead of re-searching; only refine discovery if none of them does the job.`;
          }
          return 'No returned candidate was materialized into an exact host capabilityRef. Do not cite these results in plan_task; refine discovery, choose another live result, or ask the user only for a genuinely missing connection/account/target choice.';
        }
        if (exactCarrier) return dispatchHint(exactCarrier);
        if (opts.dispatchCarrierForName) {
          return 'Each result includes its required carrier. Invoke control/recovery results with call_tool(name, args_json); invoke business results as the inner name/args_json of work_call. Never send a business result through call_tool. '
            + 'For a business result, args_json is ONE JSON string of {"tool_slug": "<the result name>", "arguments": {<the action arguments as an object>}} — copy the result\'s `example` and replace only the action arguments; do not serialize the arguments object a second time. For one fresh standalone write, keep example.requirement_id equal to that result\'s exact capabilityRef, never role_key; the tool edge owns allow/deny/ask. If a graph is already frozen, use its exact open operation id instead.';
        }
        const fixedCarrier = opts.dispatchCarrier
          ?? (opts.dispatchViaCallTool ? 'call_tool' : null);
        if (fixedCarrier) return dispatchHint(fixedCarrier);
        return opts.allowedNames
          ? 'Call one of the returned tools by name; every result is available on this turn\'s active surface.'
          : 'Call the tool you need by name. If a complete schema is behind schema_handles, read its ordered local chunks; this does not repeat provider discovery.';
      })();

      type RankedWindowRow = (typeof rankedWindow)[number];

      const selectedAccountForName = (name: string): ToolSearchSelectedAccountEvidence | undefined => {
        const candidate = planningCandidateByName.get(name);
        return candidate ? selectedAccountEvidenceByCandidate.get(candidate) : undefined;
      };

      const publicResult = (r: RankedWindowRow) => ({
          name: r.name,
          summary: ('summary' in r ? r.summary : r.oneLiner).slice(0, 600),
          ...(planningRefs[r.name]
            && (planningCandidateByName.get(r.name)?.capabilityVariants?.length ?? 0) <= 1
            ? { capabilityRef: planningRefs[r.name] }
            : {}),
          ...(planningRefs[r.name]
            && (planningCandidateByName.get(r.name)?.capabilityVariants?.length ?? 0) > 1
            ? {
                capabilityVariants: planningCandidateByName.get(r.name)!.capabilityVariants,
                capabilitySelection: 'Choose exactly one variant before plan_task; work_call arguments must match that frozen variant.',
              }
            : {}),
          ...(planningRefs[r.name] && planningCandidateByName.get(r.name)
            ? { planningProvenance: planningCandidateByName.get(r.name)!.sourceKind }
            : {}),
          ...(planningRefs[r.name] && selectedAccountForName(r.name)
            ? { selectedAccount: selectedAccountForName(r.name)! }
            : {}),
          ...(planningBlockers[r.name]
            ? {
                planningRefStatus: 'account_selection_required' as const,
                accountChoices: planningBlockers[r.name]!.choices,
              }
            : opts.discloseForPlanning && !planningRefs[r.name]
              ? localPlanningRowStatus(r.name)
              : {}),
          ...('carrier' in r && r.carrier
            ? { carrier: r.carrier }
            : opts.dispatchCarrierForName
              ? { carrier: opts.dispatchCarrierForName(r.name) }
              : opts.dispatchCarrier
                ? { carrier: opts.dispatchCarrier }
                : {}),
          ...('invocation' in r && r.invocation ? { invocation: r.invocation } : {}),
          ...('invocation' in r && r.invocation
            ? { example: renderCarrierInvocationExample(
                'carrier' in r && r.carrier
                  ? r.carrier
                  : (opts.dispatchCarrierForName?.(r.name) ?? opts.dispatchCarrier ?? 'work_call'),
                r.invocation,
                planningRefs[r.name]
                  && (planningCandidateByName.get(r.name)?.capabilityVariants?.length ?? 0) <= 1
                  ? planningRefs[r.name]
                  : undefined,
              ) }
            : {}),
      });

      const formatPage = (
        rows: readonly RankedWindowRow[],
        page: number,
        pageCount: number,
        nextCursor?: string,
      ): string => {
        // An exact selection gets only its selected schema. Natural-language
        // pages get up to three previews, exactly as the original surface did.
        const schemaNames = selectedExactly
          ? rows.some((row) => row.name === selectedExactly.name)
            ? [selectedExactly.name]
            : []
          : rows.slice(0, TOP_SCHEMAS).map((row) => row.name);
        const schemas: Record<string, unknown> = {};
        for (const name of schemaNames) {
          const schema = schemaForName(name);
          if (schema !== undefined) schemas[name] = schema;
        }

        // Complex tools carry critical execution contracts beyond argument
        // shape. Broad discovery remains one-liners + schemas.
        const guidance: Record<string, string> = {};
        if (selectedExactly && rows.some((row) => row.name === selectedExactly.name)) {
          const sourceGuidance = sourceCandidates.find((candidate) => candidate.name === selectedExactly.name)
            ?.guidance;
          const description = sourceGuidance ?? metadataMap.get(selectedExactly.name)?.description;
          if (description) guidance[selectedExactly.name] = description;
        }

        const schemaHandles: Record<string, ToolSearchSchemaHandle> = {};
        const schemaHandleErrors: Record<string, { error: string; max_bytes: number }> = {};
        const ensureSchemaHandle = (name: string): void => {
          if (schemaHandles[name] || schemaHandleErrors[name] || schemas[name] === undefined) return;
          const handle = continuations.storeSchema(schemas[name], continuationSessionId);
          if (handle) schemaHandles[name] = handle;
          else {
            schemaHandleErrors[name] = {
              error: 'schema_exceeds_bounded_lossless_store_or_is_not_serializable',
              max_bytes: TOOL_SEARCH_SCHEMA_MAX_BYTES,
            };
          }
        };
        // REDUNDANT-DISCOVERY ADVISORY, delivered INSIDE the envelope.
        //
        // discovery-advisory.ts catches "searching one toolkit over and over
        // with progressively narrowed reformulations before committing", but it
        // was wired only to composio_search_tools / composio_list_tools — never
        // to tool_search, the lane the model actually uses. Live 2026-09-03 run
        // 27: five narrowing searches converging on a slug that does not exist,
        // while thirteen dispatchable operations from that toolkit sat in
        // results already returned. Zero business calls.
        //
        // It is a FIELD, not appended prose. Concatenating it corrupted this
        // JSON payload ("Unexpected non-whitespace character after JSON") —
        // exactly what the nestedDispatch guard on the fan-out advisory exists
        // to prevent. Structured signals ride the structure.
        //
        // The toolkit is derived from the rows returned, so no provider name
        // enters the code and the signal stays behavioural.
        const advisoryToolkit = (() => {
          for (const row of rows) {
            try {
              const slug = registeredToolkitOfSlug(row.name).trim().toLowerCase();
              if (slug) return slug;
            } catch { /* a built-in with no toolkit is not a discovery loop */ }
          }
          return '';
        })();
        const discoveryAdvisory = page === 1 && advisoryToolkit
          ? maybeDiscoveryAdvisory({
              kind: 'search',
              toolkit: advisoryToolkit,
              signature: query,
              sessionId: continuationSessionId,
            })
          : null;
        const render = (): string => JSON.stringify({
          query,
          ...(role_key ? { role_key } : {}),
          page,
          page_count: pageCount,
          total_results: rankedWindow.length,
          results: rows.map(publicResult),
          schemas,
          ...(Object.keys(schemaHandles).length > 0 ? { schema_handles: schemaHandles } : {}),
          ...(Object.keys(schemaHandleErrors).length > 0 ? { schema_handle_errors: schemaHandleErrors } : {}),
          ...(Object.keys(guidance).length > 0 ? { guidance } : {}),
          // A source that could not answer this query — a provider/connection
          // fact, distinct from and never implied by an empty `results`.
          ...(unavailable.length > 0 ? { unavailable } : {}),
          brokerCoverage: toolSearchBrokerCoverage(opts.candidateSources),
          hint,
          ...(discoveryAdvisory ? { discovery_advisory: discoveryAdvisory } : {}),
          ...(nextCursor ? {
            next_cursor: nextCursor,
            continuation_hint: 'Call tool_search again with this exact cursor and the same query. The next page is local and performs no provider search.',
          } : {}),
        });

        let text = render();
        const shownSchemaNames = [...schemaNames];
        if (text.length > DEFAULT_TOOL_RESULT_MAX_CHARS && selectedExactly) {
          const exactName = selectedExactly.name;
          if (schemas[exactName] !== undefined) {
            // Keep a compact structural preview when annotations are the only
            // reason it crossed the ceiling, but retain the original bytes
            // behind the content-addressed handle either way.
            ensureSchemaHandle(exactName);
            schemas[exactName] = stripSchemaAnnotations(schemas[exactName]);
            text = render();
          }
        }
        while (text.length > DEFAULT_TOOL_RESULT_MAX_CHARS && shownSchemaNames.length > 0) {
          const moved = shownSchemaNames.pop()!;
          ensureSchemaHandle(moved);
          delete schemas[moved];
          text = render();
        }
        // Guidance is useful but is not an argument contract. If an unusually
        // large instruction block alone breaches the result ceiling, omit it;
        // the exact schema remains inline or losslessly addressable.
        if (text.length > DEFAULT_TOOL_RESULT_MAX_CHARS && selectedExactly) {
          delete guidance[selectedExactly.name];
          text = render();
        }
        return text;
      };

      const pages: Array<readonly RankedWindowRow[]> = [];
      if (rankedWindow.length === 0) pages.push([]);
      for (let offset = 0; offset < rankedWindow.length; offset += requestedLimit) {
        pages.push(rankedWindow.slice(offset, offset + requestedLimit));
      }
      let nextCursor: string | undefined;
      for (let index = pages.length - 1; index >= 1; index -= 1) {
        const pageText = formatPage(pages[index]!, index + 1, pages.length, nextCursor);
        nextCursor = continuations.storePage(pageText, continuationSessionId);
      }
      const text = formatPage(pages[0]!, 1, pages.length, nextCursor);

      // Do not promote speculative search hits. The selected tool is promoted
      // after call_tool successfully dispatches it; promoting all three schema
      // previews made ordinary sessions grow their first-class surface on every
      // search even when two suggestions were never used.

      return textResult(text);
    },
  );
}

/** Test-only: reset the memoized schema map. */
export function _resetToolSearchSchemaCacheForTest(): void {
  metadataMapPromise = null;
}
