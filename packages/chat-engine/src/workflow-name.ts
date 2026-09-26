/**
 * A workflow's name, the way a person would say it.
 *
 * Definitions are keyed by slug ("daily-overdue-salesforce-meetings",
 * "automation-9574eff2192f943e"). A slug is an identifier, not a title: the
 * title is the words, with the slug kept as a caption where the identifier
 * matters. A machine-minted slug (a generic stem plus a hash or a timestamp)
 * has no words at all, so the workflow's own description stands in for it.
 * Rule-based on shape only; there is no list of names here.
 */

const GENERIC_STEMS = new Set(['automation', 'workflow', 'flow', 'task', 'run', 'job', 'routine']);

function isSlug(name: string): boolean {
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(name);
}

function isMachinePart(part: string): boolean {
  return /^[0-9a-f]{8,}$/.test(part) || /^\d{8,}$/.test(part);
}

function firstClause(text: string, max = 64): string {
  const clause = text.trim().split(/(?<=[.!?:;])\s|\s[—–-]\s/)[0]?.trim() ?? '';
  if (!clause) return '';
  if (clause.length <= max) return clause.replace(/[.:;]$/, '');
  const cut = clause.slice(0, max).replace(/\s+\S*$/, '');
  return `${cut}…`;
}

function titleCase(words: string[]): string {
  return words
    .map((word, index) => {
      if (/^\d/.test(word)) return word;
      if (index > 0 && /^(a|an|and|at|by|for|in|of|on|or|the|to|vs|with)$/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/** The words to show as a title. Equal to `name` when the name already is words. */
export function workflowDisplayName(name: string, description?: string | null): string {
  const trimmed = name.trim();
  if (!trimmed || !isSlug(trimmed)) return trimmed;
  const parts = trimmed.split(/[-_]/);
  const words = parts.filter((part) => !isMachinePart(part));
  const machine = parts.length - words.length;
  const stemIsGeneric = words.length === 0 || (words.length === 1 && GENERIC_STEMS.has(words[0]));
  if (machine > 0 && stemIsGeneric) {
    const fromDescription = description ? firstClause(description) : '';
    if (fromDescription) return fromDescription;
    return words.length ? `${titleCase(words)} ${parts[parts.length - 1].slice(0, 6)}` : trimmed;
  }
  return titleCase(words.length ? words : parts);
}

/** The identifier, shown small beside the title only when the title is not the name itself. */
export function workflowCaption(name: string, description?: string | null): string {
  return workflowDisplayName(name, description) === name.trim() ? '' : name.trim();
}
