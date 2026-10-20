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
  | 'choose_other_capability'
  /** The call is right but needs the owner's decision: queue it once with the
   * same arguments so the turn opens the card, then stop. */
  | 'queue_for_approval'
  /** The host already staged the owner's card from this exact call; speak to
   * the owner in your own words and make no further call for it. */
  | 'speak_for_card';

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
  // Never a claim that the arguments are wrong: the refusal's own words name
  // the cause, and most refusals before dispatch are not argument faults
  // (live 2026-10-12..18: 13 runaway loops, 63 rewordings in one, each told
  // to "correct the named argument fields" of a call no argument could fix).
  repair_arguments: 'Change only what this refusal names on this same call, and retry it once. If it names something no argument can change, do not retry it: finish what you can and tell the owner in one line what is left.',
  discover_capability: 'Disclose the exact operation with tool_search first, then call it by its published ref.',
  choose_account: 'Resolve which connected account this acts as, then retry with that exact account.',
  publish_partial: 'The work is unresolved — publish the honest partial with its gaps named rather than gathering more.',
  ask_user: 'Ask the user this one exact question; it cannot be discovered.',
  choose_other_capability: 'This exact capability cannot serve this step — select a different one.',
  queue_for_approval: 'Queue this exact call once with pending_action_queue (same tool, same arguments, approvalIntent request_now, and ask: your own words to the owner — what you need to do and why, ending with the go-ahead question), then end the turn speaking to the owner, never about gates or the harness. Do not retry the call itself.',
  speak_for_card: 'The owner\'s card is already staged from this exact call. Say what you need to do and why their request needs it, in your own words, ending on the go-ahead question; make no further call for it.',
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

/** The edge for a refusal whose cause no argument can fix: the request's
 *  frozen plan has no step for this change (live 2026-10-16: 52 rewordings
 *  of one call in 48 minutes under a "correct the arguments" edge). */
export function planScopeRefusalEdge(diagnostic: string | undefined, toolName: string): HostNextEdgeV1 | undefined {
  if (!diagnostic || !diagnostic.includes('"work_requirement_unknown"')) return undefined;
  return nextEdge({
    tool: toolName,
    change: 'publish_partial',
    say: 'This request\'s plan has no step for this change, so changing its arguments cannot fix it. Bind it to an open step in `plan` only if it is that step\'s own work; otherwise do not retry it: finish the open steps and tell the owner in one line what is left and why.',
  });
}

/** The code a host consent refusal writes: `before dispatch (<code>).` */
const CONSENT_REFUSAL_CODE = /before dispatch \((coverage_missing|scope_mismatch|risk_unknown|schema_stale|authority_conflict|cardinality_spent|consent_preparation_unavailable)\)/;

/** A host refusal before dispatch, said as what it is: the real cause and the
 *  move that can succeed. The host writes every code read here; a refusal it
 *  does not recognise keeps the default edge, which claims no cause.
 *  `carrier` is the tool the model called (call_tool, work_call, or the
 *  operation itself); `toolName` is the operation it carried. */
export function truthfulRefusalEdge(input: {
  diagnostic: string | undefined;
  toolName: string;
  carrier: string;
}): HostNextEdgeV1 | undefined {
  const diagnostic = input.diagnostic ?? '';
  if (!diagnostic) return undefined;
  const planScope = planScopeRefusalEdge(diagnostic, input.toolName);
  if (planScope) return planScope;
  const consent = CONSENT_REFUSAL_CODE.exec(diagnostic)?.[1];
  switch (consent) {
    case 'coverage_missing':
      // Live 2026-10-18: space_refresh, workflow_state (a "get") and a
      // meeting save each sent through call_tool and refused this way 5-19
      // times. work_call binds a call to this request's work, and runs one
      // that only reads at once.
      return input.carrier === 'work_call'
        ? nextEdge({ tool: input.toolName, change: 'publish_partial',
          say: 'This change is not part of this request\'s accepted work, and changing its arguments cannot make it so. Do not retry it: finish the accepted work and tell the owner in one line what is left.' })
        : nextEdge({ tool: 'work_call', change: 'repair_arguments',
          say: `This call is a change, and only work_call binds a change to this request's work; its arguments are not the problem. Send this same call once through work_call, with name "${input.toolName}", the same arguments as args_json, and "${input.toolName}" as requirement_id. A call that only reads runs at once there.` });
    case 'scope_mismatch':
      return nextEdge({ tool: input.toolName, change: 'publish_partial',
        say: 'This call reaches beyond the work this request accepted (another target, account, amount or operation), so new arguments for it will be refused the same way. Do the accepted work; for anything beyond it, tell the owner in one line what else is needed.' });
    // The one run this request allows is claimed, by an earlier call or by a
    // sibling in this same step that may never have run. Claiming it done is
    // only true when that call's own result shows it.
    case 'cardinality_spent':
      return nextEdge({ tool: input.toolName, change: 'publish_partial',
        say: 'This change\'s one run for this request is already claimed, by an earlier call or by another call in this same step. Do not send it again. Say it is done only from that call\'s own result showing it succeeded; without one, tell the owner it has not been confirmed and what is left.' });
    case 'schema_stale':
      return nextEdge({ tool: 'tool_search', change: 'discover_capability',
        say: `The definition of ${input.toolName} changed since it was disclosed. Disclose it again with tool_search, called directly, then call it with its current schema.` });
    case 'risk_unknown':
      return nextEdge({ tool: 'tool_search', change: 'discover_capability',
        say: `The host could not read what ${input.toolName} would do from its current definition. Disclose the exact operation with tool_search, called directly, then call it by its published ref.` });
    case 'authority_conflict':
      return nextEdge({ tool: input.toolName, change: 'publish_partial',
        say: 'Another record already owns this change for this request, so no retry of it can run. Do not retry it: finish and tell the owner in one line what is left.' });
    case 'consent_preparation_unavailable':
      return nextEdge({ tool: input.toolName, change: 'reissue_unstarted',
        say: 'The host could not prepare this call\'s check; nothing ran and its arguments are not the problem. Send it once more unchanged; if it is refused the same way again, do not retry it: finish and tell the owner what is left.' });
    default:
      break;
  }
  if (diagnostic.includes('"error":"not_reachable"')) {
    return nextEdge({ tool: 'tool_search', change: 'discover_capability',
      say: `${input.toolName} is not carried on this turn as called, and changing its arguments cannot change that. Do what the refusal says: call tool_search directly, as its own tool call, to disclose the exact operation, then call it as disclosed.` });
  }
  if (diagnostic.includes(HOST_CALL_STOPPED_MARK)) {
    return nextEdge({ tool: input.toolName, change: 'reissue_unstarted',
      say: 'It changed nothing. If the error names an argument, fix that once; otherwise send it once more unchanged. If it fails the same way again, do not retry it: finish and tell the owner in one line what is left.' });
  }
  return undefined;
}

/** The mark a call that stopped before completing carries in its diagnostic
 *  (a host start failure, or a read that failed), with its own error. */
export const HOST_CALL_STOPPED_MARK = 'This call stopped before it completed';

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
