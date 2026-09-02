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

function decodeInner(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try { return asRecord(JSON.parse(raw)); } catch { return null; }
  }
  return asRecord(raw);
}

export function completeComposioCarrierArguments(
  outerArgumentsJson: string,
  provenEntries: readonly ProvenCompletionEntry[],
): CarrierCompletion | null {
  let outer: Record<string, unknown> | null;
  try { outer = asRecord(JSON.parse(outerArgumentsJson)); } catch { return null; }
  if (!outer || !isComposioGatewayName(outer.name)) return null;
  const usedArgsAlias = !('args_json' in outer) && 'args' in outer;
  const inner = decodeInner('args_json' in outer ? outer.args_json : outer.args);
  if (!inner) return null;

  const changes: string[] = [];
  let toolSlug = typeof inner.tool_slug === 'string' ? inner.tool_slug.trim() : '';
  const provenIdentifiers = new Set(
    provenEntries
      .filter((entry) => entry.kind === 'composio' && typeof entry.identifier === 'string')
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
    argumentsString = argumentsValue;
  } else if (asRecord(argumentsValue)) {
    argumentsString = JSON.stringify(argumentsValue);
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
