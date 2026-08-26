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
import { textResult } from './shared.js';
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from '../runtime/harness/tool-output-format.js';
import { catalogEntries, rankCatalog, type RankedCatalogEntry } from '../agents/tool-catalog.js';
import { peekConnectedToolkits } from '../integrations/composio/client.js';
import { registeredToolkitOfSlug } from '../integrations/composio/toolkit-slug.js';
import { relaxJsonSchemaForDeferred } from '../runtime/schema-normalizer.js';
import {
  AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
  issueAuthorizedLocalPlanningDisclosureCandidate,
} from '../runtime/harness/local-planning-capability.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import {
  readToolSearchContinuation,
  TOOL_SEARCH_CONTINUATION_MAX_ENTRIES as DURABLE_TOOL_SEARCH_CONTINUATION_MAX_ENTRIES,
  TOOL_SEARCH_CONTINUATION_MAX_ENTRY_BYTES,
  TOOL_SEARCH_CONTINUATION_MAX_SESSION_BYTES,
  writeToolSearchContinuation,
} from '../runtime/harness/eventlog.js';

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
  'Search the full built-in tool catalog by intent and get the tools that match — names + one-line summaries for the top results, plus the complete JSON input schema for the closest few so you can call them right the first time.',
  'Use this when the tool you need is not already on your surface: describe what you want to do (e.g. "schedule a recurring workflow", "read a clipped tool result", "spawn workers for N items") and follow the returned invocation hint.',
  'Read-only — searching never changes anything.',
].join(' ');

interface ToolSearchMetadata {
  schema: unknown;
  description: string;
}

export type ToolSearchDispatchCarrier = 'call_tool' | 'work_call';

export type ToolSearchCandidateSourceKind =
  | 'authorized_external_mcp'
  | 'authorized_composio'
  | typeof AUTHORIZED_LOCAL_REGISTRY_PROVENANCE;

/** Provider adapters stay behind the one visible broker. A candidate is
 * capability context only: its host-selected carrier still performs every
 * dispatch/approval check. `invocation` represents adapters whose public
 * operation identity is wrapped by a stable business carrier (for example an
 * action slug passed to a generic executor) without teaching that shape to the
 * broker itself. */
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
}

export interface ToolSearchCandidateSource {
  kind: ToolSearchCandidateSourceKind;
  search(input: { query: string; limit: number }): Promise<ToolSearchBrokerCandidate[]>;
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

  constructor(code: CandidateSourceUnavailableCode, message: string) {
    super(message);
    this.name = 'CandidateSourceUnavailableError';
    this.code = code;
  }
}

export interface ToolSearchPlanningDisclosureCandidate {
  name: string;
  carrier: ToolSearchDispatchCarrier;
  schema?: unknown;
  /** Exact adapter that produced this visible result. Candidate text cannot
   * manufacture this value; the broker attaches it while flattening the
   * configured host sources. */
  sourceKind: ToolSearchCandidateSourceKind;
}

export type ToolSearchBrokerCoverage = 'builtins_only' | 'authorized_external_v1';

/** Positive construction-time signal for the role governor. Partial provider
 * coverage deliberately reports builtins_only so unresolved external roles
 * retain the legacy compatibility route instead of being stranded. */
export function toolSearchBrokerCoverage(
  sources: readonly ToolSearchCandidateSource[] | undefined,
): ToolSearchBrokerCoverage {
  const kinds = new Set((sources ?? []).map((source) => source.kind));
  return kinds.has('authorized_external_mcp') && kinds.has('authorized_composio')
    ? 'authorized_external_v1'
    : 'builtins_only';
}

function dispatchHint(carrier: ToolSearchDispatchCarrier): string {
  return carrier === 'work_call'
    ? 'Invoke the selected result as the inner name/args_json of work_call. If the host already froze the contract, pass proposal:null. Otherwise the first work_call includes the complete provider-neutral semantic proposal and dispatches this first requirement in that same call; later calls use proposal:null.'
    : 'Invoke the selected result with call_tool(name, args_json), using the exact name and JSON schema above. Omit optional/nullable fields you do not need.';
}

function queryExplicitlyNamesTool(query: string, toolName: string): boolean {
  const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(query);
}

