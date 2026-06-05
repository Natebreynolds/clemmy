/**
 * Soft boundary guard for the `workflow_run` tool.
 *
 * Incident (2026-05-31): a chat user asked for a one-off ad-hoc task
 * ("scrape their top keywords into a Google sheet"). The agent did NOT
 * clarify and did NOT do the task directly — instead it silently mapped
 * the request onto an UNRELATED existing scheduled workflow
 * ('morning-prospect-prep') and called workflow_run on it, heading toward
 * an external write the user never named.
 *
 * Owner policy: do NOT auto-run an existing workflow the user did not
 * explicitly ask for by name. If no workflow closely aligns, just do the
 * task ad-hoc — don't silently invoke a routine.
 *
 * This module holds the PURE decision so it can be unit-tested without the
 * event log. The handler reads recent user messages from the event log and
 * passes the concatenated text in here.
 */

import { tokenize } from '../shared/workflow-scoring.js';

/** Needles shorter than this are ignored to avoid trivial substring hits. */
const MIN_NEEDLE_LEN = 4;

/** Generic words that aren't distinctive enough to identify a workflow. */
const NAME_STOPWORDS = new Set([
  'workflow', 'workflows', 'with', 'from', 'into', 'your', 'this', 'that',
  'please', 'flow', 'auto', 'daily', 'hourly', 'run', 'the', 'and', 'for',
]);

/** Distinctive (>=4 char, non-stopword) tokens of a workflow name/slug.
 *  Canonical tokenizer with this guard's name-focused stopword policy. */
function distinctiveNameTokens(name: string): string[] {
  return tokenize(name, { minLen: MIN_NEEDLE_LEN, stopwords: NAME_STOPWORDS });
}

/**
 * True when the workflow appears to have been explicitly named by the user
 * in their recent message text.
 *
 * @param workflowName   the workflow's canonical name, e.g. "morning-prospect-prep"
 * @param slugCandidates additional slug/dir variants to match (e.g. the
 *                       directory name, file slug). May be empty.
 * @param recentUserText concatenated recent user-message text for the session.
 */
export function workflowExplicitlyRequested(
  workflowName: string,
  slugCandidates: string[],
  recentUserText: string,
): boolean {
  const haystack = (recentUserText ?? '').toLowerCase();
  if (haystack.trim() === '') return false;

  const raw = [workflowName, ...slugCandidates];
  // Expand each candidate into its hyphen→space and hyphen-removed variants
  // so "morning prospect prep" and "morningprospectprep" also match.
  const needles = new Set<string>();
  for (const candidate of raw) {
    if (typeof candidate !== 'string') continue;
    const base = candidate.trim().toLowerCase();
    if (!base) continue;
    needles.add(base);
    needles.add(base.replace(/[-_]+/g, ' '));
    needles.add(base.replace(/[-_]+/g, ''));
  }

  for (const needle of needles) {
    if (needle.length < MIN_NEEDLE_LEN) continue;
    if (haystack.includes(needle)) return true;
  }

  // Strong PARTIAL match: the user named enough of the workflow's distinctive
  // tokens to clearly mean it WITHOUT typing the full slug — e.g. "fire off the
  // salesforce to airtable workflow" → salesforce-to-airtable-prospect-enrichment.
  // Require >=2 distinctive tokens present so a single shared word (e.g.
  // "prospect") never triggers a false match, and an unrelated ad-hoc request
  // (the original 2026-05-31 incident: "scrape keywords into a sheet" → 0
  // overlap with morning-prospect-prep) still refuses.
  const tokens = new Set(
    [workflowName, ...slugCandidates].flatMap((c) => (typeof c === 'string' ? distinctiveNameTokens(c) : [])),
  );
  if (tokens.size >= 2) {
    const hayTokens = new Set(haystack.split(/[^a-z0-9]+/).filter(Boolean));
    let overlap = 0;
    for (const t of tokens) if (hayTokens.has(t)) overlap += 1;
    if (overlap >= 2) return true;
  }
  return false;
}

/**
 * The soft-guard message returned as tool text when an unrequested
 * workflow_run is blocked. Names the workflow and points the agent toward
 * either doing the task ad-hoc or running the workflow explicitly by name.
 */
export function unrequestedWorkflowRunMessage(name: string): string {
  return [
    `Did not auto-run workflow "${name}". It wasn't named in your recent request, so running it`,
    `could do something you didn't ask for (it may write to an external destination).`,
    `If you want this exact workflow, ask to run "${name}" by name. Otherwise I'll just do the`,
    `task you asked for directly.`,
  ].join(' ');
}
