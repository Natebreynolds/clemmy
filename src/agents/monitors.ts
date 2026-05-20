import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import { findSafeCliCommand } from '../runtime/cli-discovery.js';
import { listWorkspaceProjects } from '../tools/shared.js';
import { AGENT_INBOX_DIR } from '../tools/shared.js';

const logger = pino({ name: 'clementine-next.monitors' });

const MONITOR_STATE_FILE = path.join(BASE_DIR, 'state', 'monitors.json');

// How often monitors are allowed to run (avoid hammering git every 15s)
const GIT_MONITOR_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between full git scans
const GIT_MONITOR_PROJECT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours before re-alerting same project
const STALE_WORK_THRESHOLD_HOURS = 18; // Uncommitted work older than this triggers alert

interface MonitorState {
  git: {
    lastCheckedAt?: string;
    lastAlertedAt: Record<string, string>; // projectPath -> ISO timestamp of last alert
  };
}

function loadMonitorState(): MonitorState {
  if (!existsSync(MONITOR_STATE_FILE)) return { git: { lastAlertedAt: {} } };
  try {
    return JSON.parse(readFileSync(MONITOR_STATE_FILE, 'utf-8')) as MonitorState;
  } catch {
    return { git: { lastAlertedAt: {} } };
  }
}

function saveMonitorState(state: MonitorState): void {
  const dir = path.dirname(MONITOR_STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(MONITOR_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function enqueueAgentInboxItem(slug: string, item: {
  type: string;
  content: string;
  sourceKey: string;
  metadata?: Record<string, unknown>;
}): void {
  if (!existsSync(AGENT_INBOX_DIR)) mkdirSync(AGENT_INBOX_DIR, { recursive: true });
  const filePath = path.join(AGENT_INBOX_DIR, `${slug}.json`);
  let items: Array<{ id: string; type: string; content: string; sourceKey: string; createdAt: string; status: string; metadata?: Record<string, unknown> }> = [];
  if (existsSync(filePath)) {
    try {
      items = JSON.parse(readFileSync(filePath, 'utf-8')) as typeof items;
    } catch {
      items = [];
    }
  }
  // Dedup by sourceKey
  if (items.some((i) => i.sourceKey === item.sourceKey)) return;
  items.push({
    id: randomUUID(),
    type: item.type,
    content: item.content,
    sourceKey: item.sourceKey,
    createdAt: new Date().toISOString(),
    status: 'pending',
    metadata: item.metadata,
  });
  writeFileSync(filePath, JSON.stringify(items, null, 2), 'utf-8');
}

function execGit(gitCommand: string, args: string[], cwd: string): string {
  try {
    return execFileSync(gitCommand, args, { cwd, timeout: 8000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function isGitRepo(gitCommand: string, dirPath: string): boolean {
  return execGit(gitCommand, ['rev-parse', '--git-dir'], dirPath) !== '';
}

function getUncommittedChanges(gitCommand: string, dirPath: string): string {
  return execGit(gitCommand, ['status', '--porcelain'], dirPath);
}

function getLastCommitAgeHours(gitCommand: string, dirPath: string): number {
  const raw = execGit(gitCommand, ['log', '-1', '--format=%ct'], dirPath);
  if (!raw) return Infinity;
  const ts = parseInt(raw, 10);
  return (Date.now() - ts * 1000) / 3_600_000;
}

function getCurrentBranch(gitCommand: string, dirPath: string): string {
  return execGit(gitCommand, ['branch', '--show-current'], dirPath);
}

function getRecentLog(gitCommand: string, dirPath: string): string {
  return execGit(gitCommand, ['log', '--oneline', '-3'], dirPath);
}

function runGitMonitor(state: MonitorState): void {
  const now = Date.now();
  const lastChecked = state.git.lastCheckedAt ? new Date(state.git.lastCheckedAt).getTime() : 0;
  if (now - lastChecked < GIT_MONITOR_INTERVAL_MS) return;

  const git = findSafeCliCommand('git');
  if (!git || git.skipped) {
    state.git.lastCheckedAt = new Date().toISOString();
    logger.debug({ reason: git?.skipped ? git.reason : 'git not found' }, 'Git monitor skipped because Git is unavailable');
    return;
  }

  const projects = listWorkspaceProjects();
  let alertCount = 0;

  for (const project of projects.slice(0, 30)) {
    if (alertCount >= 5) break; // Cap alerts per cycle
    if (!isGitRepo(git.command, project.path)) continue;

    const lastAlerted = state.git.lastAlertedAt[project.path];
    if (lastAlerted && now - new Date(lastAlerted).getTime() < GIT_MONITOR_PROJECT_COOLDOWN_MS) continue;

    const changes = getUncommittedChanges(git.command, project.path);
    if (!changes) continue;

    const ageHours = getLastCommitAgeHours(git.command, project.path);
    if (ageHours < STALE_WORK_THRESHOLD_HOURS) continue;

    const branch = getCurrentBranch(git.command, project.path);
    const recentLog = getRecentLog(git.command, project.path);
    const fileCount = changes.split('\n').filter(Boolean).length;
    const ageLabel = ageHours === Infinity ? 'unknown time' : `${Math.round(ageHours)}h`;

    const content = [
      `Project ${project.name} has ${fileCount} uncommitted change(s) with no commit in ${ageLabel}.`,
      branch ? `Branch: ${branch}` : '',
      recentLog ? `Recent commits:\n${recentLog}` : '',
      '',
      'Changed files:',
      changes.slice(0, 600),
    ].filter(Boolean).join('\n');

    enqueueAgentInboxItem('clementine', {
      type: 'monitor_git',
      sourceKey: `git-stale:${project.path}:${changes.split('\n')[0]}`,
      content,
      metadata: {
        project: project.name,
        projectPath: project.path,
        branch,
        fileCount,
        ageHours: Math.round(ageHours),
      },
    });

    state.git.lastAlertedAt[project.path] = new Date().toISOString();
    alertCount++;
    logger.debug({ project: project.name, ageHours }, 'Git monitor alert enqueued');
  }

  state.git.lastCheckedAt = new Date().toISOString();
}

export function processMonitors(): void {
  const state = loadMonitorState();
  try {
    runGitMonitor(state);
  } catch (err) {
    logger.warn({ err }, 'Monitor run failed');
  }
  saveMonitorState(state);
}
