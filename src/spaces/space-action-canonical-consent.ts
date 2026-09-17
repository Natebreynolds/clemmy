/**
 * One decision for a declared Workspace provider action, shared by the model's
 * `space_action_prepare` tool and a person clicking the control in the view.
 *
 * The exact current binding is projected through the canonical consent policy:
 * an ordinary create or update runs through the durable workflow_v3_call
 * receipt path with no card; a send, delete, administrative or otherwise
 * high-consequence effect keeps its one exact approval; an ambiguous account
 * asks for one choice. A person's click and the model's request must never
 * disagree about which of those an action is.
 */
import type { SpaceAction, SpaceRecord } from './store.js';
import type { RunSourceResult } from './runner.js';
import {
  acquireAutoSpaceActionV3Authority,
  evaluateSpaceActionV3AutoConsent,
} from './space-action-v3-authority.js';

export type SpaceProviderActionDecision =
  /** Ran under canonical Auto; `result` is the kernel's outcome. */
  | { kind: 'ran'; result: RunSourceResult }
  /** Needs the user's one approval (the caller stages the card). */
  | { kind: 'approval' }
  /** Needs one account choice, a connection, or an essential input; nothing
   *  was staged or run. `fromPreparation` marks a binding-time account or
   *  connection gap, as distinct from the consent decision's own need. */
  | { kind: 'needs_user'; need: 'choice' | 'credential' | 'essential_input'; message: string; fromPreparation: boolean }
  /** The exact binding could not be evaluated or armed; nothing ran. */
  | { kind: 'unavailable'; reason: string };

export async function decideAndRunSpaceProviderAction(input: {
  record: SpaceRecord;
  action: SpaceAction;
  callerArgs: Record<string, unknown>;
  /** Stable identity of this one request (a chat call or a click). */
  runOccurrenceId: string;
}): Promise<SpaceProviderActionDecision> {
  const evaluated = evaluateSpaceActionV3AutoConsent({
    slug: input.record.id,
    action: input.action,
    callerArgs: input.callerArgs,
    runOccurrenceId: input.runOccurrenceId,
  });
  if (evaluated.status === 'needs_user') {
    return { kind: 'needs_user', need: evaluated.need, message: evaluated.message, fromPreparation: true };
  }
  if (evaluated.status === 'conflict') return { kind: 'unavailable', reason: evaluated.reason };
  if (evaluated.decision.kind === 'proceed') {
    if (!evaluated.authorization) {
      return { kind: 'unavailable', reason: 'its exact Auto authorization was unavailable' };
    }
    const acquired = acquireAutoSpaceActionV3Authority({
      slug: input.record.id,
      preparation: evaluated.preparation,
      authorization: evaluated.authorization,
    });
    if (!acquired.ok) return { kind: 'unavailable', reason: acquired.error };
    const { runSpaceAction } = await import('./runner.js');
    const result = await runSpaceAction(input.record.id, input.action, input.callerArgs, {
      composioAuthority: acquired.authority,
    });
    return { kind: 'ran', result };
  }
  if (evaluated.decision.kind === 'needs_user') {
    return evaluated.decision.need === 'approval'
      ? { kind: 'approval' }
      : {
          kind: 'needs_user',
          need: evaluated.decision.need,
          message: `needs ${evaluated.decision.need.replace('_', ' ')} before it can run`,
          fromPreparation: false,
        };
  }
  return { kind: 'unavailable', reason: 'its exact effect authority needs internal repair' };
}
