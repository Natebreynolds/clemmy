/**
 * Complete a Composio carrier the model got structurally wrong, from facts
 * the host already holds. Live 2026-09-01 (GLM 5.3, "last three Slack
 * messages"): tool_search had just PROVEN SLACK_FETCH_CONVERSATION_HISTORY,
 * the model called work_call → composio_execute_tool with {channel, limit}
 * as the inner args — no tool_slug, no `arguments` wrapper — and the host
 * refused the frame. A harness that knows the answer and refuses the call is
 * the hoop, not the model.
 *
 * Three completions, all deterministic and all logged:
 *  1. no tool_slug and EXACTLY ONE composio READ proven this turn → bind it;
 *  2. action arguments given at the top level → wrapped into `arguments`;
 *  3. `arguments` given as an object → serialized once (the gateway schema
 *     takes a JSON string); the model never has to double-encode.
 * Anything ambiguous (zero or several proven reads, a non-object payload)
 * returns null and the ordinary refusal names the exact shape.
 */
import {
  registerCarrierCompleter,
  registerCarrierGatewayPredicate,
  type CarrierCompletion,
  type ProvenCompletionEntry,
} from './carrier-completion-registry.js';

export type { CarrierCompletion, ProvenCompletionEntry };


const GATEWAY_TAIL = 'composio_execute_tool';

function isComposioGatewayName(name: unknown): boolean {
  return typeof name === 'string'
    && (name === GATEWAY_TAIL || name.endsWith(`_${GATEWAY_TAIL}`) || name.endsWith(`:${GATEWAY_TAIL}`));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A model sometimes wraps the real provider arguments in an extra envelope:
 * `arguments: { "args": { channel, limit } }` (live 2026-09-02, GLM 5.3, a
 * Slack read — the provider then reports "/channel missing"). If a decoded
 * arguments object is exactly one `args`/`arguments` key wrapping an object,
 * unwrap it once. Deterministic; a real operation whose sole parameter is
 * literally named `args`/`arguments` and is an object is vanishingly rare and
 * the unwrapped call still validates against the provider schema. */
function unwrapDoubledArgsEnvelope(value: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(value);
  if (keys.length !== 1) return value;
  const only = keys[0]!;
  if (only !== 'args' && only !== 'arguments') return value;
  const inner = asRecord(value[only]);
  return inner ?? value;
}

function decodeInner(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try { return asRecord(JSON.parse(raw)); } catch { return null; }
  }
  return asRecord(raw);
}

/** A well-formed Composio operation slug: TOOLKIT_OPERATION, uppercase, single
 * underscores. */
const COMPOSIO_SLUG_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/** Normalize a bare operation NAME a model put in the carrier's `name` slot
 * (live 2026-09-02, GLM 5.3 cold chat: `googlesheets.batch_get`,
 * `slack.fetch_conversation_history`) to the canonical Composio slug —
 * uppercase, dots/spaces/hyphens to underscores, a doubled leading toolkit
 * collapsed. Returns null unless the result is a well-formed slug. The host
 * knows this operation; it should route it, not refuse it. Effect gating and
 * the write/send plan floor still apply to the routed call. */
function normalizeBareCompositeOperationName(
  name: unknown,
  provenIdentifiers: ReadonlySet<string>,
): string | null {
  if (typeof name !== 'string') return null;
  const raw = name.trim();
  if (!raw || raw === GATEWAY_TAIL || raw.endsWith(`_${GATEWAY_TAIL}`)) return null;
  // A namespaced/local carrier (mcp__server__tool, work_call, call_tool) is
  // never a bare provider op — leave it alone.
  if (raw.includes('__') || raw === 'work_call' || raw === 'call_tool') return null;
  const upper = raw.replace(/[.\s/-]+/g, '_').toUpperCase().replace(/^([A-Z0-9]+)_\1_/, '$1_');
  if (!COMPOSIO_SLUG_RE.test(upper)) return null;
  // A DOTTED name (`googlesheets.batch_get`) is unambiguously a provider
  // operation reference — a local tool never uses dots — so normalize it even
  // when nothing was proven this turn (the gateway/effect/plan path still
  // gates the routed call). An UNDERSCORED lowercase name (`read_file`,
  // `space_history`) is ambiguous with a local tool, so it is normalized ONLY
  // when it matches an operation actually proven or frozen this turn.
  if (raw.includes('.')) return upper;
  return provenIdentifiers.has(upper) ? upper : null;
}

