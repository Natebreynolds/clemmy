import { PlanStore } from './plan-store.js';

export function buildDeepTaskPrompt(task: string): string {
  return [
    'Treat this as a deep task.',
    'First think through the objective carefully.',
    'Create a concrete execution plan with 3 to 7 steps.',
    'Then respond with:',
    '1. A short strategy summary',
    '2. A step list',
    '3. The immediate next move',
    '',
    `Task: ${task}`,
  ].join('\n');
}

export function saveDeepTaskPlan(task: string, steps: string[], sessionId?: string): string {
  const plan = new PlanStore().create(task, steps, { sessionId, source: 'deep_task' });
  return plan.id;
}

export function extractSteps(text: string): string[] {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const steps = lines
    .filter((line) => /^(\d+\.|-|\*)\s+/.test(line))
    .map((line) => line.replace(/^(\d+\.|-|\*)\s+/, '').trim())
    .filter((line) => line.length > 0);

  return steps.slice(0, 10);
}
