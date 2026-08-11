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
  matchToolChoicesForStep,
  matchInvalidatedToolChoices,
  type ToolChoiceKind,
} from '../../memory/tool-choice-store.js';
import type { VerifiedReadCapabilityOrigin } from '../../memory/verified-read-origin.js';
import { peekConnectedToolkits } from '../../integrations/composio/client.js';
import { appendEvent, listEvents } from './eventlog.js';
import { getRuntimeEnv } from '../../config.js';
import { discoveryGovernor } from './discovery-governor.js';
import { resolveActiveTaskContext } from './active-task-context.js';

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
  /** previously_failed only. */
  failedAt?: string;
  failureReason?: string;
  /** Effect evidence used to keep read/write memory from crossing asks. */
  effectClass?: 'read' | 'write' | 'unknown';
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
  const acceptedInput = normalizeAuthorityInput(accepted?.data.text);
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
    for (const m of matchToolChoicesForStep(text, { purpose: 'advertise', limit: 4 })) {
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
 * Render the resolution as a DATA block for the model. Facts first, then the
 * deterministic floor. Empty resolution renders nothing — no prompt tax on
 * turns with no capability history.
 */
export function renderCapabilityResolutionForContext(resolution: CapabilityResolution): string {
  if (resolution.entries.length === 0) return '';
  const lines: string[] = ['[capability resolution — runtime-resolved facts about THIS request]'];
  for (const e of resolution.entries) {
    const conn = e.connection === 'active' ? 'connection active'
      : e.connection === 'missing' ? 'NO ACTIVE CONNECTION'
        : e.connection === 'unknown' ? 'connection unverified'
          : null;
    if (e.status === 'proven') {
      lines.push(`✓ proven execution path: ${e.kind}:${e.identifier}`
        + `; learned intent label (metadata only, NOT callable): ${JSON.stringify(e.intent)}`
        + `${e.accountIdentity ? ` (${e.accountIdentity})` : ''}${conn ? ` [${conn}]` : ''}`);
    } else {
      lines.push(`✕ previously failed: ${e.intent} — ${e.kind}:${e.identifier}`
        + `${e.failedAt ? ` (failed ${e.failedAt.slice(0, 10)}` : ''}`
        + `${e.failureReason ? `; ${e.failureReason}` : ''}${e.failedAt ? ')' : ''}${conn ? ` [${conn}]` : ''}`);
    }
  }
  lines.push(
    'Execution rule: for a proven composio path, call composio_execute_tool with the exact identifier as tool_slug. '
    + 'Never pass the learned intent label to call_tool, and never rediscover the same proven capability. ',
    'Floor: a previously-failed path must be re-verified with a cheap probe before you rely on it '
    + 'or ask for a go-ahead that assumes it — and say so. A toolkit with no active connection must be '
    + 'surfaced to the user, never worked around silently. Capabilities not listed are ordinary discovery.',
  );
  return lines.join('\n');
}
