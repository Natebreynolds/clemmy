import os from 'node:os';
import path from 'node:path';

/** Resolve the desktop state root exactly as the daemon does. */
export function resolveClementineHomeDirectory(
  configuredHome = process.env.CLEMENTINE_HOME,
  userHome = os.homedir(),
): string {
  return configuredHome || path.join(userHome, '.clementine-next');
}

export const CLEMENTINE_HOME_DIR = resolveClementineHomeDirectory();
export const CLEMENTINE_STATE_DIR = path.join(CLEMENTINE_HOME_DIR, 'state');
export const CLEMENTINE_DESKTOP_LOG_DIR = path.join(CLEMENTINE_HOME_DIR, 'logs', 'desktop');
