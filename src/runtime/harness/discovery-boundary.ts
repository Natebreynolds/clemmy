import { TOOL_REGISTRY } from '../../tools/tool-registry.js';
import { appendEvent } from './eventlog.js';
import { classifyAttemptOutcome, type AttemptSignals } from './attempt-outcome.js';
import { withLogicalToolCall } from './attempt-identity.js';
import { settleToolAttempt, type SettleToolAttemptInput } from './attempt-settlement.js';
import {
  discoveryGovernor,
  type DiscoveryAttemptOutcome,
  type DiscoveryCategory,
  type DiscoveryDecision,
} from './discovery-governor.js';

/**
 * One exact tool, one key; one unresolved requirement, one broad key.
 *
 * The same schema lookup arrives spelled a dozen ways — quoted, prefixed with
 * `select:`, carrying the `mcp__` transport, or buried in a sentence. Keying the
 * budget on the raw phrasing meant a model could ask about the same tool four
 * times and be charged four times, then be refused when it needed a different
 * tool. Canonical identity is the actual `server__tool` (or bare tool) name.
 */
export function canonicalExactSubject(raw: string): string {
  let value = raw.trim();
  // Strip a quoted wrapper, then a select: selector, then the transport prefix.
  value = value.replace(/^[`'"]+|[`'"]+$/g, '').trim();
  if (/^select:/i.test(value)) value = value.slice('select:'.length).trim();
  // A namespaced or underscored identifier anywhere in the phrase IS the
  // subject; the prose around it never was.
  const identifier = value.match(/[A-Za-z][A-Za-z0-9.:-]*(?:__[A-Za-z0-9._:-]+)+/)
    ?? value.match(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/);
  if (identifier?.[0]) value = identifier[0];
  value = value.replace(/^mcp__/i, '');
  return value.trim().toLowerCase().slice(0, 256);
}

/** Provider-neutral classification for a physical discovery operation. */
export interface DiscoveryCallClassification {
  category: DiscoveryCategory;
  /**
   * Which TOOL a schema refresh is about, or the opaque runtime-owned
   * requirement role for broad discovery. Query/provider text is never used as
   * identity. Legacy tasks without a role projection retain an empty subject.
   */
  subject: string;
  surface:
    | 'tool_search'
    | 'composio_search_tools'
    | 'composio_list_tools'
    | 'mcp_list_tools'
    | 'local_cli_list'
    | 'local_cli_probe'
    | 'provider_describe_slug'
    | 'code_mode_list_tools'
    | 'code_mode_describe';
}

export interface DiscoveryBoundaryLease extends DiscoveryCallClassification {
  sessionId: string;
  sourceUserSeq: number;
  callId: string;
  replay: boolean;
  turn?: number;
  attemptId?: string;
}

export interface AdmitDiscoveryBoundaryInput {
  sessionId?: string;
  sourceUserSeq?: number;
  turn?: number;
  attemptId?: string;
  toolName: string;
  input: unknown;
  callId: string;
  /** Optional lane provenance. Omission is inferred conservatively from the
   * host-visible carrier and never affects admission authority. */
  lane?: SettleToolAttemptInput['lane'];
}

const BUILTIN_TOOL_NAMES = TOOL_REGISTRY.map((entry) => entry.name);

function objectInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // A native ToolSearch adapter may pass the query itself as a string.
      return { query: input };
    }
  }
  return {};
}

const NATIVE_ROLE_PREFIX_RE = /^\s*\[role:([^\]\r\n]{1,128})\]\s*/i;

function explicitRoleKey(args: Record<string, unknown>): string {
  const value = [args.role_key, args.roleKey, args.requirement_role]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
  return value?.trim().slice(0, 128) ?? '';
}

/** Anthropic's built-in ToolSearch schema cannot be widened with role_key.
 * Its query therefore carries the same opaque key as a prefix. The prefix is
 * removed for exact-vs-broad classification; it never becomes query identity. */
function queryAndRole(args: Record<string, unknown>): { query: string; roleKey: string } {
  const raw = typeof args.query === 'string' ? args.query : '';
  const marker = raw.match(NATIVE_ROLE_PREFIX_RE);
  return {
    query: marker ? raw.slice(marker[0].length) : raw,
    roleKey: explicitRoleKey(args) || marker?.[1]?.trim().slice(0, 128) || '',
  };
}