export function completeComposioCarrierArguments(
  outerArgumentsJson: string,
  provenEntries: readonly ProvenCompletionEntry[],
): CarrierCompletion | null {
  let outer: Record<string, unknown> | null;
  try { outer = asRecord(JSON.parse(outerArgumentsJson)); } catch { return null; }
  if (!outer) return null;
  if (!isComposioGatewayName(outer.name)) {
    // The model named a provider operation directly in the carrier `name`
    // slot, in a non-canonical format the host could not resolve
    // ("not_reachable"). If it normalizes to a well-formed Composio slug,
    // rewrite the carrier into the gateway form and let the ordinary
    // gateway/effect/plan path take it. Anything else is left for the
    // ordinary refusal.
    const bareProven = new Set(
      provenEntries
        .filter((entry) => (entry.kind === 'composio' || entry.kind === 'frozen_scope') && typeof entry.identifier === 'string')
        .map((entry) => entry.identifier.trim().toUpperCase())
        .filter(Boolean),
    );
    const bareSlug = normalizeBareCompositeOperationName(outer.name, bareProven);
    if (!bareSlug) return null;
    const opArgs = 'args_json' in outer ? outer.args_json : ('args' in outer ? outer.args : undefined);
    let argumentsString: string | null;
    if (opArgs === null || opArgs === undefined) argumentsString = null;
    else if (typeof opArgs === 'string') argumentsString = opArgs;
    else if (asRecord(opArgs)) argumentsString = JSON.stringify(unwrapDoubledArgsEnvelope(asRecord(opArgs)!));
    else return null;
    const completedInner: Record<string, unknown> = { tool_slug: bareSlug, arguments: argumentsString };
    // Rewrite only the provider-routing fields. A carrier such as work_call
    // owns additional host contract bytes (requirement/universe/lineage); if
    // normalization drops them, the SDK sees a malformed outer call after the
    // host has already admitted its semantic provider identity. The malformed
    // wrapper then re-enters logical admission as `unknown` and poisons the
    // accepted root before any business crossing. Preserving opaque siblings
    // is provider-neutral: this adapter neither reads nor grants authority from
    // them, and the outer tool's exact schema still validates every field.
    const completedOuter: Record<string, unknown> = {
      ...outer,
      name: GATEWAY_TAIL,
      args_json: JSON.stringify(completedInner),
    };
    if (!('args_json' in outer) && 'args' in outer) delete completedOuter.args;
    return {
      argumentsJson: JSON.stringify(completedOuter),
      toolSlug: bareSlug,
      changes: [`carrier name "${String(outer.name)}" normalized to the composio operation ${bareSlug} and wrapped for the gateway`],
    };
  }
  const usedArgsAlias = !('args_json' in outer) && 'args' in outer;
  const inner = decodeInner('args_json' in outer ? outer.args_json : outer.args);
  if (!inner) return null;

  const changes: string[] = [];
  let toolSlug = typeof inner.tool_slug === 'string' ? inner.tool_slug.trim() : '';
  // Proven this turn (chat disclosure) or frozen into the step's scope (a
  // sealed workflow step names its operations before the model speaks).
  const provenIdentifiers = new Set(
    provenEntries
      .filter((entry) => (entry.kind === 'composio' || entry.kind === 'frozen_scope') && typeof entry.identifier === 'string')
      .map((entry) => entry.identifier.trim().toUpperCase())
      .filter(Boolean),
  );
  if (!toolSlug) {
    const provenReads = [...new Set(
      provenEntries
        .filter((entry) => entry.kind === 'composio' && entry.effectClass === 'read' && typeof entry.identifier === 'string')
        .map((entry) => entry.identifier.trim().toUpperCase())
        .filter(Boolean),
    )];
    if (provenReads.length !== 1) return null;
    toolSlug = provenReads[0]!;
    changes.push(`tool_slug bound to ${toolSlug}, the only operation proven this turn`);
  } else if (!provenIdentifiers.has(toolSlug.toUpperCase())) {
    // A doubled toolkit prefix (OUTLOOK_OUTLOOK_SEND_EMAIL for the proven
    // OUTLOOK_SEND_EMAIL) names the proven operation with one stutter; the
    // host completes it exactly as it completes a missing slug. Anything
    // else is left for the exact refusal — no fuzzy matching.
    const collapsed = toolSlug.toUpperCase().replace(/^([A-Z0-9]+)_\1_/, '$1_');
    if (collapsed !== toolSlug.toUpperCase() && provenIdentifiers.has(collapsed)) {
      changes.push(`tool_slug ${toolSlug} collapsed to the proven operation ${collapsed}`);
      toolSlug = collapsed;
    }
  }

  let argumentsValue: unknown;
  if ('arguments' in inner) {
    argumentsValue = inner.arguments;
  } else {
    const { tool_slug: _slug, connected_account_id: _account, ...rest } = inner;
    argumentsValue = rest;
    changes.push('top-level action arguments wrapped into arguments');
  }
  let argumentsString: string | null;
  if (argumentsValue === null || argumentsValue === undefined) {
    argumentsString = null;
  } else if (typeof argumentsValue === 'string') {
    const decodedStr = decodeInner(argumentsValue);
    const unwrappedStr = decodedStr ? unwrapDoubledArgsEnvelope(decodedStr) : null;
    if (decodedStr && unwrappedStr !== decodedStr) {
      argumentsString = JSON.stringify(unwrappedStr);
      changes.push('extra args envelope unwrapped');
    } else {
      argumentsString = argumentsValue;
    }
  } else if (asRecord(argumentsValue)) {
    const unwrapped = unwrapDoubledArgsEnvelope(asRecord(argumentsValue)!);
    if (unwrapped !== asRecord(argumentsValue)) changes.push('extra args envelope unwrapped');
    argumentsString = JSON.stringify(unwrapped);
    changes.push('arguments object serialized once');
  } else {
    return null;
  }
  if (usedArgsAlias) changes.push('args renamed to args_json');
  if (changes.length === 0) return null;

  const completedInner: Record<string, unknown> = {
    tool_slug: toolSlug,
    arguments: argumentsString,
    ...(typeof inner.connected_account_id === 'string' ? { connected_account_id: inner.connected_account_id } : {}),
  };
  const completedOuter: Record<string, unknown> = { ...outer, args_json: JSON.stringify(completedInner) };
  if (usedArgsAlias) delete completedOuter.args;
  return { argumentsJson: JSON.stringify(completedOuter), toolSlug, changes };
}

// Register with the provider-neutral registry the host kernel's seam consults.
registerCarrierCompleter(completeComposioCarrierArguments);
registerCarrierGatewayPredicate(isComposioGatewayName);
