const TOOL_SURFACE_PROBE_TOOLS = new Set([
  'check_capability',
  'list_capabilities',
  'workspace_roots',
  'workspace_info',
  'workspace_list',
  'session_history',
  'memory_recall',
  'memory_search',
  'memory_list_facts',
  'skill_list',
  'tool_choice_recall',
  'composio_search_tools',
  'local_cli_list',
]);

const CONTROL_ONLY_TOOLS = new Set([
  'ask_user_question',
  'request_approval',
  'offer_background',
  'dispatch_background_task',
  'hold_task_for_later',
  'resume_held_task',
  'workflow_step_result',
  'reflect',
  'tool_choice_remember',
  'tool_choice_invalidate',
  'working_memory',
]);

const MUTATING_OBJECTIVE_RE =
  /\b(?:add|build|call|change|configure|create|delete|deploy|draft|edit|email|execute|generate|install|make|post|publish|remove|run|save|schedule|send|set up|update|write)\b/i;

const READ_ONLY_TOOL_RE =
  /(?:^|_)(?:check|fetch|find|get|history|info|inspect|list|lookup|probe|query|read|recall|search|status)(?:_|$)/i;

function bareToolName(rawName: string): string {
  return rawName.split('__').at(-1) ?? rawName;
}

function normalizedToolName(rawName: string): string {
  return bareToolName(rawName)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function isToolSurfaceProbeTool(rawName: string): boolean {
  return TOOL_SURFACE_PROBE_TOOLS.has(normalizedToolName(rawName));
}

export function isControlOnlyTool(rawName: string): boolean {
  return CONTROL_ONLY_TOOLS.has(normalizedToolName(rawName));
}

/** Preserve the concrete action behind a multiplexer so a successful read
 * cannot certify a later mutation claim. */
export function completionEvidenceToolName(rawName: string, input?: unknown): string {
  const bare = bareToolName(rawName);
  if (bare === 'composio_execute_tool' && input && typeof input === 'object') {
    const slug = (input as { tool_slug?: unknown }).tool_slug;
    if (typeof slug === 'string' && slug.trim()) return slug.trim();
  }
  if (bare === 'call_tool' && input && typeof input === 'object') {
    const inner = (input as { tool?: unknown; tool_name?: unknown }).tool
      ?? (input as { tool_name?: unknown }).tool_name;
    if (typeof inner === 'string' && inner.trim()) return inner.trim();
  }
  return bare;
}

export function objectiveRequiresMutatingEvidence(objectiveText: string): boolean {
  return MUTATING_OBJECTIVE_RE.test(objectiveText);
}

export function isReadOnlyCompletionEvidence(rawName: string): boolean {
  const normalized = normalizedToolName(rawName);
  return isToolSurfaceProbeTool(normalized) || READ_ONLY_TOOL_RE.test(normalized);
}

export function toolOutputLooksSuccessful(output: unknown, explicitOk?: unknown): boolean {
  if (explicitOk === false) return false;
  const text = typeof output === 'string' ? output : '';
  return !/^\s*(?:ERROR|FAILED|FAILURE):/i.test(text);
}

export function hasMeaningfulSuccessfulToolNames(
  toolNames: readonly string[],
  objectiveText = '',
): boolean {
  const mutationRequired = objectiveRequiresMutatingEvidence(objectiveText);
  return toolNames.some((name) => {
    if (!name || isToolSurfaceProbeTool(name) || isControlOnlyTool(name)) return false;
    return !mutationRequired || !isReadOnlyCompletionEvidence(name);
  });
}
