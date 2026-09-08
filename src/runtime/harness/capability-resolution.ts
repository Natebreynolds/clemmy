/**
 * Typed capability resolution — the runtime resolves what this turn's ask can
 * rely on BEFORE the model speaks, so alignment is grounded in facts instead
 * of optimism.
 *
 * The live 2026-08-05 shape this exists for: the user asked for a scrape into
 * a sheet; the model asked ONE good user-question ("which metro?") — with
 * completely unverified capability. Its own memory held a proven procedure
 * for exactly that work, auto-invalidated three weeks earlier after three
 * failures, and nothing surfaced either fact. The user was about to approve a
 * plan the runtime already knew was shaky.
 *
 * Structural sources only — nothing in this control flow names a provider,
 * service, or task domain:
 *   • proven procedures  — the tool-choice store's advertise-tier matches
 *     against the user's OWN taught/learned memos;
 *   • failure history    — the same store's invalidated records (choice
 *     removed after repeated failures), matched by the same token machinery;
 *   • connection registry — the cached connected-toolkit snapshot, joined by
 *     the identifier's toolkit prefix. A missing registry is UNKNOWN, never
 *     "disconnected": absence of the registry is not absence of the account.
 *
 * The output is DATA: a typed table, persisted as a `capability_resolution`
 * event (UI + graph consumers) and rendered into the model context as facts
 * with a deterministic floor (re-verify failed paths; surface disconnected
 * toolkits). It grants nothing and blocks nothing — binding authority stays
 * with the live schema fetch and the effect gates at the tool boundary.
 */
import {
  matchInvalidatedToolChoices,
  type ToolChoiceKind,
} from '../../memory/tool-choice-store.js';
import type { VerifiedReadCapabilityOrigin } from '../../memory/verified-read-origin.js';
import type { SourceAccountRoutingEvidence } from '../../tools/source-account-routing.js';
import { peekConnectedToolkits } from '../../integrations/composio/client.js';
import { appendEvent, listEvents } from './eventlog.js';
import { getRuntimeEnv } from '../../config.js';
import { discoveryGovernor } from './discovery-governor.js';
import { resolveActiveTaskContext } from './active-task-context.js';
import { recallLearnedContracts, renderLearnedContracts } from '../../tools/tool-contract-recall.js';
import { lexicalCapabilityMatchesForRequest } from '../read-path/lexical-capability-matches.js';

export type CapabilityStatus = 'proven' | 'previously_failed';
export type ConnectionState = 'active' | 'missing' | 'unknown' | 'not_applicable';

export interface CapabilityResolutionEntry {
  intent: string;
  kind: ToolChoiceKind;
  identifier: string;
  status: CapabilityStatus;
  /** Joined from the connection registry for composio-kind capabilities. */
  connection: ConnectionState;
  accountIdentity?: string;
  /** Checked routing evidence, not consent. Scoped to exact accepted sources. */
  sourceAccountRouting?: SourceAccountRoutingEvidence;
  /** previously_failed only. */
  failedAt?: string;
  failureReason?: string;
  /** Effect evidence used to keep read/write memory from crossing asks. */
  effectClass?: 'read' | 'write' | 'unknown';
  /** CLI/MCP invoke hint when the matcher already resolved a command. */
  command?: string;
  /** Private continuity pointer. Persisted for the runtime resolver but never
   * rendered to the model or projected onto the public event plane. */
  verifiedReadOrigin?: VerifiedReadCapabilityOrigin;
}

export interface CapabilityResolution {
  entries: CapabilityResolutionEntry[];
  /** True when the registry snapshot was available for connection joins. */
  registryAvailable: boolean;
}

export interface ResolveTurnCapabilitiesOptions {
  /** Exact durable chat session. Enables continuation-only task enrichment. */
  sessionId?: string;
}

// A capability result can tighten discovery only when it was resolved from
// the exact accepted input that owns the budget. Keep that provenance out of
// the public/persisted result shape: context packets serialize resolutions,
// and the raw accepted input already has one durable home in the event log.
const resolutionInputByResult = new WeakMap<CapabilityResolution, string>();

