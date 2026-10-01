import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { BASE_DIR } from '../config.js';

/**
 * The lightweight goal-list store (`goal_create` / `goal_update`, written to
 * `~/.clementine-next/goals/*.json`) — distinct from the plan-proposals GOAL
 * CONTRACT (staged/validated, injected per-turn through the canonical active-
 * task context projection).
 *
 * This is the ONE reader for that store. It used to be copy-pasted across three
 * context assemblers (harness, chat, voice); each kept its own render but read
 * the dir with identical logic. Consolidated here so the read has a single home
 * — surface-specific rendering stays at each call site.
 *
 * (Whether this lightweight list should survive at all, or fold into the goal
 * contract, is the D2b de-duplication decision in vision.md — out of scope for
 * this consolidation, which is behavior-preserving.)
 */

const GOALS_DIR = path.join(BASE_DIR, 'goals');

export interface GoalSummary {
  id: string;
  title: string;
  status: string;
  priority?: string;
  nextActions?: string[];
  targetDate?: string;
}

/**
 * The authoritative on-disk shape written by goal-tools.ts. The various
 * read-only consumers (autonomy, briefs, check-ins, session-tools) previously
 * each declared their own SUBSET of this and re-implemented the dir read; they
 * now share this type + {@link listGoalRecords} and keep their own filter.
 */
export interface GoalRecord {
  id: string;
  title: string;
  description: string;
  owner: string;
  priority: 'high' | 'medium' | 'low';
  status: 'active' | 'paused' | 'completed' | 'blocked';
  createdAt: string;
  updatedAt: string;
  targetDate?: string;
  reviewFrequency: 'daily' | 'weekly' | 'on-demand';
  progressNotes: string[];
  nextActions: string[];
  blockers: string[];
  linkedCronJobs: string[];
  autoSchedule?: boolean;
}

export interface GoalRecordPatch {
  id?: string;
  title?: string;
  description?: string;
  owner?: string;
  priority?: GoalRecord['priority'];
  status?: GoalRecord['status'];
  targetDate?: string;
  nextActions?: string[];
  /** Appended, timestamped, to the progress log. */
  progressNote?: string;
  blockers?: string[];
  reviewFrequency?: GoalRecord['reviewFrequency'];
  linkedCronJobs?: string[];
  autoSchedule?: boolean;
}

/** The ONE writer for the goals dir: creates when `id` is absent (title and
 * description required), otherwise changes only the fields given. Shared by
 * the goal_upsert tool and the console. */
export function upsertGoalRecord(patch: GoalRecordPatch, now = new Date().toISOString()):
  | { ok: true; goal: GoalRecord; created: boolean }
  | { ok: false; reason: string } {
  mkdirSync(GOALS_DIR, { recursive: true });
  const write = (goal: GoalRecord): void => {
    const target = path.join(GOALS_DIR, `${goal.id}.json`);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(goal, null, 2), 'utf-8');
    renameSync(tmp, target);
  };
  if (patch.id) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(patch.id)) return { ok: false, reason: 'invalid goal id' };
    const file = path.join(GOALS_DIR, `${patch.id}.json`);
    if (!existsSync(file)) return { ok: false, reason: `Goal not found: ${patch.id}` };
    let goal: GoalRecord;
    try { goal = JSON.parse(readFileSync(file, 'utf-8')) as GoalRecord; } catch { return { ok: false, reason: `Goal unreadable: ${patch.id}` }; }
    if (patch.title) goal.title = patch.title;
    if (patch.description) goal.description = patch.description;
    if (patch.owner) goal.owner = patch.owner;
    if (patch.priority) goal.priority = patch.priority;
    if (patch.status) goal.status = patch.status;
    if (patch.targetDate !== undefined) goal.targetDate = patch.targetDate || undefined;
    if (patch.progressNote?.trim()) (goal.progressNotes ??= []).push(`[${now.slice(0, 16)}] ${patch.progressNote.trim()}`);
    if (patch.nextActions) goal.nextActions = patch.nextActions;
    if (patch.blockers) goal.blockers = patch.blockers;
    if (patch.reviewFrequency) goal.reviewFrequency = patch.reviewFrequency;
    if (patch.linkedCronJobs) goal.linkedCronJobs = patch.linkedCronJobs;
    if (patch.autoSchedule !== undefined) goal.autoSchedule = patch.autoSchedule;
    goal.updatedAt = now;
    write(goal);
    return { ok: true, goal, created: false };
  }
  if (!patch.title?.trim() || !patch.description?.trim()) {
    return { ok: false, reason: 'To create a goal, provide both `title` and `description` (or pass an `id` to update an existing goal).' };
  }
  const goal: GoalRecord = {
    id: randomBytes(4).toString('hex'),
    title: patch.title.trim(),
    description: patch.description.trim(),
    owner: patch.owner || 'clementine',
    priority: patch.priority || 'medium',
    status: patch.status || 'active',
    createdAt: now,
    updatedAt: now,
    ...(patch.targetDate ? { targetDate: patch.targetDate } : {}),
    reviewFrequency: patch.reviewFrequency || 'weekly',
    progressNotes: patch.progressNote?.trim() ? [`[${now.slice(0, 16)}] ${patch.progressNote.trim()}`] : [],
    nextActions: patch.nextActions || [],
    blockers: patch.blockers || [],
    linkedCronJobs: patch.linkedCronJobs || [],
    ...(patch.autoSchedule !== undefined ? { autoSchedule: patch.autoSchedule } : {}),
  };
  write(goal);
  return { ok: true, goal, created: true };
}

/** Read ALL parsed goal records from the store (no status filter — callers
 *  apply their own). The ONE reader for the goals dir. Best-effort → []. */
export function listGoalRecords(): GoalRecord[] {
  if (!existsSync(GOALS_DIR)) return [];
  try {
    return readdirSync(GOALS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(path.join(GOALS_DIR, f), 'utf-8')) as GoalRecord;
        } catch {
          return null;
        }
      })
      .filter((g): g is GoalRecord => g !== null);
  } catch {
    return [];
  }
}

/** Read active/blocked goal records. `sortByPriority` matches the harness/chat
 *  ordering; voice reads unsorted. Best-effort: returns [] on any error. */
export function listActiveGoalSummaries(
  opts: { limit: number; sortByPriority?: boolean },
): GoalSummary[] {
  if (!existsSync(GOALS_DIR)) return [];
  try {
    let goals = readdirSync(GOALS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(path.join(GOALS_DIR, f), 'utf-8')) as GoalSummary;
        } catch {
          return null;
        }
      })
      .filter((g): g is GoalSummary => g !== null && (g.status === 'active' || g.status === 'blocked'));
    if (opts.sortByPriority) {
      const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
      goals = [...goals].sort((a, b) => (order[a.priority ?? ''] ?? 1) - (order[b.priority ?? ''] ?? 1));
    }
    return goals.slice(0, opts.limit);
  } catch {
    return [];
  }
}
