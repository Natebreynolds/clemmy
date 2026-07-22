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
    const inner = (input as { name?: unknown }).name
      ?? (input as { tool?: unknown }).tool
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

const MULTI_RESULT_NOUN_RE = /\b(?:emails|messages|files|documents|reports|posts|records|contacts|tasks|events|invoices|rows|items)\b/i;
const MULTI_RESULT_QUANTIFIER_RE = /\b(?:all|both|each|every|multiple|several|many|remaining|these|those|[2-9]|[1-9][0-9]+|two|three|four|five|six|seven|eight|nine|ten)\b/i;
const ACTION_SEQUENCE_RE = /\b(?:create|build|write|draft|send|email|update|post|publish|deploy|run|execute|install|configure|generate|add|edit)\b[^\n.!?]{0,100}\b(?:and|then)\b[^\n.!?]{0,40}\b(?:create|build|write|draft|send|email|update|post|publish|deploy|run|execute|install|configure|generate|add|edit)\b/i;

/** A single successful mutation cannot prove a batch or compound objective is
 * complete. These objectives retain one bounded completion-judge check. */
export function objectiveMayRequireMultipleResults(objectiveText: string): boolean {
  const objective = objectiveText.trim();
  if (!objective) return false;
  return MULTI_RESULT_NOUN_RE.test(objective)
    || MULTI_RESULT_QUANTIFIER_RE.test(objective)
    || ACTION_SEQUENCE_RE.test(objective)
    || /(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/.test(objective);
}

function recordLooksFailed(record: Record<string, unknown>): boolean {
  const explicitSuccess = record.successful === true || record.success === true || record.ok === true;
  if (
    record.successful === false
    || record.success === false
    || record.ok === false
    || record.failed === true
  ) return true;

  const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';
  if (/^(?:error|failed|failure|not[_ -]?connected)$/.test(status)) return true;
  if (explicitSuccess) return false;

  const error = record.error;
  if (
    error === true
    || (typeof error === 'string' && error.trim().length > 0)
    || (Array.isArray(error) && error.length > 0)
    || (error !== null && typeof error === 'object' && Object.keys(error).length > 0)
  ) return true;

  const errors = record.errors;
  if (Array.isArray(errors) && errors.length > 0) return true;

  const data = record.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = data as Record<string, unknown>;
    if (typeof nested.http_error === 'string' && nested.http_error.trim()) return true;
    const statusCode = nested.status_code;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600) return true;
  }

  return false;
}

const TOOL_FAILURE_BANNER_RE = /^(?:(?:[A-Za-z0-9_.:/-]+)\s+)?(?:FAILED|FAILURE|NOT CONNECTED)(?:\b|\s*[:(])/i;
const TOOL_FAILURE_SENTENCE_RE = /^(?:An error occurred while running the tool|Tool call (?:refused|blocked) by harness|MCP error\b|SEND_REQUIRES_APPROVAL\b)/i;

export function toolOutputLooksSuccessful(output: unknown, explicitOk?: unknown): boolean {
  if (explicitOk === false) return false;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return !recordLooksFailed(output as Record<string, unknown>);
  }
  if (typeof output !== 'string') return true;

  const text = output.trim();
  if (!text) return true;
  const firstLine = (text.split(/\r?\n/, 1)[0] ?? '')
    .replace(/^[\s\u26a0\ufe0f]+/u, '')
    .trim();
  if (TOOL_FAILURE_BANNER_RE.test(firstLine) || TOOL_FAILURE_SENTENCE_RE.test(firstLine)) return false;
  if (/^(?:ERROR|FAILED|FAILURE)\s*:/i.test(firstLine)) return false;

  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return !recordLooksFailed(parsed as Record<string, unknown>);
      }
    } catch {
      // A non-JSON tool result is assessed by its failure banner only.
    }
  }
  return true;
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