function bindResolutionInput(
  resolution: CapabilityResolution,
  input: string,
): CapabilityResolution {
  resolutionInputByResult.set(resolution, input);
  return resolution;
}

/** Test-only: bind a fixture resolution to its accepted input so
 *  authoritativeForTask provenance behaves as the real resolver's output. */
export const _bindResolutionInputForTest = bindResolutionInput;

/**
 * Record a HOST-selected admission catalog as this source's authoritative
 * resolution. The entries come from the connected-registry enumeration (see
 * connected-goal-catalog.ts) — real connectivity, schema-grounded selection —
 * and the binding to the exact accepted input is what lets
 * authoritativeForTask hold, so host-bind is never starved on turn one of a
 * fresh session (live 2026-08-19 session-fixture-catalog-starvation).
 */
// Sources whose turn already started on the index-only catalog after the
// resolution deadline expired. The abandoned resolution leg keeps running
// (the fetch has no abort seam) and would otherwise land its AUTHORITATIVE
// write for a source that decided without it — observed live +64s after
// disclosure.
//
// Suppression is owned by the still-running leg, not by a capped FIFO of
// completed source tombstones. A FIFO made the 513th simultaneous timeout
// evict source one while its provider promise was still pending, allowing that
// older promise to publish late authority. Each abandoned leg now contributes
// one lifecycle token; it releases that token only after the leg settles. A
// genuinely wedged promise necessarily retains its small token because it is
// still capable of publishing. Completed legs leave no unbounded tombstone.
const supersededResolutionLegs = new Map<string, Set<symbol>>();

export function markAdmissionCapabilityResolutionSuperseded(
  sessionId: string,
  sourceUserSeq: number,
  untilSettled: PromiseLike<unknown>,
): void {
  const key = `${sessionId}#${sourceUserSeq}`;
  const token = Symbol(key);
  const tokens = supersededResolutionLegs.get(key) ?? new Set<symbol>();
  tokens.add(token);
  supersededResolutionLegs.set(key, tokens);
  const release = (): void => {
    const current = supersededResolutionLegs.get(key);
    if (!current) return;
    current.delete(token);
    if (current.size === 0) supersededResolutionLegs.delete(key);
  };
  // Attach both handlers directly instead of `.finally()`: a rejected
  // abandoned leg is expected degradation, and must not create a second
  // unhandled rejected promise merely to release its suppression token.
  void untilSettled.then(release, release);
}

export function recordAdmissionCapabilityResolution(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedInput: string;
  entries: CapabilityResolutionEntry[];
}): void {
  if (input.entries.length === 0) return;
  if (supersededResolutionLegs.has(`${input.sessionId}#${input.sourceUserSeq}`)) return;
  const resolution = bindResolutionInput(
    { entries: input.entries, registryAvailable: true },
    input.acceptedInput,
  );
  recordCapabilityResolution(input.sessionId, resolution, input.sourceUserSeq);
}

