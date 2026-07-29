import { classifyExternalWrite } from './confirm-first-gate.js';

export interface PendingActionSafetyInput {
  kind: string;
  toolName: string;
  payload: unknown;
}

/**
 * Human consent is derived from the canonical stored call, never weakened by
 * a model-declared kind. Unknown external mutations fail closed.
 */
export function pendingActionRequiresHumanApproval(
  action: PendingActionSafetyInput,
): boolean {
  if (action.kind === 'external_send') return true;

  if (action.toolName === 'run_batch') {
    if (!action.payload || typeof action.payload !== 'object' || Array.isArray(action.payload)) {
      return true;
    }
    const plan = action.payload as {
      tool?: unknown;
      composioSlug?: unknown;
      sideEffect?: unknown;
      items?: unknown;
    };
    if (plan.sideEffect === 'send') return true;
    const innerTool = typeof plan.tool === 'string' ? plan.tool.trim() : '';
    const firstItem = Array.isArray(plan.items) && plan.items.length > 0
      && plan.items[0] && typeof plan.items[0] === 'object'
      ? plan.items[0] as { args?: unknown }
      : null;
    if (innerTool === 'composio_execute_tool' && typeof plan.composioSlug === 'string') {
      const effect = classifyExternalWrite(innerTool, {
        tool_slug: plan.composioSlug,
        arguments: firstItem?.args ?? {},
      });
      return effect.irreversible
        || (effect.external && effect.mutating && !effect.classificationKnown);
    }
    if (innerTool) {
      const effect = classifyExternalWrite(innerTool, firstItem?.args ?? {});
      if (effect.external) {
        return effect.irreversible
          || (effect.mutating && !effect.classificationKnown);
      }
    }
    // An aggregate write whose actual external carrier is malformed or unknown
    // cannot inherit policy approval from model metadata.
    return plan.sideEffect !== 'read';
  }

  const effect = classifyExternalWrite(action.toolName, action.payload);
  return action.kind === 'external_send'
    || effect.irreversible
    || (effect.external && effect.mutating && !effect.classificationKnown);
}
