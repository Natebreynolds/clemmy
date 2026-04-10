import { PlanStore } from './plan-store.js';
import type { PlanRecord } from '../types.js';

function normalize(text: string): string {
  return text.toLowerCase();
}

function userIndicatesCompletion(message: string): boolean {
  const lower = normalize(message);
  return [
    'done',
    'completed',
    'finished',
    'handled',
    'took care of',
    'wrapped up',
  ].some((phrase) => lower.includes(phrase));
}

function userIndicatesNextStep(message: string): boolean {
  const lower = normalize(message);
  return [
    'next',
    'what now',
    'keep going',
    'continue',
    'move forward',
    'what should i do next',
  ].some((phrase) => lower.includes(phrase));
}

export function refineActivePlanFromMessage(message: string): PlanRecord | undefined {
  const store = new PlanStore();
  const active = store.getActive();
  if (!active) return undefined;

  const currentStep = active.steps.find((step) => step.status === 'in_progress');
  if (!currentStep) return active;

  if (userIndicatesCompletion(message)) {
    return store.updateStep(active.id, currentStep.id, 'done');
  }

  if (userIndicatesNextStep(message)) {
    return active;
  }

  return active;
}