function normalizeAuthorityInput(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function resolutionBelongsToAcceptedTask(
  sessionId: string,
  sourceUserSeq: number,
  resolution: CapabilityResolution,
): boolean {
  const resolutionInput = normalizeAuthorityInput(resolutionInputByResult.get(resolution));
  if (!resolutionInput) return false;
  const [accepted] = listEvents(sessionId, {
    types: ['user_input_received'],
    sinceSeq: sourceUserSeq - 1,
    limit: 1,
  });
  if (accepted?.seq !== sourceUserSeq) return false;
  const acceptedDisplay = normalizeAuthorityInput(accepted?.data.displayText);
  const acceptedInput = acceptedDisplay ?? normalizeAuthorityInput(accepted?.data.text);
  return acceptedInput !== null && acceptedInput === resolutionInput;
}

/**
 * Only turns whose whole payload is a low-information continuation may borrow
 * task vocabulary. A substantive turn must stand entirely on its own words:
 * seeing "continue" somewhere inside a new request is not permission to blend
 * the prior task into capability resolution.
 */
const CLEAR_CONTINUATION_RE = /^(?:(?:please\s+)?(?:continue|proceed|resume|go\s+on|carry\s+on|keep\s+going|keep\s+working|keep\s+pushing(?:\s+forward)?|press\s+on|move\s+forward|go\s+ahead|next|next\s+step|do\s+the\s+next\s+step|what(?:['’]s|\s+is)\s+next|pick\s+(?:it|this|that)\s+up|pick\s+up\s+where\s+(?:we|you)\s+left\s+off)|let(?:['’]s|\s+us)\s+(?:continue|proceed|resume|keep\s+going|keep\s+pushing(?:\s+forward)?|press\s+on|move\s+forward))(?:\s+(?:please|thanks?|now))?[.!?]*$/i;

const CONTINUATION_QUERY_MAX_CHARS = 1_600;

function continuationCapabilityQuery(
  message: string,
  opts: ResolveTurnCapabilitiesOptions,
): string {
  const text = (message ?? '').trim();
  const sessionId = opts.sessionId?.trim();
  if (!text || !sessionId || !CLEAR_CONTINUATION_RE.test(text)) return text;

  try {
    const task = resolveActiveTaskContext({ sessionId, input: text });
    const parts: string[] = [text];
    const focus = task.focus;
    // The canonical projection may intentionally expose a cross-session focus
    // for a review/resume prompt. Capability carry-over is stricter: only an
    // explicitly same-session, fresh focus can explain a bare continuation.
    if (
      focus?.disposition === 'active'
      && focus.relatedSessionId === sessionId
    ) {
      parts.push(
        focus.workstate?.objective ?? '',
        focus.title,
        focus.summary ?? '',
      );
    }
    // resolveActiveTaskContext already proves exact-session goal ownership and
    // active status; no related_goal_id or global goal-list text is consulted.
    if (task.goal?.sessionId === sessionId) parts.push(task.goal.objective);

    const seen = new Set<string>();
    const enriched = parts
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .filter((part) => {
        if (!part) return false;
        const key = part.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .join(' ')
      .slice(0, CONTINUATION_QUERY_MAX_CHARS)
      .trim();
    return enriched || text;
  } catch {
    // Task projection is additive. A malformed focus/goal never makes basic
    // capability matching fail, nor does it authorize a broader fallback.
    return text;
  }
}

/** Toolkit slug implied by a composio identifier (`GOOGLESHEETS_BATCH_GET` →
 *  `googlesheets`). Purely lexical; used only to JOIN against the registry. */
function toolkitPrefix(identifier: string): string {
  return identifier.split('_')[0]?.toLowerCase() ?? '';
}

function connectionStateFor(
  kind: ToolChoiceKind,
  identifier: string,
  registry: ReadonlyArray<{ slug: string; status: string }>,
  registryAvailable: boolean,
): ConnectionState {
  if (kind !== 'composio') return 'not_applicable';
  if (!registryAvailable) return 'unknown';
  const prefix = toolkitPrefix(identifier);
  if (!prefix) return 'unknown';
  const forToolkit = registry.filter((c) => c.slug.toLowerCase() === prefix);
  if (forToolkit.length === 0) return 'missing';
  return forToolkit.some((c) => /active/i.test(c.status)) ? 'active' : 'missing';
}

/**
 * Resolve the turn's ask against the three structural sources. Synchronous
 * and cheap (store reads are mtime-cached; the registry is a peek) so both
 * brain lanes can run it at preflight without a network round trip.
 */
export function resolveTurnCapabilities(
  message: string,
  opts: ResolveTurnCapabilitiesOptions = {},
): CapabilityResolution {
  const resolutionInput = (message ?? '').trim();
  const text = continuationCapabilityQuery(resolutionInput, opts);
  if (!text) {
    return bindResolutionInput({ entries: [], registryAvailable: false }, resolutionInput);
  }
  let registry: ReturnType<typeof peekConnectedToolkits> = [];
  try {
    registry = peekConnectedToolkits();
  } catch {
    registry = [];
  }
  const registryAvailable = registry.length > 0;
  const entries: CapabilityResolutionEntry[] = [];
  const seen = new Set<string>();
  try {
    for (const m of lexicalCapabilityMatchesForRequest({ userInput: text, limit: 4 })) {
      const key = `${m.kind}:${m.identifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        intent: m.intent,
        kind: m.kind,
        identifier: m.identifier,
        status: 'proven',
        connection: connectionStateFor(m.kind, m.identifier, registry, registryAvailable),
        ...(m.accountIdentity ? { accountIdentity: m.accountIdentity } : {}),
        ...(m.effectClass ? { effectClass: m.effectClass } : {}),
        ...(m.command ? { command: m.command } : {}),
        ...(m.verifiedReadOrigin ? { verifiedReadOrigin: m.verifiedReadOrigin } : {}),
      });
    }
  } catch { /* resolution is additive context, never turn authority */ }
  try {
    for (const m of matchInvalidatedToolChoices(text, { limit: 3 })) {
      const key = `${m.kind}:${m.identifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        intent: m.intent,
        kind: m.kind,
        identifier: m.identifier,
        status: 'previously_failed',
        connection: connectionStateFor(m.kind, m.identifier, registry, registryAvailable),
        ...(m.failedAt ? { failedAt: m.failedAt } : {}),
        ...(m.reason ? { failureReason: m.reason } : {}),
        ...(m.effectClass ? { effectClass: m.effectClass } : {}),
      });
    }
  } catch { /* resolution is additive context, never turn authority */ }
  warmResolvedContracts(entries);
  return bindResolutionInput({ entries, registryAvailable }, resolutionInput);
}

/**
 * WARM the contracts for capabilities this ask already resolved.
 *
 * The resolution names the proven tools before the model takes its first step —
 * and then, live 2026-08-07, the model spent fifteen of forty-eight calls
 * searching for those very tools. Naming is not enough: the name arrives as
 * prose while the ARGUMENT SCHEMA does not, so "I know which tool" still costs
 * a discovery round trip to learn how to call it.
 *
 * Fetching a schema is I/O, not a decision. Doing it here — at preflight, off
 * the model's critical path, while it is still reading — converts that round
 * trip into a background request, and after the first time into nothing at all
 * because the contract is durable.
 *
 * Deliberately fire-and-forget: a warm that is slow, rate-limited, or failing
 * must never delay or fail the turn it was only trying to help. Every consumer
 * of a contract already fails open, so the worst case is exactly today's
 * behaviour.
 */
function warmResolvedContracts(entries: readonly CapabilityResolutionEntry[]): void {
  if (!contractWarmingEnabled() || entries.length === 0) return;
  // Only paths the runtime believes in: a previously-FAILED capability is not
  // worth a fetch, and a toolkit with no live connection cannot answer one.
  const warmable = selectWarmableContractIdentifiers(entries);
  if (warmable.length === 0) return;
  void (async () => {
    try {
      const { ensureToolSchema } = await import('../../tools/composio-schema-cache.js');
      // ensureToolSchema is already once-per-session and negative-cached, so a
      // slug the provider cannot describe costs one attempt, ever.
      await Promise.allSettled(warmable.map((slug) => ensureToolSchema(slug)));
    } catch { /* warming is an optimisation; it has no failure mode that matters */ }
  })();
}

export function selectWarmableContractIdentifiers(
  entries: readonly CapabilityResolutionEntry[],
): string[] {
  return entries
    .filter((e) => e.kind === 'composio' && e.status === 'proven' && e.connection !== 'missing')
    .map((e) => e.identifier)
    .filter(Boolean)
    .slice(0, MAX_WARMED_CONTRACTS);
}

/**
 * Preflight warming is speculative: the resolver can surface several plausible
 * procedures, but the turn normally dispatches only one of them. Warm only the
 * highest-ranked proven contract. The old ceiling of six let one accepted turn
 * issue six provider metadata requests before the model selected a capability,
 * which moved discovery cost off the model trace without actually removing it.
 * Any additional schema is still available through the exact on-demand path.
 */
const MAX_WARMED_CONTRACTS = 1;

function contractWarmingEnabled(): boolean {
  const v = (getRuntimeEnv('CLEMMY_WARM_TOOL_CONTRACTS', 'on') ?? 'on').trim().toLowerCase();
  return v !== 'off' && v !== '0' && v !== 'false' && v !== 'no';
}

/**
 * Persist the resolution as a typed event — the UI's live "what Clem knows
 * going in" frame and the graph's future admission input. One helper so both
 * brain lanes record identically. Best-effort: telemetry never breaks a turn.
 */
export function recordCapabilityResolution(
  sessionId: string,
  resolution: CapabilityResolution,
  sourceUserSeq?: number,
): void {
  let authoritativeForTask = false;
  // Discovery policy belongs to the accepted task, including the important
  // empty-resolution case (novel task => one broad lookup). Initialize at the
  // same pre-model seam on every brain. The governor independently verifies
  // that sourceUserSeq is this session's accepted user event.
  if (Number.isSafeInteger(sourceUserSeq) && (sourceUserSeq ?? 0) > 0) {
    try {
      // A retry/correction may reuse the accepted task identity while replacing
      // its model input with an internal verification prompt. Capabilities
      // matched from that prompt are useful context, but they are not evidence
      // that the accepted task's capability is known. Exact input provenance
      // still permits a later same-task continuation resolution to tighten the
      // initially novel policy monotonically.
      authoritativeForTask = resolutionBelongsToAcceptedTask(
        sessionId,
        sourceUserSeq as number,
        resolution,
      );
      discoveryGovernor.initializeTask({
        claimKeyVersion: 'exact_request_v1',
        sessionId,
        sourceUserSeq: sourceUserSeq as number,
        knownCapability: authoritativeForTask
          && resolution.entries.some((entry) => entry.status === 'proven'),
      });
    } catch { /* render-only probes and legacy fixtures do not own task authority */ }
  }
  if (resolution.entries.length === 0) return;
  try {
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'capability_resolution',
      data: {
        entries: resolution.entries,
        registryAvailable: resolution.registryAvailable,
        authoritativeForTask,
        ...(Number.isSafeInteger(sourceUserSeq) && (sourceUserSeq ?? 0) > 0 ? { sourceUserSeq } : {}),
      },
    });
  } catch { /* resolution telemetry must never break the turn */ }
}

/**
 * Consume the turn's proven resolution at the DECISION POINT.
 *
 * The resolver proves capabilities before the model speaks, but until now the
 * proof was only rendered as context prose — execution never read it. A model
 * that named the proven Composio identifier verbatim was refused as
 * "not reachable" and had to re-derive the carrier through failed calls (live
 * 2026-08-18: the host proved OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW with an
 * active connection and prepared arguments, then charged the model three
 * refusals to rediscover it).
 *
 * This maps a requested target back onto that proof: when the exact identifier
 * was PROVEN for this source with a connection that is not missing, the call
 * belongs on the composio carrier. It grants nothing — the carrier's full gate
 * chain (effect classification, confirm-first, grounding, settlement) still
 * owns safety; this only stops the harness refusing its own knowledge.
 */
export function provenComposioSlugForTurn(input: {
  sessionId: string;
  sourceUserSeq?: number;
  requestedTarget: string;
}): { slug: string } | null {
  const wanted = input.requestedTarget.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(wanted)) return null;
  // Proof scope: this session, at or before this source. The exact-source-only
  // rule made every PAID CONTINUATION turn unreachable-by-remap — live
  // 2026-08-18 session-fixture-remap-a seq 58306 ("FIRECRAWL_SEARCH is not a
  // deferred callable tool on this turn's surface") and
  // session-fixture-remap-b seq 58040: the
  // reply turn had no own-source resolution yet, so a PROVEN slug bounced.
  // The remap only rewrites the carrier; admission, effect, and once-guards
  // still govern the call. Cross-SESSION remap stays forbidden.
  if (!Number.isSafeInteger(input.sourceUserSeq)) return null;
  try {
    // listEvents({desc:true}) hands rows back in chronological order (desc
    // only changes which rows a LIMIT keeps), so walk the array from the end:
    // newest resolution first.
    const events = listEvents(input.sessionId, { types: ['capability_resolution'] });
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      const seq = event.data.sourceUserSeq;
      if (!Number.isSafeInteger(seq) || (seq as number) > (input.sourceUserSeq as number)) continue;
      // Internal verification retries record themselves as non-authoritative;
      // they may not authorize the carrier remap.
      if (event.data.authoritativeForTask === false) continue;
      const entries = Array.isArray(event.data.entries) ? event.data.entries as CapabilityResolutionEntry[] : [];
      for (const entry of entries) {
        if (
          entry.kind === 'composio'
          && entry.status === 'proven'
          && entry.connection !== 'missing'
          && typeof entry.identifier === 'string'
          && entry.identifier.trim().toUpperCase() === wanted
        ) {
          return { slug: entry.identifier.trim() };
        }
      }
      // Only the newest authoritative resolution for this source decides.
      break;
    }
  } catch { /* an unreadable ledger refuses nothing new — the caller keeps its refusal */ }
  return null;
}