/**
 * Strip transport namespaces without changing the provider operation itself.
 * Examples:
 *   mcp__clementine-local__tool_search -> tool_search
 *   clementine-local__local_cli_probe  -> local_cli_probe
 */
export function canonicalDiscoveryToolName(toolName: string): string {
  const trimmed = toolName.trim();
  const leaf = trimmed.includes('__') ? trimmed.split('__').at(-1) ?? trimmed : trimmed;
  return leaf.toLowerCase();
}

function explicitlyNamesBuiltinTool(query: string): boolean {
  for (const toolName of BUILTIN_TOOL_NAMES) {
    const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, 'i').test(query)) {
      return true;
    }
  }
  return false;
}

function exactToolIdentifierQuery(query: string): boolean {
  let value = query.trim().replace(/^[`'"]|[`'"]$/g, '');
  if (/^select:/i.test(value)) value = value.slice('select:'.length).trim();
  if (/^[a-z][a-z0-9.:-]*(?:(?:__|_)[a-z0-9.:-]+)+$/i.test(value)) return true;
  // "get me the schema for alpha__read_rows" names ONE tool as surely as the
  // bare identifier does. Charging that as a broad search spent the task's one
  // exploration on a lookup that explored nothing.
  const namespaced = value.match(/[A-Za-z][A-Za-z0-9.:-]*__[A-Za-z0-9._:-]+/g) ?? [];
  return new Set(namespaced.map((name) => name.toLowerCase())).size === 1;
}

/** A Composio action identifier, rather than a natural-language search. */
function exactProviderActionQuery(query: string): boolean {
  const value = query.trim();
  return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value)
    || /^cx_[a-z0-9]+(?:_[a-z0-9]+)+$/i.test(value);
}

function isDescribeSlug(slug: string): boolean {
  return /DESCRIBE|GET_.*SCHEMA|LIST_.*SCHEMA|GET_BASE_SCHEMA/i.test(slug);
}

/**
 * Classify only physical discovery/schema-inspection calls. Status tools and
 * `call_tool` are deliberately absent: status may be the requested business
 * read, while call_tool is only a carrier whose validated inner call re-enters
 * the wrapped boundary.
 */
export function classifyDiscoveryCall(
  toolName: string,
  input: unknown,
): DiscoveryCallClassification | null {
  const name = canonicalDiscoveryToolName(toolName);
  const args = objectInput(input);
  const scoped = queryAndRole(args);

  if (name === 'toolsearch' || name === 'tool_search') {
    const query = scoped.query;
    const exact = explicitlyNamesBuiltinTool(query) || exactToolIdentifierQuery(query);
    return {
      category: exact ? 'exact_schema_refresh' : 'broad_discovery',
      subject: exact ? canonicalExactSubject(query) : scoped.roleKey,
      surface: 'tool_search',
    };
  }

  if (name === 'composio_search_tools') {
    const query = typeof args.query === 'string' ? args.query : '';
    const exact = exactProviderActionQuery(query);
    return {
      category: exact ? 'exact_schema_refresh' : 'broad_discovery',
      subject: exact ? canonicalExactSubject(query) : '',
      surface: 'composio_search_tools',
    };
  }
  if (name === 'composio_list_tools') {
    return { category: 'broad_discovery', subject: '', surface: 'composio_list_tools' };
  }
  if (name === 'mcp_list_tools') {
    return { category: 'broad_discovery', subject: '', surface: 'mcp_list_tools' };
  }
  if (name === 'local_cli_list') {
    return { category: 'broad_discovery', subject: '', surface: 'local_cli_list' };
  }
  if (name === 'local_cli_probe') {
    const target = [args.name, args.command, args.binary]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return {
      category: 'exact_schema_refresh',
      subject: target ? canonicalExactSubject(target) : '',
      surface: 'local_cli_probe',
    };
  }
  if (name === 'clem.listtools') {
    return { category: 'broad_discovery', subject: '', surface: 'code_mode_list_tools' };
  }
  if (name === 'clem.describe') {
    // `clem.describe("read_file")` passes the tool name as a bare string, which
    // objectInput surfaces as `query`.
    const target = [args.name, args.tool, args.toolName, args.query]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return {
      category: 'exact_schema_refresh',
      subject: target ? canonicalExactSubject(target) : '',
      surface: 'code_mode_describe',
    };
  }

  // The static Composio carrier and dynamic cx_* first-class tools are the two
  // safe shapes where the provider action slug is explicit. Do not infer from
  // arbitrary tools containing "describe" — that would budget business reads.
  if (name === 'composio_execute_tool') {
    const slug = [args.tool_slug, args.toolSlug, args.slug]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (slug && isDescribeSlug(slug)) {
      return {
        category: 'exact_schema_refresh',
        subject: canonicalExactSubject(slug),
        surface: 'provider_describe_slug',
      };
    }
    return null;
  }
  if (name.startsWith('cx_') && isDescribeSlug(name.slice(3))) {
    return {
      category: 'exact_schema_refresh',
      subject: canonicalExactSubject(name.slice(3)),
      surface: 'provider_describe_slug',
    };
  }

  return null;
}

/**
 * Claude's parent can-use-tool hook sees both direct discovery calls and the
 * outer copies of static Composio tools whose MCP handlers already re-enter
 * wrapToolForHarness. This predicate prevents charging those wrapped statics
 * twice while keeping native ToolSearch/direct MCP helpers governable.
 */
export function isClaudeParentDiscoverySurface(toolName: string, input: unknown): boolean {
  if (!classifyDiscoveryCall(toolName, input)) return false;
  const name = canonicalDiscoveryToolName(toolName);
  return name !== 'composio_search_tools'
    && name !== 'composio_list_tools'
    && name !== 'composio_execute_tool';
}

function validTaskIdentity(
  sessionId: string | undefined,
  sourceUserSeq: number | undefined,
): sessionId is string {
  return Boolean(
    sessionId?.trim()
    && Number.isSafeInteger(sourceUserSeq)
    && (sourceUserSeq ?? 0) > 0,
  );
}

function emitDecisionTelemetry(
  decision: DiscoveryDecision,
  surface: DiscoveryCallClassification['surface'],
  attribution?: { turn?: number; attemptId?: string },
): void {
  try {
    appendEvent({
      sessionId: decision.key.sessionId,
      turn: Number.isSafeInteger(attribution?.turn) && (attribution?.turn ?? 0) > 0
        ? attribution!.turn as number
        : 0,
      role: 'system',
      type: decision.telemetry.eventName,
      data: {
        ...decision.telemetry.eventData,
        surface,
        ...(attribution?.attemptId?.trim() ? { attemptId: attribution.attemptId.trim() } : {}),
      },
    });
  } catch {
    // Admission authority is the governor row, never telemetry availability.
  }
}

export class DiscoveryBudgetDeniedError extends Error {
  constructor(
    public readonly category: DiscoveryCategory,
    public readonly surface: DiscoveryCallClassification['surface'],
    public readonly reason: string,
  ) {
    // THE DENIAL IS CORRECT; THE OLD INSTRUCTION WAS NOT FOLLOWABLE HERE.
    // `tool_search` is deliberately the ONE broker that transports a requirement
    // role — the alternate doors deny before provider I/O so a refused search
    // cannot simply be reissued through another carrier. But every door was
    // told to "use the exact unresolved role_key", and a door with no role field
    // cannot do that at all: composio_search_tools takes { query, toolkit_slug,
    // limit } and nothing else. A caller that reads that advice retries the same
    // shape — live 2026-08-14, four identical refusals on one turn before it
    // gave up and reissued through tool_search, which was admitted at once.
    // So name the door that works instead of asking for a key this one cannot
    // carry. The gate is unchanged; only what the caller is told changes.
    const roleBroker = surface === 'tool_search';
    const corrective = category === 'broad_discovery'
      ? reason === 'role_required'
        ? roleBroker
          ? 'Use the exact unresolved role_key shown in the current capability card; a broad search without runtime-owned requirement membership is unavailable.'
          : `${surface} cannot carry a requirement role, so no argument to it will satisfy this. Reissue the search through tool_search with the exact unresolved role_key shown in the current capability card; do not retry this tool.`
        : reason === 'role_resolved'
          ? 'This requirement already has a resolved capability. Execute that path; do not issue broad discovery for it.'
          : reason === 'role_not_unresolved'
            ? 'That role is not an unresolved requirement of this accepted task. Use a listed unresolved role_key or the already-resolved path.'
            : 'Use the capability or prior search result already resolved for this task; do not issue another broad search.'
      : 'Use the schema already returned for this task, correct the call from its validation error, or report the specific blocker; do not re-fetch schema again.';
    super(`discovery budget denied (${reason}) on ${surface}. ${corrective}`);
    this.name = 'DiscoveryBudgetDeniedError';
  }
}

function inferredDenialLane(
  input: AdmitDiscoveryBoundaryInput,
  classification: DiscoveryCallClassification,
): SettleToolAttemptInput['lane'] {
  if (input.lane) return input.lane;
  if (
    classification.surface === 'code_mode_list_tools'
    || classification.surface === 'code_mode_describe'
  ) return 'code_mode';
  if (canonicalDiscoveryToolName(input.toolName) === 'toolsearch') return 'claude_sdk';
  return 'agents_runner';
}

/** A refusal is still one logical tool call. Settle it at the central boundary
 * because provider wrappers return this typed error as a corrective before
 * their ordinary post-dispatch settlement edge. Creating/reusing the logical
 * frame here also covers Claude's permission callback and host code-mode
 * helpers, neither of which dispatches after this refusal. */
function terminalizeDiscoveryDenial(
  input: AdmitDiscoveryBoundaryInput,
  classification: DiscoveryCallClassification,
  denial: DiscoveryBudgetDeniedError,
): void {
  if (!validTaskIdentity(input.sessionId, input.sourceUserSeq)) return;
  try {
    withLogicalToolCall({
      sessionId: input.sessionId.trim(),
      sourceUserSeq: input.sourceUserSeq as number,
      logicalToolCallId: input.callId,
      tool: input.toolName,
      args: input.input,
    }, () => {
      settleToolAttempt({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        turn: input.turn,
        lane: inferredDenialLane(input, classification),
        toolName: input.toolName,
        callId: input.callId,
        args: input.input,
        mutating: false,
        businessCall: false,
        result: {
          ok: false,
          error: 'discovery_budget_denied',
          category: denial.category,
          surface: denial.surface,
          reason: denial.reason,
        },
        signals: { preDispatch: true, policyRefused: true },
      });
    });
  } catch {
    // The discovery refusal remains fail-closed if its terminal proof cannot be
    // written. A prior refined/settled carrier may already own this id; never
    // replace the original policy denial with bookkeeping prose.
  }
}

/**
 * Admit one physical discovery call for an accepted task. Legacy/out-of-band
 * callers without an exact positive task identity retain their prior behavior.
 * Once task identity exists, governor absence/failure is a recoverable
 * fail-closed refusal rather than unmetered discovery.
 */
export function admitDiscoveryBoundary(
  input: AdmitDiscoveryBoundaryInput,
): DiscoveryBoundaryLease | null {
  const classification = classifyDiscoveryCall(input.toolName, input.input);
  if (!classification) return null;
  if (!validTaskIdentity(input.sessionId, input.sourceUserSeq)) return null;

  let decision: DiscoveryDecision;
  try {
    decision = discoveryGovernor.admit({
      sessionId: input.sessionId.trim(),
      sourceUserSeq: input.sourceUserSeq as number,
      category: classification.category,
      subject: classification.subject,
      callId: input.callId,
    });
  } catch (error) {
    const denial = new DiscoveryBudgetDeniedError(
      classification.category,
      classification.surface,
      `governor_unavailable:${error instanceof Error ? error.name : 'unknown'}`,
    );
    terminalizeDiscoveryDenial(input, classification, denial);
    throw denial;
  }
  emitDecisionTelemetry(decision, classification.surface, {
    turn: input.turn,
    attemptId: input.attemptId,
  });
  if (!decision.admitted) {
    const denial = new DiscoveryBudgetDeniedError(
      classification.category,
      classification.surface,
      decision.reason,
    );
    terminalizeDiscoveryDenial(input, classification, denial);
    throw denial;
  }
  return {
    ...classification,
    subject: decision.subject,
    sessionId: decision.key.sessionId,
    sourceUserSeq: decision.key.sourceUserSeq,
    callId: decision.callId,
    replay: decision.replay,
    ...(Number.isSafeInteger(input.turn) && (input.turn ?? 0) > 0 ? { turn: input.turn as number } : {}),
    ...(input.attemptId?.trim() ? { attemptId: input.attemptId.trim() } : {}),
  };
}

/**
 * A search that came back empty or broken did not answer the question, and a
 * budget spent on a non-answer is not a reason to stop looking. Reopen the
 * epoch so the next attempt searches with a fresh allowance.
 *
 * This is bounded, not unlimited: an epoch only opens after one was actually
 * spent, and only the runtime's own settled outcome can trigger it. The model
 * has no way to ask for another budget.
 */
/** A search outcome expressed as the signals the shared kernel reads, so the
 *  decision to reopen is made in exactly one place for every lane. */
function searchSignals(outcome: DiscoveryAttemptOutcome): AttemptSignals {
  switch (outcome) {
    case 'succeeded': return { envelopeSuccessful: true };
    case 'empty': return { envelopeSuccessful: true, emptyResult: true };
    case 'timed_out': return { errorName: 'TimeoutError' };
    case 'failed': return { envelopeSuccessful: false };
    default: return {};
  }
}

function reopenEpochAfterUnproductiveSearch(
  lease: DiscoveryBoundaryLease,
  outcome: DiscoveryAttemptOutcome,
  detail?: string,
): void {
  const attempt = classifyAttemptOutcome(searchSignals(outcome));
  if (!attempt.directive.opensDiscoveryEpoch) return;
  try {
    const record = discoveryGovernor.recordEvidence({
      sessionId: lease.sessionId,
      sourceUserSeq: lease.sourceUserSeq,
      kind: attempt.kind === 'empty_result' ? 'candidate_unavailable' : 'candidate_unsupported',
      detail: detail ?? `${lease.surface}:${outcome}`,
    });
    if (record.outcome !== 'epoch_opened') return;
    appendEvent({
      sessionId: lease.sessionId,
      turn: lease.turn ?? 0,
      role: 'system',
      type: record.telemetry.eventName,
      data: {
        ...record.telemetry.eventData,
        surface: lease.surface,
        ...(lease.attemptId ? { attemptId: lease.attemptId } : {}),
      },
    });
  } catch {
    // A budget that fails to reopen leaves the task exactly as it was before
    // this call — never worse, and never a replaced provider result.
  }
}

/** Settlement records what the spent slot bought; an unproductive answer then
 * reopens the budget. Telemetry/storage failure is safe to contain after
 * provider dispatch. */
export function settleDiscoveryBoundary(
  lease: DiscoveryBoundaryLease | null | undefined,
  outcome: DiscoveryAttemptOutcome,
  detail?: string,
): void {
  if (!lease) return;
  try {
    const settlement = discoveryGovernor.settle({
      sessionId: lease.sessionId,
      sourceUserSeq: lease.sourceUserSeq,
      category: lease.category,
      subject: lease.subject,
      callId: lease.callId,
      outcome,
      detail,
    });
    try {
      appendEvent({
        sessionId: lease.sessionId,
        turn: lease.turn ?? 0,
        role: 'system',
        type: settlement.telemetry.eventName,
        data: {
          ...settlement.telemetry.eventData,
          surface: lease.surface,
          ...(lease.attemptId ? { attemptId: lease.attemptId } : {}),
        },
      });
    } catch {
      // Best-effort trace only.
    }
    // Only a freshly recorded outcome reopens anything. A replayed settlement
    // is the same fact arriving twice and must not mint a second budget.
    if (settlement.recorded) reopenEpochAfterUnproductiveSearch(lease, outcome, detail);
  } catch {
    // The admission claim is already durable/spent; never replace a provider
    // result with a settlement bookkeeping error.
  }
}
