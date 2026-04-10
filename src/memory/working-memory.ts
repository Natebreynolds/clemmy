import { existsSync, writeFileSync } from 'node:fs';
import { WORKING_MEMORY_FILE } from './vault.js';
import type { SessionRecord } from '../types.js';
import { PlanStore } from '../planning/plan-store.js';

function buildSessionSummary(session: SessionRecord): string {
  const turns = session.turns.slice(-6);
  if (turns.length === 0) {
    return 'No recent conversation.';
  }

  return turns
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text.replace(/\s+/g, ' ').slice(0, 180)}`)
    .join('\n');
}

function buildPlanSummary(): string {
  const plans = new PlanStore().list(3);
  if (plans.length === 0) return 'No active plans.';

  return plans.map((plan) => {
    const active = plan.steps.find((step) => step.status === 'in_progress');
    const done = plan.steps.filter((step) => step.status === 'done').length;
    return `- ${plan.title} (${done}/${plan.steps.length} complete)${active ? ` | active: ${active.text}` : ''}`;
  }).join('\n');
}

function buildActiveTaskFocus(): string {
  const active = new PlanStore().getActive();
  if (!active) {
    return 'No active deep task. Keep the next useful move visible.';
  }

  const currentStep = active.steps.find((step) => step.status === 'in_progress');
  if (!currentStep) {
    return `Plan active: ${active.title}. Review remaining steps and decide the next move.`;
  }

  return `Active deep task: ${active.title}. Current step: ${currentStep.text}`;
}

export function refreshWorkingMemory(session: SessionRecord): void {
  const sections = [
    '# Working Memory',
    '',
    '## Current Session',
    buildSessionSummary(session),
    '',
    '## Active Plans',
    buildPlanSummary(),
    '',
    '## Focus',
    buildActiveTaskFocus(),
    '',
  ];

  writeFileSync(WORKING_MEMORY_FILE, sections.join('\n'));
}

export function workingMemoryExists(): boolean {
  return existsSync(WORKING_MEMORY_FILE);
}
