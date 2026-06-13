import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

/**
 * The lightweight goal-list store (`goal_create` / `goal_update`, written to
 * `~/.clementine-next/goals/*.json`) — distinct from the plan-proposals GOAL
 * CONTRACT (staged/validated, injected per-turn via renderGoalContextBlock).
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
