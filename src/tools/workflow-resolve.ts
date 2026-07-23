/**
 * Fuzzy workflow-name resolution for MANUAL execution.
 *
 * The owner's ask (2026-06-03): "workflows should also be able, when manually
 * executed, to be called by a MATCHING name, not just the direct name.
 * Clementine should reason and ask back — 'just for clarity, did you want me
 * to kick off your prospecting flow?' — then run it and report back."
 *
 * Today `workflow_run` does an exact `data.name === name` lookup and returns
 * "not found" on any miss, so "kick off my prospecting flow" dies when the
 * saved workflow is named "Morning Prospect Prep". This module is the PURE
 * matcher so it can be unit-tested without the store: it turns a free-text
 * name into one of four outcomes and lets the handler drive the conversation.
 *
 *   exact     — the user named the workflow precisely → run it.
 *   fuzzy     — one clear closest match → CONFIRM with the user, then run.
 *   ambiguous — several comparable matches → ask the user which one.
 *   none      — nothing close → don't guess; do the task ad-hoc / list options.
 *
 * (The old workflow-run-guard consumer was deleted 2026-07-23 — effect-layer
 * approval gates carry that protection now.)
 */

import { tokenize } from '../shared/workflow-scoring.js';

/** A workflow as the resolver sees it: just its display name + dir slug. */
export interface ResolverEntry {
  /** Display name, e.g. "Morning Prospect Prep". */
  name: string;
  /** Directory slug, e.g. "morning-prospect-prep". May equal name. */
  slug: string;
}

export type WorkflowResolution =
  | { kind: 'exact'; name: string }
  | { kind: 'fuzzy'; name: string; score: number }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'none'; suggestions: string[] };

/** A fuzzy candidate must clear this token/containment score to be offered. */
const FUZZY_MIN = 0.3;
/** Candidates within this score of the top are treated as equally plausible. */
const AMBIG_GAP = 0.15;
/** Tokens shorter than this carry no identifying signal. */
const MIN_TOKEN_LEN = 3;

/**
 * Generic words that don't identify a workflow: filler, cadence words, and the
 * action verbs a user types around the name ("kick off my prospecting flow").
 * Kept broad on purpose — a single shared filler word must never drive a match.
 */
const STOPWORDS = new Set([
  'workflow', 'workflows', 'flow', 'flows', 'with', 'from', 'into', 'your',
  'this', 'that', 'please', 'auto', 'daily', 'hourly', 'weekly', 'monthly',
  'nightly', 'run', 'runs', 'the', 'and', 'for', 'a', 'an', 'my', 'me', 'it',
  'to', 'of', 'on', 'now', 'again', 'kick', 'off', 'start', 'started',
  'fire', 'launch', 'execute', 'trigger', 'go', 'do', 'get', 'can', 'you',
  'please', 'one', 'job', 'task',
]);

/** Strip non-alphanumerics so "Morning Prospect Prep" ~ "morning-prospect-prep". */
function compact(value: string): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Light suffix stemmer so "prospecting"/"prospects"/"prospect" all collapse to
 * one token. Deliberately tiny — enough to bridge the gap between how a user
 * speaks ("prospecting") and how a slug reads ("prospect"), not a real stemmer.
 */
/** Distinctive, stemmed content tokens of a string (no stopwords/filler).
 *  Uses the canonical tokenizer with this matcher's stopword policy + stemming. */
function contentTokens(value: string): Set<string> {
  return new Set(tokenize(value, { minLen: MIN_TOKEN_LEN, stopwords: STOPWORDS, stem: true }));
}

/** Tokens that identify an entry: union of its name + slug content tokens. */
function entryTokens(entry: ResolverEntry): Set<string> {
  const out = contentTokens(entry.name);
  for (const t of contentTokens(entry.slug)) out.add(t);
  return out;
}

/**
 * Score how strongly a query (already tokenized + compacted) names an entry.
 * Range [0, 1]:
 *   - 0.9 when one compacted form contains the other (e.g. "prospectprep"
 *     inside "morningprospectprep") — a strong partial the user clearly meant.
 *   - otherwise (matched entry-tokens / entry-token count): the share of the
 *     workflow's distinctive words the user actually said.
 */
function scoreEntry(qTokens: Set<string>, qCompact: string, entry: ResolverEntry): number {
  const nameCompact = compact(entry.name);
  const slugCompact = compact(entry.slug);
  let containment = 0;
  if (qCompact.length >= 4) {
    for (const hay of [nameCompact, slugCompact]) {
      if (hay.length >= 4 && (hay.includes(qCompact) || qCompact.includes(hay))) {
        containment = 0.9;
        break;
      }
    }
  }
  const eTokens = entryTokens(entry);
  let tokenScore = 0;
  if (eTokens.size > 0 && qTokens.size > 0) {
    let matched = 0;
    for (const t of eTokens) if (qTokens.has(t)) matched += 1;
    tokenScore = matched / eTokens.size;
  }
  return Math.max(containment, tokenScore);
}

/**
 * Resolve a free-text workflow name against the saved workflows.
 * See module header for the four outcomes.
 */
export function resolveWorkflowName(query: string, entries: ResolverEntry[]): WorkflowResolution {
  const qCompact = compact(query);
  // Exact: the user typed the precise name or slug (modulo spacing/case).
  if (qCompact.length > 0) {
    for (const e of entries) {
      if (compact(e.name) === qCompact || compact(e.slug) === qCompact) {
        return { kind: 'exact', name: e.name };
      }
    }
  }

  const qTokens = contentTokens(query);
  const scored = entries
    .map((e) => ({ name: e.name, score: scoreEntry(qTokens, qCompact, e) }))
    .sort((a, b) => b.score - a.score);

  const viable = scored.filter((s) => s.score >= FUZZY_MIN);
  if (viable.length === 0) {
    return { kind: 'none', suggestions: scored.slice(0, 3).filter((s) => s.score > 0).map((s) => s.name) };
  }

  const top = viable[0];
  const contenders = viable.filter((s) => top.score - s.score <= AMBIG_GAP);
  if (contenders.length === 1) {
    return { kind: 'fuzzy', name: top.name, score: top.score };
  }
  return { kind: 'ambiguous', candidates: contenders.slice(0, 4).map((s) => s.name) };
}

/** Case/spacing-insensitive name equality. */
export function workflowNamesEqual(a: string, b: string): boolean {
  return compact(a) === compact(b);
}

/**
 * Does a free-text blob (e.g. the user's recent messages) refer to THIS
 * workflow? Used by the run-guard so a confirmed fuzzy run isn't re-blocked as
 * "unrequested". True only when the blob's best resolution points at this
 * workflow (exact, fuzzy, or one of an ambiguous set) — not merely a weak
 * token brush, and not when the text clearly names a DIFFERENT workflow.
 */
export function textRefersToWorkflow(
  text: string,
  entry: ResolverEntry,
  allEntries: ResolverEntry[],
): boolean {
  if (!text || text.trim() === '') return false;
  const resolution = resolveWorkflowName(text, allEntries);
  switch (resolution.kind) {
    case 'exact':
    case 'fuzzy':
      return workflowNamesEqual(resolution.name, entry.name);
    case 'ambiguous':
      return resolution.candidates.some((c) => workflowNamesEqual(c, entry.name));
    case 'none':
      return false;
  }
}