function stripSchemaAnnotations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSchemaAnnotations);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if ([
      '$schema',
      'description',
      'title',
      'examples',
      'default',
      'deprecated',
      'readOnly',
      'writeOnly',
    ].includes(key)) continue;
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
    ) => Promise<Readonly<Record<string, string>>> | Readonly<Record<string, string>>;
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
        .describe('What you want to do, in plain language. Ranked against every built-in tool.'),
      role_key: z
        .string()
        .min(1)
        .max(128)
        .nullable()
        .optional()
        .describe('Required on the wire. For broad discovery, copy one exact unresolved role_key from the current capability card; if no unresolved role is listed, pass null. For an exact tool-name schema refresh, pass null. This keys discovery admission; it does not affect ranking or grant execution authority.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .nullable()
        .optional()
        .describe(`How many ranked results to return (default ${TOP_RESULTS}).`),
      cursor: z
        .string()
        .min(1)
        .max(160)
        .nullable()
        // Default keeps serialized pre-cursor calls/replays valid while the
        // Codex-strict schema still advertises a required nullable field.
        .default(null)
        .describe('Opaque local next_cursor or schema_handles[*].cursor from a prior result in this durable session. Cursor reads survive broker restarts and never re-run provider discovery or mint new planning authority.'),
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
      if (cursor) {
        const continued = continuations.read(cursor, continuationSessionId);
        return textResult(continued.text, { isError: continued.isError });
      }
      // An exact tool name is an explicit selection, not another fuzzy search
      // term. Resolve it against the policy-filtered catalog BEFORE semantic
      // ranking so a selected name never pays a cold embedding/model detour.
      // Once selected, neighboring guesses add no value: return only the exact
      // capability and its schema. Natural-language discovery still ranks the
      // whole allowed catalog below.
      const requestedLimit = Math.min(limit ?? TOP_RESULTS, TOOL_SEARCH_WINDOW_RESULTS);
      const exactEntry = catalogEntries({ allowedNames: opts.allowedNames })
        .find((entry) => queryExplicitlyNamesTool(query, entry.name));
      const exactKnownButDenied = !exactEntry && catalogEntries()
        .some((entry) => queryExplicitlyNamesTool(query, entry.name));
      const exactNamedHit: RankedCatalogEntry | undefined = exactEntry
        ? { ...exactEntry, score: 1 }
        : undefined;
      // Sources the provider itself could not answer, so the model is told
      // "could not reach X" and can retry — never silence that reads as "X
      // does not exist" (see CandidateSourceUnavailableError).
      const unavailable: Array<{ source: ToolSearchCandidateSourceKind; reason: string }> = [];
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
            try {
              const candidates = await Promise.race([
                // A source may retain a larger bounded provider snapshot than
                // the visible limit (the Composio adapter does); whatever it
                // returns is paged locally and never fetched a second time.
                source.search({ query, limit: requestedLimit }),
                new Promise<never>((_, reject) => {
                  deadline = setTimeout(
                    () => reject(new CandidateSourceUnavailableError(
                      'timed_out',
                      `${source.kind} did not answer within ${CANDIDATE_SOURCE_SEARCH_DEADLINE_MS / 1000}s.`,
                    )),
                    CANDIDATE_SOURCE_SEARCH_DEADLINE_MS,
                  );
                }),
              ]);
              return candidates
                .filter((candidate) => candidate.name.trim() && candidate.summary.trim())
                .slice(0, TOOL_SEARCH_WINDOW_RESULTS)
                .map((candidate) => ({
                  ...candidate,
                  summary: candidate.summary.trim().slice(0, 600),
                  sourceKind: source.kind,
                }));
            } catch (error) {
              unavailable.push({
                source: source.kind,
                reason: error instanceof CandidateSourceUnavailableError
                  ? error.message
                  : `${source.kind} raised an unexpected error during discovery.`,
              });
              return [];
            } finally {
              if (deadline) clearTimeout(deadline);
            }
          }))).flat();
      const exactSourceHit = sourceCandidates.find((candidate) =>
        queryExplicitlyNamesTool(query, candidate.name));
      const selectedExactly = exactSourceHit ?? exactNamedHit;
      const rankedBuiltins = exactNamedHit
        ? [exactNamedHit]
        : await rankCatalog(query, { allowedNames: opts.allowedNames });
      // TIERED RANKING (live 2026-08-19: APIFY_SCHEDULE_PUT outranked her own
      // workflow_schedule for "update workflow schedule cron interval"). Her
      // own catalog outranks connected-app operations, which outrank
      // everything else — she finds what SHE has before the world's noise.
      const connectedSlugs = connectedToolkitSlugs();
      const combined = selectedExactly
        ? [selectedExactly]
        : [
            ...sourceCandidates.map((candidate, index) => ({
              ...candidate,
              score: (candidate.score ?? Math.max(0, 1 - (index / Math.max(1, sourceCandidates.length))))
                + (opts.discloseForPlanning
                  // The fresh planning broker is resolving missing executable
                  // roles. Exact live provider candidates must survive the
                  // bounded result card ahead of unrelated built-in controls;
                  // otherwise a dependent source can be the ninth item and
                  // plan_task can never cite it. This ranks disclosure only —
                  // stage/freeze still owns authority.
                  ? 2
                  : candidateToolkitConnected(candidate.name, connectedSlugs) ? 0.5 : 0),
            })),
            ...rankedBuiltins.map((entry) => ({
              name: entry.name,
              summary: entry.oneLiner,
              score: (entry.score ?? 0) + 1,
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
      const planningCandidates: ToolSearchPlanningDisclosureCandidate[] = opts.discloseForPlanning
        ? (await Promise.all(rankedWindow.map(async (candidate) => {
            const sourced = sourceCandidates.find((entry) => entry.name === candidate.name);
            if (sourced) {
              return {
                name: sourced.name,
                carrier: sourced.carrier,
                sourceKind: sourced.sourceKind,
                ...(sourced.schema !== undefined ? { schema: sourced.schema } : {}),
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
            });
          }))).filter((candidate): candidate is ToolSearchPlanningDisclosureCandidate => candidate !== null)
        : [];
      const planningCandidateByName = new Map(planningCandidates.map((candidate) => [candidate.name, candidate]));
      // Planning disclosure materializes exact host refs, which can mean one
      // LIVE schema fetch per candidate — measured ~3.3s each against the
      // provider today, and five consecutive 60-second tool_search calls in
      // one live turn (2026-08-25, the team-slack-update request) were this
      // stage walking a candidate list with no budget. Discovery is a READ:
      // it answers with what materialized inside the budget, and the
      // existing no-materialized-ref copy stays honest about the rest.
      let disclosureTimer: ReturnType<typeof setTimeout> | undefined;
      const disclosureExpired = Symbol('planning-disclosure-deadline');
      const planningRefs = opts.discloseForPlanning
        ? await Promise.race([
            opts.discloseForPlanning(planningCandidates),
            new Promise<typeof disclosureExpired>((resolve) => {
              disclosureTimer = setTimeout(() => resolve(disclosureExpired), PLANNING_DISCLOSURE_DEADLINE_MS);
            }),
          ]).then((outcome) => {
            if (disclosureTimer) clearTimeout(disclosureTimer);
            return outcome === disclosureExpired ? {} : outcome;
          })
        : {};

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
        if (opts.discloseForPlanning && Object.keys(planningRefs).length === 0) {
          return 'No returned candidate was materialized into an exact host capabilityRef. Do not cite these results in plan_task; refine discovery, choose another live result, or ask the user only for a genuinely missing connection/account/target choice.';
        }
        if (exactCarrier) return dispatchHint(exactCarrier);
        if (opts.dispatchCarrierForName) {
          return 'Each result includes its required carrier. Invoke control/recovery results with call_tool(name, args_json); invoke business results as the inner name/args_json of work_call. Never send a business result through call_tool.';
        }
        const fixedCarrier = opts.dispatchCarrier
          ?? (opts.dispatchViaCallTool ? 'call_tool' : null);
        if (fixedCarrier) return dispatchHint(fixedCarrier);
        return opts.allowedNames
          ? 'Call one of the returned tools by name; every result is available on this turn\'s active surface.'
          : 'Call the tool you need by name. If a complete schema is behind schema_handles, read its ordered local chunks; this does not repeat provider discovery.';
      })();

      type RankedWindowRow = (typeof rankedWindow)[number];
      const publicResult = (r: RankedWindowRow) => ({
          name: r.name,
          summary: ('summary' in r ? r.summary : r.oneLiner).slice(0, 600),
          ...(planningRefs[r.name] ? { capabilityRef: planningRefs[r.name] } : {}),
          ...(planningRefs[r.name] && planningCandidateByName.get(r.name)
            ? { planningProvenance: planningCandidateByName.get(r.name)!.sourceKind }
            : {}),
          ...(opts.discloseForPlanning && !planningRefs[r.name]
            ? { planningRefStatus: 'unsupported_unmaterialized' as const }
            : {}),
          ...('carrier' in r && r.carrier
            ? { carrier: r.carrier }
            : opts.dispatchCarrierForName
              ? { carrier: opts.dispatchCarrierForName(r.name) }
              : opts.dispatchCarrier
                ? { carrier: opts.dispatchCarrier }
                : {}),
          ...('invocation' in r && r.invocation ? { invocation: r.invocation } : {}),
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
