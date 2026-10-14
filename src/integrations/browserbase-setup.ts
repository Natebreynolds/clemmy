import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { isBrowserChoice, isCloudBrowserProvider, type BrowserChoice, type CloudBrowserProvider } from './cloud-browser-provider.js';

/** Browserbase names projects by UUID; Kernel's project is a free identifier. */
const PROJECT_ID: Record<CloudBrowserProvider, RegExp> = {
  browserbase: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  kernel: /^[A-Za-z0-9_.-]{1,128}$/,
};

export function browserbaseStoreFile(baseDir = BASE_DIR): string {
  return path.join(baseDir, 'state', 'browserbase', 'resources.json');
}

/** The owner's browser choice and which cloud providers are set up, read
 * from the cloud browser store without opening the service (tool catalogs
 * ask this on every turn). `choice` is what the owner picked on the Connect
 * screen; `provider` is the cloud provider that choice names when it is
 * configured, else null (this computer's Chrome is the browser then). */
export interface CloudBrowserSelection {
  choice: BrowserChoice;
  provider: CloudBrowserProvider | null;
  configured: Record<CloudBrowserProvider, boolean>;
}

const NOTHING: CloudBrowserSelection = { choice: 'local', provider: null, configured: { browserbase: false, kernel: false } };

let cached: { file: string; mtimeMs: number; size: number; selection: CloudBrowserSelection } | undefined;

export function cloudBrowserSelection(baseDir = BASE_DIR): CloudBrowserSelection {
  const file = browserbaseStoreFile(baseDir);
  let stat;
  try { stat = statSync(file); } catch { return NOTHING; }
  if (cached && cached.file === file && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.selection;
  let selection: CloudBrowserSelection = NOTHING;
  try {
    const store = JSON.parse(readFileSync(file, 'utf8')) as {
      policy?: { projectId?: unknown; provider?: unknown } | null;
      providers?: Partial<Record<string, { projectId?: unknown } | null>>;
      choice?: unknown;
    };
    const configured: Record<CloudBrowserProvider, boolean> = { browserbase: false, kernel: false };
    const providers = store.providers && typeof store.providers === 'object' ? store.providers : {};
    for (const [name, policy] of Object.entries(providers)) {
      if (isCloudBrowserProvider(name) && policy && typeof policy.projectId === 'string' && PROJECT_ID[name].test(policy.projectId)) configured[name] = true;
    }
    // A store written before providers existed: one Browserbase policy.
    if (!store.providers && store.policy && typeof store.policy.projectId === 'string') {
      const provider = isCloudBrowserProvider(store.policy.provider) ? store.policy.provider : 'browserbase';
      if (PROJECT_ID[provider].test(store.policy.projectId)) configured[provider] = true;
    }
    const choice: BrowserChoice = isBrowserChoice(store.choice) ? store.choice
      : configured.browserbase ? 'browserbase' : configured.kernel ? 'kernel' : 'local';
    const provider = isCloudBrowserProvider(choice) && configured[choice] ? choice : null;
    selection = { choice, provider, configured };
  } catch { selection = NOTHING; }
  cached = { file, mtimeMs: stat.mtimeMs, size: stat.size, selection };
  return selection;
}

/** Whether a cloud browser is the browser on this machine: the owner's
 * choice names a provider that is set up. Kept under its historical name
 * for the callers that ask the one question. */
export function browserbaseProjectSetUp(baseDir = BASE_DIR): boolean {
  return cloudBrowserSelection(baseDir).provider !== null;
}
