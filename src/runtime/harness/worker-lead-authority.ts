/**
 * When a worker may act with its lead's authority.
 *
 * Every worker lane asks the same question before an outside change: may
 * this worker make it as its lead would, or must it hand the call back for
 * the lead to propose? One answer here keeps the lanes from drifting.
 */
import { loadProactivityPolicy } from '../../agents/proactivity-policy.js';
import { canonicalMcpToolIdentity } from '../mcp-tool-authority.js';
import type { McpToolScope } from '../mcp-tool-scope.js';

/** Whether the owner runs in Auto (anything non-disruptive runs) rather than Ask. */
export function ownerRunsInAutoMode(): boolean {
  try { return loadProactivityPolicy().autoApproveScope === 'yolo'; } catch { return true; }
}

/**
 * A worker may make an external write its lead could make without asking:
 * only on a tool its parent leased it exactly, never an admin effect, and only
 * while the owner runs in Auto. The consent evaluation that follows still
 * decides the call; anything that needs the owner goes back to the parent.
 */
export function workerMayActAsLead(input: {
  toolName: string;
  effect: string | undefined;
  boundary: string | undefined;
  scope: McpToolScope | null | undefined;
  ownerAutoMode: boolean;
}): boolean {
  if (!input.ownerAutoMode) return false;
  if (input.effect !== 'external_write' || input.boundary !== 'host_owned_external') return false;
  const scope = input.scope;
  if (scope?.authority !== 'exact') return false;
  const identity = canonicalMcpToolIdentity(input.toolName);
  return Boolean(identity) && (scope.allowedToolNames ?? [])
    .some((leased) => canonicalMcpToolIdentity(leased) === identity);
}
