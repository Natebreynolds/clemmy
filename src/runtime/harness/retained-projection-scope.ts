import { isPlainOrClementineLocalTool } from './runtime-tool-identity.js';

/** A reader may show its complete selected reply without inspecting its whole
 * producer. Scope comes from the exact invocation arguments, never the text
 * of that reply or a model-authored completeness claim. */
export function retainedProjectionSourceScope(
  toolName: string,
  invocationArgs: unknown,
): { sourceSelectionComplete: false } | Record<string, never> {
  if (!isPlainOrClementineLocalTool(toolName, 'tool_output_query')) return {};
  let args = invocationArgs;
  if (typeof args === 'string') {
    try { args = JSON.parse(args) as unknown; } catch { return {}; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  // Empty string explicitly chooses the JSON root. It still disables the
  // ordinary record-list view and may be combined with a narrower projection.
  if (Object.hasOwn(args, 'path') && typeof (args as Record<string, unknown>).path === 'string') {
    return { sourceSelectionComplete: false };
  }
  // Strict transports encode unused optional arguments as null.
  return {};
}

/** Missing metadata preserves the existing un-focused reader contract. A
 * focused view is useful evidence for its own selection, never proof that the
 * entire ancestor result was inspected. */
export function projectionMayCompleteSource(row: { sourceSelectionComplete?: boolean }): boolean {
  return row.sourceSelectionComplete !== false;
}
