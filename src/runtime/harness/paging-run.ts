/**
 * The same list, read page after page.
 *
 * Asked for a total ("how many unread emails"), a model sometimes pages
 * through every record of a list to count it, one model round per page with
 * its history growing each time (live: fifteen pages and about two million
 * input tokens before it found the operation that returns the count). The
 * host can see the shape of that from the calls alone: the same operation
 * with the same arguments except the one that moves (a cursor, an offset).
 * From the third such page on, the model is told what paging costs and that a
 * total or summary usually comes from an operation that returns it directly.
 * It is a note only; the call goes as written.
 *
 * Generic over tools: nothing here names an argument or a provider.
 */
export interface PagingCall {
  operation: string;
  args: Record<string, unknown>;
}

/** Keys whose values differ between the two calls (present in only one counts). */
function differingKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}

/** How many calls, counting this one, read the same list in a row (other
 *  operations between them aside): the same operation, arguments that differ from this call's in one key only, always
 *  the same key, and that key moving the way a continuation moves (a value a
 *  result of this turn returned, or a number that only grows). A run of
 *  lookups by different ids is not paging. `earlier` is oldest first. */
export function pagingRunLength(
  earlier: readonly PagingCall[],
  current: PagingCall,
  returnedByAResult: (value: string) => boolean,
): number {
  const run: PagingCall[] = [current];
  let movingKey: string | undefined;
  for (let index = earlier.length - 1; index >= 0; index--) {
    const prior = earlier[index]!;
    // A search or another read between pages does not end the run.
    if (prior.operation !== current.operation) continue;
    const differ = differingKeys(prior.args, current.args);
    if (differ.length > 1) break;
    if (differ.length === 1) {
      if (movingKey !== undefined && movingKey !== differ[0]) break;
      movingKey = differ[0];
    }
    run.unshift(prior);
  }
  if (movingKey === undefined) return 1;
  const values = run.map((call) => call.args[movingKey!]);
  // The first page may start anywhere (no cursor, or one the owner gave);
  // every later one moves on from what a result returned.
  const continued = values.slice(1).every((value) => typeof value === 'string' && value !== '' && returnedByAResult(value))
    || values.every((value, index) => typeof value === 'number' && (index === 0 || value > (values[index - 1] as number)));
  return continued ? run.length : 1;
}

export const PAGING_NOTE_FROM = 3;

/** What the model is told once a run of pages reaches PAGING_NOTE_FROM. */
export function pagingRunNote(callId: string, operation: string, pages: number): string {
  return `Call ${callId} is page ${pages} of the same ${operation} list in this turn, each a round of its own. `
    + 'If what the owner asked for is a total, a count or a summary, an operation that returns it directly answers in one call '
    + '(search for one if none is in view); keep paging only when every record itself is needed.';
}
