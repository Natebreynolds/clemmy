const COMPOSIO_SLUG_RE = /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/g;

/** Lifecycle prose may name the current action. Identifiers are discovery
 * hints until an exact provider lookup returns the same slug. */
export function successorSlugsFromProse(text: string): string[] {
  if (!text.trim()) return [];
  const successors: string[] = [];
  const add = (raw: string): void => {
    const identifier = raw.trim().toUpperCase();
    if (!identifier || successors.includes(identifier)) return;
    successors.push(identifier);
  };
  for (const match of text.matchAll(/\bprefer\b([^.!?\n]+)/gi)) {
    for (const identifier of (match[1] ?? '').match(COMPOSIO_SLUG_RE) ?? []) add(identifier);
  }
  for (const match of text.matchAll(/\buse\b[\s:]+([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)(?:\s+instead\b)?/gi)) {
    add(match[1] ?? '');
  }
  return successors.slice(0, 4);
}
