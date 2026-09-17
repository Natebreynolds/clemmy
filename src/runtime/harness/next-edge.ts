import { unwrapRuntimeEffectiveToolIdentity } from './tool-effect.js';

/**
 * THE NEXT EDGE — a refusal that cannot be recovered from is a dead end.
 *
 * The binding direction is "typed stop + next edge + resumable", and the stop
 * half has been typed for a long time: `HostToolDispositionOutput` carries a
 * disposition, an effect class, and `retry: 'replan' | 'do_not_retry'`. The
 * EDGE half was optional prose or absent. `retry: 'replan'` says try
 * differently; it never said HOW.
 *
 * One defect, five times on 2026-09-11..12:
 *
 *   - composio_search_tools found the operation and never said it was callable.
 *     The model searched for the same Google Doc read five times.
 *   - tool_choice_recall's static description says "CALL THIS FIRST": three
 *     calls against 813 searches.
 *   - Plan mode's instruction says publish promptly, at turn start. Ignored for
 *     thirty-three minutes.
 *   - publish_plan refused a partial draft with "Repair the listed fields" and
 *     never mentioned that `execution_draft: null` + `readiness: needs_input`
 *     publishes the honest partial. The model went back to gathering — the
 *     exact loop the refusal should have ended.
 *   - publish-plan.ts:108 carries a comment about the 2026-09-09 incident:
 *     five refusals whose message "never mentioned" the actual mismatch. Fixed
 *     locally then; the same class reappeared one branch over in the same file.
 *
 * That last one is why this is a shared primitive and not a sixth better
 * sentence. A message someone has to remember to write is a message that
 * regresses. A typed edge every recoverable refusal must carry does not.
 *
 * WHAT AN EDGE IS NOT. It grants nothing. Naming `publish_plan` as the next
 * tool does not make a plan valid, and naming an account choice does not bind
 * one. Every gate still runs. The edge only removes the guessing about what
 * move would satisfy the gate that just refused.
 */

/** The closed set of moves a refused caller can actually make. Prose is not a
 *  member: "try again properly" is the failure this replaces. */
export type NextEdgeChange =
  /** Host scheduling yielded before invocation; unchanged work remains valid. */
  | 'reissue_unstarted'
  /** The same tool, with specific argument fields changed. */
  | 'repair_arguments'
  /** The capability is not proven for this step; disclose it first. */
  | 'discover_capability'
  /** The operation is fine; the account is ambiguous or absent. */
  | 'choose_account'
  /** The work is genuinely unresolved — publish the honest partial instead. */
  | 'publish_partial'
  /** Only the user can supply the missing fact. */
  | 'ask_user'
  /** This exact capability cannot serve; a different one must. */
  | 'choose_other_capability';

export interface NextEdgeFieldV1 {
  /** JSON-pointer-ish path into the tool's own arguments. */
  path: string;
  /** What that field must become, stated concretely. */
  set: string;
}

export interface HostNextEdgeV1 {
  version: 1;
  /** The exact tool to call next. Often the SAME tool — a repair is an edge. */
  tool: string;
  change: NextEdgeChange;
  /** Exact argument-shape changes, when the host knows them. */
  fields?: readonly NextEdgeFieldV1[];
  /** One sentence the model reads. Derived, never a substitute for the type. */
  say: string;
}

const DEFAULT_SAY: Record<NextEdgeChange, string> = {
  reissue_unstarted: 'Continue the unfinished work with a fresh call ID and the same arguments; reuse completed results.',
  repair_arguments: 'Correct the named argument fields on this same call and retry it once.',
  discover_capability: 'Disclose the exact operation with tool_search first, then call it by its published ref.',
  choose_account: 'Resolve which connected account this acts as, then retry with that exact account.',
  publish_partial: 'The work is unresolved — publish the honest partial with its gaps named rather than gathering more.',
  ask_user: 'Ask the user this one exact question; it cannot be discovered.',
  choose_other_capability: 'This exact capability cannot serve this step — select a different one.',
};

/** Build an edge. `say` is derived unless the caller knows something better;
 *  the TYPE is what consumers key on, so a nicer sentence never becomes the
 *  only place the next move lives. */
export function nextEdge(input: {
  tool: string;
  change: NextEdgeChange;
  fields?: readonly NextEdgeFieldV1[];
  say?: string;
}): HostNextEdgeV1 {
  const tool = input.tool.trim();
  return {
    version: 1,
    tool: tool || 'tool_search',
    change: input.change,
    ...(input.fields && input.fields.length > 0 ? { fields: input.fields.slice(0, 12) } : {}),
    say: (input.say ?? DEFAULT_SAY[input.change]).trim() || DEFAULT_SAY[input.change],
  };
}

/** The model-facing line. Kept in one place so every refusal in the system
 *  reads the same way and a model learns one recovery shape, not N. */
export function renderNextEdge(edge: HostNextEdgeV1): string {
  const fields = edge.fields && edge.fields.length > 0
    ? ` Set ${edge.fields.map((field) => `${field.path} = ${field.set}`).join('; ')}.`
    : '';
  return `NEXT: ${edge.say}${fields} Use \`${edge.tool}\`.`;
}

/** A recoverable refusal MUST carry an edge. Exported so the contract is
 *  checkable by consumers and by the suite, rather than trusted. */
export function isRecoverableWithoutEdge(
  retry: 'replan' | 'do_not_retry',
  edge: HostNextEdgeV1 | undefined,
): boolean {
  return retry === 'replan' && !edge;
}

/** The edge every `retry: 'replan'` disposition gets when its call site has
 *  not supplied a more exact one. A generic edge is still a typed edge: it
 *  names a tool and a move, which is strictly more than prose did. */
export function defaultDispositionEdge(input: {
  disposition: 'refused_pre_dispatch' | 'not_started' | 'effect_unknown';
  toolName: string;
}): HostNextEdgeV1 {
  if (input.disposition === 'not_started') {
    return nextEdge({
      tool: input.toolName,
      change: 'repair_arguments',
      say: 'A paired call in the same frame could not proceed, so this one never started. Replan from the paired results and reissue only what is still needed.',
    });
  }
  return nextEdge({ tool: input.toolName, change: 'repair_arguments' });
}

const WRAPPER_EDGE_TOOLS = new Set(['call_tool', 'work_call', 'composio_execute_tool']);

/** The tool an edge should name: the inner refused operation, never the
 * envelope it arrived in. Live 2026-09-11 named `call_tool` three times. */
export function edgeToolName(toolName: string, args?: unknown): string {
  const authored = toolName.trim();
  try {
    const inner = unwrapRuntimeEffectiveToolIdentity(toolName, args).toolName;
    const name = (typeof inner === 'string' && inner.trim() ? inner : authored).trim();
    return name || 'tool_search';
  } catch {
    return authored || 'tool_search';
  }
}

export function isWrapperEdgeTool(toolName: string): boolean {
  return WRAPPER_EDGE_TOOLS.has(toolName.trim());
}
