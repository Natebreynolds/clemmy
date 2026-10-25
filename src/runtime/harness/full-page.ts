/**
 * A read that came back exactly as full as it asked to be.
 *
 * Asked for a total ("how many unread emails"), a model sometimes lists the
 * records once with a page size, gets exactly that many back and reports the
 * page as the answer ("at least 1,000"). The shape alone says what that
 * page is: the list holds exactly as many records as a size the call asked
 * for, so the source likely holds more and the count is not a total. The
 * host says so beside the result, with where a total usually comes from.
 *
 * Only a real page counts (FULL_PAGE_MIN records or more): a short "five
 * most recent" selection is the whole answer to its question. Generic over
 * tools: nothing here names an argument or a provider.
 */
import { countDominantArray } from './tool-output-digest.js';

export const FULL_PAGE_MIN = 50;

function numbersIn(value: unknown, depth = 0, found: number[] = []): number[] {
  if (depth > 8 || found.length > 64) return found;
  if (typeof value === 'number' && Number.isSafeInteger(value)) found.push(value);
  else if (typeof value === 'string' && value.trim().startsWith('{')) {
    try { numbersIn(JSON.parse(value), depth + 1, found); } catch { /* text, not an encoded object */ }
  } else if (Array.isArray(value)) value.forEach((item) => numbersIn(item, depth + 1, found));
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) numbersIn(item, depth + 1, found);
  }
  return found;
}

/** The note for a read whose list came back exactly as full as a size it
 *  asked for, or null. */
export function fullPageNote(args: unknown, resultText: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(resultText); } catch { return null; }
  // A carrier holds its child's bounded view: the host's own record of the
  // list's size, not the rows it kept, is the count.
  const recorded = (parsed as { __clementine?: { records?: { total?: unknown } } } | null)?.__clementine?.records?.total;
  const count = typeof recorded === 'number' ? recorded : countDominantArray(parsed)?.count ?? 0;
  if (count < FULL_PAGE_MIN || !numbersIn(args).includes(count)) return null;
  return `This read returned ${count} records, exactly the ${count} it asked for, so the source likely holds more: `
    + `${count} is one page, not a total. A total or count usually comes from an operation that returns it directly `
    + '(search for one); report this page as a total only if nothing returns one.';
}
