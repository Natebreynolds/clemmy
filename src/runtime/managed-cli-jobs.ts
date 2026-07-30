import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { invalidateCachedScan as invalidateCliScan } from './cli-discovery.js';

export type ManagedCliKind = 'composio' | 'github';
export type ManagedCliAction = 'install' | 'auth' | 'repair';
export type ManagedCliJobStatus = 'running' | 'succeeded' | 'failed';

export interface ManagedCliJob {
  id: string;
  /** Legacy managed kind ('composio' | 'github') or a catalog id for
   *  catalog-driven auth jobs — both poll through the same jobs map. */
  kind: string;
  action: ManagedCliAction;
  title: string;
  command: string;
  status: ManagedCliJobStatus;
  output: string;
  startedAt: string;
  completedAt?: string;
  exitCode?: number | null;
}

const jobs = new Map<string, ManagedCliJob>();

/**
 * Auth flows open a browser and wait on a callback; a flow that
 * unexpectedly prompts for TTY input instead would hang the zsh child
 * forever (stdin is ignored). The hard timeout is the safety net that
 * turns a mis-flagged `authHeadless` entry into a visible failed job
 * rather than a zombie process.
 */
const AUTH_JOB_TIMEOUT_MS = 5 * 60_000;

function truncate(text: string): string {
  return text.length > 40_000 ? text.slice(text.length - 40_000) : text;
}

function commandFor(kind: ManagedCliKind, action: ManagedCliAction): { title: string; command: string; args: string[] } {
  if (kind === 'composio') {
    if (action === 'install') {
      return {
        title: 'Install Composio CLI',
        command: 'curl -fsSL https://composio.dev/install | bash',
        args: ['-lc', 'curl -fsSL https://composio.dev/install | bash'],
      };
    }
    return {
      title: action === 'repair' ? 'Repair Composio CLI auth' : 'Composio CLI login',
      command: 'composio login',
      args: ['-lc', 'composio login'],
    };
  }

  if (action === 'install') {
    return {
      title: 'Install GitHub CLI',
      command: 'brew install gh',
      args: ['-lc', 'brew install gh'],
    };
  }
  if (action === 'repair') {
    return {
      title: 'Repair GitHub CLI auth',
      command: 'gh auth refresh -h github.com -s repo -s read:org -s workflow',
      args: ['-lc', 'gh auth refresh -h github.com -s repo -s read:org -s workflow'],
    };
  }
  return {
    title: 'GitHub CLI login',
    command: 'gh auth login -h github.com --web -s repo -s read:org -s workflow',
    args: ['-lc', 'gh auth login -h github.com --web -s repo -s read:org -s workflow'],
  };
}

interface RunJobSpec {
  kind: string;
  action: ManagedCliAction;
  title: string;
  command: string;
  args: string[];
  timeoutMs?: number;
  onSuccess?: () => void;
}

function runJob(spec: RunJobSpec): ManagedCliJob {
  const id = `${spec.kind}-${spec.action}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const job: ManagedCliJob = {
    id,
    kind: spec.kind,
    action: spec.action,
    title: spec.title,
    command: spec.command,
    status: 'running',
    output: '',
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);

  const child = spawn('/bin/zsh', spec.args, {
    cwd: os.homedir(),
    env: {
      ...process.env,
      PATH: [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        path.join(os.homedir(), '.composio'),
        path.join(os.homedir(), '.composio', 'bin'),
        process.env.PATH ?? '',
      ].filter(Boolean).join(path.delimiter),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let killTimer: NodeJS.Timeout | undefined;
  if (spec.timeoutMs) {
    killTimer = setTimeout(() => {
      if (job.status === 'running') {
        job.output = truncate(`${job.output}\n[timed out after ${Math.round(spec.timeoutMs! / 60_000)} min — the flow likely waited for terminal input; run "${spec.command}" in your own terminal instead]`);
        child.kill('SIGKILL');
      }
    }, spec.timeoutMs);
    killTimer.unref?.();
  }
  child.stdout.on('data', (chunk) => { job.output = truncate(job.output + String(chunk)); });
  child.stderr.on('data', (chunk) => { job.output = truncate(job.output + String(chunk)); });
  child.on('error', (error) => {
    if (killTimer) clearTimeout(killTimer);
    job.status = 'failed';
    job.output = truncate(job.output + error.message);
    job.completedAt = new Date().toISOString();
    job.exitCode = -1;
  });
  child.on('close', (code) => {
    if (killTimer) clearTimeout(killTimer);
    job.status = code === 0 ? 'succeeded' : 'failed';
    job.completedAt = new Date().toISOString();
    job.exitCode = code;
    if (code === 0) {
      invalidateCliScan();
      try {
        spec.onSuccess?.();
      } catch { /* post-success hooks are best-effort */ }
    }
  });
  return job;
}

export function startManagedCliJob(kind: ManagedCliKind, action: ManagedCliAction): ManagedCliJob {
  const spec = commandFor(kind, action);
  return runJob({ kind, action, ...spec });
}

/**
 * One-click sign-in for a catalog CLI. The command comes ONLY from the
 * catalog — callers pass an id, never a command string, so the route adds
 * zero injection surface. Requires the entry to be verified headless
 * (browser/device-code flow); everything else stays on the copy-command
 * path in Connect.
 */
export async function startCatalogAuthJob(catalogId: string): Promise<ManagedCliJob> {
  const { findCatalogEntry } = await import('../integrations/cli-catalog/catalog.js');
  const entry = findCatalogEntry(catalogId);
  if (!entry) throw new Error(`Unknown catalog CLI: ${catalogId}`);
  if (!entry.authHeadless || !entry.authCommand) {
    throw new Error(`${entry.name} requires an interactive sign-in — run \`${entry.authCommand ?? `${entry.command} login`}\` in your terminal (see ${entry.authDocsUrl}).`);
  }
  return runJob({
    kind: entry.id,
    action: 'auth',
    title: `Sign in to ${entry.name}`,
    command: entry.authCommand,
    args: ['-lc', entry.authCommand],
    timeoutMs: AUTH_JOB_TIMEOUT_MS,
    onSuccess: () => {
      // Force a fresh probe so the signed_out→ok transition (and any
      // parked-work resume subscribed to it) fires promptly.
      void import('../integrations/cli-catalog/auth-health.js')
        .then(({ invalidateCliHealth, getCliHealth }) => {
          invalidateCliHealth(entry.id);
          return getCliHealth(entry.id, { force: true });
        })
        .catch(() => { /* the 30-min sweep remains the backstop */ });
    },
  });
}

export function getManagedCliJob(id: string): ManagedCliJob | undefined {
  return jobs.get(id);
}

/** Test seam: legacy command specs are pinned byte-for-byte. */
export const _testOnly_commandFor = commandFor;
