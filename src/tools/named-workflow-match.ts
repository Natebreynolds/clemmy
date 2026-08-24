/**
 * Catalog match for an existing workflow against free-text.
 *
 * resolveWorkflowName is the pure matcher. This wrapper is the host's
 * catalog view: every saved workflow, enabled or not, and only a unique
 * exact/fuzzy resolution. Disabled drafts stay in the catalog because a
 * user who uniquely names one is asking to run that workflow, not to
 * have chat reinvent it. Ambiguous and none stay unclaimed so chat can
 * inspect or ask. No phrase lists — the existing resolver already strips
 * action filler ("run", "kick off") before scoring.
 */
import { listWorkflows } from '../memory/workflow-store.js';
import {
  resolveWorkflowName,
  workflowNamesEqual,
  type ResolverEntry,
} from './workflow-resolve.js';

export interface UniqueEnabledWorkflowMatch {
  name: string;
  slug: string;
  enabled: boolean;
  resolutionKind: 'exact' | 'fuzzy';
}

function normalizedWorkflowReferenceTokens(value: string): string[] {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Require a literal workflow identity next to the singular word `workflow`.
 *
 * The catalog resolver intentionally accepts fuzzy free text for interactive
 * dispatch. That is too permissive for terminal evidence: if the real target
 * is absent, an incidental catalog noun such as "schedule" can become the
 * resolver's unique best hit. This predicate supplies the missing syntax
 * boundary while treating spaces, hyphens, underscores, and punctuation as
 * equivalent separators inside the exact candidate. The accepted grammar is
 * deliberately one-way: `workflow [named|called] <candidate>`. A reverse
 * `<candidate> workflow` phrase cannot prove where a space-separated name
 * started, and clause words such as "with" or "and" can themselves belong to
 * a longer name. Terminal evidence therefore accepts only punctuation, a
 * closing quote, or end-of-input after the candidate and fails closed on the
 * ambiguous natural-language forms until accepted tasks freeze target identity.
 */
export function objectiveExplicitlyNamesWorkflow(objective: string, candidate: string): boolean {
  const normalizedObjective = objective.normalize('NFKC');
  const candidateTokens = normalizedWorkflowReferenceTokens(candidate);
  if (!normalizedObjective.trim() || candidateTokens.length === 0) return false;

  const separator = '[^\\p{L}\\p{N}]+';
  const literal = candidateTokens.map(escapeRegExp).join(separator);
  // `_` and `-` are separators *inside* a normalized candidate but compound
  // characters at its outer edge. Keeping them out of the boundary prevents
  // `platform-49` from matching the prefix of
  // `platform-49-slack-channel-review` (and the symmetric suffix case).
  const compoundStart = '(?<![\\p{L}\\p{N}_-])';
  const compoundEnd = '(?![\\p{L}\\p{N}_-])';
  const singularWorkflow = `${compoundStart}workflow${compoundEnd}`;
  const explicitEnd =
    '(?=(?:\\s*$|\\s*[.,;:!?\'"”’)}\\]…–—]))';
  const forward = new RegExp(
    `${singularWorkflow}${separator}(?:(?:named|called)${separator})?${literal}${compoundEnd}${explicitEnd}`,
    'iu',
  );
  return forward.test(normalizedObjective);
}

export function uniqueEnabledWorkflowMatch(
  query: string | undefined | null,
): UniqueEnabledWorkflowMatch | null {
  const text = typeof query === 'string' ? query.trim() : '';
  if (!text) return null;
  let entries: Array<ResolverEntry & { enabled: boolean }>;
  try {
    entries = listWorkflows().map((entry) => ({
      name: entry.data.name,
      slug: entry.name,
      enabled: entry.data.enabled !== false,
    }));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  const resolution = resolveWorkflowName(text, entries);
  if (resolution.kind !== 'exact' && resolution.kind !== 'fuzzy') return null;
  const hit = entries.find((entry) => workflowNamesEqual(entry.name, resolution.name));
  return hit ? {
    name: hit.name,
    slug: hit.slug,
    enabled: hit.enabled,
    resolutionKind: resolution.kind,
  } : null;
}
