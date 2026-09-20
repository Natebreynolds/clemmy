/** Select advertised procedures without changing durable recall or dispatch.
 * A completed task-scoped search advertises only matches, including none.
 * Without a scoped search, retain the general recency overview.
 */
export function selectToolChoicesForContext<T extends { intent: string }>(
  ordered: readonly T[],
  matchedIntents: ReadonlySet<string>,
  scopedSearchCompleted = false,
): readonly T[] {
  const matched = ordered.filter((record) => matchedIntents.has(record.intent));
  return matched.length > 0 || scopedSearchCompleted ? matched : ordered;
}
