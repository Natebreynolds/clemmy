import { apiGet, apiPost } from './api';

export type GoalStatus = 'active' | 'satisfied' | 'expired';
export type GoalFilter = 'all' | 'active' | 'parked' | 'terminal' | 'self_driving';

export interface GoalStep {
  n: number;
  action: string;
  rationale?: string;
  verification?: string | null;
}

export interface GoalStage {
  id: string;
  title: string;
  criteria: string[];
  status: 'pending' | 'done';
  completedAt?: string;
}

export interface GoalEvidence {
  at: string;
  attempt: number;
  criterion: string;
  pass: boolean;
  method?: 'deterministic' | 'judge' | 'skipped';
  detail?: string;
  stageId?: string;
}

export interface GoalSummary {
  id: string;
  status: GoalStatus;
  objective: string;
  successCriteria: string[];
  steps: GoalStep[];
  risks: string[];
  origin: { kind: 'chat' | 'workflow'; runId?: string; stepId?: string } | null;
  sessionId: string | null;
  channel: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  doneReason: string | null;
  selfDriving: boolean;
  nextResumeAt: string | null;
  resumeEveryMs: number | null;
  resumeCount: number;
  maxResumes: number | null;
  noProgressStreak: number;
  deadlineAt: string | null;
  parked: { at: string; reason: 'no_progress' | 'approval_timeout' | 'blocker'; note?: string } | null;
  attempt: number;
  maxAttempts: number | null;
  progressLedger: string[];
  stages: GoalStage[];
  currentStage: GoalStage | null;
  stageProgress: { done: number; total: number } | null;
  evidenceSummary: { total: number; passed: number; failed: number; latest: GoalEvidence[] };
  actions: string[];
}

export interface GoalsPayload {
  goals: GoalSummary[];
  counts: {
    total: number;
    active: number;
    parked: number;
    selfDriving: number;
    satisfied: number;
    expired: number;
  };
  generatedAt: string;
}

export interface GoalDraft {
  objective: string;
  successCriteria: string[];
  nextActions: string[];
  risks: string[];
  missingInputs: string[];
  rationale: string;
  confidence: 'low' | 'medium' | 'high';
  sourceLines: string[];
}

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

export interface CreateGoalInput {
  objective: string;
  successCriteria?: string;
  nextActions?: string;
  risks?: string;
  selfDriving?: boolean;
  resumeEveryMinutes?: number;
  maxResumes?: number;
  maxAttempts?: number;
  deadlineAt?: string;
}

export interface DraftGoalInput {
  notes: string;
  desiredOutcome?: string;
}

export const listGoals = (status: GoalFilter = 'all') =>
  apiGet<GoalsPayload>(`/api/console/goals?status=${encodeURIComponent(status)}`);

export const createGoal = (body: CreateGoalInput) =>
  apiPost<GoalsPayload & { goal: GoalSummary }>('/api/console/goals', body);

export const draftGoal = (body: DraftGoalInput) =>
  apiPost<{ draft: GoalDraft }>('/api/console/goals/draft', body);

export const listGoalDrafts = (status: GoalDraftStatus | 'all' = 'pending') =>
  apiGet<{ drafts: GoalDraftRecord[] }>(`/api/console/goal-drafts?status=${encodeURIComponent(status)}`);

export const createGoalFromDraft = (id: string, body: Omit<CreateGoalInput, 'objective' | 'successCriteria' | 'nextActions' | 'risks'> = {}) =>
  apiPost<GoalsPayload & { draft: GoalDraftRecord; goal: GoalSummary; drafts: GoalDraftRecord[] }>(
    `/api/console/goal-drafts/${encodeURIComponent(id)}/create`,
    body,
  );

export const dismissGoalDraft = (id: string, reason?: string) =>
  apiPost<{ draft: GoalDraftRecord; drafts: GoalDraftRecord[] }>(`/api/console/goal-drafts/${encodeURIComponent(id)}/dismiss`, { reason });

export const setGoalSelfDrive = (id: string, body: { enabled: boolean; resumeEveryMinutes?: number; maxResumes?: number; deadlineAt?: string }) =>
  apiPost<GoalsPayload & { goal: GoalSummary }>(`/api/console/goals/${encodeURIComponent(id)}/self-drive`, body);

export const parkGoal = (id: string, note?: string) =>
  apiPost<GoalsPayload & { goal: GoalSummary }>(`/api/console/goals/${encodeURIComponent(id)}/park`, { note });

export const unparkGoal = (id: string) =>
  apiPost<GoalsPayload & { goal: GoalSummary }>(`/api/console/goals/${encodeURIComponent(id)}/unpark`);

export const satisfyGoal = (id: string, reason?: string) =>
  apiPost<GoalsPayload & { goal: GoalSummary }>(`/api/console/goals/${encodeURIComponent(id)}/satisfy`, { reason });

export const expireGoal = (id: string, reason?: string) =>
  apiPost<GoalsPayload & { goal: GoalSummary }>(`/api/console/goals/${encodeURIComponent(id)}/expire`, { reason });