/**
 * Render the resolution as a DATA block for the model. Facts first, then the
 * deterministic floor. Empty resolution renders nothing — no prompt tax on
 * turns with no capability history.
 */
export function renderCapabilityResolutionForContext(
  resolution: CapabilityResolution,
  opts?: {
    /**
     * The turn's ask text. When present, learned tool contracts (call shapes
     * that already succeeded on this machine) are recalled by token overlap
     * and appended as DATA. Contracts render even with zero capability
     * entries — a shape learned in another session must reach a fresh one.
     * This whole render rides the volatile turn tail on every lane; it must
     * never enter the cached system prefix.
     */
    focusInput?: string;
  },
): string {
  const contractBlock = opts?.focusInput ? renderContractRecall(opts.focusInput) : null;
  if (resolution.entries.length === 0) return contractBlock ?? '';
  const lines: string[] = ['[capability resolution — runtime-resolved facts about THIS request]'];
  for (const e of resolution.entries) {
    const conn = e.connection === 'active' ? 'connection active'
      : e.connection === 'missing' ? 'NO ACTIVE CONNECTION'
        : e.connection === 'unknown' ? 'connection unverified'
          : null;
    if (e.status === 'proven') {
      const invoke = e.kind === 'cli'
        ? '; invoke via run_shell_command'
        : e.kind === 'mcp'
          ? `; invoke the namespaced tool ${e.identifier}`
          : '';
      lines.push(`✓ proven execution path: ${e.kind}:${e.identifier}${invoke}`
        + `; learned intent label (metadata only, NOT callable): ${JSON.stringify(e.intent)}`
        + `${e.accountIdentity ? ` (${e.accountIdentity})` : ''}${conn ? ` [${conn}]` : ''}`);
    } else {
      lines.push(`✕ previously failed: ${e.intent} — ${e.kind}:${e.identifier}`
        + `${e.failedAt ? ` (failed ${e.failedAt.slice(0, 10)}` : ''}`
        + `${e.failureReason ? `; ${e.failureReason}` : ''}${e.failedAt ? ')' : ''}${conn ? ` [${conn}]` : ''}`);
    }
  }
  const hasCli = resolution.entries.some((entry) => entry.kind === 'cli' && entry.status === 'proven');
  const hasComposio = resolution.entries.some((entry) => entry.kind === 'composio' && entry.status === 'proven');
  lines.push(
    hasCli
      ? 'Execution rule: for a proven cli path, call run_shell_command with that command. Do not rediscover via Composio or MCP. '
      : hasComposio
        ? 'Execution rule: for a proven composio path, call composio_execute_tool with the exact identifier as tool_slug. '
        : 'Execution rule: invoke the proven identifier directly. ',
    'Never pass the learned intent label to call_tool. These rows are inventory, not a bound how — '
    + 'an unmatched or unreachable proven path does not close discovery. ',
    'Floor: a previously-failed path must be re-verified with a cheap probe before you rely on it '
    + 'or ask for a go-ahead that assumes it — and say so. A toolkit with no active connection must be '
    + 'surfaced to the user, never worked around silently. A capability not listed is an unresolved requirement: '
    + 'use the single discovery broker once for that requirement, not several provider-specific search surfaces.',
  );
  if (contractBlock) lines.push(contractBlock);
  return lines.join('\n');
}

/** Pure read over the on-disk contract store; a failure renders nothing. */
function renderContractRecall(focusInput: string): string | null {
  try {
    return renderLearnedContracts(recallLearnedContracts(focusInput));
  } catch {
    return null;
  }
}

/**
 * PROVISION FROM PROOF. The turn's own host-verified resolution entries,
 * readable as capability supply for semantic admission.
 *
 * Live 2026-08-18 (session-fixture-unprovisioned-catalog): the typed catalog was unprovisioned on the
 * live home (production packs refuse: identity_mismatch), so semantic
 * admission recorded "No host capabilities were supplied, so no operations
 * could be bound" — while THIS event, one read away, held proven
 * FIRECRAWL_SEARCH / GOOGLEDRIVE_LIST_FILES entries with live prepared
 * commands. Proof the host already produced for this exact accepted source is
 * capability supply; the brain must not rediscover it through tool_search.
 *
 * Scope guard: per accepted source only (same rule as
 * provenComposioSlugForTurn) — a prior turn's proof is not this turn's
 * authority. previously_failed entries are returned separately so the caller
 * can decide whether a stale cross-session failure still hides a slug.
 */
export function provenCapabilityEntriesForTurn(input: {
  sessionId: string;
  sourceUserSeq?: number;
}): CapabilityResolutionEntry[] {
  if (!Number.isSafeInteger(input.sourceUserSeq)) return [];
  try {
    // SUPPLY, not authority. Semantic admission runs BEFORE this turn's
    // resolver (live 2026-08-18 second breaker: ops=0 because the exact-source
    // proof did not exist yet at admission time), so descriptor supply may
    // draw on the session's LATEST authoritative resolution at or before this
    // source. Call authority stays strictly per accepted source
    // (provenComposioSlugForTurn) — supplying a candidate for citation grants
    // nothing: every actual call still crosses admission, effect, and
    // once-guards.
    const events = listEvents(input.sessionId, { types: ['capability_resolution'] });
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!;
      const seq = event.data.sourceUserSeq;
      if (Number.isSafeInteger(seq) && (seq as number) > (input.sourceUserSeq as number)) continue;
      if (event.data.authoritativeForTask === false) continue;
      const entries = Array.isArray(event.data.entries)
        ? event.data.entries as CapabilityResolutionEntry[]
        : [];
      return entries.filter((entry) =>
        entry.status === 'proven'
        && entry.connection !== 'missing'
        && typeof entry.identifier === 'string'
        && entry.identifier.trim().length > 0);
    }
    // Every Discord prompt opens a FRESH session (live 2026-08-18 breaker 3:
    // within-session supply always starved on turn one), so follow the same
    // prior-session trail the context builder already walks: the
    // cross_session_prefix row this session recorded at accept time. Still
    // supply, never authority — and only sessions the host itself linked.
    const prefix = [...listEvents(input.sessionId, { types: ['cross_session_prefix'] })].at(-1);
    const priorSessionIds = Array.isArray(prefix?.data.priorSessionIds)
      ? (prefix!.data.priorSessionIds as string[]).slice(0, 4)
      : [];
    for (const priorSessionId of priorSessionIds) {
      const priorEvents = listEvents(priorSessionId, { types: ['capability_resolution'] });
      for (let i = priorEvents.length - 1; i >= 0; i -= 1) {
        const event = priorEvents[i]!;
        if (event.data.authoritativeForTask === false) continue;
        const entries = Array.isArray(event.data.entries)
          ? event.data.entries as CapabilityResolutionEntry[]
          : [];
        const proven = entries.filter((entry) =>
          entry.status === 'proven'
          && entry.connection !== 'missing'
          && typeof entry.identifier === 'string'
          && entry.identifier.trim().length > 0);
        if (proven.length > 0) return proven;
      }
    }
    return [];
  } catch {
    return [];
  }
}
