/**
 * How a waiting decision reads, on every surface: one line in a list, and a
 * short heading over its full text when opened. Pure text rules shared by the
 * desktop Needs you list and the phone's, so the same record never reads one
 * way on one device and another way on the other. Layout stays per surface.
 */

const PREVIEW_MAX = 140;
const HEADING_MAX = 140;

/** Collapse markdown and whitespace into one readable line, cut at a word. */
export function oneLine(text: string | null | undefined, max = PREVIEW_MAX): string {
  const flat = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** A bare reference (`noticing:ntc-…`, a run id): no spaces, punctuation and
 *  digits. It belongs behind a disclosure, never in the line a person reads. */
export function isIdentifierLike(text: string | null | undefined): boolean {
  const value = String(text ?? '').trim();
  return value.length >= 8 && !/\s/.test(value) && /[:/_.-]/.test(value) && /\d/.test(value);
}

/** The first candidate that adds something the title does not already say,
 *  as one line. References and repeats of the title are skipped. */
export function decisionPreview(title: string, candidates: ReadonlyArray<string | null | undefined>): string | undefined {
  const normalizedTitle = title.toLowerCase().replace(/…$/, '');
  for (const candidate of candidates) {
    if (isIdentifierLike(candidate)) continue;
    const line = oneLine(candidate);
    if (!line) continue;
    const normalized = line.toLowerCase().replace(/…$/, '');
    if (normalized === normalizedTitle || normalizedTitle.startsWith(normalized) || normalized.startsWith(normalizedTitle)) continue;
    return line;
  }
  return undefined;
}

/** A heading stays a heading: long text leads with its own first line or
 *  first sentence and the rest moves into the body. A little over the limit
 *  stays whole. Only longer text is cut at a word, and then the body continues
 *  exactly where the heading stops — nothing lost, nothing repeated. */
export function decisionHeading(text: string, max = HEADING_MAX): { heading: string; body?: string } {
  const trimmed = text.trim();
  const flat = trimmed.replace(/\s+/g, ' ');
  if (flat.length <= max) return { heading: flat };
  const firstLine = trimmed.split(/\n/, 1)[0]!.trim();
  if (firstLine.length >= 20 && firstLine.length <= max) {
    return { heading: firstLine, body: trimmed.slice(trimmed.indexOf(firstLine) + firstLine.length).trim() };
  }
  const sentence = /^(.{20,}?[.?!])\s/.exec(flat)?.[1];
  if (sentence && sentence.length <= max) return { heading: sentence, body: flat.slice(sentence.length).trim() };
  if (flat.length <= max * 1.5) return { heading: flat };
  const cut = flat.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const lead = (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
  return { heading: `${lead}…`, body: `…${flat.slice(lead.length).trimStart()}` };
}
