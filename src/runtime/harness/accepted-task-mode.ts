/** Reopen mode only from the exact durable accepted source, including workers. */
import { getSession, listEvents } from './eventlog.js';
import { parseTaskMode, taskModeDigest, type TaskMode } from './task-mode.js';
import { classifyRuntimeToolEffect, unwrapRuntimeEffectiveToolIdentity, type RuntimeToolEffect } from './tool-effect.js';
import { registeredToolSideEffect } from '../../tools/tool-registry.js';

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
export function planModeCallRefusal(input: {
  mode: TaskMode | undefined; toolName: string; args: unknown; attestedEffect?: RuntimeToolEffect;
}): string | undefined {
  if (input.mode?.kind !== 'plan') return undefined;
  const identity = unwrapRuntimeEffectiveToolIdentity(input.toolName, input.args);
  const name = identity.toolName ?? input.toolName;
  // These are bounded host operations, not business effects. Workers inherit
  // the same accepted source and therefore the same ceiling at their tool edge.
  if (['publish_plan', 'run_worker'].includes(name) && !identity.composioCarrier) return undefined;
  const decision = classifyRuntimeToolEffect(input.toolName, input.args);
  const effect = input.attestedEffect ?? decision.effect;
  // A READ IS A READ, whatever carries it. Plan's ceiling is external
  // consequence; a shell command the host itself classified read-only
  // (`sf org list --json`, `gh pr list`) crosses none. Live 2026-09-08: a
  // planning turn needed the org list to plan its query and was refused as if
  // it were a write, then wandered until it died with a misleading stop.
  if ((effect === 'read' || effect === 'compute') && name !== 'request_approval') return undefined;
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
  return `PLAN_MODE_READ_ONLY: ${name} cannot execute in Plan mode. Investigate its schema and required arguments, then include the proposed action in publish_plan. The user can Execute the reviewed revision; no business effect or approval was started.`;
}
