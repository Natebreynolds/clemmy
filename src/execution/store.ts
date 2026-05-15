import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import type { ExecutionRecord, PlanRecord } from '../types.js';
import { isUserFacingExecution } from './scope.js';

const STATE_DIR = path.join(BASE_DIR, 'state');
const EXECUTIONS_FILE = path.join(STATE_DIR, 'executions.json');

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

function loadExecutions(): ExecutionRecord[] {
  ensureStateDir();
  if (!existsSync(EXECUTIONS_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(EXECUTIONS_FILE, 'utf-8'));
    return Array.isArray(parsed) ? parsed as ExecutionRecord[] : [];
  } catch {
    return [];
  }
}

function saveExecutions(executions: ExecutionRecord[]): void {
  ensureStateDir();
  writeFileSync(EXECUTIONS_FILE, JSON.stringify(executions, null, 2), 'utf-8');
}

function clean(value: string, maxChars = 220): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

export interface CreateExecutionInput {
  sessionId: string;
  userId?: string;
  channel?: string;
  title: string;
  objective: string;
  reason: string;
  startedFromMessage: string;
  confidence: number;
  reasons: string[];
  planId?: string;
  nextStep?: string;
  successCriteria?: string;
  lastAssistantSummary?: string;
  nextReviewAt?: string;
  blocker?: string;
  autoAdvance?: boolean;
}

export class ExecutionStore {
  list(limit = 20, status?: ExecutionRecord['status']): ExecutionRecord[] {
    return loadExecutions()
      .filter((execution) => !status || execution.status === status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  get(id: string): ExecutionRecord | undefined {
    return loadExecutions().find((execution) => execution.id === id);
  }

  getActiveForSession(sessionId: string): ExecutionRecord | undefined {
    return loadExecutions()
      .filter((execution) => execution.sessionId === sessionId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .find((execution) => execution.status === 'active' || execution.status === 'blocked');
  }

  create(input: CreateExecutionInput): ExecutionRecord {
    const executions = loadExecutions();
    const now = new Date().toISOString();
    const execution: ExecutionRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      userId: input.userId,
      channel: input.channel,
      title: clean(input.title, 120),
      objective: clean(input.objective, 600),
      reason: clean(input.reason, 400),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      startedFromMessage: clean(input.startedFromMessage, 500),
      planId: input.planId,
      nextStep: input.nextStep ? clean(input.nextStep, 220) : undefined,
      successCriteria: input.successCriteria ? clean(input.successCriteria, 300) : undefined,
      lastAssistantSummary: input.lastAssistantSummary ? clean(input.lastAssistantSummary, 400) : undefined,
      nextReviewAt: input.nextReviewAt,
      blocker: input.blocker ? clean(input.blocker, 220) : undefined,
      autoAdvance: input.autoAdvance !== false,
      taskBindings: [],
      workflowBindings: [],
      delegationBindings: [],
      activity: [],
      confidence: Math.max(0, Math.min(1, input.confidence)),
      reasons: input.reasons.map((item) => clean(item, 140)).filter(Boolean).slice(0, 8),
    };
    executions.push(execution);
    saveExecutions(executions);
    return execution;
  }

  addActivity(input: {
    executionId: string;
    key: string;
    type: NonNullable<ExecutionRecord['activity']>[number]['type'];
    message: string;
    metadata?: Record<string, unknown>;
  }): ExecutionRecord | undefined {
    const executions = loadExecutions();
    const execution = executions.find((entry) => entry.id === input.executionId);
    if (!execution) return undefined;

    execution.activity = Array.isArray(execution.activity) ? execution.activity : [];
    if (execution.activity.some((item) => item.key === input.key)) {
      return execution;
    }

    execution.activity.push({
      id: randomUUID(),
      key: input.key,
      type: input.type,
      message: clean(input.message, 500),
      createdAt: new Date().toISOString(),
      metadata: input.metadata,
    });
    execution.activity = execution.activity.slice(-60);
    execution.updatedAt = new Date().toISOString();
    execution.lastActivityAt = new Date().toISOString();
    saveExecutions(executions);
    return execution;
  }

  recentActivity(executionId: string, limit = 10): NonNullable<ExecutionRecord['activity']> {
    const execution = this.get(executionId);
    return [...(execution?.activity ?? [])]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  update(id: string, patch: Partial<Omit<ExecutionRecord, 'id' | 'createdAt' | 'sessionId'>>): ExecutionRecord | undefined {
    const executions = loadExecutions();
    const execution = executions.find((entry) => entry.id === id);
    if (!execution) return undefined;

    Object.assign(execution, patch, {
      updatedAt: new Date().toISOString(),
      lastActivityAt: patch.lastActivityAt ?? new Date().toISOString(),
    });
    saveExecutions(executions);
    return execution;
  }

  listDue(now = new Date(), limit = 20): ExecutionRecord[] {
    return loadExecutions().filter((execution) => {
      if (execution.autoAdvance === false) return false;
      if (!isUserFacingExecution(execution)) return false;
      if (execution.status !== 'active' && execution.status !== 'blocked') return false;
      if (!execution.nextReviewAt) return true;
      return new Date(execution.nextReviewAt).getTime() <= now.getTime();
    })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  syncWithPlan(executionId: string, plan?: PlanRecord): ExecutionRecord | undefined {
    const execution = this.get(executionId);
    if (!execution) return undefined;
    if (!plan) return execution;

    const activeStep = plan.steps.find((step) => step.status === 'in_progress');
    const allDone = plan.steps.length > 0 && plan.steps.every((step) => step.status === 'done');
    return this.update(executionId, {
      planId: plan.id,
      nextStep: activeStep?.text ?? execution.nextStep,
      status: allDone ? 'completed' : execution.status,
      blocker: allDone ? undefined : execution.blocker,
      lastAssistantSummary: execution.lastAssistantSummary,
    });
  }
}

export function renderExecutionSummary(execution: ExecutionRecord): string {
  const parts = [
    `[${execution.status}] ${execution.title}`,
    execution.nextStep ? `Next: ${execution.nextStep}` : '',
    execution.blocker ? `Blocker: ${execution.blocker}` : '',
    execution.successCriteria ? `Done when: ${execution.successCriteria}` : '',
  ].filter(Boolean);
  return parts.join(' | ');
}
