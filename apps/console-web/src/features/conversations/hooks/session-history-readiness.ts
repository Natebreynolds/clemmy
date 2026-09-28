/** Stateful chat history may only be seeded by this opening's fetch. */
export function sessionHistoryReady(query: { isLoading: boolean; isFetchedAfterMount: boolean }): boolean {
  return !query.isLoading && query.isFetchedAfterMount;
}
