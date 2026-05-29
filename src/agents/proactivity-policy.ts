import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

export type ProactivityMode = 'watch' | 'balanced' | 'hands_on';

/**
 * How aggressively the agent can auto-approve its own actions.
 *
 *   strict    — default. Every shell command + file write requires
 *               explicit approval UNLESS the user has approved a Plan
 *               that opened a 15-min plan-scope (see plan-scope.ts).
 *   workspace — auto-approve when the action's cwd / path is inside
 *               one of the user's configured WORKSPACE_DIRS. Catches
 *               80% of day-to-day "yes obviously" cases without
 *               sliding into yolo.
 *   yolo      — auto-approve everything except the hard-coded danger
 *               denylist (rm -rf /, sudo, fork bombs, etc.) which is
 *               enforced unconditionally. Also bypasses the workspace-
 *               root check on run_shell_command + write_file so the
 *               agent can act anywhere the user can.
 */
export type AutoApproveScope = 'strict' | 'workspace' | 'yolo';

export interface ProactivityPolicy {
  enabled: boolean;
  mode: ProactivityMode;
  autoApproveScope: AutoApproveScope;
  checkInMinutes: number;
  briefCadenceMinutes: number;
  defaultLongTaskMinutes: number;
  maxConcurrentBackgroundTasks: number;
  /** Move 2 (confirm-first gate): a batch of this many same-shape
   *  external writes in a session requires an instruction-reviewed plan
   *  scope before it proceeds. Floored at 2 by the gate. */
  batchConfirmThreshold: number;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  allowDiscordCheckIns: boolean;
  allowComposioActions: boolean;
  allowComputerActions: boolean;
  requireWorkflowApprovalForExecution: boolean;
  updatedAt: string;
}

export interface ProactivityPolicySnapshot {
  policy: ProactivityPolicy;
  quietHoursActive: boolean;
  proactiveWorkAllowed: boolean;
}

type RawProactivityPolicy = Partial<Record<keyof ProactivityPolicy, unknown>>;

const POLICY_FILE = path.join(BASE_DIR, 'state', 'proactivity-policy.json');

export const DEFAULT_PROACTIVITY_POLICY: ProactivityPolicy = {
  enabled: true,
  mode: 'balanced',
  autoApproveScope: 'strict',
  checkInMinutes: 3,
  briefCadenceMinutes: 60,
  defaultLongTaskMinutes: 90,
  maxConcurrentBackgroundTasks: 1,
  batchConfirmThreshold: 5,
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
  allowDiscordCheckIns: true,
  allowComposioActions: true,
  allowComputerActions: true,
  requireWorkflowApprovalForExecution: true,
  updatedAt: new Date(0).toISOString(),
};

function ensurePolicyDir(): void {
  mkdirSync(path.dirname(POLICY_FILE), { recursive: true });
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeTime(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return /^\d{2}:\d{2}$/.test(trimmed) ? trimmed : fallback;
}

function normalizeMode(value: unknown): ProactivityMode {
  return value === 'watch' || value === 'hands_on' || value === 'balanced' ? value : 'balanced';
}

function normalizeAutoApproveScope(value: unknown): AutoApproveScope {
  return value === 'workspace' || value === 'yolo' || value === 'strict' ? value : 'strict';
}

function normalizePolicy(input: RawProactivityPolicy = {}): ProactivityPolicy {
  return {
    enabled: input.enabled !== false,
    mode: normalizeMode(input.mode),
    autoApproveScope: normalizeAutoApproveScope(input.autoApproveScope),
    checkInMinutes: clampInteger(input.checkInMinutes, DEFAULT_PROACTIVITY_POLICY.checkInMinutes, 1, 60),
    briefCadenceMinutes: clampInteger(input.briefCadenceMinutes, DEFAULT_PROACTIVITY_POLICY.briefCadenceMinutes, 10, 1440),
    defaultLongTaskMinutes: clampInteger(input.defaultLongTaskMinutes, DEFAULT_PROACTIVITY_POLICY.defaultLongTaskMinutes, 5, 240),
    maxConcurrentBackgroundTasks: clampInteger(input.maxConcurrentBackgroundTasks, DEFAULT_PROACTIVITY_POLICY.maxConcurrentBackgroundTasks, 1, 5),
    batchConfirmThreshold: clampInteger(input.batchConfirmThreshold, DEFAULT_PROACTIVITY_POLICY.batchConfirmThreshold, 2, 100),
    quietHoursEnabled: input.quietHoursEnabled === true,
    quietHoursStart: normalizeTime(input.quietHoursStart, DEFAULT_PROACTIVITY_POLICY.quietHoursStart),
    quietHoursEnd: normalizeTime(input.quietHoursEnd, DEFAULT_PROACTIVITY_POLICY.quietHoursEnd),
    allowDiscordCheckIns: input.allowDiscordCheckIns !== false,
    allowComposioActions: input.allowComposioActions !== false,
    allowComputerActions: input.allowComputerActions !== false,
    requireWorkflowApprovalForExecution: input.requireWorkflowApprovalForExecution !== false,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
  };
}

function minutesSinceMidnight(time: string): number {
  const [hours, minutes] = time.split(':').map((part) => Number.parseInt(part, 10));
  return hours * 60 + minutes;
}

export function loadProactivityPolicy(): ProactivityPolicy {
  if (!existsSync(POLICY_FILE)) {
    return normalizePolicy(DEFAULT_PROACTIVITY_POLICY);
  }

  try {
    return normalizePolicy(JSON.parse(readFileSync(POLICY_FILE, 'utf-8')) as RawProactivityPolicy);
  } catch {
    return normalizePolicy(DEFAULT_PROACTIVITY_POLICY);
  }
}

export function saveProactivityPolicy(patch: RawProactivityPolicy): ProactivityPolicy {
  const policy = normalizePolicy({
    ...loadProactivityPolicy(),
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  ensurePolicyDir();
  const tmpPath = `${POLICY_FILE}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(policy, null, 2), 'utf-8');
  renameSync(tmpPath, POLICY_FILE);
  return policy;
}

export function isQuietHoursActive(policy = loadProactivityPolicy(), at = new Date()): boolean {
  if (!policy.quietHoursEnabled) return false;
  const start = minutesSinceMidnight(policy.quietHoursStart);
  const end = minutesSinceMidnight(policy.quietHoursEnd);
  const current = at.getHours() * 60 + at.getMinutes();
  if (start === end) return true;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

export function getProactivityPolicySnapshot(): ProactivityPolicySnapshot {
  const policy = loadProactivityPolicy();
  const quietHoursActive = isQuietHoursActive(policy);
  return {
    policy,
    quietHoursActive,
    proactiveWorkAllowed: policy.enabled && !quietHoursActive,
  };
}

export function getBackgroundCheckInMs(policy = loadProactivityPolicy()): number {
  return Math.max(1, policy.checkInMinutes) * 60_000;
}
