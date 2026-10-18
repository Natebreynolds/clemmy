/** A retained fact identity can open that fact, never a text search or a
 * guessed replacement. This does not say the fact is still active. */
export function memoryFactId(value: unknown): number | null {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function memoryFactHref(value: unknown): string | null {
  const id = memoryFactId(value);
  return id === null ? null : `/memory?fact=${id}`;
}
