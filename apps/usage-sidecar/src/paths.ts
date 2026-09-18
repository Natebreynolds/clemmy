import os from 'node:os';
import path from 'node:path';

export function home(): string {
  return process.env.HOME || os.homedir();
}

export function claudeProjectsDir(): string {
  return process.env.CLAUDE_PROJECTS || path.join(home(), '.claude', 'projects');
}

export function coworkRootDir(): string {
  return process.env.COWORK_ROOT
    || path.join(home(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');
}

export function codexSessionsDir(): string {
  return process.env.CODEX_HOME
    ? path.join(process.env.CODEX_HOME, 'sessions')
    : path.join(home(), '.codex', 'sessions');
}

export function clementineUsageDir(): string {
  const base = process.env.CLEMENTINE_HOME || path.join(home(), '.clementine-next');
  return path.join(base, 'state', 'token-usage');
}

export function trialsDir(): string {
  return path.join(path.dirname(new URL('../package.json', import.meta.url).pathname), '.trials');
}

export function todayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
