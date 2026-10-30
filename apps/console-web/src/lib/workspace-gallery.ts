import type { SpaceRecord } from './spaces';

/** Filter the complete loaded collection; never a thumbnail or paged subset. */
export function filterWorkspaceGallery(spaces: readonly SpaceRecord[], query: string): SpaceRecord[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return spaces.filter(space => {
    const text = `${space.title} ${space.contract?.objective ?? ''} ${space.id}`.toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });
}
