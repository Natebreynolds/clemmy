import type { WorkflowDefinition, WorkflowStepInput } from '../memory/workflow-store.js';
import { getSession, listEvents } from '../runtime/harness/eventlog.js';
import { isHarnessInjectedInput } from '../runtime/harness/objective-judge.js';

/** Keep workflow recall cheaper than the ordinary 2.6k-char primer itself. */
export const WORKFLOW_MEMORY_QUERY_MAX_BYTES = 1_600;
export const WORKFLOW_MEMORY_RECENCY_DAYS = 30;

const DAY_MS = 24 * 60 * 60_000;
const MAX_RECENT_EVENT_SCAN = 20;
const MAX_RECENT_TOPIC_MESSAGES = 2;
const MAX_RECENT_MESSAGE_CHARS = 320;

const TOPIC_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'these', 'those', 'into',
  'your', 'you', 'our', 'their', 'then', 'than', 'when', 'where', 'what', 'which',
  'who', 'why', 'how', 'use', 'uses', 'using', 'used', 'apply', 'prepare', 'run',
  'step', 'workflow', 'standard', 'current', 'latest', 'daily', 'weekly', 'monthly',
]);

function compact(value: unknown, maxChars: number): string {
  // Slice before normalizing. A giant bound value or pasted artifact must not
  // turn this small synchronous query builder into another latency/disk lane.
  let prefix = String(value ?? '').slice(0, maxChars * 4);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  let result = prefix
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
  if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
  return result;
}

function topicTokens(value: string, limit = 24): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of value.toLowerCase().match(/[a-z0-9][a-z0-9._@-]{2,}/g) ?? []) {
    if (TOPIC_STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    result.push(token);
    if (result.length >= limit) break;
  }
  return result;
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result.trimEnd();
}

/**
 * Synthetic harness turns can be stored as `user_input_received`; a workflow
 * query must never promote those carriers back into memory relevance. The
 * shared injected-input classifier owns known harness prefixes, while the
 * small structural checks below cover notification/envelope shapes rather
 * than enumerating product-specific notification prose.
 */
export function workflowPrimerMessageIsUserAuthored(text: string): boolean {
  const value = text.trim();
  if (!value || isHarnessInjectedInput(value)) return false;
  if (/^\[(?:system|harness|notification|approval|worker|daemon)\b[^\]]{0,100}\]/i.test(value)) return false;
  if (/^(?:system|harness|daemon)\s+notification\s*:/i.test(value)) return false;
  if (/\bworkflow:\s/i.test(value) && /\bstep:\s/i.test(value)) return false;
  return true;
}

function recentRelevantOriginMessages(input: {
  originSessionId?: string;
  topicTerms: Set<string>;
  nowMs: number;
}): string[] {
  const originSessionId = input.originSessionId?.trim();
  if (!originSessionId || input.topicTerms.size === 0) return [];
  try {
    // Only an actual conversation can contribute recency. Workflow/agent/
    // execution sessions contain host-authored turns with a user-shaped role.
    if (getSession(originSessionId)?.kind !== 'chat') return [];
    const cutoff = input.nowMs - WORKFLOW_MEMORY_RECENCY_DAYS * DAY_MS;
    return listEvents(originSessionId, {
      types: ['user_input_received'],
      desc: true,
      limit: MAX_RECENT_EVENT_SCAN,
    })
      .filter((event) => {
        if (event.role.toLowerCase() !== 'user') return false;
        if (event.data.synthetic === true) return false;
        const carrier = typeof event.data.source === 'string'
          ? event.data.source.trim().toLowerCase()
          : '';
        if (['system', 'harness', 'notification', 'daemon'].includes(carrier)) return false;
        const at = Date.parse(event.createdAt);
        if (!Number.isFinite(at) || at < cutoff || at > input.nowMs + 60_000) return false;
        const text = typeof event.data.text === 'string' ? event.data.text : '';
        if (!workflowPrimerMessageIsUserAuthored(text)) return false;
        const matches = topicTokens(text).filter((token) => input.topicTerms.has(token));
        // One distinctive term is enough (a project/account name); generic
        // terms are removed by TOPIC_STOPWORDS before this comparison.
        return matches.length > 0;
      })
      .map((event) => compact(event.data.text, MAX_RECENT_MESSAGE_CHARS))
      .filter(Boolean)
      .slice(0, MAX_RECENT_TOPIC_MESSAGES)
      .reverse();
  } catch {
    // Recall context is advisory. An unreadable origin transcript must never
    // stop an unattended workflow from doing its admitted work.
    return [];
  }
}

export interface WorkflowMemoryPrimerQueryInput {
  workflow: Pick<WorkflowDefinition, 'name' | 'description' | 'whenToUse' | 'description_body'>;
  step: Pick<WorkflowStepInput, 'id' | 'prompt'>;
  /** Rendered prompt is last and tightly bounded; authored metadata stays first. */
  renderedPrompt?: string;
  originSessionId?: string;
  nowMs?: number;
  maxBytes?: number;
}

/**
 * Build the semantic query for the workflow's existing unified primer.
 *
 * This is query refinement only: it neither reads/injects facts itself nor
 * bypasses consolidation, dedupe, trust, correction, or attribution gates.
 * Topic terms lead because fact FTS intentionally considers only a bounded
 * token head; at most two same-origin, topic-overlapping user turns add a
 * 30-day recency signal. The ordinary unified primer remains the sole writer
 * of model-visible memory context.
 */
export function buildWorkflowMemoryPrimerQuery(input: WorkflowMemoryPrimerQueryInput): string {
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const description = compact(input.workflow.description, 480);
  const whenToUse = compact(input.workflow.whenToUse, 240);
  const body = compact(input.workflow.description_body, 240);
  const workflowName = compact(input.workflow.name, 120);
  const stepPrompt = compact(input.step.prompt, 480);
  const renderedPrompt = compact(input.renderedPrompt, 480);
  const authoredTopic = [description, whenToUse, body, workflowName, stepPrompt]
    .filter(Boolean)
    .join(' ');
  const authoredTerms = topicTokens(authoredTopic);
  const recent = recentRelevantOriginMessages({
    originSessionId: input.originSessionId,
    topicTerms: new Set(authoredTerms),
    nowMs,
  });
  const recentTerms = topicTokens(recent.join(' '));
  // Same-origin recent detail leads when present; authored topic fills the
  // remaining bounded FTS head and is the complete fallback for scheduled runs.
  const keywordHead = [...new Set([...recentTerms, ...authoredTerms])].slice(0, 12).join(' ');
  const query = [
    keywordHead,
    description,
    whenToUse,
    body,
    workflowName,
    stepPrompt,
    ...recent,
    renderedPrompt,
  ].filter(Boolean).join('\n');
  const requestedMaxBytes = Math.trunc(input.maxBytes ?? WORKFLOW_MEMORY_QUERY_MAX_BYTES);
  const maxBytes = Number.isFinite(requestedMaxBytes)
    ? Math.max(256, Math.min(4_000, requestedMaxBytes))
    : WORKFLOW_MEMORY_QUERY_MAX_BYTES;
  return utf8Prefix(query, maxBytes);
}
