import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BASE_DIR } from '../config.js';
import { addNotification, markNotificationRead } from '../runtime/notifications.js';
import { createGoalContract, type PlanProposal } from './plan-proposals.js';
import { draftGoalFromNotes, type GoalDraft } from './goal-intake.js';

const GOAL_DRAFTS_DIR = path.join(BASE_DIR, 'state', 'goal-drafts');

export type GoalDraftStatus = 'pending' | 'created' | 'dismissed';

export interface GoalDraftRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: GoalDraftStatus;
  notes: string;
  desiredOutcome?: string;
  draft: GoalDraft;
  sessionId?: string;
  channel?: string;
  proposedByAgent: string;
  resolvedAt?: string;
  resolvedReason?: string;
  goalId?: string;
}

export interface SurfaceGoalDraftInput {
  notes: string;
  desiredOutcome?: string;
  sessionId?: string;
  channel?: string;
  proposedByAgent?: string;
  notify?: boolean;
}

export interface CreateGoalFromDraftInput {
  selfDriving?: boolean;
  resumeEveryMs?: number;
  maxResumes?: number;
  maxAttempts?: number;
  deadlineAt?: string;
  channel?: string;
}

function ensureDir(): void {
  mkdirSync(GOAL_DRAFTS_DIR, { recursive: true });
}

function fileFor(id: string): string {
  return path.join(GOAL_DRAFTS_DIR, `${id}.json`);
}

function compact(value: string, max = 180): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function writeGoalDraft(record: GoalDraftRecord): void {
  ensureDir();
  writeFileSync(fileFor(record.id), JSON.stringify(record, null, 2));
}

function notificationIdForDraft(id: string): string {
  return `goal-draft-${id}`;
}

export function getGoalDraft(id: string): GoalDraftRecord | null {
  try {
    const fp = fileFor(id);
    if (!existsSync(fp)) return null;
    return JSON.parse(readFileSync(fp, 'utf-8')) as GoalDraftRecord;
  } catch {
    return null;
  }
}

export function listGoalDrafts(filter: { status?: GoalDraftStatus | 'all'; limit?: number } = {}): GoalDraftRecord[] {
  ensureDir();
  const wanted = filter.status ?? 'pending';
  const out: GoalDraftRecord[] = [];
  for (const entry of readdirSync(GOAL_DRAFTS_DIR)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const record = JSON.parse(readFileSync(path.join(GOAL_DRAFTS_DIR, entry), 'utf-8')) as GoalDraftRecord;
      if (wanted !== 'all' && record.status !== wanted) continue;
      out.push(record);
    } catch { /* ignore malformed drafts */ }
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return typeof filter.limit === 'number' ? out.slice(0, Math.max(0, filter.limit)) : out;
}

export function renderGoalDraftNotificationBody(record: GoalDraftRecord): string {
  const missing = record.draft.missingInputs.length > 0
    ? `\n\nNeeds review:\n${record.draft.missingInputs.map((item) => `- ${compact(item, 160)}`).join('\n')}`
    : '';
  const criteria = record.draft.successCriteria.slice(0, 3);
  return [
    'I turned your notes into a goal draft.',
    '',
    `Goal: ${compact(record.draft.objective, 240)}`,
    criteria.length > 0 ? `\nSuccess checks:\n${criteria.map((item) => `- ${compact(item, 160)}`).join('\n')}` : '',
    missing,
    '',
    'Open Goals to edit/create it, or tell me what to change.',
  ].filter(Boolean).join('\n');
}

export function surfaceGoalDraftFromNotes(input: SurfaceGoalDraftInput): GoalDraftRecord {
  const notes = input.notes.trim();
  if (notes.length < 8) throw new Error('notes required');
  const now = new Date().toISOString();
  const record: GoalDraftRecord = {
    id: `gd-${randomUUID().slice(0, 8)}`,
    createdAt: now,
    updatedAt: now,
    status: 'pending',
    notes,
    desiredOutcome: input.desiredOutcome?.trim() || undefined,
    draft: draftGoalFromNotes({ notes, desiredOutcome: input.desiredOutcome }),
    sessionId: input.sessionId?.trim() || undefined,
    channel: input.channel?.trim() || undefined,
    proposedByAgent: input.proposedByAgent?.trim() || 'clementine',
  };
  writeGoalDraft(record);

  if (input.notify !== false) {
    addNotification({
      id: notificationIdForDraft(record.id),
      kind: 'system',
      title: `Review goal draft: ${compact(record.draft.objective, 80)}`,
      body: renderGoalDraftNotificationBody(record),
      createdAt: now,
      read: false,
      metadata: {
        kind: 'goal_draft',
        goalDraftId: record.id,
        sessionId: record.sessionId,
        channel: record.channel,
        needsAttention: true,
        actionUrl: `/console/goals?draft=${encodeURIComponent(record.id)}`,
      },
    });
  }

  return record;
}

export function dismissGoalDraft(id: string, reason = 'dismissed by user'): GoalDraftRecord | null {
  const record = getGoalDraft(id);
  if (!record || record.status !== 'pending') return null;
  const next: GoalDraftRecord = {
    ...record,
    status: 'dismissed',
    updatedAt: new Date().toISOString(),
    resolvedAt: new Date().toISOString(),
    resolvedReason: reason,
  };
  writeGoalDraft(next);
  markNotificationRead(notificationIdForDraft(id));
  return next;
}

export function createGoalFromDraft(id: string, input: CreateGoalFromDraftInput = {}): { draft: GoalDraftRecord; goal: PlanProposal } | null {
  const record = getGoalDraft(id);
  if (!record || record.status !== 'pending') return null;
  const goal = createGoalContract({
    objective: record.draft.objective,
    successCriteria: record.draft.successCriteria,
    nextActions: record.draft.nextActions,
    risks: record.draft.risks,
    selfDriving: input.selfDriving,
    resumeEveryMs: input.resumeEveryMs,
    maxResumes: input.maxResumes,
    maxAttempts: input.maxAttempts,
    deadlineAt: input.deadlineAt,
    sessionId: record.sessionId,
    channel: input.channel ?? record.channel ?? 'console',
    originatingRequest: record.desiredOutcome ?? record.draft.objective,
  });
  if (!goal) return null;
  const now = new Date().toISOString();
  const next: GoalDraftRecord = {
    ...record,
    status: 'created',
    updatedAt: now,
    resolvedAt: now,
    goalId: goal.id,
  };
  writeGoalDraft(next);
  markNotificationRead(notificationIdForDraft(id));
  addNotification({
    id: `${notificationIdForDraft(id)}-created`,
    kind: 'system',
    title: `Goal created: ${compact(goal.plan.objective, 80)}`,
    body: `Created goal ${goal.id} from draft ${id}.`,
    createdAt: now,
    read: false,
    silent: true,
    metadata: { kind: 'goal_draft', goalDraftId: id, goalId: goal.id },
  });
  return { draft: next, goal };
}

export function deleteGoalDraft(id: string): boolean {
  try {
    const fp = fileFor(id);
    if (!existsSync(fp)) return false;
    unlinkSync(fp);
    markNotificationRead(notificationIdForDraft(id));
    return true;
  } catch {
    return false;
  }
}
