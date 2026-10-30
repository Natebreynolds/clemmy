/** Compatibility destinations remain valid links, but a Help map offers one
 * clear name per page. The old Clem thread is reached through Today/chat. */
export function helpDestinations<T extends { id: string; desktop: string }>(places: readonly T[]): T[] {
  const seen = new Set<string>();
  return places.filter(place => {
    if (place.id === 'help' || place.id === 'clem-thread' || seen.has(place.desktop)) return false;
    seen.add(place.desktop);
    return true;
  });
}
