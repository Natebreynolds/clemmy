/** Extract explicit project names, not inferred subjects or scope rules. A name
 * must be quoted or a delimited title after “project”. The semantic extraction
 * path remains responsible for other phrasing; this never guesses aliases. */
export function extractGroundedUserProjects(text: string): string[] {
  const source = text.replace(/\s+/g, ' ').trim();
  const names = new Map<string, string>();
  const prefix = String.raw`\b[Pp]roject\s+(?:(?:named|called)\s+)?`;
  const titleWord = String.raw`(?:[\p{Lu}][\p{L}\p{N}'’_-]*|[0-9]+)`;
  const patterns = [
    new RegExp(prefix + String.raw`["“]([^"”]{2,160})["”]`, 'gu'),
    new RegExp(prefix + String.raw`'([^'\n]{2,160})'`, 'gu'),
    new RegExp(prefix + `(${titleWord}(?:\\s+${titleWord}){1,11})(?=\\s*[:,;.!?]|$)`, 'gu'),
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) {
    const name = match[1]!.trim();
    if (!/\p{L}/u.test(name) || name.length > 160) continue;
    names.set(name.toLowerCase(), name);
  }
  return [...names.values()].slice(0, 8);
}
