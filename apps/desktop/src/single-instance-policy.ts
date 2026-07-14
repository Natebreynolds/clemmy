import path from 'node:path';

export function resolveIsolatedDevUserDataPath(
  isPackaged: boolean,
  devMultiInstanceFlag: string | undefined,
  configuredClementineHome: string | undefined,
  defaultClementineHome: string,
): string | null {
  if (isPackaged || devMultiInstanceFlag !== '1' || !configuredClementineHome) return null;
  const configured = path.resolve(configuredClementineHome);
  if (configured === path.resolve(defaultClementineHome)) return null;
  return path.join(configured, 'electron-user-data');
}

export function acquireSingleInstanceLock(
  isPackaged: boolean,
  isolatedDevUserDataPath: string | null,
  requestLock: () => boolean,
): boolean {
  if (!isPackaged && isolatedDevUserDataPath) return true;
  return requestLock();
}
