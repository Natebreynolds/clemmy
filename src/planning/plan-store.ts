import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BASE_DIR } from '../config.js';
import type { PlanRecord, PlanStep } from '../types.js';

const STATE_DIR = path.join(BASE_DIR, 'state');
const PLAN_FILE = path.join(STATE_DIR, 'plans.json');

function ensureDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

function loadPlans(): PlanRecord[] {
  ensureDir();
  if (!existsSync(PLAN_FILE)) return [];
  try {
    return JSON.parse(readFileSync(PLAN_FILE, 'utf-8')) as PlanRecord[];
  } catch {
    return [];
  }
}

function savePlans(plans: PlanRecord[]): void {
  ensureDir();
  writeFileSync(PLAN_FILE, JSON.stringify(plans, null, 2));
}

function buildSteps(items: string[]): PlanStep[] {
  return items.map((text, index) => ({
    id: `step-${index + 1}`,
    text: text.trim(),
    status: index === 0 ? 'in_progress' : 'pending',
  }));
}

export class PlanStore {
  create(title: string, steps: string[]): PlanRecord {
    const plans = loadPlans();
    const now = new Date().toISOString();
    const plan: PlanRecord = {
      id: randomUUID(),
      title: title.trim(),
      createdAt: now,
      updatedAt: now,
      steps: buildSteps(steps.filter(Boolean)),
    };
    plans.push(plan);
    savePlans(plans);
    return plan;
  }

  list(limit = 10): PlanRecord[] {
    return loadPlans()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  get(id: string): PlanRecord | undefined {
    return loadPlans().find((plan) => plan.id === id);
  }

  getActive(): PlanRecord | undefined {
    return this.list(20).find((plan) => plan.steps.some((step) => step.status === 'in_progress'));
  }

  updateStep(planId: string, stepId: string, status: PlanStep['status']): PlanRecord | undefined {
    const plans = loadPlans();
    const plan = plans.find((entry) => entry.id === planId);
    if (!plan) return undefined;

    const step = plan.steps.find((entry) => entry.id === stepId);
    if (!step) return undefined;
    step.status = status;

    if (status === 'done') {
      const next = plan.steps.find((entry) => entry.status === 'pending');
      if (next) next.status = 'in_progress';
    }

    plan.updatedAt = new Date().toISOString();
    savePlans(plans);
    return plan;
  }
}
