import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Plan-tools registrar. The stored-plan surfaces (create_plan / list_plans /
 * update_plan_step) were retired: the execution lane (execution_create + friends)
 * is the single source of truth for in-flight multi-step work, and draft_plan /
 * share_plan / surface_plan cover planning VISIBILITY. Kept as a no-op registrar
 * so existing call sites (mcp-server.ts, local-runtime-tools.ts) stay stable;
 * add any future plan-scoped tools here.
 */
export function registerPlanTools(_server: McpServer): void {
  // No stored-plan tools registered — see module doc.
}
