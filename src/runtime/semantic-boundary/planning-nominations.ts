/** Initial prompt selection only. Global availability is not task relevance;
 * discovery remains available for every configured operation. Exact live
 * definitions still own execution, including versioned successors nominated
 * under the index's stable operation id. */
export function nominatedLivePlanningDescriptors<T extends { id: string }>(input: {
  live: readonly T[];
  advisory: readonly { id: string }[];
  preferredLiveIds: ReadonlySet<string>;
}): T[] {
  const baseId = (id: string): string => id.split(':definition:')[0]!;
  const nominated = new Set(input.advisory.map(row => baseId(row.id)));
  return input.live.filter(row => input.preferredLiveIds.has(row.id) || nominated.has(baseId(row.id)));
}
