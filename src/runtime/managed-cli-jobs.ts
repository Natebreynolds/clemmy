import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { invalidateCachedScan as invalidateCliScan } from './cli-discovery.js';

export type ManagedCliKind = 'composio' | 'github';
export type ManagedCliAction = 'install' | 'auth' | 'repair';
export type ManagedCliJobStatus = 'running' | 'succeeded' | 'failed';

export interface ManagedCliJob {
  id: string;
  kind: ManagedCliKind;
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

export function startManagedCliJob(kind: ManagedCliKind, action: ManagedCliAction): ManagedCliJob {
  const spec = commandFor(kind, action);
  const id = `${kind}-${action}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const job: ManagedCliJob = {
    id,
    kind,
    action,
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
  child.stdout.on('data', (chunk) => { job.output = truncate(job.output + String(chunk)); });
  child.stderr.on('data', (chunk) => { job.output = truncate(job.output + String(chunk)); });
  child.on('error', (error) => {
    job.status = 'failed';
    job.output = truncate(job.output + error.message);
    job.completedAt = new Date().toISOString();
    job.exitCode = -1;
  });
  child.on('close', (code) => {
    job.status = code === 0 ? 'succeeded' : 'failed';
    job.completedAt = new Date().toISOString();
    job.exitCode = code;
    if (code === 0) invalidateCliScan();
  });
  return job;
}

export function getManagedCliJob(id: string): ManagedCliJob | undefined {
  return jobs.get(id);
}
