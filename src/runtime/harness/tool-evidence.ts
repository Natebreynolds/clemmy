import {
  classifyMessageIntent,
  MUTATION_ACTION_CUES,
} from '../../assistant/message-intent.js';
import { classifyExternalEffectRequest } from '../../assistant/external-effect-taxonomy.js';

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

function regexAlternation(terms: readonly string[]): string {
  return terms
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
    .sort((a, b) => b.length - a.length)
    .join('|');
}

const MUTATION_ACTION_SOURCE = regexAlternation(MUTATION_ACTION_CUES);
const MUTATING_OBJECTIVE_RE = new RegExp(`\\b(?:${MUTATION_ACTION_SOURCE})\\b`, 'i');
// Many mutation verbs are also ordinary nouns ("the launch", "the email",
// "this post"). If a separate non-mutating deliverable makes the whole request
// action-shaped, those noun references must not suddenly demand write evidence.
// A real imperative still has its verb elsewhere ("publish the post"), so
// projecting the determiner+noun reference is conservative.
const MUTATION_NOUN_REFERENCE_RE = new RegExp(
  `\\b(?:a|an|the|this|that|these|those|my|our|your|its)\\s+(?:${MUTATION_ACTION_SOURCE})\\b`,
  'gi',
);

const NEGATED_ACTION_CLAUSE_RE =
  /\b(?:do\s+not|don't|dont|never|without)\b(?:(?!,\s*(?:but|however|instead|then|yet)\b)[^.!?\n;])*/gi;
const NEGATED_NO_ACTION_CLAUSE_RE =
  /\bno\s+(?:external\s+)?(?:writes?|changes?|sends?|posts?|publishes?|deployments?|uploads?)\b(?:(?!,\s*(?:but|however|instead|then|yet)\b)[^.!?\n;])*/gi;
// Mutation evidence uses a tighter, comma-bounded form. A prohibition such as
// "do not run shell commands" must not turn a lookup into a mutation, while a
// positive clause after it ("do not send email, but write the local report")
// must remain visible to the classifier.
const NEGATED_MUTATION_SEGMENT_RE =
  /\b(?:do\s+not|don't|dont|never|without)\b[^,.!?\n;]*/gi;
const NEGATED_NO_MUTATION_SEGMENT_RE =
  /\bno\s+(?:external\s+)?(?:writes?|changes?|sends?|posts?|publishes?|deployments?|uploads?)\b[^,.!?\n;]*/gi;
const INHERENT_EXTERNAL_WRITE_RE =
  /\b(?:deploy|invite|publish|send|submit|unsubscribe|upload)\b/i;
const CONTEXTUAL_EXTERNAL_WRITE_VERB_RE =
  /\b(?:host|post|schedule|reschedule)\s+(?:a|an|the|this|that|it|them|to|on|for)\b/i;
const LOCAL_SCHEDULE_TARGET_RE =
  /\b(?:workflow|automation|cron|scheduled job)\b/i;
const EXTERNAL_PROVIDER_SOURCE =
  'airtable|asana|box|crm|discord|facebook|figma|gmail|google\\s+(?:ads?|calendar|docs?|drive|sheets?)|googledocs?|googledrive|googlesheets?|github|heroku|hubspot|instagram|jira|linear|linkedin|meta|netlify|notion|one\\s*drive|onedrive|outlook|railway|salesforce|sharepoint|slack|stripe|supabase|teams|tiktok|trello|twitter|vercel|x|youtube|zoom|external\\s+(?:app|service|system)|connected\\s+(?:app|service|system)';
const EXTERNAL_OPERATIONAL_OBJECT_SOURCE =
  'accounts?|bases?|boards?|branches?|campaigns?|cards?|cells?|channels?|charges?|comments?|contacts?|customers?|databases?|deals?|docs?|documents?|drafts?|events?|files?|folders?|gists?|invoices?|issues?|leads?|lists?|meetings?|messages?|pages?|payments?|posts?|projects?|pull\\s+requests?|prs?|ranges?|records?|refunds?|releases?|reminders?|repositories?|repos?|rows?|services?|sites?|spreadsheets?|subscriptions?|tasks?|threads?|tickets?|transactions?|values?|views?';
const EXTERNAL_DESTINATION_RE = new RegExp(
  `\\b(?:${EXTERNAL_PROVIDER_SOURCE}|calendar|email|sheet\\s+(?:cell|cells|range|row|rows|tab)|spreadsheet)\\b`,
  'i',
);
const NON_EXTERNAL_MUTATION_ACTIONS = new Set([
  'build',
  'call',
  'execute',
  'generate',
  'install',
  'run',
]);
const EXTERNAL_MUTATION_ACTION_SOURCE = regexAlternation(
  MUTATION_ACTION_CUES.filter((term) => !NON_EXTERNAL_MUTATION_ACTIONS.has(term)),
);
const EXTERNAL_WRITE_ACTION_RE = new RegExp(
  `\\b(?:${EXTERNAL_MUTATION_ACTION_SOURCE})\\b`,
  'i',
);
const DIRECT_EXTERNAL_PROVIDER_TARGET_RE = new RegExp(
  `\\b(?:${EXTERNAL_MUTATION_ACTION_SOURCE})\\b\\s+(?:(?:a|an|my|our|the|this|that|these|those|your)\\s+)?(?:${EXTERNAL_PROVIDER_SOURCE}|calendar|spreadsheet)\\b`,
  'i',
);
const EXTERNAL_TARGET_PREPOSITION_RE = new RegExp(
  `\\b(?:${EXTERNAL_MUTATION_ACTION_SOURCE})\\b[^.!?\\n;]{0,160}\\b(?:as|in|into|on|through|to|via|within)\\s+(?:(?:my|our|the)\\s+)?(?:${EXTERNAL_PROVIDER_SOURCE})\\b`,
  'i',
);
const EXTERNAL_PROVIDER_OBJECT_RE = new RegExp(
  `\\b(?:${EXTERNAL_PROVIDER_SOURCE})\\b[^.!?\\n;]{0,80}\\b(?:${EXTERNAL_OPERATIONAL_OBJECT_SOURCE})\\b`,
  'i',
);
const EXTERNAL_PROVIDER_PRODUCT_OBJECT_RE =
  /\b(?:google\s+docs?|google\s+drive|google\s+sheets?|one\s*drive|onedrive)\b/i;
const GENERIC_EXTERNAL_OBJECT_ACTION_RE =
  /\b(?:(?:accept|cancel|create|decline|delete|edit|modify|remove|reschedule|update)\b[^.!?\n;]{0,100}\b(?:calendar\s+)?(?:appointment|event|invitation|meeting|reservation)|(?:forward|reply\s+to)\b[^.!?\n;]{0,100}\bemail)\b/i;
const EXPLICIT_EXTERNAL_WRITE_RE =
  /\bexternal[-\s]+write\b/i;
const URL_TARGETED_WRITE_RE =
  /\b(?:add|append|create|delete|deploy|edit|modify|post|publish|remove|send|submit|update|upload|write)\b[^.!?\n]{0,100}\b(?:https?:\/\/|api\s+endpoint)\b/i;
const STAGED_EXTERNAL_ACTION_RE =
  /\b(?:automation|configure|define|draft|prepare|preview|queue|queued|queueing|simulation|stage|staged|staging|workflow|workspace)\b/i;
const EXPLICIT_EXTERNAL_ACTION_DEFERRAL_RE =
  /(?:\b(?:do\s+not|don't|dont|never)\b[^.!?\n;]{0,160}\b(?:call|deploy|execute|invoke|post|publish|run|send|submit|upload|write)\b|\b(?:only\s+after|pending|unless|until)\b[^.!?\n;]{0,120}\b(?:approv(?:al|e|ed)|confirmation|permission)\b|\bask\b[^.!?\n;]{0,120}\b(?:if|whether)\b[^.!?\n;]{0,80}\b(?:deploy|execute|invoke|post|publish|run|send|submit|upload|write)\b|\b(?:send|deploy|post|publish|submit|upload|write)\s+nothing\s+(?:yet|now)\b|\b(?:queue|stage|prepare|draft)\b[^.!?\n;]{0,180}\bfor\s+(?:approval|confirmation|permission|later)\b|\bi\s+(?:might|may|could|would)\b[^.!?\n;]{0,120}\b(?:deploy|post|publish|send|submit|upload|write)\b[^.!?\n;]{0,60}\blater\b)/i;
const STAGED_ACTION_METADATA_RE =
  /\b(?:action(?:\s+id)?|arguments?|payload(?:json)?|tool(?:name|_slug)?)\b/i;
const STAGED_ACTION_METADATA_ONLY_RE =
  /^\s*(?:the\s+)?(?:action(?:\s+id)?|arguments?|payload(?:json)?|tool(?:name|_slug)?)\b/i;
const STAGED_CLAUSE_IMMEDIATE_EXECUTION_RE =
  new RegExp(
    `\\b(?:(?:and|then)\\s+(?:actually\\s+)?(?:${EXTERNAL_MUTATION_ACTION_SOURCE}|invoke)|(?:${EXTERNAL_MUTATION_ACTION_SOURCE}|invoke)\\b[^.!?\\n;]{0,40}\\b(?:immediately|now|right\\s+away))\\b`,
    'i',
  );
const LOCAL_ARTIFACT_WRITE_RE =
  /\b(?:build|create|draft|save|write)\b[^.!?\n;]{0,120}\b(?:local(?:ly)?|mock)\b/i;
const DISCUSSION_ARTIFACT_RE =
  /\b(?:analysis|brief|checklist|comparison|guide|mock|notes?|plan|proposal|recommendations?|report|response|summary)\b[^.!?\n;]{0,60}\b(?:about|comparing|of|regarding)\b/i;
const PROVIDER_REFERENCING_ARTIFACT_SOURCE =
  'analysis|brief|checklist|comparison|drafts?|guide|migration\\s+plan|notes?|plan|proposal|recommendations?|report|response|summary';
const PROVIDER_REFERENCING_ARTIFACT_RE = new RegExp(
  `\\b(?:${PROVIDER_REFERENCING_ARTIFACT_SOURCE})\\b`,
  'i',
);
const EXPLICIT_ARTIFACT_PROVIDER_DESTINATION_RE = new RegExp(
  `(?:\\b(?:${EXTERNAL_MUTATION_ACTION_SOURCE})\\b[^.!?\\n;]{0,100}\\b(?:${PROVIDER_REFERENCING_ARTIFACT_SOURCE})\\b[^.!?\\n;]{0,50}\\b(?:in|into|within)\\s+(?:(?:my|our|the)\\s+)?(?:${EXTERNAL_PROVIDER_SOURCE})\\b|\\b(?:add|append|copy|move|save|send|share|submit|upload)\\b[^.!?\\n;]{0,100}\\b(?:${PROVIDER_REFERENCING_ARTIFACT_SOURCE})\\b[^.!?\\n;]{0,50}\\b(?:on|through|to|via)\\s+(?:(?:my|our|the)\\s+)?(?:${EXTERNAL_PROVIDER_SOURCE})\\b|\\bsave\\b[^.!?\\n;]{0,100}\\bas\\s+(?:(?:a|an|my|our|the)\\s+)?(?:${EXTERNAL_PROVIDER_SOURCE})\\b[^.!?\\n;]{0,50}\\b(?:${PROVIDER_REFERENCING_ARTIFACT_SOURCE})\\b|\\b(?:create|save)\\s+(?:(?:a|an|my|our|the)\\s+)?(?:${EXTERNAL_PROVIDER_SOURCE})\\b[^.!?\\n;]{0,50}\\bdrafts?\\b)`,
  'i',
);
const DRAFT_ONLY_CLAUSE_RE =
  /^\s*(?:(?:please|kindly)\s+)?draft\b/i;
const DRAFT_EXTERNAL_TARGET_RE =
  /\bdraft\b[^.!?\n;]{0,120}\b(?:in|into|on|within)\s+(?:gmail|google\s+docs?|notion|outlook|slack)\b/i;

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
  const nonNegated = objectiveText
    .replace(NEGATED_MUTATION_SEGMENT_RE, ' ')
    .replace(NEGATED_NO_MUTATION_SEGMENT_RE, ' ');
  const directExternalEffect = classifyExternalEffectRequest(nonNegated).requested;
  const positive = nonNegated
    .replace(MUTATION_NOUN_REFERENCE_RE, ' referenced item ');
  return directExternalEffect
    || classifyMessageIntent(positive).intent === 'action'
    && MUTATING_OBJECTIVE_RE.test(positive);
}

function positiveObjectiveActionText(objectiveText: string): string {
  return objectiveText
    .replace(NEGATED_ACTION_CLAUSE_RE, ' ')
    .replace(NEGATED_NO_ACTION_CLAUSE_RE, ' ');
}

function externalDestinationIsOnlyArtifactContext(
  clause: string,
  immediateExecution: boolean,
): boolean {
  if (immediateExecution) return false;
  if (LOCAL_ARTIFACT_WRITE_RE.test(clause)) return true;
  if (DRAFT_ONLY_CLAUSE_RE.test(clause) && !DRAFT_EXTERNAL_TARGET_RE.test(clause)) return true;
  if (DRAFT_EXTERNAL_TARGET_RE.test(clause)) return false;
  // Provider names frequently describe the subject of a local artifact
  // ("GitHub release checklist", "Salesforce contact report"). Do not turn
  // that mention into a provider-write requirement. An explicit destination
  // ("create the report in Notion") still binds the provider as the target.
  if (
    PROVIDER_REFERENCING_ARTIFACT_RE.test(clause)
    && EXTERNAL_DESTINATION_RE.test(clause)
    && !EXPLICIT_ARTIFACT_PROVIDER_DESTINATION_RE.test(clause)
    && !INHERENT_EXTERNAL_WRITE_RE.test(clause)
  ) return true;
  const discussion = DISCUSSION_ARTIFACT_RE.exec(clause);
  if (!discussion) return false;
  const destinationContext = clause.slice(discussion.index + discussion[0].length);
  return EXTERNAL_DESTINATION_RE.test(destinationContext);
}

function externalDestinationIsBoundMutationTarget(
  clause: string,
  immediateExecution: boolean,
): boolean {
  if (immediateExecution && EXTERNAL_DESTINATION_RE.test(clause)) return true;
  return EXTERNAL_TARGET_PREPOSITION_RE.test(clause)
    || DIRECT_EXTERNAL_PROVIDER_TARGET_RE.test(clause)
    || EXTERNAL_PROVIDER_OBJECT_RE.test(clause)
    || EXTERNAL_PROVIDER_PRODUCT_OBJECT_RE.test(clause)
    || GENERIC_EXTERNAL_OBJECT_ACTION_RE.test(clause);
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
  return positive
    .split(/[.!?\n;]+/)
    .some((clause) => {
      if (!clause.trim()) return false;
      const immediateExecution = STAGED_CLAUSE_IMMEDIATE_EXECUTION_RE.test(clause);
      if (
        EXPLICIT_EXTERNAL_ACTION_DEFERRAL_RE.test(clause)
        && !immediateExecution
      ) return false;
      const stagedMetadataOnly = (
        STAGED_ACTION_METADATA_ONLY_RE.test(clause)
        || (
          STAGED_ACTION_METADATA_RE.test(clause)
          && STAGED_EXTERNAL_ACTION_RE.test(clause)
        )
      ) && !immediateExecution;
      if (stagedMetadataOnly) return false;
      if (classifyMessageIntent(clause).intent !== 'action') return false;
      if (externalDestinationIsOnlyArtifactContext(clause, immediateExecution)) return false;
      if (EXPLICIT_EXTERNAL_WRITE_RE.test(clause) || URL_TARGETED_WRITE_RE.test(clause)) return true;
      if (INHERENT_EXTERNAL_WRITE_RE.test(clause)) return true;
      if (classifyExternalEffectRequest(clause).requested) return true;
      if (
        CONTEXTUAL_EXTERNAL_WRITE_VERB_RE.test(clause)
        && !(
          /\b(?:schedule|reschedule)\b/i.test(clause)
          && LOCAL_SCHEDULE_TARGET_RE.test(clause)
          && !EXTERNAL_DESTINATION_RE.test(clause)
        )
      ) return true;
      return EXTERNAL_WRITE_ACTION_RE.test(clause)
        && externalDestinationIsBoundMutationTarget(clause, immediateExecution);
    });
}

export type FreshExternalWriteEvidenceStatus =
  | 'confirmed'
  | 'missing'
  | 'failed'
  | 'ambiguous';

interface SequencedEvidenceEvent {
  seq: number;
  type: string;
  data?: unknown;
}

/**
 * New runtime evidence carries the exact accepted user row that owns it. Keep
 * untagged historical/test rows on the legacy ordered path, but never let a
 * differently tagged overlapping request certify or poison this one.
 */
export function eventBelongsToSourceUserSeq(
  event: SequencedEvidenceEvent,
  sourceUserSeq: number | readonly number[],
): boolean {
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as { sourceUserSeq?: unknown }
    : {};
  const accepted = Array.isArray(sourceUserSeq) ? sourceUserSeq : [sourceUserSeq];
  return !Number.isSafeInteger(data.sourceUserSeq)
    || accepted.includes(data.sourceUserSeq as number);
}

type ExternalWriteAttemptState = 'confirmed' | 'failed' | 'ambiguous';

interface ExternalWriteAttempt {
  callId: string;
  actionKey: string;
  correlationFingerprint: string;
  destinationIdentity: string;
  identity: string;
  state: ExternalWriteAttemptState;
  /** Sequence at which this attempt's current outcome became known. A retry
   * only supersedes a failure/orphan when it started AFTER that resolution. */
  outcomeSeq: number;
}

function externalWriteEventData(event: SequencedEvidenceEvent): Record<string, unknown> {
  return event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : {};
}

function externalWriteIsPreDispatch(event: SequencedEvidenceEvent): boolean {
  return externalWriteEventData(event).preDispatch === true;
}

/**
 * `call_tool` is only a local transport carrier. Its typed pre-dispatch
 * refusal is useful audit evidence, but it is not a failed provider action and
 * therefore must not poison completion after the model corrects the carrier
 * envelope and the validated inner write succeeds.
 *
 * Keep this predicate deliberately strict: a provider tool (or a carrier row
 * missing any part of the trusted no-dispatch proof) remains negative evidence.
 */
function isProvenLocalCarrierRefusal(event: SequencedEvidenceEvent): boolean {
  if (event.type !== 'external_write_failed') return false;
  const data = externalWriteEventData(event);
  const toolName = firstEvidenceText(data, ['toolName', 'tool']);
  return toolName === 'call_tool'
    && data.dispatch === 'not_started'
    && data.effect === 'none'
    && data.preDispatch === true;
}

function firstEvidenceText(data: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  }
  return '';
}

function firstEvidenceId(data: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function externalWriteCallId(event: SequencedEvidenceEvent): string {
  return firstEvidenceId(externalWriteEventData(event), ['canonicalCallId', 'callId']);
}

function externalWriteCorrelationFingerprint(event: SequencedEvidenceEvent): string {
  return firstEvidenceText(externalWriteEventData(event), [
    'correlationFingerprint',
    'payloadFingerprint',
  ]);
}

function externalWriteRetryOfCallId(event: SequencedEvidenceEvent): string {
  return firstEvidenceId(externalWriteEventData(event), ['retryOfCallId']);
}

function externalWriteActionKey(event: SequencedEvidenceEvent): string {
  return firstEvidenceText(externalWriteEventData(event), ['actionKey']);
}

/**
 * Destination identity is useful for pairing legacy pre-dispatch and outcome
 * rows that predate call/payload correlation. It is deliberately NOT sufficient
 * to prove a retry: two requested emails can share a recipient while carrying
 * different subjects and bodies.
 */
function externalWriteDestinationIdentity(event: SequencedEvidenceEvent): string {
  const data = externalWriteEventData(event);
  const shape = firstEvidenceText(data, ['actionKey', 'shapeKey', 'slug', 'toolName', 'tool']);
  const rawTargets = Array.isArray(data.targets)
    ? data.targets
    : typeof data.target === 'string'
      ? [data.target]
      : [];
  const targets = rawTargets
    .filter((target): target is string => typeof target === 'string' && target.trim().length > 0)
    .map((target) => target.trim().toLowerCase())
    .sort();
  if (shape && targets.length > 0) return `shape:${shape}\0targets:${targets.join('\0')}`;
  if (shape) return `shape:${shape}\0targets:unknown`;
  return 'destination:unknown';
}

/**
 * One logical action identity. Fingerprints pair an outcome with its own pre-dispatch row;
 * they never prove that a later start is a retry (an intentional identical
 * resend has the same fingerprint). Only a validated retryOfCallId edge may
 * inherit a prior failed attempt's identity.
 */
function externalWriteIdentity(event: SequencedEvidenceEvent): string {
  const callId = externalWriteCallId(event);
  if (callId) return `call:${callId}`;
  return `legacy:${event.seq}`;
}

function resolveCurrentExternalWriteAttempts(
  events: readonly SequencedEvidenceEvent[],
): ExternalWriteAttempt[] {
  const attempts: ExternalWriteAttempt[] = [];
  const consumedRetryCallIds = new Set<string>();
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.type === 'external_write') {
      let identity = externalWriteIdentity(event);
      const retryOfCallId = externalWriteRetryOfCallId(event);
      const actionKey = externalWriteActionKey(event);
      const destinationIdentity = externalWriteDestinationIdentity(event);
      if (retryOfCallId && !consumedRetryCallIds.has(retryOfCallId)) {
        const prior = [...attempts].reverse().find((attempt) =>
          attempt.callId === retryOfCallId
          && attempt.state === 'failed'
          && actionKey.length > 0
          && attempt.actionKey === actionKey
          && attempt.destinationIdentity === destinationIdentity
        );
        if (prior) {
          identity = prior.identity;
          consumedRetryCallIds.add(retryOfCallId);
        }
      }
      attempts.push({
        callId: externalWriteCallId(event),
        actionKey,
        correlationFingerprint: externalWriteCorrelationFingerprint(event),
        destinationIdentity,
        identity,
        // New rows are durable reservations, not receipts. Legacy rows that
        // predate the explicit flag retain their historical success meaning.
        state: externalWriteIsPreDispatch(event) ? 'ambiguous' : 'confirmed',
        outcomeSeq: event.seq,
      });
      continue;
    }
    if (
      event.type !== 'external_write_succeeded'
      && event.type !== 'external_write_failed'
      && event.type !== 'external_write_orphaned'
    ) continue;

    const callId = externalWriteCallId(event);
    const actionKey = externalWriteActionKey(event);
    const correlationFingerprint = externalWriteCorrelationFingerprint(event);
    const destinationIdentity = externalWriteDestinationIdentity(event);
    const identity = externalWriteIdentity(event);
    let match = -1;
    // Exact provider attempt id wins.
    if (callId) {
      for (let index = attempts.length - 1; index >= 0; index -= 1) {
        if (attempts[index]?.callId === callId) {
          match = index;
          break;
        }
      }
    }
    // Fingerprint fallback is only for a resolution row whose producer lost
    // its call id. A different call id is a different attempt unless the later
    // external_write start carried an explicit retryOfCallId edge.
    if (match < 0 && !callId && correlationFingerprint) {
      for (let index = attempts.length - 1; index >= 0; index -= 1) {
        if (
          attempts[index]?.correlationFingerprint === correlationFingerprint
        ) {
          match = index;
          break;
        }
      }
    }
    // Legacy producers emitted neither call nor payload identity. Pair their
    // negative resolution to the latest provisional destination row, but keep
    // every later provisional write as a distinct action. Destination equality
    // alone is never evidence that a later success retried an earlier failure.
    if (match < 0 && !callId && !correlationFingerprint) {
      for (let index = attempts.length - 1; index >= 0; index -= 1) {
        if (
          attempts[index]?.destinationIdentity === destinationIdentity
          && !attempts[index]?.callId
          && !attempts[index]?.correlationFingerprint
        ) {
          match = index;
          break;
        }
      }
    }
    const state: ExternalWriteAttemptState =
      event.type === 'external_write_succeeded'
        ? 'confirmed'
        : event.type === 'external_write_orphaned'
          ? 'ambiguous'
          : 'failed';
    if (match >= 0) {
      attempts[match] = {
        ...attempts[match]!,
        ...(actionKey ? { actionKey } : {}),
        state,
        outcomeSeq: event.seq,
      };
    } else {
      // Best-effort logging can lose the provisional row while retaining the
      // resolution. Keep the negative evidence instead of silently dropping it.
      attempts.push({
        callId,
        actionKey,
        correlationFingerprint,
        destinationIdentity,
        identity,
        state,
        outcomeSeq: event.seq,
      });
    }
  }

  // Only the newest outcome per proven logical action governs. Because
  // `outcomeSeq` moves to the failure/orphan row, an already-in-flight sibling
  // write cannot masquerade as a later corrective retry.
  const latestByIdentity = new Map<string, ExternalWriteAttempt>();
  for (const attempt of attempts) {
    const prior = latestByIdentity.get(attempt.identity);
    if (!prior || attempt.outcomeSeq > prior.outcomeSeq) {
      latestByIdentity.set(attempt.identity, attempt);
    }
  }
  return [...latestByIdentity.values()];
}

/**
 * Resolve external-write evidence strictly after the accepted user row. The
 * write gate records `external_write` before dispatch; demonstrable failures
 * and ambiguous timeouts compensate that provisional row. Historical rows at
 * or before `sourceUserSeq` can never certify this request.
 */
export function freshExternalWriteEvidenceStatus(
  events: readonly SequencedEvidenceEvent[],
  sourceUserSeq: number | readonly number[] | undefined,
): FreshExternalWriteEvidenceStatus {
  const acceptedSourceUserSeqs = (
    Array.isArray(sourceUserSeq) ? sourceUserSeq : [sourceUserSeq]
  ).filter((seq): seq is number => Number.isSafeInteger(seq) && (seq ?? 0) > 0);
  if (acceptedSourceUserSeqs.length === 0) return 'missing';
  const firstSourceUserSeq = Math.min(...acceptedSourceUserSeqs);
  const current = events.filter((event) =>
    event.seq > firstSourceUserSeq
    && eventBelongsToSourceUserSeq(event, acceptedSourceUserSeqs)
    // Retain this row in the durable audit log, but exclude it from provider
    // completion truth. The validated inner tool owns that lifecycle.
    && !isProvenLocalCarrierRefusal(event)
  );
  const outcomes = resolveCurrentExternalWriteAttempts(current);
  if (outcomes.some((attempt) => attempt.state === 'ambiguous')) return 'ambiguous';
  if (outcomes.some((attempt) => attempt.state === 'failed')) return 'failed';
  return outcomes.some((attempt) => attempt.state === 'confirmed') ? 'confirmed' : 'missing';
}

/**
 * A controller certificate may backfill a missing best-effort write ledger, but
 * it can never erase explicit negative evidence from this request. Both
 * foreground brains use this one precedence rule.
 */
export function freshExternalWriteEvidenceIsVerified(
  status: FreshExternalWriteEvidenceStatus,
  acceptedExecutionCompletion = false,
): boolean {
  return status === 'confirmed'
    || (status === 'missing' && acceptedExecutionCompletion);
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
const OPTIONAL_UPPER_BOUND_RESULT_RE =
  /\b(?:up\s+to|at\s+most|no\s+more\s+than|a\s+maximum\s+of|max(?:imum)?\s+of)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s+[\w-]+){0,4}\s+(?:emails|messages|files|documents|reports|posts|records|contacts|tasks|events|invoices|rows|items|results|suggestions|matches|ideas|options)\b/gi;
const OPTIONAL_UPPER_BOUND_QUANTIFIER_RE =
  /\b(?:up\s+to|at\s+most|no\s+more\s+than|a\s+maximum\s+of|max(?:imum)?\s+of)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/gi;
const NEGATED_DELIVERABLE_CLAUSE_RE =
  /\b(?:do\s+not|don't|dont|never)\b(?:(?!\b(?:but|however|instead|then)\b)[^;.!?\n])*/gi;

/** A single successful mutation cannot prove a batch or compound objective is
 * complete. These objectives retain one bounded completion-judge check.
 *
 * An explicit upper bound is a ceiling, not a quota. "Return up to three
 * suggestions" may correctly produce zero, one, two, or three results from one
 * verified lookup; treating "three" as three required deliverables caused the
 * completion judge to overrule a real empty result and authorize extra vendor
 * calls the user had explicitly forbidden. Project only the bounded result
 * phrase away before looking for required plurals/quantifiers; compound actions
 * and any required quantity elsewhere remain visible. */
export function objectiveMayRequireMultipleResults(objectiveText: string): boolean {
  const objective = objectiveText.trim();
  if (!objective) return false;
  const required = objective
    // Prohibited work is an authority boundary, never a deliverable. Without
    // this projection, "do not write files or create tasks" looked like a
    // plural objective and paid for a completion judge after an otherwise
    // concrete one-call lookup.
    .replace(NEGATED_DELIVERABLE_CLAUSE_RE, ' prohibited work ')
    .replace(OPTIONAL_UPPER_BOUND_RESULT_RE, ' optional bounded result ')
    .replace(OPTIONAL_UPPER_BOUND_QUANTIFIER_RE, ' optional bound ');
  return MULTI_RESULT_NOUN_RE.test(required)
    || MULTI_RESULT_QUANTIFIER_RE.test(required)
    || ACTION_SEQUENCE_RE.test(required)
    || /(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/.test(required);
}

function structuredTrue(value: unknown): boolean {
  return value === true
    || value === 1
    || (typeof value === 'string' && /^(?:1|true|yes)$/i.test(value.trim()));
}

function structuredFalse(value: unknown): boolean {
  return value === false
    || value === 0
    || (typeof value === 'string' && /^(?:0|false|no)$/i.test(value.trim()));
}

function recordLooksFailed(record: Record<string, unknown>): boolean {
  const explicitSuccess =
    structuredTrue(record.successful)
    || structuredTrue(record.success)
    || structuredTrue(record.ok);
  if (
    structuredFalse(record.successful)
    || structuredFalse(record.success)
    || structuredFalse(record.ok)
    || structuredTrue(record.failed)
  ) return true;

  const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';
  if (
    /^(?:aborted|cancelled|canceled|declined|denied|error|failed|failure|no[_ -]?op|noop|not[_ -]?connected|rejected|refused|reverted|rolled[_ -]?back|skipped|unchanged)$/.test(
      status,
    )
  ) return true;
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

const EXTERNAL_WRITE_FAILURE_PROSE_RE =
  /(?:\[provider-dispatch:[^\]]+\]|DATA-QUALITY CHECKPOINT|(?:^|[\r\n])\s*HTTP\s+[45]\d{2}\b|(?:^|[\r\n])\s*(?:ERROR|FAILED|FAILURE)\s*:|\b(?:an?\s+error\s+occurred|invalid\s+(?:field|json|input|request|arguments?|parameters?|payload)|unauthori[sz]ed|forbidden|permission denied|not[_ -]?connected|authentication required|rate limit(?:ed)?|timed out|timeout|missing required|schema validation|could(?:\s+not|n't)|unable\s+to|not\s+(?:committed|completed|executed|successful)|uncommitted|unsuccessful|no\s+changes?\s+(?:was|were)\s+made|nothing\s+(?:changed|created|deleted|sent|updated)|rolled\s+back|rollback|reverted)\b|\b(?:create|delete|deliver|delivery|dispatch|operation|post|provider|publish|request|save|schedule|send|service|tool|update|upload|upstream|write)\b[\s\S]{0,48}\b(?:aborted|cancelled|canceled|declined|denied|disconnected|failed|rejected|refused|unavailable)\b|\b(?:aborted|cancelled|canceled|declined|denied|disconnected|failed|rejected|refused|unavailable)\b[\s\S]{0,48}\b(?:create|delete|deliver|delivery|dispatch|operation|post|provider|publish|request|save|schedule|send|service|tool|update|upload|upstream|write)\b)/i;
const EXTERNAL_WRITE_AMBIGUOUS_PROSE_RE =
  /\b(?:(?:request|operation|job|task|write|delivery)\s+(?:was\s+)?(?:accepted|dispatched|in[_ -]?progress|pending|processing|queued|running|started|submitted)|accepted\s+for\s+(?:delivery|processing)|will\s+be\s+(?:processed|sent|delivered))\b/i;
const EXTERNAL_WRITE_CONTRADICTED_SUCCESS_RE =
  /^(?:(?:successfully\s+)?(?:created|deleted|delivered|posted|published|saved|scheduled|sent|updated|uploaded)\b[\s\S]{0,220}\b(?:(?:commit|validation)\s+failed|changes?\s+(?:were\s+)?discarded|in\s+(?:dry[- ]?run|simulation)\s+mode))[\s\S]*$/i;
const EXTERNAL_WRITE_ZERO_EFFECT_PROSE_RE =
  /^(?:success(?:fully)?[:\s-]+)?(?:changed|created|deleted|delivered|inserted|modified|posted|published|removed|saved|sent|updated|uploaded)\s+0+\s+(?:cells?|documents?|emails?|files?|items?|messages?|posts?|records?|rows?|uploads?)\b/i;
const EXTERNAL_WRITE_ADVISORY_ERROR_RE =
  /\b(?:advisory|deprecat(?:ed|ion)|notice|warning)\b/i;
const EXTERNAL_WRITE_NEGATED_ACK_RE =
  /\b(?:did\s+not|didn't|never|not|was\s+not|wasn't|were\s+not|weren't)\s+(?:create|created|delete|deleted|deliver|delivered|publish|published|post|posted|save|saved|schedule|scheduled|send|sent|update|updated|upload|uploaded)\b/i;

const EXTERNAL_WRITE_PLAIN_ACK_RE =
  /^(?:(?:ok|success|succeeded|complete|completed|created|updated|sent|published|posted|delivered|deleted|removed|saved|uploaded|scheduled|invited)[.!]?)$/i;
const EXTERNAL_WRITE_ACTION_ACK_RE =
  /^(?:success(?:fully)?[:\s-]+)?(?:created|updated|sent|published|posted|delivered|deleted|removed|saved|uploaded|scheduled|invited)\s+(?:(?:an?|the)\s+)?(?:\d+\s+)?(?:branch(?:es)?|calendar\s+events?|commits?|deployments?|documents?|drafts?|emails?|events?|files?|invites?|messages?|pages?|posts?|pull\s+requests?|records?|reply|replies|repository|repositories|rows?|sites?|tags?|texts?|tweets?|uploads?)\b[\s\S]{0,180}$/i;
const EXTERNAL_WRITE_SUBJECT_ACK_RE =
  /^(?:(?:an?|the)\s+)?(?:branch(?:es)?|calendar\s+events?|commits?|deployments?|documents?|drafts?|emails?|events?|files?|invites?|messages?|pages?|posts?|pull\s+requests?|records?|reply|replies|repository|repositories|rows?|sites?|tags?|texts?|tweets?|uploads?)\s+(?:was\s+)?(?:created|updated|sent|published|posted|delivered|deleted|removed|saved|uploaded|scheduled|invited)[.!]?$/i;
const EXTERNAL_WRITE_SUCCESS_SUFFIX_RE =
  /^[\s\S]{1,160}\b(?:created|updated|sent|published|posted|delivered|deleted|removed|saved|uploaded|scheduled|invited)\s+successfully[.!]?$/i;
const EXTERNAL_WRITE_PROSE_RECEIPT_RE =
  /\b(?:created|updated|sent|published|posted|delivered|deleted|removed|saved|uploaded|scheduled|invited)\b[\s\S]{0,160}\b(?:confirmation|document|draft|event|file|message|page|post|record|reply|resource|row|transaction|upload)?[ _-]?(?:id|identifier|number|receipt)\s*[:=#]\s*[A-Za-z0-9][A-Za-z0-9._:/-]{2,}/i;
const EXTERNAL_WRITE_AMBIGUOUS_STATUS_RE =
  /^(?:accepted|building|deploying|in[_ -]?progress|initializing|pending|processing|provisioning|queued|running|scheduled|started|submitted|waiting)$/;
const EXTERNAL_WRITE_SUCCESS_STATUS_RE =
  /^(?:ok|success|succeeded|complete|completed|created|updated|sent|published|posted|delivered|deleted|removed|saved|uploaded)$/;
const EXTERNAL_WRITE_ECHO_CONTAINER_KEYS = new Set([
  'arg',
  'args',
  'argument',
  'arguments',
  'body',
  'input',
  'inputs',
  'parameters',
  'payload',
  'request',
]);
const EXTERNAL_WRITE_RECEIPT_URL_KEYS = new Set([
  'deploy_url',
  'display_url',
  'html_url',
  'location',
  'permalink',
  'resource_url',
  'urn',
  'web_url',
]);
const EXTERNAL_WRITE_MUTATION_ID_KEYS = new Set([
  'arn',
  'attachment_id',
  'calendar_event_id',
  'comment_id',
  'confirmation_id',
  'contact_id',
  'deploy_id',
  'deployment_id',
  'document_id',
  'draft_id',
  'email_id',
  'event_id',
  'file_id',
  'gid',
  'invite_id',
  'inserted_id',
  'issue_id',
  'lead_id',
  'message_id',
  'node_id',
  'note_id',
  'page_id',
  'post_id',
  'pull_request_id',
  'receipt_id',
  'record_id',
  'reply_id',
  'resource_id',
  'row_id',
  'last_insert_rowid',
  'spreadsheet_id',
  'task_id',
  'thread_id',
  'transaction_id',
  'tweet_id',
  'uid',
  'upload_id',
  'upserted_id',
]);
const EXTERNAL_WRITE_NON_RECEIPT_ID_KEYS = new Set([
  'account_id',
  'client_id',
  'connected_account_id',
  'connection_id',
  'connector_id',
  'correlation_id',
  'execution_id',
  'integration_id',
  'job_id',
  'operation_id',
  'request_id',
  'run_id',
  'session_id',
  'span_id',
  'tenant_id',
  'trace_id',
  'user_id',
  'workspace_id',
]);
const EXTERNAL_WRITE_MUTATION_VALUE_KEYS = new Set([
  'cleared_range',
  'updated_range',
]);
const EXTERNAL_WRITE_MUTATION_BOOLEAN_KEY_RE =
  /^(?:changed|cleared|created|deleted|delivered|invited|merged|posted|published|removed|saved|scheduled|sent|updated|uploaded)$/;
const EXTERNAL_WRITE_MUTATION_COUNT_KEY_RE =
  /^(?:changes|(?:(?:affected|changed|created|deleted|inserted|modified|published|sent|updated)(?:_(?:cells?|columns?|documents?|items?|records?|rows?))?(?:_count)?|row_count|rows_affected))$/;

function normalizedAcknowledgementKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function parseWrappedExternalWriteJson(text: string): unknown | undefined {
  let candidate = text.trim();
  if (/^HTTP\s+\d{3}\b/i.test(candidate)) {
    const lines = candidate.split(/\r?\n/);
    const bodyStart = lines.findIndex((line, index) =>
      index > 0 && /^\s*(?:```|\{|\[)/.test(line));
    if (bodyStart >= 0) candidate = lines.slice(bodyStart).join('\n').trim();
  }
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1]?.trim() ?? '';
  const labelled = candidate.match(/^(?:output|response|result)\s*:\s*([\s\S]+)$/i);
  if (labelled) candidate = labelled[1]?.trim() ?? '';
  if (
    !(
      (candidate.startsWith('{') && candidate.endsWith('}'))
      || (candidate.startsWith('[') && candidate.endsWith(']'))
    )
  ) return undefined;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }
}

function acknowledgementReceiptValue(key: string, value: unknown): boolean {
  const normalizedKey = normalizedAcknowledgementKey(key);
  const idKey = !EXTERNAL_WRITE_NON_RECEIPT_ID_KEYS.has(normalizedKey)
    && (
      normalizedKey === 'id'
      || EXTERNAL_WRITE_MUTATION_ID_KEYS.has(normalizedKey)
      || /^(?:etag|receipt|receipt_number|confirmation_number)$/.test(normalizedKey)
    );
  const urlKey = EXTERNAL_WRITE_RECEIPT_URL_KEYS.has(normalizedKey);
  const mutationValueKey = EXTERNAL_WRITE_MUTATION_VALUE_KEYS.has(normalizedKey);
  const countKey = EXTERNAL_WRITE_MUTATION_COUNT_KEY_RE.test(normalizedKey);

  if (countKey) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0;
    if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
      return Number(value) > 0;
    }
    return false;
  }
  if (!idKey && !urlKey && !mutationValueKey) return false;
  if (typeof value === 'number') return idKey && Number.isFinite(value) && value > 0;
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text || /^(?:0|false|null|none|undefined)$/i.test(text)) return false;
  if (urlKey) {
    return /^(?:https?:\/\/|urn:)[^\s]+$/i.test(text)
      || (normalizedKey === 'location' && /^\/[^\s]*$/.test(text));
  }
  if (mutationValueKey) return text.length >= 3;
  return text.length >= 3;
}

function externalWriteValueContainsFailure(
  value: unknown,
  depth = 0,
  keyHint = '',
): boolean {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return false;
    if (
      /^(?:false|null|undefined|not ok|0)$/i.test(text)
      && (
        depth === 0
        || /^(?:ok|status|success|successful)$/.test(keyHint)
      )
    ) return true;
    if (
      EXTERNAL_WRITE_FAILURE_PROSE_RE.test(text)
      || EXTERNAL_WRITE_AMBIGUOUS_PROSE_RE.test(text)
      || EXTERNAL_WRITE_CONTRADICTED_SUCCESS_RE.test(text)
      || EXTERNAL_WRITE_ZERO_EFFECT_PROSE_RE.test(text)
      || EXTERNAL_WRITE_NEGATED_ACK_RE.test(text)
    ) return true;
    const parsed = parseWrappedExternalWriteJson(text);
    if (parsed !== undefined) {
      return externalWriteValueContainsFailure(parsed, depth + 1, keyHint);
    }
    return false;
  }
  if (typeof value === 'boolean') {
    return value === false
      && (
        depth === 0
        || /^(?:ok|success|successful)$/.test(keyHint)
      );
  }
  if (typeof value === 'number') {
    return depth === 0 && (!Number.isFinite(value) || value <= 0);
  }
  if (Array.isArray(value)) {
    return value.some((item) => externalWriteValueContainsFailure(item, depth + 1, keyHint));
  }
  if (typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  if (recordLooksFailed(record) || structuredTrue(record.isError)) return true;
  const recordExplicitSuccess =
    structuredTrue(record.successful)
    || structuredTrue(record.success)
    || structuredTrue(record.ok)
    || structuredTrue(record.isSuccess)
    || structuredTrue(record.is_success);
  const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';
  if (EXTERNAL_WRITE_AMBIGUOUS_STATUS_RE.test(status)) return true;
  const hasUpsertReceipt = Object.entries(record).some(([rawKey, child]) =>
    normalizedAcknowledgementKey(rawKey) === 'upserted_id'
    && acknowledgementReceiptValue(rawKey, child));
  for (const [rawKey, child] of Object.entries(record)) {
    const key = normalizedAcknowledgementKey(rawKey);
    if (
      key === 'type'
      || key === 'mime_type'
      || EXTERNAL_WRITE_ECHO_CONTAINER_KEYS.has(key)
    ) continue;
    if (
      (key === 'failed' || key === 'is_error')
      && structuredTrue(child)
    ) return true;
    if (
      EXTERNAL_WRITE_MUTATION_BOOLEAN_KEY_RE.test(key)
      && structuredFalse(child)
    ) return true;
    if (
      EXTERNAL_WRITE_MUTATION_COUNT_KEY_RE.test(key)
      && (
        (
          typeof child === 'number'
          && (!Number.isFinite(child) || child <= 0)
        )
        || (
          typeof child === 'string'
          && /^\s*0+(?:\.0+)?\s*$/.test(child)
        )
      )
      && !(hasUpsertReceipt && key === 'modified_count')
    ) return true;
    if (
      /^(?:dry_run|no_op|noop|simulate_only|simulation|skipped)$/.test(key)
      && (
        child === true
        || (typeof child === 'string' && /^(?:1|on|true|yes)$/i.test(child.trim()))
      )
    ) return true;
    if (
      /^(?:tasks?_error|error_count|failed_count)$/.test(key)
      && (
        (
          typeof child === 'number'
          && Number.isFinite(child)
          && child > 0
        )
        || (
          typeof child === 'string'
          && /^\d+(?:\.\d+)?$/.test(child.trim())
          && Number(child) > 0
        )
      )
    ) return true;
    if (
      /^(?:phase|ready_state|state|status)$/.test(key)
      && typeof child === 'string'
      && (
        EXTERNAL_WRITE_AMBIGUOUS_STATUS_RE.test(child.trim().toLowerCase())
        || /^(?:aborted|cancelled|canceled|declined|denied|error|failed|failure|no[_ -]?op|noop|rejected|refused|reverted|rolled[_ -]?back|skipped|unchanged)$/.test(
          child.trim().toLowerCase(),
        )
      )
    ) return true;
    if (
      /^(?:status_message|status_text)$/.test(key)
      && typeof child === 'string'
      && /\b(?:denied|error|failed|failure|forbidden|invalid|not found|rejected|unauthori[sz]ed)\b/i.test(child)
    ) return true;
    if (
      (key === 'error' || key === 'errors')
      && (
        child === true
        || (
          typeof child === 'string'
          && child.trim().length > 0
          && !(
            recordExplicitSuccess
            && EXTERNAL_WRITE_ADVISORY_ERROR_RE.test(child)
          )
        )
        || (Array.isArray(child) && child.length > 0)
        || (
          child !== null
          && typeof child === 'object'
          && Object.keys(child).length > 0
        )
      )
    ) return true;
    const numericStatus = typeof child === 'number'
      ? child
      : (
          typeof child === 'string'
          && /^\d+$/.test(child.trim())
            ? Number(child)
            : undefined
        );
    if (
      (key === 'status' || key === 'status_code' || key === 'statuscode')
      && numericStatus !== undefined
      && (
        (
          numericStatus >= 100
          && numericStatus <= 599
          && ![200, 201, 204].includes(numericStatus)
        )
        || (numericStatus >= 40_000 && numericStatus < 60_000)
      )
    ) return true;
    if (externalWriteValueContainsFailure(child, depth + 1, key)) return true;
  }
  return false;
}

function externalWriteValueHasAcknowledgement(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const text = value.trim();
    if (
      !text
      || /^(?:false|null|undefined|no|not ok|0)$/i.test(text)
      || EXTERNAL_WRITE_FAILURE_PROSE_RE.test(text)
      || EXTERNAL_WRITE_AMBIGUOUS_PROSE_RE.test(text)
      || EXTERNAL_WRITE_CONTRADICTED_SUCCESS_RE.test(text)
      || EXTERNAL_WRITE_ZERO_EFFECT_PROSE_RE.test(text)
      || EXTERNAL_WRITE_NEGATED_ACK_RE.test(text)
    ) return false;
    const parsed = parseWrappedExternalWriteJson(text);
    if (parsed !== undefined) {
      return externalWriteValueHasAcknowledgement(parsed, depth + 1);
    }
    return EXTERNAL_WRITE_PLAIN_ACK_RE.test(text)
      || EXTERNAL_WRITE_ACTION_ACK_RE.test(text)
      || EXTERNAL_WRITE_SUBJECT_ACK_RE.test(text)
      || EXTERNAL_WRITE_SUCCESS_SUFFIX_RE.test(text)
      || EXTERNAL_WRITE_PROSE_RECEIPT_RE.test(text);
  }
  // Only a top-level true is itself an explicit acknowledgement. Nested
  // booleans require a success/ok key, handled in the object branch.
  if (typeof value === 'boolean') return depth === 0 && value;
  if (typeof value === 'number') return false;
  if (Array.isArray(value)) {
    if (value.length === 0) return false;
    // MCP content blocks are a transport envelope, not acknowledgement by
    // themselves. At least one non-empty block must carry clean evidence and
    // no block may carry a failure marker.
    let acknowledged = false;
    for (const item of value) {
      if (
        item
        && typeof item === 'object'
        && !Array.isArray(item)
        && (item as Record<string, unknown>).type === 'text'
      ) {
        const text = (item as Record<string, unknown>).text;
        if (
          typeof text !== 'string'
          || !text.trim()
          || EXTERNAL_WRITE_FAILURE_PROSE_RE.test(text)
          || EXTERNAL_WRITE_AMBIGUOUS_PROSE_RE.test(text)
          || EXTERNAL_WRITE_CONTRADICTED_SUCCESS_RE.test(text)
          || EXTERNAL_WRITE_ZERO_EFFECT_PROSE_RE.test(text)
        ) {
          return false;
        }
        acknowledged = externalWriteValueHasAcknowledgement(text, depth + 1) || acknowledged;
        continue;
      }
      acknowledged = externalWriteValueHasAcknowledgement(item, depth + 1) || acknowledged;
    }
    return acknowledged;
  }
  if (typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 0 || recordLooksFailed(record)) return false;
  if (structuredTrue(record.isError)) return false;

  const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';
  if (EXTERNAL_WRITE_AMBIGUOUS_STATUS_RE.test(status)) return false;

  let acknowledged =
    structuredTrue(record.successful)
    || structuredTrue(record.success)
    || structuredTrue(record.ok)
    || structuredTrue(record.isSuccess)
    || structuredTrue(record.is_success)
    || EXTERNAL_WRITE_SUCCESS_STATUS_RE.test(status);
  for (const [rawKey, child] of Object.entries(record)) {
    const key = normalizedAcknowledgementKey(rawKey);
    if (key === 'type' || key === 'mime_type') continue;
    if (
      typeof child === 'string'
      && (
        EXTERNAL_WRITE_FAILURE_PROSE_RE.test(child)
        || EXTERNAL_WRITE_AMBIGUOUS_PROSE_RE.test(child)
        || EXTERNAL_WRITE_CONTRADICTED_SUCCESS_RE.test(child)
        || EXTERNAL_WRITE_ZERO_EFFECT_PROSE_RE.test(child)
      )
    ) return false;
    if (EXTERNAL_WRITE_ECHO_CONTAINER_KEYS.has(key)) continue;
    if (acknowledgementReceiptValue(key, child)) {
      acknowledged = true;
      continue;
    }
    if (
      (key === 'successful' || key === 'success' || key === 'ok' || key === 'is_success')
      && structuredTrue(child)
    ) {
      acknowledged = true;
      continue;
    }
    if (
      EXTERNAL_WRITE_MUTATION_BOOLEAN_KEY_RE.test(key)
      && structuredTrue(child)
    ) {
      acknowledged = true;
      continue;
    }
    const numericStatus = typeof child === 'number'
      ? child
      : (
          typeof child === 'string'
          && /^\d+$/.test(child.trim())
            ? Number(child)
            : undefined
        );
    if (
      (key === 'status' || key === 'status_code' || key === 'statuscode')
      && numericStatus !== undefined
      && [200, 201, 204].includes(numericStatus)
    ) {
      acknowledged = true;
      continue;
    }
    acknowledged = externalWriteValueHasAcknowledgement(child, depth + 1) || acknowledged;
  }
  return acknowledged;
}

/**
 * External writes need positive provider acknowledgement, not merely the
 * absence of a parseable error flag. Empty envelopes, malformed/failure prose,
 * and dispatch-status markers remain ambiguous and can never certify a write.
 */
export function toolOutputProvesExternalWriteAcknowledgement(
  output: unknown,
  explicitOk?: unknown,
): boolean {
  if (
    explicitOk === false
    || !toolOutputLooksSuccessful(output, explicitOk)
    || externalWriteValueContainsFailure(output)
  ) return false;
  if (
    typeof output === 'string'
    && /^HTTP\s+(?:200|201|204)\b(?:\s+(?:OK|Created|No Content))?[.!]?(?:\r?\n|$)/i.test(output.trim())
  ) return true;
  return externalWriteValueHasAcknowledgement(output);
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
