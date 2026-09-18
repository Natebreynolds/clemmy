/** Reopen mode only from the exact durable accepted source, including workers. */
import { getSession, listEvents } from './eventlog.js';
import { parseTaskMode, taskModeDigest, type TaskMode } from './task-mode.js';
import { classifyRuntimeToolEffect, unwrapRuntimeEffectiveToolIdentity, type RuntimeToolEffect } from './tool-effect.js';
import { registeredToolSideEffect } from '../../tools/tool-registry.js';
import { declaredCliRepair } from '../../integrations/cli-catalog/catalog.js';

export function acceptedTaskMode(sessionId: string | undefined, sourceUserSeq: number | undefined): TaskMode | undefined {
  if (!sessionId || !Number.isSafeInteger(sourceUserSeq) || Number(sourceUserSeq) <= 0) return undefined;
  const source = listEvents(sessionId, { sinceSeq: Number(sourceUserSeq) - 1, types: ['user_input_received'], limit: 1 })
    .find(row => row.seq === sourceUserSeq);
  return parseTaskMode(source?.data.taskMode);
}
export function acceptedTaskModeIdentity(sessionId: string, sourceUserSeq: number): { mode: TaskMode | undefined; digest: string; principalId: string } {
  const mode = acceptedTaskMode(sessionId, sourceUserSeq);
  const session = getSession(sessionId);
  if (!session) throw new Error('task mode source session missing');
  return { mode, digest: taskModeDigest(mode), principalId: session.userId || session.id };
}
/** The one Plan-mode refusal sentence, shared by every seam that answers it. */
export function planModeReadOnlyRefusalText(name: string): string {
  return `PLAN_MODE_READ_ONLY: ${name} cannot execute in Plan mode. Investigate its schema and required arguments, then include the proposed action in publish_plan. The user can Execute the reviewed revision; no business effect or approval was started.`;
}
/** A `cli_setup` call naming a repair the catalog declares. Data, not a tool
 *  list: the catalog owns which repairs exist and what argv each one runs. */
function declaredCliRepairCall(name: string, args: unknown): boolean {
  if (name !== 'cli_setup' || !args || typeof args !== 'object' || Array.isArray(args)) return false;
  const call = args as Record<string, unknown>;
  if (call.action !== 'repair') return false;
  return declaredCliRepair(call.catalogId, call.repairId) !== null;
}

export function planModeCallRefusal(input: {
  mode: TaskMode | undefined; toolName: string; args: unknown; attestedEffect?: RuntimeToolEffect;
  /** The production host sealed this exact call (catalog entry, account,
   * schema), so consent can read its current risk. Unattested calls carry no
   * such fact and keep the plain effect ceiling. */
  attested?: boolean;
  /** Retained for callers that also enforce exact source authority. */
  identity?: { sessionId: string; sourceUserSeq: number };
  argumentsJson?: string;
}): string | undefined {
  if (input.mode?.kind !== 'plan') return undefined;
  const identity = unwrapRuntimeEffectiveToolIdentity(input.toolName, input.args);
  const name = identity.toolName ?? input.toolName;
  // These are bounded host operations, not business effects. Workers inherit
  // the same accepted source and therefore the same ceiling at their tool edge.
  if (['publish_plan', 'run_worker'].includes(name) && !identity.composioCarrier) return undefined;
  // CLASSIFY THE CALL THIS NAMES, NOT THE CARRIER AROUND IT.
  //
  // The name above is resolved through arbitrary nesting; the effect was read
  // off the RAW outer call, which unwraps only one level. At depth two they
  // disagree: a `call_tool` wrapping a `call_tool` classified `unknown`, which
  // is neither read nor host_only, so a plain status read was refused — and
  // the refusal then named the correctly-unwrapped tool, producing a message
  // that could not be acted on ("composio_status cannot execute in Plan mode"
  // about a call nothing had classified).
  //
  // Live 2026-09-11: a Plan turn was asked, in the user's own words, to "let me
  // know what tools we can use". It reached for exactly that — a connection
  // status check and two catalogue searches — double-wrapped them, and was
  // refused as if reading the tool list were a business effect. The recovery
  // then advised `call_tool`, which is what had just been refused.
  //
  // Unwrapping is strictly more accurate in both directions: a write nested at
  // any depth now classifies as the write it is, rather than as `unknown`.
  const effectiveArgs = identity.toolName ? identity.args : input.args;
  const decision = classifyRuntimeToolEffect(identity.toolName ?? input.toolName, effectiveArgs);
  const effect = input.attestedEffect ?? decision.effect;
  // A READ IS A READ, whatever carries it. Plan's ceiling is external
  // consequence; a shell command the host itself classified read-only
  // (`sf org list --json`, `gh pr list`) crosses none. Live 2026-09-08: a
  // planning turn needed the org list to plan its query and was refused as if
  // it were a write, then wandered until it died with a misleading stop.
  if ((effect === 'read' || effect === 'compute') && name !== 'request_approval') {
    // Read count and carrier are not evidence that preparation is complete.
    // The model decides which inputs it needs; this boundary enforces effects.
    return undefined;
  }
  // A PLANNING TURN MAY STILL TALK.
  //
  // Plan's ceiling is EXTERNAL CONSEQUENCE, not the absence of a read label.
  // `host_only` operations cross no boundary; the ones the registry declares
  // `sideEffect: 'read'` are the harness's own status surface — telling the
  // owner what was found mid-task. Live 2026-09-07 source 146042: Clem
  // resolved Tim, got six account rows, and called check_in to say so. Plan
  // refused it as if it were a business effect, the governor then metered that
  // refusal and named check_in as the recovery tool, and the run collapsed.
  //
  // Derived from the declaration, not a name list: a host_only tool declared
  // `write` (memory_remember, focus_set, pending_action_queue) stays refused,
  // and every business/external effect is untouched below.
  if (effect === 'host_only' && !identity.composioCarrier
    && registeredToolSideEffect(name) === 'read') return undefined;
  // A TOOL'S OWN CONFIGURATION IS PREPARATION, NOT AN EXTERNAL EFFECT.
  //
  // A declared repair carries a fixed argv reviewed in source and changes only
  // the local settings of a tool this plan needs — which account, org or
  // project it uses when a command does not name one. Refusing it stranded
  // planning behind a tool that was authenticated but unusable: the model
  // could see the problem, could not fix it, and said it was unable to run
  // commands at all. The repair stays named, bounded, and reversible by
  // running it again with another value.
  if (declaredCliRepairCall(name, effectiveArgs)) return undefined;
  // A PLANNING TURN VALIDATES WHAT IT WILL CALL.
  //
  // This gate is synchronous and sees only an effect label. An external write
  // the production host has sealed carries a current definition whose risk
  // consent can read: a carrier-bounded, non-destructive call may run once as
  // preparation so the plan binds arguments that worked, while a create, send,
  // delete or admin effect is refused there with this same sentence. An
  // unattested external write has no such fact and stays refused here.
  if (effect === 'external_write' && input.attested) return undefined;
  return planModeReadOnlyRefusalText(name);
}
