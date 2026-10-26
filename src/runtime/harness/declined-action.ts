/**
 * A no stays a no for the request it answered.
 *
 * When the owner declines a card, the action does not run and the turn
 * resumes so Clem can answer. A model can read that rejection as a refusal to
 * repair and propose the same action again (live: "Actually never mind, keep
 * it for now" retired a delete card, and the next round raised a second card
 * for the same delete). The owner already answered that exact action, so it
 * gets no new card in the same request; Clem is told it stays declined. A new
 * message from the owner is a new request, and can ask for it again.
 */
import * as approvalRegistry from './approval-registry.js';
import { unwrapRuntimeEffectiveToolIdentity } from './tool-effect.js';
import { isPlainOrClementineLocalTool } from './runtime-tool-identity.js';

/** What Clem is told when the same declined action comes back. */
export const OWNER_DECLINED_SAME_ACTION = 'The owner already declined exactly this action in this request, so it stays declined: '
  + 'nothing ran and no card was raised. Answer them in a line or two; propose it again only if they ask.';

/** The action a call carries, with carrier wrapping and empty fields set aside,
 *  so the same action reads the same however it was spelled. */
function actionKey(tool: string, args: unknown): string | null {
  const record = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : null;
  if (!record) return null;
  const identity = unwrapRuntimeEffectiveToolIdentity(tool, record);
  const name = (identity.toolName ?? tool).trim();
  const inner = identity.args && typeof identity.args === 'object' && !Array.isArray(identity.args)
    ? identity.args as Record<string, unknown> : record;
  // workflow_delete alone defines omitted/null/true confirmation identically
  // and deletes the trimmed union of name + names. Compare that same target
  // set so another spelling cannot reopen the owner's no. This comparison
  // grants no execution authority; other schemas and malformed calls keep
  // their original identity.
  if (!identity.composioCarrier && isPlainOrClementineLocalTool(name, 'workflow_delete')
    && Object.keys(inner).every(key => key === 'name' || key === 'names' || key === 'confirm')
    && (inner.confirm == null || inner.confirm === true)
    && (inner.name == null || (typeof inner.name === 'string' && inner.name.length > 0))
    && (inner.names == null || (Array.isArray(inner.names) && inner.names.length > 0 && inner.names.length <= 20
      && inner.names.every(value => typeof value === 'string' && value.length > 0)))) {
    const targets = [...new Set([...(typeof inner.name === 'string' ? [inner.name] : []),
      ...((inner.names ?? []) as string[])].map(value => value.trim()).filter(Boolean))].sort();
    // A distinct local-only key cannot match raw arguments from a gateway
    // whose provider operation merely has the same spelling.
    if (targets.length > 0) return JSON.stringify(['workflow_delete', 'target_set_v1', targets]);
  }
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== null && (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  };
  return name ? JSON.stringify([name, canonical(inner)]) : null;
}

/** True when the owner rejected a card for this exact action after `sinceIso`
 *  (the start of the request this call belongs to). */
export function ownerDeclinedSameAction(input: {
  sessionId: string;
  sinceIso: string;
  tool: string;
  args: unknown;
}): boolean {
  const key = actionKey(input.tool, input.args);
  if (!key) return false;
  return approvalRegistry.listPending({ sessionId: input.sessionId, status: 'any' }).some((row) => (
    row.resolution === 'rejected'
    && row.requestedAt >= input.sinceIso
    && typeof row.tool === 'string'
    && actionKey(row.tool, row.args) === key
  ));
}
