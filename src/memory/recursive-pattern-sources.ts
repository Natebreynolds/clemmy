export interface RecursivePattern {
  text: string;
  importance: number;
  sourceFactIds?: number[];
}

/** Citations select evidence, never silently expand to the whole input batch. */
export function selectRecursivePatternSources<T extends { id: number }>(
  ids: unknown,
  rows: readonly T[],
): T[] | null {
  if (!Array.isArray(ids) || ids.length > rows.length
    || !ids.every(id => Number.isSafeInteger(id) && id > 0)) return null;
  const distinct = [...new Set<number>(ids)];
  if (distinct.length < 2) return null;
  const byId = new Map(rows.map(row => [row.id, row]));
  if (distinct.some(id => !byId.has(id))) return null;
  return distinct.map(id => byId.get(id)!);
}
