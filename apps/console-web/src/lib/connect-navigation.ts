export type ConnectArea = 'apps' | 'devices' | 'advanced';

/** Old setup links and Clem's guided destinations remain valid after grouping. */
export function connectAreaForHash(hash: string): ConnectArea {
  const id = hash.replace(/^#/, '');
  if (['devices', 'computer', 'phone', 'channels'].includes(id)) return 'devices';
  if (['advanced', 'accounts', 'plugins', 'tools', 'folders', 'browsers', 'other-apps', 'app-service'].includes(id)) return 'advanced';
  return 'apps';
}
