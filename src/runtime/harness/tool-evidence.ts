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

const NEGATED_ACTION_CLAUSE_RE =
  /\b(?:do\s+not|don't|dont|never|without)\b[^.!?\n;]*/gi;
const NEGATED_NO_ACTION_CLAUSE_RE =
  /\bno\s+(?:external\s+)?(?:writes?|changes?|sends?|posts?|publishes?|deployments?|uploads?)\b[^.!?\n;]*/gi;
// Mutation evidence uses a tighter, comma-bounded form. A prohibition such as
// "do not run shell commands" must not turn a lookup into a mutation, while a
// positive clause after it ("do not send email, but write the local report")
// must remain visible to the classifier.
const NEGATED_MUTATION_SEGMENT_RE =
  /\b(?:do\s+not|don't|dont|never|without)\b[^,.!?\n;]*/gi;
const NEGATED_NO_MUTATION_SEGMENT_RE =
  /\bno\s+(?:external\s+)?(?:writes?|changes?|sends?|posts?|publishes?|deployments?|uploads?)\b[^,.!?\n;]*/gi;
const INHERENT_EXTERNAL_WRITE_RE =
  /\b(?:deploy|invite|publish|send|submit|upload)\b/i;
const CONTEXTUAL_EXTERNAL_WRITE_VERB_RE =
  /\b(?:host|post|schedule|reschedule)\s+(?:a|an|the|this|that|it|them|to|on|for)\b/i;
const LOCAL_SCHEDULE_TARGET_RE =
  /\b(?:workflow|automation|cron|scheduled job)\b/i;
const EXTERNAL_DESTINATION_RE =
  /\b(?:airtable|box|calendar|figma|gmail|google\s+(?:docs?|drive|sheets?)|googledocs?|googledrive|googlesheets?|github|heroku|hubspot|netlify|notion|outlook|railway|salesforce|sharepoint|slack|stripe|supabase|teams|vercel|external\s+(?:app|service|system)|connected\s+(?:app|service|system)|sheet\s+(?:cell|cells|range|row|rows|tab)|spreadsheet)\b/i;
const EXTERNAL_WRITE_ACTION_RE =
  /\b(?:add|append|change|create|delete|draft|edit|insert|make|modify|remove|rename|replace|set|update|write)\b/i;
const EXPLICIT_EXTERNAL_WRITE_RE =
  /\bexternal[-\s]+write\b/i;
const URL_TARGETED_WRITE_RE =
  /\b(?:add|append|create|delete|deploy|edit|modify|post|publish|remove|send|submit|update|upload|write)\b[^.!?\n]{0,100}\b(?:https?:\/\/|api\s+endpoint)\b/i;

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
  const positive = objectiveText
    .replace(NEGATED_MUTATION_SEGMENT_RE, ' ')
    .replace(NEGATED_NO_MUTATION_SEGMENT_RE, ' ');
  return MUTATING_OBJECTIVE_RE.test(positive);
}

function positiveObjectiveActionText(objectiveText: string): string {
  return objectiveText
    .replace(NEGATED_ACTION_CLAUSE_RE, ' ')
    .replace(NEGATED_NO_ACTION_CLAUSE_RE, ' ');
}

/**
 * Conservative request classifier for effects that must land in an external
 * system. It deliberately ignores negated clauses and requires either an
 * inherently external verb (send/deploy/publish/…) or a write verb paired with
 * a concrete external destination. A local file build therefore does not gain
 * an external-receipt requirement.
 */
export function objectiveRequiresFreshExternalWrite(objectiveText: string): boolean {
  const positive = positiveObjectiveActionText(objectiveText);
  if (!positive.trim()) return false;
  if (EXPLICIT_EXTERNAL_WRITE_RE.test(positive) || URL_TARGETED_WRITE_RE.test(positive)) return true;
  if (INHERENT_EXTERNAL_WRITE_RE.test(positive)) return true;
  if (
    CONTEXTUAL_EXTERNAL_WRITE_VERB_RE.test(positive)
    && !(
      /\b(?:schedule|reschedule)\b/i.test(positive)
      && LOCAL_SCHEDULE_TARGET_RE.test(positive)
      && !EXTERNAL_DESTINATION_RE.test(positive)
    )
  ) return true;
  return EXTERNAL_WRITE_ACTION_RE.test(positive) && EXTERNAL_DESTINATION_RE.test(positive);
}

export type FreshExternalWriteEvidenceStatus =
  | 'confirmed'
  | 'missing'
  | 'failed'
  | 'ambiguous';

interface SequencedEvidenceEvent {
  seq: number;
  type: string;
}

/**
 * Resolve external-write evidence strictly after the accepted user row. The
 * write gate records `external_write` before dispatch; demonstrable failures
 * and ambiguous timeouts compensate that provisional row. Historical rows at
 * or before `sourceUserSeq` can never certify this request.
 */
export function freshExternalWriteEvidenceStatus(
  events: readonly SequencedEvidenceEvent[],
  sourceUserSeq: number | undefined,
): FreshExternalWriteEvidenceStatus {
  if (!Number.isSafeInteger(sourceUserSeq) || (sourceUserSeq ?? 0) <= 0) return 'missing';
  const current = events.filter((event) => event.seq > (sourceUserSeq as number));
  const writes = current.filter((event) => event.type === 'external_write').length;
  if (writes === 0) return 'missing';
  const failed = current.filter((event) => event.type === 'external_write_failed').length;
  const ambiguous = current.filter((event) => event.type === 'external_write_orphaned').length;
  if (writes - failed - ambiguous > 0) return 'confirmed';
  if (ambiguous > 0) return 'ambiguous';
  return failed > 0 ? 'failed' : 'missing';
}

export function isReadOnlyCompletionEvidence(rawName: string): boolean {
  const normalized = normalizedToolName(rawName);
  return isToolSurfaceProbeTool(normalized) || READ_ONLY_TOOL_RE.test(normalized);
}

/**
 * A surface probe normally proves only that a capability exists, not that the
 * user's task is complete. The exception is a request whose deliverable is the
 * probe result itself ("what are the workspace root paths?", "what do you
 * remember about X?", "list the available skills"). Keep this intentionally
 * phrase-tight: a workspace-root lookup must not certify a broader request to
 * inspect the workspace, and a capability check must never certify an action.
 */
function surfaceProbeDirectlyAnswersObjective(rawName: string, objectiveText: string): boolean {
  const objective = objectiveText.trim();
  if (!objective) return false;
  switch (normalizedToolName(rawName)) {
    case 'workspace_roots':
      return /\bworkspace\b[^.!?\n]{0,60}\b(?:root|roots|path|paths|director(?:y|ies))\b/i.test(objective)
        || /\b(?:root|roots|path|paths|director(?:y|ies))\b[^.!?\n]{0,60}\bworkspace\b/i.test(objective);
    case 'workspace_info':
      return /\bworkspace\b[^.!?\n]{0,40}\b(?:info|information|details?|configuration|configured)\b/i.test(objective)
        || /\b(?:info|information|details?|configuration|configured)\b[^.!?\n]{0,40}\bworkspace\b/i.test(objective);
    case 'workspace_list':
      return /\b(?:list|which|what)\b[^.!?\n]{0,50}\bworkspaces?\b/i.test(objective);
    case 'session_history':
      return /\b(?:session|conversation|chat)\b[^.!?\n]{0,40}\bhistory\b/i.test(objective)
        || /\bhistory\b[^.!?\n]{0,40}\b(?:session|conversation|chat)\b/i.test(objective);
    case 'memory_recall':
    case 'memory_search':
    case 'memory_list_facts':
      return /\b(?:remember|recall|memory|memories|fact|facts)\b/i.test(objective);
    case 'skill_list':
      return /\b(?:available|installed|list|what|which)\b[^.!?\n]{0,40}\bskills?\b/i.test(objective);
    case 'check_capability':
    case 'list_capabilities':
      return /\b(?:capability|capabilities|able to|available tools?|connected (?:apps?|services?|integrations?))\b/i.test(objective);
    case 'composio_search_tools':
      return /\bcomposio\b[^.!?\n]{0,60}\b(?:tool|tools|action|actions|integration|integrations)\b/i.test(objective);
    case 'local_cli_list':
      return /\b(?:local\s+)?clis?\b/i.test(objective)
        || /\bcommand[- ]line\b[^.!?\n]{0,30}\b(?:tool|tools|clients?)\b/i.test(objective);
    default:
      return false;
  }
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

/**
 * The execution controller emits this exact success prefix only after its
 * pinned success criteria validate and the durable execution is closed.
 * Rejections begin with "Completion not accepted" and therefore never match.
 * This gives the chat loop a deterministic way to avoid sending an already
 * accepted execution through a second, weaker transcript-only judge.
 */
export function isAcceptedExecutionCompletionOutput(output: unknown): boolean {
  if (typeof output !== 'string') return false;
  const firstLine = output.trim().split(/\r?\n/, 1)[0] ?? '';
  return /^Execution\s+\S+\s+completed\.(?:\s|$)/i.test(firstLine);
}

export function hasMeaningfulSuccessfulToolNames(
  toolNames: readonly string[],
  objectiveText = '',
): boolean {
  const mutationRequired = objectiveRequiresMutatingEvidence(objectiveText);
  return toolNames.some((name) => {
    if (!name || isControlOnlyTool(name)) return false;
    if (isToolSurfaceProbeTool(name)) {
      return !mutationRequired && surfaceProbeDirectlyAnswersObjective(name, objectiveText);
    }
    return !mutationRequired || !isReadOnlyCompletionEvidence(name);
  });
}
