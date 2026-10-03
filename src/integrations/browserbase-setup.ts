/** Whether a Browserbase project is set up on this machine, read from the
 * service's own store. Never touches Keychain or starts the service, so tool
 * surfaces can ask on every turn. */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function browserbaseStoreFile(baseDir = BASE_DIR): string {
  return path.join(baseDir, 'state', 'browserbase', 'resources.json');
}

let cached: { file: string; mtimeMs: number; size: number; setUp: boolean } | undefined;

export function browserbaseProjectSetUp(baseDir = BASE_DIR): boolean {
  const file = browserbaseStoreFile(baseDir);
  let stat;
  try { stat = statSync(file); } catch { return false; }
  if (cached && cached.file === file && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.setUp;
  let setUp = false;
  try {
    const store = JSON.parse(readFileSync(file, 'utf8')) as { policy?: { projectId?: unknown } | null };
    setUp = typeof store.policy?.projectId === 'string' && PROJECT_ID.test(store.policy.projectId);
  } catch { setUp = false; }
  cached = { file, mtimeMs: stat.mtimeMs, size: stat.size, setUp };
  return setUp;
}
